import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prepareKnowledgePublication } from '../../server/src/generation/knowledge-publication'

const now = 10000
function fixture() {
  const id = randomUUID()
  return {
    publication: {
      configuration: {
        configVersion: 'old-config',
        knowledgeVersion: 'old-knowledge',
        decisionPolicyVersion: 'policy',
        questionSetVersion: 'questions',
        modelResolved: 'resolved',
        automaticEnabled: true
      },
      policy: {
        version: 'policy',
        knowledgeVersion: 'old-knowledge',
        questionSetVersion: 'questions',
        mode: 'enforced',
        modelAlias: 'alias',
        modelResolved: 'resolved',
        evaluationApproved: true,
        automaticIntents: ['faq'],
        minimumChoiceProbability: 0.9,
        minimumChoiceConfidence: 0.9,
        minimumChoiceMargin: 0.2,
        presentIntentProbability: 0.9,
        humanRequestThreshold: 0.2,
        minimumAuditProbability: 0.95,
        reviewValidityMs: 5000,
        preBudgetMs: 1000,
        postBudgetMs: 1000
      },
      evidence: [],
      textGeneratorVersion: 'generator-v1',
      evaluationApprovalId: 'old-approval'
    },
    bundle: {
      schema: 'autoreply-knowledge-v1',
      version: 'local-version',
      settings: { enabled: true, fallbackReply: '稍后核实。' },
      documents: [
        { id, name: '服务说明', category: '服务', content: '营业时间为九点至六点。', version: 2 }
      ]
    },
    approvedBy: 'admin',
    expiresAt: now + 100000,
    intents: { [id]: 'faq' },
    replyRules: '礼貌简洁'
  }
}
describe('reviewable knowledge publication preparation', () => {
  it('preserves the explicitly bound method catalogue when preparing a new knowledge version', () => {
    const input = fixture()
    const memory = {
      memoryCorpusVersion: 'published-methods-v1',
      memoryManifest: [{ id: randomUUID(), revision: 3, contentHash: 'a'.repeat(64) }]
    }
    const result = prepareKnowledgePublication(
      { ...input, publication: { ...input.publication, ...memory } },
      'company',
      'account',
      now
    )
    expect(result).toMatchObject(memory)
    expect(result.evaluationApprovalId).toBeUndefined()
    expect(result.configuration.automaticEnabled).toBe(false)
  })
  it('binds uploaded knowledge and rules to a fresh scoped version without reusing automatic approval', () => {
    const input = fixture()
    const result = prepareKnowledgePublication(input, 'company', 'account', now)
    expect(result.configuration.knowledgeVersion).not.toBe('old-knowledge')
    expect(result.configuration.configVersion).not.toBe('old-config')
    expect(result).toMatchObject({
      configuration: { automaticEnabled: false },
      policy: { mode: 'shadow', evaluationApproved: false },
      retrieval: 'lexical-v1',
      replyRules: '礼貌简洁',
      evidence: [
        {
          tenantId: 'company',
          accountId: 'account',
          kind: 'approved_faq',
          content: '营业时间为九点至六点。'
        }
      ]
    })
    expect(result.evaluationApprovalId).toBeUndefined()
    input.bundle.documents[0].content = '营业时间改为十点。'
    expect(
      prepareKnowledgePublication(input, 'company', 'account', now).configuration.knowledgeVersion
    ).not.toBe(result.configuration.knowledgeVersion)
  })
  it('rejects disabled, expired, unclassified, empty or oversized knowledge', () => {
    const input = fixture()
    expect(() =>
      prepareKnowledgePublication({ ...input, expiresAt: now }, 'company', 'account', now)
    ).toThrow('有效期')
    expect(() =>
      prepareKnowledgePublication({ ...input, intents: {} }, 'company', 'account', now)
    ).toThrow('业务类别')
    expect(() =>
      prepareKnowledgePublication(
        {
          ...input,
          bundle: { ...input.bundle, settings: { ...input.bundle.settings, enabled: false } }
        },
        'company',
        'account',
        now
      )
    ).toThrow('暂停')
    expect(() =>
      prepareKnowledgePublication(
        { ...input, bundle: { ...input.bundle, documents: [] } },
        'company',
        'account',
        now
      )
    ).toThrow('片段')
    input.bundle.documents[0].content = '产品服务说明。\n'.repeat(16000)
    expect(() => prepareKnowledgePublication(input, 'company', 'account', now)).toThrow('片段')
    expect(() => prepareKnowledgePublication(fixture(), '', 'account', now)).toThrow()
  })
})
