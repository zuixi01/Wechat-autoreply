import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  AccountPauseError,
  type AccountPauseAuthority
} from '../monitoring/account-pause-authority'
import {
  RuntimeMonitoringError,
  type RuntimeStatusAuthority
} from '../monitoring/runtime-status-authority'
import { RestorePauseError, type RestorePauseAuthority } from '../execution/restore-pause-authority'
import { RestoreInventoryError } from '../execution/restore-inventory-authority'
import { RestoreApplicationError } from '../execution/restore-application-authority'
import { RestoreRecoveryTargetError } from '../execution/restore-recovery-authority'
import { RestoreRecoveryCompletionError } from '../execution/restore-recovery-completion-authority'
import type { RequestSealAuthority } from '../execution/request-seal-authority'
import {
  RequestSealInputSchema,
  RequestSealAppliedSchema
} from '../../../src/shared/contracts/request-seal'
import { z } from 'zod'
import { AuthorityError, type AccountAuthority } from '../auth/account-authority'
import { ExecutionError, type ExecutionAuthority } from '../execution/execution-authority'
import {
  PermitRequestSchema,
  ExecutionReceiptSchema
} from '../../../src/shared/contracts/execution'
import { parseGenerationInput } from '../../../src/core/reply/generation-validation'
import { GenerationError } from '../generation/publication'
import type { GenerationService } from '../generation/generation-service'
import type { EnterpriseLearningManagement } from '../learning/learning-service'
import { LearningManagementOperations, LearningManagementError } from '../learning/learning-routes'
import { parseEditedReviewInput } from '../../../src/core/reply/edited-review-validation'
import { HumanPermitRequestSchema } from '../../../src/shared/contracts/human-confirmation'
import { AssessmentEvidenceRequestSchema } from '../../../src/shared/contracts/assessment-evidence'
import {
  DeviceReconciliationReportSchema,
  ReconciliationLookupSchema,
  ReconciliationAppliedSchema
} from '../../../src/shared/contracts/reconciliation'
import {
  ReconciliationError,
  type ReconciliationAuthority
} from '../execution/reconciliation-authority'

type Authority = Pick<AccountAuthority, 'register' | 'acquireLease' | 'heartbeat'>
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
  }
}
const Register = z.strictObject({
  enrollmentCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  agentId: z.string().uuid()
})
const Lease = z.strictObject({
  loginEpoch: z.number().int().nonnegative(),
  clientInstanceId: z.string().min(1).max(128)
})

function credential(request: IncomingMessage): string {
  const authorization = request.headers.authorization
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)
  if (!match) throw new HttpError(401, 'unauthorized')
  return match[1]
}
async function body(request: IncomingMessage, maximum = 65536): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? ''))
    throw new HttpError(415, 'json_required')
  let length = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += data.length
    if (length > maximum) throw new HttpError(413, 'request_too_large')
    chunks.push(data)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid_json')
  }
}
function respond(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  response.end(JSON.stringify(value))
}

/** No chat content, bearer credentials or upstream error objects are written to logs. */
export function createApplication(
  authority: Authority,
  options: {
    allowedOrigin?: string
    monitoring?: Pick<RuntimeStatusAuthority, 'report'>
    accountPause?: Pick<AccountPauseAuthority, 'challenge' | 'report'>
    learning?: Pick<EnterpriseLearningManagement, 'request'>
    restoration?: Pick<RestorePauseAuthority, 'challenge' | 'report' | 'lookup'> &
      Partial<
        Pick<RestorePauseAuthority, 'inventoryStart' | 'inventoryPage' | 'inventoryComplete'>
      > &
      Partial<
        Pick<
          RestorePauseAuthority,
          | 'applicationDecision'
          | 'applicationLatest'
          | 'applicationAcknowledge'
          | 'recoveryLatest'
          | 'recoveryResolutions'
          | 'recoveryObservationGrant'
          | 'recoveryAcknowledge'
        >
      >
    execution?: Pick<ExecutionAuthority, 'issue' | 'issueHuman' | 'settle'>
    reconciliation?: Pick<ReconciliationAuthority, 'challenge' | 'report' | 'decision' | 'applied'>
    requestSeals?: Pick<RequestSealAuthority, 'seal' | 'applied'>
    generation?: Pick<GenerationService, 'generate' | 'reviewEdited' | 'configuration'> &
      Partial<Pick<GenerationService, 'assessmentEvidence' | 'prepare'>>
  } = {}
) {
  const attempts = new Map<string, { count: number; expires: number }>()
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (request.headers.origin && request.headers.origin !== options.allowedOrigin)
        throw new HttpError(403, 'origin_rejected')
      const path = request.url?.split('?')[0]
      if (
        request.method === 'POST' &&
        ['/v1/runtime/pause/challenge', '/v1/runtime/pause/report'].includes(path ?? '')
      ) {
        const token = credential(request)
        if (!options.accountPause) throw new HttpError(503, 'service_unavailable')
        const input = await body(request, 8192)
        return respond(
          response,
          200,
          path === '/v1/runtime/pause/challenge'
            ? await options.accountPause.challenge(token, input)
            : await options.accountPause.report(token, input)
        )
      }
      if (request.method === 'POST' && path === '/v1/runtime/status') {
        const token = credential(request)
        if (!options.monitoring) throw new HttpError(503, 'service_unavailable')
        return respond(
          response,
          200,
          await options.monitoring.report(token, await body(request, 8192))
        )
      }
      if (
        request.method === 'POST' &&
        [
          '/v1/restorations/application/decision',
          '/v1/restorations/application/current',
          '/v1/restorations/application/acknowledge'
        ].includes(path ?? '')
      ) {
        const token = credential(request)
        const operation =
          path === '/v1/restorations/application/decision'
            ? 'applicationDecision'
            : path === '/v1/restorations/application/current'
              ? 'applicationLatest'
              : 'applicationAcknowledge'
        const handler: ((credential: string, input: unknown) => Promise<unknown>) | undefined =
          options.restoration?.[operation]
        if (!handler) throw new HttpError(503, 'restoration_not_configured')
        return respond(
          response,
          200,
          await handler.call(options.restoration, token, await body(request, 16384))
        )
      }
      if (
        request.method === 'POST' &&
        [
          '/v1/restorations/inventory/start',
          '/v1/restorations/inventory/page',
          '/v1/restorations/inventory/complete'
        ].includes(path ?? '')
      ) {
        const token = credential(request)
        const operation =
          path === '/v1/restorations/inventory/start'
            ? 'inventoryStart'
            : path === '/v1/restorations/inventory/page'
              ? 'inventoryPage'
              : 'inventoryComplete'
        const handler: ((credential: string, input: unknown) => Promise<unknown>) | undefined =
          options.restoration?.[operation]
        if (!handler) throw new HttpError(503, 'restoration_not_configured')
        return respond(
          response,
          200,
          await handler.call(
            options.restoration,
            token,
            await body(request, operation === 'inventoryPage' ? 524288 : 16384)
          )
        )
      }
      if (request.method === 'POST' && path === '/v1/restorations/recovery/current') {
        const token = credential(request)
        if (!options.restoration?.recoveryLatest)
          throw new HttpError(503, 'restoration_not_configured')
        return respond(
          response,
          200,
          await options.restoration.recoveryLatest(token, await body(request, 16384))
        )
      }
      if (request.method === 'POST' && path === '/v1/restorations/recovery/resolutions') {
        const token = credential(request)
        if (!options.restoration?.recoveryResolutions)
          throw new HttpError(503, 'restoration_not_configured')
        return respond(
          response,
          200,
          await options.restoration.recoveryResolutions(token, await body(request, 16384))
        )
      }
      if (request.method === 'POST' && path === '/v1/restorations/recovery/observation-grant') {
        const token = credential(request)
        if (!options.restoration?.recoveryObservationGrant)
          throw new HttpError(503, 'restoration_not_configured')
        return respond(
          response,
          200,
          await options.restoration.recoveryObservationGrant(token, await body(request, 16384))
        )
      }
      if (request.method === 'POST' && path === '/v1/restorations/recovery/acknowledge') {
        const token = credential(request)
        if (!options.restoration?.recoveryAcknowledge)
          throw new HttpError(503, 'restoration_not_configured')
        return respond(
          response,
          200,
          await options.restoration.recoveryAcknowledge(token, await body(request, 1048576))
        )
      }
      const learningOperation = LearningManagementOperations.find(
        (operation) => path === `/v1/learning/${operation}`
      )
      if (request.method === 'POST' && learningOperation) {
        const token = credential(request)
        if (!options.learning) throw new HttpError(503, 'learning_not_configured')
        const input = await body(request, 2097152)
        const controller = new AbortController()
        const disconnected = (): void => {
          if (!response.writableEnded) controller.abort('learning_client_disconnected')
        }
        response.once('close', disconnected)
        try {
          const result = await options.learning.request(
            token,
            learningOperation,
            input,
            controller.signal
          )
          if (!controller.signal.aborted) return respond(response, 200, result)
          return
        } finally {
          response.removeListener('close', disconnected)
        }
      }
      if (
        request.method === 'POST' &&
        [
          '/v1/restorations/challenge',
          '/v1/restorations/report',
          '/v1/restorations/lookup'
        ].includes(path ?? '')
      ) {
        const token = credential(request)
        if (!options.restoration) throw new HttpError(503, 'restoration_not_configured')
        const input = await body(request, 16384)
        return respond(
          response,
          200,
          path === '/v1/restorations/lookup'
            ? await options.restoration.lookup(token, input)
            : path === '/v1/restorations/challenge'
              ? await options.restoration.challenge(token, input)
              : await options.restoration.report(token, input)
        )
      }
      if (request.method === 'GET' && path === '/health') {
        return respond(response, 200, { service: 'autoreply', version: '0.1.0', status: 'alive' })
      }
      if (request.method === 'POST' && path === '/v1/devices/register') {
        const now = Date.now()
        for (const [key, value] of attempts) if (value.expires <= now) attempts.delete(key)
        const address = request.socket.remoteAddress ?? 'unknown'
        const entry = attempts.get(address) ?? { count: 0, expires: now + 60000 }
        entry.count++
        attempts.set(address, entry)
        if (entry.count > 10 || attempts.size > 10000)
          throw new HttpError(429, 'registration_rate_limited')
        const input = Register.parse(await body(request))
        return respond(response, 201, await authority.register(input.enrollmentCode, input.agentId))
      }
      if (request.method === 'POST' && path === '/v1/leases/acquire') {
        const token = credential(request)
        const input = Lease.parse(await body(request))
        return respond(
          response,
          200,
          await authority.acquireLease(token, input.loginEpoch, input.clientInstanceId)
        )
      }
      if (request.method === 'GET' && path === '/v1/device')
        return respond(response, 200, await authority.heartbeat(credential(request)))
      if (request.method === 'GET' && path === '/v1/configuration') {
        const token = credential(request)
        if (!options.generation) throw new HttpError(503, 'generation_not_configured')
        return respond(response, 200, await options.generation.configuration(token))
      }
      if (request.method === 'POST' && path === '/v1/replies/evidence') {
        const token = credential(request)
        if (!options.generation?.assessmentEvidence)
          throw new HttpError(503, 'generation_not_configured')
        return respond(
          response,
          200,
          await options.generation.assessmentEvidence(
            token,
            AssessmentEvidenceRequestSchema.parse(await body(request))
          )
        )
      }
      if (request.method === 'POST' && path === '/v1/replies/prepare') {
        const token = credential(request)
        if (!options.generation?.prepare) throw new HttpError(503, 'generation_not_configured')
        return respond(
          response,
          200,
          await options.generation.prepare(token, parseGenerationInput(await body(request, 262144)))
        )
      }
      if (
        request.method === 'POST' &&
        (path === '/v1/replies/generate' || path === '/v1/replies/review-edited')
      ) {
        const token = credential(request)
        if (!options.generation) throw new HttpError(503, 'generation_not_configured')
        const input = await body(request, 262144)
        const controller = new AbortController()
        const disconnected = (): void => {
          if (!response.writableEnded) controller.abort()
        }
        response.once('close', disconnected)
        try {
          const result =
            path === '/v1/replies/review-edited'
              ? await options.generation.reviewEdited(
                  token,
                  parseEditedReviewInput(input),
                  controller.signal
                )
              : await options.generation.generate(
                  token,
                  parseGenerationInput(input),
                  controller.signal
                )
          if (!controller.signal.aborted) return respond(response, 200, result)
          return
        } finally {
          response.removeListener('close', disconnected)
        }
      }
      if (request.method === 'POST' && path === '/v1/executions/issue' && options.execution) {
        const token = credential(request)
        return respond(
          response,
          201,
          await options.execution.issue(token, PermitRequestSchema.parse(await body(request)))
        )
      }
      if (request.method === 'POST' && path === '/v1/executions/issue-human' && options.execution) {
        return respond(
          response,
          201,
          await options.execution.issueHuman(
            credential(request),
            HumanPermitRequestSchema.parse(await body(request, 131072))
          )
        )
      }
      if (request.method === 'POST' && path === '/v1/executions/settle' && options.execution) {
        const token = credential(request)
        return respond(
          response,
          200,
          await options.execution.settle(token, ExecutionReceiptSchema.parse(await body(request)))
        )
      }
      if (
        request.method === 'POST' &&
        ['/v1/reconciliation/seal', '/v1/reconciliation/seal-applied'].includes(path ?? '')
      ) {
        const token = credential(request)
        if (!options.requestSeals) throw new HttpError(503, 'reconciliation_not_configured')
        const input = await body(request, 8192)
        return respond(
          response,
          200,
          path === '/v1/reconciliation/seal'
            ? await options.requestSeals.seal(token, RequestSealInputSchema.parse(input))
            : await options.requestSeals.applied(token, RequestSealAppliedSchema.parse(input))
        )
      }
      if (
        request.method === 'POST' &&
        [
          '/v1/reconciliation/challenge',
          '/v1/reconciliation/report',
          '/v1/reconciliation/decision',
          '/v1/reconciliation/applied'
        ].includes(path ?? '')
      ) {
        const token = credential(request)
        if (!options.reconciliation) throw new HttpError(503, 'reconciliation_not_configured')
        const input = await body(request, 8192)
        if (path === '/v1/reconciliation/decision')
          return respond(response, 200, {
            decision: await options.reconciliation.decision(
              token,
              ReconciliationLookupSchema.parse(input)
            )
          })
        if (path === '/v1/reconciliation/applied')
          return respond(
            response,
            200,
            await options.reconciliation.applied(token, ReconciliationAppliedSchema.parse(input))
          )
        return respond(
          response,
          200,
          path === '/v1/reconciliation/challenge'
            ? await options.reconciliation.challenge(token, PermitRequestSchema.parse(input))
            : await options.reconciliation.report(
                token,
                DeviceReconciliationReportSchema.parse(input)
              )
        )
      }
      throw new HttpError(404, 'not_found')
    } catch (error) {
      if (response.headersSent || response.destroyed) return
      if (error instanceof HttpError) return respond(response, error.status, { error: error.code })
      if (error instanceof LearningManagementError)
        return respond(response, error.status, { error: error.code })
      if (error instanceof z.ZodError) return respond(response, 400, { error: 'invalid_request' })
      if (error instanceof AuthorityError) {
        const status = error.code === 'DENIED' ? 401 : error.code === 'INVALID_REQUEST' ? 400 : 409
        return respond(response, status, { error: error.code })
      }
      if (error instanceof ExecutionError) return respond(response, 409, { error: error.code })
      if (error instanceof RuntimeMonitoringError)
        return respond(response, error.code === 'INVALID_REQUEST' ? 400 : 409, {
          error: error.code
        })
      if (error instanceof AccountPauseError)
        return respond(response, error.code === 'INVALID_REQUEST' ? 400 : 409, {
          error: error.code
        })
      if (error instanceof ReconciliationError) return respond(response, 409, { error: error.code })
      if (error instanceof RestorePauseError) return respond(response, 409, { error: error.code })
      if (error instanceof RestoreInventoryError)
        return respond(response, 409, { error: error.code })
      if (error instanceof RestoreApplicationError)
        return respond(response, 409, { error: error.code })
      if (error instanceof RestoreRecoveryTargetError)
        return respond(response, 409, { error: error.code })
      if (error instanceof RestoreRecoveryCompletionError)
        return respond(response, 409, { error: error.code })
      if (error instanceof GenerationError)
        return respond(response, error.code === 'GENERATION_OVERLOADED' ? 429 : 409, {
          error: error.code
        })
      respond(response, 503, { error: 'service_unavailable' })
    }
  }
}
