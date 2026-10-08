import { randomInt, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { deploymentVersion } from '../../../evals/memory/deployment'
import type { PoolClient } from 'pg'
import type { Postgres } from '../database/postgres'
import type { Scope } from '../auth/account-authority'
import { withLearningAccount, type LearningAccountAuthority } from './learning-account'
import { loadPublication, PublicationSchema } from '../generation/publication'
import { HttpTextGenerator, textGeneratorVersion } from '../generation/text-generator'
import { TypeSafeClient } from '../decision/typesafe-client'
import { JevReplyPipeline, type PipelineResult } from '../reply/jev-pipeline'
import {
  parseForegroundEvaluationInput,
  foregroundHostOperation
} from './learning-foreground-binding'
import { hashContext } from '../../../src/core/reply/hashes'
import { learningHash } from '../../../src/core/memory/learning-scope'
import { buildMemorySection } from '../../../src/core/ai-client'
import { ReplyTaskSchema, type ReplyTask } from '../../../src/shared/contracts/task'
import { ConversationContextSchema } from '../../../src/shared/contracts/context'
import { Id, Hash } from '../../../src/shared/contracts/identity'
import {
  LearningEvaluationDatasetSchema,
  LEARNING_EVALUATION_MAX_CASES,
  type LearningEvaluationDataset
} from '../../../src/shared/contracts/learning-evaluation'
import {
  LearningEpisodeSchema,
  MemoryContentSchema,
  MemoryEvidenceSchema,
  MemoryScopeSchema
} from '../../../src/shared/contracts/learning-memory'
import {
  MemoryReplayInputSchema,
  MemoryReplayReceiptSchema,
  MemoryReplayPacketSchema,
  adjudicateReplayEvidence
} from '../../../evals/memory/replay'
import {
  captureEnterpriseLearningReplayState,
  selectEnterpriseLearningContext,
  renderEnterpriseLearningReference,
  type EnterpriseGenerationContext
} from './learning-generation-context'
import {
  EnterpriseLearningValidationBudget,
  createEnterpriseValidationFetch,
  type EnterpriseValidationRun,
  type EnterpriseValidationAdmissionGuard
} from './learning-validation-budget'
import {
  EnterpriseEvaluationCheckpoint,
  type EvaluationAssignment,
  type EvaluationCheckpointSnapshot
} from './learning-evaluation-checkpoint'

const category = MemoryReplayInputSchema.shape.cases.element.shape.category
const natural = z.number().int().nonnegative().safe()
export const EnterpriseMemoryReplayInputSchema = z
  .strictObject({
    version: z.literal(1),
    datasetId: Id,
    origin: MemoryReplayInputSchema.shape.origin,
    rubricRef: Id,
    maxRequests: z.number().int().min(1).max(18000),
    backgroundCostUsd: z.number().finite().nonnegative(),
    legacy: MemoryReplayInputSchema.shape.legacy,
    sources: MemoryReplayInputSchema.shape.sources,
    cases: z
      .array(
        z.strictObject({
          caseId: Id,
          conversationId: Id,
          category,
          inbound: z.array(z.string().min(1).max(8000)).min(1).max(30),
          context: ConversationContextSchema.optional()
        })
      )
      .min(1)
      .max(2000)
  })
  .superRefine((input, ctx) => {
    const fail = (message: string): void => {
      ctx.addIssue({ code: 'custom', message })
    }
    const ids = [...input.sources, ...input.cases].map((c) => c.caseId)
    if (ids.length > LEARNING_EVALUATION_MAX_CASES) fail('dataset_case_limit_exceeded')
    if (new Set(ids).size !== ids.length) fail('duplicate_case_id')
    if (input.sources.some((s) => s.split === 'evaluate')) fail('holdout_cannot_be_source')
    const splits = new Map<string, string>()
    for (const item of [
      ...input.sources,
      ...input.cases.map((c) => ({ ...c, split: 'evaluate' }))
    ]) {
      if (splits.has(item.conversationId) && splits.get(item.conversationId) !== item.split)
        fail('conversation_split_overlap')
      splits.set(item.conversationId, item.split)
    }
    if (input.cases.length * 9 > input.maxRequests) fail('request_budget_exceeded')
    if (
      new TextEncoder().encode(
        buildMemorySection(input.legacy.map((c, i) => ({ ...c, cardId: String(i) })))
      ).length > 2000
    )
      fail('legacy_context_over_budget')
  })
type ReplayInput = z.infer<typeof EnterpriseMemoryReplayInputSchema>
const model = z.strictObject({ baseUrl: z.string().url(), model: Id, expectedModel: Id })
const method = z.strictObject({
  id: Id,
  revision: z.number().int().positive().safe(),
  contentHash: Hash,
  content: MemoryContentSchema,
  evidence: z.array(MemoryEvidenceSchema).min(1).max(100),
  scope: MemoryScopeSchema,
  expiresAt: natural.optional()
})
const frame = z.strictObject({
  caseId: Id,
  task: ReplyTaskSchema,
  stateHash: Hash,
  context: z.strictObject({
    text: z.string().max(2000),
    estimatedTokens: natural.max(2000),
    methodRefs: z.array(method.pick({ id: true, revision: true, contentHash: true })).max(5),
    caseIds: z.array(Id).max(3)
  })
})
export const EnterpriseMemoryReplayPacketSchema = z.strictObject({
  schema: z.literal('autoreply-enterprise-memory-replay-v1'),
  input: EnterpriseMemoryReplayInputSchema,
  publication: PublicationSchema,
  model,
  methods: z.array(method).max(10000),
  episodes: z.array(LearningEpisodeSchema).max(6000),
  frames: z.array(frame).min(1).max(2000),
  frozen: LearningEvaluationDatasetSchema.shape.frozen,
  receipts: z.array(MemoryReplayReceiptSchema).min(3).max(6000),
  blind: MemoryReplayPacketSchema.shape.blind
})
export type EnterpriseMemoryReplayPacket = z.infer<typeof EnterpriseMemoryReplayPacketSchema>
const BasisSchema = EnterpriseMemoryReplayPacketSchema.pick({
  input: true,
  publication: true,
  model: true,
  methods: true,
  episodes: true,
  frames: true
})
export interface EnterpriseMemoryReplayOptions {
  text: { apiKey: string; baseUrl: string; model: string; expectedModel: string }
  jevApiKey: string
  workerId: string
  fetch?: typeof fetch
  monitorIntervalMs?: number
  onRun?: (runId: string) => Promise<void>
  /** Trusted main-host rendezvous, never an HTTP/renderer authority claim. */
  foregroundTask?: (
    assignment: EnterpriseForegroundAssignment,
    signal: AbortSignal
  ) => Promise<unknown>
  foregroundResult?: (
    assignment: EnterpriseForegroundAssignment & { result: PipelineResult },
    signal: AbortSignal
  ) => Promise<void>
  /** Host-only controlled clock for engineering UTC-boundary tests. Production uses DB time. */
  now?: () => number
}
export interface EnterpriseForegroundAssignment {
  runId: string
  scope: Scope
  assignment: EvaluationAssignment
  frozen: EnterpriseMemoryReplayPacket['frozen']
  task: ReplyTask
  item: ReplayInput['cases'][number]
}
function blindQuestion(item: ReplayInput['cases'][number]): string {
  return item.context
    ? JSON.stringify({ context: item.context, inbound: item.inbound })
    : item.inbound.join('\n')
}
function taskFor(
  scope: Scope,
  publication: z.infer<typeof PublicationSchema>,
  item: ReplayInput['cases'][number],
  clientId: string,
  timeout: number,
  clock: () => number = Date.now
): ReplyTask {
  const now = clock()
  return ReplyTaskSchema.parse({
    taskId: randomUUID(),
    identity: {
      tenantId: scope.tenant_id,
      employeeId: scope.employee_id,
      accountId: scope.account_id,
      agentId: scope.agent_id,
      platform: scope.platform,
      loginEpoch: 0,
      clientInstanceId: clientId
    },
    conversationId: item.conversationId,
    bindingVersion: 1,
    conversationRevision: 1,
    runEpoch: 1,
    inboundRange: { from: 1, to: item.inbound.length },
    contextHash: hashContext({ inbound: item.inbound, context: item.context }),
    configVersion: publication.configuration.configVersion,
    knowledgeVersion: publication.configuration.knowledgeVersion,
    decisionPolicyVersion: publication.policy.version,
    questionSetVersion: publication.policy.questionSetVersion,
    createdAt: now,
    expiresAt: now + timeout + publication.policy.preBudgetMs + publication.policy.postBudgetMs
  })
}
function deployedVersions(
  packet: Pick<EnterpriseMemoryReplayPacket, 'publication' | 'model'>
): Pick<EnterpriseMemoryReplayPacket['frozen'], 'policyVersion' | 'retrievalVersion'> {
  const policyVersion = learningHash({
    policy: packet.publication.policy,
    generator: textGeneratorVersion(packet.model),
    implementation: implementationHash([
      '../reply/jev-pipeline',
      '../decision/typesafe-client',
      '../generation/text-generator',
      '../generation/model-call-transport',
      '../../../src/shared/contracts/decision',
      '../../../src/core/ai-client',
      '../../../evals/memory/deployment',
      './learning-memory-replay',
      './learning-evaluation-checkpoint',
      './learning-foreground-binding',
      './learning-validation-budget'
    ])
  })
  const retrievalVersion = learningHash({
    retrieval: packet.publication.retrieval,
    implementation: implementationHash([
      './learning-generation-context',
      './learning-publication',
      '../../../src/core/memory/learning-retrieval',
      '../../../src/core/memory/learning-episodes',
      '../../../src/core/knowledge/retrieval',
      '../../../evals/memory/deployment'
    ])
  })
  return { policyVersion, retrievalVersion }
}
function frozenMetadata(
  packet: Pick<
    EnterpriseMemoryReplayPacket,
    'input' | 'publication' | 'model' | 'methods' | 'episodes' | 'frames'
  >,
  frozenAt: number
): EnterpriseMemoryReplayPacket['frozen'] {
  const { policyVersion, retrievalVersion } = deployedVersions(packet)
  return {
    frozenAt,
    policyVersion,
    retrievalVersion,
    knowledgeVersion: packet.publication.configuration.knowledgeVersion,
    modelVersion: learningHash({
      jev: packet.publication.policy.modelResolved,
      text: packet.model.expectedModel
    }),
    backgroundCostUsd: packet.input.backgroundCostUsd,
    latencyScope: 'enterprise_pipeline',
    sharedConfigurationHash: learningHash({
      publication: packet.publication,
      model: packet.model,
      policyVersion,
      retrievalVersion
    }),
    noMemoryManifestHash: learningHash([]),
    staticMemoryManifestHash: learningHash(packet.input.legacy),
    learnedMemoryManifestHash: learningHash({
      methods: packet.methods,
      episodes: packet.episodes,
      frames: packet.frames.map((f) => ({
        caseId: f.caseId,
        stateHash: f.stateHash,
        context: f.context
      }))
    }),
    methods: packet.methods.map((m) => ({
      id: m.id,
      revision: m.revision,
      contentHash: m.contentHash,
      sourceCaseIds: m.evidence.map((e) => e.episodeId)
    }))
  }
}

/** Hash deployed files, not transpiler-specific Function.toString output. Both collecting and
 * importing processes must run the same deployment. Missing files fail closed. */
function implementationHash(modules: string[]): string {
  return deploymentVersion(import.meta.url, modules)
}

/** Trusted worker only. Production Jev/text/audit and retrieval, but no GenerationService, episode
 * recorder, activation store or ExecutionAuthority. Evaluation holds the shared background slot. */
export class EnterpriseMemoryReplay {
  private readonly budget: EnterpriseLearningValidationBudget
  private readonly checkpoints: EnterpriseEvaluationCheckpoint
  private readonly options: EnterpriseMemoryReplayOptions
  constructor(
    database: Postgres,
    private readonly authority: LearningAccountAuthority,
    options: EnterpriseMemoryReplayOptions
  ) {
    new HttpTextGenerator(options.text)
    new TypeSafeClient({ apiKey: options.jevApiKey, maxAttempts: 1 })
    Id.parse(options.workerId)
    this.options = { ...options, text: structuredClone(options.text) }
    this.budget = new EnterpriseLearningValidationBudget(database, authority, { now: options.now })
    this.checkpoints = new EnterpriseEvaluationCheckpoint(authority, this.budget, options.now)
  }
  drain(): Promise<void> {
    return this.budget.drain()
  }
  async collect(
    reference: string,
    raw: unknown,
    external?: AbortSignal,
    onReceipt?: (record: EnterpriseMemoryReplayPacket['receipts'][number]) => Promise<void>
  ): Promise<EnterpriseMemoryReplayPacket> {
    return this.execute(reference, raw, undefined, external, onReceipt)
  }
  async resume(
    reference: string,
    runId: string,
    external?: AbortSignal,
    onReceipt?: (record: EnterpriseMemoryReplayPacket['receipts'][number]) => Promise<void>
  ): Promise<EnterpriseMemoryReplayPacket> {
    return this.execute(reference, undefined, z.uuid().parse(runId), external, onReceipt)
  }
  private async validateResumeWithin(
    snapshot: EvaluationCheckpointSnapshot,
    client: PoolClient,
    scope: Scope,
    at: number,
    signal: AbortSignal
  ): Promise<void> {
    const basis = BasisSchema.parse(snapshot.basis),
      frozen = EnterpriseMemoryReplayPacketSchema.shape.frozen.parse(snapshot.frozen)
    if (signal.aborted) throw new Error('evaluation_cancelled')
    if (
      learningHash(frozenMetadata(basis, frozen.frozenAt)) !== learningHash(frozen) ||
      learningHash(basis.model) !==
        learningHash(
          model.parse({
            baseUrl: this.options.text.baseUrl,
            model: this.options.text.model,
            expectedModel: this.options.text.expectedModel
          })
        ) ||
      learningHash(scope) !== learningHash(snapshot.scope) ||
      learningHash(await loadPublication(client, scope)) !== learningHash(basis.publication) ||
      basis.publication.evidence.some((e) => e.expiresAt <= at)
    )
      throw new Error('evaluation_environment_changed')
    if (
      snapshot.assignments.length !== basis.input.cases.length * 3 ||
      basis.frames.length !== basis.input.cases.length ||
      new Set(basis.frames.map((f) => f.caseId)).size !== basis.frames.length
    )
      throw new Error('evaluation_checkpoint_basis_conflict')
    for (const item of basis.input.cases) {
      const captured = basis.frames.find((f) => f.caseId === item.caseId)
      const assigned = snapshot.assignments.filter((a) => a.caseId === item.caseId)
      if (
        !captured ||
        new Set(assigned.map((a) => a.arm)).size !== 3 ||
        assigned.length !== 3 ||
        learningHash(await captureEnterpriseLearningReplayState(client, scope, captured.task)) !==
          captured.stateHash
      )
        throw new Error('evaluation_environment_changed')
    }
  }
  private async execute(
    reference: string,
    raw: unknown,
    resumeId: string | undefined,
    external?: AbortSignal,
    onReceipt?: (record: EnterpriseMemoryReplayPacket['receipts'][number]) => Promise<void>
  ): Promise<EnterpriseMemoryReplayPacket> {
    const controller = new AbortController(),
      signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal
    let run: EnterpriseValidationRun | undefined,
      monitor: ReturnType<typeof setInterval> | undefined,
      checking = false
    let active:
      | { item: ReplayInput['cases'][number]; task: ReplyTask; stateHash: string }
      | undefined
    let executingAssignment: EvaluationAssignment | undefined
    let budgetExhausted = false
    let measuring: { assignmentId: string; started: number } | undefined
    try {
      const recovered = resumeId
        ? await this.checkpoints.claim(
            reference,
            resumeId,
            this.options.workerId,
            (snapshot, client, scope, at) =>
              this.validateResumeWithin(snapshot, client, scope, at, signal)
          )
        : undefined
      const input = recovered
        ? BasisSchema.parse(recovered.snapshot.basis).input
        : EnterpriseMemoryReplayInputSchema.parse(raw)
      const basis = recovered
        ? { scope: recovered.snapshot.scope, ...recovered.snapshot.basis }
        : await withLearningAccount(this.authority, reference, null, async (client, scope) => {
            const publication = await loadPublication(client, scope)
            if (publication.textGeneratorVersion !== textGeneratorVersion(this.options.text))
              throw new Error('evaluation_reply_model_changed')
            const frames: EnterpriseMemoryReplayPacket['frames'] = [],
              methods = new Map<string, z.infer<typeof method>>(),
              episodes = new Map<string, z.infer<typeof LearningEpisodeSchema>>()
            for (const item of input.cases) {
              const task = taskFor(scope, publication, item, randomUUID(), 30000, this.options.now)
              const state = await captureEnterpriseLearningReplayState(client, scope, task)
              const context = selectEnterpriseLearningContext(state, item.inbound.join('\n'))
              frames.push({ caseId: item.caseId, task, stateHash: learningHash(state), context })
              for (const ref of context.methodRefs)
                methods.set(ref.id, state.methods.find((m) => m.id === ref.id)!)
              for (const id of context.caseIds)
                episodes.set(id, state.cases.find((e) => e.id === id)!)
            }
            const declared = new Map(input.sources.map((s) => [s.caseId, s]))
            const sourceIds = [
              ...new Set(
                [...methods.values()]
                  .flatMap((m) => m.evidence.map((e) => e.episodeId))
                  .concat([...episodes.keys()])
              )
            ]
            if (!methods.size) throw new Error('evaluation_no_active_methods')
            const sources = (
              await client.query(
                'SELECT id::text,conversation_id FROM learning_episodes WHERE tenant_id=$1 AND account_id=$2 AND id=ANY($3::uuid[])',
                [scope.tenant_id, scope.account_id, sourceIds]
              )
            ).rows
            if (
              sources.length !== sourceIds.length ||
              sources.some(
                (s) =>
                  declared.get(String(s.id))?.split !== 'learn' ||
                  declared.get(String(s.id))?.conversationId !==
                    (String(s.conversation_id ?? '') || 'account')
              )
            )
              throw new Error('evaluation_source_not_in_learn_split')
            return {
              scope,
              publication,
              frames,
              methods: [...methods.values()].sort((a, b) => a.id.localeCompare(b.id)),
              episodes: [...episodes.values()].sort((a, b) => a.id.localeCompare(b.id))
            }
          })
      const privateBasis = recovered
        ? recovered.snapshot.basis
        : {
            input,
            publication: basis.publication,
            model: model.parse({
              baseUrl: this.options.text.baseUrl,
              model: this.options.text.model,
              expectedModel: this.options.text.expectedModel
            }),
            methods: basis.methods,
            episodes: basis.episodes,
            frames: basis.frames
          }
      // Keys are host-only; strict public model metadata intentionally omits the credential.
      const frozen = recovered
        ? recovered.snapshot.frozen
        : frozenMetadata(privateBasis, this.options.now?.() ?? Date.now())
      if (input.sources.some((s) => s.label.labelledAt > frozen.frozenAt))
        throw new Error('source_label_after_freeze')
      if (Buffer.byteLength(JSON.stringify(privateBasis)) > 32 * 1024 * 1024)
        throw new Error('evaluation_basis_too_large')
      const source =
        'holdout:' +
        learningHash({
          input,
          publication: basis.publication,
          model: privateBasis.model,
          configurationHash: frozen.sharedConfigurationHash,
          frames: basis.frames.map((f) => ({ caseId: f.caseId, stateHash: f.stateHash }))
        })
      const assignments: EvaluationAssignment[] = recovered ? recovered.snapshot.assignments : []
      for (const item of recovered ? [] : input.cases) {
        const order: EvaluationAssignment['arm'][] = ['none', 'baseline', 'learned']
        for (let i = 2; i > 0; i--) {
          const j = randomInt(i + 1)
          ;[order[i], order[j]] = [order[j], order[i]]
        }
        for (const arm of order)
          assignments.push({
            ordinal: assignments.length,
            assignmentId: randomUUID(),
            caseId: item.caseId,
            arm
          })
      }
      if (recovered && !recovered.run)
        return EnterpriseMemoryReplayPacketSchema.parse({
          schema: 'autoreply-enterprise-memory-replay-v1',
          ...privateBasis,
          frozen,
          receipts: recovered.snapshot.receipts,
          blind: recovered.snapshot.receipts.map((r) => {
            const item = input.cases.find((c) => c.caseId === r.caseId)!
            return {
              assignmentId: r.assignmentId,
              caseId: r.caseId,
              category: item.category,
              question: blindQuestion(item),
              reply: r.reply
            }
          })
        })
      run =
        recovered?.run ??
        (await this.budget.begin(
          reference,
          null,
          source,
          this.options.workerId,
          input.cases.length * 9,
          'evaluation'
        ))
      const claim = run
      const assertFrozen = async (client: PoolClient, scope: Scope): Promise<void> => {
        if (signal.aborted) throw new Error('evaluation_cancelled')
        if (!active) throw new Error('evaluation_case_missing')
        const versions = deployedVersions(privateBasis)
        if (
          versions.policyVersion !== frozen.policyVersion ||
          versions.retrievalVersion !== frozen.retrievalVersion ||
          learningHash(scope) !== learningHash(basis.scope) ||
          basis.publication.evidence.some(
            (e) => e.expiresAt <= (this.options.now?.() ?? Date.now())
          ) ||
          learningHash(await loadPublication(client, scope)) !== learningHash(basis.publication) ||
          learningHash(await captureEnterpriseLearningReplayState(client, scope, active.task)) !==
            active.stateHash
        )
          throw new Error('evaluation_environment_changed')
      }
      if (!recovered)
        await this.checkpoints.create(
          reference,
          claim,
          privateBasis,
          frozen,
          assignments,
          async (client, scope) => {
            for (const captured of basis.frames) {
              const item = input.cases.find((c) => c.caseId === captured.caseId)!
              active = { item, task: captured.task, stateHash: captured.stateHash }
              await assertFrozen(client, scope)
            }
          }
        )
      await this.options.onRun?.(claim.id)
      const guard: EnterpriseValidationAdmissionGuard = async (client, scope, at) => {
        await assertFrozen(client, scope)
        await this.checkpoints.assertRequestBudgetWithin(client, scope, claim, at)
        if (!active || !executingAssignment)
          throw new Error('evaluation_checkpoint_execution_conflict')
        await this.checkpoints.recordExecutionTaskWithin(
          client,
          scope,
          claim,
          executingAssignment,
          active.task,
          at
        )
      }
      const generator = new HttpTextGenerator({
        ...this.options.text,
        timeoutMs: claim.timeoutMs,
        fetch: createEnterpriseValidationFetch(
          'text',
          this.budget,
          reference,
          claim,
          this.options.fetch,
          this.options.text.expectedModel,
          guard,
          () => {
            budgetExhausted = true
          }
        )
      })
      const decision = new TypeSafeClient({
        apiKey: this.options.jevApiKey,
        timeoutMs: claim.timeoutMs,
        maxAttempts: 1,
        fetch: createEnterpriseValidationFetch(
          'jev',
          this.budget,
          reference,
          claim,
          this.options.fetch,
          undefined,
          guard,
          () => {
            budgetExhausted = true
          }
        )
      })
      const pipeline = new JevReplyPipeline(decision, generator, this.options.now)
      const receipts: EnterpriseMemoryReplayPacket['receipts'] = recovered?.snapshot.receipts ?? [],
        blind: EnterpriseMemoryReplayPacket['blind'] = receipts.map((r) => {
          const item = input.cases.find((c) => c.caseId === r.caseId)!
          return {
            assignmentId: r.assignmentId,
            caseId: r.caseId,
            category: item.category,
            question: blindQuestion(item),
            reply: r.reply
          }
        })
      const readCalls = async (
        assignmentId?: string
      ): Promise<
        { claim_token: string; input_tokens: number; output_tokens: number; measurement: string }[]
      > =>
        withLearningAccount(
          this.authority,
          reference,
          null,
          async (client, scope) =>
            (
              await client.query(
                'SELECT claim_token::text,input_tokens,output_tokens,measurement FROM learning_attempts WHERE tenant_id=$1 AND account_id=$2 AND validation_run_id=$3 AND ($4::uuid IS NULL OR claim_token IN (SELECT unnest(model_call_refs) FROM learning_evaluation_stages WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3 AND assignment_id=$4)) ORDER BY created_at,claim_token',
                [scope.tenant_id, scope.account_id, claim.id, assignmentId ?? null]
              )
            ).rows
        )
      monitor = setInterval(
        () => {
          if (checking || signal.aborted || !active) return
          checking = true
          void this.budget.trackRequest(
            withLearningAccount(
              this.authority,
              reference,
              null,
              async (client, scope, _conversation, at) => {
                await this.budget.assertCurrentWithin(client, scope, claim, at)
                await assertFrozen(client, scope)
              },
              this.options.now
            )
              .catch(() => controller.abort('evaluation_environment_changed'))
              .finally(() => {
                checking = false
              })
          )
        },
        z
          .number()
          .int()
          .min(1)
          .max(1000)
          .parse(this.options.monitorIntervalMs ?? 500)
      )
      monitor.unref()
      for (const assignment of assignments.slice(receipts.length)) {
        const item = input.cases.find((c) => c.caseId === assignment.caseId)!
        const captured = basis.frames.find((f) => f.caseId === item.caseId)!
        const arm = assignment.arm
        const started = performance.now()
        measuring = { assignmentId: assignment.assignmentId, started }
        const priorTiming = await this.checkpoints.start(reference, claim, assignment)
        let task = taskFor(
          basis.scope,
          basis.publication,
          item,
          claim.id,
          claim.timeoutMs,
          this.options.now
        )
        let generationContext = item.context
        active = { item, task, stateHash: captured.stateHash }
        executingAssignment = assignment
        const foreground = (): EnterpriseForegroundAssignment =>
          structuredClone({
            runId: claim.id,
            scope: basis.scope,
            assignment,
            frozen,
            task,
            item
          })
        if (this.options.foregroundTask) {
          const supplied = await foregroundHostOperation(
            () => this.options.foregroundTask!(foreground(), signal),
            signal,
            claim.timeoutMs
          )
          const foregroundInput = parseForegroundEvaluationInput(
            supplied,
            basis.scope,
            basis.publication,
            item,
            this.options.now?.() ?? Date.now()
          )
          task = foregroundInput.task
          generationContext = foregroundInput.context
          active = { item, task, stateHash: captured.stateHash }
          await withLearningAccount(this.authority, reference, null, assertFrozen)
        }
        const context = await withLearningAccount(
          this.authority,
          reference,
          item.conversationId,
          async (client, scope) => {
            await assertFrozen(client, scope)
            const current = await captureEnterpriseLearningReplayState(client, scope, task)
            return arm === 'learned'
              ? selectEnterpriseLearningContext(current, item.inbound.join('\n'))
              : ({
                  text: '',
                  methodRefs: [],
                  caseIds: [],
                  estimatedTokens: 0
                } satisfies EnterpriseGenerationContext)
          }
        )
        const processReference =
          arm === 'baseline'
            ? buildMemorySection(input.legacy.map((c, i) => ({ ...c, cardId: String(i) })))
            : context.text
        const result = await pipeline.run(
          {
            task,
            inbound: item.inbound,
            context: generationContext,
            evidence: basis.publication.evidence,
            retrieval: basis.publication.retrieval,
            replyRules: basis.publication.replyRules,
            processReference,
            isCurrent: () => !signal.aborted,
            modelCalls: {
              run: async <T>(
                stage: 'pre' | 'text' | 'post',
                operation: () => Promise<T>
              ): Promise<T> => {
                await withLearningAccount(
                  this.authority,
                  reference,
                  null,
                  assertFrozen,
                  this.options.now
                )
                const saved = await this.checkpoints.stage(reference, claim, assignment, stage)
                if (saved !== undefined) return structuredClone(saved) as T
                const previous = new Set((await readCalls()).map((r) => String(r.claim_token)))
                const value = await operation()
                const refs = (await readCalls())
                  .filter((r) => !previous.has(String(r.claim_token)))
                  .map((r) => String(r.claim_token))
                await this.checkpoints.saveStage(
                  reference,
                  claim,
                  assignment,
                  stage,
                  value,
                  refs,
                  assertFrozen,
                  task
                )
                return value
              }
            }
          },
          basis.publication.policy,
          signal
        )
        if (budgetExhausted) throw new Error('evaluation_budget_waiting')
        if (signal.aborted || result.status === 'cancelled') throw new Error('evaluation_cancelled')
        if (result.reasons.includes('decision_or_generation_failed'))
          throw new Error('evaluation_replay_unavailable')
        await withLearningAccount(this.authority, reference, null, assertFrozen)
        const calls = await readCalls(assignment.assignmentId)
        if (
          calls.length === 0 &&
          !(result.status === 'handoff' && result.reasons.includes('explicit_human_request'))
        )
          throw new Error('evaluation_missing_model_calls')
        const measured = calls.every((r) => r.measurement === 'reported')
        const executionTaskHashes = [
          ...new Set([
            ...(await this.checkpoints.executionHashes(reference, claim, assignment)),
            hashContext(task)
          ])
        ].sort()
        const record = MemoryReplayReceiptSchema.parse({
          assignmentId: assignment.assignmentId,
          caseId: item.caseId,
          arm,
          reply: result.draft?.text ?? null,
          generatedAt: this.options.now?.() ?? Date.now(),
          latencyMs: priorTiming.activeMs + performance.now() - started,
          latencyComplete: priorTiming.timingComplete && executionTaskHashes.length === 1,
          executionTaskHashes,
          inputTokens: measured ? calls.reduce((n, r) => n + Number(r.input_tokens), 0) : null,
          outputTokens: measured ? calls.reduce((n, r) => n + Number(r.output_tokens), 0) : null,
          costUsd: null,
          configurationHash: frozen.sharedConfigurationHash,
          memoryManifestHash:
            arm === 'none'
              ? frozen.noMemoryManifestHash
              : arm === 'baseline'
                ? frozen.staticMemoryManifestHash
                : frozen.learnedMemoryManifestHash,
          loadedMethodRefs: context.methodRefs,
          loadedCaseRefs: context.caseIds.map((id) => ({
            id,
            hash: learningHash(basis.episodes.find((e) => e.id === id)!)
          })),
          modelCallRefs: calls.map((r) => String(r.claim_token)),
          pipelineStatus: result.status,
          pipelineReasons: result.reasons
        })
        await this.checkpoints.finish(reference, claim, assignment, record, task)
        measuring = undefined
        receipts.push(record)
        blind.push({
          assignmentId: record.assignmentId,
          caseId: item.caseId,
          category: item.category,
          question: blindQuestion(item),
          reply: record.reply
        })
        await onReceipt?.(structuredClone(record))
        if (this.options.foregroundResult)
          await foregroundHostOperation(
            () =>
              this.options.foregroundResult!(
                { ...foreground(), result: structuredClone(result) },
                signal
              ),
            signal,
            claim.timeoutMs
          )
      }
      // Every scope is checked at completion, including frames evaluated earlier in the run.
      for (const captured of basis.frames) {
        const item = input.cases.find((c) => c.caseId === captured.caseId)!
        active = { item, task: captured.task, stateHash: captured.stateHash }
        await withLearningAccount(this.authority, reference, null, assertFrozen)
      }
      const packet = EnterpriseMemoryReplayPacketSchema.parse({
        schema: 'autoreply-enterprise-memory-replay-v1',
        ...privateBasis,
        frozen,
        receipts,
        blind
      })
      clearInterval(monitor)
      await this.checkpoints.complete(reference, claim)
      await this.budget.end(reference, claim, 'completed')
      return packet
    } catch (error) {
      const endState = signal.aborted ? 'cancelled' : 'failed'
      controller.abort('evaluation_failed')
      if (run) await this.budget.end(reference, run, endState).catch(() => {})
      if (run)
        await this.checkpoints
          .incomplete(
            reference,
            run,
            budgetExhausted ? 'waiting_budget' : 'incomplete',
            measuring
              ? {
                  assignmentId: measuring.assignmentId,
                  elapsedMs: performance.now() - measuring.started
                }
              : undefined
          )
          .catch(() => {})
      throw budgetExhausted ? new Error('evaluation_budget_waiting') : error
    } finally {
      if (monitor) clearInterval(monitor)
    }
  }
}

/** Content/deployment consistency only; authenticated server provenance is checked separately. */
export function verifyEnterpriseMemoryReplayPacket(raw: unknown): EnterpriseMemoryReplayPacket {
  const packet = EnterpriseMemoryReplayPacketSchema.parse(raw)
  if (learningHash(frozenMetadata(packet, packet.frozen.frozenAt)) !== learningHash(packet.frozen))
    throw new Error('frozen_packet_changed')
  if (
    packet.frames.length !== packet.input.cases.length ||
    new Set(packet.frames.map((f) => f.caseId)).size !== packet.frames.length ||
    new Set(packet.methods.map((m) => m.id)).size !== packet.methods.length ||
    new Set(packet.episodes.map((e) => e.id)).size !== packet.episodes.length
  )
    throw new Error('duplicate_replay_basis')
  for (const m of packet.methods)
    if (learningHash(m.content) !== m.contentHash) throw new Error('loaded_memory_changed')
  const sources = new Map(packet.input.sources.map((s) => [s.caseId, s]))
  if (packet.input.sources.some((s) => s.label.labelledAt > packet.frozen.frozenAt))
    throw new Error('source_label_after_freeze')
  for (const captured of packet.frames) {
    const item = packet.input.cases.find((c) => c.caseId === captured.caseId)
    if (
      !item ||
      captured.task.conversationId !== item.conversationId ||
      captured.task.contextHash !== hashContext({ inbound: item.inbound, context: item.context }) ||
      captured.task.configVersion !== packet.publication.configuration.configVersion ||
      captured.task.knowledgeVersion !== packet.publication.configuration.knowledgeVersion ||
      captured.task.decisionPolicyVersion !== packet.publication.policy.version ||
      captured.task.questionSetVersion !== packet.publication.policy.questionSetVersion
    )
      throw new Error('replay_task_changed')
  }
  const calls = packet.receipts.flatMap((r) => r.modelCallRefs ?? [])
  if (
    packet.receipts.some(
      (r) =>
        !r.modelCallRefs ||
        !r.pipelineStatus ||
        (r.modelCallRefs.length === 0 &&
          !(
            r.pipelineStatus === 'handoff' && r.pipelineReasons?.includes('explicit_human_request')
          ))
    ) ||
    new Set(calls).size !== calls.length
  )
    throw new Error('invalid_model_call_evidence')
  if (
    packet.frozen.methods.some((m) =>
      m.sourceCaseIds.some((id) => sources.get(id)?.split !== 'learn')
    ) ||
    packet.episodes.some(
      (e) =>
        sources.get(e.id)?.split !== 'learn' ||
        sources.get(e.id)?.conversationId !== (e.scope.conversationId ?? 'account')
    )
  )
    throw new Error('evaluation_source_not_in_learn_split')
  return packet
}

export function adjudicateEnterpriseMemoryReplay(
  raw: unknown,
  labels: unknown
): LearningEvaluationDataset {
  const packet = verifyEnterpriseMemoryReplayPacket(raw)
  const cases = packet.input.cases.map((c) => ({
    caseId: c.caseId,
    conversationId: c.conversationId,
    category: c.category,
    question: blindQuestion(c)
  }))
  return adjudicateReplayEvidence(
    {
      frozen: packet.frozen,
      receipts: packet.receipts,
      blind: packet.blind,
      input: {
        datasetId: packet.input.datasetId,
        origin: packet.input.origin,
        rubricRef: packet.input.rubricRef,
        sources: packet.input.sources,
        cases
      }
    },
    labels,
    (r, item) => {
      const captured = packet.frames.find((f) => f.caseId === item.caseId)
      if (!captured) throw new Error('missing_replay_basis')
      const selectedMethods = captured.context.methodRefs.map(
        (ref) =>
          packet.methods.find(
            (m) =>
              m.id === ref.id && m.revision === ref.revision && m.contentHash === ref.contentHash
          )!
      )
      const selectedEpisodes = captured.context.caseIds.map(
        (id) => packet.episodes.find((e) => e.id === id)!
      )
      if (
        selectedMethods.some((m) => !m) ||
        selectedEpisodes.some((e) => !e) ||
        renderEnterpriseLearningReference(selectedMethods, selectedEpisodes) !==
          captured.context.text
      )
        throw new Error('loaded_memory_changed')
      const refs = r.arm === 'learned' ? captured.context.methodRefs : [],
        history =
          r.arm === 'learned'
            ? selectedEpisodes.map((e) => ({ id: e.id, hash: learningHash(e) }))
            : []
      if (
        learningHash(refs) !== learningHash(r.loadedMethodRefs) ||
        learningHash(history) !== learningHash(r.loadedCaseRefs ?? [])
      )
        throw new Error('loaded_memory_changed')
    }
  )
}
