import { z } from 'zod'
import { ModelCallError, ModelTransportError } from '../generation/model-call-contracts'
import {
  JevRequestSchema,
  ModelListSchema,
  parseJevResponse,
  type DecisionProvider,
  type JevRequest,
  type JevResponse
} from '../../../src/shared/contracts/decision'

export type JevErrorCode =
  | 'INVALID_REQUEST'
  | 'AUTH_FAILED'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'REDIRECT_REJECTED'
  | 'HTTP_ERROR'

/** Never preserve an upstream error body, credentials, state or request headers in errors. */
export class JevError extends Error {
  constructor(
    readonly code: JevErrorCode,
    readonly retryable = false,
    readonly status?: number,
    readonly retryAfterMs?: number
  ) {
    super(`TypeSafe request failed: ${code}`)
    this.name = 'JevError'
  }
}

interface RequestOptions {
  signal?: AbortSignal
  deadlineMs?: number
}
interface ClientOptions {
  apiKey: string
  fetch?: typeof fetch
  timeoutMs?: number
  maxAttempts?: number
  retryDelayMs?: number
}

const maximumResponseBytes = 2_000_000

function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => {})
}

async function responseText(
  response: Response,
  signal: AbortSignal,
  interrupted: () => JevError
): Promise<string> {
  if (Number(response.headers.get('content-length') ?? 0) > maximumResponseBytes)
    throw new JevError('INVALID_RESPONSE')
  const reader = response.body?.getReader()
  if (!reader) throw new JevError('INVALID_RESPONSE')
  const cancel = (): void => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      if (signal.aborted) throw interrupted()
      const { done, value } = await reader.read()
      if (signal.aborted) throw interrupted()
      if (done) break
      bytes += value.byteLength
      if (bytes > maximumResponseBytes) throw new JevError('INVALID_RESPONSE')
      chunks.push(value)
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))
    } catch {
      throw new JevError('INVALID_RESPONSE')
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    reader.releaseLock()
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new JevError('CANCELLED'))
    const abort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(new JevError('CANCELLED'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export class TypeSafeClient implements DecisionProvider {
  #apiKey: string
  private readonly transport: typeof fetch
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly retryDelayMs: number

  constructor(options: ClientOptions) {
    if (!options.apiKey.trim() || /[\r\n]/.test(options.apiKey)) throw new JevError('AUTH_FAILED')
    this.#apiKey = options.apiKey.trim()
    this.transport = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 3000
    this.maxAttempts = options.maxAttempts ?? 2
    this.retryDelayMs = options.retryDelayMs ?? 150
    if (
      !Number.isFinite(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      !Number.isInteger(this.maxAttempts) ||
      this.maxAttempts < 1 ||
      this.maxAttempts > 2 ||
      !Number.isFinite(this.retryDelayMs) ||
      this.retryDelayMs < 0
    )
      throw new JevError('INVALID_REQUEST')
  }

  async listModels(options: RequestOptions = {}): Promise<z.infer<typeof ModelListSchema>> {
    return this.request('/v1/models', undefined, (value) => ModelListSchema.parse(value), options)
  }

  async evaluate(input: JevRequest, options: RequestOptions = {}): Promise<JevResponse> {
    let request: JevRequest
    try {
      // Snapshot before the first await; a caller cannot mutate the questions in flight.
      request = structuredClone(JevRequestSchema.parse(input))
    } catch {
      throw new JevError('INVALID_REQUEST')
    }
    return this.request(
      '/v1/systemone',
      request,
      (value) => parseJevResponse(request, value),
      options
    )
  }

  private async request<T>(
    path: '/v1/models' | '/v1/systemone',
    body: JevRequest | undefined,
    parse: (data: unknown) => T,
    options: RequestOptions
  ): Promise<T> {
    const deadline =
      options.deadlineMs ?? Date.now() + this.timeoutMs * this.maxAttempts + this.retryDelayMs
    if (!Number.isFinite(deadline)) throw new JevError('INVALID_REQUEST')
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (options.signal?.aborted) throw new JevError('CANCELLED')
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new JevError('TIMEOUT')
      const controller = new AbortController()
      const signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal
      const timer = setTimeout(
        () => controller.abort('model_timeout'),
        Math.min(this.timeoutMs, remaining)
      )
      const interrupted = (): JevError =>
        new JevError(options.signal?.aborted ? 'CANCELLED' : 'TIMEOUT', !options.signal?.aborted)
      let abort!: () => void
      const stopped = new Promise<never>((_, reject) => {
        abort = () => reject(interrupted())
        signal.addEventListener('abort', abort, { once: true })
      })
      let failure: JevError | undefined
      try {
        const call = async (): Promise<T> => {
          const response = await this.transport(`https://api.typesafe.ai${path}`, {
            method: body ? 'POST' : 'GET',
            headers: {
              Authorization: `Bearer ${this.#apiKey}`,
              'Content-Type': 'application/json'
            },
            body: body ? JSON.stringify(body) : undefined,
            redirect: 'manual',
            signal
          })
          try {
            // A transport ignoring cancellation may return later. Its body is discarded below.
            if (signal.aborted) throw interrupted()
            if (response.status >= 300 && response.status < 400)
              throw new JevError('REDIRECT_REJECTED', false, response.status)
            if (response.status === 401 || response.status === 403)
              throw new JevError('AUTH_FAILED', false, response.status)
            if (response.status === 429) {
              const rawDelay = response.headers.get('retry-after')
              const retryAfter = rawDelay ? Number(rawDelay) * 1000 : undefined
              throw new JevError(
                'RATE_LIMITED',
                true,
                429,
                Number.isFinite(retryAfter) ? retryAfter : undefined
              )
            }
            if (response.status >= 500) throw new JevError('UNAVAILABLE', true, response.status)
            if (response.status !== 200) throw new JevError('HTTP_ERROR', false, response.status)
            const text = await responseText(response, signal, interrupted)
            if (signal.aborted) throw interrupted()
            try {
              return parse(JSON.parse(text))
            } catch {
              throw new JevError('INVALID_RESPONSE')
            }
          } finally {
            discardBody(response)
          }
        }
        // Bound the whole attempt, including headers, body and parsing. Abort signals alone
        // cannot guarantee completion for a transport that does not cooperate.
        return await Promise.race([call(), stopped])
      } catch (error) {
        if (error instanceof ModelCallError) throw error
        failure =
          error instanceof JevError
            ? error
            : error instanceof ModelTransportError
              ? new JevError(error.code, error.code === 'UNAVAILABLE' || error.code === 'TIMEOUT')
              : options.signal?.aborted
                ? new JevError('CANCELLED')
                : controller.signal.aborted
                  ? new JevError('TIMEOUT', true)
                  : new JevError('UNAVAILABLE', true)
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
      }
      if (!failure.retryable || attempt + 1 >= this.maxAttempts) throw failure
      const retryWait = Math.max(this.retryDelayMs, failure.retryAfterMs ?? 0)
      if (Date.now() + retryWait >= deadline) throw failure
      await delay(retryWait, options.signal)
    }
    throw new JevError('UNAVAILABLE')
  }
}
