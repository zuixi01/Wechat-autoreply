import { createHash, randomInt, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { KnowledgeBundleSchema } from '../../src/shared/contracts/knowledge'
import { Id, Hash } from '../../src/shared/contracts/identity'
import { MemoryContentSchema } from '../../src/shared/contracts/learning-memory'
import {
  LearningEvaluationCaseSchema,
  LearningEvaluationDatasetSchema,
  LEARNING_EVALUATION_MAX_CASES,
  type LearningEvaluationDataset
} from '../../src/shared/contracts/learning-evaluation'
import { KnowledgeStore } from '../../src/core/knowledge/knowledge-store'
import { KnowledgeReplyService } from '../../src/core/knowledge/knowledge-reply'
import {
  boundedMemorySnapshot,
  buildLearningContext
} from '../../src/core/memory/learning-retrieval'
import { buildMemorySection } from '../../src/core/ai-client'
import { deploymentVersion } from './deployment'

const category = z.enum(['inquiry', 'complaint', 'handoff', 'multiple_intents'])
const natural = z.number().int().nonnegative().safe()
export const MemoryReplayInputSchema = z
  .strictObject({
    version: z.literal(1),
    datasetId: Id,
    origin: z.enum(['business_observation', 'synthetic', 'model']),
    rubricRef: Id,
    model: z.strictObject({
      baseURL: z.string().url(),
      model: Id,
      expectedModel: Id,
      maxOutputTokens: z.number().int().min(1).max(2000)
    }),
    maxRequests: z.number().int().min(1).max(6000),
    backgroundCostUsd: z.number().finite().nonnegative(),
    knowledge: KnowledgeBundleSchema,
    rules: z.string().max(16000),
    legacy: z
      .array(
        z.strictObject({
          scenario: z.string().min(1).max(1000),
          guidance: z.string().min(1).max(6000),
          rationale: z.string().max(2000)
        })
      )
      .max(5),
    methods: z
      .array(
        z.strictObject({
          id: Id,
          revision: z.number().int().positive().safe(),
          content: MemoryContentSchema,
          sourceCaseIds: z.array(Id).min(1).max(10000)
        })
      )
      .min(1)
      .max(10000),
    sources: z.array(LearningEvaluationCaseSchema).min(1).max(100000),
    cases: z
      .array(
        z.strictObject({
          caseId: Id,
          conversationId: Id,
          category,
          question: z.string().trim().min(1).max(8000),
          memoryIds: z.array(Id).max(5).optional()
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
    const sourceSplits = new Map(input.sources.map((c) => [c.caseId, c.split]))
    const methodIds = new Set(input.methods.map((m) => m.id))
    if (new Set(ids).size !== ids.length) fail('duplicate_case_id')
    if (new Set(input.methods.map((m) => m.id)).size !== input.methods.length)
      fail('duplicate_method_id')
    if (input.sources.some((s) => s.split === 'evaluate')) fail('holdout_cannot_be_source')
    const splits = new Map<string, string>()
    for (const c of [...input.sources, ...input.cases.map((c) => ({ ...c, split: 'evaluate' }))]) {
      if (splits.has(c.conversationId) && splits.get(c.conversationId) !== c.split)
        fail('conversation_split_overlap')
      splits.set(c.conversationId, c.split)
    }
    for (const method of input.methods) {
      if (new Set(method.sourceCaseIds).size !== method.sourceCaseIds.length)
        fail('duplicate_source_case')
      if (method.sourceCaseIds.some((id) => sourceSplits.get(id) !== 'learn'))
        fail('method_source_must_be_learn')
    }
    if (
      input.cases.some(
        (c) =>
          c.memoryIds &&
          (new Set(c.memoryIds).size !== c.memoryIds.length ||
            c.memoryIds.some((id) => !methodIds.has(id)))
      )
    )
      fail('invalid_frozen_selection')
    if (input.cases.some((c) => !c.memoryIds) && input.methods.length > 5)
      fail('explicit_frozen_selection_required')
    if (input.cases.length * 3 > input.maxRequests) fail('request_budget_exceeded')
    if (!input.knowledge.settings.enabled) fail('knowledge_must_be_enabled')
  })
const arm = z.enum(['none', 'baseline', 'learned'])
export const MemoryReplayReceiptSchema = z.strictObject({
  assignmentId: Id,
  caseId: Id,
  arm,
  reply: z.string().min(1).max(16000).nullable(),
  generatedAt: natural,
  latencyMs: z.number().finite().nonnegative(),
  latencyComplete: z.boolean().optional(),
  inputTokens: natural.nullable(),
  outputTokens: natural.nullable(),
  costUsd: z.null(),
  configurationHash: Hash,
  memoryManifestHash: Hash,
  loadedMethodRefs: z
    .array(
      z.strictObject({ id: Id, revision: z.number().int().positive().safe(), contentHash: Hash })
    )
    .max(5),
  modelCallRefs: z.array(Id).max(3).optional(),
  executionTaskHashes: z.array(Hash).min(1).max(9).optional(),
  loadedCaseRefs: z
    .array(z.strictObject({ id: Id, hash: Hash }))
    .max(3)
    .optional(),
  pipelineStatus: z.enum(['candidate', 'handoff', 'invalid', 'cancelled']).optional(),
  pipelineReasons: z.array(z.string().min(1).max(128)).max(30).optional()
})
const receipt = MemoryReplayReceiptSchema
export const MemoryReplayPacketSchema = z.strictObject({
  version: z.literal(1),
  input: MemoryReplayInputSchema,
  frozen: LearningEvaluationDatasetSchema.shape.frozen,
  receipts: z.array(receipt).min(3).max(6000),
  blind: z
    .array(
      z.strictObject({
        assignmentId: Id,
        caseId: Id,
        category,
        question: z.string(),
        reply: z.string().nullable()
      })
    )
    .min(3)
    .max(6000)
})
export type MemoryReplayPacket = z.infer<typeof MemoryReplayPacketSchema>
export type ReplayGenerate = (
  system: string,
  question: string,
  requestId: string
) => Promise<{ text: string; inputTokens: number | null; outputTokens: number | null }>
type ReplayInput = z.infer<typeof MemoryReplayInputSchema>
function frozenSnapshot(
  input: ReplayInput,
  item: ReplayInput['cases'][number]
): ReturnType<typeof boundedMemorySnapshot> {
  const methods = new Map(input.methods.map((m) => [m.id, m]))
  const selected = (item.memoryIds ?? input.methods.map((m) => m.id)).map((id) => methods.get(id)!)
  const scope = {
    workspaceId: 'isolated-evaluation',
    platform: 'generic' as const,
    conversationId: item.conversationId
  }
  return boundedMemorySnapshot(
    scope,
    selected.map((m) => ({
      id: m.id,
      revision: m.revision,
      contentHash: replayHash(m.content),
      content: m.content,
      scope,
      evidence: []
    }))
  )
}
export function replayHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function deployedVersions(): Pick<
  MemoryReplayPacket['frozen'],
  'policyVersion' | 'retrievalVersion'
> {
  return {
    policyVersion: deploymentVersion(import.meta.url, [
      '../../src/core/knowledge/knowledge-reply',
      '../../src/core/ai-client',
      '../../src/core/memory/learning-retrieval',
      '../../src/shared/contracts/knowledge',
      '../../src/shared/contracts/learning-memory',
      '../../src/shared/contracts/learning-evaluation',
      '../../src/shared/contracts/identity',
      './replay',
      './replay-http',
      './deployment'
    ]),
    retrievalVersion: deploymentVersion(import.meta.url, [
      '../../src/core/knowledge/knowledge-store',
      '../../src/core/knowledge/retrieval',
      '../../src/core/memory/learning-retrieval',
      '../../src/core/memory/learning-scope',
      './replay',
      './deployment'
    ])
  }
}

/** Uses the production knowledge reply pipeline and frozen memory rendering. There is no LearningService,
 * episode writer, scheduler, publication or sending capability in this isolated process. */
export async function replayMemoryCases(
  raw: unknown,
  generate: ReplayGenerate
): Promise<MemoryReplayPacket> {
  const input = MemoryReplayInputSchema.parse(raw)
  const frozenAt = Date.now()
  if (input.sources.some((c) => c.label.labelledAt > frozenAt))
    throw new Error('source_label_after_freeze')
  const { policyVersion, retrievalVersion } = deployedVersions()
  const assertDeployment = (): void => {
    const current = deployedVersions()
    if (current.policyVersion !== policyVersion || current.retrievalVersion !== retrievalVersion)
      throw new Error('evaluation_environment_changed')
  }
  const frozen = {
    frozenAt,
    modelVersion: input.model.expectedModel,
    knowledgeVersion: input.knowledge.version,
    policyVersion,
    retrievalVersion,
    backgroundCostUsd: input.backgroundCostUsd,
    latencyScope: 'knowledge_preview' as const,
    sharedConfigurationHash: replayHash({
      model: input.model,
      knowledge: input.knowledge,
      rules: input.rules,
      policyVersion,
      retrievalVersion
    }),
    noMemoryManifestHash: replayHash([]),
    staticMemoryManifestHash: replayHash(input.legacy),
    learnedMemoryManifestHash: replayHash(input.methods),
    methods: input.methods.map((m) => ({
      id: m.id,
      revision: m.revision,
      contentHash: replayHash(m.content),
      sourceCaseIds: m.sourceCaseIds
    }))
  }
  const store = new KnowledgeStore(':memory:')
  try {
    store.settings(input.knowledge.settings)
    for (const document of input.knowledge.documents)
      store.finish(store.begin(document.name, 'txt', document.category).id, document.content)
    const answers = new KnowledgeReplyService(store)
    const receipts: MemoryReplayPacket['receipts'] = []
    const blind: MemoryReplayPacket['blind'] = []
    for (const item of input.cases) {
      // Randomize request order to avoid systematically measuring the learned arm after warm-up.
      const order: z.infer<typeof arm>[] = ['none', 'baseline', 'learned']
      for (let i = order.length - 1; i > 0; i--) {
        const j = randomInt(i + 1)
        ;[order[i], order[j]] = [order[j], order[i]]
      }
      for (const group of order) {
        assertDeployment()
        const assignmentId = randomUUID()
        let usage: Awaited<ReturnType<ReplayGenerate>> | null = null
        const start = performance.now()
        const snapshot = group === 'learned' ? frozenSnapshot(input, item) : null
        const memory =
          group === 'learned'
            ? buildLearningContext(snapshot!)
            : group === 'baseline'
              ? buildMemorySection(input.legacy.map((c, i) => ({ ...c, cardId: `legacy-${i}` })))
              : ''
        const answer = await answers.answer(
          item.question,
          input.rules + memory,
          async (system, question) => {
            assertDeployment()
            usage = await generate(system, question, assignmentId)
            return usage.text
          }
        )
        assertDeployment()
        const observed = usage as Awaited<ReturnType<ReplayGenerate>> | null
        const record = receipt.parse({
          assignmentId,
          caseId: item.caseId,
          arm: group,
          reply: answer.text,
          generatedAt: Date.now(),
          latencyMs: performance.now() - start,
          inputTokens: observed?.inputTokens ?? (answer.fallback ? 0 : null),
          outputTokens: observed?.outputTokens ?? (answer.fallback ? 0 : null),
          costUsd: null,
          configurationHash: frozen.sharedConfigurationHash,
          memoryManifestHash:
            group === 'none'
              ? frozen.noMemoryManifestHash
              : group === 'baseline'
                ? frozen.staticMemoryManifestHash
                : frozen.learnedMemoryManifestHash,
          loadedMethodRefs: snapshot
            ? snapshot.items.map(({ id, revision, contentHash }) => ({
                id,
                revision,
                contentHash
              }))
            : []
        })
        receipts.push(record)
        blind.push({
          assignmentId: record.assignmentId,
          caseId: item.caseId,
          category: item.category,
          question: item.question,
          reply: record.reply
        })
      }
    }
    assertDeployment()
    return MemoryReplayPacketSchema.parse({ version: 1, input, frozen, receipts, blind })
  } finally {
    store.close()
  }
}

export const MemoryReplayAdjudicationSchema = z
  .array(
    z.strictObject({
      assignmentId: Id,
      origin: z.enum(['human', 'synthetic', 'model']),
      reviewerId: Id,
      evidenceRef: Id,
      labelledAt: natural,
      blinded: z.boolean(),
      humanReviewed: z.boolean(),
      substantialCorrection: z.boolean(),
      severeError: z.boolean(),
      validAnswer: z.boolean(),
      costUsd: z.number().finite().nonnegative().optional(),
      costEvidenceRef: Id.optional(),
      inputTokens: natural.optional(),
      outputTokens: natural.optional()
    })
  )
  .max(6000)
/** Separate human import: never fills missing labels/usage/cost with assumed acceptance or zero. */
export function adjudicateMemoryReplay(
  raw: unknown,
  annotations: unknown
): LearningEvaluationDataset {
  const packet = MemoryReplayPacketSchema.parse(raw)
  const { input, frozen } = packet
  const deployed = deployedVersions()
  if (
    packet.receipts.length !== input.cases.length * 3 ||
    packet.blind.length !== packet.receipts.length
  )
    throw new Error('incomplete_three_arm_replay')
  if (
    frozen.policyVersion !== deployed.policyVersion ||
    frozen.retrievalVersion !== deployed.retrievalVersion ||
    frozen.sharedConfigurationHash !==
      replayHash({
        model: input.model,
        knowledge: input.knowledge,
        rules: input.rules,
        policyVersion: frozen.policyVersion,
        retrievalVersion: frozen.retrievalVersion
      }) ||
    frozen.noMemoryManifestHash !== replayHash([]) ||
    frozen.staticMemoryManifestHash !== replayHash(input.legacy) ||
    frozen.learnedMemoryManifestHash !== replayHash(input.methods) ||
    frozen.modelVersion !== input.model.expectedModel ||
    frozen.knowledgeVersion !== input.knowledge.version ||
    frozen.backgroundCostUsd !== input.backgroundCostUsd ||
    (frozen.latencyScope !== undefined && frozen.latencyScope !== 'knowledge_preview') ||
    replayHash(frozen.methods) !==
      replayHash(
        input.methods.map((m) => ({
          id: m.id,
          revision: m.revision,
          contentHash: replayHash(m.content),
          sourceCaseIds: m.sourceCaseIds
        }))
      )
  )
    throw new Error('frozen_packet_changed')
  if (input.sources.some((c) => c.label.labelledAt > frozen.frozenAt))
    throw new Error('source_label_after_freeze')
  return adjudicateReplayEvidence(packet, annotations, (r, item) => {
    const expectedRefs =
      r.arm === 'learned'
        ? frozenSnapshot(input, item).items.map(({ id, revision, contentHash }) => ({
            id,
            revision,
            contentHash
          }))
        : []
    if (replayHash(expectedRefs) !== replayHash(r.loadedMethodRefs))
      throw new Error('loaded_memory_changed')
  })
}
export type MemoryReplayEvidence = Pick<MemoryReplayPacket, 'frozen' | 'receipts' | 'blind'> & {
  input: Pick<ReplayInput, 'datasetId' | 'origin' | 'rubricRef' | 'sources' | 'cases'>
}
/** Common three-arm label/usage rules for parsed, separately verified pipeline packets. */
export function adjudicateReplayEvidence(
  packet: MemoryReplayEvidence,
  annotations: unknown,
  assertLoaded: (
    r: MemoryReplayPacket['receipts'][number],
    item: ReplayInput['cases'][number]
  ) => void
): LearningEvaluationDataset {
  const labels = MemoryReplayAdjudicationSchema.parse(annotations)
  const { frozen } = packet
  if (
    packet.receipts.length !== packet.input.cases.length * 3 ||
    packet.blind.length !== packet.receipts.length
  )
    throw new Error('incomplete_three_arm_replay')
  if (labels.length !== packet.receipts.length) throw new Error('missing_adjudication')
  const byId = new Map(labels.map((l) => [l.assignmentId, l]))
  if (byId.size !== labels.length) throw new Error('duplicate_assignment')
  if (new Set(packet.receipts.map((r) => r.assignmentId)).size !== packet.receipts.length)
    throw new Error('duplicate_receipt')
  const cases = packet.input.cases.map((item) => {
    const records = packet.receipts.filter((r) => r.caseId === item.caseId)
    if (records.length !== 3 || new Set(records.map((r) => r.arm)).size !== 3)
      throw new Error('incomplete_three_arm_replay')
    const outcomes = records.map((r) => {
      assertLoaded(r, item)
      const expectedManifest =
        r.arm === 'none'
          ? frozen.noMemoryManifestHash
          : r.arm === 'baseline'
            ? frozen.staticMemoryManifestHash
            : frozen.learnedMemoryManifestHash
      const assigned = packet.blind.filter((b) => b.assignmentId === r.assignmentId)
      if (
        assigned.length !== 1 ||
        assigned[0].caseId !== r.caseId ||
        assigned[0].reply !== r.reply ||
        assigned[0].question !== item.question ||
        assigned[0].category !== item.category
      )
        throw new Error('blind_assignment_changed')
      if (
        r.generatedAt < frozen.frozenAt ||
        r.configurationHash !== frozen.sharedConfigurationHash ||
        r.memoryManifestHash !== expectedManifest
      )
        throw new Error('receipt_configuration_changed')
      const l = byId.get(r.assignmentId)
      if (!l) throw new Error('missing_adjudication')
      if (l.costUsd === undefined || !l.costEvidenceRef) throw new Error('missing_metered_cost')
      if (l.labelledAt < r.generatedAt) throw new Error('label_before_generation')
      if (
        (l.inputTokens !== undefined &&
          r.inputTokens !== null &&
          l.inputTokens !== r.inputTokens) ||
        (l.outputTokens !== undefined &&
          r.outputTokens !== null &&
          l.outputTokens !== r.outputTokens)
      )
        throw new Error('usage_changed')
      const inputTokens = r.inputTokens ?? l.inputTokens,
        outputTokens = r.outputTokens ?? l.outputTokens
      if (inputTokens === undefined || outputTokens === undefined)
        throw new Error('missing_metered_usage')
      return [
        r.arm,
        {
          reply: r.reply,
          generatedAt: r.generatedAt,
          latencyMs: r.latencyMs,
          ...(r.latencyComplete === undefined ? {} : { latencyComplete: r.latencyComplete }),
          configurationHash: r.configurationHash,
          memoryManifestHash: r.memoryManifestHash,
          inputTokens,
          outputTokens,
          costUsd: l.costUsd,
          humanReviewed: l.humanReviewed,
          substantialCorrection: l.substantialCorrection,
          severeError: l.severeError,
          validAnswer: l.validAnswer
        }
      ] as const
    })
    const judges = records.map((r) => byId.get(r.assignmentId)!)
    // A case-level origin cannot disguise a synthetic/model judgement on any of the three arms.
    const origin = judges.some((j) => j.origin === 'synthetic')
      ? 'synthetic'
      : judges.some((j) => j.origin === 'model')
        ? 'model'
        : 'human'
    return {
      caseId: item.caseId,
      conversationId: item.conversationId,
      category: item.category,
      split: 'evaluate',
      label: {
        origin,
        blinded: judges.every((j) => j.blinded),
        assignmentRef: replayHash(records.map((r) => r.assignmentId)),
        reviewerId: replayHash(judges.map((j) => j.reviewerId)),
        evidenceRef: replayHash(judges.map((j) => [j.evidenceRef, j.costEvidenceRef])),
        labelledAt: Math.max(...judges.map((j) => j.labelledAt))
      },
      ...Object.fromEntries(outcomes)
    }
  })
  return LearningEvaluationDatasetSchema.parse({
    version: 2,
    datasetId: packet.input.datasetId,
    origin: packet.input.origin,
    rubricRef: packet.input.rubricRef,
    frozen: packet.frozen,
    cases: [...packet.input.sources, ...cases]
  })
}
