import { z } from 'zod'
import { Hash, Id } from './identity'
import { ReplyTaskSchema, ReplyDraftSchema } from './task'

/** An authenticated employee's explicit confirmation, never a model approval. */
export const HumanConfirmationSchema = z
  .strictObject({
    confirmationId: z.string().uuid(),
    taskId: Id,
    sourceTaskId: Id,
    taskHash: Hash,
    draftHash: Hash,
    draftRevision: z.number().int().nonnegative().safe(),
    employeeId: Id,
    modelResolved: Id,
    confirmedAt: z.number().int().nonnegative().safe(),
    expiresAt: z.number().int().positive().safe()
  })
  .refine((c) => c.expiresAt > c.confirmedAt && c.expiresAt - c.confirmedAt <= 5000)
export type HumanConfirmation = z.infer<typeof HumanConfirmationSchema>
export const HumanPermitRequestSchema = z.strictObject({
  task: ReplyTaskSchema,
  draft: ReplyDraftSchema,
  confirmation: HumanConfirmationSchema,
  leaseVersion: z.number().int().positive().safe()
})
export type HumanPermitRequest = z.infer<typeof HumanPermitRequestSchema>
