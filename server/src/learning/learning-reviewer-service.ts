import { z } from 'zod'
import type { Postgres } from '../database/postgres'
import type { Server } from 'node:net'
import { EnterpriseLearningWorkerAuthority } from './learning-worker-authority'
import { EnterpriseLearningQueue } from './learning-queue'
import { EnterpriseLearningRepository } from './learning-repository'
import {
  EnterpriseLearningReviewerWorker,
  type EnterpriseLearningReviewerOptions
} from './learning-reviewer-worker'
import {
  StructuredLearningReviewer,
  type LearningReviewTransport
} from '../../../src/core/memory/learning-reviewer'
import { HttpLearningReviewTransport } from '../../../src/core/memory/learning-transport'
import { resolveLearningReviewModel } from '../../../src/core/memory/learning-model-configuration'
import { LearningSettingsSchema } from '../../../src/shared/contracts/learning-memory'
import { learningHash } from '../../../src/core/memory/learning-scope'

const Model = z.strictObject({
  id: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(128),
  baseURL: z.string().url(),
  apiKey: z.string().trim().min(1)
})
export interface EnterpriseLearningReviewerConfiguration extends Pick<
  EnterpriseLearningReviewerOptions,
  'monitorIntervalMs' | 'pollIntervalMs' | 'onOutcome'
> {
  models: readonly z.infer<typeof Model>[]
  fallbackModelId: string
}

/** Abort the model immediately; HTTP draining must finish before its databases are closed. */
export async function stopEnterpriseLearningService(
  server: (Pick<Server, 'close'> & { closeIdleConnections(): void }) | undefined,
  worker:
    | (Pick<EnterpriseLearningReviewerWorker, 'stop'> &
        Partial<Pick<EnterpriseLearningReviewerWorker, 'shutdown'>>)
    | undefined,
  databases: readonly Pick<Postgres, 'close'>[]
): Promise<void> {
  let learningStopped: Promise<void> | void
  try {
    learningStopped = worker?.shutdown ? worker.shutdown() : worker?.stop()
  } catch {
    learningStopped = Promise.reject(new Error('service_shutdown_failed'))
  }
  const serverClosed = server
    ? new Promise<void>((resolve, reject) => {
        try {
          server.close((error) => {
            if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING')
              reject(new Error('service_shutdown_failed'))
            else resolve()
          })
        } catch {
          reject(new Error('service_shutdown_failed'))
        }
      })
    : Promise.resolve()
  let idleCloseFailed = false
  try {
    server?.closeIdleConnections()
  } catch {
    idleCloseFailed = true
  }
  // Even failed worker shutdown must wait for actual HTTP draining. Attempt
  // every database close afterwards, including when another close throws.
  const stopped = await Promise.allSettled([learningStopped, serverClosed])
  const closed = await Promise.allSettled(
    databases.map((database) => Promise.resolve().then(() => database.close()))
  )
  if (idleCloseFailed || [...stopped, ...closed].some((result) => result.status === 'rejected'))
    throw new Error('service_shutdown_failed')
}

/** Trusted server configuration only. Ordinary device and administration connections cannot run this factory. */
export async function assertEnterpriseLearningWorkerRole(database: Postgres): Promise<void> {
  const role = (
    await database.pool.query(`SELECT current_user=session_user AS same_login,
    rolsuper,rolbypassrls,rolcreaterole,rolreplication,
    pg_has_role(session_user,'autoreply_learning_worker','MEMBER') AS worker_member,
    pg_has_role(session_user,'autoreply_admin','MEMBER') AS admin_member,
    EXISTS(SELECT 1 FROM pg_roles p WHERE (p.rolsuper OR p.rolbypassrls OR p.rolcreaterole) AND pg_has_role(session_user,p.oid,'MEMBER')) AS privileged_member
    FROM pg_roles WHERE rolname=session_user`)
  ).rows[0]
  if (
    !role ||
    !role.same_login ||
    role.rolsuper ||
    role.rolbypassrls ||
    role.rolcreaterole ||
    role.rolreplication ||
    role.admin_member ||
    role.privileged_member
  )
    throw new Error('privileged_learning_role_rejected')
  if (!role.worker_member) throw new Error('learning_worker_role_required')
}
/** Immutable host catalogue shared by reviewer and validator, with identical endpoint checks. */
export function createEnterpriseLearningReviewTransport(
  configuration: EnterpriseLearningReviewerConfiguration
): { transport: LearningReviewTransport; fingerprint: string } {
  const models = z.array(Model).min(1).max(20).parse(configuration.models)
  const fallbackModelId = configuration.fallbackModelId
  if (new Set(models.map((model) => model.id)).size !== models.length)
    throw new Error('learning_model_id_conflict')
  if (!models.some((model) => model.id === fallbackModelId))
    throw new Error('learning_model_not_configured')
  // Validate all endpoints before claiming any job or reserving tokens.
  const transports = new Map(
    models.map((model) => [
      model.id,
      new HttpLearningReviewTransport({
        baseURL: model.baseURL,
        model: model.model,
        apiKey: model.apiKey
      })
    ])
  )
  const hostModels = models.map((model) => ({
    id: model.id,
    provider: 'enterprise',
    modelName: model.model,
    baseURL: model.baseURL,
    apiKey: model.apiKey,
    capabilities: ['text'] as const
  }))
  const fingerprint = learningHash({
    models,
    fallbackModelId,
    reviewer: 'structured-learning-review-v1'
  })
  const transport: LearningReviewTransport = {
    complete: (request, signal) => {
      const settings = LearningSettingsSchema.parse({
        reviewModelId: request.reviewModelId,
        maxReviewInputTokens: request.maxInputTokens
      })
      const resolved = resolveLearningReviewModel(
        settings,
        hostModels,
        hostModels.find((model) => model.id === fallbackModelId) ?? null
      )
      return transports.get(resolved.modelId)!.complete(request, signal)
    }
  }
  return { transport, fingerprint }
}
export async function createEnterpriseLearningReviewer(
  database: Postgres,
  configuration: EnterpriseLearningReviewerConfiguration
): Promise<EnterpriseLearningReviewerWorker> {
  await assertEnterpriseLearningWorkerRole(database)
  const { transport, fingerprint } = createEnterpriseLearningReviewTransport(configuration)
  const authority = new EnterpriseLearningWorkerAuthority(database)
  const reviewer = new StructuredLearningReviewer(transport)
  return new EnterpriseLearningReviewerWorker(
    new EnterpriseLearningQueue(database, authority),
    new EnterpriseLearningRepository(authority),
    reviewer,
    {
      references: () => authority.references(),
      fingerprint: () => fingerprint,
      monitorIntervalMs: configuration.monitorIntervalMs,
      pollIntervalMs: configuration.pollIntervalMs,
      onOutcome: configuration.onOutcome
    }
  )
}
