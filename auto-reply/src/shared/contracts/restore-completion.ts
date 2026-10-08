import { z } from 'zod'
import { Hash } from './identity'
import { DeviceScopeSchema } from './registration'
import { LedgerRestoreContextSchema } from './restoration'
import { RestoreRecoveryLocalReceiptSchema, type RestoreRecoveryPackage } from './restore-recovery'
import {
  RestoreResolutionLocalReceiptSchema,
  type RestoreResolutionPackage
} from './restore-resolution'
import { RestoreObservationGrantSchema, parseRestoreObservationGrant } from './restore-observation'
import { hashContext } from '../../core/reply/hashes'
const Millis = z.number().int().nonnegative().safe()
export const RestoreRecoveryCompletionInputSchema = z.strictObject({
  formatVersion: z.literal(1),
  completionId: z.uuid().toLowerCase(),
  preparedAt: Millis,
  boundaryApplication: RestoreRecoveryLocalReceiptSchema,
  resolutionApplication: RestoreResolutionLocalReceiptSchema,
  observationGrant: RestoreObservationGrantSchema,
  provenance: z.array(LedgerRestoreContextSchema).min(1).max(1000),
  automaticStart: z.literal(false),
  canRelease: z.literal(false)
})
export type RestoreRecoveryCompletionInput = z.infer<typeof RestoreRecoveryCompletionInputSchema>
export function parseRestoreRecoveryCompletionInput(
  raw: unknown,
  p: RestoreRecoveryPackage,
  resolutions: RestoreResolutionPackage
): RestoreRecoveryCompletionInput {
  if (Buffer.byteLength(JSON.stringify(raw) ?? '') > 1048576)
    throw Error('restore_completion_conflict')
  const value = RestoreRecoveryCompletionInputSchema.parse(raw),
    b = value.boundaryApplication,
    r = value.resolutionApplication,
    a = p.authorization,
    g = parseRestoreObservationGrant(value.observationGrant, p),
    h = p.boundary.history
  const ids = new Set<string>()
  let previous: (typeof value.provenance)[number] | undefined
  for (const c of value.provenance) {
    const { contextHash, ...descriptor } = c
    if (
      hashContext(descriptor) !== contextHash ||
      ids.has(c.restoreId.toLowerCase()) ||
      c.previousRestoreId !== (previous?.restoreId ?? null) ||
      c.previousContextHash !== (previous?.contextHash ?? null)
    )
      throw Error('restore_completion_conflict')
    ids.add(c.restoreId.toLowerCase())
    previous = c
  }
  if (
    hashContext(previous) !== hashContext(p.boundary.manifest.context) ||
    b.authorizationId !== a.authorizationId ||
    b.authorizationHash !== hashContext(a) ||
    b.boundaryHash !== a.boundaryHash ||
    hashContext(b.scope) !== hashContext(a.scope) ||
    b.caseId !== a.caseId ||
    b.uploadId !== a.uploadId ||
    b.restoreId !== a.restoreId ||
    b.contextHash !== a.contextHash ||
    b.inventoryBasisHash !== a.inventoryBasisHash ||
    b.quarantinedInboundCount !== p.boundary.manifest.summary.unhandledInbound ||
    b.ownedConversationCount !== h.conversations.length ||
    b.sourceMessageCount !== h.conversations.reduce((n, c) => n + c.messages.length, 0) ||
    b.appliedAt < a.recordedAt ||
    b.appliedAt >= a.expiresAt ||
    r.authorizationId !== a.authorizationId ||
    r.authorizationHash !== b.authorizationHash ||
    r.boundaryApplicationId !== b.applicationId ||
    r.boundaryHash !== a.boundaryHash ||
    r.resolutionBasisHash !== a.resolutionBasisHash ||
    r.packageHash !== hashContext(resolutions) ||
    r.restoreId !== a.restoreId ||
    r.contextHash !== a.contextHash ||
    r.localExecutions !== resolutions.localExecutions.length ||
    r.centralPermits !== resolutions.subjects.filter((s) => s.kind === 'central_permit').length ||
    r.requestSeals !== resolutions.records.filter((s) => s.kind === 'request_seal').length ||
    r.appliedAt < b.appliedAt ||
    r.appliedAt >= a.expiresAt ||
    value.preparedAt < Math.max(r.appliedAt, g.issuedAt) ||
    value.preparedAt >= Math.min(a.expiresAt, g.expiresAt)
  )
    throw Error('restore_completion_conflict')
  return value
}
/** Authenticated device durability declaration, never a physical disk or release certificate. */
export const RestoreRecoveryCompletionReceiptSchema = z.strictObject({
  formatVersion: z.literal(1),
  acknowledgementId: z.uuid().toLowerCase(),
  completionId: z.uuid().toLowerCase(),
  requestHash: Hash,
  scope: DeviceScopeSchema,
  caseId: z.uuid().toLowerCase(),
  authorizationId: z.uuid().toLowerCase(),
  authorizationHash: Hash,
  restoreId: z.uuid().toLowerCase(),
  contextHash: Hash,
  boundaryApplicationHash: Hash,
  resolutionApplicationHash: Hash,
  provenanceHash: Hash,
  provenanceCount: Millis.min(1),
  recordedAt: Millis,
  status: z.literal('durable_recovery_recorded'),
  localDurabilityDeclared: z.literal(true),
  localDurabilityVerifiedByServer: z.literal(false),
  accountAdmissionRequired: z.literal(true),
  automaticStart: z.literal(false),
  canRelease: z.literal(false)
})
export type RestoreRecoveryCompletionReceipt = z.infer<
  typeof RestoreRecoveryCompletionReceiptSchema
>
export function parseRestoreRecoveryCompletionReceipt(
  raw: unknown,
  input: RestoreRecoveryCompletionInput
): RestoreRecoveryCompletionReceipt {
  const ack = RestoreRecoveryCompletionReceiptSchema.parse(raw),
    b = input.boundaryApplication
  if (
    ack.completionId !== input.completionId ||
    ack.requestHash !== hashContext(input) ||
    hashContext(ack.scope) !== hashContext(b.scope) ||
    ack.caseId !== b.caseId ||
    ack.authorizationId !== b.authorizationId ||
    ack.authorizationHash !== b.authorizationHash ||
    ack.restoreId !== b.restoreId ||
    ack.contextHash !== b.contextHash ||
    ack.boundaryApplicationHash !== hashContext(b) ||
    ack.resolutionApplicationHash !== hashContext(input.resolutionApplication) ||
    ack.provenanceHash !== hashContext(input.provenance) ||
    ack.provenanceCount !== input.provenance.length ||
    ack.recordedAt < input.preparedAt
  )
    throw Error('restore_completion_conflict')
  return ack
}
