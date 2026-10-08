import type { LearningFeedback, MemoryScope } from '../../shared/contracts/learning-memory'
import type { LearningStore } from './learning-store'

/** Call only from trusted employee/platform events; it derives usage from saved generation records. */
export class LearningFeedbackCollector {
  constructor(private readonly store: LearningStore) {}
  record(scope: MemoryScope, event: LearningFeedback): void {
    this.store.recordTrustedFeedback(scope, event)
  }
}
