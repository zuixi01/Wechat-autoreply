import { z } from 'zod'
import { Hash, Id, IdentitySchema } from './identity'
import { ReplyTaskSchema, ReplyDraftSchema, DraftReviewSchema } from './task'
import { HumanConfirmationSchema } from './human-confirmation'
import type {
  WorkbenchPresentationRequest,
  WorkbenchPresentationAck,
  WorkbenchPresentationTicket,
  WorkbenchPresentationResult
} from './workbench-presentation'
import { AssessmentExplanationSchema } from './assessment-explanation'
import { AssessmentEvidencePageSchema } from './assessment-evidence'
import { ReconciliationAcknowledgmentSchema } from './reconciliation'
import {
  LearningCorrectionInputSchema,
  LearningResultInputSchema,
  LearningHumanFeedbackInputSchema
} from './learning-memory'

export const WorkbenchScopeSchema = IdentitySchema.omit({
  loginEpoch: true,
  clientInstanceId: true
})
export type WorkbenchScope = z.infer<typeof WorkbenchScopeSchema>
export function workbenchScopeOf(scope: WorkbenchScope): WorkbenchScope {
  return WorkbenchScopeSchema.parse({
    tenantId: scope.tenantId,
    employeeId: scope.employeeId,
    accountId: scope.accountId,
    agentId: scope.agentId,
    platform: scope.platform
  })
}
export const LocalReplyRecordSchema = z
  .strictObject({
    task: ReplyTaskSchema,
    draft: ReplyDraftSchema.optional(),
    review: DraftReviewSchema.optional(),
    edited: z.boolean().optional(),
    reasons: z.array(Id).max(50).optional(),
    assessmentComplete: z.boolean().optional(),
    humanConfirmation: HumanConfirmationSchema.optional(),
    explanation: AssessmentExplanationSchema.optional(),
    status: z.enum([
      'generating',
      'ready',
      'needs_human',
      'sent',
      'not_sent',
      'unknown',
      'skipped',
      'obsolete'
    ]),
    inboundPreview: z.string().max(400),
    revision: z.number().int().positive(),
    updatedAt: z.number().int().nonnegative()
  })
  .refine(
    (record) =>
      !record.explanation ||
      ((record.explanation.taskId === record.task.taskId ||
        record.explanation.taskId === record.humanConfirmation?.sourceTaskId) &&
        record.explanation.contextHash === record.task.contextHash &&
        record.explanation.knowledgeVersion === record.task.knowledgeVersion &&
        record.explanation.draftHash === record.draft?.draftHash &&
        record.explanation.draftRevision === record.draft?.draftRevision &&
        record.explanation.totalReferences === (record.draft?.evidenceIds.length ?? 0) &&
        record.explanation.evidence.every((e) => record.draft?.evidenceIds.includes(e.evidenceId)))
  )
export type LocalReplyRecord = z.infer<typeof LocalReplyRecordSchema>
export const WorkbenchRowSchema = z.strictObject({
  taskId: Id,
  conversationId: Id,
  status: LocalReplyRecordSchema.shape.status.or(z.literal('sending')),
  version: Hash,
  inboundPreview: z.string().max(400),
  replyText: z.string().max(10000).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  humanOwned: z.boolean(),
  stopAcknowledged: z.boolean(),
  canSkip: z.boolean(),
  canRelease: z.boolean(),
  canReview: z.boolean().default(false),
  canConfirm: z.boolean().default(false),
  canReadEvidence: z.boolean().default(false),
  canLearn: z.boolean().default(false),
  learningPending: z.boolean().default(false),
  reconciliationRequired: z.boolean().default(false),
  canReconcile: z.boolean().default(false),
  reviewStatus: DraftReviewSchema.shape.status.optional(),
  reviewReasons: z.array(Id).max(100).optional(),
  explanation: AssessmentExplanationSchema.optional()
})
export type WorkbenchRow = z.infer<typeof WorkbenchRowSchema>
export const WorkbenchSnapshotSchema = z.strictObject({
  state: z.enum(['available', 'not_registered', 'closed', 'unavailable']),
  rows: z.array(WorkbenchRowSchema).max(100)
})
export type WorkbenchSnapshot = z.infer<typeof WorkbenchSnapshotSchema>
export const WorkbenchActionSchema = z.strictObject({
  taskId: Id,
  expectedVersion: Hash,
  action: z.enum(['takeover', 'release', 'skip'])
})
export type WorkbenchAction = z.infer<typeof WorkbenchActionSchema>
export const WorkbenchEditSchema = z.strictObject({
  taskId: Id,
  expectedVersion: Hash,
  text: z
    .string()
    .min(1)
    .max(10000)
    .refine((text) => text.trim().length > 0)
})
export type WorkbenchEdit = z.infer<typeof WorkbenchEditSchema>
export const WorkbenchConfirmSchema = z.strictObject({ taskId: Id, expectedVersion: Hash })
export type WorkbenchConfirm = z.infer<typeof WorkbenchConfirmSchema>
const learningTarget = { taskId: Id, expectedVersion: Hash }
export const WorkbenchLearningInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...learningTarget,
    kind: z.literal('correction'),
    input: LearningCorrectionInputSchema
  }),
  z.strictObject({
    ...learningTarget,
    kind: z.literal('result'),
    input: LearningResultInputSchema
  }),
  z.strictObject({
    ...learningTarget,
    kind: z.literal('feedback'),
    input: LearningHumanFeedbackInputSchema
  })
])
export type WorkbenchLearningInput = z.infer<typeof WorkbenchLearningInputSchema>
export const WorkbenchLearningResultSchema = z.discriminatedUnion('success', [
  z.strictObject({ success: z.literal(true), state: z.enum(['pending', 'saved']), sourceId: Id }),
  z.strictObject({
    success: z.literal(false),
    code: z.enum([
      'invalid_input',
      'unavailable',
      'task_changed',
      'storage_unavailable',
      'event_conflict',
      'event_unavailable'
    ])
  })
])
export type WorkbenchLearningResult = z.infer<typeof WorkbenchLearningResultSchema>
export const WorkbenchEvidenceInputSchema = WorkbenchConfirmSchema.extend({
  offset: z.number().int().min(0).max(100)
})
export type WorkbenchEvidenceInput = z.infer<typeof WorkbenchEvidenceInputSchema>
export const WorkbenchEvidenceResultSchema = z.discriminatedUnion('success', [
  z.strictObject({ success: z.literal(true), page: AssessmentEvidencePageSchema }),
  z.strictObject({
    success: z.literal(false),
    code: z.enum(['invalid_input', 'unavailable', 'task_changed'])
  })
])
export type WorkbenchEvidenceResult = z.infer<typeof WorkbenchEvidenceResultSchema>
export const WorkbenchResultSchema = z.discriminatedUnion('success', [
  z.strictObject({
    success: z.literal(true),
    snapshot: WorkbenchSnapshotSchema,
    stopAcknowledged: z.boolean()
  }),
  z.strictObject({
    success: z.literal(false),
    code: z.enum([
      'invalid_input',
      'unavailable',
      'task_changed',
      'execution_pending',
      'review_unavailable',
      'send_rejected',
      'storage_unavailable'
    ])
  })
])
export type WorkbenchResult = z.infer<typeof WorkbenchResultSchema>
export const WorkbenchReconciliationResultSchema = z.union([
  ReconciliationAcknowledgmentSchema.extend({
    success: z.literal(true),
    resolution: z.enum(['confirmed', 'not_sent']).optional(),
    applicationAcknowledged: z.boolean().optional()
  }),
  z.strictObject({
    success: z.literal(true),
    status: z.literal('request_sealed'),
    sealId: z.string().uuid(),
    sealHash: Hash,
    resolution: z.literal('not_sent'),
    applicationAcknowledged: z.boolean()
  }),
  z.strictObject({
    success: z.literal(false),
    code: z.enum(['invalid_input', 'unavailable', 'task_changed', 'execution_pending'])
  })
])
export type WorkbenchReconciliationResult = z.infer<typeof WorkbenchReconciliationResultSchema>
export interface WorkbenchDesktopApi {
  presentationTicket?(input: WorkbenchPresentationRequest): Promise<WorkbenchPresentationTicket>
  presentationAck?(input: WorkbenchPresentationAck): Promise<WorkbenchPresentationResult>
  learn(input: WorkbenchLearningInput): Promise<WorkbenchLearningResult>
  snapshot(): Promise<WorkbenchSnapshot>
  act(input: WorkbenchAction): Promise<WorkbenchResult>
  reviewEdited(input: WorkbenchEdit): Promise<WorkbenchResult>
  confirmSend(input: WorkbenchConfirm): Promise<WorkbenchResult>
  evidence(input: WorkbenchEvidenceInput): Promise<WorkbenchEvidenceResult>
  reconcile?(input: WorkbenchConfirm): Promise<WorkbenchReconciliationResult>
}
