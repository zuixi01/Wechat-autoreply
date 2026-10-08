import { z } from 'zod'

export const Id = z.string().trim().min(1).max(128)
export const Version = z.number().int().nonnegative()
export const Hash = z.string().regex(/^[a-f0-9]{64}$/)
export const IdentitySchema = z.strictObject({
  tenantId: Id,
  employeeId: Id,
  accountId: Id,
  agentId: Id,
  platform: z.enum(['wechat', 'wework']),
  loginEpoch: Version,
  clientInstanceId: Id
})
export const ConversationBindingSchema = z.strictObject({
  identity: IdentitySchema,
  conversationId: Id,
  bindingVersion: Version,
  identityVerified: z.boolean(),
  identityEvidence: z.array(z.string().min(1)).min(1)
})
export type Identity = z.infer<typeof IdentitySchema>
export type ConversationBinding = z.infer<typeof ConversationBindingSchema>

export function sameIdentity(a: Identity, b: Identity): boolean {
  return Object.keys(IdentitySchema.shape).every(
    (key) => a[key as keyof Identity] === b[key as keyof Identity]
  )
}
