import { z } from 'zod'
import { Id, IdentitySchema } from './identity'

export const LeaseGrantSchema = z
  .strictObject({
    identity: IdentitySchema,
    leaseId: Id,
    version: z.number().int().positive().safe(),
    serverIssuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive()
  })
  .refine(
    (lease) =>
      lease.expiresAt > lease.serverIssuedAt && lease.expiresAt - lease.serverIssuedAt <= 30000
  )
export type LeaseGrant = z.infer<typeof LeaseGrantSchema>
