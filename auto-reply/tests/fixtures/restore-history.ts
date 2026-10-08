import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { hashContext } from '../../src/core/reply/hashes'
import {
  RestoreHistoryProofVerifier,
  restoreHistorySigningBytes,
  type RestoreHistoryRequirement,
  type RestoreHistorySourceTrust
} from '../../server/src/recovery/restore-history-proof'
import type { RestoreHistoryProof } from '../../src/shared/contracts/restore-history'
import type { RestoreInventoryItem } from '../../src/shared/contracts/restore-inventory'

// Project-owned synthetic facts and ephemeral keys; none represent a tested chat client.
export function historyFixture() {
  const now = 2000000
  const keys = generateKeyPairSync('ed25519')
  const scope = {
    tenant_id: 'tenant',
    account_id: 'account',
    employee_id: 'employee',
    agent_id: 'agent',
    platform: 'wechat' as const
  }
  const identity = {
    tenantId: 'tenant',
    accountId: 'account',
    employeeId: 'employee',
    agentId: 'agent',
    platform: 'wechat' as const,
    loginEpoch: 1,
    clientInstanceId: 'synthetic-client'
  }
  const descriptor = {
    formatVersion: 1 as const,
    restoreId: randomUUID(),
    backupId: randomUUID(),
    sourceSha256: 'a'.repeat(64),
    restoredAt: new Date(now - 3000).toISOString(),
    previousRestoreId: null,
    previousContextHash: null,
    requiresReconciliation: true as const
  }
  const context = { ...descriptor, contextHash: hashContext(descriptor) }
  const item: RestoreInventoryItem = {
    kind: 'message',
    key: `m:${hashContext({ identity, conversationId: 'customer' })}:0000000000000001`,
    identity,
    conversationId: 'customer',
    sourceMessageId: 'old-message',
    sequence: 1,
    observedAt: now - 7000,
    sequenceComplete: true,
    direction: 'inbound',
    contentHash: 'b'.repeat(64),
    handledBy: null,
    identityVerified: true,
    messageIdVerified: true,
    hasGap: false,
    humanOwned: false,
    lastSequence: 1,
    revision: 0
  }
  const summary = {
    conversations: 1,
    messages: 1,
    inbound: 1,
    handledInbound: 0,
    unhandledInbound: 1,
    executions: 0,
    unknownExecutions: 0,
    pendingCentral: 0
  }
  const manifest = {
    formatVersion: 1 as const,
    evidenceKind: 'local_restored_metadata' as const,
    context,
    scope,
    basisHash: '',
    canRelease: false as const,
    externalEvidenceRequired: true as const,
    summary
  }
  const required: RestoreHistoryRequirement = {
    caseId: randomUUID(),
    uploadId: randomUUID(),
    manifest,
    items: [item],
    platformAccountIdHash: 'c'.repeat(64),
    backupStartedAt: now - 5000,
    allDevicesStoppedAt: now - 2000
  }
  const rehash = () => {
    const hash = createHash('sha256').update(
      hashContext({
        formatVersion: 1,
        context: required.manifest.context,
        scope: required.manifest.scope
      })
    )
    for (const entry of required.items) hash.update(hashContext(entry))
    required.manifest.basisHash = hash.update(hashContext(required.manifest.summary)).digest('hex')
  }
  rehash()
  const trust: RestoreHistorySourceTrust = {
    source: {
      sourceId: 'synthetic-history-source',
      keyId: 'fixture-key',
      version: 'fixture-v1',
      releaseSha256: 'd'.repeat(64)
    },
    tenantId: 'tenant',
    accountId: 'account',
    platformAccountIdHash: required.platformAccountIdHash,
    platform: 'wechat',
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    physicalHistoryVerificationSha256: 'e'.repeat(64),
    completeAccountHistoryVerified: true,
    stableMessageIdentityVerified: true,
    notBefore: now - 10000,
    notAfter: now + 10000,
    revokedAt: null
  }
  const proof: RestoreHistoryProof = {
    formatVersion: 1,
    kind: 'restore-account-history',
    proofId: randomUUID(),
    caseId: required.caseId,
    uploadId: required.uploadId,
    restoreId: context.restoreId,
    contextHash: context.contextHash,
    inventoryBasisHash: manifest.basisHash,
    scope,
    platformAccountIdHash: required.platformAccountIdHash,
    source: trust.source,
    historyFrom: now - 6000,
    observedThrough: now - 1000,
    capturedAt: now,
    complete: true,
    allConversationsEnumerated: true,
    nextPageToken: null,
    conversations: [
      {
        conversationId: 'customer',
        complete: true,
        hasGap: false,
        nextPageToken: null,
        messages: [
          {
            sourceMessageId: 'old-message',
            position: 1,
            direction: 'inbound',
            contentHash: 'b'.repeat(64),
            sentAt: now - 7000
          },
          {
            sourceMessageId: 'after-backup',
            position: 2,
            direction: 'human_outbound',
            contentHash: 'f'.repeat(64),
            sentAt: now - 1500
          }
        ]
      },
      {
        conversationId: 'new-after-backup-customer',
        complete: true,
        hasGap: false,
        nextPageToken: null,
        messages: []
      }
    ]
  }
  const envelope = () => ({
    proof,
    signature: sign(null, restoreHistorySigningBytes(proof), keys.privateKey).toString('base64url')
  })
  return {
    now,
    keys,
    required,
    trust,
    proof,
    envelope,
    rehash,
    verifier: () => new RestoreHistoryProofVerifier([trust])
  }
}
