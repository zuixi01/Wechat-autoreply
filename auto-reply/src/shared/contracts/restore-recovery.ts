import { z } from 'zod'
import { Hash, Id } from './identity'
import { DeviceScopeSchema } from './registration'
import { RestoreHistoryProofSchema } from './restore-history'
import { RestoreInventoryManifestSchema } from './restore-inventory'
import { hashContext } from '../../core/reply/hashes'
const Millis = z.number().int().nonnegative().safe()
export const RestoreRecoveryCurrentSchema = z.strictObject({
  caseId: z.uuid().toLowerCase(),
  restoreId: z.uuid().toLowerCase(),
  contextHash: Hash
})
export const RestoreRecoveryApprovalInputSchema = z.strictObject({
  authorizationId: z.uuid().toLowerCase(),
  tenantId: Id,
  accountId: Id,
  caseId: z.uuid().toLowerCase(),
  uploadId: z.uuid().toLowerCase(),
  reviewId: z.uuid().toLowerCase(),
  expectedContextHash: Hash,
  expectedInventoryBasisHash: Hash,
  expectedAssessmentBasisHash: Hash,
  expectedHistoryReceiptHash: Hash,
  expectedExecutionReceiptHash: Hash,
  expectedResolutionBasisHash: Hash,
  reviewedBy: Id,
  reviewedAt: Millis,
  historyPolicy: z.literal('quarantine_all_history')
})
export const RestoreRecoveryBoundarySchema = z
  .strictObject({
    formatVersion: z.literal(1),
    kind: z.literal('restore-account-boundary'),
    authorizationId: z.uuid().toLowerCase(),
    manifest: RestoreInventoryManifestSchema,
    history: RestoreHistoryProofSchema,
    historyReceiptHash: Hash,
    executionReceiptHash: Hash,
    resolutionBasisHash: Hash,
    humanOwnershipPolicy: z.literal('all_restored_conversations')
  })
  .refine(
    (v) =>
      v.manifest.context.contextHash === v.history.contextHash &&
      v.manifest.context.restoreId.toLowerCase() === v.history.restoreId &&
      v.manifest.basisHash === v.history.inventoryBasisHash &&
      hashContext(v.manifest.scope) === hashContext(v.history.scope) &&
      v.history.complete &&
      v.history.allConversationsEnumerated &&
      v.history.nextPageToken === null
  )
export const RestoreRecoveryAuthorizationReceiptSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    authorizationId: z.uuid().toLowerCase(),
    scope: DeviceScopeSchema,
    caseId: z.uuid().toLowerCase(),
    uploadId: z.uuid().toLowerCase(),
    reviewId: z.uuid().toLowerCase(),
    restoreId: z.uuid().toLowerCase(),
    contextHash: Hash,
    inventoryBasisHash: Hash,
    assessmentBasisHash: Hash,
    historyProofId: z.uuid().toLowerCase(),
    historyReceiptHash: Hash,
    executionReceiptHash: Hash,
    resolutionBasisHash: Hash,
    boundaryHash: Hash,
    requestHash: Hash,
    historyPolicy: z.literal('quarantine_all_history'),
    recordedBy: Id,
    recordedAt: Millis,
    expiresAt: Millis,
    status: z.literal('approved_for_boundary'),
    localDurableApplicationRequired: z.literal(true),
    centralCompletionRequired: z.literal(true),
    physicalFactsVerifiedByThisCommand: z.literal(false),
    automaticStart: z.literal(false),
    canRelease: z.literal(false)
  })
  .refine((v) => v.expiresAt > v.recordedAt && v.expiresAt - v.recordedAt <= 300000)
export type RestoreRecoveryApprovalInput = z.infer<typeof RestoreRecoveryApprovalInputSchema>
export type RestoreRecoveryBoundary = z.infer<typeof RestoreRecoveryBoundarySchema>
export type RestoreRecoveryAuthorizationReceipt = z.infer<
  typeof RestoreRecoveryAuthorizationReceiptSchema
>
/** Delivered only through the authenticated target endpoint; never a caller-authored approval. */
export const RestoreRecoveryPackageSchema = z
  .strictObject({
    authorization: RestoreRecoveryAuthorizationReceiptSchema,
    boundary: RestoreRecoveryBoundarySchema
  })
  .refine(
    ({ authorization: a, boundary: b }) =>
      a.authorizationId === b.authorizationId &&
      a.boundaryHash === hashContext(b) &&
      a.caseId === b.history.caseId &&
      a.uploadId === b.history.uploadId &&
      a.restoreId === b.history.restoreId &&
      a.contextHash === b.history.contextHash &&
      a.inventoryBasisHash === b.manifest.basisHash &&
      a.historyProofId === b.history.proofId &&
      a.historyReceiptHash === b.historyReceiptHash &&
      a.executionReceiptHash === b.executionReceiptHash &&
      a.resolutionBasisHash === b.resolutionBasisHash &&
      b.history.historyFrom <= b.history.observedThrough &&
      b.history.observedThrough <= b.history.capturedAt &&
      b.history.capturedAt <= a.recordedAt &&
      hashContext(a.scope) === hashContext(b.history.scope)
  )
export const RestoreRecoveryLocalReceiptSchema = z.strictObject({
  formatVersion: z.literal(1),
  applicationId: z.uuid().toLowerCase(),
  authorizationId: z.uuid().toLowerCase(),
  authorizationHash: Hash,
  boundaryHash: Hash,
  scope: DeviceScopeSchema,
  caseId: z.uuid().toLowerCase(),
  uploadId: z.uuid().toLowerCase(),
  restoreId: z.uuid().toLowerCase(),
  contextHash: Hash,
  inventoryBasisHash: Hash,
  postInventoryBasisHash: Hash,
  quarantinedInboundCount: Millis,
  ownedConversationCount: Millis,
  sourceMessageCount: Millis,
  appliedAt: Millis,
  localExecutionResolutionRequired: z.literal(true),
  centralConfirmationRequired: z.literal(true),
  automaticStart: z.literal(false),
  canRelease: z.literal(false)
})
export type RestoreRecoveryPackage = z.infer<typeof RestoreRecoveryPackageSchema>
export type RestoreRecoveryLocalReceipt = z.infer<typeof RestoreRecoveryLocalReceiptSchema>
export const RestorationBoundaryApplyResultSchema = z.discriminatedUnion('success', [
  z.strictObject({
    success: z.literal(true),
    status: z.enum([
      'boundary_recorded',
      'executions_recorded',
      'reads_prepared',
      'completion_recorded'
    ]),
    canRelease: z.literal(false)
  }),
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
export type RestorationBoundaryApplyResult = z.infer<typeof RestorationBoundaryApplyResultSchema>
