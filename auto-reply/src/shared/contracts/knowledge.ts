import { z } from 'zod'
import type { MemoryScope } from './learning-memory'

export const KNOWLEDGE_EXTENSIONS = ['txt', 'md', 'csv', 'json', 'docx', 'xlsx', 'pdf'] as const
export const KnowledgeDocumentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(240),
  category: z.string().max(80),
  format: z.string().max(20),
  state: z.enum(['processing', 'ready', 'failed']),
  enabled: z.boolean(),
  error: z.string().optional(),
  characters: z.number().int().nonnegative(),
  chunks: z.number().int().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
  version: z.number().int().positive()
})
export type KnowledgeDocument = z.infer<typeof KnowledgeDocumentSchema>
export const KnowledgeSettingsSchema = z.object({
  enabled: z.boolean(),
  fallbackReply: z.string().trim().min(1).max(1000)
})
export type KnowledgeSettings = z.infer<typeof KnowledgeSettingsSchema>
export const KnowledgeSnapshotSchema = z.object({
  version: z.string(),
  settings: KnowledgeSettingsSchema,
  documents: z.array(KnowledgeDocumentSchema)
})
export type KnowledgeSnapshot = z.infer<typeof KnowledgeSnapshotSchema>
export const KnowledgeHitSchema = z.object({
  documentId: z.string(),
  name: z.string(),
  category: z.string(),
  chunkId: z.string(),
  text: z.string(),
  score: z.number(),
  version: z.number()
})
export type KnowledgeHit = z.infer<typeof KnowledgeHitSchema>
export type KnowledgeUpload = {
  name: string
  bytes: Uint8Array
  category?: string
  replaceId?: string
}
export type KnowledgeReply = {
  learning?: { scope: MemoryScope; episodeId: string; corpusVersion: string; memoryRefs: { id: string; revision: number }[] }
  text: string
  hits: KnowledgeHit[]
  version: string
  fallback: boolean
}
export const KnowledgeBundleSchema = z.strictObject({
  schema: z.literal('autoreply-knowledge-v1'),
  version: z.string().min(1),
  settings: KnowledgeSettingsSchema,
  documents: z
    .array(
      z.strictObject({
        id: z.string().uuid(),
        name: z.string().min(1).max(240),
        category: z.string().max(80),
        content: z.string().min(1).max(2000000),
        version: z.number().int().positive()
      })
    )
    .max(200)
})
export type KnowledgeBundle = z.infer<typeof KnowledgeBundleSchema>
export interface KnowledgeDesktopApi {
  snapshot(): Promise<KnowledgeSnapshot>
  importFile(
    input: KnowledgeUpload
  ): Promise<{ success: boolean; error?: string; document?: KnowledgeDocument }>
  save(input: {
    id?: string
    name: string
    category: string
    content: string
  }): Promise<KnowledgeDocument>
  detail(id: string): Promise<{ document: KnowledgeDocument; content: string }>
  update(input: { id: string; enabled?: boolean; category?: string }): Promise<void>
  remove(id: string): Promise<void>
  settings(input: KnowledgeSettings): Promise<void>
  search(query: string): Promise<{ hits: KnowledgeHit[]; version: string }>
  answer(input: { question: string; modeId: string; objectId?: string }): Promise<KnowledgeReply>
  export(): Promise<KnowledgeBundle>
}
