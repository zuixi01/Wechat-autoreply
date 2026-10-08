import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { ReplyTaskSchema, ReplyDraftSchema } from '../../shared/contracts/task'
import {
  LearningCorrectionInputSchema,
  LearningResultInputSchema,
  LearningHumanFeedbackInputSchema
} from '../../shared/contracts/learning-memory'
import { workbenchScopeOf, type WorkbenchScope } from '../../shared/contracts/workbench'
import { hashContext, hashDraft } from '../reply/hashes'

const common = {
  task: ReplyTaskSchema,
  draft: ReplyDraftSchema,
  at: z.number().int().nonnegative().safe()
}
export const LearningOutboxEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...common,
    kind: z.literal('correction'),
    input: LearningCorrectionInputSchema
  }),
  z.strictObject({ ...common, kind: z.literal('result'), input: LearningResultInputSchema }),
  z.strictObject({
    ...common,
    kind: z.literal('feedback'),
    input: LearningHumanFeedbackInputSchema
  })
])
export type LearningOutboxEvent = z.infer<typeof LearningOutboxEventSchema>
export type LearningOutboxState = 'pending' | 'saved' | 'forgotten'
function scopeKey(scope: WorkbenchScope): string {
  return hashContext(workbenchScopeOf(scope))
}
function retentionKey(scope: WorkbenchScope, conversationId?: string): string {
  return `learning_retention:${scopeKey(scope)}:${conversationId === undefined ? 'account' : hashContext(conversationId)}`
}
function fingerprint(event: LearningOutboxEvent): string {
  return hashContext({ kind: event.kind, task: event.task, draft: event.draft, input: event.input })
}
function verified(raw: unknown): LearningOutboxEvent {
  const event = LearningOutboxEventSchema.parse(raw)
  if (
    event.task.taskId !== event.draft.taskId ||
    hashDraft(event.draft.text) !== event.draft.draftHash ||
    event.at < event.task.createdAt
  )
    throw new Error('learning_task_changed')
  return event
}

/** Private event text exists only until acknowledgment, expiry or explicit forgetting. */
export class LearningOutbox {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: <T>(run: () => T) => T
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS learning_outbox (
      scope_key TEXT NOT NULL,source_id TEXT NOT NULL,event_hash TEXT NOT NULL,
      conversation_hash TEXT NOT NULL,payload TEXT,created_at INTEGER NOT NULL,at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','saved','forgotten')),
      PRIMARY KEY(scope_key,source_id),
      CHECK((state='pending' AND payload IS NOT NULL) OR (state!='pending' AND payload IS NULL))
    ); CREATE INDEX IF NOT EXISTS learning_outbox_pending ON learning_outbox(scope_key,state,at);`)
    this.transaction(() => {
      const format = db
        .prepare("SELECT value FROM runtime_metadata WHERE key='learning_outbox_source_format'")
        .get()
      if (format && format.value !== 1) throw new Error('learning_outbox_format_unsupported')
      if (!format) {
        for (const row of db.prepare('SELECT scope_key,source_id FROM learning_outbox').all())
          db.prepare(
            'UPDATE learning_outbox SET source_id=? WHERE scope_key=? AND source_id=?'
          ).run(hashContext(String(row.source_id)), row.scope_key, row.source_id)
        db.prepare(
          "INSERT INTO runtime_metadata(key,value) VALUES('learning_outbox_source_format',1)"
        ).run()
      }
    })
  }

  enqueue(raw: LearningOutboxEvent): string {
    const event = verified(raw),
      key = scopeKey(workbenchScopeOf(event.task.identity)),
      hash = fingerprint(event)
    return this.transaction(() => {
      const existing = this.db
        .prepare('SELECT event_hash,state FROM learning_outbox WHERE scope_key=? AND source_id=?')
        .get(key, hashContext(event.input.sourceId))
      if (existing) {
        if (existing.state === 'forgotten') throw new Error('learning_event_forgotten')
        if (existing.event_hash !== hash) throw new Error('learning_event_conflict')
      } else {
        this.db
          .prepare('INSERT INTO learning_outbox VALUES(?,?,?,?,?,?,?,?)')
          .run(
            key,
            hashContext(event.input.sourceId),
            hash,
            hashContext(event.task.conversationId),
            JSON.stringify(event),
            event.task.createdAt,
            event.at,
            'pending'
          )
      }
      return event.input.sourceId
    })
  }

  pending(scope: WorkbenchScope, now = Date.now(), retentionDays = 90): LearningOutboxEvent[] {
    const key = scopeKey(scope),
      days = z.number().int().min(7).max(365).parse(retentionDays)
    z.number().int().nonnegative().safe().parse(now)
    return this.transaction(() => {
      for (const row of this.db
        .prepare('SELECT value FROM runtime_metadata WHERE key LIKE ?')
        .all(`learning_retention:${key}:%`))
        z.number().int().min(7).max(365).parse(row.value)
      this.db
        .prepare(
          `UPDATE learning_outbox SET payload=NULL,state='forgotten' WHERE scope_key=? AND state!='forgotten' AND created_at<=?-
          COALESCE((SELECT value FROM runtime_metadata WHERE key=?||conversation_hash),
          (SELECT value FROM runtime_metadata WHERE key=?),?)*86400000`
        )
        .run(key, now, `learning_retention:${key}:`, retentionKey(scope), days)
      return this.db
        .prepare(
          "SELECT * FROM learning_outbox WHERE scope_key=? AND state='pending' ORDER BY at,rowid LIMIT 100"
        )
        .all(key)
        .map((row) => this.eventOf(row, key))
    })
  }

  /** Persist only the last host-verified effective policy, keyed without customer identifiers. */
  setRetention(
    scope: WorkbenchScope,
    conversationId: string | undefined,
    retentionDays: number
  ): void {
    const days = z.number().int().min(7).max(365).parse(retentionDays)
    if (conversationId !== undefined) z.string().trim().min(1).max(128).parse(conversationId)
    this.db
      .prepare(
        'INSERT INTO runtime_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      )
      .run(retentionKey(scope, conversationId), days)
  }

  /** Policy lookup precedes expiry: a longer customer override must survive the 90-day default. */
  pendingConversations(scope: WorkbenchScope): string[] {
    const key = scopeKey(scope)
    const rows = this.db
      .prepare("SELECT * FROM learning_outbox WHERE scope_key=? AND state='pending'")
      .all(key)
    return [...new Set(rows.map((row) => this.eventOf(row, key).task.conversationId))]
  }

  /** Rendering never expires evidence using a policy that may have changed on the server. */
  pendingForDisplay(scope: WorkbenchScope): LearningOutboxEvent[] {
    const key = scopeKey(scope)
    return this.db
      .prepare(
        "SELECT * FROM learning_outbox WHERE scope_key=? AND state='pending' ORDER BY at,rowid LIMIT 100"
      )
      .all(key)
      .map((row) => this.eventOf(row, key))
  }

  private eventOf(row: Record<string, unknown>, key: string): LearningOutboxEvent {
    try {
      const event = verified(JSON.parse(String(row.payload)))
      if (
        hashContext(event.input.sourceId) !== row.source_id ||
        scopeKey(workbenchScopeOf(event.task.identity)) !== key ||
        fingerprint(event) !== row.event_hash ||
        hashContext(event.task.conversationId) !== row.conversation_hash ||
        event.task.createdAt !== row.created_at ||
        event.at !== row.at
      )
        throw new Error('changed')
      return event
    } catch {
      throw new Error('learning_outbox_corrupt')
    }
  }

  state(scope: WorkbenchScope, sourceId: string): LearningOutboxState | undefined {
    const row = this.db
      .prepare('SELECT state FROM learning_outbox WHERE scope_key=? AND source_id=?')
      .get(scopeKey(scope), hashContext(sourceId))
    return row?.state as LearningOutboxState | undefined
  }

  acknowledge(scope: WorkbenchScope, sourceId: string): void {
    this.db
      .prepare(
        "UPDATE learning_outbox SET payload=NULL,state='saved' WHERE scope_key=? AND source_id=? AND state='pending'"
      )
      .run(scopeKey(scope), hashContext(sourceId))
  }

  discard(scope: WorkbenchScope, sourceId: string): void {
    this.db
      .prepare(
        "UPDATE learning_outbox SET payload=NULL,state='forgotten' WHERE scope_key=? AND source_id=? AND state='pending'"
      )
      .run(scopeKey(scope), hashContext(sourceId))
  }

  forget(scope: WorkbenchScope, conversationId?: string): void {
    const key = scopeKey(scope)
    if (conversationId === undefined)
      this.db
        .prepare("UPDATE learning_outbox SET payload=NULL,state='forgotten' WHERE scope_key=?")
        .run(key)
    else
      this.db
        .prepare(
          "UPDATE learning_outbox SET payload=NULL,state='forgotten' WHERE scope_key=? AND conversation_hash=?"
        )
        .run(key, hashContext(conversationId))
  }

  /** An account-level server forget also covers older device bindings in this local ledger. */
  forgetAccount(raw: WorkbenchScope, conversationId?: string): void {
    const scope = workbenchScopeOf(raw)
    if (conversationId !== undefined) z.string().trim().min(1).max(128).parse(conversationId)
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE learning_outbox SET payload=NULL,state='forgotten'
        WHERE state='pending' AND json_extract(payload,'$.task.identity.tenantId')=?
        AND json_extract(payload,'$.task.identity.accountId')=? AND json_extract(payload,'$.task.identity.platform')=?
        ${conversationId === undefined ? '' : 'AND conversation_hash=?'}`
        )
        .run(
          ...[
            scope.tenantId,
            scope.accountId,
            scope.platform,
            ...(conversationId === undefined ? [] : [hashContext(conversationId)])
          ]
        )
      this.forget(scope, conversationId)
    })
  }
}
