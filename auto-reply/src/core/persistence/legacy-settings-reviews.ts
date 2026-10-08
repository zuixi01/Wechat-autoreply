import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  LegacyReviewInputSchema,
  LegacyReviewRecordSchema,
  type LegacySettingsDraft,
  type LegacyReviewRecord,
  type LegacyReviewResult
} from '../../shared/contracts/legacy-migration'
import { hashContext } from '../reply/hashes'

export const legacyReviewDdl = `
  CREATE TABLE IF NOT EXISTS legacy_settings_reviews(
    source_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES legacy_settings_drafts(id),
    revision INTEGER NOT NULL CHECK(revision>0), request_hash TEXT NOT NULL,
    record_hash TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(draft_id,revision));
  CREATE TRIGGER IF NOT EXISTS legacy_review_no_update BEFORE UPDATE ON legacy_settings_reviews
    BEGIN SELECT RAISE(ABORT,'immutable_review'); END;
  CREATE TRIGGER IF NOT EXISTS legacy_review_no_delete BEFORE DELETE ON legacy_settings_reviews
    BEGIN SELECT RAISE(ABORT,'immutable_review'); END;
`

/** Private human provenance only: no customer binding or execution authority. */
export class LegacySettingsReviews {
  constructor(
    private readonly db: DatabaseSync,
    private readonly workspace: string,
    private readonly getDraft: (id: string) => LegacySettingsDraft
  ) {}

  history(id: string): LegacyReviewRecord[] {
    const draft = this.getDraft(id)
    if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) === 1) return []
    try {
      const rows = this.db
        .prepare('SELECT * FROM legacy_settings_reviews WHERE draft_id=? ORDER BY revision')
        .all(id)
      let previous: string | null = null
      return rows.map((row, index) => {
        const record = LegacyReviewRecordSchema.parse(JSON.parse(String(row.payload)))
        const { recordHash, ...body } = record
        const request = LegacyReviewInputSchema.parse({
          sourceId: record.sourceId,
          draftId: record.draftId,
          expectedContentHash: record.expectedContentHash,
          expectedReviewRevision: record.expectedReviewRevision,
          decision: record.decision,
          reason: record.reason,
          ...(record.replyRules === undefined ? {} : { replyRules: record.replyRules })
        })
        if (
          record.workspaceId !== this.workspace ||
          record.draftId !== draft.id ||
          record.expectedContentHash !== draft.contentHash ||
          record.revision !== index + 1 ||
          record.expectedReviewRevision !== index ||
          record.previousHash !== previous ||
          recordHash !== hashContext(body) ||
          record.requestHash !==
            hashContext({ workspace: this.workspace, reviewer: record.reviewer, input: request }) ||
          row.source_id !== record.sourceId ||
          row.draft_id !== record.draftId ||
          row.revision !== record.revision ||
          row.record_hash !== recordHash ||
          row.request_hash !== record.requestHash ||
          !this.validRules(draft, request)
        )
          throw new Error('invalid')
        previous = recordHash
        return record
      })
    } catch {
      throw new Error('legacy_settings_archive_corrupt')
    }
  }

  private validRules(
    draft: LegacySettingsDraft,
    input: { decision: string; replyRules?: string }
  ): boolean {
    return input.decision === 'accept' && draft.content.kind === 'mode'
      ? input.replyRules !== undefined
      : input.replyRules === undefined
  }

  record(value: unknown, actor: string): LegacyReviewResult {
    let input: z.infer<typeof LegacyReviewInputSchema>, reviewer: string
    try {
      input = LegacyReviewInputSchema.parse(value)
      reviewer = z.string().trim().min(1).max(200).parse(actor)
    } catch {
      throw new Error('legacy_settings_review_invalid')
    }
    const draft = this.getDraft(input.draftId)
    if (!this.validRules(draft, input)) throw new Error('legacy_settings_review_invalid')
    const requestHash = hashContext({ workspace: this.workspace, reviewer, input })
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const history = this.history(draft.id),
        revision = history.length
      const existing = this.db
        .prepare('SELECT draft_id FROM legacy_settings_reviews WHERE source_id=?')
        .get(input.sourceId)
      if (existing) {
        const record = this.history(String(existing.draft_id)).find(
          (r) => r.sourceId === input.sourceId
        )
        if (!record || record.requestHash !== requestHash)
          throw new Error('legacy_settings_review_conflict')
        this.db.exec('COMMIT')
        return { record, currentReviewRevision: revision, isCurrent: record.revision === revision }
      }
      if (
        input.expectedContentHash !== draft.contentHash ||
        input.expectedReviewRevision !== revision
      )
        throw new Error('legacy_settings_review_conflict')
      const body = {
        ...input,
        workspaceId: this.workspace,
        reviewer,
        revision: revision + 1,
        previousHash: history.length ? history[history.length - 1].recordHash : null,
        requestHash,
        createdAt: Date.now(),
        automaticEnabled: false as const,
        identityVerified: false as const
      }
      const record = LegacyReviewRecordSchema.parse({ ...body, recordHash: hashContext(body) })
      this.db
        .prepare('INSERT INTO legacy_settings_reviews VALUES(?,?,?,?,?,?)')
        .run(
          record.sourceId,
          draft.id,
          record.revision,
          requestHash,
          record.recordHash,
          JSON.stringify(record)
        )
      this.db.exec('COMMIT')
      return { record, currentReviewRevision: record.revision, isCurrent: true }
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      if (
        error instanceof Error &&
        ['legacy_settings_review_conflict', 'legacy_settings_archive_corrupt'].includes(
          error.message
        )
      )
        throw error
      throw new Error('legacy_settings_review_failed')
    }
  }
}
