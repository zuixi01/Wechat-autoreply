import { afterEach, describe, expect, it, vi } from 'vitest'
import { Ledger } from '../../src/core/persistence/ledger'
import { LearningOutboxSync } from '../../src/main/services/learning-outbox-sync'
import { LearningSettingsSchema } from '../../src/shared/contracts/learning-memory'
import { workbenchScopeOf } from '../../src/shared/contracts/workbench'
import { taskFixture } from '../fixtures/task'
import { learningHash } from '../../src/core/memory/learning-scope'

const fixtures: { ledger: Ledger; sync: LearningOutboxSync }[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.sync.stop()
    f.ledger.close()
  }
})
function fixture() {
  const task = taskFixture(),
    now = Date.now()
  task.task.createdAt = now - 8 * 86400000
  task.task.expiresAt = task.task.createdAt + 10000
  const scope = workbenchScopeOf(task.task.identity),
    ledger = new Ledger(':memory:')
  ledger.learning.enqueue({
    task: task.task,
    draft: task.draft,
    kind: 'correction',
    input: { sourceId: 'policy-test', text: '先核对状态', reason: '实际纠正' },
    at: now
  })
  const client = {
    learningSettings: vi.fn(async () => LearningSettingsSchema.parse({ caseRetentionDays: 7 })),
    recordLearningCorrection: vi.fn(async () => ({}) as never),
    recordLearningResult: vi.fn(async () => ({}) as never),
    recordLearningFeedback: vi.fn(async () => {})
  }
  let current: typeof scope | undefined = scope
  const failure = vi.fn(),
    sync = new LearningOutboxSync(ledger, client, () => current, failure)
  fixtures.push({ ledger, sync })
  return {
    task,
    scope,
    ledger,
    client,
    sync,
    failure,
    change: () => {
      current = { ...scope, accountId: 'foreign' }
    }
  }
}
describe('authoritative learning outbox policy', () => {
  it('continues privacy cleanup using the last verified retention while the policy service is offline', async () => {
    const f = fixture()
    f.ledger.learning.setRetention(f.scope, f.task.task.conversationId, 7)
    f.client.learningSettings.mockRejectedValue(new Error('offline'))
    await f.sync.flush()
    expect(f.ledger.learning.state(f.scope, 'policy-test')).toBe('forgotten')
    expect(f.client.recordLearningCorrection).not.toHaveBeenCalled()
    expect(f.failure).not.toHaveBeenCalled()
  })
  it('cancels a policy lookup that ignores abort and rejects its late persistence', async () => {
    const f = fixture()
    let resolve!: (value: ReturnType<typeof LearningSettingsSchema.parse>) => void
    f.client.learningSettings.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const work = f.sync.flush()
    await vi.waitFor(() => expect(f.client.learningSettings).toHaveBeenCalledOnce())
    await f.sync.cancel()
    await work
    resolve(LearningSettingsSchema.parse({ caseRetentionDays: 7 }))
    await Promise.resolve()
    expect(f.client.recordLearningCorrection).not.toHaveBeenCalled()
    expect(f.ledger.learning.pending(f.scope)).toHaveLength(1)
  })
  it('loads effective customer retention before deciding whether an event may be replayed', async () => {
    const f = fixture()
    await f.sync.flush()
    expect(f.client.learningSettings).toHaveBeenCalledWith(
      {
        workspaceId: `enterprise:${learningHash({ tenant: f.scope.tenantId, account: f.scope.accountId })}`,
        tenantId: f.scope.tenantId,
        accountId: f.scope.accountId,
        platform: f.scope.platform,
        conversationId: f.task.task.conversationId
      },
      undefined,
      expect.any(AbortSignal)
    )
    expect(f.client.recordLearningCorrection).not.toHaveBeenCalled()
    expect(f.ledger.learning.state(f.scope, 'policy-test')).toBe('forgotten')
    expect(f.failure).not.toHaveBeenCalled()
  })
  it('honors a longer retention rather than deleting a 100 day old event using the default 90', async () => {
    const f = fixture()
    // Replace the isolated event with one whose actual source is older than the default.
    const createdAt = Date.now() - 100 * 86400000
    f.ledger.learning.enqueue({
      task: { ...f.task.task, createdAt, expiresAt: createdAt + 10000 },
      draft: f.task.draft,
      kind: 'correction',
      input: { sourceId: 'old-valid', text: '先核对状态', reason: '实际纠正' },
      at: Date.now()
    })
    f.client.learningSettings.mockResolvedValue(
      LearningSettingsSchema.parse({ caseRetentionDays: 365 })
    )
    await f.sync.flush()
    expect(f.client.recordLearningCorrection).toHaveBeenCalledTimes(2)
    expect(f.ledger.learning.state(f.scope, 'old-valid')).toBe('saved')
  })
  it('does not dispatch or invent a default policy when current policy lookup fails', async () => {
    const f = fixture()
    f.client.learningSettings.mockRejectedValue(new Error('offline'))
    await f.sync.flush()
    expect(f.client.recordLearningCorrection).not.toHaveBeenCalled()
    expect(f.ledger.learning.state(f.scope, 'policy-test')).toBe('pending')
    expect(f.failure).not.toHaveBeenCalled()
  })
  it('does not persist or use a late policy response after an account switch', async () => {
    const f = fixture()
    f.client.learningSettings.mockImplementation(async () => {
      f.change()
      return LearningSettingsSchema.parse({ caseRetentionDays: 7 })
    })
    await f.sync.flush()
    expect(f.client.recordLearningCorrection).not.toHaveBeenCalled()
    expect(f.ledger.learning.pending(f.scope)).toHaveLength(1)
  })
})
