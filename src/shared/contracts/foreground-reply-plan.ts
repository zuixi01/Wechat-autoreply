import { z } from 'zod'
import { formatWechatReply, hasReplyIdentityLeak } from '../reply-persona'

export const ReplyPartSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: z.string().trim().min(1).max(4096) }),
  z.strictObject({ kind: z.literal('image'), assetId: z.string().uuid() })
])
export const ReplyPlanSchema = z.strictObject({ parts: z.array(ReplyPartSchema).min(1).max(3) })
export const DeliverySchema = ReplyPlanSchema.extend({
  id: z.string().uuid(),
  question: z.string().max(80 * 4096 + 79),
  cursor: z.number().int().min(0).max(2)
}).refine((value) => value.cursor < value.parts.length)
export type ReplyPart = z.infer<typeof ReplyPartSchema>
export type ReplyPlan = z.infer<typeof ReplyPlanSchema>
export type Delivery = z.infer<typeof DeliverySchema>

export function parseReplyPlan(raw: string, allowedAssets: readonly string[] = []): ReplyPlan {
  const trimmed = raw.trim()
  const value =
    trimmed.startsWith('{') || trimmed.startsWith('```')
      ? JSON.parse(trimmed.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''))
      : { parts: [{ kind: 'text', text: trimmed }] }
  const plan = ReplyPlanSchema.parse(value)
  const parts = plan.parts.map((part) => {
    if (part.kind === 'image') {
      if (!allowedAssets.includes(part.assetId)) throw new Error('sticker_not_allowed')
      return part
    }
    if (hasReplyIdentityLeak(part.text)) throw new Error('reply_identity_invalid')
    return { ...part, text: formatWechatReply(part.text) }
  })
  if (
    parts.reduce((total, part) => total + (part.kind === 'text' ? part.text.length : 0), 0) > 4096
  )
    throw new Error('reply_invalid')
  return { parts }
}
