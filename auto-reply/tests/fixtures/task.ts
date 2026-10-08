import type { ReplyTask, ReplyDraft, DraftReview } from '../../src/shared/contracts/task'
import type { CurrentSendState } from '../../src/core/sending/validation'
import { hashContext, hashDraft } from '../../src/core/reply/hashes'

export function taskFixture(): {
  task: ReplyTask
  draft: ReplyDraft
  review: DraftReview
  current: CurrentSendState
  now: number
} {
  const now = 10000
  const identity = {
    tenantId: 'company',
    employeeId: 'employee-A',
    accountId: 'account-A',
    agentId: 'agent-A',
    platform: 'wework' as const,
    loginEpoch: 1,
    clientInstanceId: 'process-A'
  }
  const task: ReplyTask = {
    taskId: 'task-A',
    identity,
    conversationId: 'customer-A',
    bindingVersion: 1,
    conversationRevision: 2,
    runEpoch: 3,
    inboundRange: { from: 1, to: 2 },
    contextHash: hashContext({ text: '需要售后' }),
    configVersion: 'config-1',
    knowledgeVersion: 'knowledge-1',
    decisionPolicyVersion: 'policy-1',
    questionSetVersion: 'questions-1',
    createdAt: 9000,
    expiresAt: 20000
  }
  const draft: ReplyDraft = {
    taskId: task.taskId,
    draftRevision: 1,
    draftHash: hashDraft('请提供订单号。'),
    action: 'clarify',
    text: '请提供订单号。',
    evidenceIds: []
  }
  const review: DraftReview = {
    reviewId: 'review-A',
    taskId: task.taskId,
    contextHash: task.contextHash,
    draftRevision: draft.draftRevision,
    draftHash: draft.draftHash,
    configVersion: task.configVersion,
    knowledgeVersion: task.knowledgeVersion,
    decisionPolicyVersion: task.decisionPolicyVersion,
    questionSetVersion: task.questionSetVersion,
    modelResolved: 'jev-test-version',
    status: 'passed',
    reasons: [],
    reviewedAt: 9500,
    expiresAt: 19000
  }
  const current: CurrentSendState = {
    ...task,
    identity,
    modelResolved: review.modelResolved,
    paused: false,
    leaseValid: true,
    identityVerified: true,
    hasMessageGap: false,
    humanActive: false,
    hasHumanDraft: false,
    backgroundReadVerified: true,
    nonInterferingSendVerified: true,
    factsVerified: true
  }
  return { task, draft, review, current, now }
}
