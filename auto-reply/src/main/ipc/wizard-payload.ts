import { z } from 'zod'

const rect = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive().max(65536),
  height: z.number().positive().max(65536)
})
export const WizardCompletionSchema = z.strictObject({
  id: z.string().regex(/^wizard-\d{13}-[1-9]\d{0,9}$/),
  regions: z.strictObject({
    contactList: rect,
    chatMain: rect,
    inputBox: rect,
    unreadIndicator: rect.nullable(),
    displayId: z.number().int().optional(),
    scaleFactor: z.number().positive().max(16).optional(),
    capturedAt: z.number().int().nonnegative()
  })
})
export const WizardCancellationSchema = WizardCompletionSchema.pick({ id: true })
