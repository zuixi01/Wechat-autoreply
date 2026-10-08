import { z } from 'zod'
import { Hash, Id } from './identity'
import { DeviceScopeSchema } from './registration'

const Millis = z.number().int().nonnegative().safe()
export const RestoreHistorySourceSchema = z.strictObject({
  sourceId: Id,
  keyId: Id,
  version: Id,
  releaseSha256: Hash
})
export const RestoreHistoryMessageSchema = z.strictObject({
  sourceMessageId: Id,
  position: z.number().int().positive().safe(),
  direction: z.enum(['inbound', 'human_outbound', 'automation_outbound']),
  contentHash: Hash,
  sentAt: Millis
})
export const RestoreHistoryProofSchema = z.strictObject({
  formatVersion: z.literal(1),
  kind: z.literal('restore-account-history'),
  proofId: z.uuid().toLowerCase(),
  caseId: z.uuid().toLowerCase(),
  uploadId: z.uuid().toLowerCase(),
  restoreId: z.uuid().toLowerCase(),
  contextHash: Hash,
  inventoryBasisHash: Hash,
  scope: DeviceScopeSchema,
  platformAccountIdHash: Hash,
  source: RestoreHistorySourceSchema,
  historyFrom: Millis,
  observedThrough: Millis,
  capturedAt: Millis,
  complete: z.boolean(),
  allConversationsEnumerated: z.boolean(),
  nextPageToken: Id.nullable(),
  conversations: z
    .array(
      z.strictObject({
        conversationId: Id,
        complete: z.boolean(),
        hasGap: z.boolean(),
        nextPageToken: Id.nullable(),
        messages: z.array(RestoreHistoryMessageSchema).max(200000)
      })
    )
    .max(20000)
})
export type RestoreHistoryProof = z.infer<typeof RestoreHistoryProofSchema>
export const SignedRestoreHistoryProofSchema = z.strictObject({
  proof: RestoreHistoryProofSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/)
})
export type SignedRestoreHistoryProof = z.infer<typeof SignedRestoreHistoryProofSchema>

const Count = z.number().int().nonnegative().safe()
export const RestoreHistoryCheckSchema = z
  .strictObject({
    proofId: z.uuid().toLowerCase(),
    caseId: z.uuid().toLowerCase(),
    uploadId: z.uuid().toLowerCase(),
    proofHash: Hash,
    signedProofHash: Hash,
    sourceHash: Hash,
    sourceTrustHash: Hash,
    physicalHistoryVerificationSha256: Hash,
    scopeHash: Hash,
    restoreId: z.uuid().toLowerCase(),
    contextHash: Hash,
    inventoryBasisHash: Hash,
    conversations: Count,
    messages: Count,
    localMessageAnchors: Count,
    additionalMessages: Count,
    historyFrom: Millis,
    observedThrough: Millis,
    capturedAt: Millis,
    sourceClaimAuthenticated: z.literal(true),
    structurallyComplete: z.literal(true),
    physicalHistoryVerifiedByThisCheck: z.literal(false),
    executionOutcomesVerified: z.literal(false),
    canRelease: z.literal(false)
  })
  .refine((value) => value.additionalMessages + value.localMessageAnchors === value.messages)
export type RestoreHistoryCheck = z.infer<typeof RestoreHistoryCheckSchema>

export const RestoreHistorySubmissionSchema = z.strictObject({
  requirementId: z.uuid().toLowerCase(),
  signedProof: SignedRestoreHistoryProofSchema
})
export const RestoreHistoryReceiptSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    kind: z.literal('restore-history-evidence'),
    proofId: z.uuid().toLowerCase(),
    caseId: z.uuid().toLowerCase(),
    uploadId: z.uuid().toLowerCase(),
    requirementId: z.uuid().toLowerCase(),
    requirementHash: Hash,
    assessmentBasisHash: Hash,
    checked: RestoreHistoryCheckSchema,
    recordedBy: Id,
    recordedAt: Millis,
    physicalHistoryReviewRequired: z.literal(true),
    executionOutcomesRequired: z.literal(true),
    automaticStart: z.literal(false),
    canRelease: z.literal(false)
  })
  .refine(
    (v) =>
      v.checked.proofId === v.proofId &&
      v.checked.caseId === v.caseId &&
      v.checked.uploadId === v.uploadId
  )
export type RestoreHistoryReceipt = z.infer<typeof RestoreHistoryReceiptSchema>
