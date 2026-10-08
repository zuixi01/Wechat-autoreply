import { randomUUID } from 'node:crypto'
import { hashContext } from '../../src/core/reply/hashes'
import {
  RestoreRecoveryCompletionReceiptSchema,
  type RestoreRecoveryCompletionInput
} from '../../src/shared/contracts/restore-completion'
import type { RestoreRecoveryPackage } from '../../src/shared/contracts/restore-recovery'
import type { RestoreResolutionPackage } from '../../src/shared/contracts/restore-resolution'
import type { RestoreObservationGrant } from '../../src/shared/contracts/restore-observation'
/** Server tests declare synthetic durability; SQLite durability is exercised separately. */
export function restoreCompletionInputFixture(
  p: RestoreRecoveryPackage,
  resolutions: RestoreResolutionPackage,
  grant: RestoreObservationGrant,
  now = Date.now()
): RestoreRecoveryCompletionInput {
  const a = p.authorization,
    boundaryApplication = {
      formatVersion: 1 as const,
      applicationId: randomUUID(),
      authorizationId: a.authorizationId,
      authorizationHash: hashContext(a),
      boundaryHash: a.boundaryHash,
      scope: a.scope,
      caseId: a.caseId,
      uploadId: a.uploadId,
      restoreId: a.restoreId,
      contextHash: a.contextHash,
      inventoryBasisHash: a.inventoryBasisHash,
      postInventoryBasisHash: 'e'.repeat(64),
      quarantinedInboundCount: p.boundary.manifest.summary.unhandledInbound,
      ownedConversationCount: p.boundary.history.conversations.length,
      sourceMessageCount: p.boundary.history.conversations.reduce(
        (n, c) => n + c.messages.length,
        0
      ),
      appliedAt: now,
      localExecutionResolutionRequired: true as const,
      centralConfirmationRequired: true as const,
      automaticStart: false as const,
      canRelease: false as const
    }
  return {
    formatVersion: 1,
    completionId: randomUUID(),
    preparedAt: now,
    boundaryApplication,
    resolutionApplication: {
      formatVersion: 1,
      applicationId: randomUUID(),
      boundaryApplicationId: boundaryApplication.applicationId,
      authorizationId: a.authorizationId,
      authorizationHash: hashContext(a),
      boundaryHash: a.boundaryHash,
      resolutionBasisHash: a.resolutionBasisHash,
      packageHash: hashContext(resolutions),
      restoreId: a.restoreId,
      contextHash: a.contextHash,
      localExecutions: resolutions.localExecutions.length,
      centralPermits: resolutions.subjects.filter((s) => s.kind === 'central_permit').length,
      requestSeals: resolutions.records.filter((s) => s.kind === 'request_seal').length,
      appliedAt: now,
      originalExecutionRecordsPreserved: true,
      centralConfirmationRequired: true,
      automaticStart: false,
      canRelease: false
    },
    observationGrant: grant,
    provenance: [p.boundary.manifest.context],
    automaticStart: false,
    canRelease: false
  }
}
export function restoreCompletionAckFixture(
  input: RestoreRecoveryCompletionInput,
  recordedAt = input.preparedAt
) {
  const b = input.boundaryApplication
  return RestoreRecoveryCompletionReceiptSchema.parse({
    formatVersion: 1,
    acknowledgementId: randomUUID(),
    completionId: input.completionId,
    requestHash: hashContext(input),
    scope: b.scope,
    caseId: b.caseId,
    authorizationId: b.authorizationId,
    authorizationHash: b.authorizationHash,
    restoreId: b.restoreId,
    contextHash: b.contextHash,
    boundaryApplicationHash: hashContext(b),
    resolutionApplicationHash: hashContext(input.resolutionApplication),
    provenanceHash: hashContext(input.provenance),
    provenanceCount: input.provenance.length,
    recordedAt,
    status: 'durable_recovery_recorded',
    localDurabilityDeclared: true,
    localDurabilityVerifiedByServer: false,
    accountAdmissionRequired: true,
    automaticStart: false,
    canRelease: false
  })
}
