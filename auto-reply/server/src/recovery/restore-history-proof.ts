import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import { z } from 'zod'
import { hashContext } from '../../../src/core/reply/hashes'
import { Hash } from '../../../src/shared/contracts/identity'
import {
  SignedRestoreHistoryProofSchema,
  RestoreHistoryCheckSchema,
  type RestoreHistoryCheck,
  type RestoreHistoryProof
} from '../../../src/shared/contracts/restore-history'
import {
  RestoreInventoryItemSchema,
  RestoreInventoryManifestSchema,
  type RestoreInventoryItem,
  type RestoreInventoryManifest
} from '../../../src/shared/contracts/restore-inventory'

import {
  RestoreHistorySourceTrustSchema,
  type RestoreHistorySourceTrust
} from '../../../src/shared/contracts/history-source-trust'
export {
  RestoreHistorySourceTrustSchema,
  type RestoreHistorySourceTrust
} from '../../../src/shared/contracts/history-source-trust'
const Millis = z.number().int().nonnegative().safe()
export interface RestoreHistoryRequirement {
  caseId: string
  uploadId: string
  manifest: RestoreInventoryManifest
  items: RestoreInventoryItem[]
  platformAccountIdHash: string
  backupStartedAt: number
  allDevicesStoppedAt: number
}
export type RestoreHistoryErrorCode =
  | 'restore_history_invalid'
  | 'restore_history_source_untrusted'
  | 'restore_history_signature_invalid'
  | 'restore_history_context_conflict'
  | 'restore_history_incomplete'
  | 'restore_history_time_invalid'
  | 'restore_history_inventory_invalid'
  | 'restore_history_anchor_conflict'
export class RestoreHistoryError extends Error {
  constructor(readonly code: RestoreHistoryErrorCode) {
    super(code)
    this.name = 'RestoreHistoryError'
  }
}
function fail(code: RestoreHistoryErrorCode): never {
  throw new RestoreHistoryError(code)
}
/** Sign a domain-separated canonical payload digest, with an independently held source key. */
export function restoreHistorySigningBytes(proof: RestoreHistoryProof): Buffer {
  return Buffer.from(`autoreply.restore-account-history.v1\n${hashContext(proof)}`, 'utf8')
}

function checkedRequirement(raw: RestoreHistoryRequirement): RestoreHistoryRequirement {
  try {
    const request = z
      .strictObject({
        caseId: z.uuid().toLowerCase(),
        uploadId: z.uuid().toLowerCase(),
        manifest: RestoreInventoryManifestSchema,
        items: z.array(RestoreInventoryItemSchema).max(2000000),
        platformAccountIdHash: Hash,
        backupStartedAt: Millis,
        allDevicesStoppedAt: Millis
      })
      .parse(raw)
    const { contextHash, ...descriptor } = request.manifest.context
    if (
      hashContext(descriptor) !== contextHash ||
      request.backupStartedAt > Date.parse(request.manifest.context.restoredAt) ||
      request.allDevicesStoppedAt < Date.parse(request.manifest.context.restoredAt)
    )
      fail('restore_history_inventory_invalid')
    const digest = createHash('sha256').update(
      hashContext({
        formatVersion: 1,
        context: request.manifest.context,
        scope: request.manifest.scope
      })
    )
    let previous = ''
    const summary = {
      conversations: 0,
      messages: 0,
      inbound: 0,
      handledInbound: 0,
      unhandledInbound: 0,
      executions: 0,
      unknownExecutions: 0,
      pendingCentral: 0
    }
    const conversations = new Set<string>()
    for (const item of request.items) {
      const s = request.manifest.scope,
        i = item.identity
      if (
        item.key <= previous ||
        i.tenantId !== s.tenant_id ||
        i.employeeId !== s.employee_id ||
        i.accountId !== s.account_id ||
        i.agentId !== s.agent_id ||
        i.platform !== s.platform
      )
        fail('restore_history_inventory_invalid')
      previous = item.key
      const conversationKey = hashContext({ identity: i, conversationId: item.conversationId })
      if (item.kind === 'message') {
        if (
          !item.identityVerified ||
          !item.messageIdVerified ||
          item.key !== `m:${conversationKey}:${String(item.sequence).padStart(16, '0')}`
        )
          fail('restore_history_inventory_invalid')
        conversations.add(conversationKey)
        summary.messages++
        if (item.direction === 'inbound') {
          summary.inbound++
          if (item.handledBy === null) summary.unhandledInbound++
          else summary.handledInbound++
        }
      } else {
        if (item.key !== `s:${item.executionId}`) fail('restore_history_inventory_invalid')
        if (item.conversation) conversations.add(conversationKey)
        summary.executions++
        if (
          item.status === 'unknown' ||
          item.receiptStatus === 'unknown' ||
          item.permitStatus === 'unknown'
        )
          summary.unknownExecutions++
        if (item.phase !== null && item.phase !== 'settled') summary.pendingCentral++
      }
      digest.update(hashContext(item))
    }
    summary.conversations = conversations.size
    if (
      hashContext(summary) !== hashContext(request.manifest.summary) ||
      digest.update(hashContext(summary)).digest('hex') !== request.manifest.basisHash
    )
      fail('restore_history_inventory_invalid')
    return request
  } catch {
    fail('restore_history_inventory_invalid')
  }
}
export type CheckedRestoreHistoryProof = RestoreHistoryCheck

/** No production sources are registered here. A valid signature authenticates a source claim;
 * physical completeness and outcome reconciliation remain independent release prerequisites. */
export class RestoreHistoryProofVerifier {
  private readonly sources: Array<{ trust: RestoreHistorySourceTrust; key: KeyObject }>
  constructor(configuredSources: RestoreHistorySourceTrust[]) {
    const ids = new Set<string>()
    this.sources = configuredSources.map((input) => {
      try {
        const trust = RestoreHistorySourceTrustSchema.parse(structuredClone(input))
        const id = hashContext({
          sourceId: trust.source.sourceId,
          keyId: trust.source.keyId,
          platform: trust.platform,
          tenantId: trust.tenantId,
          accountId: trust.accountId
        })
        const key = createPublicKey(trust.publicKeyPem)
        if (ids.has(id) || key.asymmetricKeyType !== 'ed25519' || trust.notAfter <= trust.notBefore)
          fail('restore_history_source_untrusted')
        ids.add(id)
        return { trust, key }
      } catch {
        fail('restore_history_source_untrusted')
      }
    })
  }
  check(
    raw: unknown,
    required: RestoreHistoryRequirement,
    now: number
  ): CheckedRestoreHistoryProof {
    // Bound the entire account before Zod clones nested arrays, rather than only each conversation.
    const candidate = raw as { proof?: { conversations?: Array<{ messages?: unknown[] }> } } | null
    const candidateConversations = candidate?.proof?.conversations
    if (Array.isArray(candidateConversations)) {
      let count = 0
      if (candidateConversations.length > 20000) fail('restore_history_incomplete')
      for (const conversation of candidateConversations) {
        if (Array.isArray(conversation?.messages)) count += conversation.messages.length
        if (count > 200000) fail('restore_history_incomplete')
      }
    }
    const envelope = SignedRestoreHistoryProofSchema.safeParse(raw)
    if (!envelope.success || !Millis.safeParse(now).success) fail('restore_history_invalid')
    const { proof, signature } = envelope.data
    const source = this.sources.find(
      ({ trust }) =>
        hashContext(trust.source) === hashContext(proof.source) &&
        trust.platform === proof.scope.platform &&
        trust.tenantId === proof.scope.tenant_id &&
        trust.accountId === proof.scope.account_id &&
        trust.platformAccountIdHash === proof.platformAccountIdHash
    )
    if (
      !source ||
      source.trust.revokedAt !== null ||
      now < source.trust.notBefore ||
      now >= source.trust.notAfter
    )
      fail('restore_history_source_untrusted')
    const bytes = Buffer.from(signature, 'base64url')
    if (
      bytes.toString('base64url') !== signature ||
      !verify(null, restoreHistorySigningBytes(proof), source.key, bytes)
    )
      fail('restore_history_signature_invalid')
    const requirement = checkedRequirement(required),
      m = requirement.manifest
    if (
      proof.caseId !== requirement.caseId ||
      proof.uploadId !== requirement.uploadId ||
      proof.restoreId !== m.context.restoreId.toLowerCase() ||
      proof.contextHash !== m.context.contextHash ||
      proof.inventoryBasisHash !== m.basisHash ||
      hashContext(proof.scope) !== hashContext(m.scope) ||
      proof.platformAccountIdHash !== requirement.platformAccountIdHash
    )
      fail('restore_history_context_conflict')
    if (
      proof.historyFrom > requirement.backupStartedAt ||
      proof.observedThrough < requirement.allDevicesStoppedAt ||
      proof.observedThrough < proof.historyFrom ||
      proof.capturedAt < proof.observedThrough ||
      proof.capturedAt > now ||
      now - proof.capturedAt > 300000 ||
      now - proof.observedThrough > 300000 ||
      proof.capturedAt < source.trust.notBefore ||
      proof.capturedAt >= source.trust.notAfter
    )
      fail('restore_history_time_invalid')
    if (!proof.complete || !proof.allConversationsEnumerated || proof.nextPageToken !== null)
      fail('restore_history_incomplete')
    const conversations = new Map<string, Map<string, { direction: string; contentHash: string }>>()
    let messages = 0
    for (const conversation of proof.conversations) {
      if (
        conversations.has(conversation.conversationId) ||
        !conversation.complete ||
        conversation.hasGap ||
        conversation.nextPageToken !== null
      )
        fail('restore_history_incomplete')
      const entries = new Map<string, { direction: string; contentHash: string }>()
      for (const [index, message] of conversation.messages.entries()) {
        if (
          message.position !== index + 1 ||
          entries.has(message.sourceMessageId) ||
          message.sentAt > proof.observedThrough
        )
          fail('restore_history_incomplete')
        entries.set(message.sourceMessageId, message)
        if (++messages > 200000) fail('restore_history_incomplete')
      }
      conversations.set(conversation.conversationId, entries)
    }
    const localAnchors = new Set<string>()
    for (const item of requirement.items) {
      const conversation = conversations.get(item.conversationId)
      if (!conversation) fail('restore_history_anchor_conflict')
      if (item.kind !== 'message') continue
      if (item.observedAt > proof.observedThrough) fail('restore_history_time_invalid')
      const message = conversation.get(item.sourceMessageId)
      if (
        !message ||
        message.direction !== item.direction ||
        message.contentHash !== item.contentHash
      )
        fail('restore_history_anchor_conflict')
      // The same platform message may appear in more than one historical login epoch.
      localAnchors.add(
        hashContext({ conversationId: item.conversationId, sourceMessageId: item.sourceMessageId })
      )
    }
    return RestoreHistoryCheckSchema.parse({
      proofId: proof.proofId,
      caseId: proof.caseId,
      uploadId: proof.uploadId,
      proofHash: hashContext(proof),
      signedProofHash: hashContext(envelope.data),
      sourceHash: hashContext(source.trust.source),
      sourceTrustHash: hashContext(source.trust),
      physicalHistoryVerificationSha256: source.trust.physicalHistoryVerificationSha256,
      scopeHash: hashContext(proof.scope),
      restoreId: proof.restoreId,
      contextHash: proof.contextHash,
      inventoryBasisHash: proof.inventoryBasisHash,
      conversations: conversations.size,
      messages,
      localMessageAnchors: localAnchors.size,
      additionalMessages: messages - localAnchors.size,
      historyFrom: proof.historyFrom,
      observedThrough: proof.observedThrough,
      capturedAt: proof.capturedAt,
      sourceClaimAuthenticated: true,
      structurallyComplete: true,
      physicalHistoryVerifiedByThisCheck: false,
      executionOutcomesVerified: false,
      canRelease: false
    })
  }
}
