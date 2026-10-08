import { describe, expect, it } from 'vitest'
import { receiptAuthority, retainedConfirmedReceipts } from '../../src/renderer/src/features/memory/learning-receipt-state'
import { teachingDraft, teachingScopeAvailable } from '../../src/renderer/src/features/memory/learning-teaching-draft'
import type { MemoryScope } from '../../src/shared/contracts/learning-memory'
import type { DeviceStatus } from '../../src/shared/contracts/registration'
import type { LearningSubmissionReceipt } from '../../src/shared/contracts/learning-submissions'

const scope: MemoryScope = { workspaceId: 'enterprise:a', tenantId: 'tenant', accountId: 'account', platform: 'wechat' }
const status: DeviceStatus = { state: 'connected', serverUrl: 'https://server.example', scope: {
  tenant_id: 'tenant', account_id: 'account', employee_id: 'employee', agent_id: 'agent', platform: 'wechat'
} }
const receipts: LearningSubmissionReceipt[] = [
  { sourceId: 'saved', kind: 'manual', state: 'saved', firstSubmittedAt: 1, evidenceAt: 1 },
  { sourceId: 'pending', kind: 'manual', state: 'pending', firstSubmittedAt: 1, evidenceAt: 1 }
]
describe('legacy teaching draft and confirmed receipt display', () => {
  it('transfers employee text without inheriting trace identity, references or activation', () => {
    expect(teachingDraft('draft', '报价', '先核对资料', '不得猜测')).toEqual({ id: 'draft',
      content: { kind: 'lesson', scenario: '报价', guidance: '先核对资料', rationale: '不得猜测', steps: [], pitfalls: [], verification: [] }, reason: '不得猜测' })
    expect(teachingScopeAvailable({ ...scope, conversationId: 'unassigned:unknown' })).toBe(false)
    expect(teachingScopeAvailable(scope)).toBe(true)
  })
  it('keeps only explicitly confirmed saves under the same authority on a coded transport failure', () => {
    const authority = receiptAuthority(scope, status)
    expect(retainedConfirmedReceipts(receipts, authority, authority, { status: 'unavailable', code: 'network_unavailable' })).toEqual([receipts[0]])
    expect(retainedConfirmedReceipts(receipts, authority, authority, { status: 'unavailable', code: 'storage_busy' })).toEqual([receipts[0]])
    expect(retainedConfirmedReceipts(receipts, authority, authority, { code: 'network_unavailable' })).toEqual([])
    expect(retainedConfirmedReceipts(receipts, authority, authority, { status: 'unavailable', code: 'network_unavailable', extra: 'untrusted' })).toEqual([])
    expect(retainedConfirmedReceipts(receipts, authority, authority, new Error('NETWORK_UNAVAILABLE'))).toEqual([])
    expect(retainedConfirmedReceipts(receipts, authority, authority, { code: 'AUTHORIZATION_FAILED' })).toEqual([])
    expect(retainedConfirmedReceipts(receipts, authority, authority, { message: 'No handler registered' })).toEqual([])
  })
  it('clears display across device, employee, server, account and unavailable authority changes', () => {
    const authority = receiptAuthority(scope, status)
    const variants: DeviceStatus[] = [
      { ...status, scope: { ...status.scope!, agent_id: 'new-agent' } },
      { ...status, scope: { ...status.scope!, employee_id: 'new-employee' } },
      { ...status, serverUrl: 'https://other.example' },
      { ...status, scope: { ...status.scope!, account_id: 'other' } },
      { ...status, state: 'unavailable' }
    ]
    for (const variant of variants)
      expect(retainedConfirmedReceipts(receipts, authority, receiptAuthority(scope, variant), { status: 'unavailable', code: 'network_unavailable' })).toEqual([])
    expect(retainedConfirmedReceipts(receipts, authority, undefined, { status: 'unavailable', code: 'network_unavailable' })).toEqual([])
  })
})
