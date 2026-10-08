import { describe, expect, it } from 'vitest'
import * as view from '../../src/renderer/src/features/memory/learning-view-state'
import type { LearningWorkbenchSnapshot } from '../../src/shared/contracts/learning-desktop'
import type { MemoryScope } from '../../src/shared/contracts/learning-memory'

const enterprise: MemoryScope = {
  workspaceId: 'enterprise:hash',
  platform: 'wechat',
  tenantId: 'tenant',
  accountId: 'a'
}
function snapshot(scope: MemoryScope, scopes: MemoryScope[] = []): LearningWorkbenchSnapshot {
  return { scope, scopes } as LearningWorkbenchSnapshot
}

describe('learning window scope and response ownership', () => {
  it('offers only complete scopes belonging to the current enterprise account', () => {
    const customer = { ...enterprise, conversationId: 'customer' }
    const foreign = { ...enterprise, accountId: 'b' }
    const incomplete: MemoryScope = { workspaceId: enterprise.workspaceId, platform: 'wechat' }
    expect(
      view.learningScopeOptions(snapshot(enterprise, [customer, foreign, incomplete]))
    ).toEqual([enterprise, customer])
  })
  it('retains local platform choices without mixing another workspace or enterprise owner', () => {
    const local: MemoryScope = { workspaceId: 'local', platform: 'wechat' }
    const options = view.learningScopeOptions(
      snapshot(local, [local, enterprise, { ...local, workspaceId: 'other' }])
    )
    expect(options).toHaveLength(3)
    expect(options.map((scope) => scope.platform)).toEqual(['wechat', 'wework', 'generic'])
    expect(options.every((scope) => scope.workspaceId === 'local' && !scope.accountId)).toBe(true)
  })
  it('uses semantic scope identity regardless of object property order', () => {
    expect(view.learningScopeKey(enterprise)).toBe(
      view.learningScopeKey({
        accountId: 'a',
        tenantId: 'tenant',
        platform: 'wechat',
        workspaceId: 'enterprise:hash'
      })
    )
  })
  it('keeps the current scope value selected when the same authorized scope has another field order', () => {
    const reordered: MemoryScope = {
      accountId: 'a',
      tenantId: 'tenant',
      platform: 'wechat',
      workspaceId: 'enterprise:hash'
    }
    const options = view.learningScopeOptions(snapshot(enterprise, [reordered]))
    expect(options).toHaveLength(1)
    expect(JSON.stringify(options[0])).toBe(JSON.stringify(enterprise))
  })
  it('does not accept a detail or action response after a scope switch', () => {
    const guard = new view.LearningRequestGuard()
    guard.select(enterprise)
    const detail = guard.begin('detail'),
      mutation = guard.begin('mutation')
    guard.select({ ...enterprise, conversationId: 'other' })
    expect(guard.accepts(detail)).toBe(false)
    expect(guard.accepts(mutation)).toBe(false)
    expect(guard.accepts(guard.begin('snapshot'))).toBe(true)
  })
  it('rejects superseded reads but does not let a poll invalidate a pending mutation', () => {
    const guard = new view.LearningRequestGuard()
    guard.select(enterprise)
    const first = guard.begin('detail'),
      mutation = guard.begin('mutation')
    const latest = guard.begin('detail')
    guard.begin('snapshot')
    expect(guard.accepts(first)).toBe(false)
    expect(guard.accepts(latest)).toBe(true)
    expect(guard.accepts(mutation)).toBe(true)
    guard.invalidate('detail')
    expect(guard.accepts(latest)).toBe(false)
  })
  it('invalidates every in-flight response on unmount, including a return to the same scope', () => {
    const guard = new view.LearningRequestGuard()
    guard.select(enterprise)
    const token = guard.begin('mutation')
    guard.invalidateAll()
    guard.select(enterprise)
    expect(guard.accepts(token)).toBe(false)
  })
})
