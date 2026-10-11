import { z } from 'zod'

export const StickerSchema = z.strictObject({
  id: z.string().uuid(),
  label: z.string().trim().min(1).max(40),
  tags: z.array(z.string().trim().min(1).max(20)).max(8),
  enabled: z.boolean(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().positive().max(512),
  height: z.number().int().positive().max(512)
})
export type Sticker = z.infer<typeof StickerSchema>
export const StyleEditSchema = z.strictObject({
  target: z.string().trim().max(128),
  id: z.string().uuid().optional(),
  action: z.enum(['teach', 'correct', 'delete', 'rollback']),
  text: z.string().trim().min(1).max(160).optional()
})
export interface PersonalResourcesApi {
  resources(target: string): Promise<{
    stickers: Sticker[]
    style: { id: string; text: string; revision: number }[]
    learningEnabled: boolean
  }>
  importSticker(): Promise<Sticker | null>
  editSticker(input: {
    id: string
    enabled?: boolean
    label?: string
    tags?: string[]
    delete?: boolean
  }): Promise<void>
  editStyle(input: z.infer<typeof StyleEditSchema>): Promise<void>
  enableLearning(enabled: boolean): Promise<void>
}
