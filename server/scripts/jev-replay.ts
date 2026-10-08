import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashContext } from '../../src/core/reply/hashes'
import { closePrivatePermissionWorker } from '../../src/core/persistence/private-backup-directory'
import { z } from 'zod'
import { Id } from '../../src/shared/contracts/identity'
import { validateFrozenReplayInputs } from '../../evals/jev/replay-input'
import { replayFrozenJevCases, type JevReplayArmArtifact } from '../../evals/jev/replay'
import { createJevReplayProviderFactory } from '../../evals/jev/replay-providers'
import { JevReplayJournal } from '../src/generation/jev-replay-journal'
import { JevBlindPacketSeals } from '../src/generation/jev-blind-packet-seals'
import { JevBlindLabelReviews } from '../src/generation/jev-blind-label-reviews'
import { JevCalibrationDeclarations } from '../src/generation/jev-calibration-declarations'
import { JevCalibratedHoldouts } from '../src/generation/jev-calibrated-holdouts'
import { EMPTY_ENTERPRISE_MEMORY_VERSION } from '../src/learning/learning-publication'
import {
  assertJevBlindReviewFreeze,
  PrivateBlindReviewPacketSchema,
  createJevBlindReview,
  importJevBlindLabels
} from '../../evals/jev/blind-review'
import { createPrivateOutput, writePrivateJson } from '../../evals/memory/private-files'
import { writeJevBlindReviewPages } from '../../evals/jev/private-review-pages'
import {
  readJevReplayArtifacts,
  writeJevReplayArtifactIndex
} from '../../evals/jev/private-artifacts'
import {
  readPrivateJevInput as readPrivateInput,
  readPrivateJevInputs
} from '../../evals/jev/private-inputs'
import { Postgres } from '../src/database/postgres'
import { Administration } from '../src/admin/administration'
import { textGeneratorVersion } from '../src/generation/text-generator'
import { writePrivateAdminOutput } from './private-admin-output'
import { prepareJevReplayCalibration } from '../../evals/jev/calibration-replay'
import { calibratePolicies } from '../../evals/jev/calibration'
import { JevSettlementClaimsSchema } from '../../evals/jev/settlement-reconciliation'

const ScopeOptions = z.strictObject({
  tenant: Id,
  account: Id,
  run: Id
})
const Path = z.string().min(1)
const Count = z
  .string()
  .regex(/^\d{1,6}$/)
  .transform(Number)
  .pipe(z.number().int().min(0).max(100000))
const PlanOptions = ScopeOptions.extend({ mode: z.literal('plan'), input: Path, out: Path })
const BlindOptions = ScopeOptions.extend({
  mode: z.literal('blind'),
  input: Path,
  artifacts: Path,
  priors: Path,
  rubric: Id,
  kind: z.enum(['business', 'synthetic']),
  out: Path
})
const ImportOptions = ScopeOptions.extend({
  mode: z.literal('import'),
  packet: Path,
  artifacts: Path,
  labels: Path,
  'review-id': z.uuid(),
  out: Path
})
const CalibrationOptions = ImportOptions.extend({ mode: z.literal('calibrate'), settings: Path })
const FreezeHoldoutOptions = CalibrationOptions.extend({
  mode: z.literal('freeze-holdout'),
  'policy-version': Id,
  'config-version': Id
})
const VerifyHoldoutOptions = ScopeOptions.extend({
  mode: z.literal('verify-holdout'),
  request: Path,
  out: Path
})
const CorrelateSettlementsOptions = VerifyHoldoutOptions.extend({
  mode: z.literal('correlate-settlements'),
  settlements: Path
})
const HoldoutEvidenceFiles = z.strictObject({
  calibration: z.strictObject({
    packet: Path,
    artifacts: Path,
    labels: Path,
    settings: Path,
    reviewId: z.uuid(),
    policyVersion: Id,
    configVersion: Id
  }),
  holdout: z.strictObject({ packet: Path, artifacts: Path, labels: Path, reviewId: z.uuid() })
})
const DeclareOptions = ScopeOptions.extend({
  mode: z.literal('declare'),
  settings: Path,
  out: Path
})
const ReviewOptions = ScopeOptions.extend({
  mode: z.literal('review-submit'),
  'packet-id': z.uuid(),
  labels: Path,
  out: Path
})
const ExecuteOptions = ScopeOptions.extend({
  mode: z.literal('execute'),
  input: Path,
  out: Path,
  'max-attempts': Count.refine((n) => n > 0)
})
const LimitOptions = ScopeOptions.omit({ run: true }).extend({
  mode: z.literal('limit'),
  'daily-attempt-limit': Count
})
const Options = z.discriminatedUnion('mode', [
  PlanOptions,
  BlindOptions,
  ImportOptions,
  CalibrationOptions,
  FreezeHoldoutOptions,
  VerifyHoldoutOptions,
  CorrelateSettlementsOptions,
  DeclareOptions,
  ReviewOptions,
  ExecuteOptions,
  LimitOptions
])

function parseOptions(args: string[]): z.infer<typeof Options> {
  const schema =
    args[0] === 'plan'
      ? PlanOptions
      : args[0] === 'blind'
        ? BlindOptions
        : args[0] === 'import'
          ? ImportOptions
          : args[0] === 'calibrate'
            ? CalibrationOptions
            : args[0] === 'freeze-holdout'
              ? FreezeHoldoutOptions
              : args[0] === 'verify-holdout'
                ? VerifyHoldoutOptions
                : args[0] === 'correlate-settlements'
                  ? CorrelateSettlementsOptions
                  : args[0] === 'declare'
                    ? DeclareOptions
                    : args[0] === 'review-submit'
                      ? ReviewOptions
                      : args[0] === 'execute'
                        ? ExecuteOptions
                        : args[0] === 'limit'
                          ? LimitOptions
                          : null
  if (!schema || args.length % 2 !== 1) throw new Error('usage')
  const values: Record<string, string> = { mode: args[0] }
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i].slice(2)
    if (
      !args[i].startsWith('--') ||
      !(key in schema.shape) ||
      key in values ||
      args[i + 1].startsWith('--')
    )
      throw new Error('usage')
    values[key] = args[i + 1]
  }
  return Options.parse(values)
}

export interface JevReplayCommandDependencies {
  environment?: Readonly<Record<string, string | undefined>>
  connect?: (connection: string) => Postgres
  fetch?: typeof fetch
  stdout?: (text: string) => void
  signal?: AbortSignal
}

/** The CLI and integration tests use the same command workflow. Injection is
 * available only to code callers, never through user-supplied CLI flags. */
export async function runJevReplayCommand(
  args: string[],
  dependencies: JevReplayCommandDependencies = {}
): Promise<number> {
  const environment = { ...(dependencies.environment ?? process.env) }
  const write =
    dependencies.stdout ??
    ((text: string): void => {
      process.stdout.write(text)
    })
  if (args.length === 1 && args[0] === '--help') {
    write(
      'eval:jev plan --tenant ID --account ID --run ID --input PRIVATE_JSON --out NEW_PRIVATE_JSON\n' +
        'eval:jev blind --tenant ID --account ID --run ID --input PRIVATE_JSON --artifacts PRIVATE_JSON --priors PRIVATE_JSON --rubric ID --kind business|synthetic --out NEW_PRIVATE_DIRECTORY\n' +
        'eval:jev review-submit --tenant ID --account ID --run ID --packet-id UUID --labels PRIVATE_JSON --out NEW_PRIVATE_DIRECTORY\n' +
        'eval:jev import --tenant ID --account ID --run ID --packet PRIVATE_JSON --artifacts PRIVATE_JSON --labels PRIVATE_JSON --review-id UUID --out NEW_PRIVATE_DIRECTORY\n' +
        'eval:jev calibrate --tenant ID --account ID --run ID --packet PRIVATE_JSON --artifacts PRIVATE_JSON --labels PRIVATE_JSON --review-id UUID --settings PRIVATE_JSON --out NEW_PRIVATE_DIRECTORY\n' +
        'eval:jev declare --tenant ID --account ID --run ID --settings PRIVATE_JSON --out NEW_PRIVATE_DIRECTORY\n' +
        'eval:jev freeze-holdout --tenant ID --account ID --run SOURCE_RUN --packet PRIVATE_JSON --artifacts PRIVATE_JSON --labels PRIVATE_JSON --review-id UUID --settings PRIVATE_JSON --policy-version NEW_ID --config-version NEW_ID --out NEW_PRIVATE_DIRECTORY\n' +
        'eval:jev verify-holdout --tenant ID --account ID --run SOURCE_RUN --request PRIVATE_JSON --out NEW_PRIVATE_DIRECTORY\n' +
        'eval:jev correlate-settlements --tenant ID --account ID --run SOURCE_RUN --request PRIVATE_JSON --settlements PRIVATE_JSON --out NEW_PRIVATE_DIRECTORY\n' +
        'eval:jev limit --tenant ID --account ID --daily-attempt-limit INTEGER\n' +
        'eval:jev execute --tenant ID --account ID --run ID --input PRIVATE_JSON --out NEW_PRIVATE_DIRECTORY --max-attempts INTEGER\n' +
        'Uses authenticated database freezes and one complete calibration/holdout split. Execute runs evaluation-only A/B/C; no messages are sent.\n' +
        'Review-submit uses REVIEW_DATABASE_URL only, with an independent account-scoped reviewer login. Other modes require ADMIN_DATABASE_URL and TEXT_MODEL_BASE_URL/ID/EXPECTED_ID. Cases/labels limit: 16 MiB; artifacts/packets: 64 MiB.\n' +
        'Plan/blind/review-submit/import/declare/calibrate/freeze-holdout/verify-holdout/correlate-settlements/limit never call a model. Declare fixes candidates before any execution; calibrate requires the matching declaration and complete calibration split. Freeze-holdout recomputes the recommendation in one transaction and reserves untouched original holdout groups for a new evaluation-only freeze. Verify-holdout authenticates both complete datasets, retains distinct snapshots and computes holdout-only statistics; it exits 2 pending real billing and business admission. Correlate-settlements rechecks live central evidence and associates normalized fee claims under the same account transaction; supplier authenticity and admission remain unverified, and it always exits 2. Execute requires JEV_API_KEY and TEXT_MODEL_API_KEY and configured central attempt limits; it can incur model charges.\n' +
        'Limits count HTTP attempts, not money. Unknown usage/fees stay unknown; no automatic paid resume, sending or release authorization. Execute exits 2 pending billing/business review.\n'
    )
    return 0
  }
  const options = parseOptions(args)
  if (dependencies.signal?.aborted) throw new Error('evaluation_cancelled')
  const connection =
    options.mode === 'review-submit'
      ? environment.REVIEW_DATABASE_URL
      : environment.ADMIN_DATABASE_URL
  if (!connection?.trim())
    throw new Error(
      options.mode === 'review-submit'
        ? 'reviewer_configuration_required'
        : 'administrator_configuration_required'
    )
  const db = (dependencies.connect ?? ((value: string) => new Postgres(value)))(connection)
  try {
    if (options.mode === 'review-submit') {
      const receipt = await new JevBlindLabelReviews(db).submit({
        tenantId: options.tenant,
        accountId: options.account,
        runId: options.run,
        packetId: options['packet-id'],
        labels: await readPrivateInput(options.labels)
      })
      const directory = await createPrivateOutput(options.out)
      await writePrivateJson(join(directory, 'review-receipt.private.json'), receipt)
      await writePrivateJson(join(directory, 'status.json'), {
        mode: 'independent_labels_recorded',
        reviewId: receipt.reviewId,
        revision: receipt.revision,
        modelsCalled: false,
        releaseAuthorized: false
      })
      write('Independent reviewer labels recorded. No models called or messages sent.\n')
      return 0
    }
    const generatorVersion = textGeneratorVersion({
      baseUrl: environment.TEXT_MODEL_BASE_URL ?? '',
      model: environment.TEXT_MODEL_ID ?? '',
      expectedModel: environment.TEXT_MODEL_EXPECTED_ID ?? ''
    })
    if (options.mode === 'limit') {
      await new JevReplayJournal(db, generatorVersion).setLimit(options.tenant, options.account, {
        dailyAttemptLimit: options['daily-attempt-limit']
      })
      write(
        'Central Jev evaluation attempt limit updated. Existing usage is retained; no models called.\n'
      )
      return 0
    }
    const frozen = await new Administration(db, generatorVersion).readFrozenEvaluation(
      options.tenant,
      options.account,
      options.run
    )
    if (options.mode === 'declare') {
      const receipt = await new JevCalibrationDeclarations(db, generatorVersion).declare({
        tenantId: options.tenant,
        accountId: options.account,
        runId: options.run,
        settings: await readPrivateInput(options.settings)
      })
      const directory = await createPrivateOutput(options.out)
      await writePrivateJson(join(directory, 'declaration-receipt.private.json'), receipt)
      await writePrivateJson(join(directory, 'status.json'), {
        mode: 'calibration_candidates_declared',
        modelsCalled: false,
        candidatePredeclarationVerified: true,
        monetaryBudgetVerified: false,
        releaseAuthorized: false
      })
      write(
        'Calibration candidates declared before execution. No models called or sending authorized.\n'
      )
      return 0
    }
    if (options.mode === 'freeze-holdout') {
      const packet = await readPrivateInput(options.packet, 64 * 1048576)
      assertJevBlindReviewFreeze(frozen, packet)
      const parsed = PrivateBlindReviewPacketSchema.parse(packet)
      if (parsed.input.split !== 'calibration') throw new Error('calibration_split_required')
      const artifacts = await readJevReplayArtifacts(
        options.artifacts,
        readPrivateInput,
        {
          runId: frozen.runId,
          datasetId: parsed.input.datasetId,
          split: parsed.input.split,
          inputHash: hashContext(parsed.input)
        },
        readPrivateJevInputs
      )
      const result = await new JevCalibratedHoldouts(db, generatorVersion).freeze({
        tenantId: options.tenant,
        accountId: options.account,
        runId: options.run,
        packet,
        artifacts,
        labels: await readPrivateInput(options.labels),
        settings: await readPrivateInput(options.settings),
        reviewId: options['review-id'],
        policyVersion: options['policy-version'],
        configVersion: options['config-version']
      })
      const directory = await createPrivateOutput(options.out)
      await writePrivateJson(join(directory, 'holdout-receipt.private.json'), result.receipt)
      await writePrivateJson(join(directory, 'publication.private.json'), result.publication)
      await writePrivateJson(join(directory, 'calibration-report.private.json'), result.calibration)
      await writePrivateJson(join(directory, 'status.json'), {
        mode: 'calibrated_holdout_frozen',
        targetRunId: result.receipt.targetRunId,
        modelsCalled: false,
        monetaryBudgetVerified: false,
        releaseAuthorized: false
      })
      write(
        'Untouched holdout reserved for the derived evaluation-only freeze. No model calls, publication activation or sending authorization.\n'
      )
      return 0
    }
    if (options.mode === 'verify-holdout' || options.mode === 'correlate-settlements') {
      const files = HoldoutEvidenceFiles.parse(await readPrivateInput(options.request))
      const calibrationPacket = PrivateBlindReviewPacketSchema.parse(
        await readPrivateInput(files.calibration.packet, 64 * 1048576)
      )
      assertJevBlindReviewFreeze(frozen, calibrationPacket)
      const holdoutPacket = PrivateBlindReviewPacketSchema.parse(
        await readPrivateInput(files.holdout.packet, 64 * 1048576)
      )
      const readArtifacts = (
        path: string,
        packet: z.infer<typeof PrivateBlindReviewPacketSchema>
      ): ReturnType<typeof readJevReplayArtifacts> =>
        readJevReplayArtifacts(
          path,
          readPrivateInput,
          {
            runId: packet.frozen.runId,
            datasetId: packet.input.datasetId,
            split: packet.input.split,
            inputHash: hashContext(packet.input)
          },
          readPrivateJevInputs
        )
      const evidence = {
        calibration: {
          tenantId: options.tenant,
          accountId: options.account,
          runId: options.run,
          packet: calibrationPacket,
          artifacts: await readArtifacts(files.calibration.artifacts, calibrationPacket),
          labels: await readPrivateInput(files.calibration.labels),
          settings: await readPrivateInput(files.calibration.settings),
          reviewId: files.calibration.reviewId,
          policyVersion: files.calibration.policyVersion,
          configVersion: files.calibration.configVersion
        },
        holdout: {
          packet: holdoutPacket,
          artifacts: await readArtifacts(files.holdout.artifacts, holdoutPacket),
          labels: await readPrivateInput(files.holdout.labels),
          reviewId: files.holdout.reviewId
        }
      }
      const service = new JevCalibratedHoldouts(db, generatorVersion)
      if (options.mode === 'correlate-settlements') {
        const claims = JevSettlementClaimsSchema.safeParse(
          await readPrivateInput(options.settlements, 64 * 1048576)
        )
        if (!claims.success) throw new Error('jev_settlement_request_invalid')
        const result = await service.correlateSettlements({
          evidence,
          settlements: claims.data
        })
        const directory = await createPrivateOutput(options.out)
        await writePrivateJson(join(directory, 'correlated-evidence.private.json'), result)
        await writePrivateJson(join(directory, 'status.json'), {
          mode: 'central_settlement_correlation_pending_authentication',
          sourceRunId: result.verifiedEvidence.lineage.sourceRunId,
          targetRunId: result.verifiedEvidence.lineage.targetRunId,
          evidenceHash: result.verifiedEvidence.evidenceHash,
          correlationHash: result.correlationHash,
          centralEvidenceVerified: true,
          settlementStatus: result.settlementReport.status,
          declaredBudgetStatus: result.settlementReport.declaredBudgetAssessment.status,
          statisticalAssessment:
            result.verifiedEvidence.statisticalEvaluation?.holdout.assessment.status ??
            'usage_incomplete',
          modelsCalled: false,
          rawExportContentVerified: false,
          supplierAuthenticityVerified: false,
          providerBillingAccountVerified: false,
          monetaryBudgetVerified: false,
          releaseAuthorized: false
        })
        write(
          'Live central evidence correlated with normalized settlement claims. Supplier authenticity and business admission remain unverified; no model calls or sending authorization.\n'
        )
        return 2
      }
      const result = await service.verify(evidence)
      const directory = await createPrivateOutput(options.out)
      await writePrivateJson(join(directory, 'verified-evidence.private.json'), result)
      if (result.statisticalEvaluation)
        await writePrivateJson(
          join(directory, 'statistical-report.private.json'),
          result.statisticalEvaluation
        )
      await writePrivateJson(join(directory, 'status.json'), {
        mode: 'calibrated_holdout_verified_pending_admission',
        sourceRunId: result.lineage.sourceRunId,
        targetRunId: result.lineage.targetRunId,
        evidenceHash: result.evidenceHash,
        centralEvidenceVerified: true,
        statisticalAssessment:
          result.statisticalEvaluation?.holdout.assessment.status ?? 'usage_incomplete',
        modelsCalled: false,
        monetaryBudgetVerified: false,
        releaseAuthorized: false
      })
      write(
        'Calibrated holdout evidence and statistics verified. Real billing and business admission remain required; no model calls or sending authorization.\n'
      )
      return 2
    }
    if (options.mode === 'execute') {
      if (
        frozen.publication.memoryManifest?.length ||
        (frozen.publication.memoryCorpusVersion &&
          frozen.publication.memoryCorpusVersion !== EMPTY_ENTERPRISE_MEMORY_VERSION)
      )
        throw new Error('jev_replay_enterprise_memory_not_supported')
      const Key = z
        .string()
        .trim()
        .min(1)
        .refine((value) => !/[\r\n]/.test(value))
      const jevApiKey = Key.parse(environment.JEV_API_KEY)
      const text = {
        apiKey: Key.parse(environment.TEXT_MODEL_API_KEY),
        baseUrl: environment.TEXT_MODEL_BASE_URL ?? '',
        model: environment.TEXT_MODEL_ID ?? '',
        expectedModel: environment.TEXT_MODEL_EXPECTED_ID ?? ''
      }
      const rawCases = await readPrivateInput(options.input)
      validateFrozenReplayInputs(frozen, rawCases, generatorVersion)
      const journal = new JevReplayJournal(db, generatorVersion)
      const limit = await journal.readLimit(options.tenant, options.account)
      if (!limit || !limit.remainingAttempts) throw new Error('attempt_limit_unavailable')
      const directory = await createPrivateOutput(options.out)
      const prepared = await journal.begin({
        tenantId: options.tenant,
        accountId: options.account,
        runId: options.run,
        fullRawCases: rawCases,
        maxRunAttempts: options['max-attempts']
      })
      await writePrivateJson(join(directory, 'execution.private.json'), {
        executionId: prepared.executionId,
        frozen: prepared.source,
        input: prepared.input,
        maximumRunAttempts: options['max-attempts'],
        accountAttemptLimit: limit,
        monetaryBudgetVerified: false,
        releaseAuthorized: false
      })
      let modelsCalled = false
      const network = dependencies.fetch ?? fetch
      const factory = createJevReplayProviderFactory(
        prepared.source,
        {
          jevApiKey,
          text,
          fetch: (url, init) => {
            modelsCalled = true
            return network(url, init)
          }
        },
        journal
      )
      const controller = new AbortController()
      const signal = dependencies.signal
        ? AbortSignal.any([controller.signal, dependencies.signal])
        : controller.signal
      const stop = (): void => controller.abort('operator_cancelled')
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
      const artifacts: JevReplayArmArtifact[] = []
      try {
        await replayFrozenJevCases(
          {
            frozen: prepared.source,
            rawCases: prepared.input,
            identity: {
              ...prepared.source.authenticatedScope,
              agentId: 'isolated-jev-evaluator',
              loginEpoch: 0,
              clientInstanceId: prepared.executionId
            }
          },
          async (assignment) => {
            await journal.bindAssignment(assignment)
            return factory(assignment)
          },
          {
            textGeneratorVersion: generatorVersion,
            signal,
            onArm: async (artifact) => {
              await writePrivateJson(
                join(directory, `${artifact.assignmentId}.private.json`),
                artifact
              )
              artifacts.push(artifact)
              if (artifact.status !== 'invalid' && artifact.status !== 'cancelled') {
                await journal.sealArtifact(
                  {
                    ...prepared.source.authenticatedScope,
                    runId: artifact.runId,
                    caseId: artifact.caseId,
                    arm: artifact.arm,
                    assignmentId: artifact.assignmentId,
                    executionPlanHash: artifact.executionPlanHash,
                    snapshotHash: artifact.snapshotHash,
                    inputHash: artifact.inputHash
                  },
                  artifact
                )
              }
            }
          }
        )
        const artifactIndex = await writeJevReplayArtifactIndex(
          directory,
          {
            executionId: prepared.executionId,
            runId: prepared.source.runId,
            datasetId: prepared.input.datasetId,
            split: prepared.input.split,
            inputHash: hashContext(prepared.input)
          },
          artifacts
        )
        await writePrivateJson(join(directory, 'status.json'), {
          mode: 'awaiting_billing_and_independent_labels',
          modelsCalled,
          cases: prepared.input.cases.length,
          completedArms: artifacts.length,
          artifactInput: artifactIndex.file,
          aggregateAvailable: artifactIndex.aggregateAvailable,
          usageComplete: artifacts.every((a) => a.usage !== null),
          monetaryBudgetVerified: false,
          billedCostMicros: null,
          releaseAuthorized: false
        })
        write(
          'A/B/C drafts recorded privately. Billing and independent business review remain required; no messages sent.\n'
        )
      } catch {
        await writePrivateJson(join(directory, 'status.json'), {
          mode: 'execution_incomplete',
          modelsCalled,
          savedArms: artifacts.length,
          monetaryBudgetVerified: false,
          billedCostMicros: null,
          releaseAuthorized: false,
          automaticPaidResumeSupported: false
        })
        throw new Error('evaluation_incomplete')
      } finally {
        controller.abort('evaluation_finished')
        process.removeListener('SIGINT', stop)
        process.removeListener('SIGTERM', stop)
      }
      return 2
    }
    if (options.mode === 'blind') {
      const rawCases = await readPrivateInput(options.input)
      const { input } = validateFrozenReplayInputs(frozen, rawCases, generatorVersion)
      const packetSeals = new JevBlindPacketSeals(db, generatorVersion)
      await packetSeals.assertCanCreate({
        tenantId: options.tenant,
        accountId: options.account,
        runId: options.run,
        split: input.split
      })
      const artifacts = await readJevReplayArtifacts(
        options.artifacts,
        readPrivateInput,
        {
          runId: frozen.runId,
          datasetId: input.datasetId,
          split: input.split,
          inputHash: hashContext(input)
        },
        readPrivateJevInputs
      )
      const result = createJevBlindReview({
        frozen,
        rawCases,
        artifacts,
        priorAnnotations: await readPrivateInput(options.priors),
        dataKind: options.kind,
        rubricRef: options.rubric
      })
      const directory = await createPrivateOutput(options.out)
      await writePrivateJson(join(directory, 'sealed-mapping.private.json'), result.privatePacket)
      const reviewView = await writeJevBlindReviewPages(directory, result.blind)
      const centralReceipt = await packetSeals.seal({
        tenantId: options.tenant,
        accountId: options.account,
        runId: options.run,
        packet: result.privatePacket,
        artifacts
      })
      await writePrivateJson(join(directory, 'status.json'), {
        mode: 'blind_review_ready',
        modelsCalled: false,
        centralReceipt,
        reviewerInput: reviewView.file,
        reviewerFormat: reviewView.kind,
        releaseAuthorized: false
      })
      write(
        'Private blind-review files written. Keep the mapping separate from reviewers. No model calls or sending.\n'
      )
      return 0
    }
    if (options.mode === 'import' || options.mode === 'calibrate') {
      const packet = await readPrivateInput(options.packet, 64 * 1048576)
      assertJevBlindReviewFreeze(frozen, packet)
      const parsedPacket = PrivateBlindReviewPacketSchema.parse(packet)
      const { input } = parsedPacket
      if (options.mode === 'calibrate' && input.split !== 'calibration')
        throw new Error('calibration_split_required')
      const calibrationSettings =
        options.mode === 'calibrate' ? await readPrivateInput(options.settings) : null
      const declarations = new JevCalibrationDeclarations(db, generatorVersion)
      const declarationRequest = {
        tenantId: options.tenant,
        accountId: options.account,
        runId: options.run,
        settings: calibrationSettings
      }
      if (options.mode === 'calibrate') await declarations.verify(declarationRequest)
      const labels = await readPrivateInput(options.labels)
      const reviews = new JevBlindLabelReviews(db)
      const reviewRequest = {
        tenantId: options.tenant,
        accountId: options.account,
        runId: options.run,
        packetId: parsedPacket.packetId,
        packetHash: parsedPacket.packetHash,
        reviewId: options['review-id'],
        labels
      }
      await reviews.verify(reviewRequest)
      const artifacts = await readJevReplayArtifacts(
        options.artifacts,
        readPrivateInput,
        {
          runId: frozen.runId,
          datasetId: input.datasetId,
          split: input.split,
          inputHash: hashContext(input)
        },
        readPrivateJevInputs
      )
      const centralReceipt = await new JevBlindPacketSeals(db, generatorVersion).verify({
        tenantId: options.tenant,
        accountId: options.account,
        runId: options.run,
        packet,
        artifacts
      })
      const preparedCalibration =
        options.mode === 'calibrate'
          ? prepareJevReplayCalibration(packet, artifacts, labels, calibrationSettings)
          : null
      const result =
        preparedCalibration?.adjudication ?? importJevBlindLabels(packet, artifacts, labels)
      const calibration = preparedCalibration ? calibratePolicies(preparedCalibration.input) : null
      // Reading all pieces and checking their seals can take seconds. Recheck
      // revisions and reviewer eligibility after that work, before any output.
      // This receipt remains a verification snapshot, never release authority.
      const reviewReceipt = await reviews.verify(reviewRequest)
      const declarationReceipt =
        options.mode === 'calibrate' ? await declarations.verify(declarationRequest) : null
      const directory = await createPrivateOutput(options.out)
      await writePrivateJson(join(directory, 'adjudication.private.json'), result)
      if (result.dataset)
        await writePrivateJson(join(directory, 'labelled.private.json'), result.dataset)
      if (calibration)
        await writePrivateJson(join(directory, 'calibration-report.private.json'), calibration)
      await writePrivateJson(join(directory, 'status.json'), {
        mode: calibration ? 'calibration_evaluated' : result.status,
        dataKind: result.dataKind,
        modelsCalled: false,
        centralReceipt,
        reviewReceipt,
        ...(calibration && preparedCalibration
          ? {
              calibrationInputHash: calibration.inputHash,
              calibrationSettingsHash: hashContext(preparedCalibration.settings),
              declarationReceipt,
              candidatePredeclarationVerified: true,
              holdoutRequired: true
            }
          : {}),
        monetaryBudgetVerified: false,
        releaseAuthorized: false
      })
      if (calibration) {
        write(
          'Calibration evaluated against declared candidates, central seals and latest independent labels; billing and untouched holdout remain required. No models called or messages sent.\n'
        )
        return calibration.status === 'recommended_for_frozen_holdout' ? 0 : 2
      }
      write('Independent labels imported; costs remain unknown and release is not authorized.\n')
      return result.dataset ? 0 : 2
    }
    const result = validateFrozenReplayInputs(
      frozen,
      await readPrivateInput(options.input),
      generatorVersion
    )
    await writePrivateAdminOutput(options.out, {
      mode: 'authenticated_replay_preflight',
      ...result.summary,
      candidateExecutionImplemented: true,
      monetaryBudgetVerified: false
    })
    write(
      'Replay inputs match the database freeze; no models called. Candidate execution and business review remain required.\n'
    )
    return 0
  } finally {
    await db.close()
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : ''
const modulePath = fileURLToPath(import.meta.url)
const isEntry =
  process.platform === 'win32'
    ? entryPath.toLowerCase() === modulePath.toLowerCase()
    : entryPath === modulePath
if (isEntry)
  void runJevReplayCommand(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch(() => {
      process.stderr.write(
        process.argv[2] === 'execute'
          ? 'Evaluation failed. Inspect private output and the original server journal before starting new paid work; automatic paid resume is not supported. No messages sent.\n'
          : process.argv[2] === 'review-submit'
            ? 'Reviewer command failed. Check the independent reviewer login, sealed packet and private labels/output. A committed review is retained if writing its receipt fails; submitting the same latest labels to a new output directory recovers its original receipt. No models called or messages sent.\n'
            : 'Replay command failed. Check arguments, administrator configuration, database freeze and private input/output data. No model calls or sending.\n'
      )
      process.exitCode = 1
    })
    .finally(closePrivatePermissionWorker)
