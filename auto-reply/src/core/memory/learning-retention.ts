import type { LearningStore } from './learning-store'
import type { RetentionReport } from '../../shared/contracts/learning-memory'

/** Retention is a data lifecycle policy, independent from whether the agent learns. */
export class LearningRetention {
  constructor(private readonly store: LearningStore) {}
  run(now: number): RetentionReport {
    return this.store.pruneExpiredEpisodes(now)
  }
}
