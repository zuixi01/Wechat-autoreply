import { z } from 'zod'
import { Hash, Id, IdentitySchema, sameIdentity } from './identity'
import { ExecutionPermitSchema, PermitRequestSchema } from './execution'
import { DeviceReconciliationReportSchema } from './reconciliation'

// A seal is a revocation of a request, never a send permission or an assertion
// that an already dispatched message was absent. Main proves non-dispatch from
// its durable journal before using this route.
export const RequestSealInputSchema = z
  .strictObject({
    executionId: Id,
    identity: IdentitySchema,
    request: PermitRequestSchema,
    stopped: DeviceReconciliationReportSchema.shape.stopped,
    verificationProofHash: Hash
  })
  .refine(
    (p) =>
      p.identity.loginEpoch === p.request.loginEpoch &&
      p.identity.clientInstanceId === p.request.clientInstanceId
  )
export type RequestSealInput = z.infer<typeof RequestSealInputSchema>
export const RequestSealSchema = z.strictObject({
  sealId: z.string().uuid(),
  input: RequestSealInputSchema,
  requestHash: Hash,
  sealedAt: z.number().int().nonnegative().safe()
})
export type RequestSeal = z.infer<typeof RequestSealSchema>
export const RequestSealResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('request_sealed'), seal: RequestSealSchema }),
  z.strictObject({
    status: z.literal('existing_permit'),
    permit: ExecutionPermitSchema.refine((p) => !p.newlyIssued)
  })
])
export type RequestSealResult = z.infer<typeof RequestSealResultSchema>
export const RequestSealAppliedSchema = z.strictObject({
  sealId: z.string().uuid(),
  sealHash: Hash,
  requestHash: Hash,
  executionId: Id
})
export const RequestSealAckSchema = RequestSealAppliedSchema.extend({
  status: z.literal('request_seal_applied')
})
export type RequestSealAck = z.infer<typeof RequestSealAckSchema>

export function parseRequestSealResult(
  value: unknown,
  input: RequestSealInput,
  requestHash: string
): RequestSealResult {
  const result = RequestSealResultSchema.parse(value)
  if (result.status === 'request_sealed') {
    const s = result.seal
    // The caller also compares a canonical hash of the returned input. All
    // scalar bindings below reject substituted identities/requests early.
    if (
      s.requestHash !== requestHash ||
      s.input.executionId !== input.executionId ||
      !sameIdentity(s.input.identity, input.identity) ||
      s.input.verificationProofHash !== input.verificationProofHash ||
      s.input.stopped.stoppedAt !== input.stopped.stoppedAt ||
      s.sealedAt < input.stopped.stoppedAt ||
      JSON.stringify(s.input.request) !== JSON.stringify(input.request)
    )
      throw new Error('request_seal_mismatch')
  } else {
    const p = result.permit,
      r = input.request
    if (
      !sameIdentity(p.identity, input.identity) ||
      p.taskId !== r.taskId ||
      p.taskHash !== r.taskHash ||
      p.draftHash !== r.draftHash ||
      p.draftRevision !== r.draftRevision ||
      p.leaseVersion !== r.leaseVersion ||
      (p.purpose ?? 'automatic') !== (r.purpose ?? 'automatic') ||
      p.confirmationId !== r.confirmationId ||
      p.expiresAt <= p.issuedAt ||
      p.expiresAt - p.issuedAt > 5000
    )
      throw new Error('request_seal_permit_mismatch')
  }
  return result
}
