import { z } from 'zod'
import { Hash, Id } from './identity'
import { RestoreHistorySourceSchema } from './restore-history'
const Millis = z.number().int().nonnegative().safe()
/** Supplied only by independent maintenance configuration, never a device report. */
export const RestoreHistorySourceTrustSchema = z
  .strictObject({
    source: RestoreHistorySourceSchema,
    tenantId: Id,
    accountId: Id,
    platformAccountIdHash: Hash,
    platform: z.enum(['wechat', 'wework']),
    publicKeyPem: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/),
    physicalHistoryVerificationSha256: Hash,
    completeAccountHistoryVerified: z.literal(true),
    stableMessageIdentityVerified: z.literal(true),
    notBefore: Millis,
    notAfter: Millis,
    revokedAt: Millis.nullable(),
    stableSourceOrderVerified: z.literal(true).optional(),
    sourceOrderVerificationSha256: Hash.optional()
  })
  .refine(
    (v) =>
      (v.stableSourceOrderVerified === true) === (v.sourceOrderVerificationSha256 !== undefined)
  )
export type RestoreHistorySourceTrust = z.infer<typeof RestoreHistorySourceTrustSchema>
