import { describe, expect, it } from 'vitest'
import {
  reconcileJevSettlements,
  type JevSettlementReconciliationInput
} from '../../evals/jev/settlement-reconciliation'
import { hashContext } from '../../src/core/reply/hashes'
import { createSyntheticJevSettlementInput } from '../fixtures/jev-settlement-data'

const base = createSyntheticJevSettlementInput()
function fixture() {
  return structuredClone(base)
}
function targetC(input: JevSettlementReconciliationInput) {
  return input.artifacts.find((a) => a.runId === input.holdout.runId && a.arm === 'C')!
}
function bill(
  input: JevSettlementReconciliationInput,
  provider: 'text' | 'jev',
  requestId: string
) {
  return input.exports
    .find((s) => s.provider === provider)!
    .rows.find((r) => r.requestId === requestId)!
}
function addUnrelated(input: JevSettlementReconciliationInput) {
  input.exports[0].rows.push({
    requestId: 'unrelated-request',
    status: 'settled',
    settledCostMicros: 999999,
    lineRef: 'unrelated-line'
  })
}
function addFailedAttempt(
  input: JevSettlementReconciliationInput,
  outcome: 'error' | 'cancelled' | 'timed_out' | 'not_dispatched',
  stage: 'pre' | 'text' = 'text'
) {
  const artifact = targetC(input),
    index = artifact.attempts!.findIndex((a) => a.stage === stage),
    retry = structuredClone(artifact.attempts![index]),
    requestId = `synthetic-${outcome}-${stage}-request`
  retry.attemptId = `synthetic-${outcome}-${stage}-attempt`
  retry.result = {
    outcome,
    durationMs: 1,
    ...(outcome === 'not_dispatched'
      ? {}
      : {
          usage: { inputTokens: 1, outputTokens: 1 },
          providerRequestId: {
            header:
              stage === 'text' ? ('x-request-id' as const) : ('x-typesafe-request-id' as const),
            value: requestId
          }
        })
  }
  artifact.attempts!.splice(index, 0, retry)
  artifact.stages.find((s) => s.stage === stage)!.durationMs++
  artifact.latencyMs++
  if (outcome === 'not_dispatched') {
    artifact.usage = null
    artifact.usageSource = 'unknown'
  } else {
    artifact.usage!.inputTokens++
    artifact.usage!.outputTokens++
    input.exports
      .find((s) => s.provider === retry.start.provider)!
      .rows.push({
        requestId,
        status: 'settled',
        settledCostMicros: 55,
        lineRef: `synthetic-${outcome}-${stage}-line`
      })
  }
  return { artifact, retry }
}

describe('offline settlement correlation, never authenticated fees or release', () => {
  it('covers all 100/200 cases and three arms, binding report and original immutable input', () => {
    const input = fixture(),
      before = structuredClone(input)
    const result = reconcileJevSettlements(input)
    expect(input).toEqual(before)
    expect(result).toMatchObject({
      status: 'complete_declared',
      attemptCount: 1800,
      declaredSettledCostMicros: 108000,
      unmatchedAccountRowCount: 0
    })
    expect(result.bySplit.calibration).toMatchObject({
      caseArmCount: 300,
      attemptCount: 600,
      declaredSettledCostMicros: 36000
    })
    expect(result.bySplit.holdout).toMatchObject({
      caseArmCount: 600,
      attemptCount: 1200,
      declaredSettledCostMicros: 72000
    })
    expect(result.holdoutArms.C).toMatchObject({
      caseCount: 200,
      maximumDeclaredTurnCostMicros: 140,
      p95DeclaredTurnCostMicros: 140
    })
    expect(result.declaredBudgetAssessment.status).toBe('within_declared')
    expect(result.centralEvidenceVerified).toBe(false)
    expect(result.rawExportContentVerified).toBe(false)
    expect(result.supplierAuthenticityVerified).toBe(false)
    expect(result.providerBillingAccountVerified).toBe(false)
    expect(result.monetaryBudgetVerified).toBe(false)
    expect(result.releaseAuthorized).toBe(false)
    const { reportHash, ...body } = result
    expect(reportHash).toBe(hashContext(body))
    expect(result.inputHash).toBe(hashContext(input))
  })

  it('counts an errored retry rather than charging only final responses', () => {
    const input = fixture(),
      { artifact } = addFailedAttempt(input, 'error')
    const result = reconcileJevSettlements(input)
    expect(result.attemptCount).toBe(1801)
    expect(result.declaredSettledCostMicros).toBe(108055)
    expect(
      result.cases.find((c) => c.assignmentId === artifact.assignmentId)!.stages.text
        .declaredSettledCostMicros
    ).toBe(155)
  })

  it.each(['cancelled', 'timed_out'] as const)(
    'retains a recorded settled charge for %s attempts',
    (outcome) => {
      const input = fixture()
      addFailedAttempt(input, outcome, 'pre')
      expect(reconcileJevSettlements(input).declaredSettledCostMicros).toBe(108055)
    }
  )

  it('does not estimate fees from token usage or require usage when a request is matched', () => {
    const input = fixture(),
      artifact = targetC(input)
    artifact.usage = null
    artifact.usageSource = 'unknown'
    delete artifact.attempts!.find((a) => a.stage === 'text')!.result!.usage
    expect(reconcileJevSettlements(input).declaredSettledCostMicros).toBe(108000)
  })

  it.each(['row_missing', 'pending', 'request_id_missing', 'dispatch_not_confirmed'] as const)(
    'keeps %s unknown throughout stage, case and totals',
    (reason) => {
      const input = fixture(),
        artifact = targetC(input),
        attempt = artifact.attempts!.find((a) => a.stage === 'text')!
      const source = input.exports.find((s) => s.provider === 'text')!
      const index = source.rows.findIndex(
        (r) => r.requestId === attempt.result!.providerRequestId!.value
      )
      if (reason === 'dispatch_not_confirmed') {
        addFailedAttempt(input, 'not_dispatched')
      } else if (reason === 'pending') {
        source.rows[index] = {
          requestId: source.rows[index].requestId,
          lineRef: source.rows[index].lineRef,
          status: 'pending',
          settledCostMicros: null
        }
      } else {
        source.rows.splice(index, 1)
        if (reason !== 'row_missing') delete attempt.result!.providerRequestId
      }
      const result = reconcileJevSettlements(input),
        actual = result.cases.find((c) => c.assignmentId === artifact.assignmentId)!
      expect(actual.attempts.find((a) => a.missingReason === reason)).toBeDefined()
      expect(actual.stages.text.declaredSettledCostMicros).toBeNull()
      expect(actual.declaredSettledCostMicros).toBeNull()
      expect(result.declaredSettledCostMicros).toBeNull()
      expect(result.knownMatchedSubtotalMicros).toBe(
        reason === 'dispatch_not_confirmed' ? 108000 : 107900
      )
      expect(result.bySplit.calibration.status).toBe('complete_declared')
      expect(result.bySplit.holdout.status).toBe('incomplete')
      expect(result.holdoutArms.C.maximumDeclaredTurnCostMicros).toBeNull()
      expect(result.holdoutArms.C.p95DeclaredTurnCostMicros).toBeNull()
      expect(result.declaredBudgetAssessment.status).toBe('incomplete')
    }
  )

  it('accepts an explicit zero settled row without authenticating it', () => {
    const input = fixture(),
      requestId = targetC(input).attempts![0].result!.providerRequestId!.value
    const row = bill(input, 'jev', requestId)
    if (row.status === 'settled') row.settledCostMicros = 0
    const result = reconcileJevSettlements(input)
    expect(result.status).toBe('complete_declared')
    expect(result.declaredSettledCostMicros).toBe(107980)
    expect(result.monetaryBudgetVerified).toBe(false)
  })

  it('distinguishes no started model stages from missing or undispatched attempts', () => {
    const input = fixture(),
      artifact = targetC(input)
    for (const attempt of artifact.attempts!) {
      const source = input.exports.find((s) => s.provider === attempt.start.provider)!
      source.rows = source.rows.filter(
        (r) => r.requestId !== attempt.result!.providerRequestId!.value
      )
    }
    artifact.status = 'handoff'
    artifact.wouldRelease = false
    artifact.draft = null
    artifact.pre = null
    artifact.post = null
    artifact.attempts = []
    artifact.stages = []
    artifact.usage = { inputTokens: 0, outputTokens: 0 }
    artifact.usageSource = 'recorded_http_attempts'
    artifact.otherProcessingMs = artifact.latencyMs
    const result = reconcileJevSettlements(input),
      actual = result.cases.find((c) => c.assignmentId === artifact.assignmentId)!
    expect(actual.attemptCount).toBe(0)
    expect(actual.declaredSettledCostMicros).toBe(0)
    expect(actual.stages.pre.execution).toBe('not_started')
    expect(actual.stages.text.execution).toBe('not_started')
    expect(result.releaseAuthorized).toBe(false)
  })

  it('requires exact request ids, not case-folded identifiers', () => {
    const input = fixture(),
      attempt = targetC(input).attempts![0]
    const row = bill(input, 'jev', attempt.result!.providerRequestId!.value)
    row.requestId = row.requestId.toUpperCase()
    input.exports[0].scope = 'provider_account_export'
    const result = reconcileJevSettlements(input)
    expect(result.unresolvedAttemptCount).toBe(1)
    expect(result.unmatchedAccountRowCount).toBe(1)
  })

  it('scopes identical request ids to the provider and billing account', () => {
    const input = fixture(),
      artifact = targetC(input)
    const text = artifact.attempts!.find((a) => a.stage === 'text')!
    const row = bill(input, 'text', text.result!.providerRequestId!.value)
    const jevId = artifact.attempts![0].result!.providerRequestId!.value
    row.requestId = jevId
    text.result!.providerRequestId!.value = jevId
    expect(reconcileJevSettlements(input).status).toBe('complete_declared')
  })

  it('excludes unrelated account-export rows with an explicit count, preserving the bound input hash', () => {
    const input = fixture()
    input.exports[0].scope = 'provider_account_export'
    addUnrelated(input)
    const result = reconcileJevSettlements(input)
    expect(result.unmatchedAccountRowCount).toBe(1)
    expect(result.sources[0].rowCount - result.sources[0].matchedRowCount).toBe(1)
    expect(result.declaredSettledCostMicros).toBe(108000)
    expect(result.inputHash).toBe(hashContext(input))
  })

  it('allows distinct original lines from one raw export to be sliced by logical provider', () => {
    const input = fixture()
    input.exports[1].rawExportSha256 = input.exports[0].rawExportSha256
    expect(reconcileJevSettlements(input).declaredSettledCostMicros).toBe(108000)
  })

  it('rejects one original export line reused under another source and logical provider', () => {
    const input = fixture()
    input.exports[1].rawExportSha256 = input.exports[0].rawExportSha256
    input.exports[1].rows[0].lineRef = input.exports[0].rows[0].lineRef
    expect(() => reconcileJevSettlements(input)).toThrow('duplicate_settlement_line')
  })

  it('requires the remaining planned arm even when 900 existing artifacts remain', () => {
    const input = fixture()
    input.plan.assignments.push({
      ...input.plan.assignments.at(-1)!,
      caseId: 'synthetic-unexecuted-case',
      inputHash: hashContext('synthetic-unexecuted-case')
    })
    const planHash = hashContext(input.plan)
    input.artifacts.forEach((a) => {
      a.executionPlanHash = planHash
    })
    expect(input.artifacts).toHaveLength(900)
    expect(() => reconcileJevSettlements(input)).toThrow('artifact_plan_coverage_incomplete')
  })

  it('rejects a candidate with deleted stages and attempts rather than reporting free execution', () => {
    const input = fixture(),
      artifact = targetC(input)
    artifact.stages = []
    artifact.attempts = []
    artifact.usage = { inputTokens: 0, outputTokens: 0 }
    artifact.otherProcessingMs = artifact.latencyMs
    expect(() => reconcileJevSettlements(input)).toThrow('artifact_stage_mismatch')
  })

  it('rejects a failed final attempt instead of treating the older response as completion', () => {
    const input = fixture(),
      { artifact, retry } = addFailedAttempt(input, 'error')
    artifact.attempts = artifact.attempts!.filter((a) => a !== retry)
    artifact.attempts.push(retry)
    expect(() => reconcileJevSettlements(input)).toThrow('artifact_stage_attempts_mismatch')
  })

  it('does not expose private unknown schema keys in its error contract', () => {
    const input = fixture(),
      privateKey = 'synthetic-private-bill-secret'
    Object.assign(input.exports[0].rows[0], { [privateKey]: 'synthetic-private-value' })
    try {
      reconcileJevSettlements(input)
      expect.fail('Expected malformed settlement input rejection')
    } catch (error) {
      expect(error).toMatchObject({
        name: 'JevSettlementReconciliationError',
        code: 'settlement_input_invalid'
      })
      expect(String(error)).not.toContain(privateKey)
      expect(String(error)).not.toContain('synthetic-private-value')
    }
  })

  it.each([
    [
      'unknown settlement status',
      (v: JevSettlementReconciliationInput) => {
        Object.assign(v.exports[0].rows[0], { status: 'refunded' })
      }
    ],
    [
      'missing settlement status',
      (v: JevSettlementReconciliationInput) => {
        Reflect.deleteProperty(v.exports[0].rows[0], 'status')
      }
    ],
    [
      'pending settlement with amount',
      (v: JevSettlementReconciliationInput) => {
        Object.assign(v.exports[0].rows[0], { status: 'pending', settledCostMicros: 20 })
      }
    ],
    [
      'unfinished replay attempt',
      (v: JevSettlementReconciliationInput) => {
        targetC(v).attempts![0].result = null
      }
    ],
    [
      'one missing artifact',
      (v: JevSettlementReconciliationInput) => {
        v.artifacts.pop()
      }
    ]
  ] as const)('rejects %s as invalid input, not unknown fees', (_label, mutate) => {
    const input = fixture()
    mutate(input)
    expect(() => reconcileJevSettlements(input)).toThrow('settlement_input_invalid')
  })

  it('rejects unrelated rows declared as an experiment-only selection', () => {
    const input = fixture()
    addUnrelated(input)
    expect(() => reconcileJevSettlements(input)).toThrow('unmatched_experiment_settlement')
  })

  it('uses C maximum, so a single over-budget turn cannot hide behind p95', () => {
    const input = fixture(),
      artifact = targetC(input)
    const row = bill(
      input,
      'text',
      artifact.attempts!.find((a) => a.stage === 'text')!.result!.providerRequestId!.value
    )
    if (row.status === 'settled') row.settledCostMicros = input.plan.maximumTurnCostMicros
    const result = reconcileJevSettlements(input)
    expect(result.holdoutArms.C.p95DeclaredTurnCostMicros).toBe(140)
    expect(result.holdoutArms.C.maximumDeclaredTurnCostMicros).toBe(10040)
    expect(result.declaredBudgetAssessment.status).toBe('exceeded_declared')
  })

  it('can detect an exceeded known subtotal even while another stage is pending', () => {
    const input = fixture(),
      artifact = targetC(input)
    const text = bill(
      input,
      'text',
      artifact.attempts!.find((a) => a.stage === 'text')!.result!.providerRequestId!.value
    )
    if (text.status === 'settled') text.settledCostMicros = 10001
    const row = bill(input, 'jev', artifact.attempts![0].result!.providerRequestId!.value)
    Object.assign(row, { status: 'pending', settledCostMicros: null })
    const result = reconcileJevSettlements(input)
    expect(result.holdoutArms.C.status).toBe('incomplete')
    expect(result.declaredBudgetAssessment.status).toBe('exceeded_declared')
  })

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid money %s without rounding or currency conversion',
    (money) => {
      const input = fixture()
      Object.assign(input.exports[0].rows[0], { settledCostMicros: money })
      expect(() => reconcileJevSettlements(input)).toThrow()
    }
  )

  it('rejects aggregate integer overflow rather than wrapping or silently losing precision', () => {
    const input = fixture()
    Object.assign(input.exports[0].rows[0], { settledCostMicros: Number.MAX_SAFE_INTEGER })
    expect(() => reconcileJevSettlements(input)).toThrow('settlement_sum_overflow')
  })

  it.each([
    [
      'wrong currency',
      'settlement_currency_mismatch',
      (v: JevSettlementReconciliationInput) => {
        v.exports[0].currency = 'USD'
      }
    ],
    [
      'wrong account',
      'declared_billing_account_mismatch',
      (v: JevSettlementReconciliationInput) => {
        v.exports[0].billingAccountId = 'other-account'
      }
    ],
    [
      'duplicate source',
      'duplicate_settlement_source',
      (v: JevSettlementReconciliationInput) => {
        v.exports.push(structuredClone(v.exports[0]))
      }
    ],
    [
      'duplicate export hash',
      'duplicate_settlement_export',
      (v: JevSettlementReconciliationInput) => {
        const s = structuredClone(v.exports[0])
        s.sourceId = 'duplicate-file'
        v.exports.push(s)
      }
    ],
    [
      'duplicate row',
      'duplicate_settlement_request',
      (v: JevSettlementReconciliationInput) => {
        v.exports[0].rows.push(structuredClone(v.exports[0].rows[0]))
      }
    ],
    [
      'duplicate bill line',
      'duplicate_settlement_line',
      (v: JevSettlementReconciliationInput) => {
        v.exports[0].rows[1].lineRef = v.exports[0].rows[0].lineRef
      }
    ],
    [
      'reused run',
      'distinct_calibrated_holdout_required',
      (v: JevSettlementReconciliationInput) => {
        v.holdout.runId = v.calibration.runId
      }
    ],
    [
      'reused snapshot',
      'distinct_calibrated_holdout_required',
      (v: JevSettlementReconciliationInput) => {
        v.holdout.snapshotHash = v.calibration.snapshotHash
      }
    ],
    [
      'changed frozen hash',
      'artifact_freeze_mismatch',
      (v: JevSettlementReconciliationInput) => {
        targetC(v).inputHash = hashContext('tamper')
      }
    ],
    [
      'wrong run',
      'artifact_freeze_mismatch',
      (v: JevSettlementReconciliationInput) => {
        targetC(v).runId = 'synthetic-wrong-run'
      }
    ],
    [
      'wrong snapshot',
      'artifact_freeze_mismatch',
      (v: JevSettlementReconciliationInput) => {
        targetC(v).snapshotHash = hashContext('synthetic-wrong-snapshot')
      }
    ],
    [
      'wrong plan',
      'artifact_freeze_mismatch',
      (v: JevSettlementReconciliationInput) => {
        targetC(v).executionPlanHash = hashContext('synthetic-wrong-plan')
      }
    ],
    [
      'case outside plan',
      'artifact_case_outside_plan',
      (v: JevSettlementReconciliationInput) => {
        targetC(v).caseId = 'synthetic-unplanned-case'
      }
    ],
    [
      'duplicate assignment',
      'duplicate_artifact_assignment',
      (v: JevSettlementReconciliationInput) => {
        v.artifacts[1].assignmentId = v.artifacts[0].assignmentId
      }
    ],
    [
      'duplicate global attempt',
      'duplicate_replay_attempt',
      (v: JevSettlementReconciliationInput) => {
        targetC(v).attempts![0].attemptId = v.artifacts[0].attempts![0].attemptId
      }
    ],
    [
      'A with decision stage',
      'artifact_stage_mismatch',
      (v: JevSettlementReconciliationInput) => {
        v.artifacts[0].stages[0].stage = 'pre'
        v.artifacts[0].attempts![0].stage = 'pre'
      }
    ],
    [
      'B with post stage',
      'artifact_stage_mismatch',
      (v: JevSettlementReconciliationInput) => {
        v.artifacts[1].stages[1].stage = 'post'
        v.artifacts[1].attempts![1].stage = 'post'
      }
    ],
    [
      'missing pre response',
      'artifact_stage_mismatch',
      (v: JevSettlementReconciliationInput) => {
        targetC(v).pre = null
      }
    ],
    [
      'missing post response',
      'artifact_stage_mismatch',
      (v: JevSettlementReconciliationInput) => {
        targetC(v).post = null
      }
    ],
    [
      'stages out of order',
      'artifact_stage_mismatch',
      (v: JevSettlementReconciliationInput) => {
        const a = targetC(v)
        ;[a.stages[0], a.stages[1]] = [a.stages[1], a.stages[0]]
      }
    ],
    [
      'inconsistent total latency',
      'artifact_stage_mismatch',
      (v: JevSettlementReconciliationInput) => {
        targetC(v).latencyMs++
      }
    ],
    [
      'attempt time exceeds stage',
      'artifact_stage_attempts_mismatch',
      (v: JevSettlementReconciliationInput) => {
        targetC(v).attempts![0].result!.durationMs = 5
      }
    ],
    [
      'changed text draft reference',
      'artifact_text_result_mismatch',
      (v: JevSettlementReconciliationInput) => {
        targetC(v).attempts!.find((a) => a.stage === 'text')!.result!.textOutput!.draftHash =
          hashContext('other-draft')
      }
    ],
    [
      'changed text evidence',
      'artifact_text_result_mismatch',
      (v: JevSettlementReconciliationInput) => {
        targetC(v).attempts!.find((a) => a.stage === 'text')!.result!.textOutput!.evidenceIds = [
          'other-evidence'
        ]
      }
    ],
    [
      'changed Jev model',
      'artifact_jev_result_mismatch',
      (v: JevSettlementReconciliationInput) => {
        targetC(v).attempts![0].result!.actualModel = 'other-model'
      }
    ],
    [
      'changed Jev answers',
      'artifact_jev_result_mismatch',
      (v: JevSettlementReconciliationInput) => {
        targetC(v).attempts![0].result!.answers = { synthetic_check: { type: 'noul', noul: 0 } }
      }
    ],
    [
      'changed Jev usage',
      'artifact_jev_result_mismatch',
      (v: JevSettlementReconciliationInput) => {
        const a = targetC(v)
        a.attempts![0].result!.usage!.inputTokens++
        a.usage!.inputTokens++
      }
    ],
    [
      'duplicate arm',
      'duplicate_case_arm',
      (v: JevSettlementReconciliationInput) => {
        v.artifacts[1] = structuredClone(v.artifacts[0])
      }
    ],
    [
      'missing ledger',
      'attempt_ledger_missing',
      (v: JevSettlementReconciliationInput) => {
        const a = targetC(v)
        a.attempts = null
        a.usage = null
        a.usageSource = 'unknown'
      }
    ],
    [
      'wrong provider',
      'attempt_provider_mismatch',
      (v: JevSettlementReconciliationInput) => {
        targetC(v).attempts![0].start.provider = 'text'
      }
    ],
    [
      'wrong header',
      'provider_request_header_mismatch',
      (v: JevSettlementReconciliationInput) => {
        targetC(v).attempts![0].result!.providerRequestId!.header = 'x-request-id'
      }
    ],
    [
      'undispatched with id',
      'undispatched_request_id_present',
      (v: JevSettlementReconciliationInput) => {
        const { retry } = addFailedAttempt(v, 'not_dispatched')
        retry.result!.providerRequestId = {
          header: 'x-request-id',
          value: 'synthetic-undispatched-id'
        }
      }
    ],
    [
      'reused request',
      'request_matches_multiple_attempts',
      (v: JevSettlementReconciliationInput) => {
        const a = targetC(v)
        a.attempts![2].result!.providerRequestId!.value =
          a.attempts![0].result!.providerRequestId!.value
      }
    ]
  ] as const)('rejects %s', (_label, code, mutate) => {
    const input = fixture()
    mutate(input)
    expect(() => reconcileJevSettlements(input)).toThrow(code)
  })
})
