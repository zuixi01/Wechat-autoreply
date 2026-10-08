import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { Id, Hash } from '../../src/shared/contracts/identity'
import { hashContext } from '../../src/core/reply/hashes'
import { TypeSafeClient } from '../../server/src/decision/typesafe-client'
import { HttpTextGenerator, textGeneratorVersion } from '../../server/src/generation/text-generator'
import { recordedTransport } from '../../server/src/generation/model-call-transport'
import {
  ModelCallError,
  ModelStageSchema,
  type ModelCallHandle,
  type ModelCallStart,
  type ModelStage
} from '../../server/src/generation/model-call-contracts'
import { PublicationSchema } from '../../server/src/generation/publication'
import { EvaluationPlanSchema } from '../../server/src/admin/evaluation-admission'
import { evaluationSnapshotHash } from '../../server/src/generation/evaluation-authorization'
import { preQuestions, auditQuestions } from '../../server/src/reply/jev-pipeline'
import type {
  AuthorizedReplaySource,
  ReplayAssignment,
  ReplayAttempt,
  ReplayProviders
} from './replay'

const AssignmentSchema = z.strictObject({
  runId: Id,
  caseId: Id,
  arm: z.enum(['A', 'B', 'C']),
  assignmentId: z.uuid()
})
export const ReplayCallBindingSchema = AssignmentSchema.extend({
  tenantId: Id,
  accountId: Id,
  employeeId: Id,
  platform: z.enum(['wechat', 'wework']),
  executionPlanHash: Hash,
  snapshotHash: Hash,
  inputHash: Hash
})
export type ReplayCallBinding = z.infer<typeof ReplayCallBindingSchema>

/** The implementation must durably reserve every attempt before returning,
 * enforce shared account limits, and preserve unknown attempts after a crash.
 * An in-memory implementation is only suitable for protocol tests. */
export interface ReplayCallJournal {
  reserve(
    binding: ReplayCallBinding,
    stage: ModelStage,
    start: ModelCallStart
  ): Promise<ModelCallHandle>
  readAttempts(binding: ReplayCallBinding): Promise<ReplayAttempt[]>
}
export interface JevReplayProviderOptions {
  jevApiKey: string
  text: { apiKey: string; baseUrl: string; model: string; expectedModel: string }
  fetch?: typeof fetch
  now?: () => number
}

/** Wires the same production HTTP clients into the evaluation-only core.
 * This creates no leases, generation tasks, approvals or senders. It is not
 * an execution command; the caller must provide an authenticated durable journal. */
export function createJevReplayProviderFactory(
  source: AuthorizedReplaySource,
  options: JevReplayProviderOptions,
  journal: ReplayCallJournal
): (assignment: ReplayAssignment) => ReplayProviders {
  const frozen = structuredClone(source)
  const scope = ReplayCallBindingSchema.pick({
    tenantId: true,
    accountId: true,
    employeeId: true,
    platform: true
  }).parse(frozen.authenticatedScope)
  const publication = PublicationSchema.parse(frozen.publication)
  const plan = EvaluationPlanSchema.parse(frozen.plan)
  const version = textGeneratorVersion(options.text)
  if (
    frozen.snapshotHash !== evaluationSnapshotHash(publication) ||
    publication.textGeneratorVersion !== version ||
    plan.replayProtocol !== 'jev-abc-v1'
  )
    throw new ModelCallError('CONTEXT_UNAVAILABLE')
  if (
    !journal ||
    typeof journal.reserve !== 'function' ||
    typeof journal.readAttempts !== 'function'
  )
    throw new ModelCallError('RECORD_UNAVAILABLE')
  const now = options.now ?? Date.now
  const checkCurrent = (): void => {
    const at = now()
    if (
      !Number.isFinite(at) ||
      !Number.isFinite(frozen.createdAt.getTime()) ||
      !Number.isFinite(frozen.expiresAt.getTime()) ||
      at < frozen.createdAt.getTime() ||
      at >= frozen.expiresAt.getTime()
    )
      throw new ModelCallError('CONTEXT_UNAVAILABLE')
  }
  checkCurrent()
  const captured = { ...options, text: { ...options.text } }
  const createdAssignments = new Set<string>()
  return (rawAssignment) => {
    checkCurrent()
    const assignment = AssignmentSchema.parse(structuredClone(rawAssignment))
    const item = plan.assignments.find((a) => a.caseId === assignment.caseId)
    if (
      assignment.runId !== frozen.runId ||
      !item?.inputHash ||
      createdAssignments.has(assignment.assignmentId)
    )
      throw new ModelCallError('CONTEXT_UNAVAILABLE')
    const binding = ReplayCallBindingSchema.parse({
      ...assignment,
      ...scope,
      executionPlanHash: hashContext(plan),
      snapshotHash: frozen.snapshotHash,
      inputHash: item.inputHash
    })
    const context = new AsyncLocalStorage<ModelStage>()
    const reserve = async (start: ModelCallStart): Promise<ModelCallHandle> => {
      checkCurrent()
      const stage = context.getStore()
      if (
        !stage ||
        (stage === 'text') !== (start.provider === 'text') ||
        (assignment.arm === 'A' && stage !== 'text') ||
        (assignment.arm === 'B' && stage === 'post') ||
        start.requestedModel !==
          (stage === 'text' ? captured.text.model : publication.policy.modelAlias) ||
        (stage !== 'text' &&
          start.questionHash !== hashContext(stage === 'pre' ? preQuestions() : auditQuestions()))
      )
        throw new ModelCallError('CONTEXT_UNAVAILABLE')
      return journal.reserve(structuredClone(binding), stage, structuredClone(start))
    }
    const decision = new TypeSafeClient({
      apiKey: captured.jevApiKey,
      maxAttempts: 2,
      timeoutMs: Math.max(publication.policy.preBudgetMs, publication.policy.postBudgetMs),
      fetch: recordedTransport('jev', reserve, captured.fetch)
    })
    const generator = new HttpTextGenerator({
      ...captured.text,
      fetch: recordedTransport('text', reserve, captured.fetch, captured.text.expectedModel)
    })
    createdAssignments.add(assignment.assignmentId)
    return Object.freeze<ReplayProviders>({
      decision,
      generator,
      textGeneratorVersion: version,
      expectedTextModel: captured.text.expectedModel,
      now,
      assertAssignment: (actual: ReplayCallBinding) => {
        if (hashContext(ReplayCallBindingSchema.parse(actual)) !== hashContext(binding))
          throw new ModelCallError('CONTEXT_UNAVAILABLE')
      },
      modelCalls: {
        run: (rawStage, operation) => {
          const stage = ModelStageSchema.parse(rawStage)
          checkCurrent()
          return context.run(stage, operation)
        }
      },
      readAttempts: () => journal.readAttempts(structuredClone(binding))
    })
  }
}
