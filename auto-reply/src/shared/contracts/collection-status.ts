import { z } from 'zod'

/** Display metadata only; this module must remain usable by a sandboxed renderer. */
export const CollectionStatusSchema = z.strictObject({
  coverage: z.enum(['not_started', 'scanning', 'complete', 'incomplete']),
  reason: z.enum([
    'none',
    'interrupted',
    'source_unavailable',
    'inventory_changed',
    'no_progress',
    'limit_reached',
    'partial_inventory',
    'identity_unverified'
  ]),
  knownConversations: z.number().int().nonnegative(),
  pendingReads: z.number().int().nonnegative(),
  needsHuman: z.number().int().nonnegative(),
  lastCompletedAt: z.number().int().nonnegative().nullable()
})
