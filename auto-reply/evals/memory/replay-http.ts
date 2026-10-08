import { z } from 'zod'
import type { ReplayGenerate } from './replay'

const envelope = z.object({
  model: z.string(),
  choices: z
    .array(
      z.object({
        finish_reason: z.literal('stop'),
        message: z.object({ content: z.string().trim().min(1).max(16000) })
      })
    )
    .length(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().safe(),
      completion_tokens: z.number().int().nonnegative().safe()
    })
    .optional()
})
/** Plain-text adapter for the production knowledge reply callback. No labels or endpoint from chat. */
export function replayHttpGenerator(
  config: { baseURL: string; model: string; expectedModel: string; maxOutputTokens: number },
  apiKey: string
): ReplayGenerate {
  const base = new URL(config.baseURL)
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.protocol !== 'https:' &&
      !(
        base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
      )) ||
    !apiKey.trim() ||
    /[\r\n]/.test(apiKey)
  )
    throw new Error('invalid_model_configuration')
  const normalized = base.href.replace(/\/+$/, '')
  const endpoint = normalized.endsWith('/chat/completions')
    ? normalized
    : normalized + '/chat/completions'
  return async (system, question) => {
    const signal = AbortSignal.timeout(30000)
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'manual',
      signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        stream: false,
        max_tokens: config.maxOutputTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: question }
        ]
      })
    })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error('model_request_failed')
    }
    const reader = response.body.getReader(),
      decoder = new TextDecoder('utf-8', { fatal: true })
    let text = '',
      bytes = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.length
        if (bytes > 65536) throw new Error('response_too_large')
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw error
    } finally {
      reader.releaseLock()
    }
    const result = envelope.parse(JSON.parse(text))
    if (result.model !== config.expectedModel) throw new Error('model_changed')
    return {
      text: result.choices[0].message.content,
      inputTokens: result.usage?.prompt_tokens ?? null,
      outputTokens: result.usage?.completion_tokens ?? null
    }
  }
}
