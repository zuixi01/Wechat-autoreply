import { z } from 'zod'
import { Id } from './identity'
import { CollectionStatusSchema } from './collection-status'

export const RuntimeStatusSchema = z.strictObject({
  state: z.enum(['paused', 'starting', 'running', 'pausing', 'blocked', 'closed']),
  reason: z.enum([
    'none',
    'not_registered',
    'capability_unverified',
    'execution_path_unverified',
    'identity_unverified',
    'configuration_unavailable',
    'lease_lost',
    'start_cancelled',
    'observer_failed',
    'user_pause',
    'locked',
    'suspended',
    'shutdown',
    'settlement_pending',
    'local_storage_unavailable',
    'execution_reconciliation_required'
  ]),
  lease: z.enum(['stopped', 'acquiring', 'active', 'lost']),
  configurationVersion: Id.optional(),
  pauseAcknowledged: z.boolean(),
  readiness: z
    .strictObject({
      registered: z.boolean(),
      backgroundRead: z.boolean(),
      nonInterferingSend: z.boolean()
    })
    .optional(),
  collection: CollectionStatusSchema.optional()
})
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>
export interface RuntimeDesktopApi {
  status(): Promise<RuntimeStatus>
  synchronize(): Promise<RuntimeStatus>
  start(): Promise<RuntimeStatus>
  pause(): Promise<RuntimeStatus>
}
