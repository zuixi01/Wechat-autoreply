import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { DeviceScopeSchema, type DeviceScope } from '../../shared/contracts/registration'
import { type Identity, sameIdentity, Hash } from '../../shared/contracts/identity'
import { ObservedMessageSchema } from '../../shared/contracts/message'
import { ReplyTaskSchema } from '../../shared/contracts/task'
import {
  PermitRequestSchema,
  ExecutionPermitSchema,
  ExecutionReceiptSchema
} from '../../shared/contracts/execution'
import { hashContext } from '../reply/hashes'
import { supportedLedgerSchema } from './ledger-schema'
import { readLedgerRestoreContext, type LedgerRestoreContext } from './ledger-restoration'

const NumberValue = z.number().int().nonnegative().safe()
const Status = z.enum(['prepared', 'dispatching', 'confirmed', 'unknown', 'cancelled', 'rejected'])
const Phase = z.enum([
  'requesting',
  'issued',
  'dispatching',
  'receipt_pending',
  'settled',
  'unresolved'
])
const Page = z.strictObject({
  after: z.string().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  expectedBasisHash: Hash.optional()
})
export interface RestoreMessageInventory {
  kind: 'message'
  key: string
  identity: Identity
  conversationId: string
  sourceMessageId: string
  sequence: number
  observedAt: number
  sequenceComplete: boolean
  direction: 'inbound' | 'human_outbound' | 'automation_outbound'
  contentHash: string
  handledBy: string | null
  identityVerified: boolean
  messageIdVerified: boolean
  hasGap: boolean
  humanOwned: boolean
  lastSequence: number
  revision: number
}
export interface RestoreExecutionInventory {
  kind: 'execution'
  key: string
  identity: Identity
  conversationId: string
  executionId: string
  taskId: string
  taskHash: string
  draftHash: string
  inboundRange: { from: number; to: number }
  localRangePresent: boolean
  status: z.infer<typeof Status>
  phase: z.infer<typeof Phase> | null
  permitId: string | null
  requestHash: string | null
  permitHash: string | null
  permitStatus: 'issued' | 'confirmed' | 'not_sent' | 'unknown' | null
  centralUpdatedAt: number | null
  conversation: {
    lastSequence: number
    revision: number
    hasGap: boolean
    humanOwned: boolean
    sequenceComplete: boolean
  } | null
  controlHash: string | null
  receiptStatus: 'confirmed' | 'not_sent' | 'unknown' | null
  receiptHash: string | null
  evidenceHash: string | null
  baselineSequence: number | null
  createdAt: number
  updatedAt: number
}
export interface LedgerRestoreInventory {
  formatVersion: 1
  evidenceKind: 'local_restored_metadata'
  context: LedgerRestoreContext
  scope: DeviceScope
  basisHash: string
  canRelease: false
  externalEvidenceRequired: true
  summary: {
    conversations: number
    messages: number
    inbound: number
    handledInbound: number
    unhandledInbound: number
    executions: number
    unknownExecutions: number
    pendingCentral: number
  }
  items: (RestoreMessageInventory | RestoreExecutionInventory)[]
  nextAfter: string | null
}
function matches(identity: Identity, scope: DeviceScope): boolean {
  return (
    identity.tenantId === scope.tenant_id &&
    identity.employeeId === scope.employee_id &&
    identity.accountId === scope.account_id &&
    identity.agentId === scope.agent_id &&
    identity.platform === scope.platform
  )
}
function conversationScope(identity: Identity, conversationId: string): string {
  return hashContext({ identity, conversationId })
}
function deliveryScope(identity: Identity, conversationId: string): string {
  return hashContext({
    tenantId: identity.tenantId,
    accountId: identity.accountId,
    platform: identity.platform,
    conversationId
  })
}
function json(value: unknown): unknown {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1048576)
    throw Error('invalid')
  return JSON.parse(value)
}
function boolean(value: unknown): boolean {
  if (value !== 0 && value !== 1) throw Error('invalid')
  return value === 1
}
function requireUnique(db: DatabaseSync, table: string, columns: string[]): void {
  const indexes = db
    .prepare('SELECT name FROM pragma_index_list(?) WHERE "unique"=1 AND partial=0')
    .all(table)
  if (
    !indexes.some(
      (index) =>
        db
          .prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
          .all(String(index.name))
          .map((column) => column.name)
          .join(',') === columns.join(',')
    )
  )
    throw Error('invalid')
}
/** Explicit read only; no Ledger constructor, recovery writes, client reads or release. */
export function readLedgerRestoreInventory(
  db: DatabaseSync,
  scopeInput: unknown,
  input: unknown = {},
  visit?: (item: LedgerRestoreInventory['items'][number]) => void
): LedgerRestoreInventory {
  const ownTransaction = !db.isTransaction
  try {
    const scope = DeviceScopeSchema.parse(scopeInput),
      page = Page.parse(input)
    if (ownTransaction) db.exec('BEGIN')
    if (!supportedLedgerSchema(db.prepare('PRAGMA user_version').get()?.user_version))
      throw Error('invalid')
    if (
      db.prepare('PRAGMA foreign_key_check').get() ||
      db
        .prepare(
          `SELECT a.execution_id FROM central_attempts a
      LEFT JOIN sends s ON s.execution_id=a.execution_id WHERE s.execution_id IS NULL LIMIT 1`
        )
        .get()
    )
      throw Error('invalid')
    for (const [table, columns] of [
      ['messages', ['scope', 'source_id']],
      ['messages', ['scope', 'sequence']],
      ['sends', ['execution_id']],
      ['sends', ['task_key']],
      ['conversations', ['scope']],
      ['conversation_controls', ['delivery_scope']],
      ['central_attempts', ['execution_id']],
      ['central_attempts', ['permit_id']]
    ] as [string, string[]][])
      requireUnique(db, table, columns)
    const context = readLedgerRestoreContext(db)
    if (!context) throw Error('invalid')
    const summary: LedgerRestoreInventory['summary'] = {
      conversations: 0,
      messages: 0,
      inbound: 0,
      handledInbound: 0,
      unhandledInbound: 0,
      executions: 0,
      unknownExecutions: 0,
      pendingCentral: 0
    }
    const digest = createHash('sha256').update(hashContext({ formatVersion: 1, context, scope })),
      items: LedgerRestoreInventory['items'] = [],
      conversations = new Set<string>(),
      itemKeys = new Set<string>()
    let hasMore = false,
      scanned = 0
    const add = (item: LedgerRestoreInventory['items'][number]): void => {
      if (itemKeys.has(item.key)) throw Error('invalid')
      itemKeys.add(item.key)
      digest.update(hashContext(item))
      visit?.(item)
      if (!page.after || item.key > page.after) {
        if (items.length < page.limit) items.push(item)
        else hasMore = true
      }
    }
    for (const row of db
      .prepare(
        `SELECT m.*,c.last_sequence,c.revision,c.has_gap,c.human_owned,COUNT(*) OVER(PARTITION BY m.scope) AS local_count
      FROM messages m LEFT JOIN conversations c ON c.scope=m.scope ORDER BY m.scope,m.sequence`
      )
      .iterate()) {
      if (++scanned > 1000000) throw Error('invalid')
      const message = ObservedMessageSchema.parse(json(row.payload))
      if (!matches(message.identity, scope)) continue
      const sequence = NumberValue.parse(row.sequence),
        lastSequence = NumberValue.parse(row.last_sequence),
        localScope = conversationScope(message.identity, message.conversationId)
      if (
        sequence < 1 ||
        lastSequence < sequence ||
        row.scope !== localScope ||
        row.source_id !== message.sourceMessageId ||
        row.payload_hash !==
          hashContext({ direction: message.direction, kind: message.kind, text: message.text })
      )
        throw Error('invalid')
      const control = db
        .prepare('SELECT human_owned,revision FROM conversation_controls WHERE delivery_scope=?')
        .get(deliveryScope(message.identity, message.conversationId))
      const handledBy =
        row.handled_execution === null
          ? null
          : z.string().min(1).max(256).parse(row.handled_execution)
      const item: RestoreMessageInventory = {
        kind: 'message',
        key: `m:${localScope}:${String(sequence).padStart(16, '0')}`,
        identity: message.identity,
        conversationId: message.conversationId,
        sourceMessageId: message.sourceMessageId,
        sequence,
        observedAt: NumberValue.parse(message.observedAt),
        sequenceComplete: NumberValue.parse(row.local_count) === lastSequence,
        direction: message.direction,
        contentHash: Hash.parse(row.payload_hash),
        handledBy,
        identityVerified: message.identityVerified,
        messageIdVerified: message.messageIdVerified,
        hasGap: boolean(row.has_gap),
        humanOwned: boolean(control?.human_owned ?? row.human_owned),
        lastSequence,
        revision: NumberValue.parse(
          NumberValue.parse(row.revision) + NumberValue.parse(control?.revision ?? 0)
        )
      }
      if (!conversations.has(localScope)) {
        conversations.add(localScope)
        summary.conversations++
      }
      summary.messages++
      if (message.direction === 'inbound') {
        summary.inbound++
        if (handledBy === null) summary.unhandledInbound++
        else summary.handledInbound++
      }
      add(item)
    }
    for (const row of db
      .prepare(
        `SELECT s.*,a.phase,a.request_json,a.permit_id,a.permit_json,a.receipt_json,a.baseline_sequence,a.updated_at AS central_updated_at
      FROM sends s LEFT JOIN central_attempts a ON a.execution_id=s.execution_id ORDER BY s.execution_id`
      )
      .iterate()) {
      if (++scanned > 1100000) throw Error('invalid')
      const task = ReplyTaskSchema.parse(json(row.task))
      if (!matches(task.identity, scope)) continue
      const executionId = z.uuid().parse(row.execution_id),
        draftHash = Hash.parse(row.draft_hash),
        taskHash = hashContext(task)
      if (
        row.task_key !== hashContext({ identity: task.identity, taskId: task.taskId }) ||
        row.scope !== deliveryScope(task.identity, task.conversationId)
      )
        throw Error('invalid')
      const request =
          row.request_json === null ? null : PermitRequestSchema.parse(json(row.request_json)),
        permit =
          row.permit_json === null ? null : ExecutionPermitSchema.parse(json(row.permit_json)),
        receipt =
          row.receipt_json === null ? null : ExecutionReceiptSchema.parse(json(row.receipt_json)),
        phase = row.phase === null ? null : Phase.parse(row.phase)
      if (
        (request === null) !== (phase === null) ||
        (request &&
          (request.taskId !== task.taskId ||
            request.taskHash !== taskHash ||
            request.draftHash !== draftHash ||
            request.loginEpoch !== task.identity.loginEpoch ||
            request.clientInstanceId !== task.identity.clientInstanceId))
      )
        throw Error('invalid')
      if (
        permit &&
        (!request ||
          !sameIdentity(permit.identity, task.identity) ||
          permit.permitId !== row.permit_id ||
          permit.taskId !== task.taskId ||
          permit.conversationId !== task.conversationId ||
          permit.taskHash !== taskHash ||
          permit.draftHash !== draftHash ||
          permit.draftRevision !== request.draftRevision ||
          permit.leaseVersion !== request.leaseVersion ||
          (permit.purpose ?? 'automatic') !== (request.purpose ?? 'automatic') ||
          permit.confirmationId !== request.confirmationId)
      )
        throw Error('invalid')
      if (
        (!permit && row.permit_id !== null) ||
        (receipt &&
          (!permit || receipt.permitId !== permit.permitId || receipt.draftHash !== draftHash))
      )
        throw Error('invalid')
      const localScope = conversationScope(task.identity, task.conversationId),
        conversationRow = db.prepare('SELECT * FROM conversations WHERE scope=?').get(localScope),
        control = db
          .prepare('SELECT human_owned,revision FROM conversation_controls WHERE delivery_scope=?')
          .get(deliveryScope(task.identity, task.conversationId))
      const conversation = conversationRow
        ? {
            lastSequence: NumberValue.parse(conversationRow.last_sequence),
            revision: NumberValue.parse(
              NumberValue.parse(conversationRow.revision) +
                NumberValue.parse(control?.revision ?? 0)
            ),
            hasGap: boolean(conversationRow.has_gap),
            humanOwned: boolean(control?.human_owned ?? conversationRow.human_owned),
            sequenceComplete:
              NumberValue.parse(
                db.prepare('SELECT count(*) AS total FROM messages WHERE scope=?').get(localScope)
                  ?.total
              ) === NumberValue.parse(conversationRow.last_sequence)
          }
        : null
      if (conversation && !conversations.has(localScope)) {
        conversations.add(localScope)
        summary.conversations++
      }
      const controlHash = control
        ? hashContext({
            humanOwned: boolean(control.human_owned),
            revision: NumberValue.parse(control.revision)
          })
        : null
      const item: RestoreExecutionInventory = {
        kind: 'execution',
        key: `s:${executionId}`,
        executionId,
        identity: task.identity,
        conversationId: task.conversationId,
        taskId: task.taskId,
        taskHash,
        draftHash,
        inboundRange: task.inboundRange,
        localRangePresent:
          NumberValue.parse(
            db
              .prepare(
                'SELECT count(*) AS total FROM messages WHERE scope=? AND sequence BETWEEN ? AND ?'
              )
              .get(localScope, task.inboundRange.from, task.inboundRange.to)?.total
          ) ===
          task.inboundRange.to - task.inboundRange.from + 1,
        status: Status.parse(row.status),
        phase,
        permitId: permit?.permitId ?? null,
        requestHash: request ? hashContext(request) : null,
        permitHash: permit ? hashContext(permit) : null,
        permitStatus: permit?.status ?? null,
        centralUpdatedAt:
          row.central_updated_at === null ? null : NumberValue.parse(row.central_updated_at),
        conversation,
        controlHash,
        receiptStatus: receipt?.status ?? null,
        receiptHash: receipt ? hashContext(receipt) : null,
        evidenceHash:
          row.evidence === null ? null : hashContext(z.string().max(1048576).parse(row.evidence)),
        baselineSequence:
          row.baseline_sequence === null ? null : NumberValue.parse(row.baseline_sequence),
        createdAt: NumberValue.parse(row.created_at),
        updatedAt: NumberValue.parse(row.updated_at)
      }
      summary.executions++
      if (
        item.status === 'unknown' ||
        receipt?.status === 'unknown' ||
        permit?.status === 'unknown'
      )
        summary.unknownExecutions++
      if (phase !== null && phase !== 'settled') summary.pendingCentral++
      add(item)
    }
    const basisHash = digest.update(hashContext(summary)).digest('hex')
    if (page.expectedBasisHash && page.expectedBasisHash !== basisHash)
      throw Error('ledger_restore_inventory_conflict')
    if (ownTransaction) db.exec('COMMIT')
    return {
      formatVersion: 1,
      evidenceKind: 'local_restored_metadata',
      context,
      scope,
      basisHash,
      canRelease: false,
      externalEvidenceRequired: true,
      summary,
      items,
      nextAfter: hasMore ? items[items.length - 1].key : null
    }
  } catch (error) {
    if (ownTransaction && db.isTransaction) db.exec('ROLLBACK')
    if (error instanceof Error && error.message === 'ledger_restore_inventory_conflict') throw error
    throw Error('ledger_restore_inventory_invalid')
  }
}
