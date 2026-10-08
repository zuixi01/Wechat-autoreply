import { hashContext } from '../../../src/core/reply/hashes'
import type { JevRequest, JevResponse } from '../../../src/shared/contracts/decision'
import type { ReplyTask } from '../../../src/shared/contracts/task'
import { TypeSafeClient } from '../decision/typesafe-client'
import {
  JevReplyPipeline,
  type DecisionPolicy,
  type KnowledgeEvidence,
  type PipelineResult
} from '../reply/jev-pipeline'
import { HttpTextGenerator } from './text-generator'

export const offlineScenarios = [
  'faq',
  'human_request',
  'mixed_requests',
  'audit_failure',
  'invented_fact',
  'malformed_decision'
] as const
export type OfflineScenario = (typeof offlineScenarios)[number]
export interface OfflineCall {
  stage: 'pre' | 'text' | 'post'
  path: string
  finalDraft?: string
  evidenceIds?: string[]
}

/** Exercises the production HTTP parsers and candidate pipeline. Both transports are
 * always injected: no environment secrets, real HTTP, chat clients or send permissions. */
export async function runOfflineJevScenario(
  scenario: OfflineScenario,
  platform: 'wechat' | 'wework' = 'wechat'
): Promise<{
  scenario: OfflineScenario
  platform: string
  calls: OfflineCall[]
  result: PipelineResult
}> {
  const now = Date.now()
  const inbound = [
    scenario === 'human_request'
      ? '请转人工处理'
      : scenario === 'mixed_requests'
        ? '支持离线阅读吗？另外我要退款。'
        : '支持离线阅读吗？'
  ]
  const task: ReplyTask = {
    taskId: `offline-${platform}-${scenario}`,
    identity: {
      tenantId: 'offline-company',
      employeeId: `offline-employee-${platform}`,
      accountId: `offline-account-${platform}`,
      agentId: `offline-agent-${platform}`,
      platform,
      loginEpoch: 1,
      clientInstanceId: `offline-client-${platform}`
    },
    conversationId: `offline-customer-${platform}`,
    bindingVersion: 1,
    conversationRevision: 1,
    runEpoch: 1,
    inboundRange: { from: 1, to: 1 },
    contextHash: hashContext(inbound),
    configVersion: 'offline-config',
    knowledgeVersion: 'offline-knowledge',
    decisionPolicyVersion: 'offline-policy',
    questionSetVersion: 'offline-questions',
    createdAt: now,
    expiresAt: now + 60000
  }
  const policy: DecisionPolicy = {
    version: task.decisionPolicyVersion,
    questionSetVersion: task.questionSetVersion,
    knowledgeVersion: task.knowledgeVersion,
    mode: 'enforced',
    modelAlias: 'jev-offline',
    modelResolved: 'jev-offline-resolved',
    // Synthetic policy only; never saved as a business evaluation approval.
    evaluationApproved: true,
    automaticIntents: ['faq'],
    minimumChoiceProbability: 0.9,
    minimumChoiceConfidence: 0.8,
    minimumChoiceMargin: 0.3,
    presentIntentProbability: 0.9,
    humanRequestThreshold: 0.2,
    minimumAuditProbability: 0.95,
    reviewValidityMs: 5000,
    preBudgetMs: 2000,
    postBudgetMs: 2000
  }
  const evidence: KnowledgeEvidence = {
    evidenceId: `offline-faq-${platform}`,
    tenantId: task.identity.tenantId,
    accountId: task.identity.accountId,
    conversationId: task.conversationId,
    intent: 'faq',
    knowledgeVersion: task.knowledgeVersion,
    kind: 'approved_faq',
    content: '本产品支持离线阅读。',
    source: '合成演示知识，不能用于真实业务',
    approvedBy: 'offline-reviewer',
    validFrom: now - 1000,
    expiresAt: now + 60000
  }
  const calls: OfflineCall[] = []
  const decisionTransport: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname
    if (path !== '/v1/systemone' || options?.method !== 'POST')
      throw new Error('unexpected_offline_decision_request')
    const request: JevRequest = JSON.parse(String(options.body))
    const post = Boolean(request.questions.supported)
    const state = request.state as Record<string, unknown>
    calls.push({
      stage: post ? 'post' : 'pre',
      path,
      ...(post
        ? {
            finalDraft: String(state.final_draft),
            evidenceIds: (state.trusted_evidence as { evidenceId: string }[]).map(
              (item) => item.evidenceId
            )
          }
        : {})
    })
    if (scenario === 'malformed_decision')
      return Response.json({ model: policy.modelResolved, answers: {} })
    const answers: JevResponse['answers'] = {}
    for (const [name, question] of Object.entries(request.questions)) {
      if (question.type === 'choice')
        answers[name] = {
          type: 'choice',
          choice: 'faq',
          confidence: 1,
          probabilities: { faq: 1, price: 0, order: 0, aftersales: 0, other: 0 }
        }
      else
        answers[name] = {
          type: 'noul',
          noul:
            name === 'human_requested' ||
            (name.startsWith('has_') &&
              name !== 'has_faq' &&
              !(name === 'has_aftersales' && scenario === 'mixed_requests')) ||
            (post && name === 'supported' && scenario === 'audit_failure')
              ? 0
              : 1
        }
    }
    return Response.json({
      model: policy.modelResolved,
      answers,
      usage: { input_tokens: 10, output_tokens: 5 }
    })
  }
  const textTransport: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname
    if (path !== '/v1/chat/completions' || options?.method !== 'POST')
      throw new Error('unexpected_offline_text_request')
    const request = JSON.parse(String(options.body))
    const state = JSON.parse(request.messages[1].content)
    if (state.trusted_evidence[0].evidenceId !== evidence.evidenceId)
      throw new Error('offline_evidence_scope_mismatch')
    calls.push({ stage: 'text', path })
    return Response.json({
      model: 'text-offline-resolved',
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: JSON.stringify({
              text: scenario === 'invented_fact' ? '退款已到账，再优惠100元。' : evidence.content,
              evidenceIds: [evidence.evidenceId]
            })
          }
        }
      ]
    })
  }
  const decision = new TypeSafeClient({
    apiKey: 'synthetic-offline-key',
    fetch: decisionTransport,
    maxAttempts: 1
  })
  const generator = new HttpTextGenerator({
    apiKey: 'synthetic-offline-key',
    baseUrl: 'https://text-provider.invalid/v1/',
    model: 'text-offline',
    expectedModel: 'text-offline-resolved',
    fetch: textTransport
  })
  const result = await new JevReplyPipeline(decision, generator).run(
    { task, inbound, evidence: [evidence], retrieval: 'lexical-v1', isCurrent: () => true },
    policy
  )
  return { scenario, platform, calls, result }
}

export interface OfflineJevDemoReport {
  formatVersion: number
  mode: 'offline_simulation'
  scope: string
  passed: boolean
  realProviderCalled: false
  chatClientsAccessed: false
  messagesSent: 0
  realAccuracyValidated: false
  serverAdmissionValidated: false
  productionReady: false
  cases: Awaited<ReturnType<typeof runOfflineJevScenario>>[]
}

export async function runOfflineJevDemo(): Promise<OfflineJevDemoReport> {
  const cases = []
  for (const platform of ['wechat', 'wework'] as const)
    for (const scenario of offlineScenarios)
      cases.push(await runOfflineJevScenario(scenario, platform))
  const passed = cases.every(({ scenario, calls, result }) => {
    if (scenario === 'faq')
      return (
        result.automaticAllowed &&
        result.review?.status === 'passed' &&
        calls.map((call) => call.stage).join(',') === 'pre,text,post'
      )
    if (result.automaticAllowed) return false
    if (scenario === 'human_request') return result.status === 'handoff' && calls.length === 0
    if (scenario === 'mixed_requests') return result.status === 'handoff' && calls.length === 1
    if (scenario === 'malformed_decision') return result.status === 'invalid' && calls.length === 1
    return result.review?.status === 'needs_human' && calls.length === 3
  })
  return {
    formatVersion: 1,
    mode: 'offline_simulation' as const,
    scope: 'HTTP request/response parsers and candidate pipeline with synthetic transport',
    passed,
    realProviderCalled: false,
    chatClientsAccessed: false,
    messagesSent: 0,
    realAccuracyValidated: false,
    serverAdmissionValidated: false,
    productionReady: false,
    cases
  }
}
