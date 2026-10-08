import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { ServiceTransport } from './http/server-transport'
import { Postgres } from './database/postgres'
import { AccountAuthority } from './auth/account-authority'
import { RuntimeStatusAuthority } from './monitoring/runtime-status-authority'
import { AccountPauseAuthority } from './monitoring/account-pause-authority'
import { createApplication } from './http/application'
import { ExecutionAuthority } from './execution/execution-authority'
import { ReconciliationAuthority } from './execution/reconciliation-authority'
import { RestorePauseAuthority } from './execution/restore-pause-authority'
import { RequestSealAuthority } from './execution/request-seal-authority'
import { TypeSafeClient } from './decision/typesafe-client'
import { JevReplyPipeline } from './reply/jev-pipeline'
import { HttpTextGenerator } from './generation/text-generator'
import { GenerationService } from './generation/generation-service'
import { ModelCallAuthority } from './generation/model-call-authority'
import { loadPublication, GenerationError } from './generation/publication'
import {
  createEnterpriseLearningReviewer,
  stopEnterpriseLearningService
} from './learning/learning-reviewer-service'
import type { EnterpriseLearningReviewerWorker } from './learning/learning-reviewer-worker'
import { createEnterpriseLearningValidator } from './learning/learning-validator-service'
import type { EnterpriseLearningValidatorWorker } from './learning/learning-validator-worker'
import { createEnterpriseLearningMaintenance } from './learning/learning-maintenance-factory'
import type { EnterpriseLearningMaintenanceWorker } from './learning/learning-maintenance-worker'
import { EnterpriseLearningManagement } from './learning/learning-service'
import { LearningManagementError } from './learning/learning-routes'
import {
  createEnterpriseLearningManagementRuntime,
  type EnterpriseLearningManagementRuntime
} from './learning/learning-management-runtime'

/** Called only after the entrypoint validates basic configuration and TLS. */
export async function runManagementService(
  url: string,
  transport: ServiceTransport
): Promise<void> {
  const { host, port } = transport
  const database = new Postgres(url)
  let server: ReturnType<typeof createHttpServer> | undefined
  let learningManagement: EnterpriseLearningManagementRuntime | undefined
  let learningDatabase: Postgres | undefined
  let learningWorker: EnterpriseLearningReviewerWorker | undefined
  let learningValidator: EnterpriseLearningValidatorWorker | undefined
  let learningMaintenance: EnterpriseLearningMaintenanceWorker | undefined
  let shuttingDown: Promise<void> | undefined
  const cleanup = (): Promise<void> => {
    return (shuttingDown ??= stopEnterpriseLearningService(
      server,
      {
        stop: async () => {
          const results = await Promise.allSettled(
            [
              () => learningManagement?.stop(),
              () => learningWorker?.shutdown(),
              () => learningValidator?.shutdown(),
              () => learningMaintenance?.shutdown()
            ].map(async (stop) => stop())
          )
          if (results.some((result) => result.status === 'rejected'))
            throw new Error('service_shutdown_failed')
        }
      },
      [database, ...(learningDatabase ? [learningDatabase] : [])]
    ))
  }
  try {
    // Refuse accidentally running the normal service with migration/superuser credentials.
    const role = await database.pool.query(
      `SELECT current_user=session_user AS same_login,
     rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,
     pg_has_role(session_user,'autoreply_app','USAGE') AS app_member,
     pg_has_role(session_user,'autoreply_admin','MEMBER') AS admin_member,
     EXISTS(SELECT 1 FROM pg_roles p WHERE
       p.rolname IN ('autoreply_learning_worker','autoreply_jev_reviewer')
       AND pg_has_role(session_user,p.oid,'MEMBER')) AS separate_role_member,
     EXISTS(SELECT 1 FROM pg_roles p WHERE
       (p.rolsuper OR p.rolbypassrls OR p.rolcreaterole OR p.rolcreatedb OR p.rolreplication)
       AND pg_has_role(session_user,p.oid,'MEMBER')) AS privileged_member
     FROM pg_roles WHERE rolname=session_user`
    )
    if (
      !role.rows[0] ||
      !role.rows[0].same_login ||
      !role.rows[0].app_member ||
      role.rows[0]?.rolsuper ||
      role.rows[0]?.rolbypassrls ||
      role.rows[0]?.rolcreaterole ||
      role.rows[0]?.rolcreatedb ||
      role.rows[0]?.rolreplication ||
      role.rows[0]?.admin_member ||
      role.rows[0]?.separate_role_member ||
      role.rows[0]?.privileged_member
    ) {
      throw new Error('privileged_service_role_rejected')
    }
    const authority = new AccountAuthority(database)
    let generator: HttpTextGenerator | undefined
    const execution = new ExecutionAuthority(authority, async (db, scope) => {
      if (!generator) throw new GenerationError('CONFIGURATION_UNAVAILABLE')
      const publication = await loadPublication(db, scope)
      if (publication.textGeneratorVersion !== generator.version)
        throw new GenerationError('CONFIGURATION_CHANGED')
    })
    const textKey = process.env.TEXT_MODEL_API_KEY,
      textBase = process.env.TEXT_MODEL_BASE_URL,
      textModel = process.env.TEXT_MODEL_ID,
      textExpected = process.env.TEXT_MODEL_EXPECTED_ID
    let generation: GenerationService | undefined
    if (process.env.TYPESAFE_API_KEY && textKey && textBase && textModel && textExpected) {
      const modelCalls = new ModelCallAuthority(database, authority)
      generator = new HttpTextGenerator({
        apiKey: textKey,
        baseUrl: textBase,
        model: textModel,
        expectedModel: textExpected,
        fetch: modelCalls.transport('text', fetch, textExpected)
      })
      generation = new GenerationService(
        authority,
        execution,
        new JevReplyPipeline(
          new TypeSafeClient({
            apiKey: process.env.TYPESAFE_API_KEY,
            fetch: modelCalls.transport('jev')
          }),
          generator
        ),
        generator.version,
        10,
        modelCalls
      )
    }
    const learningUrl = process.env.LEARNING_DATABASE_URL
    const reviewKey = process.env.LEARNING_REVIEW_API_KEY ?? textKey
    const reviewBase = process.env.LEARNING_REVIEW_BASE_URL ?? textBase
    const reviewModel = process.env.LEARNING_REVIEW_MODEL_ID ?? textModel
    const reviewConfigurationId = process.env.LEARNING_REVIEW_CONFIGURATION_ID ?? reviewModel
    const application = createApplication(authority, {
      monitoring: new RuntimeStatusAuthority(authority),
      accountPause: new AccountPauseAuthority(authority),
      learning: new EnterpriseLearningManagement(database, authority, {
        modelDirectory: () =>
          learningManagement && reviewKey && reviewBase && reviewModel && reviewConfigurationId
            ? [{ id: reviewConfigurationId, label: reviewModel }]
            : [],
        validate: (...args) => {
          if (!learningManagement) throw new LearningManagementError(503, 'validation_unconfigured')
          return learningManagement.validate(...args)
        },
        curate: (...args) => {
          if (!learningManagement) throw new LearningManagementError(503, 'curation_unconfigured')
          return learningManagement.curate(...args)
        }
      }),
      restoration: new RestorePauseAuthority(authority),
      execution,
      generation,
      reconciliation: new ReconciliationAuthority(authority),
      requestSeals: new RequestSealAuthority(authority)
    })
    server = transport.tls
      ? createHttpsServer(transport.tls, application)
      : createHttpServer(application)
    server.requestTimeout = 10000
    server.headersTimeout = 5000
    server.maxRequestsPerSocket = 100
    if (learningUrl) {
      learningDatabase = new Postgres(learningUrl)
      learningManagement = await createEnterpriseLearningManagementRuntime(
        learningDatabase,
        authority,
        {
          review:
            reviewKey && reviewBase && reviewModel
              ? {
                  models: [
                    {
                      id: process.env.LEARNING_REVIEW_CONFIGURATION_ID ?? reviewModel,
                      apiKey: reviewKey,
                      baseURL: reviewBase,
                      model: reviewModel
                    }
                  ],
                  fallbackModelId: process.env.LEARNING_REVIEW_CONFIGURATION_ID ?? reviewModel
                }
              : undefined,
          validation:
            process.env.TYPESAFE_API_KEY && textKey && textBase && textModel && textExpected
              ? {
                  text: {
                    apiKey: textKey,
                    baseUrl: textBase,
                    model: textModel,
                    expectedModel: textExpected
                  },
                  jevApiKey: process.env.TYPESAFE_API_KEY
                }
              : undefined
        }
      )
      learningMaintenance = await createEnterpriseLearningMaintenance(learningDatabase, {
        review:
          reviewKey && reviewBase && reviewModel
            ? {
                models: [
                  {
                    id: process.env.LEARNING_REVIEW_CONFIGURATION_ID ?? reviewModel,
                    apiKey: reviewKey,
                    baseURL: reviewBase,
                    model: reviewModel
                  }
                ],
                fallbackModelId: process.env.LEARNING_REVIEW_CONFIGURATION_ID ?? reviewModel
              }
            : undefined,
        onOutcome: (outcome) => {
          if (outcome === 'failed')
            process.stderr.write(
              'Enterprise learning maintenance failed; inspect scoped maintenance status.\n'
            )
        }
      })
      if (reviewKey && reviewBase && reviewModel) {
        const id = process.env.LEARNING_REVIEW_CONFIGURATION_ID ?? reviewModel
        learningWorker = await createEnterpriseLearningReviewer(learningDatabase, {
          models: [{ id, apiKey: reviewKey, baseURL: reviewBase, model: reviewModel }],
          fallbackModelId: id,
          onOutcome: (outcome) => {
            if (outcome === 'failed')
              process.stderr.write(
                'Enterprise learning review failed; inspect scoped learning job status.\n'
              )
          }
        })
        if (process.env.TYPESAFE_API_KEY && textKey && textBase && textModel && textExpected) {
          learningValidator = await createEnterpriseLearningValidator(learningDatabase, {
            models: [{ id, apiKey: reviewKey, baseURL: reviewBase, model: reviewModel }],
            fallbackModelId: id,
            text: {
              apiKey: textKey,
              baseUrl: textBase,
              model: textModel,
              expectedModel: textExpected
            },
            jevApiKey: process.env.TYPESAFE_API_KEY,
            onOutcome: (outcome) => {
              if (outcome === 'failed')
                process.stderr.write(
                  'Enterprise learning validation failed; inspect scoped validation status.\n'
                )
            }
          })
        }
      } else {
        process.stdout.write(
          'Enterprise learning reviewer disabled: model configuration missing; maintenance remains enabled.\n'
        )
      }
    } else {
      process.stdout.write(
        'Enterprise learning reviewer disabled: dedicated database login or model configuration missing.\n'
      )
    }
    const listener = server
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject)
      listener.listen(port, host, () => {
        listener.removeListener('error', reject)
        resolve()
      })
    })
    const stop = (): void => {
      void cleanup().catch(() => {
        process.exitCode = 1
        process.stderr.write('Service shutdown failed.\n')
      })
    }
    listener.on('error', () => {
      process.exitCode = 1
      process.stderr.write('Service listener failed.\n')
      stop()
    })
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
    learningWorker?.start()
    learningValidator?.start()
    learningMaintenance?.start()
    process.stdout.write(`AutoReply management service listening on port ${port}\n`)
  } catch (error) {
    try {
      await cleanup()
    } catch {
      throw new Error('service_startup_cleanup_failed')
    }
    throw error
  }
}
