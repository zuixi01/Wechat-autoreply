import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { IdentitySchema, type Identity } from '../../shared/contracts/identity'
import { ReplyTaskSchema, type ReplyTask } from '../../shared/contracts/task'
import {
  ObservedMessageSchema,
  type ObservedMessage,
  type StoredMessage
} from '../../shared/contracts/message'
import { hashContext } from '../reply/hashes'
import type { ContextMessage } from '../../shared/contracts/context'
import { CentralOutbox } from './central-outbox'
import { ReplyRecords } from './reply-records'
import { CollectionStore } from './collection-store'
import { RestoreObservationGate } from './restore-observation-gate'
import {
  prepareRestoreCompletionIntent,
  readRestoreCompletionIntent,
  readRestoreCompletionAck,
  saveRestoreCompletionAck
} from './restore-completion-journal'
import type { DeviceScope } from '../../shared/contracts/registration'
import type { RestoreObservationGrant } from '../../shared/contracts/restore-observation'
import { LearningOutbox } from './learning-outbox'
import { LearningSubmissionStore } from './learning-submissions'
import { CURRENT_LEDGER_SCHEMA } from './ledger-schema'
import {
  applyRestoreApplication,
  saveRestoreApplicationAck,
  hasRestoreApplicationAck
} from './restore-application-journal'
import type { RestoreLocalApplicationReceipt } from '../../shared/contracts/restore-application'
import type { RestoreRecoveryLocalReceipt } from '../../shared/contracts/restore-recovery'
import type { RestoreResolutionLocalReceipt } from '../../shared/contracts/restore-resolution'
import {
  applyRestoreExecutionResolutions,
  readRestoreResolutionApplication
} from './restore-resolution-journal'
import {
  applyRestoreRecoveryBoundary,
  readRestoreRecoveryApplication
} from './restore-recovery-journal'
import { readRestorePauseReport, saveRestorePauseReport } from './restore-pause-journal'
import type { RestorePauseReport } from '../../shared/contracts/restoration'
import { readLedgerRestoreInventory, type LedgerRestoreInventory } from './restore-inventory'
import {
  readRestoreInventoryAttempt,
  saveRestoreInventoryAttempt
} from './restore-inventory-journal'
import type { RestoreInventoryStartInput } from '../../shared/contracts/restore-inventory'
import {
  hasLedgerRestoreEvidence,
  readLedgerRestoreContext,
  type LedgerRestoreContext
} from './ledger-restoration'

export type SendStatus =
  | 'prepared'
  | 'dispatching'
  | 'confirmed'
  | 'unknown'
  | 'cancelled'
  | 'rejected'
export interface SendRecord {
  executionId: string
  taskKey: string
  task: ReplyTask
  draftHash: string
  status: SendStatus
  reason: string | null
  evidence: string | null
  createdAt: number
  updatedAt: number
}
export interface ConversationSnapshot {
  revision: number
  hasGap: boolean
  humanOwned: boolean
  messages: StoredMessage[]
}

export function selectConversationContext(snapshot: ConversationSnapshot): ContextMessage[] {
  const selected: ContextMessage[] = []
  let length = 0
  for (const message of [...snapshot.messages].reverse()) {
    if (selected.length >= 40 || length + message.text.length > 32000) break
    const { sequence, sourceMessageId, direction, kind, text } = message
    selected.unshift({ sequence, sourceMessageId, direction, kind, text })
    length += text.length
  }
  return selected
}
export function hashConversationContext(snapshot: ConversationSnapshot): string {
  return hashContext(selectConversationContext(snapshot))
}

export function conversationKey(identity: Identity, conversationId: string): string {
  return hashContext({ identity: IdentitySchema.parse(identity), conversationId })
}

export function deliveryScope(identity: Identity, conversationId: string): string {
  return hashContext({
    tenantId: identity.tenantId,
    accountId: identity.accountId,
    platform: identity.platform,
    conversationId
  })
}

/** Local durable ledger. No network, UI side effects or model credentials belong here. */
export class Ledger {
  private readonly db: DatabaseSync
  readonly central: CentralOutbox
  readonly replies: ReplyRecords
  readonly collection: CollectionStore
  readonly learning: LearningOutbox
  readonly learningSubmissions: LearningSubmissionStore
  private readonly restoreObservations: RestoreObservationGate
  private transactionDepth = 0

  constructor(path: string, now = Date.now()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    const version = this.db.prepare('PRAGMA user_version').get()
    if (Number(version?.user_version ?? 0) > CURRENT_LEDGER_SCHEMA) {
      this.db.close()
      throw new Error('unsupported_ledger_version')
    }
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS conversations (
        scope TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0,
        has_gap INTEGER NOT NULL DEFAULT 0, last_sequence INTEGER NOT NULL DEFAULT 0,
        human_owned INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        scope TEXT NOT NULL REFERENCES conversations(scope), source_id TEXT NOT NULL,
        sequence INTEGER NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL, handled_execution TEXT,
        PRIMARY KEY(scope, source_id), UNIQUE(scope, sequence)
      );
      CREATE TABLE IF NOT EXISTS sends (
        execution_id TEXT PRIMARY KEY, task_key TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL, task TEXT NOT NULL, draft_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('prepared','dispatching','confirmed','unknown','cancelled','rejected')),
        reason TEXT, evidence TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sends_scope_status ON sends(scope, status);
      CREATE TABLE IF NOT EXISTS conversation_controls (
        delivery_scope TEXT PRIMARY KEY, human_owned INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS runtime_metadata (
        key TEXT PRIMARY KEY, value INTEGER NOT NULL CHECK(value>=0)
      );
    `)
    if (
      !this.db
        .prepare('PRAGMA table_info(messages)')
        .all()
        .some((column) => column.name === 'handled_execution')
    ) {
      this.db.exec('ALTER TABLE messages ADD COLUMN handled_execution TEXT')
    }
    if (
      !this.db
        .prepare('PRAGMA table_info(conversations)')
        .all()
        .some((column) => column.name === 'human_owned')
    ) {
      this.db.exec('ALTER TABLE conversations ADD COLUMN human_owned INTEGER NOT NULL DEFAULT 0')
    }
    this.central = new CentralOutbox(this.db, (id) => this.getSend(id))
    this.replies = new ReplyRecords(this.db)
    this.restoreObservations = new RestoreObservationGate(this.db)
    this.collection = new CollectionStore(
      this.db,
      (operation) => this.transaction(operation),
      (message) => this.observe(message),
      (identity, id) => this.markGap(identity, id),
      (identity) => this.restoreObservations.current(identity, Date.now())
    )
    this.learning = new LearningOutbox(this.db, (operation) => this.transaction(operation))
    this.learningSubmissions = new LearningSubmissionStore(this.db, (operation) =>
      this.transaction(operation)
    )
    this.db.exec(`PRAGMA user_version=${CURRENT_LEDGER_SCHEMA}`)
    // A restarted process cannot know if a dispatch reached the client. Never replay it.
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE sends SET status='unknown', reason='process_restarted', updated_at=? WHERE status='dispatching'"
        )
        .run(now)
      this.db
        .prepare(
          "UPDATE sends SET status='cancelled', reason='process_restarted', updated_at=? WHERE status='prepared'"
        )
        .run(now)
    })
    this.central.recover(now)
    this.replies.invalidate(now)
  }

  close(): void {
    this.db.close()
  }

  installRestoreObservationGrant(
    scope: DeviceScope,
    raw: unknown,
    now = Date.now()
  ): RestoreObservationGrant {
    return this.transaction(() => this.restoreObservations.install(scope, raw, now))
  }
  restoreObservationGrant(
    identity: Identity,
    now = Date.now()
  ): RestoreObservationGrant | undefined {
    return this.restoreObservations.current(identity, now)
  }
  observe(
    input: ObservedMessage,
    now = Date.now()
  ): {
    inserted: boolean
    sequence: number
    revision: number
    hasGap: boolean
    historical?: boolean
  } {
    const message = ObservedMessageSchema.parse(structuredClone(input))
    const scope = conversationKey(message.identity, message.conversationId)
    // Observation time changes on reread; the content and direction must remain stable.
    const fingerprint = hashContext({
      direction: message.direction,
      kind: message.kind,
      text: message.text
    })
    return this.transaction(() => {
      const historical = this.restoreObservations.classify(message, fingerprint, now)
      this.db.prepare('INSERT OR IGNORE INTO conversations(scope) VALUES(?)').run(scope)
      const conversation = this.db.prepare('SELECT * FROM conversations WHERE scope=?').get(scope)!
      const control = this.control(
        message.identity,
        message.conversationId,
        Boolean(conversation.human_owned)
      )
      const previous = this.db
        .prepare('SELECT sequence, payload_hash FROM messages WHERE scope=? AND source_id=?')
        .get(scope, message.sourceMessageId)
      const gap =
        !message.identityVerified ||
        !message.messageIdVerified ||
        (previous !== undefined && previous.payload_hash !== fingerprint)
      if (previous) {
        if (gap && !conversation.has_gap) {
          this.db
            .prepare('UPDATE conversations SET has_gap=1, revision=revision+1 WHERE scope=?')
            .run(scope)
        }
        const current = this.db
          .prepare('SELECT revision, has_gap FROM conversations WHERE scope=?')
          .get(scope)!
        return {
          inserted: false,
          sequence: Number(previous.sequence),
          revision: Number(current.revision) + Number(control.revision),
          hasGap: Boolean(current.has_gap),
          ...(historical ? { historical: true } : {})
        }
      }
      // Only a NEW human message reacquires the conversation. Rereading old
      // outbound history after explicit release must not keep taking it back.
      if (message.direction === 'human_outbound' && !historical)
        this.updateControl(message.identity, message.conversationId, true)
      const sequence = Number(conversation.last_sequence) + 1
      this.db
        .prepare(
          'INSERT INTO messages(scope,source_id,sequence,payload,payload_hash,handled_execution) VALUES(?,?,?,?,?,?)'
        )
        .run(
          scope,
          message.sourceMessageId,
          sequence,
          JSON.stringify(message),
          fingerprint,
          historical && message.direction === 'inbound' ? 'restore_history_observation' : null
        )
      this.db
        .prepare(
          'UPDATE conversations SET last_sequence=?, revision=revision+1, has_gap=MAX(has_gap,?) WHERE scope=?'
        )
        .run(sequence, gap ? 1 : 0, scope)
      return {
        inserted: true,
        sequence,
        revision:
          Number(conversation.revision) +
          1 +
          Number(this.control(message.identity, message.conversationId).revision),
        hasGap: gap || Boolean(conversation.has_gap),
        ...(historical ? { historical: true } : {})
      }
    })
  }

  markGap(identity: Identity, conversationId: string): void {
    const scope = conversationKey(identity, conversationId)
    this.db
      .prepare(
        `INSERT INTO conversations(scope,revision,has_gap) VALUES(?,1,1)
      ON CONFLICT(scope) DO UPDATE SET has_gap=1, revision=revision+1`
      )
      .run(scope)
  }

  setHumanOwned(identity: Identity, conversationId: string, owned: boolean): void {
    const scope = conversationKey(identity, conversationId)
    this.transaction(() => {
      this.updateControl(identity, conversationId, owned)
      this.db.prepare('INSERT OR IGNORE INTO conversations(scope) VALUES(?)').run(scope)
      // The legacy column is retained for v3 migration only. The stable control
      // takes precedence, including explicit release, across all login epochs.
    })
  }

  snapshot(identity: Identity, conversationId: string): ConversationSnapshot {
    const scope = conversationKey(identity, conversationId)
    return this.transaction(() => {
      const row = this.db
        .prepare('SELECT revision,has_gap,human_owned FROM conversations WHERE scope=?')
        .get(scope)
      const messages = this.db
        .prepare(
          'SELECT sequence,payload,handled_execution FROM messages WHERE scope=? ORDER BY sequence'
        )
        .all(scope)
      const control = this.control(identity, conversationId, Boolean(row?.human_owned))
      return {
        revision: Number(row?.revision ?? 0) + Number(control.revision),
        hasGap: Boolean(row?.has_gap),
        humanOwned: Boolean(control.human_owned),
        messages: messages.map((m) => ({
          ...ObservedMessageSchema.parse(JSON.parse(String(m.payload))),
          sequence: Number(m.sequence),
          handledBy: m.handled_execution === null ? null : String(m.handled_execution)
        }))
      }
    })
  }
  /** Bounded timing metadata: no body returned and no write, handling or send authority. */
  inboundReferences(
    task: ReplyTask
  ): { sourceMessageId: string; sequence: number; verified: boolean }[] {
    const rows = this.db
      .prepare(
        "SELECT source_id,sequence,(json_extract(payload,'$.identityVerified')=1 AND json_extract(payload,'$.messageIdVerified')=1) AS verified FROM messages WHERE scope=? AND sequence BETWEEN ? AND ? AND json_extract(payload,'$.direction')='inbound' ORDER BY sequence LIMIT 1001"
      )
      .all(
        conversationKey(task.identity, task.conversationId),
        task.inboundRange.from,
        task.inboundRange.to
      )
    if (rows.length > 1000) throw new Error('runtime_evidence_source_limit')
    return rows.map((row) => ({
      sourceMessageId: String(row.source_id),
      sequence: Number(row.sequence),
      verified: Boolean(row.verified)
    }))
  }

  /** Status polling does not read/reparse the conversation's full message history. */
  conversationState(
    identity: Identity,
    conversationId: string
  ): Pick<ConversationSnapshot, 'revision' | 'hasGap' | 'humanOwned'> {
    const scope = conversationKey(identity, conversationId)
    return this.transaction(() => {
      const row = this.db
        .prepare('SELECT revision,has_gap,human_owned FROM conversations WHERE scope=?')
        .get(scope)
      const control = this.control(identity, conversationId, Boolean(row?.human_owned))
      return {
        revision: Number(row?.revision ?? 0) + Number(control.revision),
        hasGap: Boolean(row?.has_gap),
        humanOwned: Boolean(control.human_owned)
      }
    })
  }

  private control(
    identity: Identity,
    conversationId: string,
    legacyOwned = false
  ): { human_owned: number; revision: number } {
    const scope = deliveryScope(identity, conversationId)
    this.db
      .prepare(
        'INSERT OR IGNORE INTO conversation_controls(delivery_scope,human_owned) VALUES(?,?)'
      )
      .run(scope, legacyOwned ? 1 : 0)
    const row = this.db
      .prepare('SELECT human_owned,revision FROM conversation_controls WHERE delivery_scope=?')
      .get(scope)!
    return { human_owned: Number(row.human_owned), revision: Number(row.revision) }
  }

  private updateControl(identity: Identity, conversationId: string, owned: boolean): void {
    this.control(identity, conversationId)
    this.db
      .prepare(
        `UPDATE conversation_controls SET human_owned=?,revision=revision+1
      WHERE delivery_scope=? AND human_owned<>?`
      )
      .run(owned ? 1 : 0, deliveryScope(identity, conversationId), owned ? 1 : 0)
  }

  prepare(
    taskInput: ReplyTask,
    draftHash: string,
    now: number
  ): { created: boolean; record: SendRecord } {
    if (this.requiresRestoreReview()) throw new Error('ledger_restore_reconciliation_required')
    const task = ReplyTaskSchema.parse(structuredClone(taskInput))
    if (!/^[a-f0-9]{64}$/.test(draftHash)) throw new Error('invalid_draft_hash')
    const taskKey = hashContext({ identity: task.identity, taskId: task.taskId })
    return this.transaction(() => {
      const existing = this.byTaskKey(taskKey)
      if (existing) return { created: false, record: existing }
      const executionId = randomUUID()
      this.db
        .prepare(
          `INSERT INTO sends(execution_id,task_key,scope,task,draft_hash,status,created_at,updated_at)
        VALUES(?,?,?,?,?,'prepared',?,?)`
        )
        .run(
          executionId,
          taskKey,
          deliveryScope(task.identity, task.conversationId),
          JSON.stringify(task),
          draftHash,
          now,
          now
        )
      return { created: true, record: this.getSend(executionId)! }
    })
  }

  transition(
    executionId: string,
    expected: SendStatus,
    next: SendStatus,
    now: number,
    reason: string | null = null,
    evidence: string | null = null
  ): boolean {
    if (next === 'dispatching' && this.requiresRestoreReview())
      throw new Error('ledger_restore_reconciliation_required')
    const allowed: Partial<Record<SendStatus, SendStatus[]>> = {
      prepared: ['dispatching', 'cancelled', 'rejected'],
      dispatching: ['confirmed', 'unknown', 'cancelled']
    }
    if (!allowed[expected]?.includes(next)) throw new Error('invalid_send_transition')
    if (next === 'confirmed' && !evidence) throw new Error('confirmation_evidence_required')
    return this.transaction(() => {
      const record = this.getSend(executionId)
      if (!record || record.status !== expected) return false
      const changed =
        this.db
          .prepare(
            'UPDATE sends SET status=?,reason=?,evidence=?,updated_at=? WHERE execution_id=? AND status=?'
          )
          .run(next, reason, evidence, now, executionId, expected).changes === 1
      if (changed && next === 'confirmed') {
        this.db
          .prepare(
            `UPDATE messages SET handled_execution=? WHERE scope=? AND sequence BETWEEN ? AND ?
          AND json_extract(payload,'$.direction')='inbound' AND handled_execution IS NULL`
          )
          .run(
            executionId,
            conversationKey(record.task.identity, record.task.conversationId),
            record.task.inboundRange.from,
            record.task.inboundRange.to
          )
      }
      return changed
    })
  }

  hasUnknown(identity: Identity, conversationId: string, excludingExecutionId = ''): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM sends WHERE scope=? AND execution_id<>? AND status IN ('dispatching','unknown') LIMIT 1"
        )
        .get(deliveryScope(identity, conversationId), excludingExecutionId)
    )
  }

  getSend(executionId: string): SendRecord | undefined {
    const row = this.db.prepare('SELECT * FROM sends WHERE execution_id=?').get(executionId)
    if (!row) return undefined
    return {
      executionId: String(row.execution_id),
      taskKey: String(row.task_key),
      task: ReplyTaskSchema.parse(JSON.parse(String(row.task))),
      draftHash: String(row.draft_hash),
      status: row.status as SendStatus,
      reason: row.reason === null ? null : String(row.reason),
      evidence: row.evidence === null ? null : String(row.evidence),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    }
  }

  findTask(identity: Identity, taskId: string): SendRecord | undefined {
    return this.byTaskKey(hashContext({ identity: IdentitySchema.parse(identity), taskId }))
  }

  /** Skip exactly this unchanged pending range. Neither unknown delivery nor new
   * inbound can be hidden by a renderer's old task selection. */
  skipReply(task: ReplyTask, now: number): boolean {
    return this.transaction(() => {
      const snapshot = this.snapshot(task.identity, task.conversationId)
      const range = snapshot.messages.filter(
        (m) =>
          m.direction === 'inbound' &&
          m.sequence >= task.inboundRange.from &&
          m.sequence <= task.inboundRange.to
      )
      if (
        snapshot.hasGap ||
        snapshot.revision !== task.conversationRevision ||
        hashConversationContext(snapshot) !== task.contextHash ||
        !range.length ||
        range.some((m) => m.handledBy !== null) ||
        this.hasUnknown(task.identity, task.conversationId) ||
        this.findTask(task.identity, task.taskId) ||
        !this.replies.update(task.identity, task.taskId, { status: 'skipped' }, now)
      )
        return false
      const scope = conversationKey(task.identity, task.conversationId)
      this.db
        .prepare(
          `UPDATE messages SET handled_execution=? WHERE scope=? AND sequence BETWEEN ? AND ?
        AND json_extract(payload,'$.direction')='inbound' AND handled_execution IS NULL`
        )
        .run(`skip:${task.taskId}`, scope, task.inboundRange.from, task.inboundRange.to)
      this.db.prepare('UPDATE conversations SET revision=revision+1 WHERE scope=?').run(scope)
      return true
    })
  }

  /** Restored history is not proof of the latest central execution state. */
  requiresRestoreReview(): boolean {
    return (
      hasLedgerRestoreEvidence(this.db) ||
      Number(
        this.db
          .prepare("SELECT value FROM runtime_metadata WHERE key='restore_review_required'")
          .get()?.value ?? 0
      ) !== 0
    )
  }

  restoreContext(): LedgerRestoreContext | null {
    return readLedgerRestoreContext(this.db)
  }
  restoreCompletionIntent(scope: unknown): ReturnType<typeof readRestoreCompletionIntent> {
    return this.transaction(() => readRestoreCompletionIntent(this.db, scope))
  }
  prepareRestoreCompletion(
    scope: unknown,
    id: string,
    grant: RestoreObservationGrant,
    now = Date.now()
  ): ReturnType<typeof prepareRestoreCompletionIntent> {
    return this.transaction(() => prepareRestoreCompletionIntent(this.db, scope, id, grant, now))
  }
  restoreCompletionAck(scope: unknown): ReturnType<typeof readRestoreCompletionAck> {
    return this.transaction(() => readRestoreCompletionAck(this.db, scope))
  }
  saveRestoreCompletionAck(
    scope: unknown,
    ack: unknown
  ): ReturnType<typeof saveRestoreCompletionAck> {
    return this.transaction(() => saveRestoreCompletionAck(this.db, scope, ack))
  }
  applyRestoreRecoveryBoundary(
    scope: unknown,
    input: unknown,
    now: number
  ): RestoreRecoveryLocalReceipt {
    return this.transaction(() => applyRestoreRecoveryBoundary(this.db, scope, input, now))
  }
  restoreRecoveryApplication(authorizationId: string): RestoreRecoveryLocalReceipt | null {
    return this.transaction(() => readRestoreRecoveryApplication(this.db, authorizationId))
  }
  applyRestoreExecutionResolutions(
    scope: unknown,
    input: unknown,
    now: number
  ): RestoreResolutionLocalReceipt {
    return this.transaction(() => applyRestoreExecutionResolutions(this.db, scope, input, now))
  }
  restoreResolutionApplication(authorizationId: string): RestoreResolutionLocalReceipt | null {
    return this.transaction(() => readRestoreResolutionApplication(this.db, authorizationId))
  }
  applyRestoreDecision(
    scope: unknown,
    input: unknown,
    now: number
  ): RestoreLocalApplicationReceipt {
    return this.transaction(() => applyRestoreApplication(this.db, scope, input, now))
  }
  saveRestoreApplicationAck(
    receipt: unknown,
    ack: unknown
  ): ReturnType<typeof saveRestoreApplicationAck> {
    return this.transaction(() => saveRestoreApplicationAck(this.db, receipt, ack))
  }
  hasRestoreApplicationAck(scope: unknown): boolean {
    return hasRestoreApplicationAck(this.db, scope)
  }
  restoreInventory(scope: unknown, input: unknown = {}): LedgerRestoreInventory {
    return readLedgerRestoreInventory(this.db, scope, input)
  }
  visitRestoreInventory(
    scope: unknown,
    visit: (item: LedgerRestoreInventory['items'][number]) => void
  ): LedgerRestoreInventory {
    return readLedgerRestoreInventory(this.db, scope, {}, visit)
  }
  restoreInventoryAttempt(sourceKey: string, now: number): RestoreInventoryStartInput | null {
    return readRestoreInventoryAttempt(this.db, sourceKey, now)
  }
  saveRestoreInventoryAttempt(
    sourceKey: string,
    request: RestoreInventoryStartInput,
    now: number
  ): RestoreInventoryStartInput {
    return this.transaction(() => saveRestoreInventoryAttempt(this.db, sourceKey, request, now))
  }
  restorePauseReport(challengeId: string): RestorePauseReport | null {
    return readRestorePauseReport(this.db, challengeId)
  }
  saveRestorePauseReport(report: RestorePauseReport): RestorePauseReport {
    return this.transaction(() => saveRestorePauseReport(this.db, report))
  }

  /** Persist before exposing a new run so restart cannot reuse old task authority. */
  nextRunEpoch(): number {
    return this.transaction(() => {
      const previous = Number(
        this.db.prepare("SELECT value FROM runtime_metadata WHERE key='run_epoch'").get()?.value ??
          0
      )
      const next = previous + 1
      if (!Number.isSafeInteger(next)) throw new Error('run_epoch_exhausted')
      this.db
        .prepare(
          "INSERT INTO runtime_metadata(key,value) VALUES('run_epoch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
        )
        .run(next)
      return next
    })
  }

  private byTaskKey(key: string): SendRecord | undefined {
    const row = this.db.prepare('SELECT execution_id FROM sends WHERE task_key=?').get(key)
    return row ? this.getSend(String(row.execution_id)) : undefined
  }

  private transaction<T>(operation: () => T): T {
    if (this.transactionDepth) return operation()
    this.db.exec('BEGIN IMMEDIATE')
    this.transactionDepth++
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.transactionDepth--
    }
  }
}
