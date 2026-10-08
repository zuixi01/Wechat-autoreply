import { DatabaseSync } from 'node:sqlite'
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { Id } from '../../shared/contracts/identity'
import {
  protectPrivateDirectory,
  verifyPrivatePaths
} from '../../core/persistence/private-backup-directory'

const ScopeSchema = z.strictObject({
  origin: z
    .string()
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value)
        return (
          url.origin === value &&
          (url.protocol === 'https:' ||
            (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
        )
      } catch {
        return false
      }
    }),
  tenantId: Id,
  actorId: Id
})
export type AdminPauseScope = z.infer<typeof ScopeSchema>
export interface AdminPauseRecord {
  requestId: string
  confirmed: boolean
  createdAt: number
}
export interface AdminPauseJournal {
  latest(scope: AdminPauseScope): Promise<AdminPauseRecord | null>
  begin(
    scope: AdminPauseScope,
    requestId: string
  ): Promise<{ accepted: boolean; record: AdminPauseRecord }>
  confirm(scope: AdminPauseScope, requestId: string): Promise<AdminPauseRecord | null>
  close(): Promise<void>
}
const uuid = (value: string): string => z.uuid().parse(value).toLowerCase()
const key = (scope: AdminPauseScope): string => JSON.stringify(ScopeSchema.parse(scope))
/** Test/default transport journal; the actual desktop always supplies the file journal. */
export class MemoryAdminPauseJournal implements AdminPauseJournal {
  private readonly records = new Map<string, AdminPauseRecord[]>()
  async latest(scope: AdminPauseScope): Promise<AdminPauseRecord | null> {
    const rows = this.records.get(key(scope)) ?? []
    const record = rows.find((row) => !row.confirmed) ?? rows.at(-1)
    return record ? { ...record } : null
  }
  async begin(
    scope: AdminPauseScope,
    id: string
  ): Promise<{ accepted: boolean; record: AdminPauseRecord }> {
    id = uuid(id)
    const scopeKey = key(scope),
      rows = this.records.get(scopeKey) ?? []
    const existing = rows.find((row) => row.requestId === id)
    const pending = rows.find((row) => !row.confirmed)
    if (pending && pending.requestId !== id) return { accepted: false, record: { ...pending } }
    if (existing) return { accepted: true, record: { ...existing } }
    const record = { requestId: id, confirmed: false, createdAt: Date.now() }
    rows.push(record)
    this.records.set(scopeKey, rows)
    return { accepted: true, record: { ...record } }
  }
  async confirm(scope: AdminPauseScope, id: string): Promise<AdminPauseRecord | null> {
    const row = (this.records.get(key(scope)) ?? []).find((row) => row.requestId === uuid(id))
    if (row) row.confirmed = true
    return row ? { ...row } : null
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}
const RowSchema = z.strictObject({
  request_id: z.uuid(),
  confirmed: z.union([z.literal(0), z.literal(1)]),
  created_at: z.number().int().nonnegative().safe()
})
function record(raw: unknown): AdminPauseRecord | null {
  if (raw === undefined) return null
  const row = RowSchema.parse(raw)
  return { requestId: row.request_id, confirmed: row.confirmed === 1, createdAt: row.created_at }
}
/** Metadata only, separate from the sending ledger; never stores bearer or DB credentials.
 * FULL SQLite commits precede HTTP. A pending intent cannot be replaced by another UUID. */
export class FileAdminPauseJournal implements AdminPauseJournal {
  private database?: DatabaseSync
  private opening?: Promise<DatabaseSync>
  private closed = false
  private readonly directory: string
  constructor(directory: string) {
    this.directory = resolve(directory)
  }
  private async files(): Promise<string[]> {
    const names = await readdir(this.directory)
    if (
      names.some((name) => !['pause.sqlite', 'pause.sqlite-wal', 'pause.sqlite-shm'].includes(name))
    )
      throw new Error('admin_journal_invalid')
    return names.map((name) => join(this.directory, name))
  }
  private async ready(): Promise<DatabaseSync> {
    if (this.closed) throw new Error('admin_journal_closed')
    if (this.database) {
      await verifyPrivatePaths(this.directory, await this.files())
      if (this.closed) throw new Error('admin_journal_closed')
      return this.database
    }
    if (this.opening) return this.opening
    const opening = (async () => {
      const parent = dirname(this.directory)
      const compare = (value: string): string =>
        process.platform === 'win32' ? value.toLowerCase() : value
      if (compare(await realpath(parent)) !== compare(parent))
        throw new Error('admin_journal_path_invalid')
      let fresh = false
      try {
        await mkdir(this.directory, { mode: 0o700 })
        fresh = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      if (fresh) await protectPrivateDirectory(this.directory)
      await verifyPrivatePaths(this.directory, await this.files())
      const path = join(this.directory, 'pause.sqlite')
      let existed = true
      try {
        if (!(await lstat(path)).isFile()) throw new Error('admin_journal_invalid')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        existed = false
        const handle = await open(path, 'wx', 0o600)
        await handle.close()
      }
      const db = new DatabaseSync(path)
      try {
        db.exec('PRAGMA busy_timeout=2500;PRAGMA foreign_keys=ON;PRAGMA synchronous=FULL')
        if (existed) {
          if (db.prepare('PRAGMA user_version').get()?.user_version !== 1)
            throw new Error('admin_journal_version_invalid')
          const columns = db
            .prepare('PRAGMA table_info(pause_operations)')
            .all()
            .map((row) => row.name)
          if (
            JSON.stringify(columns) !==
            JSON.stringify([
              'id',
              'server_origin',
              'tenant_id',
              'actor_id',
              'request_id',
              'confirmed',
              'created_at'
            ])
          )
            throw new Error('admin_journal_schema_invalid')
        } else
          db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE pause_operations(id INTEGER PRIMARY KEY,server_origin TEXT NOT NULL,tenant_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,confirmed INTEGER NOT NULL CHECK(confirmed IN(0,1)),created_at INTEGER NOT NULL CHECK(created_at>=0),UNIQUE(server_origin,tenant_id,actor_id,request_id)) STRICT;
          CREATE INDEX pause_scope ON pause_operations(server_origin,tenant_id,actor_id,confirmed,id);
          PRAGMA user_version=1;COMMIT;`)
        db.exec('PRAGMA journal_mode=WAL')
        await verifyPrivatePaths(this.directory, await this.files())
        if (this.closed) throw new Error('admin_journal_closed')
        this.database = db
        return db
      } catch (error) {
        db.close()
        throw error
      }
    })()
    this.opening = opening
    try {
      return await opening
    } finally {
      if (this.opening === opening) this.opening = undefined
    }
  }
  private parameters(scope: AdminPauseScope): string[] {
    const s = ScopeSchema.parse(scope)
    return [s.origin, s.tenantId, s.actorId]
  }
  async latest(scope: AdminPauseScope): Promise<AdminPauseRecord | null> {
    const db = await this.ready()
    return record(
      db
        .prepare(
          'SELECT request_id,confirmed,created_at FROM pause_operations WHERE server_origin=? AND tenant_id=? AND actor_id=? ORDER BY confirmed,id DESC LIMIT 1'
        )
        .get(...this.parameters(scope))
    )
  }
  async begin(
    scope: AdminPauseScope,
    id: string
  ): Promise<{ accepted: boolean; record: AdminPauseRecord }> {
    id = uuid(id)
    const values = this.parameters(scope),
      db = await this.ready()
    db.exec('BEGIN IMMEDIATE')
    try {
      const existing = record(
        db
          .prepare(
            'SELECT request_id,confirmed,created_at FROM pause_operations WHERE server_origin=? AND tenant_id=? AND actor_id=? AND request_id=?'
          )
          .get(...values, id)
      )
      const pending = record(
        db
          .prepare(
            'SELECT request_id,confirmed,created_at FROM pause_operations WHERE server_origin=? AND tenant_id=? AND actor_id=? AND confirmed=0 ORDER BY id LIMIT 1'
          )
          .get(...values)
      )
      let result: { accepted: boolean; record: AdminPauseRecord }
      if (pending && pending.requestId !== id) result = { accepted: false, record: pending }
      else if (existing) result = { accepted: true, record: existing }
      else {
        const createdAt = Date.now()
        db.prepare(
          'INSERT INTO pause_operations(server_origin,tenant_id,actor_id,request_id,confirmed,created_at) VALUES(?,?,?,?,0,?)'
        ).run(...values, id, createdAt)
        result = { accepted: true, record: { requestId: id, confirmed: false, createdAt } }
      }
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  async confirm(scope: AdminPauseScope, id: string): Promise<AdminPauseRecord | null> {
    id = uuid(id)
    const values = this.parameters(scope),
      db = await this.ready()
    return record(
      db
        .prepare(
          'UPDATE pause_operations SET confirmed=1 WHERE server_origin=? AND tenant_id=? AND actor_id=? AND request_id=? RETURNING request_id,confirmed,created_at'
        )
        .get(...values, id)
    )
  }
  async close(): Promise<void> {
    this.closed = true
    try {
      await this.opening
    } catch {
      /* Failed initialization is not an open connection. */
    }
    this.database?.close()
    this.database = undefined
  }
}
