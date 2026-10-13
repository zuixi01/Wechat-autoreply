import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import {
  ForegroundRecordSchema,
  ForegroundCheckpointSchema,
  ForegroundResolutionSchema,
  type ForegroundCheckpoint,
  type ForegroundRecord
} from '../../shared/contracts/foreground-wechat'
import type { ForegroundJournal } from '../agent/foreground-wechat'
import type { ForegroundBatchStore } from '../agent/foreground-batch'
import { ListRowSchema, type ListRow } from '../../shared/contracts/foreground-batch'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { ownerStyleKey } from '../../shared/reply-persona'
const BatchCheckpointSchema = z.strictObject({
  row: ListRowSchema,
  boundaryUnknown: z.boolean().optional(),
  checkpoint: ForegroundCheckpointSchema.optional()
})

export class SqliteForegroundJournal implements ForegroundJournal, ForegroundBatchStore {
  private readonly db: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(
      'PRAGMA synchronous=FULL; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS foreground_replies (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL)'
    )
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS foreground_reply_state ON foreground_replies(json_extract(payload, '$.state')); CREATE TABLE IF NOT EXISTS foreground_batch_checkpoints (target TEXT PRIMARY KEY, payload TEXT NOT NULL)"
    )
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS foreground_single_checkpoints (target TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS foreground_resolutions (id TEXT PRIMARY KEY, state TEXT NOT NULL, resolved_at INTEGER NOT NULL)'
    )
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS foreground_generated_hashes (hash TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS foreground_migrations (name TEXT PRIMARY KEY)'
    )
    if (
      !this.db
        .prepare('SELECT 1 FROM foreground_migrations WHERE name=?')
        .get('generated_hashes_v1')
    )
      this.transaction(() => {
        for (const row of this.db
          .prepare("SELECT json_extract(payload,'$.reply') AS reply FROM foreground_replies")
          .all())
          this.markGenerated(String(row.reply ?? ''))
        this.db.prepare('INSERT INTO foreground_migrations VALUES (?)').run('generated_hashes_v1')
      })
  }
  list(limit?: number): ForegroundRecord[] {
    if (limit !== undefined) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 50)
        throw new Error('record_limit_invalid')
      return this.db
        .prepare(
          'SELECT payload FROM foreground_replies ORDER BY created_at DESC, rowid DESC LIMIT ?'
        )
        .all(limit)
        .reverse()
        .map((row) => ForegroundRecordSchema.parse(JSON.parse(String(row.payload))))
    }
    return this.db
      .prepare('SELECT payload FROM foreground_replies ORDER BY created_at, rowid')
      .all()
      .map((r) => ForegroundRecordSchema.parse(JSON.parse(String(r.payload))))
  }
  hasUnknown(): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM foreground_replies WHERE json_extract(payload, '$.state')='unknown' LIMIT 1"
        )
        .get()
    )
  }
  unresolved(): ForegroundRecord[] {
    return this.db
      .prepare(
        "SELECT payload FROM foreground_replies WHERE json_extract(payload, '$.state')='unknown' ORDER BY created_at, rowid LIMIT 50"
      )
      .all()
      .map((row) => ForegroundRecordSchema.parse(JSON.parse(String(row.payload))))
  }
  generatedReplies(target: string): string[] {
    return this.db
      .prepare(
        "SELECT payload FROM foreground_replies WHERE json_extract(payload, '$.target')=? ORDER BY created_at DESC, rowid DESC LIMIT 500"
      )
      .all(target)
      .map((row) => ForegroundRecordSchema.parse(JSON.parse(String(row.payload))).reply)
  }
  handoffs(): ForegroundRecord[] {
    return this.db
      .prepare(
        "SELECT payload FROM foreground_replies WHERE json_extract(payload,'$.state')='handoff' AND json_extract(payload,'$.handledAt') IS NULL ORDER BY created_at,rowid LIMIT 50"
      )
      .all()
      .map((row) => ForegroundRecordSchema.parse(JSON.parse(String(row.payload))))
  }
  acknowledgeHandoff(id: string): void {
    z.string().uuid().parse(id)
    const row = this.db.prepare('SELECT payload FROM foreground_replies WHERE id=?').get(id)
    if (!row) throw new Error('handoff_not_found')
    const record = ForegroundRecordSchema.parse(JSON.parse(String(row.payload)))
    if (record.state !== 'handoff') throw new Error('handoff_invalid')
    this.save({ ...record, handledAt: record.handledAt ?? Date.now() })
  }
  private generatedHash(text: string): string {
    return createHash('sha256').update(ownerStyleKey(text)).digest('hex')
  }
  private markGenerated(text: string): void {
    if (text.trim())
      this.db
        .prepare('INSERT OR IGNORE INTO foreground_generated_hashes VALUES (?)')
        .run(this.generatedHash(text))
  }
  isGenerated(text: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM foreground_generated_hashes WHERE hash=?')
        .get(this.generatedHash(text))
    )
  }
  loadSingle(target: string): ForegroundCheckpoint | undefined {
    const row = this.db
      .prepare('SELECT payload FROM foreground_single_checkpoints WHERE target=?')
      .get(target)
    if (!row) return undefined
    const value = ForegroundCheckpointSchema.parse(JSON.parse(String(row.payload)))
    if (value.baseline.contact !== target) throw new Error('checkpoint_invalid')
    return value
  }
  saveSingle(value: ForegroundCheckpoint): void {
    this.transaction(() => this.writeSingle(value))
  }
  complete(record: ForegroundRecord, checkpoint: ForegroundCheckpoint): void {
    this.transaction(() => {
      this.save(record)
      this.writeSingle(checkpoint)
    })
  }
  private transaction(write: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      write()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  private writeSingle(value: ForegroundCheckpoint): void {
    const valid = ForegroundCheckpointSchema.parse(value)
    this.db
      .prepare(
        'INSERT INTO foreground_single_checkpoints VALUES (?,?) ON CONFLICT(target) DO UPDATE SET payload=excluded.payload'
      )
      .run(valid.baseline.contact, JSON.stringify(valid))
    this.db
      .prepare(
        "UPDATE foreground_batch_checkpoints SET payload=json_set(payload,'$.checkpoint',json(?)) WHERE target=?"
      )
      .run(JSON.stringify(valid), valid.baseline.contact)
  }
  clearSingle(target: string): void {
    this.db.prepare('DELETE FROM foreground_single_checkpoints WHERE target=?').run(target)
  }
  resolve(input: unknown): void {
    const valid = ForegroundResolutionSchema.parse(input)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT payload FROM foreground_replies WHERE id=?').get(valid.id)
      if (!row) throw new Error('record_not_found')
      const record = ForegroundRecordSchema.parse(JSON.parse(String(row.payload)))
      if (record.state !== 'unknown') throw new Error('record_already_resolved')
      this.save({ ...record, state: valid.state })
      this.db
        .prepare('INSERT INTO foreground_resolutions VALUES (?,?,?)')
        .run(valid.id, valid.state, Date.now())
      // Settle this attempt only. Later messages remain beyond its exact source
      // boundary and are still new after restart; never replay this attempt.
      if (record.source) {
        const old = this.loadSingle(record.target)
        const delivery =
          valid.state === 'sent' &&
          old?.delivery &&
          old.delivery.id === record.planId &&
          old.delivery.cursor === record.partIndex &&
          old.delivery.cursor + 1 < old.delivery.parts.length
            ? { ...old.delivery, cursor: old.delivery.cursor + 1 }
            : undefined
        this.writeSingle({
          baseline: record.source,
          ownEcho:
            valid.state === 'sent'
              ? record.part?.kind === 'image'
                ? '[非文本消息]'
                : record.reply
              : undefined,
          pending: Boolean(delivery),
          delivery
        })
      } else {
        // Old records lack a source boundary. Preserve the existing legacy
        // manual-rebaseline behavior rather than inventing a message identity.
        this.clearSingle(record.target)
        this.db
          .prepare('DELETE FROM foreground_batch_checkpoints WHERE target=?')
          .run(record.target)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  loadBatch(
    targets: string[],
    includeCompleted = false
  ): { row: ListRow; checkpoint?: ForegroundCheckpoint; boundaryUnknown?: boolean }[] {
    if (!targets.length) return []
    return this.db
      .prepare(
        `SELECT payload FROM foreground_batch_checkpoints WHERE target IN (${targets.map(() => '?').join(',')})${includeCompleted ? '' : " AND coalesce(json_extract(payload, '$.checkpoint.pending'),1)=1"}`
      )
      .all(...targets)
      .map((row) => {
        const value = BatchCheckpointSchema.parse(JSON.parse(String(row.payload)))
        if (
          (value.checkpoint && value.row.name !== value.checkpoint.baseline.contact) ||
          !targets.includes(value.row.name)
        )
          throw new Error('checkpoint_invalid')
        return value
      })
  }
  saveBatchHint(row: ListRow, boundaryUnknown?: boolean): void {
    const value = BatchCheckpointSchema.parse({ row, boundaryUnknown })
    if (!value.row.nameComplete) throw new Error('contact_mismatch')
    this.db
      .prepare(
        'INSERT INTO foreground_batch_checkpoints VALUES (?,?) ON CONFLICT(target) DO UPDATE SET payload=excluded.payload'
      )
      .run(row.name, JSON.stringify(value))
  }
  saveBatch(row: ListRow, checkpoint: ForegroundCheckpoint): void {
    const value = BatchCheckpointSchema.parse({ row, checkpoint })
    if (checkpoint.baseline.contact !== row.name) throw new Error('contact_mismatch')
    this.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO foreground_batch_checkpoints VALUES (?,?) ON CONFLICT(target) DO UPDATE SET payload=excluded.payload'
        )
        .run(row.name, JSON.stringify(value))
      this.writeSingle(checkpoint)
    })
  }
  save(record: ForegroundRecord): void {
    const valid = ForegroundRecordSchema.parse(record)
    if (valid.state === 'handoff' && valid.handledAt === undefined) {
      const old = this.db
        .prepare(
          "SELECT json_extract(payload,'$.handledAt') AS handled_at FROM foreground_replies WHERE id=?"
        )
        .get(valid.id)
      if (typeof old?.handled_at === 'number') valid.handledAt = old.handled_at
    }
    this.markGenerated(valid.reply)
    this.db
      .prepare(
        'INSERT INTO foreground_replies VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload'
      )
      .run(valid.id, JSON.stringify(valid), valid.createdAt)
  }
  close(): void {
    this.db.close()
  }
}
