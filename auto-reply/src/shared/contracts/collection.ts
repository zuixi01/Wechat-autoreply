import { z } from 'zod'
import { ConversationBindingSchema, Id, IdentitySchema } from './identity'
import { ObservedMessageSchema } from './message'
import { CollectionStatusSchema } from './collection-status'
export { CollectionStatusSchema } from './collection-status'

export const Cursor = z.string().min(1).max(2048)
export const CollectionEntrySchema = z.strictObject({
  binding: ConversationBindingSchema,
  displayName: z.string().max(256),
  // This token describes source activity, never customer identity or UI coordinates.
  activityVersion: Id
})
export const InventoryPageSchema = z.strictObject({
  identity: IdentitySchema,
  snapshotId: Id,
  entries: z.array(CollectionEntrySchema).max(100),
  nextCursor: Cursor.nullable(),
  total: z.number().int().nonnegative().max(100000),
  // Only a stable authoritative enumeration can claim full coverage.
  authoritative: z.boolean()
})
export const MessagePageSchema = z.strictObject({
  binding: ConversationBindingSchema,
  activityVersion: Id,
  fromCursor: Cursor.nullable(),
  nextCursor: Cursor.nullable(),
  messages: z.array(ObservedMessageSchema).max(100),
  complete: z.boolean(),
  hasGap: z.boolean()
})
export type CollectionEntry = z.infer<typeof CollectionEntrySchema>
export type InventoryPage = z.infer<typeof InventoryPageSchema>
export type MessagePage = z.infer<typeof MessagePageSchema>
export type CollectionStatus = z.infer<typeof CollectionStatusSchema>
export interface CollectionReadRequest {
  entry: CollectionEntry
  cursor: string | null
  revision: number
  restoreGrant?: import('./restore-observation').RestoreObservationGrant
}
export interface CollectionSource {
  capabilities(): {
    backgroundRead: boolean
    stableIdentity: boolean
    stableMessageIds: boolean
  }
  inventory(
    input: {
      identity: z.infer<typeof IdentitySchema>
      snapshotId: string | null
      cursor: string | null
    },
    signal: AbortSignal
  ): Promise<InventoryPage>
  read(request: CollectionReadRequest, signal: AbortSignal): Promise<MessagePage>
  // Hints speed up discovery; periodic enumeration remains mandatory.
  subscribe?(onHint: (conversationId: string) => void): () => void
}
