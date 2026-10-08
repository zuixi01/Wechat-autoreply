/** Optional loopback controls. A private token and a native HTTP client are required. */
import * as http from 'node:http'
import { timingSafeEqual } from 'node:crypto'

const PRIMARY_PORT = 12680
const FALLBACK_PORT = 12681

export type SkillStartReason =
  | 'capability_unverified'
  | 'no_vision_key'
  | 'no_provider'
  | 'missing_required_field'
  | 'engine_failed'
  | 'already_running'
  | 'wizard_cancelled'
  | 'mode_not_found'
  | 'default_mode_not_running'

export type SkillPauseReason = 'not_running' | 'pause_failed'

export interface SkillStartResult {
  ok: boolean
  reason?: SkillStartReason
  message?: string
}

export interface SkillPauseResult {
  ok: boolean
  reason?: SkillPauseReason
  message?: string
}

export interface SkillEngineController {
  /** 启动引擎；返回业务级结果，不抛异常 */
  start(): Promise<SkillStartResult>
  /** 暂停引擎；返回业务级结果，不抛异常 */
  pause(): Promise<SkillPauseResult>
  /** 查询当前是否在运行 */
  isRunning(): boolean
}

export function createSkillServer(
  engineController: SkillEngineController,
  token: string
): http.Server {
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error('skill_token_unavailable')
  const secret = Buffer.from(`Bearer ${token}`)
  let operationInProgress = false
  const respond = (res: http.ServerResponse, status: number, error?: string): void => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      Connection: 'close'
    })
    res.end(JSON.stringify(error ? { ok: false, error } : { ok: true }))
  }
  const authorized = (req: http.IncomingMessage): boolean => {
    // Browser requests, including simple POSTs, never control the desktop agent.
    if (
      req.headers.origin !== undefined ||
      req.headers.referer !== undefined ||
      Object.keys(req.headers).some((key) => key.startsWith('sec-fetch-'))
    )
      return false
    const address = instance.address()
    if (!address || typeof address === 'string') return false
    if (
      req.headers.host !== `127.0.0.1:${address.port}` &&
      req.headers.host !== `localhost:${address.port}`
    )
      return false
    const supplied = Buffer.from(req.headers.authorization ?? '')
    return supplied.length === secret.length && timingSafeEqual(supplied, secret)
  }
  const readEmptyBody = (req: http.IncomingMessage): Promise<void> =>
    new Promise((resolve, reject) => {
      let size = 0
      let body = ''
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 1024) {
          reject(new Error('body_too_large'))
          return
        }
        body += chunk.toString('utf8')
      })
      req.on('end', () => {
        if (body.trim() && body.trim() !== '{}') reject(new Error('invalid_body'))
        else resolve()
      })
      req.on('error', () => reject(new Error('invalid_body')))
      req.on('aborted', () => reject(new Error('invalid_body')))
    })
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (!authorized(req)) {
      respond(res, 403, 'control_unauthorized')
      return
    }
    const start = req.url === '/skill/start' && req.method === 'POST'
    const pause = req.url === '/skill/pause' && req.method === 'POST'
    const status = req.url === '/skill/status' && req.method === 'GET'
    if (!start && !pause && !status) {
      respond(res, 404, 'not_found')
      return
    }
    if (status) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        Connection: 'close'
      })
      res.end(
        JSON.stringify({ ok: true, status: engineController.isRunning() ? 'running' : 'stopped' })
      )
      return
    }
    try {
      await readEmptyBody(req)
    } catch (error) {
      const oversized = error instanceof Error && error.message === 'body_too_large'
      res.once('finish', () => req.destroy())
      respond(res, oversized ? 413 : 400, oversized ? 'body_too_large' : 'invalid_body')
      return
    }
    if (operationInProgress) {
      respond(res, 409, 'operation_in_progress')
      return
    }
    if (start && engineController.isRunning()) {
      respond(res, 409, 'already_running')
      return
    }
    // Pause always asks both runtimes to stop, even during startup or incomplete shutdown.
    operationInProgress = true
    try {
      const result = await (start ? engineController.start() : engineController.pause())
      if (result.ok) {
        respond(res, 200)
        return
      }
      const reason = result.reason || (start ? 'engine_failed' : 'pause_failed')
      const clientErrors = [
        'no_vision_key',
        'no_provider',
        'missing_required_field',
        'mode_not_found',
        'default_mode_not_running'
      ]
      const conflicts = [
        'capability_unverified',
        'already_running',
        'wizard_cancelled',
        'not_running'
      ]
      respond(
        res,
        clientErrors.includes(reason) ? 400 : conflicts.includes(reason) ? 409 : 500,
        reason
      )
    } catch {
      // Callback exceptions can contain model keys or customer text. Do not serialize or log them.
      respond(res, 500, start ? 'engine_failed' : 'pause_failed')
    } finally {
      operationInProgress = false
    }
  }
  const instance = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) respond(res, 500, 'internal_error')
      else res.destroy()
    })
  })
  instance.requestTimeout = 5000
  instance.headersTimeout = 5000
  instance.keepAliveTimeout = 1000
  instance.maxHeadersCount = 20
  return instance
}

let server: http.Server | null = null

export function startSkillServer(engineController: SkillEngineController): void {
  if (server) return
  const token = process.env.AUTOREPLY_LEGACY_SKILL_TOKEN
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
    console.warn('[Skill Server] 未配置有效的私有控制令牌，保持关闭。')
    return
  }
  const instance = createSkillServer(engineController, token)
  server = instance
  let triedFallback = false
  instance.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE' && !triedFallback && server === instance) {
      triedFallback = true
      instance.listen(FALLBACK_PORT, '127.0.0.1')
    } else {
      console.warn('[Skill Server] 本地控制接口无法启动。')
      instance.close()
      if (server === instance) server = null
    }
  })
  instance.listen(PRIMARY_PORT, '127.0.0.1')
}

export function stopSkillServer(): void {
  const instance = server
  server = null
  if (instance) {
    instance.close()
    instance.closeAllConnections()
  }
}
