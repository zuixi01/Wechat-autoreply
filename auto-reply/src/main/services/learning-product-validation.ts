import { z } from 'zod'
import type { KnowledgeStore } from '../../core/knowledge/knowledge-store'
import { KnowledgeReplyService } from '../../core/knowledge/knowledge-reply'
import type { LearningStore } from '../../core/memory/learning-store'
import type { LearningReviewTransport } from '../../core/memory/learning-reviewer'
import {
  BudgetedLearningValidationTransport,
  type ValidationRunClaim
} from '../../core/memory/learning-validation-budget'
import { StructuredMemoryRiskChecker } from '../../core/memory/learning-risk'
import { boundedMemorySnapshot, buildLearningContext } from '../../core/memory/learning-retrieval'
import { learningHash } from '../../core/memory/learning-scope'
import type { LearningValidationDependencies } from '../../core/memory/learning-validation'
import type {
  MemoryScope,
  MemoryRevision,
  MemorySnapshotItem,
  LearningValidationCase
} from '../../shared/contracts/learning-memory'

interface ProductValidationOptions {
  knowledge(): KnowledgeStore
  policy(scope: MemoryScope, modeId?: string): { rules: string; validatorVersion: string }
  transport: LearningReviewTransport
  replyTransport?: LearningReviewTransport
}
const Reply = z.strictObject({ text: z.string().trim().min(1).max(10000) })
/** Calibrates the actual knowledge reply path; human rubrics never enter the model prompt. */
export class LearningProductValidation {
  constructor(
    private readonly store: LearningStore,
    private readonly options: ProductValidationOptions
  ) {}
  async dataset(scope: MemoryScope): Promise<{
    cases: LearningValidationCase[]
    knowledgeVersion: string
    policyVersion: string
    validatorVersion: string
  }> {
    const calibration = this.store.validation.calibration(scope)
    const policy = this.options.policy(scope, calibration.modeId)
    return {
      cases: calibration.cases,
      knowledgeVersion: this.options.knowledge().version(),
      policyVersion: learningHash(policy.rules),
      validatorVersion: policy.validatorVersion
    }
  }
  forRun(scope: MemoryScope, run: ValidationRunClaim): LearningValidationDependencies {
    const transport = new BudgetedLearningValidationTransport(
      this.store,
      run,
      this.options.transport
    )
    const replyTransport = new BudgetedLearningValidationTransport(
      this.store,
      run,
      this.options.replyTransport ?? this.options.transport
    )
    const settings = this.store.settings(scope)
    const risk = new StructuredMemoryRiskChecker(
      transport,
      settings.maxReviewInputTokens,
      settings.reviewModelId
    )
    let target: MemoryRevision | undefined
    const item = (revision: MemoryRevision): MemorySnapshotItem => ({
      id: revision.memoryId,
      revision: revision.revision,
      scope: this.store.get(scope, revision.memoryId).scope,
      contentHash: revision.contentHash,
      content: revision.content,
      evidence: revision.evidence,
      expiresAt: revision.expiresAt
    })
    return {
      assessRisk: (revision, signal) => {
        target = structuredClone(revision)
        return risk.assess(revision, signal)
      },
      replay: async (example, revision, signal) => {
        if (signal.aborted) throw new Error('validation_cancelled')
        if (!target || (revision && revision.memoryId !== target.memoryId))
          throw new Error('validation_target_missing')
        const candidateTarget = target
        const existing = this.store.retrieve(scope, example.input)
        // A merged candidate must stand on its own after the superseded methods are removed.
        const replacementIds = new Set(
          this.store.curation
            .replacements(scope, candidateTarget.memoryId)
            .map((ref) => ref.memoryId)
        )
        const replaced = existing.items.filter((entry) => replacementIds.has(entry.id))
        const memory = this.store.get(scope, candidateTarget.memoryId)
        const baseline =
          memory.state === 'active' && memory.activeRevision !== null
            ? this.store
                .history(scope, candidateTarget.memoryId)
                .find((entry) => entry.revision === memory.activeRevision)
            : undefined
        const limits = { maxEntries: settings.maxEntries, maxTokens: settings.maxContextTokens }
        const baselineItems = baseline ? [item(baseline)] : replaced
        const candidateItems = [item(candidateTarget)]
        const others = existing.items
          .filter((entry) => entry.id !== candidateTarget.memoryId && !replacementIds.has(entry.id))
          .slice(
            0,
            Math.max(0, settings.maxEntries - Math.max(baselineItems.length, candidateItems.length))
          )
        const fits = (entries: MemorySnapshotItem[]): boolean =>
          boundedMemorySnapshot(scope, entries, limits).items.length === entries.length
        if (!fits(candidateItems) || !fits(baselineItems))
          throw new Error('validation_memory_context_over_budget')
        while (
          others.length &&
          (!fits([...candidateItems, ...others]) || !fits([...baselineItems, ...others]))
        )
          others.pop()
        const snapshot = boundedMemorySnapshot(
          scope,
          [...(revision ? [item(revision)] : replaced), ...others],
          limits,
          existing.corpusVersion
        )
        const policy = this.options.policy(scope, this.store.validation.calibration(scope).modeId)
        const reply = await new KnowledgeReplyService(this.options.knowledge()).answer(
          example.input,
          policy.rules + buildLearningContext(snapshot),
          async (system, user) => {
            const response = await replyTransport.complete(
              {
                system:
                  system +
                  '\n输出格式：仅输出 JSON 对象 {"text":"最终回复文字"}，不要输出评分或其他字段。',
                user,
                maxInputTokens: settings.maxReviewInputTokens,
                maxOutputTokens: 2000,
                reviewModelId: settings.reviewModelId
              },
              signal
            )
            try {
              return Reply.parse(JSON.parse(response.text)).text
            } catch {
              throw new Error('validation_reply_invalid')
            }
          }
        )
        if (signal.aborted) throw new Error('validation_cancelled')
        return {
          text: reply.text,
          covered: false,
          severeErrors: reply.fallback ? ['replay_knowledge_missing'] : []
        }
      }
    }
  }
}
