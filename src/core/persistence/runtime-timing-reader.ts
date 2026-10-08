import { DatabaseSync } from 'node:sqlite'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { verifyPrivatePaths } from './private-backup-directory'
import type { TimingJournalHealth } from './runtime-timing-journal'
import { TimingJournalRecordSchema } from '../agent/runtime-timing-evidence'
import { accountMemoryScope, learningHash } from '../memory/learning-scope'
import { MemoryScopeSchema } from '../../shared/contracts/learning-memory'

const MiB = 1024 * 1024
const retentionMs = 90 * 86400000
const indexName = 'index.private.sqlite'
const integer = z.number().int().nonnegative().safe()
const SessionSchema = z.strictObject({
  id: z.uuid(),
  created_at: integer,
  epoch: integer,
  owner_pid: z.number().int().positive().safe(),
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
const HeaderSchema = z.strictObject({
  schema: z.literal('autoreply-runtime-timing-v1'),
  sessionId: z.uuid(),
  openedAt: integer
})
const FooterSchema = z.strictObject({
  kind: z.literal('session_closed'),
  sessionId: z.uuid(),
  records: z.number().int().min(0).max(10000),
  dropped: z.literal(0),
  pending: z.literal(0),
  bytes: z
    .number()
    .int()
    .positive()
    .max(64 * MiB),
  closed: z.literal(true)
})
type TimingJournalRecord = z.infer<typeof TimingJournalRecordSchema>
type FileIdentity = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
const fileIdentity = (info: FileIdentity): FileIdentity => ({
  dev: info.dev,
  ino: info.ino,
  size: info.size,
  mtimeMs: info.mtimeMs,
  ctimeMs: info.ctimeMs
})
const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  Object.keys(left).every(
    (key) => left[key as keyof FileIdentity] === right[key as keyof FileIdentity]
  )

function recordScopeHashes(record: TimingJournalRecord): string[] {
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
  const scope = MemoryScopeSchema.parse({
    workspaceId: `enterprise:${learningHash({ tenant: identity.tenantId, account: identity.accountId })}`,
    tenantId: identity.tenantId,
    accountId: identity.accountId,
    platform: identity.platform,
    conversationId
  })
  return [learningHash(accountMemoryScope(scope)), learningHash(scope)]
}

async function privateFile(
  directory: string,
  path: string,
  maximum: number
): Promise<FileIdentity> {
  await verifyPrivatePaths(directory, [path])
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximum)
    throw new Error('runtime_timing_reader_file_invalid')
  return fileIdentity(info)
}

/** Read only: never initializes SQLite, changes ACLs, prunes or repairs a session. */
export async function readSealedRuntimeTimingJournal(
  vaultRoot: string,
  sessionId: string,
  now: () => number = Date.now
): Promise<{
  sessionId: string
  records: TimingJournalRecord[]
  health: TimingJournalHealth
  journalHash: string
  assertCurrent(): Promise<void>
}> {
  const directory = resolve(vaultRoot),
    id = z.uuid().parse(sessionId)
  const canonical = await realpath(directory)
  if (
    process.platform === 'win32'
      ? directory.toLowerCase() !== canonical.toLowerCase()
      : directory !== canonical
  )
    throw new Error('runtime_timing_vault_path_invalid')
  await verifyPrivatePaths(directory, [])
  const root = fileIdentity(await lstat(directory))
  const sessionDirectory = join(directory, id),
    indexPath = join(directory, indexName)
  const eventPath = join(sessionDirectory, 'events.private.jsonl')
  let sessionIdentity: { dev: number; ino: number } | undefined

  async function inspectIndex(expectedScopes?: string[]): Promise<z.infer<typeof SessionSchema>> {
    await verifyPrivatePaths(directory, [])
    const currentRoot = await lstat(directory)
    if (currentRoot.dev !== root.dev || currentRoot.ino !== root.ino)
      throw new Error('runtime_timing_vault_replaced')
    const indexIdentity = await privateFile(directory, indexPath, 8 * MiB)
    const db = new DatabaseSync(indexPath, { readOnly: true })
    try {
      db.exec('BEGIN')
      if (
        Number(db.prepare('PRAGMA user_version').get()?.user_version) !== 1 ||
        Number(db.prepare('PRAGMA page_size').get()?.page_size) !== 4096 ||
        db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok'
      )
        throw new Error('runtime_timing_vault_index_invalid')
      const sessions = db
        .prepare('SELECT * FROM sessions ORDER BY id')
        .all()
        .map((value) => SessionSchema.parse(value))
      const epoch = integer.parse(
        Number(db.prepare('SELECT epoch FROM meta WHERE id=1').get()?.epoch)
      )
      if (
        sessions.length > 128 ||
        sessions.some((value) => value.epoch > epoch) ||
        sessions.reduce((sum, row) => sum + row.reserved_bytes, 32 * MiB) > 256 * MiB
      )
        throw new Error('runtime_timing_vault_capacity')
      const row = sessions.find((value) => value.id === id)
      const at = integer.parse(now())
      if (
        !row ||
        row.state !== 'sealed' ||
        row.created_at > at ||
        row.created_at + retentionMs <= at
      )
        throw new Error('runtime_timing_vault_revoked')
      const scopes = db
        .prepare('SELECT scope_hash FROM scopes WHERE session_id=? ORDER BY scope_hash')
        .all(id)
        .map((value) =>
          z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .parse(value.scope_hash)
        )
      if (
        scopes.length > 2048 ||
        Number(db.prepare('SELECT COUNT(*) count FROM scopes').get()?.count) > 8192 ||
        Number(db.prepare('SELECT COUNT(*) count FROM forgotten').get()?.count) > 4096
      )
        throw new Error('runtime_timing_vault_capacity')
      const revoked = db
        .prepare(
          'SELECT MAX(f.epoch) epoch FROM forgotten f JOIN scopes s ON s.scope_hash=f.scope_hash WHERE s.session_id=?'
        )
        .get(id)
      if (integer.parse(Number(revoked?.epoch ?? 0)) > row.epoch)
        throw new Error('runtime_timing_vault_revoked')
      if (expectedScopes && learningHash(scopes) !== learningHash(expectedScopes))
        throw new Error('runtime_timing_scope_invalid')
      // Do not hold a SQLite read transaction while awaiting filesystem or ACL checks.
      db.exec('COMMIT')
      const names = await readdir(directory)
      const declared = new Set(sessions.map((value) => value.id))
      if (
        names.length > 130 ||
        names.some(
          (name) => name !== indexName && name !== indexName + '-journal' && !declared.has(name)
        )
      )
        throw new Error('runtime_timing_vault_unknown_file')
      for (const name of names) {
        const path = join(directory, name)
        await verifyPrivatePaths(directory, [path])
        const info = await lstat(path)
        if (name === indexName || name === indexName + '-journal') {
          if (!info.isFile() || info.nlink !== 1 || info.size > 16 * MiB)
            throw new Error('runtime_timing_vault_index_invalid')
        } else if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new Error('runtime_timing_vault_path_invalid')
        }
      }
      let totalBytes = 32 * MiB
      for (const stored of sessions) {
        const storedDirectory = join(directory, stored.id)
        let files: string[]
        try {
          await verifyPrivatePaths(storedDirectory, [])
          files = await readdir(storedDirectory)
        } catch (error) {
          if (stored.state === 'allocating' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            totalBytes += stored.reserved_bytes
            continue
          }
          throw error
        }
        if (files.some((name) => name !== 'events.private.jsonl' && name !== 'report.private.json'))
          throw new Error('runtime_timing_vault_unknown_file')
        let actualBytes = 0
        for (const name of files) {
          actualBytes += (
            await privateFile(storedDirectory, join(storedDirectory, name), stored.max_bytes)
          ).size
        }
        if (actualBytes > stored.max_bytes) throw new Error('runtime_timing_vault_capacity')
        totalBytes += Math.max(actualBytes, stored.reserved_bytes)
      }
      if (totalBytes > 256 * MiB) throw new Error('runtime_timing_vault_capacity')
      const actualIndex = await lstat(indexPath)
      if (actualIndex.dev !== indexIdentity.dev || actualIndex.ino !== indexIdentity.ino)
        throw new Error('runtime_timing_vault_replaced')
      return row
    } finally {
      db.close()
    }
  }

  async function inspectSession(row: z.infer<typeof SessionSchema>): Promise<FileIdentity> {
    await verifyPrivatePaths(sessionDirectory, [])
    const currentIdentity = await lstat(sessionDirectory)
    if (
      sessionIdentity &&
      (sessionIdentity.dev !== currentIdentity.dev || sessionIdentity.ino !== currentIdentity.ino)
    )
      throw new Error('runtime_timing_vault_replaced')
    sessionIdentity ??= { dev: currentIdentity.dev, ino: currentIdentity.ino }
    const names = await readdir(sessionDirectory)
    if (
      names.length !== 2 ||
      !names.includes('events.private.jsonl') ||
      !names.includes('report.private.json')
    )
      throw new Error('runtime_timing_vault_session_invalid')
    const events = await privateFile(sessionDirectory, eventPath, row.max_bytes)
    const report = await privateFile(
      sessionDirectory,
      join(sessionDirectory, 'report.private.json'),
      row.max_bytes
    )
    if (events.size + report.size > row.max_bytes || events.size + report.size > row.reserved_bytes)
      throw new Error('runtime_timing_vault_capacity')
    return events
  }

  async function readEvents(expected: FileIdentity): Promise<Buffer> {
    const file = await open(eventPath, 'r')
    try {
      const before = await file.stat()
      if (!before.isFile() || before.nlink !== 1 || !sameIdentity(expected, fileIdentity(before)))
        throw new Error('runtime_timing_reader_file_changed')
      const buffer = Buffer.alloc(expected.size + 1)
      let offset = 0
      while (offset < buffer.length) {
        const read = await file.read(buffer, offset, buffer.length - offset, offset)
        if (!read.bytesRead) break
        offset += read.bytesRead
      }
      if (offset !== expected.size || !sameIdentity(expected, fileIdentity(await file.stat())))
        throw new Error('runtime_timing_reader_file_changed')
      return buffer.subarray(0, offset)
    } finally {
      await file.close()
    }
  }

  const row = await inspectIndex()
  const eventIdentity = await inspectSession(row)
  const bytes = await readEvents(eventIdentity)
  const body = bytes.toString('utf8')
  if (!Buffer.from(body, 'utf8').equals(bytes) || !body.endsWith('\n'))
    throw new Error('runtime_timing_journal_invalid')
  const lines = body.slice(0, -1).split('\n')
  if (
    lines.length < 2 ||
    lines.length > 10002 ||
    lines.some((line) => !line || Buffer.byteLength(line) > 256 * 1024)
  )
    throw new Error('runtime_timing_journal_invalid')
  const header = HeaderSchema.parse(JSON.parse(lines[0]))
  const footer = FooterSchema.parse(JSON.parse(lines.at(-1)!))
  if (
    header.sessionId !== id ||
    footer.sessionId !== id ||
    footer.records !== lines.length - 2 ||
    header.openedAt > integer.parse(now()) ||
    footer.bytes !== Buffer.byteLength(lines.slice(0, -1).join('\n') + '\n')
  )
    throw new Error('runtime_timing_journal_invalid')
  const records = lines
    .slice(1, -1)
    .map((line) => TimingJournalRecordSchema.parse(JSON.parse(line)))
  const scopes = [...new Set(records.flatMap(recordScopeHashes))].sort()
  await inspectIndex(scopes)
  const journalHash = createHash('sha256').update(bytes).digest('hex')
  const health: TimingJournalHealth = {
    sessionId: id,
    records: footer.records,
    dropped: 0,
    pending: 0,
    bytes: bytes.length,
    closed: true
  }
  return {
    sessionId: id,
    records,
    health,
    journalHash,
    assertCurrent: async () => {
      const current = await inspectIndex(scopes)
      const identity = await inspectSession(current)
      if (
        learningHash(current) !== learningHash(row) ||
        !sameIdentity(eventIdentity, identity) ||
        createHash('sha256')
          .update(await readEvents(identity))
          .digest('hex') !== journalHash
      )
        throw new Error('runtime_timing_reader_file_changed')
      await inspectIndex(scopes)
    }
  }
}
