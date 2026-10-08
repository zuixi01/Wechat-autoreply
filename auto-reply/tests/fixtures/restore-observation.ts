import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { hashContext } from '../../src/core/reply/hashes'
import type { RestoreRecoveryPackage } from '../../src/shared/contracts/restore-recovery'
import type { ObservedMessage } from '../../src/shared/contracts/message'
import {
  parseRestoreObservationGrant,
  RestoreObservationProofSchema,
  restoreObservationSigningBytes
} from '../../src/shared/contracts/restore-observation'

/** Offline signer, deliberately not a physical client capability or production trust. */
export function restoreObservationFixture(p: RestoreRecoveryPackage, issuedAt = 7450) {
  const keys = generateKeyPairSync('ed25519'),
    a = p.authorization,
    sourceTrust = {
      source: p.boundary.history.source,
      tenantId: a.scope.tenant_id,
      accountId: a.scope.account_id,
      platform: a.scope.platform,
      platformAccountIdHash: p.boundary.history.platformAccountIdHash,
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      physicalHistoryVerificationSha256: 'a'.repeat(64),
      completeAccountHistoryVerified: true,
      stableMessageIdentityVerified: true,
      stableSourceOrderVerified: true,
      sourceOrderVerificationSha256: 'b'.repeat(64),
      notBefore: 0,
      notAfter: 9999999999999,
      revokedAt: null
    },
    grant = parseRestoreObservationGrant(
      {
        formatVersion: 1,
        grantId: randomUUID(),
        authorizationId: a.authorizationId,
        authorizationHash: hashContext(a),
        boundaryHash: a.boundaryHash,
        restoreId: a.restoreId,
        contextHash: a.contextHash,
        sourceTrust,
        sourceTrustHash: hashContext(sourceTrust),
        issuedAt,
        expiresAt: Math.min(issuedAt + 300000, a.expiresAt, sourceTrust.notAfter),
        automaticStart: false,
        canRelease: false
      },
      p
    )
  return {
    grant,
    signed(
      message: ObservedMessage,
      position?: number,
      previous?: { sourceMessageId: string; contentHash: string } | null
    ): ObservedMessage {
      const last = p.boundary.history.conversations
          .find((c) => c.conversationId === message.conversationId)
          ?.messages.at(-1),
        prev = previous === undefined ? last : previous,
        proof = RestoreObservationProofSchema.parse({
          formatVersion: 1,
          kind: 'restore-ordered-observation',
          grantId: grant.grantId,
          grantHash: hashContext(grant),
          identity: message.identity,
          conversationId: message.conversationId,
          sourceMessageId: message.sourceMessageId,
          direction: message.direction,
          contentHash: hashContext({
            direction: message.direction,
            kind: message.kind,
            text: message.text
          }),
          position: position ?? (last?.position ?? 0) + 1,
          previousSourceMessageId: prev?.sourceMessageId ?? null,
          previousContentHash: prev?.contentHash ?? null,
          sentAt: message.observedAt,
          capturedAt: message.observedAt
        })
      return {
        ...message,
        restoreEvidence: {
          proof,
          signature: sign(null, restoreObservationSigningBytes(proof), keys.privateKey).toString(
            'base64url'
          )
        }
      }
    }
  }
}
