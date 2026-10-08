import { randomUUID } from 'node:crypto'
import { learningHash } from './learning-scope'
import type { ProviderAdapter, ProviderInput, ProviderEvent } from '../session-types'
import type { LearningStore } from './learning-store'
import type { MemoryScope } from '../../shared/contracts/learning-memory'
import {
  learningContextCurrent,
  retrieveLearningContext,
  type LearningContext
} from './learning-context'

interface MemoryProviderOptions {
  fallbackScope?: MemoryScope
  extract?: (screenshot: string) => Promise<string>
  activity?: { foregroundStarted(): void; foregroundEnded(): void }
  onLoaded?: (input: ProviderInput, context: LearningContext) => void
  onDraft?: (input: ProviderInput, context: LearningContext | null, draft: string) => void
  onLearningError?: () => void
}
/** Isolated learning failures cannot stop replies; changed published snapshots must stop stale replies. */
export class MemoryProvider implements ProviderAdapter {
  constructor(
    private readonly provider: ProviderAdapter,
    private readonly store: LearningStore,
    private readonly resolveScope: (input: ProviderInput) => MemoryScope | null,
    private readonly options: MemoryProviderOptions = {}
  ) {
    if (options.fallbackScope?.conversationId) throw new Error('unverified_personal_fallback')
  }
  private notify(callback: (() => void) | undefined): void {
    try {
      callback?.()
    } catch {
      this.reportError()
    }
  }
  private reportError(): void {
    try {
      this.options.onLearningError?.()
    } catch {
      /* Learning diagnostics have no reply authority. */
    }
  }
  async *run(input: ProviderInput): AsyncIterable<ProviderEvent> {
    this.notify(() => this.options.activity?.foregroundStarted())
    try {
      // Unscoped legacy cards must not leak into the new provider path.
      const original = { ...input }
      delete original.memoryCards
      delete original.memorySnapshot
      const prepared: ProviderInput = { ...original, learningGenerationId: randomUUID() }
      let context: LearningContext | null = null
      try {
        const verified = this.resolveScope(prepared),
          scope = verified ?? this.options.fallbackScope
        const query =
          prepared.extractedText ||
          prepared.ocrText ||
          (prepared.screenshot && this.options.extract
            ? await this.options.extract(prepared.screenshot)
            : '')
        if (query) prepared.extractedText = query
        if (scope && query.trim())
          context = retrieveLearningContext(
            this.store,
            scope,
            query,
            Boolean(verified),
            `generation:${learningHash(prepared.learningGenerationId)}`
          )
      } catch {
        this.reportError()
      }
      if (context) this.notify(() => this.options.onLoaded?.(prepared, context!))
      const enriched = context
        ? {
            ...prepared,
            memorySnapshot: context.snapshot,
            customPrompt: (prepared.customPrompt ?? '') + context.text
          }
        : prepared
      for await (const event of this.provider.run(enriched)) {
        if (event.type === 'reply_text') {
          if (context && !learningContextCurrent(this.store, context)) {
            yield { type: 'error', error: '工作记忆已更新，本次回复已取消，请重新生成。' }
            return
          }
          this.notify(() => this.options.onDraft?.(prepared, context, event.content))
          yield {
            ...event,
            learningGenerationId: prepared.learningGenerationId,
            ...(context ? { memorySnapshot: context.snapshot } : {})
          }
        } else yield event
      }
    } finally {
      this.notify(() => this.options.activity?.foregroundEnded())
    }
  }
}
