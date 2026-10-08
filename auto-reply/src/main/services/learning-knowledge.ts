import { randomUUID } from 'node:crypto'
import { learningHash } from '../../core/memory/learning-scope'
import type { KnowledgeReplyService } from '../../core/knowledge/knowledge-reply'
import type { LearningService } from './learning-service'
import type { MemoryScope } from '../../shared/contracts/learning-memory'
import type { KnowledgeReply } from '../../shared/contracts/knowledge'
import {
  learningContextCurrent,
  retrieveLearningContext,
  type LearningContext
} from '../../core/memory/learning-context'

/** The knowledge test panel follows the same learning path as generators, without any sending action. */
export class LearningKnowledgeAnswers {
  constructor(
    private readonly knowledge: KnowledgeReplyService,
    private readonly learning: LearningService,
    private readonly onLearningError: () => void = () => {}
  ) {}
  private reportError(): void {
    try {
      this.onLearningError()
    } catch {
      /* Diagnostic failure cannot cancel a knowledge answer. */
    }
  }
  async answer(
    question: string,
    rules: string,
    generate: (system: string, question: string) => Promise<string | null>,
    trustedObjectScope?: MemoryScope
  ): Promise<KnowledgeReply> {
    this.learning.foregroundStarted()
    try {
      const scope = trustedObjectScope ?? this.learning.accountScope('generic')
      this.learning.assertScope(scope)
      const generationId = randomUUID()
      let context: LearningContext | null = null
      try {
        context = retrieveLearningContext(
          this.learning.store,
          scope,
          question,
          Boolean(trustedObjectScope),
          `generation:${learningHash(generationId)}`
        )
      } catch {
        this.reportError()
      }
      const result = await this.knowledge.answer(question, rules + (context?.text ?? ''), generate)
      if (context && !learningContextCurrent(this.learning.store, context))
        throw new Error('工作记忆已更新，请重新试答。')
      try {
        const episode = this.learning.onDraft(
          {
            screenshot: '',
            appType: 'generic',
            extractedText: question,
            learningGenerationId: generationId
          },
          context,
          result.text,
          trustedObjectScope
        )
        if (context)
          result.learning = {
            scope: episode.scope,
            episodeId: episode.id,
            corpusVersion: context.snapshot.corpusVersion,
            memoryRefs: context.snapshot.items.map((item) => ({
              id: item.id,
              revision: item.revision
            }))
          }
      } catch {
        this.reportError()
      }
      return result
    } finally {
      this.learning.foregroundEnded()
    }
  }
}
