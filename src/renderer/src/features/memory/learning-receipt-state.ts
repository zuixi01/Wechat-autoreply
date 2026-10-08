import type { DeviceStatus } from '../../../../shared/contracts/registration'
import type { MemoryScope } from '../../../../shared/contracts/learning-memory'
import type { LearningSubmissionReceipt } from '../../../../shared/contracts/learning-submissions'
import { learningScopeKey } from './learning-view-state'
import { LearningSubmissionReadResultSchema } from '../../../../shared/contracts/learning-submission-desktop'

export function receiptAuthority(scope: MemoryScope, status?: DeviceStatus): string | undefined {
  if (!scope.tenantId && !scope.accountId && !scope.workspaceId.startsWith('enterprise:'))
    return `local:${learningScopeKey(scope)}`
  const device = status?.scope
  if (!device || !status?.serverUrl || !['registered', 'connected'].includes(status.state) ||
    device.tenant_id !== scope.tenantId || device.account_id !== scope.accountId || device.platform !== scope.platform)
    return undefined
  return JSON.stringify([status.serverUrl, device.tenant_id, device.account_id, device.employee_id, device.agent_id, device.platform])
}

/** Only strict plain transient results qualify; thrown errors never retain private rows. */
export function receiptTransportUnavailable(value: unknown): boolean {
  const parsed = LearningSubmissionReadResultSchema.safeParse(value)
  return parsed.success && parsed.data.status === 'unavailable'
}
export function retainedConfirmedReceipts(
  rows: LearningSubmissionReceipt[],
  previousAuthority: string | undefined,
  currentAuthority: string | undefined,
  error: unknown
): LearningSubmissionReceipt[] {
  return previousAuthority && previousAuthority === currentAuthority && receiptTransportUnavailable(error)
    ? rows.filter((row) => row.state === 'saved')
    : []
}
