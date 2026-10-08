import { z } from 'zod'
import { Hash } from './identity'
import { DeviceScopeSchema } from './registration'
import { RestoreDecisionReceiptSchema } from './restore-decision'
import { RestoreInventoryManifestSchema } from './restore-inventory'
import { hashContext } from '../../core/reply/hashes'

export const RestoreApplicationLookupSchema = z.strictObject({
  caseId: z.uuid().toLowerCase(),
  uploadId: z.uuid().toLowerCase(),
  decisionId: z.uuid().toLowerCase(),
  restoreId: z.uuid().toLowerCase(),
  contextHash: Hash,
  decisionHash: Hash
})
export const RestoreApplicationCurrentSchema = RestoreApplicationLookupSchema.pick({
  caseId: true,
  restoreId: true,
  contextHash: true
})
export const RestoreApplicationDecisionSchema = z
  .strictObject({
    scope: DeviceScopeSchema,
    decision: RestoreDecisionReceiptSchema,
    decisionHash: Hash,
    manifest: RestoreInventoryManifestSchema,
    canRelease: z.literal(false)
  })
  .refine(
    (value) =>
      value.decisionHash === hashContext(value.decision) &&
      value.decision.contextHash === value.manifest.context.contextHash &&
      value.decision.restoreId === value.manifest.context.restoreId.toLowerCase() &&
      value.decision.targetAgentId === value.scope.agent_id &&
      value.decision.inventoryBasisHash === value.manifest.basisHash &&
      hashContext(value.scope) === hashContext(value.manifest.scope)
  )
export type RestoreApplicationDecision = z.infer<typeof RestoreApplicationDecisionSchema>
export const RestoreLocalApplicationReceiptSchema = z.strictObject({
  applicationId: z.uuid().toLowerCase(),
  scope: DeviceScopeSchema,
  caseId: z.uuid().toLowerCase(),
  uploadId: z.uuid().toLowerCase(),
  decisionId: z.uuid().toLowerCase(),
  decisionHash: Hash,
  restoreId: z.uuid().toLowerCase(),
  contextHash: Hash,
  inventoryBasisHash: Hash,
  postInventoryBasisHash: Hash,
  quarantinedInboundCount: z.number().int().nonnegative().safe(),
  ownedConversationCount: z.number().int().nonnegative().safe(),
  appliedAt: z.number().int().nonnegative().safe(),
  centralConfirmationRequired: z.literal(true),
  canRelease: z.literal(false)
})
export type RestoreLocalApplicationReceipt = z.infer<typeof RestoreLocalApplicationReceiptSchema>
/** Records quarantine only. Independent recovery evidence is still required. */
export const RestoreApplicationAckSchema = z.strictObject({
  acknowledgementId: z.uuid().toLowerCase(),
  applicationId: z.uuid().toLowerCase(),
  applicationHash: Hash,
  scope: DeviceScopeSchema,
  caseId: z.uuid().toLowerCase(),
  decisionId: z.uuid().toLowerCase(),
  restoreId: z.uuid().toLowerCase(),
  contextHash: Hash,
  recordedAt: z.number().int().nonnegative().safe(),
  status: z.literal('quarantine_recorded'),
  externalEvidenceRequired: z.literal(true),
  automaticStart: z.literal(false),
  canRelease: z.literal(false)
})
export type RestoreApplicationAck = z.infer<typeof RestoreApplicationAckSchema>
