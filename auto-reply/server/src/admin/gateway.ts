import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { TextDecoder } from 'node:util'
import { z } from 'zod'
import { Id } from '../../../src/shared/contracts/identity'
import { AdminGatewayRequestSchema } from '../../../src/shared/contracts/admin-gateway'
import { AdminError, type Administration } from './administration'

type Operations = Pick<
  Administration,
  'identity' | 'runtimeStatus' | 'requestPauseAll' | 'pauseAllRequest' | 'pauseAllAccounts'
>
class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
  }
}
const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
function reply(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed) return
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  response.end(JSON.stringify(value))
}
async function readInput(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? ''))
    throw new GatewayError(415, 'json_required')
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.length
    if (length > 16384) throw new GatewayError(413, 'request_too_large')
    chunks.push(bytes)
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } catch {
    throw new GatewayError(400, 'invalid_json')
  }
}

/** Dedicated operator gateway. Every operation re-authenticates the mapped DB
 * login inside Administration; the bearer never grants an employee DB role.
 * No CORS, chat content, enrollment, resume, SQL or arbitrary command endpoint. */
export function createAdminGateway(
  admin: Operations,
  configuration: {
    tenantId: string
    token: string
  }
) {
  const tenant = Id.parse(configuration.tenantId)
  const key = digest(
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .parse(configuration.token)
  )
  let active = 0
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let admitted = false
    try {
      if (request.headers.origin) throw new GatewayError(403, 'origin_rejected')
      const match = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)
      if (!match || !timingSafeEqual(key, digest(match[1])))
        throw new GatewayError(401, 'unauthorized')
      if (request.url !== '/v1/admin/operations') throw new GatewayError(404, 'not_found')
      if (request.method !== 'POST') throw new GatewayError(405, 'post_required')
      if (active >= 8) throw new GatewayError(429, 'busy')
      active++
      admitted = true
      const input = AdminGatewayRequestSchema.parse(await readInput(request))
      let result: unknown
      switch (input.operation) {
        case 'identity':
          result = await admin.identity(tenant)
          break
        case 'runtime-status':
          result = await admin.runtimeStatus(tenant, input.input)
          break
        case 'request-pause-all':
          result = await admin.requestPauseAll(tenant, input.requestId)
          break
        case 'pause-all-request':
          result = await admin.pauseAllRequest(tenant, input.requestId)
          break
        case 'pause-all-accounts':
          result = await admin.pauseAllAccounts(tenant, input.requestId, input.input)
          break
      }
      reply(response, 200, { result })
    } catch (error) {
      if (error instanceof GatewayError) reply(response, error.status, { code: error.code })
      else if (error instanceof z.ZodError) reply(response, 400, { code: 'invalid_input' })
      else if (error instanceof AdminError && error.code === 'DENIED')
        reply(response, 403, { code: 'denied' })
      else if (error instanceof Error && error.message === 'bulk_pause_not_found')
        reply(response, 404, { code: 'pause_not_found' })
      else if (
        error instanceof Error &&
        ['invalid_bulk_pause_cursor', 'invalid_runtime_cursor'].includes(error.message)
      )
        reply(response, 400, { code: 'invalid_cursor' })
      else reply(response, 503, { code: 'operation_unconfirmed' })
    } finally {
      if (admitted) active--
    }
  }
}
