import { describe, expect, it } from 'vitest'
import { taskFixture } from '../fixtures/task'
import {
  validateAutomaticSend,
  validateHumanConfirmedSend
} from '../../src/core/sending/validation'
import { randomUUID } from 'node:crypto'
import { hashContext, hashDraft } from '../../src/core/reply/hashes'

describe('automatic-send task and review binding', () => {
  it('requires the exact learning snapshot in automatic review and the current published corpus', () => {
    const f = taskFixture()
    const binding = {
      memoryCorpusVersion: 'published-methods-v1',
      memorySnapshotHash: '1'.repeat(64),
      learningContextVersion: '2'.repeat(64)
    }
    const task = { ...f.task, ...binding },
      review = { ...f.review, ...binding },
      current = { ...f.current, memoryCorpusVersion: binding.memoryCorpusVersion }
    expect(validateAutomaticSend(task, f.draft, review, current, f.now)).toEqual({ allowed: true })
    for (const changed of [
      { ...review, memorySnapshotHash: '3'.repeat(64) },
      { ...review, learningContextVersion: '3'.repeat(64) },
      f.review
    ])
      expect(validateAutomaticSend(task, f.draft, changed, current, f.now).allowed).toBe(false)
    expect(
      validateAutomaticSend(
        task,
        f.draft,
        review,
        { ...current, memoryCorpusVersion: 'published-methods-v2' },
        f.now
      ).allowed
    ).toBe(false)
  })
  function human() {
    const f = taskFixture()
    f.current.automaticEnabled = false
    f.current.factsVerified = false
    f.current.humanOwned = true
    f.current.humanConfirmationValid = true
    const confirmation = {
      confirmationId: randomUUID(),
      taskId: f.task.taskId,
      sourceTaskId: 'original-assessment',
      taskHash: hashContext(f.task),
      draftHash: f.draft.draftHash,
      draftRevision: f.draft.draftRevision,
      employeeId: f.task.identity.employeeId,
      modelResolved: f.current.modelResolved,
      confirmedAt: f.now,
      expiresAt: f.now + 5000
    }
    return { ...f, confirmation }
  }
  it('requires a current corpus and the complete bound task hash even with explicit human authority', () => {
    const f = human()
    const task = {
      ...f.task,
      memoryCorpusVersion: 'published-methods-v1',
      memorySnapshotHash: '1'.repeat(64),
      learningContextVersion: '2'.repeat(64)
    }
    const confirmation = { ...f.confirmation, taskHash: hashContext(task) }
    const current = { ...f.current, memoryCorpusVersion: task.memoryCorpusVersion }
    expect(validateHumanConfirmedSend(task, f.draft, confirmation, current, f.now)).toEqual({
      allowed: true
    })
    expect(
      validateHumanConfirmedSend(
        task,
        f.draft,
        confirmation,
        { ...current, memoryCorpusVersion: 'published-methods-v2' },
        f.now
      ).allowed
    ).toBe(false)
    expect(
      validateHumanConfirmedSend(
        { ...task, memorySnapshotHash: '3'.repeat(64) },
        f.draft,
        confirmation,
        current,
        f.now
      ).allowed
    ).toBe(false)
  })
  it('distinguishes explicit human authority from automatic review/fact approval', () => {
    const f = human()
    expect(validateHumanConfirmedSend(f.task, f.draft, f.confirmation, f.current, f.now)).toEqual({
      allowed: true
    })
    expect(validateAutomaticSend(f.task, f.draft, f.review, f.current, f.now).allowed).toBe(false)
  })
  it.each(['paused', 'humanActive', 'hasHumanDraft', 'hasMessageGap'] as const)(
    'human send still respects %s',
    (field) => {
      const f = human()
      f.current[field] = true
      expect(
        validateHumanConfirmedSend(f.task, f.draft, f.confirmation, f.current, f.now).allowed
      ).toBe(false)
    }
  )
  it('rejects human confirmation after text, target, employee, version or authorization changes', () => {
    const f = human()
    for (const current of [
      { ...f.current, conversationId: 'other' },
      { ...f.current, conversationRevision: 99 },
      { ...f.current, humanOwned: false },
      { ...f.current, humanConfirmationValid: false },
      { ...f.current, leaseValid: false },
      { ...f.current, nonInterferingSendVerified: false }
    ])
      expect(
        validateHumanConfirmedSend(f.task, f.draft, f.confirmation, current, f.now).allowed
      ).toBe(false)
    expect(
      validateHumanConfirmedSend(
        f.task,
        { ...f.draft, text: 'changed' },
        f.confirmation,
        f.current,
        f.now
      ).allowed
    ).toBe(false)
    expect(
      validateHumanConfirmedSend(
        f.task,
        f.draft,
        { ...f.confirmation, employeeId: 'other' },
        f.current,
        f.now
      ).allowed
    ).toBe(false)
    expect(
      validateHumanConfirmedSend(f.task, f.draft, f.confirmation, f.current, f.now + 5000).allowed
    ).toBe(false)
  })
  it('admits a current, fully checked task', () => {
    const f = taskFixture()
    expect(validateAutomaticSend(f.task, f.draft, f.review, f.current, f.now)).toEqual({
      allowed: true
    })
  })
  it.each(['tenantId', 'employeeId', 'accountId', 'agentId', 'clientInstanceId'] as const)(
    'rejects changed %s',
    (field) => {
      const f = taskFixture()
      f.current.identity = { ...f.current.identity, [field]: 'other' }
      expect(validateAutomaticSend(f.task, f.draft, f.review, f.current, f.now).allowed).toBe(false)
    }
  )
  it('rejects account relogin and a same-named other customer', () => {
    const f = taskFixture()
    f.current.identity = { ...f.current.identity, loginEpoch: 2 }
    expect(validateAutomaticSend(f.task, f.draft, f.review, f.current, f.now).allowed).toBe(false)
    f.current.identity = f.task.identity
    f.current.conversationId = 'customer-B-with-same-display-name'
    expect(validateAutomaticSend(f.task, f.draft, f.review, f.current, f.now).allowed).toBe(false)
  })
  it.each(['conversationRevision', 'runEpoch', 'bindingVersion'] as const)(
    'rejects a new %s',
    (field) => {
      const f = taskFixture()
      f.current[field]++
      expect(validateAutomaticSend(f.task, f.draft, f.review, f.current, f.now).allowed).toBe(false)
    }
  )
  it.each([
    'configVersion',
    'knowledgeVersion',
    'decisionPolicyVersion',
    'questionSetVersion'
  ] as const)('rejects a new %s', (field) => {
    const f = taskFixture()
    f.current[field] = 'new-version'
    expect(validateAutomaticSend(f.task, f.draft, f.review, f.current, f.now).allowed).toBe(false)
  })
  it('rejects a prefix added after review, even if the draft hash was updated', () => {
    const f = taskFixture()
    f.draft.text = '您好，' + f.draft.text
    f.draft.draftHash = hashDraft(f.draft.text)
    expect(validateAutomaticSend(f.task, f.draft, f.review, f.current, f.now).allowed).toBe(false)
  })
  it('rejects text tampering without a new hash', () => {
    const f = taskFixture()
    f.draft.text = '已退款。'
    expect(validateAutomaticSend(f.task, f.draft, f.review, f.current, f.now).allowed).toBe(false)
  })
  it.each(['paused', 'humanActive', 'hasHumanDraft', 'hasMessageGap'] as const)(
    'rejects %s',
    (field) => {
      const f = taskFixture()
      f.current[field] = true
      expect(validateAutomaticSend(f.task, f.draft, f.review, f.current, f.now).allowed).toBe(false)
    }
  )
  it.each([
    'leaseValid',
    'identityVerified',
    'backgroundReadVerified',
    'nonInterferingSendVerified',
    'factsVerified'
  ] as const)('rejects missing %s', (field) => {
    const f = taskFixture()
    f.current[field] = false
    expect(validateAutomaticSend(f.task, f.draft, f.review, f.current, f.now).allowed).toBe(false)
  })
  it('rejects a missing or failed review and a different actual model', () => {
    const f = taskFixture()
    expect(
      validateAutomaticSend(f.task, f.draft, undefined as never, f.current, f.now).allowed
    ).toBe(false)
    f.review.status = 'needs_human'
    expect(validateAutomaticSend(f.task, f.draft, f.review, f.current, f.now).allowed).toBe(false)
    f.review.status = 'passed'
    f.current.modelResolved = 'changed-model'
    expect(validateAutomaticSend(f.task, f.draft, f.review, f.current, f.now).allowed).toBe(false)
  })
  it('rejects an expired or future-dated task/review', () => {
    const f = taskFixture()
    expect(validateAutomaticSend(f.task, f.draft, f.review, f.current, 20000).allowed).toBe(false)
    expect(validateAutomaticSend(f.task, f.draft, f.review, f.current, 8000).allowed).toBe(false)
  })
  it('hashes object-key ordering consistently but preserves message ordering and final text', () => {
    expect(hashContext({ a: 1, b: 2 })).toBe(hashContext({ b: 2, a: 1 }))
    expect(hashContext(['A', 'B'])).not.toBe(hashContext(['B', 'A']))
    expect(hashDraft('回复')).not.toBe(hashDraft('回复 '))
  })
})
