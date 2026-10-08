import type { Postgres } from '../database/postgres'
import { randomUUID } from 'node:crypto'
import {
  assertEnterpriseLearningWorkerRole,
  createEnterpriseLearningReviewTransport,
  type EnterpriseLearningReviewerConfiguration
} from './learning-reviewer-service'
import { EnterpriseLearningWorkerAuthority } from './learning-worker-authority'
import { EnterpriseLearningMaintenanceService } from './learning-maintenance-service'
import { EnterpriseLearningValidationBudget } from './learning-validation-budget'
import {
  EnterpriseLearningMaintenanceWorker,
  type EnterpriseLearningMaintenanceOptions
} from './learning-maintenance-worker'

/** Privacy retention does not require a configured review or text model. */
export async function createEnterpriseLearningMaintenance(
  database: Postgres,
  options: Omit<EnterpriseLearningMaintenanceOptions, 'references'> & {
    review?: EnterpriseLearningReviewerConfiguration
  } = {}
): Promise<EnterpriseLearningMaintenanceWorker> {
  await assertEnterpriseLearningWorkerRole(database)
  const authority = new EnterpriseLearningWorkerAuthority(database)
  const { review, ...workerOptions } = options
  const model = review ? createEnterpriseLearningReviewTransport(review) : undefined
  return new EnterpriseLearningMaintenanceWorker(
    new EnterpriseLearningMaintenanceService(authority, {
      merge: model
        ? {
            budget: new EnterpriseLearningValidationBudget(database, authority),
            transport: model.transport,
            fingerprint: () => model.fingerprint,
            workerId: randomUUID(),
            monitorIntervalMs: review?.monitorIntervalMs
          }
        : undefined
    }),
    {
      ...workerOptions,
      references: () => authority.references()
    }
  )
}
