import { z } from 'zod'
import type { PoolClient } from 'pg'
import { Id } from '../../../src/shared/contracts/identity'
import { hashContext } from '../../../src/core/reply/hashes'
import {
  PrivateBlindReviewPacketSchema,
  assertJevBlindReviewFreeze,
  importJevBlindLabels
} from '../../../evals/jev/blind-review'
import { prepareJevReplayCalibration } from '../../../evals/jev/calibration-replay'
import { calibratePolicies, type CalibrationReport } from '../../../evals/jev/calibration'
import {
  evaluateCalibratedHoldout,
  type CalibratedHoldoutEvaluation
} from '../../../evals/jev/metrics'
import {
  JevSettlementClaimsSchema,
  reconcileJevSettlements,
  type JevSettlementReconciliationReport
} from '../../../evals/jev/settlement-reconciliation'
import { Administration } from '../admin/administration'
import { FreezeEvaluationSchema } from '../admin/evaluation-admission'
import type { Postgres } from '../database/postgres'
import { JevCalibrationDeclarations } from './jev-calibration-declarations'
import { JevBlindPacketSeals } from './jev-blind-packet-seals'
import { JevBlindLabelReviews } from './jev-blind-label-reviews'
import { evaluationSnapshotHash } from './evaluation-authorization'
import type { Publication } from './publication'

const Request = z.strictObject({
  tenantId: Id,
  accountId: Id,
  runId: Id,
  reviewId: z.uuid(),
  packet: z.unknown(),
  artifacts: z.unknown(),
  labels: z.unknown(),
  settings: z.unknown(),
  policyVersion: Id,
  configVersion: Id
})
const VerifyRequest = z.strictObject({
  calibration: Request,
  holdout: z.strictObject({
    packet: z.unknown(),
    artifacts: z.unknown(),
    labels: z.unknown(),
    reviewId: z.uuid()
  })
})
const CorrelateSettlementsRequest = z.strictObject({
  evidence: VerifyRequest,
  settlements: JevSettlementClaimsSchema
})
function canonicalJson(value: unknown): string {
  const ordered = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(ordered)
      : item !== null && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, child]) => [key, ordered(child)])
          )
        : item
  return JSON.stringify(ordered(value))
}
export interface JevCalibratedHoldoutReceipt {
  lineageId: string
  sourceRunId: string
  targetRunId: string
  sourceSnapshotHash: string
  targetSnapshotHash: string
  calibrationReportHash: string
  calibrationInputHash: string
  reviewId: string
  declarationId: string
  frozenAt: string
  evaluationOnly: true
  releaseAuthorized: false
}
export interface JevVerifiedHoldoutEvidence {
  lineage: JevCalibratedHoldoutReceipt
  holdoutSeal: Awaited<ReturnType<JevBlindPacketSeals['verify']>>
  holdoutReview: Awaited<ReturnType<JevBlindLabelReviews['verify']>>
  labelledCasesHash: string
  evidenceHash: string
  calibration: CalibrationReport
  holdout: ReturnType<typeof importJevBlindLabels>
  statisticalEvaluation: CalibratedHoldoutEvaluation | null
  statisticsHash: string
  centralEvidenceVerified: true
  monetaryBudgetVerified: false
  releaseAuthorized: false
}
export interface JevCorrelatedSettlementEvidence {
  protocol: 'jev-central-settlement-correlation-v1'
  scope: { tenantId: string; accountId: string }
  dataKind: 'business' | 'synthetic'
  businessTruthVerified: false
  verifiedEvidence: JevVerifiedHoldoutEvidence
  settlementReport: JevSettlementReconciliationReport
  correlationHash: string
  centralEvidenceVerified: true
  rawExportContentVerified: false
  supplierAuthenticityVerified: false
  providerBillingAccountVerified: false
  monetaryBudgetVerified: false
  releaseAuthorized: false
}

/** Derives the candidate from authenticated full evidence. The complete verify,
 * selection, latest-review check and new freeze share one account transaction.
 * No aggregate report supplied by an operator can substitute for those inputs. */
export class JevCalibratedHoldouts {
  constructor(
    private readonly db: Postgres,
    private readonly generatorVersion: string
  ) {}
  /** Fresh central evidence and arithmetic share one account transaction. The
   * supplied claims never replace a database freeze or authenticate a supplier.
   * An exported correlation cannot substitute for another live verification. */
  async correlateSettlements(
    raw: z.infer<typeof CorrelateSettlementsRequest>
  ): Promise<JevCorrelatedSettlementEvidence> {
    // z.unknown packet/artifact fields retain references. Snapshot the entire
    // request before any await so callers cannot change evidence or amounts
    // while the authenticated database checks are in progress.
    let request: z.infer<typeof CorrelateSettlementsRequest>
    try {
      request = CorrelateSettlementsRequest.parse(structuredClone(raw))
    } catch {
      throw new Error('jev_settlement_request_invalid')
    }
    const source = request.evidence.calibration
    return this.db.transaction(source.tenantId, async (client) => {
      const bound = Object.assign(Object.create(this.db), {
        transaction: async <T>(tenant: string, operation: (db: PoolClient) => Promise<T>) => {
          if (tenant !== source.tenantId) throw new Error('jev_holdout_context_invalid')
          return operation(client)
        }
      }) as Postgres
      const verifiedEvidence = await new JevCalibratedHoldouts(bound, this.generatorVersion).verify(
        request.evidence
      )
      // verify has authenticated both immutable packets, all original attempts
      // and the latest independent reviews, retaining its locks until this
      // callback (including fee correlation and hashing) has completed.
      const calibration = PrivateBlindReviewPacketSchema.parse(source.packet)
      const holdout = PrivateBlindReviewPacketSchema.parse(request.evidence.holdout.packet)
      if (!Array.isArray(source.artifacts) || !Array.isArray(request.evidence.holdout.artifacts))
        throw new Error('jev_settlement_artifact_list_required')
      const settlementReport = reconcileJevSettlements({
        protocol: 'jev-settlement-reconciliation-input-v1',
        scope: { tenantId: source.tenantId, accountId: source.accountId },
        calibration: {
          runId: verifiedEvidence.lineage.sourceRunId,
          snapshotHash: verifiedEvidence.lineage.sourceSnapshotHash
        },
        holdout: {
          runId: verifiedEvidence.lineage.targetRunId,
          snapshotHash: verifiedEvidence.lineage.targetSnapshotHash
        },
        plan: calibration.frozen.plan,
        artifacts: [...source.artifacts, ...request.evidence.holdout.artifacts],
        ...request.settlements
      })
      const body: Omit<JevCorrelatedSettlementEvidence, 'correlationHash'> = {
        protocol: 'jev-central-settlement-correlation-v1',
        scope: { tenantId: source.tenantId, accountId: source.accountId },
        dataKind:
          calibration.dataKind === 'synthetic' || holdout.dataKind === 'synthetic'
            ? 'synthetic'
            : 'business',
        businessTruthVerified: false,
        verifiedEvidence,
        settlementReport,
        centralEvidenceVerified: true,
        rawExportContentVerified: false,
        supplierAuthenticityVerified: false,
        providerBillingAccountVerified: false,
        monetaryBudgetVerified: false,
        releaseAuthorized: false
      }
      return { ...body, correlationHash: hashContext(body) }
    })
  }
  /** Recompute both halves under the same account lock. This is an evidence
   * check, not admission: calibrated and held-out observations retain their
   * distinct snapshots, and absent settled fees remain unknown. */
  async verify(raw: z.infer<typeof VerifyRequest>): Promise<JevVerifiedHoldoutEvidence> {
    const request = VerifyRequest.parse(structuredClone(raw))
    const source = request.calibration
    const packet = PrivateBlindReviewPacketSchema.parse(request.holdout.packet)
    if (packet.input.split !== 'holdout') throw new Error('jev_holdout_split_required')
    return this.db.transaction(source.tenantId, async (client) => {
      const scope = (
        await client.query('SELECT * FROM autoreply.authenticate_admin($1)', [source.tenantId])
      ).rows[0]
      if (scope?.tenant_id !== source.tenantId || !scope.actor_id)
        throw new Error('jev_holdout_denied')
      const account = await client.query(
        'SELECT id FROM accounts WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [source.tenantId, source.accountId]
      )
      if (!account.rows[0]) throw new Error('jev_holdout_context_invalid')
      // Require an existing lineage before recomputation. Verification cannot
      // create a missing freeze or a replacement for a changed source review.
      const lineages = (
        await client.query(
          'SELECT id,target_run_id FROM jev_holdout_lineages WHERE tenant_id=$1 AND account_id=$2 AND source_run_id=$3 AND review_id=$4',
          [source.tenantId, source.accountId, source.runId, source.reviewId]
        )
      ).rows
      if (lineages.length !== 1) throw new Error('jev_holdout_lineage_required')
      const bound = Object.assign(Object.create(this.db), {
        transaction: async <T>(tenant: string, operation: (db: PoolClient) => Promise<T>) => {
          if (tenant !== source.tenantId) throw new Error('jev_holdout_context_invalid')
          return operation(client)
        }
      }) as Postgres
      const calibrated = await new JevCalibratedHoldouts(bound, this.generatorVersion).freeze(
        source
      )
      if (
        calibrated.receipt.lineageId !== lineages[0].id ||
        calibrated.receipt.targetRunId !== lineages[0].target_run_id
      )
        throw new Error('jev_holdout_lineage_changed')
      const target = await new Administration(bound, this.generatorVersion).readFrozenEvaluation(
        source.tenantId,
        source.accountId,
        calibrated.receipt.targetRunId
      )
      assertJevBlindReviewFreeze(target, packet)
      const seal = await new JevBlindPacketSeals(bound, this.generatorVersion).verify({
        tenantId: source.tenantId,
        accountId: source.accountId,
        runId: target.runId,
        packet,
        artifacts: request.holdout.artifacts
      })
      const review = await new JevBlindLabelReviews(bound).verify({
        tenantId: source.tenantId,
        accountId: source.accountId,
        runId: target.runId,
        packetId: packet.packetId,
        packetHash: packet.packetHash,
        reviewId: request.holdout.reviewId,
        labels: request.holdout.labels
      })
      const imported = importJevBlindLabels(
        packet,
        request.holdout.artifacts,
        request.holdout.labels
      )
      const calibrationObservations = importJevBlindLabels(
        source.packet,
        source.artifacts,
        source.labels
      )
      const statistics: CalibratedHoldoutEvaluation | null =
        calibrationObservations.dataset && imported.dataset
          ? {
              ...evaluateCalibratedHoldout(calibrationObservations.dataset, imported.dataset),
              dataKind:
                calibrationObservations.dataKind === 'synthetic' ||
                imported.dataKind === 'synthetic'
                  ? 'synthetic'
                  : 'business'
            }
          : null
      const proof = {
        lineage: calibrated.receipt,
        holdoutSeal: seal,
        holdoutReview: review,
        labelledCasesHash: hashContext(imported.cases),
        statisticsHash: hashContext(statistics)
      }
      return {
        ...proof,
        evidenceHash: hashContext(proof),
        calibration: calibrated.calibration,
        holdout: imported,
        statisticalEvaluation: statistics,
        centralEvidenceVerified: true as const,
        monetaryBudgetVerified: false as const,
        releaseAuthorized: false as const
      }
    })
  }
  async freeze(raw: z.infer<typeof Request>): Promise<{
    receipt: JevCalibratedHoldoutReceipt
    calibration: CalibrationReport
    publication: Publication
  }> {
    const request = Request.parse(structuredClone(raw))
    const packet = PrivateBlindReviewPacketSchema.parse(request.packet)
    if (packet.input.split !== 'calibration') throw new Error('calibration_split_required')
    return this.db.transaction(request.tenantId, async (client) => {
      const scope = (
        await client.query('SELECT * FROM autoreply.authenticate_admin($1)', [request.tenantId])
      ).rows[0]
      if (scope?.tenant_id !== request.tenantId || !scope.actor_id)
        throw new Error('jev_holdout_denied')
      const account = await client.query(
        'SELECT id FROM accounts WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [request.tenantId, request.accountId]
      )
      if (!account.rows[0]) throw new Error('jev_holdout_context_invalid')
      // Existing verifiers use this already-open transaction; they neither open
      // another connection nor commit between evidence verification and freeze.
      const bound = Object.assign(Object.create(this.db), {
        transaction: async <T>(
          tenant: string,
          operation: (db: PoolClient) => Promise<T>
        ): Promise<T> => {
          if (tenant !== request.tenantId) throw new Error('jev_holdout_context_invalid')
          return operation(client)
        }
      }) as Postgres
      const admin = new Administration(bound, this.generatorVersion)
      const source = await admin.readFrozenEvaluation(
        request.tenantId,
        request.accountId,
        request.runId
      )
      const declaration = await new JevCalibrationDeclarations(bound, this.generatorVersion).verify(
        {
          tenantId: request.tenantId,
          accountId: request.accountId,
          runId: request.runId,
          settings: request.settings
        }
      )
      await new JevBlindPacketSeals(bound, this.generatorVersion).verify({
        tenantId: request.tenantId,
        accountId: request.accountId,
        runId: request.runId,
        packet: request.packet,
        artifacts: request.artifacts
      })
      const review = await new JevBlindLabelReviews(bound).verify({
        tenantId: request.tenantId,
        accountId: request.accountId,
        runId: request.runId,
        packetId: packet.packetId,
        packetHash: packet.packetHash,
        reviewId: request.reviewId,
        labels: request.labels
      })
      const prepared = prepareJevReplayCalibration(
        packet,
        request.artifacts,
        request.labels,
        request.settings
      )
      const calibration = calibratePolicies(prepared.input)
      if (calibration.status !== 'recommended_for_frozen_holdout' || !calibration.recommendedPolicy)
        throw new Error('jev_holdout_recommendation_required')
      const publication: Publication = {
        ...source.publication,
        policy: { ...calibration.recommendedPolicy, version: request.policyVersion },
        configuration: {
          ...source.publication.configuration,
          configVersion: request.configVersion,
          decisionPolicyVersion: request.policyVersion
        }
      }
      FreezeEvaluationSchema.parse({ publication, plan: source.plan })
      const snapshot = evaluationSnapshotHash(publication)
      const row = (
        await client.query(
          'SELECT * FROM autoreply.freeze_jev_calibrated_holdout($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',
          [
            request.tenantId,
            request.accountId,
            request.runId,
            packet.packetId,
            review.reviewId,
            canonicalJson(prepared.settings),
            canonicalJson(calibration),
            JSON.stringify(publication),
            snapshot
          ]
        )
      ).rows[0]
      if (
        !row ||
        row.tenant_id !== request.tenantId ||
        row.account_id !== request.accountId ||
        row.source_run_id !== request.runId ||
        row.source_snapshot_hash !== source.snapshotHash ||
        row.target_snapshot_hash !== snapshot ||
        row.review_id !== review.reviewId ||
        row.labels_hash !== review.labelsHash ||
        row.declaration_id !== declaration.declarationId ||
        row.settings_hash !== declaration.settingsHash ||
        row.input_hash !== calibration.inputHash ||
        row.report_hash !== hashContext(calibration) ||
        hashContext(row.report_json) !== hashContext(calibration)
      )
        throw new Error('jev_holdout_lineage_changed')
      const target = await admin.readFrozenEvaluation(
        request.tenantId,
        request.accountId,
        row.target_run_id
      )
      if (
        target.snapshotHash !== snapshot ||
        hashContext(target.publication) !== hashContext(publication) ||
        hashContext(target.plan) !== hashContext(source.plan)
      )
        throw new Error('jev_holdout_lineage_changed')
      return {
        publication,
        calibration,
        receipt: {
          lineageId: z.uuid().parse(row.id),
          sourceRunId: request.runId,
          targetRunId: Id.parse(row.target_run_id),
          sourceSnapshotHash: source.snapshotHash,
          targetSnapshotHash: snapshot,
          calibrationReportHash: row.report_hash,
          calibrationInputHash: calibration.inputHash,
          reviewId: review.reviewId,
          declarationId: declaration.declarationId,
          frozenAt: target.createdAt.toISOString(),
          evaluationOnly: true,
          releaseAuthorized: false
        }
      }
    })
  }
}
