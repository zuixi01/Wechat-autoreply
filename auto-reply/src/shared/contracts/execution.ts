import { z } from 'zod'
import { Hash, Id, IdentitySchema, Version } from './identity'

export const PermitRequestSchema = z
  .strictObject({
    taskId: Id,
    taskHash: Hash,
    draftHash: Hash,
    draftRevision: Version,
    loginEpoch: Version,
    clientInstanceId: Id,
    leaseVersion: z.number().int().positive().safe(),
    purpose: z.enum(['automatic', 'human']).optional(),
    confirmationId: z.string().uuid().optional()
  })
  .refine((p) => (p.purpose === 'human' ? !!p.confirmationId : !p.confirmationId))

export const ExecutionPermitSchema = z
  .strictObject({
    permitId: Id,
    identity: IdentitySchema,
    taskId: Id,
    conversationId: Id,
    taskHash: Hash,
    draftHash: Hash,
    draftRevision: Version,
    leaseVersion: z.number().int().positive().safe(),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    status: z.enum(['issued', 'confirmed', 'not_sent', 'unknown']),
    newlyIssued: z.boolean(),
    purpose: z.enum(['automatic', 'human']).optional(),
    confirmationId: z.string().uuid().optional()
  })
  .refine((p) => (p.purpose === 'human' ? !!p.confirmationId : !p.confirmationId))

const ReceiptBase = { permitId: Id, draftHash: Hash }
// These are attestations from the authenticated Agent. Actual echo/quiescence
// evidence must be produced by the verified adapter, never a renderer checkbox.
export const ExecutionReceiptSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...ReceiptBase,
    status: z.literal('confirmed'),
    sourceMessageId: Id,
    verificationProofHash: Hash
  }),
  z.strictObject({
    ...ReceiptBase,
    status: z.literal('not_sent'),
    dispatchStarted: z.literal(false),
    quiescent: z.literal(true),
    verificationProofHash: Hash
  }),
  z.strictObject({ ...ReceiptBase, status: z.literal('unknown') })
])
export type PermitRequest = z.infer<typeof PermitRequestSchema>
export type ExecutionPermit = z.infer<typeof ExecutionPermitSchema>
export type ExecutionReceipt = z.infer<typeof ExecutionReceiptSchema>
