import {
  AssessmentExplanationSchema,
  type AssessmentExplanation
} from '../../../src/shared/contracts/assessment-explanation'
import type { GenerationResult } from '../../../src/shared/contracts/generation'
import { evidenceBelongsToTask, type KnowledgeEvidence } from '../reply/jev-pipeline'

export function explainAssessment(
  result: GenerationResult,
  knowledge: KnowledgeEvidence[],
  now = Date.now()
): AssessmentExplanation {
  const references = result.draft?.evidenceIds ?? []
  const available = references.flatMap((id) => {
    const item = knowledge.find(
      (e) =>
        e.evidenceId === id &&
        evidenceBelongsToTask(e, result.task, now) &&
        result.intents.includes(e.intent)
    )
    return item ? [item] : []
  })
  return AssessmentExplanationSchema.parse({
    taskId: result.task.taskId,
    contextHash: result.task.contextHash,
    knowledgeVersion: result.task.knowledgeVersion,
    assessedAt: now,
    ...(result.draft
      ? { draftHash: result.draft.draftHash, draftRevision: result.draft.draftRevision }
      : {}),
    intents: result.intents,
    recommendation: result.automaticAllowed ? 'automatic' : result.draft ? 'review' : 'handoff',
    factsVerified: result.factsVerified,
    evidence: available.slice(0, 8).map((item) => ({
      evidenceId: item.evidenceId,
      intent: item.intent,
      kind: item.kind,
      source: item.source,
      excerpt: item.content.slice(0, 600),
      excerptTruncated: item.content.length > 600,
      validFrom: item.validFrom,
      expiresAt: item.expiresAt
    })),
    totalReferences: references.length,
    unavailableReferences: references.length - available.length,
    omittedReferences: Math.max(0, available.length - 8)
  })
}
