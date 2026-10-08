import { z } from 'zod'
import { Id } from './identity'

export const ContextMessageSchema = z.strictObject({
  sequence: z.number().int().positive(),
  sourceMessageId: Id,
  direction: z.enum(['inbound', 'human_outbound', 'automation_outbound']),
  kind: z.enum(['text', 'image', 'file', 'voice', 'unsupported']),
  text: z.string().max(32000)
})
export const ConversationContextSchema = z
  .array(ContextMessageSchema)
  .min(1)
  .max(40)
  .superRefine((messages, c) => {
    if (
      messages.reduce((n, m) => n + m.text.length, 0) > 32000 ||
      new Set(messages.map((m) => m.sourceMessageId)).size !== messages.length ||
      messages.some((m, i) => i > 0 && m.sequence !== messages[i - 1].sequence + 1)
    )
      c.addIssue({ code: 'custom', message: 'Context budget, message IDs or sequence invalid' })
  })
export type ContextMessage = z.infer<typeof ContextMessageSchema>
