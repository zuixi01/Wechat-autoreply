import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { historyFixture } from '../fixtures/restore-history'
import {
  checkRestoreExecutionOutcomes,
  restoreExecutionSubjects
} from '../../server/src/recovery/restore-execution-proof'
import type { RestoreExecutionSubject } from '../../src/shared/contracts/restore-execution'
import type { RestoreAssessment } from '../../server/src/admin/restore-assessment'
const h = (c: string) => c.repeat(64)
function lostResponseAssessment() {
  const f = fixture(),
    executionId = randomUUID(),
    identity = historyFixture().required.items[0].identity
  const local = {
    kind: 'execution',
    key: `s:${executionId}`,
    identity,
    conversationId: 'customer',
    executionId,
    taskId: 'synthetic-task',
    taskHash: h('5'),
    draftHash: h('4'),
    inboundRange: { from: 1, to: 1 },
    localRangePresent: true,
    status: 'unknown',
    phase: 'requesting',
    permitId: null,
    requestHash: h('a'),
    permitHash: null,
    permitStatus: null,
    centralUpdatedAt: f.now,
    conversation: null,
    controlHash: null,
    receiptStatus: null,
    receiptHash: null,
    evidenceHash: null,
    baselineSequence: null,
    createdAt: f.now - 4000,
    updatedAt: f.now
  }
  const central = {
    permitId: 'lost-response-permit',
    agentId: identity.agentId,
    taskId: local.taskId,
    taskHash: local.taskHash,
    draftHash: local.draftHash,
    draftRevision: 0,
    leaseVersion: 1,
    loginEpoch: identity.loginEpoch,
    clientInstanceId: identity.clientInstanceId,
    conversationId: 'customer',
    purpose: 'automatic',
    confirmationId: null,
    status: 'unknown',
    issuedAt: new Date(f.now - 4000).toISOString(),
    expiresAt: new Date(f.now - 3500).toISOString(),
    settledAt: null,
    settlementHash: null
  }
  const assessment = {
    items: [
      {
        key: `l:${local.key}`,
        subjectHash: h('b'),
        kind: 'local_execution',
        requiredEvidence: 'execution_outcome',
        reasons: ['local_permit_absent'],
        metadata: { local, central: null }
      },
      {
        key: f.subject.subjectKey,
        subjectHash: f.subject.subjectHash,
        kind: 'central_permit',
        requiredEvidence: 'execution_outcome',
        reasons: [],
        metadata: { current: central, metadataComplete: true, comparison: 'not_captured' }
      }
    ]
  } as unknown as RestoreAssessment
  return { f, local, central, assessment }
}
function fixture() {
  const f = historyFixture(),
    subject: RestoreExecutionSubject = {
      subjectKey: `p:${h('1')}`,
      subjectHash: h('2'),
      kind: 'central_permit',
      executionGroup: 'permit:synthetic-permit',
      principalHash: h('3'),
      conversationId: 'customer',
      draftHash: h('4'),
      earliestSendAt: f.now - 4000,
      recordedOutcome: null
    }
  f.proof.conversations[0].messages.push({
    sourceMessageId: 'synthetic-sent',
    position: 3,
    direction: 'automation_outbound',
    contentHash: h('5'),
    sentAt: f.now - 1500
  })
  const outcome = {
    subjectKey: subject.subjectKey,
    subjectHash: subject.subjectHash,
    conversationId: 'customer',
    evidenceSha256: h('6'),
    observedAt: f.now - 1000,
    outcome: 'confirmed' as const,
    sourceMessageId: 'synthetic-sent',
    sourceContentHash: h('5'),
    draftTextHash: h('4'),
    causalAttributionVerified: true as const
  }
  const input = {
    reviewId: randomUUID(),
    tenantId: 'tenant',
    accountId: 'account',
    caseId: f.proof.caseId,
    uploadId: f.proof.uploadId,
    historyProofId: f.proof.proofId,
    assessmentBasisHash: h('7'),
    reviewerId: 'synthetic-reviewer',
    reviewedAt: f.now,
    outcomes: [outcome]
  }
  const check = (raw: unknown = input, subjects: unknown = [subject], now = f.now) =>
    checkRestoreExecutionOutcomes(raw, subjects, f.proof, f.required.allDevicesStoppedAt, now)
  return { ...f, subject, outcome, input, check }
}
it('binds a confirmed execution to the exact automation outbound anchor and draft', () => {
  const f = fixture()
  expect(f.check()).toMatchObject({ confirmed: 1, notSent: 0, executionGroups: 1 })
})
it('associates a lost permit response by the exact full principal and verifies both records with one source anchor', () => {
  const { f, assessment } = lostResponseAssessment(),
    subjects = restoreExecutionSubjects(assessment)
  expect(subjects.map((s) => s.executionGroup)).toEqual([
    'permit:lost-response-permit',
    'permit:lost-response-permit'
  ])
  const input = {
    ...f.input,
    outcomes: subjects.map((s) => ({
      ...f.outcome,
      subjectKey: s.subjectKey,
      subjectHash: s.subjectHash
    }))
  }
  expect(f.check(input, subjects)).toMatchObject({ confirmed: 2, executionGroups: 1 })
})
it('refuses ambiguous lost responses and task-ID reuse across different execution identities', () => {
  const first = lostResponseAssessment()
  first.assessment.items.push({
    ...first.assessment.items[1],
    key: `p:${h('c')}`,
    metadata: {
      current: { ...first.central, permitId: 'other-permit' },
      metadataComplete: true,
      comparison: 'not_captured'
    }
  })
  expect(() => restoreExecutionSubjects(first.assessment)).toThrow('restore_execution_conflict')
  const second = lostResponseAssessment()
  second.central.clientInstanceId = 'different-client'
  expect(() => restoreExecutionSubjects(second.assessment)).toThrow('restore_execution_conflict')
})
it('accepts explicit independently reviewed nondispatch journal evidence', () => {
  const f = fixture(),
    {
      sourceMessageId: _,
      sourceContentHash: __,
      draftTextHash: ___,
      causalAttributionVerified: ____,
      ...base
    } = f.outcome
  void _
  void __
  void ___
  void ____
  f.input.outcomes = []
  expect(
    f.check({
      ...f.input,
      outcomes: [
        {
          ...base,
          outcome: 'not_sent',
          dispatchStarted: false,
          quiescent: true,
          dispatchJournalEntrySha256: h('8'),
          nonDispatchJournalVerified: true
        }
      ]
    })
  ).toMatchObject({ confirmed: 0, notSent: 1 })
})
describe('rejects invalid confirmed reviews', () => {
  for (const [name, change] of Object.entries({
    'wrong source': { sourceMessageId: 'missing' },
    'wrong conversation': { conversationId: 'other' },
    'wrong content': { sourceContentHash: h('9') },
    'wrong draft': { draftTextHash: h('9') },
    'unverified causality': { causalAttributionVerified: false },
    'wrong subject hash': { subjectHash: h('9') },
    'before device stop': { observedAt: 0 },
    'after source capture': { observedAt: 2000001 },
    'implicit release': { canRelease: true }
  }))
    it(name, () => {
      const f = fixture()
      expect(() => f.check({ ...f.input, outcomes: [{ ...f.outcome, ...change }] })).toThrow()
    })
})
it('rejects human or inbound messages even with matching source IDs and content', () => {
  for (const direction of ['inbound', 'human_outbound'] as const) {
    const f = fixture()
    f.proof.conversations[0].messages[2].direction = direction
    expect(() => f.check()).toThrow()
  }
})
it('requires all assessment subjects exactly once', () => {
  const f = fixture()
  expect(() => f.check({ ...f.input, outcomes: [] })).toThrow()
  expect(() => f.check({ ...f.input, outcomes: [f.outcome, f.outcome] })).toThrow()
  expect(() => f.check(f.input, [f.subject, f.subject])).toThrow()
})
it('keeps a local and central representation of the same execution together', () => {
  const f = fixture(),
    local = { ...f.subject, subjectKey: `l:s:${randomUUID()}`, kind: 'local_execution' as const }
  expect(
    f.check({ ...f.input, outcomes: [{ ...f.outcome, subjectKey: local.subjectKey }, f.outcome] }, [
      local,
      f.subject
    ])
  ).toMatchObject({ confirmed: 2, executionGroups: 1 })
})
it('does not reuse the same source anchor for a different execution or inconsistent principal', () => {
  const f = fixture(),
    local = { ...f.subject, subjectKey: `l:s:${randomUUID()}`, kind: 'local_execution' as const }
  for (const mutation of [
    { executionGroup: 'permit:different' },
    { principalHash: h('9') },
    { kind: 'central_permit' as const }
  ])
    expect(() =>
      f.check(
        { ...f.input, outcomes: [{ ...f.outcome, subjectKey: local.subjectKey }, f.outcome] },
        [{ ...local, ...mutation }, f.subject]
      )
    ).toThrow()
})
it('rejects contradiction with an immutable terminal outcome', () => {
  const f = fixture()
  expect(() => f.check(f.input, [{ ...f.subject, recordedOutcome: 'not_sent' }])).toThrow()
})
it('rejects wrong scope, stale review, invalid clock and oversized input before cloning', () => {
  const f = fixture()
  for (const mutation of [
    { tenantId: 'other' },
    { accountId: 'other' },
    { caseId: randomUUID() },
    { uploadId: randomUUID() },
    { historyProofId: randomUUID() },
    { reviewedAt: f.now - 1 },
    { reviewedAt: f.now + 1 },
    { extra: 'x'.repeat(1048576) }
  ])
    expect(() => f.check({ ...f.input, ...mutation })).toThrow()
  expect(() => f.check(f.input, [f.subject], f.now + 300001)).toThrow()
  expect(() => f.check(f.input, [f.subject], NaN)).toThrow()
})
it('records zero executions without implying that recovery may be released', () => {
  const f = fixture()
  expect(f.check({ ...f.input, outcomes: [] }, [])).toMatchObject({
    confirmed: 0,
    notSent: 0,
    executionGroups: 0
  })
})
it('requires independently verified nondispatch evidence and forbids reuse across executions', () => {
  const f = fixture(),
    negative = {
      subjectKey: f.subject.subjectKey,
      subjectHash: f.subject.subjectHash,
      conversationId: 'customer',
      evidenceSha256: h('6'),
      observedAt: f.now - 1000,
      outcome: 'not_sent',
      dispatchStarted: false,
      quiescent: true,
      dispatchJournalEntrySha256: h('8'),
      nonDispatchJournalVerified: true
    }
  for (const change of [
    { dispatchStarted: true },
    { quiescent: false },
    { nonDispatchJournalVerified: false },
    { dispatchJournalEntrySha256: undefined }
  ])
    expect(() => f.check({ ...f.input, outcomes: [{ ...negative, ...change }] })).toThrow()
  const local = {
    ...f.subject,
    subjectKey: `l:s:${randomUUID()}`,
    kind: 'local_execution' as const,
    executionGroup: 'local:another'
  }
  expect(() =>
    f.check({ ...f.input, outcomes: [{ ...negative, subjectKey: local.subjectKey }, negative] }, [
      local,
      f.subject
    ])
  ).toThrow()
})
it('supports the full permitted identifier length when deriving server subjects', () => {
  const f = fixture(),
    permitId = 'p'.repeat(128)
  const c = {
    permitId,
    agentId: 'agent',
    taskId: 'task',
    taskHash: h('a'),
    draftHash: h('b'),
    draftRevision: 0,
    leaseVersion: 1,
    loginEpoch: 1,
    clientInstanceId: 'client',
    conversationId: 'customer',
    purpose: 'automatic',
    confirmationId: null,
    status: 'unknown',
    issuedAt: new Date(f.now - 4000).toISOString(),
    expiresAt: null,
    settledAt: null,
    settlementHash: null
  }
  const assessment = {
    items: [
      {
        key: f.subject.subjectKey,
        subjectHash: f.subject.subjectHash,
        kind: 'central_permit',
        requiredEvidence: 'execution_outcome',
        reasons: [],
        metadata: { current: c, metadataComplete: true, comparison: 'not_captured' }
      }
    ]
  } as unknown as RestoreAssessment
  expect(restoreExecutionSubjects(assessment)[0].executionGroup).toBe(`permit:${permitId}`)
  c.taskHash = ''
  expect(() => restoreExecutionSubjects(assessment)).toThrow()
})
