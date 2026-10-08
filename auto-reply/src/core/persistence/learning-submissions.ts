import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  LearningEpisodeSchema,
  MemoryScopeSchema,
  type MemoryScope
} from '../../shared/contracts/learning-memory'
import {
  LearningSubmissionAuthoritySchema,
  LearningSubmissionIntentSchema,
  LearningSubmissionReceiptSchema,
  LearningSubmissionErrorSchema,
  type LearningSubmissionError,
  type LearningSubmissionIntent,
  type LearningSubmissionReceipt
} from '../../shared/contracts/learning-submissions'
import { accountMemoryScope, learningHash, memoryScopeKey } from '../memory/learning-scope'

type Row = Record<string, unknown>
const timestamp = z.number().int().nonnegative().safe()
const retention = z.number().int().min(7).max(365)
function fingerprint(value: LearningSubmissionIntent): string {
  return learningHash({ kind: value.kind, input: value.input, authorityId: value.authorityId })
}
function receipt(row: Row, errorCode?: LearningSubmissionError): LearningSubmissionReceipt {
  return LearningSubmissionReceiptSchema.parse({
    sourceId: row.source_id,
    kind: row.kind,
    state: row.state,
    firstSubmittedAt: row.submitted_at,
    evidenceAt: row.evidence_at,
    ...(errorCode === undefined ? {} : { errorCode })
  })
}

/** A transport journal only; acknowledged content remains in the authoritative learning store. */
export class LearningSubmissionStore {
  private errorKey(row: Row): string {
    return `learning_submission_error:${row.scope_key}:${row.authority_id}:${learningHash(row.source_id)}`
  }
  private readReceipt(row: Row): LearningSubmissionReceipt {
    const code = this.db
      .prepare('SELECT value FROM runtime_metadata WHERE key=?')
      .get(this.errorKey(row))?.value
    return receipt(row, code === undefined ? undefined : LearningSubmissionErrorSchema.parse(code))
  }
  markError(
    scope: MemoryScope,
    authorityId: string,
    sourceId: string,
    errorCode: LearningSubmissionError
  ): void {
    const key = memoryScopeKey(scope)
    LearningSubmissionAuthoritySchema.parse(authorityId)
    z.uuid().parse(sourceId)
    const code = LearningSubmissionErrorSchema.parse(errorCode)
    const row = this.db
      .prepare(
        "SELECT * FROM learning_submissions WHERE scope_key=? AND authority_id=? AND source_id=? AND state='pending'"
      )
      .get(key, authorityId, sourceId)
    if (!row) return
    this.db
      .prepare(
        'INSERT INTO runtime_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      )
      .run(this.errorKey(row), code)
  }
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: <T>(run: () => T) => T
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS learning_submissions (
      scope_key TEXT NOT NULL,account_key TEXT NOT NULL,conversation_hash TEXT NOT NULL,
      authority_id TEXT NOT NULL,source_id TEXT NOT NULL,kind TEXT NOT NULL,
      event_hash TEXT NOT NULL,payload TEXT,submitted_at INTEGER NOT NULL,evidence_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','saved','forgotten')),
      PRIMARY KEY(scope_key,authority_id,source_id),
      CHECK((state='pending' AND payload IS NOT NULL) OR (state!='pending' AND payload IS NULL))
    ); CREATE INDEX IF NOT EXISTS learning_submissions_pending
      ON learning_submissions(scope_key,authority_id,state,submitted_at);`)
  }

  enqueue(raw: unknown): LearningSubmissionReceipt {
    const value = LearningSubmissionIntentSchema.parse(raw)
    const key = memoryScopeKey(value.input.scope)
    return this.transaction(() => {
      const previous = this.db
        .prepare(
          'SELECT * FROM learning_submissions WHERE scope_key=? AND authority_id=? AND source_id=?'
        )
        .get(key, value.authorityId, value.input.sourceId)
      if (previous) {
        if (previous.state === 'forgotten') throw new Error('learning_submission_forgotten')
        if (previous.event_hash !== fingerprint(value))
          throw new Error('learning_submission_conflict')
        return this.readReceipt(previous)
      }
      const cutoffs = [value.input.scope, accountMemoryScope(value.input.scope)].map(
        (scope) =>
          this.db
            .prepare('SELECT value FROM runtime_metadata WHERE key=?')
            .get(`learning_submission_forget:${memoryScopeKey(scope)}`)?.value
      )
      if (
        cutoffs.some(
          (cutoff) => cutoff !== undefined && value.firstSubmittedAt <= timestamp.parse(cutoff)
        )
      )
        throw new Error('learning_submission_forgotten')
      this.db
        .prepare('INSERT INTO learning_submissions VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(
          key,
          memoryScopeKey(accountMemoryScope(value.input.scope)),
          learningHash(value.input.scope.conversationId ?? null),
          value.authorityId,
          value.input.sourceId,
          value.kind,
          fingerprint(value),
          JSON.stringify(value),
          value.firstSubmittedAt,
          value.evidenceAt,
          'pending'
        )
      return LearningSubmissionReceiptSchema.parse({
        sourceId: value.input.sourceId,
        kind: value.kind,
        state: 'pending',
        firstSubmittedAt: value.firstSubmittedAt,
        evidenceAt: value.evidenceAt
      })
    })
  }

  setRetention(scope: MemoryScope, days: number): void {
    const key = memoryScopeKey(scope),
      valid = retention.parse(days)
    this.db
      .prepare(
        `INSERT INTO runtime_metadata(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`
      )
      .run(`learning_submission_retention:${key}`, valid)
  }

  private episodePrefix(scope: MemoryScope): string {
    return `learning_submission_episode:${memoryScopeKey(accountMemoryScope(scope))}:${memoryScopeKey(scope)}:`
  }

  /** Called only after an authorized host read; no message content is copied into the journal. */
  observeEpisode(raw: unknown): void {
    const episode = LearningEpisodeSchema.parse(raw)
    for (const scope of [episode.scope, accountMemoryScope(episode.scope)]) {
      const cutoff = this.db
        .prepare('SELECT value FROM runtime_metadata WHERE key=?')
        .get(`learning_submission_forget:${memoryScopeKey(scope)}`)?.value
      if (cutoff !== undefined && episode.startedAt <= timestamp.parse(cutoff)) return
    }
    this.db
      .prepare(
        `INSERT INTO runtime_metadata(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=MIN(runtime_metadata.value,excluded.value)`
      )
      .run(this.episodePrefix(episode.scope) + learningHash(episode.id), episode.startedAt)
  }

  episodeTime(scope: MemoryScope, id: string): number | undefined {
    const validId = z.string().trim().min(1).max(128).parse(id)
    const row = this.db
      .prepare('SELECT value FROM runtime_metadata WHERE key=?')
      .get(this.episodePrefix(scope) + learningHash(validId))
    return row ? timestamp.parse(row.value) : undefined
  }

  pruneEpisodeTimes(now = Date.now()): void {
    timestamp.parse(now)
    this.transaction(() => {
      for (const row of this.db
        .prepare(
          "SELECT key,value FROM runtime_metadata WHERE key LIKE 'learning_submission_episode:%'"
        )
        .all()) {
        const match =
          /^learning_submission_episode:([a-f0-9]{64}):([a-f0-9]{64}):([a-f0-9]{64})$/.exec(
            String(row.key)
          )
        if (!match) throw new Error('learning_submission_corrupt')
        const customer = this.db
          .prepare('SELECT value FROM runtime_metadata WHERE key=?')
          .get(`learning_submission_retention:${match[2]}`)?.value
        const account = this.db
          .prepare('SELECT value FROM runtime_metadata WHERE key=?')
          .get(`learning_submission_retention:${match[1]}`)?.value
        const days = retention.parse(customer ?? account ?? 365)
        if (timestamp.parse(row.value) <= now - days * 86400000)
          this.db.prepare('DELETE FROM runtime_metadata WHERE key=?').run(String(row.key))
      }
    })
  }

  pendingScopes(): MemoryScope[] {
    const scopes = new Map<string, MemoryScope>()
    for (const row of this.db
      .prepare("SELECT * FROM learning_submissions WHERE state='pending'")
      .all()) {
      try {
        const intent = LearningSubmissionIntentSchema.parse(JSON.parse(String(row.payload)))
        const key = memoryScopeKey(intent.input.scope)
        if (
          key !== row.scope_key ||
          intent.authorityId !== row.authority_id ||
          fingerprint(intent) !== row.event_hash
        )
          throw new Error('mismatch')
        scopes.set(key, intent.input.scope)
      } catch {
        throw new Error('learning_submission_corrupt')
      }
    }
    return [...scopes.values()]
  }

  prune(scope: MemoryScope, now = Date.now()): void {
    const parsed = MemoryScopeSchema.parse(scope),
      key = memoryScopeKey(parsed)
    timestamp.parse(now)
    this.transaction(() => {
      const customer = this.db
        .prepare('SELECT value FROM runtime_metadata WHERE key=?')
        .get(`learning_submission_retention:${key}`)?.value
      const account = this.db
        .prepare('SELECT value FROM runtime_metadata WHERE key=?')
        .get(`learning_submission_retention:${memoryScopeKey(accountMemoryScope(parsed))}`)?.value
      // Unknown policy permits cleanup at the legal maximum only; synchronization must fetch current policy.
      const days = retention.parse(customer ?? account ?? 365)
      for (const row of this.db
        .prepare(
          "SELECT * FROM learning_submissions WHERE scope_key=? AND state='pending' AND evidence_at<=?"
        )
        .all(key, now - days * 86400000))
        this.db.prepare('DELETE FROM runtime_metadata WHERE key=?').run(this.errorKey(row))
      this.db
        .prepare(
          `UPDATE learning_submissions SET payload=NULL,state='forgotten'
        WHERE scope_key=? AND state='pending' AND evidence_at<=?`
        )
        .run(key, now - days * 86400000)
      this.db
        .prepare('DELETE FROM runtime_metadata WHERE key LIKE ? AND value<=?')
        .run(this.episodePrefix(parsed) + '%', now - days * 86400000)
    })
  }

  pending(scope: MemoryScope, authorityId: string, now = Date.now()): LearningSubmissionIntent[] {
    const key = memoryScopeKey(MemoryScopeSchema.parse(scope))
    LearningSubmissionAuthoritySchema.parse(authorityId)
    return this.transaction(() => {
      this.prune(scope, now)
      return this.db
        .prepare(
          `SELECT * FROM learning_submissions
        WHERE scope_key=? AND authority_id=? AND state='pending' ORDER BY submitted_at,source_id LIMIT 100`
        )
        .all(key, authorityId)
        .map((row) => {
          try {
            const value = LearningSubmissionIntentSchema.parse(JSON.parse(String(row.payload)))
            if (
              memoryScopeKey(value.input.scope) !== key ||
              value.authorityId !== authorityId ||
              value.input.sourceId !== row.source_id ||
              value.kind !== row.kind ||
              fingerprint(value) !== row.event_hash ||
              value.firstSubmittedAt !== row.submitted_at ||
              value.evidenceAt !== row.evidence_at
            )
              throw new Error('mismatch')
            return value
          } catch {
            throw new Error('learning_submission_corrupt')
          }
        })
    })
  }

  receipts(scope: MemoryScope, authorityId: string): LearningSubmissionReceipt[] {
    const key = memoryScopeKey(scope)
    LearningSubmissionAuthoritySchema.parse(authorityId)
    return this.db
      .prepare(
        `SELECT * FROM learning_submissions WHERE scope_key=? AND authority_id=?
      ORDER BY submitted_at DESC,source_id LIMIT 100`
      )
      .all(key, authorityId)
      .map((row) => this.readReceipt(row))
  }

  receipt(
    scope: MemoryScope,
    authorityId: string,
    sourceId: string
  ): LearningSubmissionReceipt | undefined {
    const key = memoryScopeKey(scope)
    LearningSubmissionAuthoritySchema.parse(authorityId)
    z.uuid().parse(sourceId)
    const row = this.db
      .prepare(
        'SELECT * FROM learning_submissions WHERE scope_key=? AND authority_id=? AND source_id=?'
      )
      .get(key, authorityId, sourceId)
    return row ? this.readReceipt(row) : undefined
  }

  acknowledge(scope: MemoryScope, authorityId: string, sourceId: string): void {
    const key = memoryScopeKey(scope)
    LearningSubmissionAuthoritySchema.parse(authorityId)
    z.uuid().parse(sourceId)
    this.db
      .prepare(
        `UPDATE learning_submissions SET payload=NULL,state='saved'
      WHERE scope_key=? AND authority_id=? AND source_id=? AND state='pending'`
      )
      .run(key, authorityId, sourceId)
    this.db
      .prepare('DELETE FROM runtime_metadata WHERE key=?')
      .run(this.errorKey({ scope_key: key, authority_id: authorityId, source_id: sourceId }))
  }

  forget(scope: MemoryScope, now = Date.now()): void {
    const parsed = MemoryScopeSchema.parse(scope)
    timestamp.parse(now)
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO runtime_metadata(key,value) VALUES(?,?)
        ON CONFLICT(key) DO UPDATE SET value=MAX(runtime_metadata.value,excluded.value)`
        )
        .run(`learning_submission_forget:${memoryScopeKey(parsed)}`, now)
      const prefix =
        parsed.conversationId === undefined
          ? `learning_submission_episode:${memoryScopeKey(accountMemoryScope(parsed))}:`
          : this.episodePrefix(parsed)
      this.db.prepare('DELETE FROM runtime_metadata WHERE key LIKE ?').run(prefix + '%')
      for (const row of this.db
        .prepare(
          `SELECT * FROM learning_submissions WHERE account_key=? ${parsed.conversationId === undefined ? '' : 'AND conversation_hash=?'}`
        )
        .all(
          memoryScopeKey(accountMemoryScope(parsed)),
          ...(parsed.conversationId === undefined ? [] : [learningHash(parsed.conversationId)])
        ))
        this.db.prepare('DELETE FROM runtime_metadata WHERE key=?').run(this.errorKey(row))
      this.db
        .prepare(
          `UPDATE learning_submissions SET payload=NULL,state='forgotten'
        WHERE account_key=? ${parsed.conversationId === undefined ? '' : 'AND conversation_hash=?'}`
        )
        .run(
          memoryScopeKey(accountMemoryScope(parsed)),
          ...(parsed.conversationId === undefined ? [] : [learningHash(parsed.conversationId)])
        )
    })
  }
}
