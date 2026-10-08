import { z } from 'zod'
import { Hash, Id } from './identity'
import { DeviceScopeSchema } from './registration'
const Millis = z.number().int().nonnegative().safe()
export const RestoreAdmissionApprovalInputSchema = z.strictObject({
  approvalId: z.uuid().toLowerCase(),
  tenantId: Id,
  accountId: Id,
  expectedBasisHash: Hash,
  reviewedBy: Id,
  reviewedAt: Millis,
  evidenceSha256: Hash,
  completeAccountCasesVerified: z.literal(true),
  physicalDurabilityIndependentlyVerified: z.literal(true)
})
export const RestoreAdmissionCaseSchema = z.strictObject({
  caseId: z.uuid(),
  restoreId: z.uuid(),
  contextHash: Hash,
  agentId: Id,
  reviewHash: Hash,
  authorizationId: z.uuid(),
  completionId: z.uuid(),
  requestHash: Hash,
  receiptHash: Hash,
  provenanceHash: Hash,
  provenanceCount: z.number().int().positive().max(1000),
  state: z.literal('ready_for_independent_review')
})
export const RestoreAdmissionReceiptSchema = z.strictObject({
  formatVersion: z.literal(1),
  approvalId: z.uuid().toLowerCase(),
  requestHash: Hash,
  auditBasisHash: Hash,
  scope: DeviceScopeSchema,
  restoreId: z.uuid(),
  contextHash: Hash,
  provenanceHash: Hash,
  cases: z.array(RestoreAdmissionCaseSchema).min(1).max(10000),
  sourceKeyHashes: z.array(Hash).min(1).max(10000),
  permitSetStorageHash: Hash,
  sealSetStorageHash: Hash,
  reviewedBy: Id,
  reviewedAt: Millis,
  evidenceSha256: Hash,
  recordedBy: Id,
  recordedAt: Millis,
  status: z.literal('account_restore_admission_approved'),
  centralAdmissionApproved: z.literal(true),
  localAdmissionRequired: z.literal(true),
  physicalVerificationPerformedByThisCommand: z.literal(false),
  automaticStart: z.literal(false)
})
export type RestoreAdmissionReceipt = z.infer<typeof RestoreAdmissionReceiptSchema>
