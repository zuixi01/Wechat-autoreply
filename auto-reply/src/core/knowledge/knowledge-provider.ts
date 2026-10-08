import type { ProviderAdapter, ProviderInput, ProviderEvent } from '../session-types'
import { KnowledgeStore } from './knowledge-store'
import { knowledgeInstructions } from './knowledge-reply'

/** Apply the shared library before existing local generators; never changes sending controls. */
export class KnowledgeProvider implements ProviderAdapter {
  constructor(
    private readonly provider: ProviderAdapter,
    private readonly store: KnowledgeStore,
    private readonly extract: (screenshot: string) => Promise<string>
  ) {}
  async *run(input: ProviderInput): AsyncIterable<ProviderEvent> {
    if (!this.store.settings().enabled || !this.store.snapshot().documents.length) {
      yield* this.provider.run(input)
      return
    }
    try {
      const query =
        input.extractedText ||
        input.ocrText ||
        (input.screenshot ? await this.extract(input.screenshot) : '')
      if (!query.trim()) {
        yield { type: 'skip' }
        return
      }
      const { hits, version } = this.store.search(query)
      if (!hits.length) {
        yield { type: 'reply_text', content: this.store.settings().fallbackReply }
        return
      }
      const enriched = {
        ...input,
        extractedText: query,
        customPrompt:
          (input.customPrompt ?? '') +
          knowledgeInstructions(hits, this.store.settings().fallbackReply)
      }
      for await (const event of this.provider.run(enriched)) {
        if (event.type === 'reply_text' && this.store.version() !== version) {
          yield { type: 'error', error: '知识库已更新，本次回复已取消。' }
          return
        }
        yield event
      }
    } catch {
      yield { type: 'error', error: '知识检索或文字读取失败，本次回复已取消。' }
    }
  }
}
