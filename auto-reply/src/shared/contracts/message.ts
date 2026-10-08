import { z } from 'zod'
import { Id, IdentitySchema } from './identity'
import { SignedRestoreObservationSchema } from './restore-observation'

export const ObservedMessageSchema = z.strictObject({
  identity: IdentitySchema,
  conversationId: Id,
  sourceMessageId: Id,
  direction: z.enum(['inbound', 'human_outbound', 'automation_outbound']),
  kind: z.enum(['text', 'image', 'file', 'voice', 'unsupported']),
  text: z.string().max(100000),
  observedAt: z.number().int().nonnegative(),
  // Only stable IDs obtained from a validated adapter qualify for automatic handling.
  identityVerified: z.boolean(),
  messageIdVerified: z.boolean(),
  restoreEvidence: SignedRestoreObservationSchema.optional()
})
export type ObservedMessage = z.infer<typeof ObservedMessageSchema>
export interface StoredMessage extends ObservedMessage {
  sequence: number
  handledBy: string | null
}
