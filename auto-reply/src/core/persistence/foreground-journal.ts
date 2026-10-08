import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import {
  ForegroundRecordSchema,
  ForegroundCheckpointSchema,
  type ForegroundCheckpoint,
  type ForegroundRecord
} from '../../shared/contracts/foreground-wechat'
import type { ForegroundJournal } from '../agent/foreground-wechat'
import type { ForegroundBatchStore } from '../agent/foreground-batch'
import { ListRowSchema, type ListRow } from '../../shared/contracts/foreground-batch'
import { z } from 'zod'
const BatchCheckpointSchema = z.strictObject({
  row: ListRowSchema,
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
  loadBatch(targets: string[]): { row: ListRow; checkpoint?: ForegroundCheckpoint }[] {
    if (!targets.length) return []
    return this.db
      .prepare(
        `SELECT payload FROM foreground_batch_checkpoints WHERE target IN (${targets.map(() => '?').join(',')}) AND coalesce(json_extract(payload, '$.checkpoint.pending'),1)=1`
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
  saveBatchHint(row: ListRow): void {
    const value = BatchCheckpointSchema.parse({ row })
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
    this.db
      .prepare(
        'INSERT INTO foreground_batch_checkpoints VALUES (?,?) ON CONFLICT(target) DO UPDATE SET payload=excluded.payload'
      )
      .run(row.name, JSON.stringify(value))
  }
  save(record: ForegroundRecord): void {
    const valid = ForegroundRecordSchema.parse(record)
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
