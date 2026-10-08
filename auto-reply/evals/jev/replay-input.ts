import { z } from 'zod'
import { Hash, Id } from '../../src/shared/contracts/identity'
import { ConversationContextSchema } from '../../src/shared/contracts/context'
import { hashContext } from '../../src/core/reply/hashes'
import { EvaluationPlanSchema } from '../../server/src/admin/evaluation-admission'
import { PublicationSchema } from '../../server/src/generation/publication'
import { evaluationSnapshotHash } from '../../server/src/generation/evaluation-authorization'

/** Model inputs only. Independent business labels never enter this contract. */
export const ReplayCaseInputSchema = z
  .strictObject({
    caseId: Id,
    conversationGroup: Id,
    split: z.enum(['calibration', 'holdout']),
    conversationId: Id,
    inbound: z
      .array(
        z
          .string()
          .min(1)
          .max(8000)
          .refine((s) => s.trim().length > 0)
      )
      .min(1)
      .max(30),
    context: ConversationContextSchema.optional()
  })
  .superRefine((item, c) => {
    if (item.inbound.reduce((n, text) => n + text.length, 0) > 24000)
      c.addIssue({ code: 'custom', message: 'Inbound budget exceeded' })
  })
export const ReplayInputSchema = z.strictObject({
  datasetId: Id,
  split: z.enum(['calibration', 'holdout']),
  cases: z.array(ReplayCaseInputSchema).min(1).max(2000)
})
export type ReplayCaseInput = z.infer<typeof ReplayCaseInputSchema>

export function replayCaseInputHash(input: unknown): string {
  return hashContext(ReplayCaseInputSchema.parse(input))
}

/** The caller must obtain this record from Administration.readFrozenEvaluation,
 * never accept a user file as proof that a database freeze exists. */
export interface FrozenReplaySource {
  runId: string
  snapshotHash: string
  publication: z.infer<typeof PublicationSchema>
  plan: z.infer<typeof EvaluationPlanSchema>
  createdAt: Date
  expiresAt: Date
  serverNow: Date
}

/** No provider, publication write, generation task, lease or execution is involved. */
export function validateFrozenReplayInputs(
  frozen: FrozenReplaySource,
  raw: unknown,
  activeTextGeneratorVersion: string
): {
  input: z.infer<typeof ReplayInputSchema>
  summary: {
    runId: string
    executionPlanHash: string
    snapshotHash: string
    split: 'calibration' | 'holdout'
    caseCount: number
    maximumLogicalModelCalls: number
    releaseAuthorized: false
    modelsCalled: false
  }
} {
  const input = ReplayInputSchema.parse(raw)
  const publication = PublicationSchema.parse(frozen.publication)
  const plan = EvaluationPlanSchema.parse(frozen.plan)
  Id.parse(frozen.runId)
  Hash.parse(frozen.snapshotHash)
  const times = [frozen.createdAt, frozen.expiresAt, frozen.serverNow].map((t) => t.getTime())
  if (times.some((t) => !Number.isFinite(t)) || times[2] < times[0] || times[2] >= times[1])
    throw new Error('evaluation_run_expired_or_invalid')
  if (evaluationSnapshotHash(publication) !== frozen.snapshotHash)
    throw new Error('frozen_snapshot_invalid')
  if (publication.textGeneratorVersion !== activeTextGeneratorVersion)
    throw new Error('text_generator_changed')
  if (plan.replayProtocol !== 'jev-abc-v1') throw new Error('replay_inputs_not_frozen')
  if (input.datasetId !== plan.datasetId) throw new Error('replay_dataset_mismatch')
  const expected = new Map(
    plan.assignments.filter((a) => a.split === input.split).map((a) => [a.caseId, a])
  )
  if (input.cases.length !== expected.size) throw new Error('replay_sample_incomplete')
  const seen = new Set<string>()
  for (const item of input.cases) {
    const assignment = expected.get(item.caseId)
    if (
      seen.has(item.caseId) ||
      !assignment ||
      item.split !== input.split ||
      item.conversationGroup !== assignment.conversationGroup ||
      replayCaseInputHash(item) !== assignment.inputHash
    )
      throw new Error('replay_case_changed_or_unplanned')
    seen.add(item.caseId)
  }
  return {
    input,
    summary: {
      runId: frozen.runId,
      executionPlanHash: hashContext(plan),
      snapshotHash: frozen.snapshotHash,
      split: input.split,
      caseCount: input.cases.length,
      // A: text; B: pre + text; C: pre + text + post. HTTP retries
      // and token/monetary limits need separate recording before dispatch.
      maximumLogicalModelCalls: input.cases.length * 6,
      releaseAuthorized: false,
      modelsCalled: false
    }
  }
}
