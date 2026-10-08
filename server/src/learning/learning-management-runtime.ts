import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { AccountAuthority, AuthorityError, tokenHash, type Scope } from '../auth/account-authority'
import type { Postgres } from '../database/postgres'
import type { LearningAccountAuthority } from './learning-account'
import { EnterpriseLearningWorkerAuthority } from './learning-worker-authority'
import { EnterpriseLearningMaintenanceService } from './learning-maintenance-service'
import {
  EnterpriseLearningProductValidation,
  type EnterpriseLearningProductValidationOptions
} from './learning-product-validation'
import { EnterpriseLearningValidationBudget } from './learning-validation-budget'
import { LearningOperationDrain } from '../../../src/core/memory/learning-operation-drain'
import {
  assertEnterpriseLearningWorkerRole,
  createEnterpriseLearningReviewTransport,
  type EnterpriseLearningReviewerConfiguration
} from './learning-reviewer-service'
import { LearningManagementError } from './learning-routes'
import { learningHash } from '../../../src/core/memory/learning-scope'
import type {
  LearningCurationReport,
  LearningValidationResult
} from '../../../src/shared/contracts/learning-memory'

function sameAccount(left: Scope, right: Scope): boolean {
  return (
    left.tenant_id === right.tenant_id &&
    left.account_id === right.account_id &&
    left.employee_id === right.employee_id &&
    left.platform === right.platform
  )
}
/** Both authorities remain necessary. A worker binding never lends authority to a revoked device. */
class DeviceWorkerAuthority implements LearningAccountAuthority {
  constructor(
    private readonly worker: EnterpriseLearningWorkerAuthority,
    private readonly devices: AccountAuthority,
    private readonly credential: string
  ) {}

  async reference(): Promise<string> {
    const device = await this.devices.authenticate(this.credential)
    for (const reference of await this.worker.references()) {
      try {
        const matches = await this.worker.withLockedAccount(
          reference,
          async (_db, scope) => sameAccount(device, scope),
          true
        )
        if (matches) return reference
      } catch (error) {
        if (!(error instanceof AuthorityError && error.code === 'DENIED')) throw error
      }
    }
    throw new AuthorityError('DENIED')
  }
  async withLockedAccount<T>(
    reference: string,
    operation: (db: PoolClient, scope: Scope) => Promise<T>,
    allowPaused = false
  ): Promise<T> {
    return this.worker.withLockedAccount(
      reference,
      async (db, scope) => {
        const caller = (
          await db.query('SELECT * FROM autoreply.authenticate_device($1)', [
            tokenHash(this.credential)
          ])
        ).rows[0] as Scope | undefined
        if (!caller || !sameAccount(caller, scope)) throw new AuthorityError('DENIED')
        // Account lock already held; caller may be another device from the same account.
        const current = await db.query(
          `SELECT 1 FROM agents WHERE tenant_id=$1 AND account_id=$2
        AND employee_id=$3 AND id=$4 AND token_hash=$5 AND revoked_at IS NULL FOR SHARE`,
          [
            scope.tenant_id,
            scope.account_id,
            scope.employee_id,
            caller.agent_id,
            tokenHash(this.credential)
          ]
        )
        if (!current.rowCount) throw new AuthorityError('DENIED')
        return operation(db, scope)
      },
      allowPaused
    )
  }
}

export interface LearningManagementRuntimeConfiguration {
  review?: EnterpriseLearningReviewerConfiguration
  validation?: Pick<EnterpriseLearningProductValidationOptions, 'text' | 'jevApiKey' | 'fetch'>
  now?: () => number
}
export interface EnterpriseLearningManagementRuntime {
  validate(
    credential: string,
    conversationId: string | null,
    id: string,
    revision: number,
    signal: AbortSignal
  ): Promise<LearningValidationResult>
  curate(
    credential: string,
    conversationId: string | null,
    dryRun: boolean,
    signal: AbortSignal
  ): Promise<LearningCurationReport>
  stop(): Promise<void>
}

/** Only host configuration and a verified dedicated login can create manual worker operations. */
export async function createEnterpriseLearningManagementRuntime(
  database: Postgres,
  devices: AccountAuthority,
  configuration: LearningManagementRuntimeConfiguration = {}
): Promise<EnterpriseLearningManagementRuntime> {
  await assertEnterpriseLearningWorkerRole(database)
  const worker = new EnterpriseLearningWorkerAuthority(database)
  const model = configuration.review
    ? createEnterpriseLearningReviewTransport(configuration.review)
    : undefined
  const validation = configuration.validation
    ? { ...configuration.validation, text: { ...configuration.validation.text } }
    : undefined
  const now = configuration.now
  const monitorIntervalMs = configuration.review?.monitorIntervalMs
  const workerId = randomUUID()
  const validatorVersion =
    model && validation
      ? learningHash({
          engine: 'enterprise-paired-jev-validator-v1',
          review: model.fingerprint,
          text: validation.text,
          decisionCredential: validation.jevApiKey
        })
      : undefined
  let stopped = false
  const controllers = new Set<AbortController>()
  const pending = new Set<Promise<unknown>>()
  const modelOperations = new LearningOperationDrain()
  async function run<T>(
    external: AbortSignal,
    execute: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (stopped) throw new LearningManagementError(409, 'learning_shutdown')
    const controller = new AbortController()
    controllers.add(controller)
    const signal = AbortSignal.any([external, controller.signal])
    const work = execute(signal)
    pending.add(work)
    try {
      return await work
    } finally {
      pending.delete(work)
      controllers.delete(controller)
    }
  }
  return {
    curate: (credential, conversationId, dryRun, external) =>
      run(external, async (signal) => {
        const authority = new DeviceWorkerAuthority(worker, devices, credential)
        const reference = await authority.reference()
        const service = new EnterpriseLearningMaintenanceService(authority, {
          now,
          merge: model
            ? {
                budget: new EnterpriseLearningValidationBudget(database, authority, { now }),
                transport: model.transport,
                fingerprint: () => model.fingerprint,
                workerId,
                monitorIntervalMs
              }
            : undefined
        })
        try {
          return await service.curate(reference, conversationId, { dryRun }, signal)
        } finally {
          void modelOperations.track(service.drain())
        }
      }),
    validate: (credential, conversationId, id, revision, external) =>
      run(external, async (signal) => {
        const authority = new DeviceWorkerAuthority(worker, devices, credential)
        const reference = await authority.reference()
        if (!model || !validation || !validatorVersion)
          throw new LearningManagementError(503, 'validation_unconfigured')
        const product = new EnterpriseLearningProductValidation(database, authority, {
          ...validation,
          now,
          riskTransport: model.transport,
          validatorVersion,
          workerId,
          monitorIntervalMs
        })
        try {
          return await product.validate(reference, conversationId, id, revision, signal)
        } finally {
          void modelOperations.track(product.drain())
        }
      }),
    stop: async () => {
      stopped = true
      for (const controller of controllers) controller.abort('learning_shutdown')
      await Promise.allSettled([...pending])
      await modelOperations.drain()
    }
  }
}
