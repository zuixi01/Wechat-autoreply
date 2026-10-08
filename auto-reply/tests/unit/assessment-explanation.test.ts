import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { taskFixture } from '../fixtures/task'
import type { GenerationResult } from '../../src/shared/contracts/generation'
import type { KnowledgeEvidence } from '../../server/src/reply/jev-pipeline'
import { explainAssessment } from '../../server/src/generation/assessment-explanation'
import { parseGenerationResult } from '../../src/core/reply/generation-validation'
import { Ledger } from '../../src/core/persistence/ledger'
import { hashContext } from '../../src/core/reply/hashes'

function fixture() {
  const f = taskFixture()
  f.draft.evidenceIds = ['faq-A']
  const result: GenerationResult = {
    task: f.task,
    draft: f.draft,
    review: f.review,
    status: 'candidate',
    automaticAllowed: false,
    factsVerified: false,
    reasons: ['freeform_requires_human'],
    intents: ['faq'],
    usage: { input_tokens: 1, output_tokens: 1 }
  }
  const evidence: KnowledgeEvidence = {
    evidenceId: 'faq-A',
    tenantId: f.task.identity.tenantId,
    accountId: f.task.identity.accountId,
    conversationId: f.task.conversationId,
    intent: 'faq',
    knowledgeVersion: f.task.knowledgeVersion,
    kind: 'approved_faq',
    source: '经审核的合成产品手册',
    content: '合成业务内容',
    approvedBy: 'synthetic-reviewer',
    validFrom: 9000,
    expiresAt: 18000
  }
  return { ...f, result, evidence }
}
describe('bound server-authored assessment explanations', () => {
  it('does not reveal knowledge for another tenant, employee account, customer, version, intent or expired period', () => {
    const f = fixture()
    for (const patch of [
      { tenantId: 'other' },
      { accountId: 'other' },
      { conversationId: 'other' },
      { knowledgeVersion: 'other' },
      { intent: 'price' as const },
      { validFrom: 11000 },
      { expiresAt: 10000 }
    ]) {
      const explanation = explainAssessment(f.result, [{ ...f.evidence, ...patch }], f.now)
      expect(explanation.evidence).toEqual([])
      expect(explanation.unavailableReferences).toBe(1)
      expect(JSON.stringify(explanation)).not.toContain('合成业务内容')
      expect(JSON.stringify(explanation)).not.toContain('经审核的合成产品手册')
    }
    expect(explainAssessment(f.result, [f.evidence], f.now).evidence[0].excerpt).toBe(
      '合成业务内容'
    )
  })
  it('only shows cited sources, caps excerpts and source count, and accounts for all hidden references', () => {
    const f = fixture()
    const knowledge = Array.from({ length: 11 }, (_, i) => ({
      ...f.evidence,
      evidenceId: `source-${i}`,
      content: '合'.repeat(800)
    }))
    f.result.draft!.evidenceIds = knowledge.slice(0, 10).map((e) => e.evidenceId)
    const explanation = explainAssessment(f.result, knowledge, f.now)
    expect(explanation).toMatchObject({
      totalReferences: 10,
      unavailableReferences: 0,
      omittedReferences: 2
    })
    expect(explanation.evidence).toHaveLength(8)
    expect(explanation.evidence.every((e) => e.excerpt.length === 600 && e.excerptTruncated)).toBe(
      true
    )
    expect(explanation.evidence.some((e) => e.evidenceId === 'source-10')).toBe(false)
  })
  it('rejects swapped task/context/knowledge/draft, intents, facts, recommendation and references at the transport boundary', () => {
    const f = fixture()
    f.result.explanation = explainAssessment(f.result, [f.evidence], f.now)
    expect(parseGenerationResult(f.result, f.task, f.now)).toEqual(f.result)
    for (const patch of [
      { taskId: 'other' },
      { contextHash: 'a'.repeat(64) },
      { knowledgeVersion: 'other' },
      { draftHash: 'a'.repeat(64) },
      { draftRevision: 99 },
      { intents: ['order'] },
      { factsVerified: true },
      { recommendation: 'automatic' },
      { totalReferences: 2, unavailableReferences: 1 },
      { evidence: [{ ...f.result.explanation.evidence[0], evidenceId: 'other' }] }
    ])
      expect(() =>
        parseGenerationResult(
          { ...f.result, explanation: { ...f.result.explanation, ...patch } },
          f.task,
          f.now
        )
      ).toThrow()
  })
  it('records an explicit handoff without invented intent, draft, knowledge or model reasoning', () => {
    const f = fixture()
    const result: GenerationResult = {
      ...f.result,
      status: 'handoff',
      draft: undefined,
      review: undefined,
      intents: [],
      reasons: ['explicit_human_request']
    }
    const explanation = explainAssessment(result, [f.evidence], f.now)
    expect(explanation).toMatchObject({
      recommendation: 'handoff',
      intents: [],
      evidence: [],
      totalReferences: 0,
      factsVerified: false
    })
    expect(explanation.draftHash).toBeUndefined()
    expect(parseGenerationResult({ ...result, explanation }, f.task, f.now).explanation).toEqual(
      explanation
    )
  })
  it('persists explanations without granting sending authority, rejects edits with stale explanations, and retains the exact source on human confirmation', () => {
    const f = fixture(),
      ledger = new Ledger(':memory:')
    try {
      const explanation = explainAssessment(f.result, [f.evidence], f.now)
      ledger.replies.begin(f.task, ['合成问题'], f.now)
      ledger.replies.update(
        f.task.identity,
        f.task.taskId,
        { status: 'needs_human', draft: f.draft, explanation },
        f.now
      )
      expect(ledger.replies.get(f.task.identity, f.task.taskId)?.explanation).toEqual(explanation)
      expect(ledger.findTask(f.task.identity, f.task.taskId)).toBeUndefined()
      expect(() =>
        ledger.replies.update(
          f.task.identity,
          f.task.taskId,
          {
            status: 'needs_human',
            draft: { ...f.draft, draftRevision: 2 }
          },
          f.now
        )
      ).toThrow()
      const task = { ...f.task, taskId: randomUUID() }
      ledger.replies.begin(task, ['合成问题'], f.now)
      ledger.replies.update(
        task.identity,
        task.taskId,
        {
          status: 'needs_human',
          draft: { ...f.draft, taskId: task.taskId },
          explanation,
          humanConfirmation: {
            confirmationId: randomUUID(),
            taskId: task.taskId,
            sourceTaskId: f.task.taskId,
            taskHash: hashContext(task),
            draftHash: f.draft.draftHash,
            draftRevision: f.draft.draftRevision,
            employeeId: task.identity.employeeId,
            modelResolved: f.review.modelResolved,
            confirmedAt: f.now,
            expiresAt: f.now + 5000
          }
        },
        f.now
      )
      expect(ledger.replies.get(task.identity, task.taskId)?.explanation?.taskId).toBe(
        f.task.taskId
      )
    } finally {
      ledger.close()
    }
  })
})
