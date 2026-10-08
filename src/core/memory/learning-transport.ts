import { z } from 'zod'
import type { LearningReviewTransport } from './learning-reviewer'

const Configuration = z.strictObject({ baseURL: z.string().url(), apiKey: z.string().trim().min(1), model: z.string().trim().min(1).max(128) })
const ResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().min(1).max(64000) }) })).min(1).max(10),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative().safe(), completion_tokens: z.number().int().nonnegative().safe() }).optional()
})
/** OpenAI-compatible text endpoint. Credentials stay in the host and redirects never forward them. */
export class HttpLearningReviewTransport implements LearningReviewTransport {
  private readonly config: z.infer<typeof Configuration>
  private readonly endpoint: string
  constructor(config: z.infer<typeof Configuration>) {
    this.config = Configuration.parse(config)
    const url = new URL(this.config.baseURL)
    if (url.username || url.password || url.search || url.hash) throw new Error('review_endpoint_invalid')
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('review_insecure_endpoint')
    const base = url.href.replace(/\/$/, '')
    this.endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
  }
  async complete(request: { system: string; user: string; maxOutputTokens: number }, signal: AbortSignal): ReturnType<LearningReviewTransport['complete']> {
    if (signal.aborted) throw new Error('review_cancelled')
    if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > 2000) throw new Error('review_output_budget_invalid')
    let response: Response
    try {
      response = await fetch(this.endpoint, {
        method: 'POST', redirect: 'manual', signal,
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.config.model, stream: false, max_tokens: request.maxOutputTokens,
          response_format: { type: 'json_object' }, messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }] })
      })
    } catch { throw new Error(signal.aborted ? 'review_cancelled' : 'review_unavailable') }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(response.status === 401 || response.status === 403 ? 'review_auth_failed' : response.status === 429 ? 'review_rate_limited' : 'review_http_error')
    }
    if (!response.body) throw new Error('review_response_invalid')
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let text = '', bytes = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.length
        if (bytes > 65536) throw new Error('review_response_too_large')
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
    } catch {
      await reader.cancel().catch(() => {})
      throw new Error(signal.aborted ? 'review_cancelled' : bytes > 65536 ? 'review_response_too_large' : 'review_response_invalid')
    } finally { reader.releaseLock() }
    let parsed: z.infer<typeof ResponseSchema>
    try { parsed = ResponseSchema.parse(JSON.parse(text)) } catch { throw new Error('review_response_invalid') }
    return { text: parsed.choices[0].message.content,
      ...(parsed.usage ? { usage: { inputTokens: parsed.usage.prompt_tokens, outputTokens: parsed.usage.completion_tokens } } : {}) }
  }
}
