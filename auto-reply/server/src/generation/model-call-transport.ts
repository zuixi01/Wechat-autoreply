import { z } from 'zod'
import { performance } from 'node:perf_hooks'
import { hashContext, hashDraft } from '../../../src/core/reply/hashes'
import { Id } from '../../../src/shared/contracts/identity'
import { JevRequestSchema, parseJevResponse } from '../../../src/shared/contracts/decision'
import { parseTextGenerationResponse } from './text-generator'
import {
  ModelCallError,
  ModelTransportError,
  ProviderRequestIdSchema,
  type ModelCallHandle,
  type ModelCallResult,
  type ModelCallStart
} from './model-call-contracts'

const Usage = z.object({
  input_tokens: z.number().int().nonnegative().safe(),
  output_tokens: z.number().int().nonnegative().safe()
})
const TextUsage = z.object({
  prompt_tokens: z.number().int().nonnegative().safe(),
  completion_tokens: z.number().int().nonnegative().safe()
})

/** Only sanitized, bounded metadata leaves this transport. Raw bodies are never journaled. */
export function recordedTransport(
  provider: 'jev' | 'text',
  reserve: (start: ModelCallStart) => Promise<ModelCallHandle>,
  upstream: typeof fetch = fetch,
  expectedTextModel?: string
): typeof fetch {
  return async (url, init) => {
    if (init?.method !== 'POST' || typeof init.body !== 'string')
      throw new ModelCallError('CONTEXT_UNAVAILABLE')
    let request: Record<string, unknown>
    try {
      request = JSON.parse(init.body)
    } catch {
      throw new ModelCallError('CONTEXT_UNAVAILABLE')
    }
    const requestedModel = Id.parse(request.model)
    const handle = await reserve({
      provider,
      requestedModel,
      requestHash: hashContext(request),
      ...(provider === 'jev'
        ? { questionHash: hashContext(JevRequestSchema.parse(request).questions) }
        : {})
    })
    const started = performance.now()
    const signal = init.signal
    const report: ModelCallResult = { outcome: 'error', failureCode: 'UNAVAILABLE', durationMs: 0 }
    let dispatched = false
    let abort: (() => void) | undefined
    const cancelled = (): Error =>
      new Error(signal?.reason === 'model_timeout' ? 'model_timeout' : 'model_cancelled')
    const stop = new Promise<never>((_, reject) => {
      abort = () => reject(cancelled())
      signal?.addEventListener('abort', abort, { once: true })
    })
    const call = async (): Promise<Response> => {
      if (signal?.aborted) throw cancelled()
      dispatched = true
      const response = await upstream(url, init)
      if (signal?.aborted) {
        void response.body?.cancel().catch(() => {})
        throw cancelled()
      }
      report.httpStatus = response.status
      const requestIdHeader = provider === 'jev' ? 'x-typesafe-request-id' : 'x-request-id'
      const requestId = ProviderRequestIdSchema.safeParse({
        header: requestIdHeader,
        value: response.headers.get(requestIdHeader)
      })
      if (requestId.success) report.providerRequestId = requestId.data
      if (response.status !== 200) {
        report.failureCode =
          response.status >= 300 && response.status < 400
            ? 'REDIRECT_REJECTED'
            : [401, 403].includes(response.status)
              ? 'AUTH_FAILED'
              : response.status === 429
                ? 'RATE_LIMITED'
                : response.status >= 500
                  ? 'UNAVAILABLE'
                  : 'HTTP_ERROR'
        void response.body?.cancel().catch(() => {})
        return new Response(null, { status: response.status, headers: response.headers })
      }
      const maximum = provider === 'jev' ? 2_000_000 : 262144
      const reader = response.body?.getReader()
      if (!reader) throw new Error('invalid_body')
      const cancelReader = (): void => {
        void reader.cancel().catch(() => {})
      }
      signal?.addEventListener('abort', cancelReader, { once: true })
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        if (Number(response.headers.get('content-length') ?? 0) > maximum)
          throw new Error('invalid_body')
        while (true) {
          const { done, value } = await reader.read()
          if (signal?.aborted) throw cancelled()
          if (done) break
          bytes += value.byteLength
          if (bytes > maximum) throw new Error('invalid_body')
          chunks.push(value)
        }
      } finally {
        signal?.removeEventListener('abort', cancelReader)
        cancelReader()
      }
      const body = Buffer.concat(chunks)
      let value: Record<string, unknown>
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
        const model = Id.safeParse(value.model)
        if (model.success) report.actualModel = model.data
        const usage = (provider === 'jev' ? Usage : TextUsage).safeParse(value.usage)
        if (usage.success) {
          const counts = usage.data as Record<string, number>
          report.usage = {
            inputTokens: counts.input_tokens ?? counts.prompt_tokens,
            outputTokens: counts.output_tokens ?? counts.completion_tokens
          }
        }
        if (provider === 'jev')
          report.answers = parseJevResponse(JevRequestSchema.parse(request), value).answers
        else {
          const output = parseTextGenerationResponse(value, expectedTextModel ?? requestedModel)
          report.textOutput = {
            draftHash: hashDraft(output.text),
            evidenceIds: output.evidenceIds
          }
        }
        report.outcome = 'response'
        delete report.failureCode
      } catch (error) {
        report.failureCode =
          error instanceof Error && error.message === 'MODEL_DRIFT'
            ? 'MODEL_DRIFT'
            : 'INVALID_RESPONSE'
      }
      return new Response(body, { status: response.status, headers: response.headers })
    }
    let response: Response | undefined
    let failure: unknown
    try {
      response = await Promise.race([call(), stop])
    } catch (error) {
      failure = new ModelTransportError('UNAVAILABLE')
      if (signal?.aborted) {
        report.outcome = !dispatched
          ? 'not_dispatched'
          : signal.reason === 'model_timeout'
            ? 'timed_out'
            : 'cancelled'
        report.failureCode = signal.reason === 'model_timeout' ? 'TIMEOUT' : 'CANCELLED'
        failure = new ModelTransportError(
          signal.reason === 'model_timeout' ? 'TIMEOUT' : 'CANCELLED'
        )
      } else if (error instanceof Error && error.message === 'invalid_body') {
        report.failureCode = 'INVALID_RESPONSE'
        failure = new ModelTransportError('INVALID_RESPONSE')
      }
    } finally {
      if (abort) signal?.removeEventListener('abort', abort)
    }
    if (failure || report.outcome !== 'response') delete report.textOutput
    // Snapshot before persisting: a transport ignoring cancellation cannot mutate a late receipt.
    const result = structuredClone({
      ...report,
      durationMs: Math.max(0, Math.floor(performance.now() - started))
    })
    await handle.finish(result)
    if (failure) throw failure
    if (!response) throw new ModelCallError('RECORD_UNAVAILABLE')
    return response
  }
}
