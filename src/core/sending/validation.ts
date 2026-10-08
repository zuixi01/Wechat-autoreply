import { sameIdentity, type Identity } from '../../shared/contracts/identity'
import {
  DraftReviewSchema,
  ReplyDraftSchema,
  ReplyTaskSchema,
  type DraftReview,
  type ReplyDraft,
  type ReplyTask
} from '../../shared/contracts/task'
import { hashDraft, hashContext } from '../reply/hashes'
import { sameLearningBinding, sameMemoryCorpus } from '../../shared/contracts/learning-task'
import {
  HumanConfirmationSchema,
  type HumanConfirmation
} from '../../shared/contracts/human-confirmation'

export interface CurrentSendState {
  identity: Identity
  conversationId: string
  bindingVersion: number
  conversationRevision: number
  runEpoch: number
  contextHash: string
  configVersion: string
  knowledgeVersion: string
  decisionPolicyVersion: string
  questionSetVersion: string
  modelResolved: string
  memoryCorpusVersion?: string
  paused: boolean
  leaseValid: boolean
  identityVerified: boolean
  hasMessageGap: boolean
  humanActive: boolean
  hasHumanDraft: boolean
  backgroundReadVerified: boolean
  nonInterferingSendVerified: boolean
  factsVerified: boolean
  automaticEnabled?: boolean
  humanOwned?: boolean
  humanConfirmationValid?: boolean
}
export type SendValidation = { allowed: true } | { allowed: false; reason: string }

/** Pure gate shared by preparation and final execution. It does not send or grant a lease. */
export function validateAutomaticSend(
  task: ReplyTask,
  draft: ReplyDraft,
  review: DraftReview,
  current: CurrentSendState,
  now = Date.now()
): SendValidation {
  const reject = (reason: string): SendValidation => ({ allowed: false, reason })
  if (
    !ReplyTaskSchema.safeParse(task).success ||
    !ReplyDraftSchema.safeParse(draft).success ||
    !DraftReviewSchema.safeParse(review).success
  )
    return reject('invalid_contract')
  if (current.paused || current.automaticEnabled === false) return reject('paused')
  if (!current.leaseValid) return reject('lease_invalid')
  if (!current.identityVerified || current.hasMessageGap)
    return reject('identity_or_messages_uncertain')
  if (current.humanActive || current.hasHumanDraft || current.humanOwned)
    return reject('human_priority')
  if (!current.backgroundReadVerified || !current.nonInterferingSendVerified)
    return reject('capability_unverified')
  if (!current.factsVerified) return reject('facts_unverified')
  if (
    !sameIdentity(task.identity, current.identity) ||
    task.conversationId !== current.conversationId
  )
    return reject('target_changed')
  const versions = [
    'bindingVersion',
    'conversationRevision',
    'runEpoch',
    'contextHash',
    'configVersion',
    'knowledgeVersion',
    'decisionPolicyVersion',
    'questionSetVersion'
  ] as const
  if (versions.some((key) => task[key] !== current[key])) return reject('task_obsolete')
  if (!sameMemoryCorpus(task, current)) return reject('task_obsolete')
  if (
    now < task.createdAt ||
    now >= task.expiresAt ||
    now < review.reviewedAt ||
    now >= review.expiresAt
  )
    return reject('expired')
  if (draft.taskId !== task.taskId || review.taskId !== task.taskId) return reject('task_mismatch')
  if (!['reply', 'clarify'].includes(draft.action)) return reject('action_not_sendable')
  if (
    draft.draftHash !== hashDraft(draft.text) ||
    review.draftHash !== draft.draftHash ||
    review.draftRevision !== draft.draftRevision
  )
    return reject('draft_changed')
  if (review.status !== 'passed' || review.reasons.length > 0) return reject('review_not_passed')
  const reviewedVersions = [
    'contextHash',
    'configVersion',
    'knowledgeVersion',
    'decisionPolicyVersion',
    'questionSetVersion'
  ] as const
  if (
    reviewedVersions.some((key) => review[key] !== task[key]) ||
    !sameLearningBinding(review, task) ||
    review.modelResolved !== current.modelResolved
  )
    return reject('review_obsolete')
  return { allowed: true }
}

/** Human authority is explicit and scoped; it does not assert that Jev/facts passed. */
export function validateHumanConfirmedSend(
  task: ReplyTask,
  draft: ReplyDraft,
  confirmation: HumanConfirmation,
  current: CurrentSendState,
  now = Date.now()
): SendValidation {
  const reject = (reason: string): SendValidation => ({ allowed: false, reason })
  if (
    !ReplyTaskSchema.safeParse(task).success ||
    !ReplyDraftSchema.safeParse(draft).success ||
    !HumanConfirmationSchema.safeParse(confirmation).success
  )
    return reject('invalid_contract')
  if (current.paused) return reject('paused')
  if (!current.leaseValid) return reject('lease_invalid')
  if (!current.identityVerified || current.hasMessageGap)
    return reject('identity_or_messages_uncertain')
  if (current.humanActive || current.hasHumanDraft) return reject('human_priority')
  if (!current.backgroundReadVerified || !current.nonInterferingSendVerified)
    return reject('capability_unverified')
  if (current.humanOwned !== true || current.humanConfirmationValid !== true)
    return reject('human_confirmation_unavailable')
  if (
    !sameIdentity(task.identity, current.identity) ||
    task.conversationId !== current.conversationId
  )
    return reject('target_changed')
  if (
    (
      [
        'bindingVersion',
        'conversationRevision',
        'runEpoch',
        'contextHash',
        'configVersion',
        'knowledgeVersion',
        'decisionPolicyVersion',
        'questionSetVersion'
      ] as const
    ).some((k) => task[k] !== current[k])
  )
    return reject('task_obsolete')
  if (!sameMemoryCorpus(task, current)) return reject('task_obsolete')
  if (
    now < task.createdAt ||
    now >= task.expiresAt ||
    now < confirmation.confirmedAt ||
    now >= confirmation.expiresAt
  )
    return reject('expired')
  if (!['reply', 'clarify'].includes(draft.action)) return reject('action_not_sendable')
  if (
    draft.taskId !== task.taskId ||
    confirmation.taskId !== task.taskId ||
    confirmation.sourceTaskId === task.taskId ||
    confirmation.taskHash !== hashContext(task) ||
    confirmation.draftHash !== draft.draftHash ||
    confirmation.draftRevision !== draft.draftRevision ||
    hashDraft(draft.text) !== draft.draftHash ||
    confirmation.employeeId !== task.identity.employeeId ||
    confirmation.modelResolved !== current.modelResolved
  )
    return reject('human_confirmation_changed')
  return { allowed: true }
}
