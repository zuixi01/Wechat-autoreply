import { z } from 'zod'
import { Hash, Id, IdentitySchema } from './identity'
import { RestoreHistorySourceTrustSchema } from './history-source-trust'
import { type RestoreRecoveryPackage } from './restore-recovery'
import { hashContext } from '../../core/reply/hashes'
const Millis = z.number().int().nonnegative().safe()
export const RestoreObservationGrantSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    grantId: z.uuid().toLowerCase(),
    authorizationId: z.uuid().toLowerCase(),
    authorizationHash: Hash,
    boundaryHash: Hash,
    restoreId: z.uuid().toLowerCase(),
    contextHash: Hash,
    sourceTrust: RestoreHistorySourceTrustSchema.refine(
      (s) => s.stableSourceOrderVerified === true && s.revokedAt === null
    ),
    sourceTrustHash: Hash,
    issuedAt: Millis,
    expiresAt: Millis,
    automaticStart: z.literal(false),
    canRelease: z.literal(false)
  })
  .refine(
    (v) =>
      v.sourceTrustHash === hashContext(v.sourceTrust) &&
      v.expiresAt > v.issuedAt &&
      v.expiresAt - v.issuedAt <= 300000
  )
export type RestoreObservationGrant = z.infer<typeof RestoreObservationGrantSchema>
export function parseRestoreObservationGrant(
  raw: unknown,
  p: RestoreRecoveryPackage
): RestoreObservationGrant {
  if (Buffer.byteLength(JSON.stringify(raw) ?? '') > 16384)
    throw Error('restore_observation_grant_conflict')
  const g = RestoreObservationGrantSchema.parse(raw),
    a = p.authorization,
    h = p.boundary.history,
    s = g.sourceTrust
  if (
    g.authorizationId !== a.authorizationId ||
    g.authorizationHash !== hashContext(a) ||
    g.boundaryHash !== a.boundaryHash ||
    g.restoreId !== a.restoreId ||
    g.contextHash !== a.contextHash ||
    hashContext(s.source) !== hashContext(h.source) ||
    s.tenantId !== a.scope.tenant_id ||
    s.accountId !== a.scope.account_id ||
    s.platform !== a.scope.platform ||
    s.platformAccountIdHash !== h.platformAccountIdHash ||
    g.issuedAt < a.recordedAt ||
    g.issuedAt < s.notBefore ||
    g.expiresAt !== Math.min(g.issuedAt + 300000, a.expiresAt, s.notAfter)
  )
    throw Error('restore_observation_grant_conflict')
  return g
}
export const RestoreObservationProofSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    kind: z.literal('restore-ordered-observation'),
    grantId: z.uuid().toLowerCase(),
    grantHash: Hash,
    identity: IdentitySchema,
    conversationId: Id,
    sourceMessageId: Id,
    direction: z.enum(['inbound', 'human_outbound', 'automation_outbound']),
    contentHash: Hash,
    position: Millis.min(1),
    previousSourceMessageId: Id.nullable(),
    previousContentHash: Hash.nullable(),
    sentAt: Millis,
    capturedAt: Millis
  })
  .refine((v) => (v.previousSourceMessageId === null) === (v.previousContentHash === null))
export const SignedRestoreObservationSchema = z.strictObject({
  proof: RestoreObservationProofSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/)
})
export type SignedRestoreObservation = z.infer<typeof SignedRestoreObservationSchema>
export function restoreObservationSigningBytes(
  p: z.infer<typeof RestoreObservationProofSchema>
): Buffer {
  return Buffer.from(`autoreply.restore-ordered-observation.v1\n${hashContext(p)}`, 'utf8')
}
