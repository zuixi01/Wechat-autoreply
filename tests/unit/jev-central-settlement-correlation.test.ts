import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { PoolClient } from 'pg'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  PrivateBlindReviewPacketSchema,
  type PrivateBlindReviewPacket
} from '../../evals/jev/blind-review'
import { replayCaseInputHash } from '../../evals/jev/replay-input'
import * as settlements from '../../evals/jev/settlement-reconciliation'
import { hashContext } from '../../src/core/reply/hashes'
import type { Postgres } from '../../server/src/database/postgres'
import {
  JevCalibratedHoldouts,
  type JevCorrelatedSettlementEvidence,
  type JevVerifiedHoldoutEvidence
} from '../../server/src/generation/jev-calibrated-holdouts'
import { evaluationSnapshotHash } from '../../server/src/generation/evaluation-authorization'
import { PublicationSchema, type Publication } from '../../server/src/generation/publication'
import { createSyntheticJevSettlementInput } from '../fixtures/jev-settlement-data'

// Plumbing only: verify is mocked, the DB is a transaction test double, and all
// 900 artifacts / 1800 attempts and bills are fabricated. No SQL authentication,
// central seals, supplier invoices, network, model calls or release are proven.
type CorrelateRequest = Parameters<JevCalibratedHoldouts['correlateSettlements']>[0]
type VerifyRequest = Parameters<JevCalibratedHoldouts['verify']>[0]
let base: ReturnType<typeof createSyntheticJevSettlementInput>
let packets: Record<'calibration' | 'holdout', PrivateBlindReviewPacket>

beforeAll(async () => {
  base = createSyntheticJevSettlementInput()
  const publication = PublicationSchema.parse(
    JSON.parse(await readFile('server/admin/publication.example.json', 'utf8'))
  )
  const holdoutPublication: Publication = {
    ...structuredClone(publication),
    policy: { ...publication.policy, version: 'synthetic-held-policy' },
    configuration: {
      ...publication.configuration,
      configVersion: 'synthetic-held-config',
      decisionPolicyVersion: 'synthetic-held-policy'
    }
  }
  const cases = base.plan.assignments.map((assignment) => ({
    caseId: assignment.caseId,
    conversationGroup: assignment.conversationGroup,
    split: assignment.split,
    conversationId: `synthetic-customer-${assignment.caseId}`,
    inbound: [`Synthetic question ${assignment.caseId}`]
  }))
  base.plan.assignments.forEach((assignment, index) => {
    assignment.inputHash = replayCaseInputHash(cases[index])
  })
  base.calibration.snapshotHash = evaluationSnapshotHash(publication)
  base.holdout.snapshotHash = evaluationSnapshotHash(holdoutPublication)
  const assignments = new Map(
    base.plan.assignments.map((assignment) => [assignment.caseId, assignment])
  )
  for (const artifact of base.artifacts) {
    const assignment = assignments.get(artifact.caseId)!
    artifact.inputHash = assignment.inputHash!
    artifact.executionPlanHash = hashContext(base.plan)
    artifact.snapshotHash = base[assignment.split].snapshotHash
  }
  const packet = (split: 'calibration' | 'holdout', published: Publication) => {
    const rawCases = cases.filter((item) => item.split === split)
    const artifacts = base.artifacts.filter((artifact) => artifact.runId === base[split].runId)
    const body = {
      protocol: 'jev-blind-review-v1' as const,
      packetId: randomUUID(),
      dataKind: 'synthetic' as const,
      rubricRef: 'synthetic-plumbing-only-rubric',
      frozen: {
        authenticatedScope: {
          ...base.scope,
          employeeId: 'mock-executor-not-authenticated',
          platform: 'wechat' as const
        },
        ...base[split],
        publication: published,
        plan: base.plan,
        createdAt: '2026-01-01T00:00:00.000Z',
        serverNow: '2026-01-01T00:01:00.000Z',
        expiresAt: '2026-01-02T00:00:00.000Z'
      },
      input: { datasetId: base.plan.datasetId, split, cases: rawCases },
      priorAnnotations: {
        annotatedBy: 'mock-prior-annotator',
        cases: rawCases.map((item) => ({
          caseId: item.caseId,
          category: 'faq',
          eligible: true,
          expectedHandoff: false,
          intentCount: 1
        }))
      },
      mapping: artifacts.map((artifact) => ({
        reviewId: randomUUID(),
        caseId: artifact.caseId,
        arm: artifact.arm,
        assignmentId: artifact.assignmentId,
        artifactHash: hashContext(artifact)
      }))
    }
    return PrivateBlindReviewPacketSchema.parse({ ...body, packetHash: hashContext(body) })
  }
  packets = {
    calibration: packet('calibration', publication),
    holdout: packet('holdout', holdoutPublication)
  }
})
afterEach(() => vi.restoreAllMocks())

function fixture() {
  const input = structuredClone(base)
  const packet = structuredClone(packets)
  const labels = (split: 'calibration' | 'holdout') => ({
    annotationSource: 'blinded_business_adjudication' as const,
    adjudicatedBy: 'mock-independent-reviewer',
    labels: packet[split].mapping.map((item) => ({
      reviewId: item.reviewId,
      substantialCorrection: false,
      severeFactError: false,
      unauthorizedPromise: false,
      incorrectlyBlocked: false,
      coveredIntents: 1
    }))
  })
  const request: CorrelateRequest = {
    evidence: {
      calibration: {
        ...input.scope,
        runId: input.calibration.runId,
        reviewId: randomUUID(),
        packet: packet.calibration,
        artifacts: input.artifacts.filter((artifact) => artifact.runId === input.calibration.runId),
        labels: labels('calibration'),
        settings: { fixtureOnly: 'mock-central-verifier' },
        policyVersion: 'synthetic-held-policy',
        configVersion: 'synthetic-held-config'
      },
      holdout: {
        packet: packet.holdout,
        artifacts: input.artifacts.filter((artifact) => artifact.runId === input.holdout.runId),
        labels: labels('holdout'),
        reviewId: randomUUID()
      }
    },
    settlements: {
      declaredBillingAccounts: input.declaredBillingAccounts,
      exports: input.exports
    }
  }
  const mockEvidence: JevVerifiedHoldoutEvidence = {
    lineage: {
      lineageId: randomUUID(),
      sourceRunId: input.calibration.runId,
      targetRunId: input.holdout.runId,
      sourceSnapshotHash: input.calibration.snapshotHash,
      targetSnapshotHash: input.holdout.snapshotHash,
      calibrationReportHash: hashContext('mock-calibration-report'),
      calibrationInputHash: hashContext('mock-calibration-input'),
      reviewId: request.evidence.calibration.reviewId,
      declarationId: randomUUID(),
      frozenAt: '2026-01-01T00:00:00.000Z',
      evaluationOnly: true,
      releaseAuthorized: false
    },
    holdoutSeal: {
      packetId: packet.holdout.packetId,
      packetHash: packet.holdout.packetHash,
      artifactSetHash: hashContext(request.evidence.holdout.artifacts),
      sealedAt: '2026-01-01T00:00:00.000Z',
      centralRecordVerified: true,
      releaseAuthorized: false
    },
    holdoutReview: {
      reviewId: request.evidence.holdout.reviewId,
      packetId: packet.holdout.packetId,
      packetHash: packet.holdout.packetHash,
      labelsHash: hashContext(request.evidence.holdout.labels),
      reviewerId: 'mock-independent-reviewer',
      revision: 1,
      reviewedAt: '2026-01-01T00:00:00.000Z',
      centralReviewVerified: true,
      releaseAuthorized: false
    },
    labelledCasesHash: hashContext('mock-labelled-cases'),
    evidenceHash: hashContext('mock-evidence-not-authenticated'),
    calibration: {
      datasetId: input.plan.datasetId,
      inputHash: hashContext('mock-calibration-input'),
      experimentSnapshotHash: input.calibration.snapshotHash,
      dataKind: 'synthetic',
      sampleCount: 100,
      independentConversations: 100,
      status: 'insufficient_evidence',
      recommendedPolicy: null,
      candidates: [],
      holdoutRequired: true,
      releaseAuthorized: false,
      limitations: ['Mock verifier result: no real central authentication or calibration.']
    },
    holdout: {
      dataKind: 'synthetic',
      status: 'usage_incomplete',
      dataset: null,
      cases: [],
      billedCostMicros: null,
      releaseAuthorized: false,
      approvalSubmission: null,
      limitations: ['Mock verifier result: no real labels or central authentication.']
    },
    statisticalEvaluation: null,
    statisticsHash: hashContext(null),
    centralEvidenceVerified: true,
    monetaryBudgetVerified: false,
    releaseAuthorized: false
  }
  return { request, input, packet, mockEvidence }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
function database(options: { wait?: Promise<void>; beforeCommit?: (value: unknown) => void } = {}) {
  const client = {
    query: vi.fn(() => {
      throw new Error('plumbing_test_must_not_execute_sql')
    })
  } as unknown as PoolClient
  const events: string[] = []
  const entered = deferred()
  const transaction = vi.fn(
    async (tenant: string, operation: (client: PoolClient) => Promise<unknown>) => {
      expect(tenant).toBe(base.scope.tenantId)
      events.push('begin')
      entered.resolve()
      await options.wait
      try {
        const value = await operation(client)
        options.beforeCommit?.(value)
        events.push('commit')
        return value
      } catch (error) {
        events.push('rollback')
        throw error
      }
    }
  )
  return { db: { transaction } as unknown as Postgres, transaction, client, events, entered }
}

describe('central settlement plumbing only, mocked verification is not authenticated SQL evidence', () => {
  it('snapshots amounts, frozen plan, artifacts and private packets before the first DB await', async () => {
    const f = fixture(),
      gate = deferred(),
      d = database({ wait: gate.promise })
    const original = structuredClone(f.request)
    const pure = settlements.reconcileJevSettlements(f.input)
    const verify = vi
      .spyOn(JevCalibratedHoldouts.prototype, 'verify')
      .mockResolvedValue(f.mockEvidence)
    const pending = new JevCalibratedHoldouts(d.db, 'mock-generator').correlateSettlements(
      f.request
    )
    await d.entered.promise
    Object.assign(f.request.settlements.exports[0].rows[0], { settledCostMicros: 999999 })
    const sourcePacket = f.request.evidence.calibration.packet as PrivateBlindReviewPacket
    sourcePacket.frozen.plan.maximumTurnCostMicros = 1
    sourcePacket.frozen.plan.currency = 'USD'
    sourcePacket.input.cases[0].inbound[0] = 'Caller mutation after entry'
    sourcePacket.mapping[0].artifactHash = 'f'.repeat(64)
    sourcePacket.rubricRef = 'changed-after-entry'
    sourcePacket.dataKind = 'business'
    ;(f.request.evidence.holdout.packet as PrivateBlindReviewPacket).dataKind = 'business'
    ;(f.request.evidence.calibration.artifacts as typeof f.input.artifacts)[0].caseId =
      'unplanned-mutation'
    gate.resolve()
    const result = await pending
    expect(verify).toHaveBeenCalledWith(original.evidence)
    expect(result.settlementReport).toEqual(pure)
    expect(result.settlementReport).toMatchObject({
      attemptCount: 1800,
      declaredSettledCostMicros: 108000
    })
    expect(result.dataKind).toBe('synthetic')
    expect(d.events).toEqual(['begin', 'commit'])
    expect(d.client.query).not.toHaveBeenCalled()
  })

  it('reuses one transaction and client, completing receipt, fee report and hashes before COMMIT', async () => {
    const f = fixture(),
      expectedReport = settlements.reconcileJevSettlements(f.input)
    const observedClients: PoolClient[] = []
    const d = database({
      beforeCommit: (value) => {
        expect(d.events).toEqual(['begin'])
        const result = value as JevCorrelatedSettlementEvidence
        expect(result.verifiedEvidence).toEqual(f.mockEvidence)
        expect(result.settlementReport).toEqual(expectedReport)
        const { correlationHash, ...body } = result
        const { reportHash, ...reportBody } = result.settlementReport
        expect(correlationHash).toBe(hashContext(body))
        expect(reportHash).toBe(hashContext(reportBody))
        expect(result.centralEvidenceVerified).toBe(true) // Wrapper flag only; verifier is mocked.
        expect(result.settlementReport.centralEvidenceVerified).toBe(false)
        for (const flag of [
          'rawExportContentVerified',
          'supplierAuthenticityVerified',
          'providerBillingAccountVerified',
          'monetaryBudgetVerified',
          'releaseAuthorized'
        ] as const) {
          expect(result[flag]).toBe(false)
          expect(result.settlementReport[flag]).toBe(false)
        }
      }
    })
    vi.spyOn(JevCalibratedHoldouts.prototype, 'verify').mockImplementation(function (
      this: JevCalibratedHoldouts,
      raw: VerifyRequest
    ) {
      const bound = Reflect.get(this, 'db') as Postgres
      return bound.transaction(raw.calibration.tenantId, async (client) => {
        observedClients.push(client)
        return structuredClone(f.mockEvidence)
      })
    })
    const result = await new JevCalibratedHoldouts(d.db, 'mock-generator').correlateSettlements(
      f.request
    )
    expect(result.settlementReport.cases).toHaveLength(900)
    expect(d.transaction).toHaveBeenCalledTimes(1)
    expect(observedClients).toEqual([d.client])
    expect(d.events).toEqual(['begin', 'commit'])
    expect(d.client.query).not.toHaveBeenCalled()
  })

  it.each(['scope', 'plan', 'artifacts', 'currency', 'privateExportContent'])(
    'rejects strict claims override %s before starting a DB transaction',
    async (key) => {
      const f = fixture(),
        d = database()
      if (key === 'privateExportContent')
        Object.assign(f.request.settlements.exports[0], {
          rawPrivateContent: 'synthetic-unknown-private-key'
        })
      else Object.assign(f.request.settlements, { [key]: key === 'currency' ? 'USD' : {} })
      const verify = vi.spyOn(JevCalibratedHoldouts.prototype, 'verify')
      const pure = vi.spyOn(settlements, 'reconcileJevSettlements')
      await expect(
        new JevCalibratedHoldouts(d.db, 'mock-generator').correlateSettlements(f.request)
      ).rejects.toThrow('jev_settlement_request_invalid')
      expect(d.transaction).not.toHaveBeenCalled()
      expect(verify).not.toHaveBeenCalled()
      expect(pure).not.toHaveBeenCalled()
      expect(d.events).toEqual([])
    }
  )

  it('propagates mocked verifier denial without calculating fees or committing', async () => {
    const f = fixture(),
      d = database()
    const denial = new Error('jev_holdout_denied')
    const verify = vi.spyOn(JevCalibratedHoldouts.prototype, 'verify').mockRejectedValue(denial)
    const pure = vi.spyOn(settlements, 'reconcileJevSettlements')
    await expect(
      new JevCalibratedHoldouts(d.db, 'mock-generator').correlateSettlements(f.request)
    ).rejects.toBe(denial)
    expect(verify).toHaveBeenCalledTimes(1)
    expect(pure).not.toHaveBeenCalled()
    expect(d.transaction).toHaveBeenCalledTimes(1)
    expect(d.events).toEqual(['begin', 'rollback'])
    expect(d.client.query).not.toHaveBeenCalled()
  })
})
