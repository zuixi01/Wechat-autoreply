import { ipcMain } from 'electron'
import { rendererTrust } from './trusted-ipc'
import {
  LearningSubmissionDesktopRequests,
  LearningSubmissionReadTransientSchema,
  type LearningSubmissionReadTransient
} from '../../shared/contracts/learning-submission-desktop'
import type { MemoryScope } from '../../shared/contracts/learning-memory'
import type { DesktopAgentRuntime } from '../services/desktop-agent-runtime'

function transientReadCode(error: unknown): LearningSubmissionReadTransient['code'] | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  if (error.code === 'network_unavailable') return 'network_unavailable'
  if (
    error.code === 'ERR_SQLITE_ERROR' &&
    'errcode' in error &&
    (error.errcode === 5 || error.errcode === 6)
  )
    return 'storage_busy'
  return undefined
}

export function registerLearningSubmissionIpc(
  file: string,
  origin: string | undefined,
  runtime: DesktopAgentRuntime,
  assertReceiptScope?: (scope: MemoryScope) => void
): void {
  const trust = rendererTrust(file, origin)
  ipcMain.handle('learning-submission:submit', (event, raw: unknown) => {
    trust(event)
    return runtime.submitLearning(LearningSubmissionDesktopRequests.submit.parse(raw))
  })
  ipcMain.handle('learning-submission:receipts', (event, raw: unknown) => {
    trust(event)
    const { scope } = LearningSubmissionDesktopRequests.receipts.parse(raw)
    // Scope/authority failures, including errors in the guard itself, are never transient reads.
    assertReceiptScope?.(scope)
    try {
      return runtime.learningSubmissions(scope)
    } catch (error) {
      const code = assertReceiptScope && transientReadCode(error)
      if (!code) throw error
      return LearningSubmissionReadTransientSchema.parse({ status: 'unavailable', code })
    }
  })
}
