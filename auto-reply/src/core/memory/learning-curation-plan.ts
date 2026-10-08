import type {
  LearningCurationItem,
  LearningFeedback,
  MemoryRecord,
  MemoryRevision
} from '../../shared/contracts/learning-memory'
import { learningHash } from './learning-scope'

export type CurationMethod = { memory: MemoryRecord; revision: MemoryRevision }

/** Both storage backends apply the same inactivity and protection rules. */
export function planLearningCuration(
  methods: CurationMethod[],
  feedback: LearningFeedback[],
  now: number
): LearningCurationItem[] {
  return methods.map(({ memory, revision }) => {
    const item: LearningCurationItem = {
      memoryId: memory.id,
      beforeRevision: memory.currentRevision,
      action: 'keep',
      reason: 'curation_recent'
    }
    if (memory.pinned || !['review', 'curator'].includes(revision.source))
      return { ...item, reason: 'curation_protected' }
    if (memory.state === 'archived') return { ...item, reason: 'curation_already_archived' }
    if (now < revision.createdAt + 14 * 86400000)
      return { ...item, reason: 'curation_new_item_grace' }
    const usageAt = feedback
      .filter(
        (event) =>
          ['loaded', 'adopted'].includes(event.kind) &&
          event.memoryRefs.some((ref) => ref.id === memory.id)
      )
      .reduce((latest, event) => Math.max(latest, event.at), 0)
    const age = now - Math.max(memory.updatedAt, revision.createdAt, usageAt)
    if (age >= 30 * 86400000)
      return { ...item, action: 'archive', reason: 'curation_unused_thirty_days' }
    if (age >= 14 * 86400000 && memory.state !== 'stale')
      return { ...item, action: 'stale', reason: 'curation_unused_fourteen_days' }
    return item
  })
}

/** Select at most one same-scenario group; its old methods remain active until validation. */
export function selectLearningCurationMerge(
  methods: CurationMethod[],
  items: LearningCurationItem[],
  now: number
): CurationMethod[] {
  const groups = new Map<string, CurationMethod[]>()
  for (const method of methods) {
    const { memory, revision } = method
    if (
      memory.pinned ||
      memory.state !== 'active' ||
      memory.currentRevision !== memory.activeRevision ||
      revision.content.kind === 'preference' ||
      !['review', 'curator'].includes(revision.source) ||
      now < revision.createdAt + 14 * 86400000 ||
      items.find((item) => item.memoryId === memory.id)?.action === 'archive'
    )
      continue
    const key = learningHash({
      kind: revision.content.kind,
      scenario: revision.content.scenario.normalize('NFKC').toLowerCase().replace(/\s/gu, '')
    })
    groups.set(key, [...(groups.get(key) ?? []), method])
  }
  return [...groups.values()].find((group) => group.length >= 2)?.slice(0, 5) ?? []
}
