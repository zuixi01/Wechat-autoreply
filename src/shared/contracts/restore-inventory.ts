import { z } from 'zod'
import { Id, Hash, IdentitySchema } from './identity'
import { DeviceScopeSchema } from './registration'
import { LedgerRestoreContextSchema } from './restoration'

const Count = z.number().int().nonnegative().safe()
const Positive = Count.min(1)
const Key = z.string().regex(/^(m:[a-f0-9]{64}:[0-9]{16}|s:[a-f0-9-]{36})$/)
const Conversation = z.strictObject({
  lastSequence: Count,
  revision: Count,
  hasGap: z.boolean(),
  humanOwned: z.boolean(),
  sequenceComplete: z.boolean()
})
const common = { key: Key, identity: IdentitySchema, conversationId: Id }
export const RestoreInventoryItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...common,
    kind: z.literal('message'),
    sourceMessageId: Id,
    sequence: Positive,
    observedAt: Count,
    sequenceComplete: z.boolean(),
    direction: z.enum(['inbound', 'human_outbound', 'automation_outbound']),
    contentHash: Hash,
    handledBy: z.string().min(1).max(256).nullable(),
    identityVerified: z.boolean(),
    messageIdVerified: z.boolean(),
    hasGap: z.boolean(),
    humanOwned: z.boolean(),
    lastSequence: Count,
    revision: Count
  }),
  z.strictObject({
    ...common,
    kind: z.literal('execution'),
    executionId: z.uuid(),
    taskId: Id,
    taskHash: Hash,
    draftHash: Hash,
    inboundRange: z.strictObject({ from: Positive, to: Positive }).refine((v) => v.to >= v.from),
    localRangePresent: z.boolean(),
    status: z.enum(['prepared', 'dispatching', 'confirmed', 'unknown', 'cancelled', 'rejected']),
    phase: z
      .enum(['requesting', 'issued', 'dispatching', 'receipt_pending', 'settled', 'unresolved'])
      .nullable(),
    permitId: Id.nullable(),
    requestHash: Hash.nullable(),
    permitHash: Hash.nullable(),
    permitStatus: z.enum(['issued', 'confirmed', 'not_sent', 'unknown']).nullable(),
    centralUpdatedAt: Count.nullable(),
    conversation: Conversation.nullable(),
    controlHash: Hash.nullable(),
    receiptStatus: z.enum(['confirmed', 'not_sent', 'unknown']).nullable(),
    receiptHash: Hash.nullable(),
    evidenceHash: Hash.nullable(),
    baselineSequence: Count.nullable(),
    createdAt: Count,
    updatedAt: Count
  })
])
export type RestoreInventoryItem = z.infer<typeof RestoreInventoryItemSchema>
export const RestoreInventorySummarySchema = z
  .strictObject({
    conversations: Count,
    messages: Count,
    inbound: Count,
    handledInbound: Count,
    unhandledInbound: Count,
    executions: Count,
    unknownExecutions: Count,
    pendingCentral: Count
  })
  .refine(
    (v) =>
      v.messages + v.executions <= 2000000 &&
      v.inbound <= v.messages &&
      v.handledInbound + v.unhandledInbound === v.inbound &&
      v.unknownExecutions <= v.executions &&
      v.pendingCentral <= v.executions &&
      v.conversations <= v.messages + v.executions
  )
export const RestoreInventoryManifestSchema = z.strictObject({
  formatVersion: z.literal(1),
  evidenceKind: z.literal('local_restored_metadata'),
  context: LedgerRestoreContextSchema,
  scope: DeviceScopeSchema,
  basisHash: Hash,
  canRelease: z.literal(false),
  externalEvidenceRequired: z.literal(true),
  summary: RestoreInventorySummarySchema
})
export type RestoreInventoryManifest = z.infer<typeof RestoreInventoryManifestSchema>
export const RestoreInventoryStartSchema = z.strictObject({
  caseId: z.uuid(),
  requestId: z.uuid(),
  challengeId: z.uuid(),
  manifest: RestoreInventoryManifestSchema
})
export type RestoreInventoryStartInput = z.infer<typeof RestoreInventoryStartSchema>
export const RestoreInventoryPageSchema = z
  .strictObject({
    uploadId: z.uuid(),
    index: Count.max(19999),
    items: z.array(RestoreInventoryItemSchema).min(1).max(100)
  })
  .refine((v) => v.items.every((item, i) => i === 0 || v.items[i - 1].key < item.key))
export const RestoreInventoryCompleteSchema = z.strictObject({
  uploadId: z.uuid(),
  pageCount: Count.max(20000)
})
export const RestoreInventoryStartAckSchema = z
  .strictObject({ uploadId: z.uuid(), manifestHash: Hash, issuedAt: Count, expiresAt: Count })
  .refine((v) => v.expiresAt - v.issuedAt === 900000)
export const RestoreInventoryPageAckSchema = z.strictObject({
  uploadId: z.uuid(),
  index: Count,
  pageHash: Hash,
  itemCount: Positive.max(100)
})
export const RestoreInventoryCompleteAckSchema = z.strictObject({
  uploadId: z.uuid(),
  manifestHash: Hash,
  basisHash: Hash,
  itemCount: Count,
  pageCount: Count,
  status: z.literal('inventory_received'),
  canRelease: z.literal(false),
  externalEvidenceRequired: z.literal(true)
})
export type RestoreInventoryCompleteAck = z.infer<typeof RestoreInventoryCompleteAckSchema>
export const RestorationInventorySubmitResultSchema = z.discriminatedUnion('success', [
  RestoreInventoryCompleteAckSchema.extend({ success: z.literal(true), caseId: z.uuid() }).strict(),
  z.strictObject({
    success: z.literal(false),
    code: z.enum([
      'invalid_input',
      'unavailable',
      'execution_pending',
      'device_changed',
      'local_storage_unavailable'
    ])
  })
])
export type RestorationInventorySubmitResult = z.infer<
  typeof RestorationInventorySubmitResultSchema
>
