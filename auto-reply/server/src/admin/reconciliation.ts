import { z } from 'zod'
import { Hash, Id } from '../../../src/shared/contracts/identity'

// Operator references are metadata, never physical-device attestations or permission
// to overwrite an unknown receipt. Keep private screenshots/chat outside this DB.
export const ReconciliationNoteSchema = z.strictObject({
  noteId: z.string().uuid(),
  snapshotHash: Hash,
  referenceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  evidenceHash: Hash,
  observedAt: z.number().int().nonnegative().safe()
})
export type ReconciliationNote = z.infer<typeof ReconciliationNoteSchema>

export const ReconciliationSnapshotSchema = z.strictObject({
  tenantId: Id,
  accountId: Id,
  permitId: Id,
  agentId: Id,
  taskId: Id,
  taskHash: z.string().nullable(),
  draftHash: z.string(),
  draftRevision: z.number().int().nonnegative().safe().nullable(),
  leaseVersion: z.number().int().positive().safe(),
  loginEpoch: z.number().int().nonnegative().safe().nullable(),
  clientInstanceId: Id.nullable(),
  conversationId: Id.nullable(),
  purpose: z.enum(['automatic', 'human']),
  confirmationId: Id.nullable(),
  statusAtOpening: z.enum(['issued', 'unknown']),
  issuedAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().nonnegative().safe().nullable(),
  settledAt: z.number().int().nonnegative().safe().nullable(),
  settlementHash: z.string().nullable()
})
export type ReconciliationSnapshot = z.infer<typeof ReconciliationSnapshotSchema>
export interface ReconciliationCase {
  caseId: string
  snapshotHash: string
  snapshot: ReconciliationSnapshot
  openedBy: string
  openedAt: number
  noteCount: number
  devicePauseAcknowledged: null
}
