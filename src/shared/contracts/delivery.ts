import { z } from 'zod'
import { Hash, Id, IdentitySchema } from './identity'

const BoundDelivery = {
  executionId: Id,
  identity: IdentitySchema,
  conversationId: Id,
  draftHash: Hash
}
export const ConfirmedDeliverySchema = z.strictObject({
  ...BoundDelivery,
  status: z.literal('confirmed'),
  evidence: z.string().trim().min(1).max(8192),
  proof: z.strictObject({ sourceMessageId: Id, verificationProofHash: Hash }).optional()
})
export const NotSentDeliverySchema = z.strictObject({
  ...BoundDelivery,
  status: z.literal('not_sent'),
  dispatchStarted: z.literal(false),
  quiescent: z.literal(true),
  verificationProofHash: Hash
})
export const DeliveryResultSchema = z.discriminatedUnion('status', [
  ConfirmedDeliverySchema,
  NotSentDeliverySchema,
  z.strictObject({ status: z.literal('unknown') })
])
export type DeliveryResult = z.infer<typeof DeliveryResultSchema>
