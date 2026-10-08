import { z } from 'zod'
import { Hash, Id } from './identity'

export const WorkbenchPresentationRequestSchema = z.strictObject({
  taskId: Id,
  expectedVersion: Hash
})
export const WorkbenchPresentationAckSchema = z.strictObject({ nonce: z.uuid() })
export const WorkbenchPresentationTicketSchema = z.discriminatedUnion('available', [
  z.strictObject({ available: z.literal(true), nonce: z.uuid() }),
  z.strictObject({ available: z.literal(false) })
])
export const WorkbenchPresentationResultSchema = z.strictObject({ accepted: z.boolean() })
export type WorkbenchPresentationRequest = z.infer<typeof WorkbenchPresentationRequestSchema>
export type WorkbenchPresentationAck = z.infer<typeof WorkbenchPresentationAckSchema>
export type WorkbenchPresentationTicket = z.infer<typeof WorkbenchPresentationTicketSchema>
export type WorkbenchPresentationResult = z.infer<typeof WorkbenchPresentationResultSchema>
