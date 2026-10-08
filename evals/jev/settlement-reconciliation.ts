import { z } from 'zod'
import { Hash, Id } from '../../src/shared/contracts/identity'
import { hashContext } from '../../src/core/reply/hashes'
import { EvaluationPlanSchema } from '../../server/src/admin/evaluation-admission'
import { ProviderRequestIdSchema } from '../../server/src/generation/model-call-contracts'
import { BlindReviewArtifactSchema } from './blind-review'

const Provider = z.enum(['jev', 'text'])
const Money = z.number().int().nonnegative().safe()
const SettlementRow = z.discriminatedUnion('status', [
  z.strictObject({
    requestId: ProviderRequestIdSchema.shape.value,
    status: z.literal('settled'),
    settledCostMicros: Money,
    lineRef: Id
  }),
  z.strictObject({
    requestId: ProviderRequestIdSchema.shape.value,
    status: z.literal('pending'),
    settledCostMicros: z.null(),
    lineRef: Id
  })
])

/** Normalized claims from a supplier adapter, not authenticated supplier bills.
 * One final net settlement per request, in integer millionths of its currency.
 * Hash metadata alone does not establish the bytes or origin of an export. */
export const JevSettlementReconciliationInputSchema = z.strictObject({
  protocol: z.literal('jev-settlement-reconciliation-input-v1'),
  scope: z.strictObject({ tenantId: Id, accountId: Id }),
  calibration: z.strictObject({ runId: Id, snapshotHash: Hash }),
  holdout: z.strictObject({ runId: Id, snapshotHash: Hash }),
  plan: EvaluationPlanSchema,
  declaredBillingAccounts: z.strictObject({ jev: Id, text: Id }),
  artifacts: z.array(BlindReviewArtifactSchema).min(900).max(6000),
  exports: z
    .array(
      z.strictObject({
        sourceId: Id,
        provider: Provider,
        billingAccountId: Id,
        currency: z.enum(['CNY', 'USD']),
        rawExportSha256: Hash,
        scope: z.enum(['provider_account_export', 'experiment_subset']),
        rows: z.array(SettlementRow).max(200000)
      })
    )
    .max(100)
})

/** Only supplier claims are accepted here. Central callers derive all scope,
 * frozen plan and execution records from freshly verified evidence themselves. */
export const JevSettlementClaimsSchema = JevSettlementReconciliationInputSchema.pick({
  declaredBillingAccounts: true,
  exports: true
})

export type JevSettlementReconciliationInput = z.infer<
  typeof JevSettlementReconciliationInputSchema
>
type ProviderName = z.infer<typeof Provider>
type ArmName = 'A' | 'B' | 'C'
type StageName = 'pre' | 'text' | 'post'
type Split = 'calibration' | 'holdout'
type MissingReason = 'request_id_missing' | 'dispatch_not_confirmed' | 'row_missing' | 'pending'

export class JevSettlementReconciliationError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'JevSettlementReconciliationError'
  }
}
function reject(code: string): never {
  // Never include customer content, provider identifiers or bill lines in errors.
  throw new JevSettlementReconciliationError(code)
}
function sum(values: readonly number[]): number {
  const total = values.reduce((n, value) => n + BigInt(value), 0n)
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) reject('settlement_sum_overflow')
  return Number(total)
}
function key(provider: ProviderName, account: string, requestId: string): string {
  return JSON.stringify([provider, account, requestId])
}
function percentile(values: readonly number[], quantile: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * quantile
  const low = Math.floor(position)
  return sorted[low] + (sorted[Math.ceil(position)] - sorted[low]) * (position - low)
}

interface AttemptMatch {
  attemptId: string
  stage: StageName
  provider: ProviderName
  outcome: string
  sourceId: string | null
  lineRef: string | null
  declaredSettledCostMicros: number | null
  missingReason: MissingReason | null
}
interface CostSummary {
  status: 'complete_declared' | 'incomplete'
  attemptCount: number
  settledAttemptCount: number
  unresolvedAttemptCount: number
  knownMatchedSubtotalMicros: number
  declaredSettledCostMicros: number | null
}
interface CaseCosts extends CostSummary {
  runId: string
  caseId: string
  arm: ArmName
  assignmentId: string
  split: Split
  stages: Record<StageName, CostSummary & { execution: 'observed_attempts' | 'not_started' }>
  attempts: AttemptMatch[]
}
type ArmCosts = CostSummary & {
  caseCount: number
  maximumDeclaredTurnCostMicros: number | null
  p95DeclaredTurnCostMicros: number | null
}
export interface JevSettlementReconciliationReport extends CostSummary {
  protocol: 'jev-settlement-reconciliation-report-v1'
  dataKind: 'unverified'
  inputHash: string
  reportHash: string
  scope: { tenantId: string; accountId: string }
  calibration: { runId: string; snapshotHash: string }
  holdout: { runId: string; snapshotHash: string }
  planHash: string
  currency: 'CNY' | 'USD'
  sources: {
    sourceId: string
    provider: ProviderName
    billingAccountId: string
    rawExportSha256: string
    scope: 'provider_account_export' | 'experiment_subset'
    rowCount: number
    matchedRowCount: number
  }[]
  unmatchedAccountRowCount: number
  bySplit: Record<Split, CostSummary & { caseArmCount: number }>
  holdoutArms: Record<ArmName, ArmCosts>
  declaredBudgetAssessment: {
    rule: 'holdout-C-maximum-turn-cost'
    maximumTurnCostMicros: number
    status: 'exceeded_declared' | 'within_declared' | 'incomplete'
  }
  cases: CaseCosts[]
  centralEvidenceVerified: false
  rawExportContentVerified: false
  supplierAuthenticityVerified: false
  providerBillingAccountVerified: false
  monetaryBudgetVerified: false
  releaseAuthorized: false
}
function summarize(attempts: readonly AttemptMatch[]): CostSummary {
  const settled = attempts.filter((a) => a.declaredSettledCostMicros !== null)
  const subtotal = sum(settled.map((a) => a.declaredSettledCostMicros!))
  const complete = settled.length === attempts.length
  return {
    status: complete ? 'complete_declared' : 'incomplete',
    attemptCount: attempts.length,
    settledAttemptCount: settled.length,
    unresolvedAttemptCount: attempts.length - settled.length,
    knownMatchedSubtotalMicros: subtotal,
    // An empty, structurally complete ledger sums to zero; it invents no HTTP
    // response or zero-fee bill row. Its authenticity still remains unverified.
    declaredSettledCostMicros: complete ? subtotal : null
  }
}

/** Offline arithmetic and correlation only. Callers must independently verify
 * live central seals/reviews, supplier exports and billing account ownership
 * before any admission. This result is never a release/approval contract. */
export function reconcileJevSettlements(raw: unknown): JevSettlementReconciliationReport {
  const parsed = JevSettlementReconciliationInputSchema.safeParse(raw)
  if (!parsed.success) reject('settlement_input_invalid')
  const input = parsed.data
  if (input.plan.replayProtocol !== 'jev-abc-v1') reject('replay_protocol_required')
  if (
    input.calibration.runId === input.holdout.runId ||
    input.calibration.snapshotHash === input.holdout.snapshotHash
  )
    reject('distinct_calibrated_holdout_required')
  const planHash = hashContext(input.plan)
  const assignments = new Map(input.plan.assignments.map((a) => [a.caseId, a]))
  const sourceIds = new Set<string>()
  const exportHashes = new Set<string>()
  const rows = new Map<
    string,
    {
      sourceId: string
      scope: 'provider_account_export' | 'experiment_subset'
      row: z.infer<typeof SettlementRow>
    }
  >()
  const lines = new Set<string>()
  for (const source of input.exports) {
    if (sourceIds.has(source.sourceId)) reject('duplicate_settlement_source')
    sourceIds.add(source.sourceId)
    if (source.billingAccountId !== input.declaredBillingAccounts[source.provider])
      reject('declared_billing_account_mismatch')
    if (source.currency !== input.plan.currency) reject('settlement_currency_mismatch')
    const exportKey = key(source.provider, source.billingAccountId, source.rawExportSha256)
    if (exportHashes.has(exportKey)) reject('duplicate_settlement_export')
    exportHashes.add(exportKey)
    for (const row of source.rows) {
      const rowKey = key(source.provider, source.billingAccountId, row.requestId)
      if (rows.has(rowKey)) reject('duplicate_settlement_request')
      // A shared raw file may be sliced into logical Jev/text exports, but its
      // same original line cannot be assigned to two model requests.
      const lineKey = JSON.stringify([source.rawExportSha256, row.lineRef])
      if (lines.has(lineKey)) reject('duplicate_settlement_line')
      lines.add(lineKey)
      rows.set(rowKey, { sourceId: source.sourceId, scope: source.scope, row })
    }
  }
  const caseArms = new Set<string>(),
    artifactIds = new Set<string>(),
    attemptIds = new Set<string>()
  const observedRequests = new Set<string>(),
    matchedRows = new Set<string>()
  const cases: CaseCosts[] = []
  for (const artifact of input.artifacts) {
    const assignment = assignments.get(artifact.caseId)
    if (!assignment) reject('artifact_case_outside_plan')
    const frozen = input[assignment.split]
    if (
      artifact.runId !== frozen.runId ||
      artifact.snapshotHash !== frozen.snapshotHash ||
      artifact.executionPlanHash !== planHash ||
      artifact.inputHash !== assignment.inputHash
    )
      reject('artifact_freeze_mismatch')
    const caseKey = JSON.stringify([artifact.caseId, artifact.arm])
    if (caseArms.has(caseKey)) reject('duplicate_case_arm')
    caseArms.add(caseKey)
    if (artifactIds.has(artifact.assignmentId)) reject('duplicate_artifact_assignment')
    artifactIds.add(artifact.assignmentId)
    if (artifact.attempts === null) reject('attempt_ledger_missing')
    const stages = new Set(artifact.stages.map((s) => s.stage))
    const expected: StageName[] =
      artifact.arm === 'A'
        ? ['text']
        : artifact.arm === 'B'
          ? ['pre', 'text']
          : ['pre', 'text', 'post']
    if (
      artifact.stages.some((s, i) => s.stage !== expected[i]) ||
      (artifact.status === 'candidate' && artifact.stages.length !== expected.length) ||
      Boolean(artifact.draft) !== stages.has('text') ||
      Boolean(artifact.pre) !== stages.has('pre') ||
      Boolean(artifact.post) !== stages.has('post') ||
      Math.abs(
        artifact.latencyMs -
          artifact.otherProcessingMs -
          artifact.stages.reduce((n, s) => n + s.durationMs, 0)
      ) > 0.000001
    )
      reject('artifact_stage_mismatch')
    for (const stage of artifact.stages) {
      const records = artifact.attempts.filter((a) => a.stage === stage.stage)
      const last = records.at(-1)?.result
      if (
        !last ||
        last.outcome !== 'response' ||
        stage.durationMs + 1 < records.reduce((n, a) => n + a.result!.durationMs, 0)
      )
        reject('artifact_stage_attempts_mismatch')
      if (stage.stage === 'text') {
        if (
          !artifact.draft ||
          last.answers !== undefined ||
          !last.textOutput ||
          last.textOutput.draftHash !== artifact.draft.draftHash ||
          hashContext(last.textOutput.evidenceIds) !== hashContext(artifact.draft.evidenceIds)
        )
          reject('artifact_text_result_mismatch')
      } else {
        const response = artifact[stage.stage]
        if (
          !response ||
          last.answers === undefined ||
          last.textOutput !== undefined ||
          last.actualModel !== response.model ||
          hashContext(last.answers) !== hashContext(response.answers) ||
          !last.usage ||
          last.usage.inputTokens !== response.usage.input_tokens ||
          last.usage.outputTokens !== response.usage.output_tokens
        )
          reject('artifact_jev_result_mismatch')
      }
    }
    const usageComplete = artifact.attempts.every((a) => a.result!.usage !== undefined)
    const totalUsage = usageComplete
      ? {
          inputTokens: sum(artifact.attempts.map((a) => a.result!.usage!.inputTokens)),
          outputTokens: sum(artifact.attempts.map((a) => a.result!.usage!.outputTokens))
        }
      : null
    if (
      hashContext(totalUsage) !== hashContext(artifact.usage) ||
      artifact.usageSource !== (usageComplete ? 'recorded_http_attempts' : 'unknown')
    )
      reject('artifact_usage_mismatch')
    const attempts: AttemptMatch[] = artifact.attempts.map((attempt) => {
      if (attemptIds.has(attempt.attemptId)) reject('duplicate_replay_attempt')
      attemptIds.add(attempt.attemptId)
      if (!stages.has(attempt.stage)) reject('attempt_stage_missing')
      const provider = attempt.stage === 'text' ? 'text' : 'jev'
      if (attempt.start.provider !== provider) reject('attempt_provider_mismatch')
      const result = attempt.result!
      const requestId = result.providerRequestId
      if (
        requestId &&
        requestId.header !== (provider === 'jev' ? 'x-typesafe-request-id' : 'x-request-id')
      )
        reject('provider_request_header_mismatch')
      if (result.outcome === 'not_dispatched' && requestId)
        reject('undispatched_request_id_present')
      const requestKey = requestId
        ? key(provider, input.declaredBillingAccounts[provider], requestId.value)
        : null
      if (requestKey && observedRequests.has(requestKey))
        reject('request_matches_multiple_attempts')
      if (requestKey) observedRequests.add(requestKey)
      const bill = requestKey ? rows.get(requestKey) : undefined
      if (bill) matchedRows.add(requestKey!)
      return {
        attemptId: attempt.attemptId,
        stage: attempt.stage,
        provider,
        outcome: result.outcome,
        sourceId: bill?.sourceId ?? null,
        lineRef: bill?.row.lineRef ?? null,
        declaredSettledCostMicros:
          bill?.row.status === 'settled' ? bill.row.settledCostMicros : null,
        missingReason: !requestId
          ? result.outcome === 'not_dispatched'
            ? 'dispatch_not_confirmed'
            : 'request_id_missing'
          : !bill
            ? 'row_missing'
            : bill.row.status === 'pending'
              ? 'pending'
              : null
      }
    })
    cases.push({
      runId: artifact.runId,
      caseId: artifact.caseId,
      arm: artifact.arm,
      assignmentId: artifact.assignmentId,
      split: assignment.split,
      ...summarize(attempts),
      stages: Object.fromEntries(
        (['pre', 'text', 'post'] as const).map((stage) => {
          const selected = attempts.filter((a) => a.stage === stage)
          return [
            stage,
            {
              ...summarize(selected),
              execution: selected.length ? 'observed_attempts' : 'not_started'
            }
          ]
        })
      ) as CaseCosts['stages'],
      attempts
    })
  }
  if (caseArms.size !== input.plan.assignments.length * 3)
    reject('artifact_plan_coverage_incomplete')
  for (const [rowKey, bill] of rows) {
    if (!matchedRows.has(rowKey) && bill.scope === 'experiment_subset')
      reject('unmatched_experiment_settlement')
  }
  const allAttempts = cases.flatMap((c) => c.attempts)
  const bySplit = Object.fromEntries(
    (['calibration', 'holdout'] as const).map((split) => {
      const selected = cases.filter((c) => c.split === split)
      return [
        split,
        { ...summarize(selected.flatMap((c) => c.attempts)), caseArmCount: selected.length }
      ]
    })
  ) as Record<Split, CostSummary & { caseArmCount: number }>
  const holdoutArms = Object.fromEntries(
    (['A', 'B', 'C'] as const).map((arm) => {
      const selected = cases.filter((c) => c.split === 'holdout' && c.arm === arm)
      const summary = summarize(selected.flatMap((c) => c.attempts))
      const complete = summary.status === 'complete_declared'
      const costs = selected.map((c) => c.declaredSettledCostMicros!)
      return [
        arm,
        {
          ...summary,
          caseCount: selected.length,
          maximumDeclaredTurnCostMicros: complete ? Math.max(...costs) : null,
          p95DeclaredTurnCostMicros: complete ? percentile(costs, 0.95) : null
        }
      ]
    })
  ) as Record<
    ArmName,
    CostSummary & {
      caseCount: number
      maximumDeclaredTurnCostMicros: number | null
      p95DeclaredTurnCostMicros: number | null
    }
  >
  const limit = input.plan.maximumTurnCostMicros
  const exceeded = cases.some(
    (c) => c.split === 'holdout' && c.arm === 'C' && c.knownMatchedSubtotalMicros > limit
  )
  const body: Omit<JevSettlementReconciliationReport, 'reportHash'> = {
    protocol: 'jev-settlement-reconciliation-report-v1' as const,
    dataKind: 'unverified',
    inputHash: hashContext(input),
    scope: input.scope,
    calibration: input.calibration,
    holdout: input.holdout,
    planHash,
    currency: input.plan.currency,
    ...summarize(allAttempts),
    sources: input.exports.map((s) => ({
      sourceId: s.sourceId,
      provider: s.provider,
      billingAccountId: s.billingAccountId,
      rawExportSha256: s.rawExportSha256,
      scope: s.scope,
      rowCount: s.rows.length,
      matchedRowCount: s.rows.filter((r) =>
        matchedRows.has(key(s.provider, s.billingAccountId, r.requestId))
      ).length
    })),
    unmatchedAccountRowCount: rows.size - matchedRows.size,
    bySplit,
    holdoutArms,
    declaredBudgetAssessment: {
      rule: 'holdout-C-maximum-turn-cost' as const,
      maximumTurnCostMicros: limit,
      status: exceeded
        ? ('exceeded_declared' as const)
        : holdoutArms.C.status === 'complete_declared'
          ? ('within_declared' as const)
          : ('incomplete' as const)
    },
    cases,
    centralEvidenceVerified: false as const,
    rawExportContentVerified: false as const,
    supplierAuthenticityVerified: false as const,
    providerBillingAccountVerified: false as const,
    monetaryBudgetVerified: false as const,
    releaseAuthorized: false as const
  }
  return { ...body, reportHash: hashContext(body) }
}
