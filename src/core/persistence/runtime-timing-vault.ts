import { DatabaseSync } from 'node:sqlite'
import { closeSync, openSync } from 'node:fs'
import { lstat, mkdir, opendir, readdir, realpath, rmdir, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { PrivateRuntimeTimingJournal } from './runtime-timing-journal'
import { protectPrivateDirectory, verifyPrivatePaths } from './private-backup-directory'
import { TimingJournalRecordSchema } from '../agent/runtime-timing-evidence'
import { accountMemoryScope, learningHash } from '../memory/learning-scope'
import { MemoryScopeSchema, type MemoryScope } from '../../shared/contracts/learning-memory'

const MiB = 1024 * 1024,
  metadataReserve = 32 * MiB,
  retentionMs = 90 * 86400000,
  indexName = 'index.private.sqlite',
  indexFiles = new Set([indexName, indexName + '-journal'])
const Limits = z
  .strictObject({
    maxSessions: z.number().int().min(1).max(128).default(128),
    maxTotalBytes: z
      .number()
      .int()
      .min(metadataReserve + 1024)
      .max(256 * MiB)
      .default(256 * MiB),
    maxSessionBytes: z
      .number()
      .int()
      .min(1024)
      .max(64 * MiB)
      .default(64 * MiB)
  })
  .refine((value) => value.maxTotalBytes >= metadataReserve + value.maxSessionBytes)
const Session = z.strictObject({
  id: z.uuid(),
  created_at: z.number().int().nonnegative().safe(),
  epoch: z.number().int().nonnegative().safe(),
  owner_pid: z.number().int().positive(),
  max_bytes: z
    .number()
    .int()
    .min(1024)
    .max(64 * MiB),
  reserved_bytes: z
    .number()
    .int()
    .nonnegative()
    .max(64 * MiB),
  state: z.enum(['allocating', 'active', 'sealed', 'incomplete', 'revocation_pending', 'deleting'])
})
type SessionRow = z.infer<typeof Session>
const scopeKeys = (scope: MemoryScope): [string, string] => [
  learningHash(accountMemoryScope(scope)),
  learningHash(scope)
]
function recordScope(raw: unknown): MemoryScope {
  const record = TimingJournalRecordSchema.parse(raw)
  const event = record.kind === 'event' ? record.value.event : undefined
  const task =
    record.kind === 'binding' ? record.task : event && 'task' in event ? event.task : undefined
  const identity =
    task?.identity ??
    (event && 'binding' in event
      ? event.binding.identity
      : event && 'identity' in event
        ? event.identity
        : undefined)
  const conversationId =
    task?.conversationId ??
    (event && 'binding' in event
      ? event.binding.conversationId
      : event && 'conversationId' in event
        ? event.conversationId
        : undefined)
  if (!identity || !conversationId) throw new Error('runtime_timing_scope_invalid')
  return MemoryScopeSchema.parse({
    workspaceId: `enterprise:${learningHash({ tenant: identity.tenantId, account: identity.accountId })}`,
    tenantId: identity.tenantId,
    accountId: identity.accountId,
    platform: identity.platform,
    conversationId
  })
}
function processAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Only ESRCH proves absence. Access denial and PID reuse stay conservatively live.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Private metadata only. SQLite transactions fence quota and forgetting across hosts. */
export class PrivateRuntimeTimingVault {
  readonly directory: string
  private readonly limits: z.infer<typeof Limits>
  private db!: DatabaseSync
  private rootIdentity!: { dev: number; ino: number }
  private readonly live = new Map<
    string,
    { journal: PrivateRuntimeTimingJournal; invalidated?: () => void }
  >()
  private maintenance?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private stopped = false
  private shuttingDown?: Promise<void>
  private constructor(
    directory: string,
    limits: unknown,
    private readonly now: () => number
  ) {
    this.directory = resolve(directory)
    this.limits = Limits.parse(limits)
  }
  static async open(
    directory: string,
    limits: unknown = {},
    now: () => number = Date.now
  ): Promise<PrivateRuntimeTimingVault> {
    const vault = new PrivateRuntimeTimingVault(directory, limits, now)
    await vault.initialize()
    try {
      await vault.pruneExpired()
    } catch (error) {
      vault.db.close()
      throw error
    }
    return vault
  }
  private async initialize(): Promise<void> {
    const parent = dirname(this.directory),
      canonical = await realpath(parent)
    if (
      process.platform === 'win32'
        ? parent.toLowerCase() !== canonical.toLowerCase()
        : parent !== canonical
    )
      throw new Error('runtime_timing_vault_path_invalid')
    let created = false
    try {
      await mkdir(this.directory, { mode: 0o700 })
      created = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (created || (await readdir(this.directory)).length === 0)
      await protectPrivateDirectory(this.directory)
    else await verifyPrivatePaths(this.directory, [])
    const root = await lstat(this.directory)
    this.rootIdentity = { dev: root.dev, ino: root.ino }
    const path = join(this.directory, indexName)
    try {
      closeSync(openSync(path, 'wx', 0o600))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    await verifyPrivatePaths(this.directory, [path])
    const file = await lstat(path)
    if (!file.isFile() || file.nlink !== 1 || file.size > 8 * MiB)
      throw new Error('runtime_timing_vault_index_invalid')
    this.db = new DatabaseSync(path)
    try {
      this.db.exec(
        'PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA max_page_count=2048'
      )
      if (Number(this.db.prepare('PRAGMA page_size').get()?.page_size) !== 4096)
        throw new Error('index_page_size')
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version)
      if (version !== 0 && version !== 1) throw new Error('index_version')
      this.db
        .exec(`CREATE TABLE IF NOT EXISTS meta(id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL CHECK(epoch>=0));
        INSERT OR IGNORE INTO meta VALUES(1,0);
        CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,epoch INTEGER NOT NULL,
          owner_pid INTEGER NOT NULL,max_bytes INTEGER NOT NULL,reserved_bytes INTEGER NOT NULL,state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS scopes(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,scope_hash TEXT NOT NULL,
          PRIMARY KEY(session_id,scope_hash));
        CREATE TABLE IF NOT EXISTS forgotten(scope_hash TEXT PRIMARY KEY,epoch INTEGER NOT NULL);
        PRAGMA user_version=1;`)
      if (this.db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
        throw new Error('index_corrupt')
      await this.verifyRoot()
    } catch {
      this.db.close()
      throw new Error('runtime_timing_vault_index_invalid')
    }
  }
  private transaction<T>(run: () => T): T {
    if (this.stopped) throw new Error('runtime_timing_vault_closed')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = run()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  private rows(): SessionRow[] {
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY created_at,id')
      .all()
      .map((row) => Session.parse(row))
  }
  private row(id: string): SessionRow | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id)
    return row ? Session.parse(row) : undefined
  }
  private async verifyIndex(): Promise<void> {
    const index = join(this.directory, indexName)
    await verifyPrivatePaths(this.directory, [index])
    const root = await lstat(this.directory)
    if (root.dev !== this.rootIdentity.dev || root.ino !== this.rootIdentity.ino)
      throw new Error('runtime_timing_vault_replaced')
    const info = await lstat(index)
    if (!info.isFile() || info.nlink !== 1 || info.size > 8 * MiB)
      throw new Error('runtime_timing_vault_index_invalid')
  }
  private async verifyRoot(): Promise<void> {
    await this.verifyIndex()
    const declared = new Set(this.rows().map((row) => row.id))
    if (declared.size > 128) throw new Error('runtime_timing_vault_capacity')
    let count = 0
    const entries = await opendir(this.directory)
    for await (const entry of entries) {
      if (
        ++count > 130 ||
        (!indexFiles.has(entry.name) && !declared.has(entry.name) && !this.row(entry.name))
      )
        throw new Error('runtime_timing_vault_unknown_file')
      const path = join(this.directory, entry.name)
      await verifyPrivatePaths(this.directory, [path])
      const info = await lstat(path)
      if (indexFiles.has(entry.name)) {
        if (!info.isFile() || info.nlink !== 1 || info.size > 16 * MiB)
          throw new Error('runtime_timing_vault_index_invalid')
      } else if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('runtime_timing_vault_path_invalid')
    }
  }
  async createSession(invalidated?: () => void): Promise<PrivateRuntimeTimingJournal> {
    await this.verifyRoot()
    await this.auditStoredBytes()
    const id = randomUUID(),
      createdAt = z.number().int().nonnegative().safe().parse(this.now())
    this.transaction(() => {
      const totals = this.db
        .prepare('SELECT COUNT(*) count,COALESCE(SUM(reserved_bytes),0) bytes FROM sessions')
        .get()!
      if (
        Number(totals.count) >= this.limits.maxSessions ||
        metadataReserve + Number(totals.bytes) + this.limits.maxSessionBytes >
          this.limits.maxTotalBytes
      )
        throw new Error('runtime_timing_vault_capacity')
      const epoch = Number(this.db.prepare('SELECT epoch FROM meta WHERE id=1').get()!.epoch)
      this.db
        .prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?)')
        .run(
          id,
          createdAt,
          epoch,
          process.pid,
          this.limits.maxSessionBytes,
          this.limits.maxSessionBytes,
          'allocating'
        )
    })
    const directory = join(this.directory, id)
    try {
      await mkdir(directory, { mode: 0o700 })
      const journal = await PrivateRuntimeTimingJournal.open(
        directory,
        { maxBytes: this.limits.maxSessionBytes },
        {
          beforeWrite: (raw) => this.beforeWrite(id, raw)
        },
        id
      )
      this.transaction(() =>
        this.db
          .prepare("UPDATE sessions SET state='active' WHERE id=? AND state='allocating'")
          .run(id)
      )
      this.live.set(id, { journal, invalidated })
      return journal
    } catch {
      this.transaction(() =>
        this.db.prepare("UPDATE sessions SET state='deleting' WHERE id=?").run(id)
      )
      await this.deleteSession(id).catch(() => {})
      throw new Error('runtime_timing_vault_session_failed')
    }
  }
  private async beforeWrite(id: string, raw?: unknown): Promise<void> {
    const hashes = raw === undefined ? undefined : scopeKeys(recordScope(raw))
    await this.verifyIndex()
    try {
      this.transaction(() => {
        const row = this.row(id)
        if (
          !row ||
          row.owner_pid !== process.pid ||
          row.state !== 'active' ||
          this.now() >= row.created_at + retentionMs
        )
          throw new Error('runtime_timing_vault_revoked')
        const revoked = hashes
          ? this.db
              .prepare('SELECT MAX(epoch) epoch FROM forgotten WHERE scope_hash IN (?,?)')
              .get(...hashes)
          : this.db
              .prepare(
                'SELECT MAX(f.epoch) epoch FROM forgotten f JOIN scopes s ON s.scope_hash=f.scope_hash WHERE s.session_id=?'
              )
              .get(id)
        if (Number(revoked?.epoch ?? 0) > row.epoch) throw new Error('runtime_timing_vault_revoked')
        if (hashes) {
          const missing = [...new Set(hashes)].filter(
            (hash) =>
              !this.db
                .prepare('SELECT 1 FROM scopes WHERE session_id=? AND scope_hash=?')
                .get(id, hash)
          )
          const count = Number(this.db.prepare('SELECT COUNT(*) count FROM scopes').get()!.count)
          const own = Number(
            this.db.prepare('SELECT COUNT(*) count FROM scopes WHERE session_id=?').get(id)!.count
          )
          if (count + missing.length > 8192 || own + missing.length > 2048)
            throw new Error('runtime_timing_vault_capacity')
          for (const hash of missing)
            this.db.prepare('INSERT INTO scopes VALUES(?,?)').run(id, hash)
        }
      })
    } catch (error) {
      this.invalidate(id)
      throw error
    }
  }
  private invalidate(id: string): void {
    const owner = this.live.get(id)
    try {
      owner?.invalidated?.()
    } catch {
      /* Retirement cannot change permissions. */
    }
  }
  private async fileBytes(id: string): Promise<number> {
    const directory = join(this.directory, z.uuid().parse(id)),
      files = await readdir(directory)
    if (files.some((name) => name !== 'events.private.jsonl' && name !== 'report.private.json'))
      throw new Error('runtime_timing_vault_cleanup_failed')
    let bytes = 0
    await verifyPrivatePaths(
      directory,
      files.map((name) => join(directory, name))
    )
    for (const name of files) {
      const info = await lstat(join(directory, name))
      if (!info.isFile() || info.nlink !== 1) throw new Error('runtime_timing_vault_cleanup_failed')
      bytes += info.size
    }
    return bytes
  }
  private async auditStoredBytes(): Promise<void> {
    for (const row of this.rows()) {
      if (!['sealed', 'incomplete'].includes(row.state)) continue
      const bytes = await this.fileBytes(row.id)
      if (bytes > row.max_bytes) throw new Error('runtime_timing_vault_capacity')
      this.transaction(() =>
        this.db
          .prepare(
            "UPDATE sessions SET reserved_bytes=MAX(reserved_bytes,?) WHERE id=? AND state IN ('sealed','incomplete')"
          )
          .run(bytes, row.id)
      )
    }
    const total = Number(
      this.db.prepare('SELECT COALESCE(SUM(reserved_bytes),0) bytes FROM sessions').get()!.bytes
    )
    if (total + metadataReserve > this.limits.maxTotalBytes)
      throw new Error('runtime_timing_vault_capacity')
  }
  async finishSession(
    journal: PrivateRuntimeTimingJournal,
    exportReport?: () => Promise<string>
  ): Promise<string | undefined> {
    await journal.close()
    const initial = this.row(journal.sessionId)
    if (!initial || ['sealed', 'incomplete', 'deleting'].includes(initial.state)) {
      this.live.delete(journal.sessionId)
      return undefined
    }
    let output: string | undefined,
      exportFailed = false
    if (exportReport && !journal.health().reason) {
      try {
        output = await exportReport()
      } catch {
        exportFailed = true
      }
    }
    await this.verifyRoot()
    const bytes = await this.fileBytes(journal.sessionId)
    this.transaction(() => {
      const row = this.row(journal.sessionId)
      if (
        !row ||
        row.owner_pid !== process.pid ||
        !['active', 'revocation_pending'].includes(row.state) ||
        bytes > row.max_bytes
      )
        throw new Error('runtime_timing_vault_revoked')
      if (output && output !== join(journal.directory, 'report.private.json'))
        throw new Error('runtime_timing_vault_report_invalid')
      const state =
        output && !exportFailed && !journal.health().reason && row.state === 'active'
          ? 'sealed'
          : 'incomplete'
      this.db
        .prepare('UPDATE sessions SET state=?,reserved_bytes=? WHERE id=?')
        .run(state, bytes, journal.sessionId)
      if (state !== 'sealed') output = undefined
    })
    this.live.delete(journal.sessionId)
    return output
  }
  async assertReadable(id: string): Promise<void> {
    const parsed = z.uuid().parse(id)
    await this.verifyIndex()
    const db = this.stopped
      ? new DatabaseSync(join(this.directory, indexName), { readOnly: true })
      : this.db
    try {
      const row = db
        .prepare('SELECT state,created_at,max_bytes FROM sessions WHERE id=?')
        .get(parsed)
      if (!row || row.state !== 'sealed' || this.now() >= Number(row.created_at) + retentionMs)
        throw new Error('runtime_timing_vault_revoked')
      await verifyPrivatePaths(join(this.directory, parsed), [
        join(this.directory, parsed, 'report.private.json')
      ])
      if ((await this.fileBytes(parsed)) > Number(row.max_bytes))
        throw new Error('runtime_timing_vault_capacity')
    } finally {
      if (this.stopped) db.close()
    }
  }
  async inventory(): Promise<{ sessions: number; active: number; reservedBytes: number }> {
    await this.verifyRoot()
    await this.auditStoredBytes()
    const rows = this.rows()
    return {
      sessions: rows.length,
      active: rows.filter((row) => ['active', 'allocating'].includes(row.state)).length,
      reservedBytes: rows.reduce((sum, row) => sum + row.reserved_bytes, 0)
    }
  }
  hasSessionScopes(id: string): boolean {
    return Boolean(
      this.db.prepare('SELECT 1 FROM scopes WHERE session_id=? LIMIT 1').get(z.uuid().parse(id))
    )
  }
  isStopped(): boolean {
    return this.stopped
  }
  async forgetScope(raw: MemoryScope): Promise<void> {
    const scope = MemoryScopeSchema.parse(raw),
      hash = learningHash(scope)
    await this.verifyRoot()
    const ids = this.transaction(() => {
      // Keep fences for all older writers, including scopes they have not encountered yet.
      const minEpoch = this.db
        .prepare(
          "SELECT MIN(epoch) epoch FROM sessions WHERE state IN ('active','allocating','revocation_pending')"
        )
        .get()?.epoch
      this.db
        .prepare('DELETE FROM forgotten WHERE epoch<?')
        .run(minEpoch ?? Number.MAX_SAFE_INTEGER)
      if (
        !this.db.prepare('SELECT 1 FROM forgotten WHERE scope_hash=?').get(hash) &&
        Number(this.db.prepare('SELECT COUNT(*) count FROM forgotten').get()!.count) >= 4096
      )
        throw new Error('runtime_timing_vault_capacity')
      const epoch = Number(this.db.prepare('SELECT epoch FROM meta WHERE id=1').get()!.epoch) + 1
      z.number().int().safe().parse(epoch)
      this.db.prepare('UPDATE meta SET epoch=? WHERE id=1').run(epoch)
      this.db
        .prepare(
          'INSERT INTO forgotten VALUES(?,?) ON CONFLICT(scope_hash) DO UPDATE SET epoch=excluded.epoch'
        )
        .run(hash, epoch)
      const ids = this.db
        .prepare('SELECT session_id FROM scopes WHERE scope_hash=?')
        .all(hash)
        .map((row) => z.uuid().parse(row.session_id))
      for (const id of ids)
        this.db
          .prepare(
            "UPDATE sessions SET state=CASE WHEN state IN ('active','allocating','revocation_pending') THEN 'revocation_pending' ELSE 'deleting' END WHERE id=?"
          )
          .run(id)
      return ids
    })
    let failed = false,
      busy = false
    for (const id of ids) {
      try {
        await this.deleteSession(id)
      } catch (error) {
        if ((error as Error).message === 'runtime_timing_vault_writer_busy') busy = true
        else failed = true
      }
    }
    if (failed) throw new Error('runtime_timing_vault_cleanup_failed')
    if (busy) throw new Error('runtime_timing_vault_writer_busy')
  }
  async discardSession(journal: PrivateRuntimeTimingJournal): Promise<void> {
    this.invalidate(journal.sessionId)
    await journal.close()
    this.transaction(() =>
      this.db.prepare("UPDATE sessions SET state='deleting' WHERE id=?").run(journal.sessionId)
    )
    await this.deleteSession(journal.sessionId)
  }
  private async deleteSession(id: string): Promise<void> {
    const row = this.row(z.uuid().parse(id))
    if (!row) return
    const own = this.live.get(id)
    if (
      ['active', 'allocating', 'revocation_pending'].includes(row.state) &&
      !own &&
      processAlive(row.owner_pid)
    )
      throw new Error('runtime_timing_vault_writer_busy')
    this.invalidate(id)
    if (own) await own.journal.close()
    await this.verifyRoot()
    this.transaction(() =>
      this.db.prepare("UPDATE sessions SET state='deleting' WHERE id=?").run(id)
    )
    const directory = join(this.directory, id)
    let exists = true
    try {
      await lstat(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      exists = false
    }
    if (exists) {
      try {
        if (own) await own.journal.forget()
        else {
          await this.fileBytes(id)
          for (const name of await readdir(directory)) await unlink(join(directory, name))
          await rmdir(directory)
        }
      } catch {
        throw new Error('runtime_timing_vault_cleanup_failed')
      }
    }
    this.transaction(() =>
      this.db.prepare('DELETE FROM sessions WHERE id=? AND state=?').run(id, 'deleting')
    )
    this.live.delete(id)
  }
  pruneExpired(): Promise<void> {
    if (this.maintenance) return this.maintenance
    const work = this.pruneCore()
    this.maintenance = work
    const settled = (): void => {
      if (this.maintenance === work) this.maintenance = undefined
    }
    void work.then(settled, settled)
    return work
  }
  private async pruneCore(): Promise<void> {
    await this.verifyRoot()
    const now = z.number().int().nonnegative().safe().parse(this.now())
    let failed = false
    for (const row of this.rows()) {
      try {
        const revoked =
          Number(
            this.db
              .prepare(
                'SELECT MAX(f.epoch) epoch FROM forgotten f JOIN scopes s ON s.scope_hash=f.scope_hash WHERE s.session_id=?'
              )
              .get(row.id)?.epoch ?? 0
          ) > row.epoch
        if (row.created_at + retentionMs <= now || row.state === 'deleting' || revoked)
          await this.deleteSession(row.id)
        else if (
          ['active', 'allocating', 'revocation_pending'].includes(row.state) &&
          !processAlive(row.owner_pid)
        ) {
          // A dead process never gets a complete timing report reconstructed from its partial log.
          let exists = true
          try {
            await lstat(join(this.directory, row.id))
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            exists = false
          }
          if (!exists) {
            this.transaction(() => this.db.prepare('DELETE FROM sessions WHERE id=?').run(row.id))
            continue
          }
          const bytes = await this.fileBytes(row.id)
          if (bytes > row.max_bytes) throw new Error('runtime_timing_vault_capacity')
          this.transaction(() =>
            this.db
              .prepare("UPDATE sessions SET state='incomplete',reserved_bytes=? WHERE id=?")
              .run(bytes, row.id)
          )
        }
      } catch {
        failed = true
      }
    }
    if (failed) throw new Error('runtime_timing_vault_cleanup_failed')
  }
  startRetention(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => void this.pruneExpired().catch(() => {}), 60000)
    this.timer.unref()
  }
  shutdown(): Promise<void> {
    if (this.shuttingDown) return this.shuttingDown
    const work = (async () => {
      if (this.timer) clearInterval(this.timer)
      this.timer = undefined
      await this.maintenance?.catch(() => {})
      if ([...this.live.values()].some((item) => !item.journal.health().closed))
        throw new Error('runtime_timing_vault_not_quiescent')
      this.stopped = true
      this.db.close()
    })()
    this.shuttingDown = work
    void work.catch(() => {
      if (this.shuttingDown === work) this.shuttingDown = undefined
    })
    return work
  }
}
