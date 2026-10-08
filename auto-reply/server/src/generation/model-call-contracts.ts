import { z } from 'zod'
import { Id, Hash } from '../../../src/shared/contracts/identity'
import { JevResponseSchema } from '../../../src/shared/contracts/decision'

export const ModelStageSchema = z.enum(['pre', 'text', 'post'])
export type ModelStage = z.infer<typeof ModelStageSchema>
export interface ModelCallScope {
  run<T>(stage: ModelStage, operation: () => Promise<T>): Promise<T>
}
export const ModelCallLimitSchema = z.strictObject({
  dailyAttemptLimit: z.number().int().min(0).max(100000)
})
export const ModelCallStartSchema = z.strictObject({
  provider: z.enum(['jev', 'text']),
  requestHash: Hash,
  requestedModel: Id,
  questionHash: Hash.optional()
})
export const ProviderRequestIdSchema = z.strictObject({
  header: z.enum(['x-typesafe-request-id', 'x-request-id']),
  value: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
})
export const ModelCallResultSchema = z.strictObject({
  outcome: z.enum(['response', 'error', 'cancelled', 'timed_out', 'not_dispatched']),
  durationMs: z.number().int().nonnegative().safe(),
  failureCode: z
    .enum([
      'AUTH_FAILED',
      'RATE_LIMITED',
      'UNAVAILABLE',
      'INVALID_RESPONSE',
      'MODEL_DRIFT',
      'REDIRECT_REJECTED',
      'HTTP_ERROR',
      'CANCELLED',
      'TIMEOUT'
    ])
    .optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  // Observed provider headers can correlate an attempt with external records.
  // They do not certify billing, and absence remains unknown.
  providerRequestId: ProviderRequestIdSchema.optional(),
  actualModel: Id.optional(),
  usage: z
    .strictObject({
      inputTokens: z.number().int().nonnegative().safe(),
      outputTokens: z.number().int().nonnegative().safe()
    })
    .optional(),
  answers: JevResponseSchema.shape.answers.optional(),
  textOutput: z
    .strictObject({
      draftHash: Hash,
      evidenceIds: z.array(Id).min(1).max(100)
    })
    .optional()
})
export type ModelCallStart = z.infer<typeof ModelCallStartSchema>
export type ModelCallResult = z.infer<typeof ModelCallResultSchema>
export interface ModelCallHandle {
  finish(result: ModelCallResult): Promise<void>
}
export class ModelCallError extends Error {
  constructor(
    readonly code:
      | 'LIMIT_UNCONFIGURED'
      | 'LIMIT_REACHED'
      | 'RECORD_UNAVAILABLE'
      | 'CONTEXT_UNAVAILABLE'
  ) {
    super(code)
    this.name = 'ModelCallError'
  }
}
export class ModelTransportError extends Error {
  constructor(readonly code: 'INVALID_RESPONSE' | 'UNAVAILABLE' | 'TIMEOUT' | 'CANCELLED') {
    super(code)
    this.name = 'ModelTransportError'
  }
}
