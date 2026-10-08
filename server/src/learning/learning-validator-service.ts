import { randomUUID } from 'node:crypto'
import type { Postgres } from '../database/postgres'
import { learningHash } from '../../../src/core/memory/learning-scope'
import { EnterpriseLearningWorkerAuthority } from './learning-worker-authority'
import {
  assertEnterpriseLearningWorkerRole,
  createEnterpriseLearningReviewTransport,
  type EnterpriseLearningReviewerConfiguration
} from './learning-reviewer-service'
import {
  EnterpriseLearningProductValidation,
  type EnterpriseLearningProductValidationOptions
} from './learning-product-validation'
import { EnterpriseLearningValidatorWorker } from './learning-validator-worker'

export interface EnterpriseLearningValidatorConfiguration extends EnterpriseLearningReviewerConfiguration {
  text: EnterpriseLearningProductValidationOptions['text']
  jevApiKey: string
}
/** Only a dedicated, unprivileged login can construct a production validator. */
export async function createEnterpriseLearningValidator(
  database: Postgres,
  configuration: EnterpriseLearningValidatorConfiguration
): Promise<EnterpriseLearningValidatorWorker> {
  await assertEnterpriseLearningWorkerRole(database)
  const { transport, fingerprint } = createEnterpriseLearningReviewTransport(configuration)
  const authority = new EnterpriseLearningWorkerAuthority(database)
  const product = new EnterpriseLearningProductValidation(database, authority, {
    text: configuration.text,
    jevApiKey: configuration.jevApiKey,
    riskTransport: transport,
    validatorVersion: learningHash({
      engine: 'enterprise-paired-jev-validator-v1',
      review: fingerprint,
      text: configuration.text,
      decisionCredential: configuration.jevApiKey
    }),
    workerId: randomUUID(),
    monitorIntervalMs: configuration.monitorIntervalMs
  })
  return new EnterpriseLearningValidatorWorker(product, {
    references: () => authority.references(),
    pollIntervalMs: configuration.pollIntervalMs,
    onOutcome: configuration.onOutcome
  })
}
