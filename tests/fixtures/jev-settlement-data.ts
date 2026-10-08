import type { JevSettlementReconciliationInput } from '../../evals/jev/settlement-reconciliation'
import { hashContext, hashDraft } from '../../src/core/reply/hashes'
import type { JevResponse } from '../../src/shared/contracts/decision'
import { evaluationPlan } from './evaluation-data'

// Fabricated complete protocol shapes, not HTTP execution or supplier invoices.
export function createSyntheticJevSettlementInput(): JevSettlementReconciliationInput {
  const plan = evaluationPlan()
  plan.replayProtocol = 'jev-abc-v1'
  plan.assignments.forEach((a) => {
    a.inputHash = hashContext({ caseId: a.caseId })
  })
  const planHash = hashContext(plan)
  const calibration = { runId: 'synthetic-calibration', snapshotHash: hashContext('old-policy') }
  const holdout = { runId: 'synthetic-holdout', snapshotHash: hashContext('new-policy') }
  const base: JevSettlementReconciliationInput = {
    protocol: 'jev-settlement-reconciliation-input-v1',
    scope: { tenantId: 'synthetic-tenant', accountId: 'synthetic-account' },
    calibration,
    holdout,
    plan,
    declaredBillingAccounts: { jev: 'synthetic-jev-account', text: 'synthetic-text-account' },
    artifacts: [],
    exports: (['jev', 'text'] as const).map((provider) => ({
      sourceId: `synthetic-${provider}-export`,
      provider,
      billingAccountId: `synthetic-${provider}-account`,
      currency: 'CNY',
      rawExportSha256: hashContext({ syntheticExport: provider }),
      scope: 'experiment_subset',
      rows: []
    }))
  }
  base.artifacts = plan.assignments.flatMap((assignment) =>
    (['A', 'B', 'C'] as const).map((arm) => {
      const stages =
        arm === 'A'
          ? (['text'] as const)
          : arm === 'B'
            ? (['pre', 'text'] as const)
            : (['pre', 'text', 'post'] as const)
      const frozen = base[assignment.split]
      const text = `Synthetic draft ${assignment.caseId} ${arm}`
      const response: JevResponse = {
        model: 'synthetic-model',
        answers: { synthetic_check: { type: 'noul', noul: 1 } },
        usage: { input_tokens: 1, output_tokens: 1 }
      }
      return {
        ...frozen,
        caseId: assignment.caseId,
        arm,
        assignmentId: `${assignment.caseId}-${arm}`,
        protocol: 'jev-abc-v1',
        baselineRoute: 'automatic-intents-with-scoped-evidence-v1',
        inputHash: assignment.inputHash!,
        executionPlanHash: planHash,
        status: 'candidate',
        wouldRelease: arm !== 'B',
        releaseAuthorized: false,
        factsVerified: true,
        intents: ['faq'],
        reasons: [],
        draft: { text, evidenceIds: ['synthetic-evidence'], draftHash: hashDraft(text) },
        pre: arm === 'A' ? null : structuredClone(response),
        post: arm === 'C' ? structuredClone(response) : null,
        stages: stages.map((stage) => ({ stage, durationMs: 1, completed: true })),
        latencyMs: 10,
        otherProcessingMs: 10 - stages.length,
        attempts: stages.map((stage) => {
          const provider = stage === 'text' ? 'text' : 'jev'
          const requestId = `${assignment.caseId}-${arm}-${stage}`
          base.exports
            .find((s) => s.provider === provider)!
            .rows.push({
              requestId,
              status: 'settled',
              settledCostMicros: provider === 'text' ? 100 : 20,
              lineRef: requestId
            })
          return {
            attemptId: requestId,
            stage,
            start: {
              provider,
              requestedModel: 'synthetic-model',
              requestHash: hashContext(requestId)
            },
            result: {
              outcome: 'response',
              durationMs: 1,
              usage: { inputTokens: 1, outputTokens: 1 },
              actualModel: response.model,
              ...(stage === 'text'
                ? {
                    textOutput: { draftHash: hashDraft(text), evidenceIds: ['synthetic-evidence'] }
                  }
                : { answers: structuredClone(response.answers) }),
              providerRequestId: {
                header: provider === 'jev' ? 'x-typesafe-request-id' : 'x-request-id',
                value: requestId
              }
            }
          }
        }),
        usage: { inputTokens: stages.length, outputTokens: stages.length },
        usageSource: 'recorded_http_attempts',
        billedCostMicros: null
      }
    })
  )
  return base
}
