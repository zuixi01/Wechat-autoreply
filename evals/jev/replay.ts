import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { IdentitySchema, Id, type Identity } from '../../src/shared/contracts/identity'
import type { ReplyTask } from '../../src/shared/contracts/task'
import {
  parseJevResponse,
  type DecisionProvider,
  type JevResponse
} from '../../src/shared/contracts/decision'
import { hashContext, hashDraft } from '../../src/core/reply/hashes'
import { relevance } from '../../src/core/knowledge/retrieval'
import {
  JevReplyPipeline,
  assessPreDecision,
  preQuestions,
  auditQuestions,
  evidenceBelongsToTask,
  isExplicitHumanRequest,
  type DraftGenerator,
  type KnowledgeEvidence,
  type PipelineResult
} from '../../server/src/reply/jev-pipeline'
import { PublicationSchema } from '../../server/src/generation/publication'
import { EvaluationPlanSchema } from '../../server/src/admin/evaluation-admission'
import { evaluationSnapshotHash } from '../../server/src/generation/evaluation-authorization'
import { EMPTY_ENTERPRISE_MEMORY_VERSION } from '../../server/src/learning/learning-publication'
import {
  ModelCallStartSchema,
  ModelCallResultSchema,
  type ModelCallScope,
  type ModelStage
} from '../../server/src/generation/model-call-contracts'
import {
  ReplayCaseInputSchema,
  replayCaseInputHash,
  validateFrozenReplayInputs,
  type FrozenReplaySource,
  type ReplayCaseInput
} from './replay-input'

export const JEV_REPLAY_PROTOCOL = 'jev-abc-v1' as const
/** Fixed A treatment: start with the publication's allowed intents, retain each
 * intent having tenant/account/customer/version/time-scoped knowledge, and use
 * the same lexical-v1 top-three retrieval when enabled. Without lexical
 * retrieval every allowed intent with scoped evidence is supplied to text.
 * Text must cite every selected intent and exactly reproduce approved blocks.
 * B/C instead select intents through Jev. This intentional routing difference
 * can affect coverage; it is not an oracle or an independently labelled route.
 * Changing these rules requires a new frozen replay protocol/route version. */
export const JEV_BASELINE_ROUTE = 'automatic-intents-with-scoped-evidence-v1' as const
const IntentOrder = ['faq', 'price', 'order', 'aftersales', 'other'] as const
type Intent = (typeof IntentOrder)[number]
export type JevReplayArm = 'A' | 'B' | 'C'

const AuthenticatedScopeSchema = IdentitySchema.pick({
  tenantId: true,
  accountId: true,
  employeeId: true,
  platform: true
})
/** This scope must come from the authenticated database reader, not an input file. */
export interface AuthorizedReplaySource extends FrozenReplaySource {
  authenticatedScope: z.infer<typeof AuthenticatedScopeSchema>
}
export const ReplayAttemptSchema = z.strictObject({
  attemptId: Id,
  stage: z.enum(['pre', 'text', 'post']),
  start: ModelCallStartSchema,
  result: ModelCallResultSchema.nullable()
})
export type ReplayAttempt = z.infer<typeof ReplayAttemptSchema>
export interface ReplayProviders {
  decision: DecisionProvider
  generator: DraftGenerator
  textGeneratorVersion: string
  expectedTextModel: string
  /** Real HTTP factories verify this against their captured journal binding. */
  assertAssignment?: (binding: ReplayProviderBinding) => void
  now?: () => number
  /** Supply a private, durable recorder/budget context. HTTP retries must be
   * reserved by the clients' recordedTransport, not counted as one stage. */
  modelCalls?: ModelCallScope
  /** Actual attempts for this assignment only, including retries and failures. */
  readAttempts?: () => Promise<ReplayAttempt[]>
}
export interface ReplayAssignment {
  runId: string
  caseId: string
  arm: JevReplayArm
  assignmentId: string
}
export interface ReplayProviderBinding extends ReplayAssignment {
  tenantId: string
  accountId: string
  employeeId: string
  platform: Identity['platform']
  executionPlanHash: string
  snapshotHash: string
  inputHash: string
}
export interface JevReplayArmArtifact extends ReplayAssignment {
  protocol: typeof JEV_REPLAY_PROTOCOL
  baselineRoute: typeof JEV_BASELINE_ROUTE
  inputHash: string
  executionPlanHash: string
  snapshotHash: string
  status: PipelineResult['status']
  /** Experimental projection only. This object cannot be submitted to a sender. */
  wouldRelease: boolean
  releaseAuthorized: false
  factsVerified: boolean
  intents: string[]
  reasons: string[]
  draft: { text: string; evidenceIds: string[]; draftHash: string } | null
  pre: JevResponse | null
  post: JevResponse | null
  stages: { stage: ModelStage; durationMs: number; completed: boolean }[]
  latencyMs: number
  otherProcessingMs: number
  attempts: ReplayAttempt[] | null
  usage: { inputTokens: number; outputTokens: number } | null
  usageSource: 'recorded_http_attempts' | 'unknown'
  billedCostMicros: null
}

function selectEvidence(
  scoped: KnowledgeEvidence[],
  intents: Intent[],
  item: ReplayCaseInput,
  retrieval: 'lexical-v1' | undefined
): KnowledgeEvidence[] {
  if (!retrieval) return scoped
  const prior = (item.context ?? [])
    .filter((m) => m.direction === 'inbound' && m.kind === 'text')
    .slice(-3)
    .map((m) => m.text)
    .join('\n')
    .slice(-8000)
  return intents.flatMap((intent) =>
    scoped
      .filter((e) => e.intent === intent)
      .map((e) => ({
        e,
        score: Math.max(
          relevance(item.inbound.join('\n'), e.content),
          relevance(prior, e.content) * 0.35
        )
      }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((row) => row.e)
  )
}

/** No database writes, leases, approvals or senders. Each call starts its own
 * provider operations; raw drafts/responses/attempts are PRIVATE artifacts. */
export async function executeJevReplayArm(
  arm: JevReplayArm,
  input: { frozen: AuthorizedReplaySource; caseInput: ReplayCaseInput; identity: Identity },
  providers: ReplayProviders,
  external?: AbortSignal,
  assignmentId: string = randomUUID()
): Promise<JevReplayArmArtifact> {
  if (!['A', 'B', 'C'].includes(arm)) throw new Error('invalid_replay_arm')
  assignmentId = Id.parse(assignmentId)
  const frozen = structuredClone(input.frozen)
  const item = ReplayCaseInputSchema.parse(structuredClone(input.caseInput))
  const identity = IdentitySchema.parse(structuredClone(input.identity))
  const scope = AuthenticatedScopeSchema.parse(frozen.authenticatedScope)
  if (Object.entries(scope).some(([key, value]) => identity[key as keyof Identity] !== value))
    throw new Error('replay_identity_scope_mismatch')
  const p = PublicationSchema.parse(frozen.publication)
  frozen.plan = EvaluationPlanSchema.parse(frozen.plan)
  const expectedTextModel = Id.parse(providers.expectedTextModel)
  const now = providers.now ?? Date.now
  const at = now()
  if (frozen.expiresAt.getTime() <= at || at < frozen.createdAt.getTime())
    throw new Error('evaluation_run_expired_or_invalid')
  if (p.textGeneratorVersion !== providers.textGeneratorVersion)
    throw new Error('text_generator_changed')
  if (
    p.memoryManifest?.length ||
    (p.memoryCorpusVersion && p.memoryCorpusVersion !== EMPTY_ENTERPRISE_MEMORY_VERSION)
  )
    throw new Error('jev_replay_enterprise_memory_not_supported')
  // Single-arm calls enforce the same frozen hash/membership, without requiring
  // the caller to give this function all other private customer inputs.
  const planned = frozen.plan.assignments.find((a) => a.caseId === item.caseId)
  if (
    frozen.plan.replayProtocol !== JEV_REPLAY_PROTOCOL ||
    !planned ||
    planned.inputHash !== replayCaseInputHash(item) ||
    planned.conversationGroup !== item.conversationGroup ||
    planned.split !== item.split
  )
    throw new Error('replay_case_changed_or_unplanned')
  // The full source integrity check is shared with the batch preflight. Its
  // complete sample check is performed by replayFrozenJevCases before dispatch.
  if (frozen.snapshotHash !== evaluationSnapshotHash(p)) throw new Error('frozen_snapshot_invalid')
  providers.assertAssignment?.({
    runId: frozen.runId,
    caseId: item.caseId,
    arm,
    assignmentId,
    ...scope,
    executionPlanHash: hashContext(frozen.plan),
    snapshotHash: frozen.snapshotHash,
    inputHash: replayCaseInputHash(item)
  })
  // Preserve the original bytes in the frozen input hash, but normalize all
  // three model inputs exactly as the production C pipeline does.
  const modelItem = { ...item, inbound: item.inbound.map((text) => text.trim()) }
  const task: ReplyTask = {
    taskId: assignmentId,
    identity,
    conversationId: item.conversationId,
    bindingVersion: 1,
    conversationRevision: 1,
    runEpoch: 1,
    inboundRange: { from: 1, to: item.inbound.length },
    contextHash: hashContext(item),
    configVersion: p.configuration.configVersion,
    knowledgeVersion: p.configuration.knowledgeVersion,
    decisionPolicyVersion: p.policy.version,
    questionSetVersion: p.policy.questionSetVersion,
    createdAt: at,
    expiresAt: Math.min(at + 60000, frozen.expiresAt.getTime())
  }
  const current = (): boolean => !external?.aborted && now() < task.expiresAt
  const result: JevReplayArmArtifact = {
    runId: frozen.runId,
    caseId: item.caseId,
    arm,
    assignmentId,
    protocol: JEV_REPLAY_PROTOCOL,
    baselineRoute: JEV_BASELINE_ROUTE,
    inputHash: replayCaseInputHash(item),
    executionPlanHash: hashContext(frozen.plan),
    snapshotHash: frozen.snapshotHash,
    status: 'invalid',
    wouldRelease: false,
    releaseAuthorized: false,
    factsVerified: false,
    intents: [],
    reasons: [],
    draft: null,
    pre: null,
    post: null,
    stages: [],
    latencyMs: 0,
    otherProcessingMs: 0,
    attempts: null,
    usage: null,
    usageSource: 'unknown',
    billedCostMicros: null
  }
  const started = performance.now()
  const fail = (status: PipelineResult['status'], reason: string): void => {
    result.status = status
    result.reasons = [reason]
    result.wouldRelease = false
  }
  const stageScope: ModelCallScope = {
    run: async <T>(stage: ModelStage, operation: () => Promise<T>): Promise<T> => {
      if (!current()) throw new Error('replay_cancelled_or_expired')
      const stageStart = performance.now()
      const record = { stage, durationMs: 0, completed: false }
      result.stages.push(record)
      const budget =
        stage === 'pre' ? p.policy.preBudgetMs : stage === 'post' ? p.policy.postBudgetMs : 30000
      let interrupted = false
      let abort!: () => void
      let timer: ReturnType<typeof setTimeout>
      const stopped = new Promise<never>((_, reject) => {
        abort = () => {
          interrupted = true
          reject(new Error('replay_stage_timeout_or_cancelled'))
        }
        external?.addEventListener('abort', abort, { once: true })
        timer = setTimeout(abort, Math.max(1, Math.min(budget, task.expiresAt - now())))
      })
      const guarded = async (): Promise<T> => {
        if (interrupted || !current()) throw new Error('replay_cancelled_or_expired')
        return operation()
      }
      try {
        const call = providers.modelCalls ? providers.modelCalls.run(stage, guarded) : guarded()
        const value = await Promise.race([call, stopped])
        record.completed = true
        return value
      } finally {
        clearTimeout(timer!)
        external?.removeEventListener('abort', abort)
        record.durationMs = performance.now() - stageStart
      }
    }
  }
  const decision: DecisionProvider = {
    evaluate: async (request, options) => {
      const response = parseJevResponse(
        request,
        await providers.decision.evaluate(request, options)
      )
      if (request.questions.primary_intent) result.pre = structuredClone(response)
      else result.post = structuredClone(response)
      return response
    }
  }
  const bounded = async <T>(
    stage: ModelStage,
    budget: number,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> => {
    const timeout = new AbortController()
    const signal = external ? AbortSignal.any([external, timeout.signal]) : timeout.signal
    const duration = Math.min(budget, task.expiresAt - now())
    if (!current() || duration <= 0) throw new Error('replay_cancelled_or_expired')
    const timer = setTimeout(() => timeout.abort('model_timeout'), duration)
    let abort!: () => void
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('replay_stage_timeout_or_cancelled'))
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      return await stageScope.run(stage, () => Promise.race([operation(signal), interrupted]))
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }
  try {
    if (!current()) fail('cancelled', 'task_obsolete')
    else if (arm === 'C') {
      const assessed = await new JevReplyPipeline(decision, providers.generator, now).run(
        {
          task,
          inbound: modelItem.inbound,
          context: item.context,
          evidence: p.evidence,
          ...(p.retrieval ? { retrieval: p.retrieval } : {}),
          ...(p.replyRules ? { replyRules: p.replyRules } : {}),
          isCurrent: current,
          modelCalls: stageScope
        },
        p.policy,
        external
      )
      result.status = assessed.status
      result.wouldRelease = assessed.automaticAllowed && p.configuration.automaticEnabled
      result.factsVerified = assessed.factsVerified === true
      result.reasons = assessed.reasons
      if (assessed.status === 'candidate' && !p.configuration.automaticEnabled)
        result.reasons.push('automatic_disabled')
      result.intents = assessed.intents
      result.draft = assessed.draft
        ? {
            text: assessed.draft.text,
            evidenceIds: assessed.draft.evidenceIds,
            draftHash: assessed.draft.draftHash
          }
        : null
    } else if (isExplicitHumanRequest(modelItem.inbound)) fail('handoff', 'explicit_human_request')
    else {
      const scoped = p.evidence.filter((e) => evidenceBelongsToTask(e, task, now()))
      let intents: Intent[]
      if (arm === 'B') {
        const pre = await bounded('pre', p.policy.preBudgetMs, (signal) =>
          decision.evaluate(
            {
              model: p.policy.modelAlias,
              state: {
                untrusted_inbound: modelItem.inbound,
                ...(item.context ? { untrusted_conversation: item.context } : {})
              },
              questions: preQuestions()
            },
            { signal, deadlineMs: Math.min(task.expiresAt, now() + p.policy.preBudgetMs) }
          )
        )
        if (!current()) throw new Error('replay_cancelled_or_expired')
        const assessment = assessPreDecision(pre, p.policy)
        intents = assessment.intents
        result.intents = intents
        if (assessment.status !== 'allowed') {
          result.status = assessment.status
          result.reasons = assessment.reasons
          return await finish()
        }
      } else {
        // A's fixed baseline uses only configured automatic intents which have
        // in-scope retrieved evidence. It never sees human labels or Jev output.
        intents = IntentOrder.filter(
          (intent) =>
            p.policy.automaticIntents.includes(intent) &&
            selectEvidence(scoped, [intent], modelItem, p.retrieval).some(
              (e) => e.intent === intent
            )
        )
        result.intents = intents
      }
      const relevant = selectEvidence(scoped, intents, modelItem, p.retrieval)
      if (!intents.length || intents.some((intent) => !relevant.some((e) => e.intent === intent)))
        fail('handoff', 'evidence_missing')
      else {
        const generated = await bounded('text', 30000, (signal) =>
          providers.generator.generate(
            {
              identity,
              conversationId: item.conversationId,
              inbound: modelItem.inbound,
              ...(item.context ? { context: item.context } : {}),
              intents,
              evidence: relevant,
              ...(p.replyRules ? { replyRules: p.replyRules } : {})
            },
            signal
          )
        )
        if (!current()) throw new Error('replay_cancelled_or_expired')
        const draft = z
          .strictObject({
            text: z.string().trim().min(1).max(10000),
            evidenceIds: z.array(Id).min(1).max(100)
          })
          .parse(generated)
        const cited = relevant.filter((e) => draft.evidenceIds.includes(e.evidenceId))
        if (
          new Set(draft.evidenceIds).size !== draft.evidenceIds.length ||
          cited.length !== draft.evidenceIds.length ||
          intents.some((intent) => !cited.some((e) => e.intent === intent))
        )
          fail('invalid', 'evidence_reference_invalid')
        else if (cited.some((e) => now() >= e.expiresAt)) fail('invalid', 'evidence_expired')
        else {
          result.status = 'candidate'
          result.draft = { ...draft, draftHash: hashDraft(draft.text) }
          result.factsVerified =
            draft.text ===
            draft.evidenceIds
              .map((id) => cited.find((e) => e.evidenceId === id)!.content)
              .join('\n')
          if (!result.factsVerified) result.reasons.push('freeform_requires_human')
          if (p.policy.mode === 'shadow') result.reasons.push('shadow_mode')
          if (!p.policy.evaluationApproved) result.reasons.push('evaluation_not_approved')
          if (!p.configuration.automaticEnabled) result.reasons.push('automatic_disabled')
          result.wouldRelease = !result.reasons.length
        }
      }
    }
  } catch {
    fail(
      current() ? 'invalid' : 'cancelled',
      current() ? 'decision_or_generation_failed' : 'task_obsolete'
    )
  }
  return finish()

  async function finish(): Promise<JevReplayArmArtifact> {
    result.latencyMs = performance.now() - started
    result.otherProcessingMs = Math.max(
      0,
      result.latencyMs - result.stages.reduce((sum, s) => sum + s.durationMs, 0)
    )
    if (providers.readAttempts) {
      try {
        const attempts = z
          .array(ReplayAttemptSchema)
          .max(100)
          .parse(await providers.readAttempts())
        if (
          new Set(attempts.map((a) => a.attemptId)).size !== attempts.length ||
          attempts.some(
            (a) =>
              !result.stages.some((s) => s.stage === a.stage) ||
              (a.stage === 'text') !== (a.start.provider === 'text') ||
              (a.result?.outcome === 'response' &&
                a.result.actualModel !==
                  (a.stage === 'text' ? expectedTextModel : p.policy.modelResolved)) ||
              (a.stage !== 'text' && a.start.requestedModel !== p.policy.modelAlias) ||
              (a.stage !== 'text' &&
                a.start.questionHash !==
                  hashContext(a.stage === 'pre' ? preQuestions() : auditQuestions()))
          )
        )
          throw new Error('attempt_scope_invalid')
        result.attempts = attempts
        if (attempts.some((a) => a.result === null)) {
          result.status = 'invalid'
          result.wouldRelease = false
          result.reasons.push('attempt_result_unknown')
        }
        if (
          result.stages.every((s) => attempts.some((a) => a.stage === s.stage)) &&
          attempts.every((a) => a.result?.usage !== undefined)
        ) {
          const usage = attempts.reduce(
            (usage, a) => ({
              inputTokens: usage.inputTokens + a.result!.usage!.inputTokens,
              outputTokens: usage.outputTokens + a.result!.usage!.outputTokens
            }),
            { inputTokens: 0, outputTokens: 0 }
          )
          if (Number.isSafeInteger(usage.inputTokens) && Number.isSafeInteger(usage.outputTokens)) {
            result.usage = usage
            result.usageSource = 'recorded_http_attempts'
          }
        }
        if (result.usageSource === 'unknown') result.reasons.push('usage_records_incomplete')
      } catch {
        result.wouldRelease = false
        result.status = 'invalid'
        result.reasons.push('attempt_records_unavailable')
      }
    }
    return structuredClone(result)
  }
}

export async function replayFrozenJevCases(
  input: { frozen: AuthorizedReplaySource; rawCases: unknown; identity: Identity },
  createProviders: (assignment: ReplayAssignment) => ReplayProviders | Promise<ReplayProviders>,
  options: {
    textGeneratorVersion: string
    signal?: AbortSignal
    onArm?: (artifact: JevReplayArmArtifact) => Promise<void>
  }
): Promise<JevReplayArmArtifact[]> {
  const frozen = structuredClone(input.frozen)
  const scope = AuthenticatedScopeSchema.parse(frozen.authenticatedScope)
  const identity = IdentitySchema.parse(structuredClone(input.identity))
  if (Object.entries(scope).some(([key, value]) => identity[key as keyof Identity] !== value))
    throw new Error('replay_identity_scope_mismatch')
  const { input: cases } = validateFrozenReplayInputs(
    frozen,
    input.rawCases,
    options.textGeneratorVersion
  )
  const artifacts: JevReplayArmArtifact[] = []
  for (const item of cases.cases) {
    for (const arm of ['A', 'B', 'C'] as const) {
      if (options.signal?.aborted) throw new Error('replay_cancelled')
      const assignment = {
        runId: frozen.runId,
        caseId: item.caseId,
        arm,
        assignmentId: randomUUID()
      }
      const providers = await createProviders(assignment)
      const artifact = await executeJevReplayArm(
        arm,
        { frozen, caseInput: item, identity },
        providers,
        options.signal,
        assignment.assignmentId
      )
      artifacts.push(artifact)
      if (options.onArm) await options.onArm(artifact)
      if (artifact.status === 'invalid' || artifact.status === 'cancelled')
        throw new Error('replay_arm_incomplete')
    }
  }
  return artifacts
}
