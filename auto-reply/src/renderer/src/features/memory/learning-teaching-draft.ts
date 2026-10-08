import type { MemoryContent, MemoryScope } from '../../../../shared/contracts/learning-memory'

/** Employee input only. Legacy traces and card names supply no customer authority. */
export interface LearningTeachingDraft {
  id: string
  content: MemoryContent
  reason: string
}
export function teachingDraft(
  id: string,
  scenario: string,
  guidance = '',
  rationale = ''
): LearningTeachingDraft {
  return {
    id,
    content: { kind: 'lesson', scenario, guidance, rationale, steps: [], pitfalls: [], verification: [] },
    reason: rationale
  }
}
export function teachingScopeAvailable(scope: MemoryScope): boolean {
  return !scope.conversationId?.startsWith('unassigned:')
}
