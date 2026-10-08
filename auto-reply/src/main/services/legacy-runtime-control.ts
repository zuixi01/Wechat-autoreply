import type { RuntimeStatus } from '../../shared/contracts/runtime'
import type { SkillPauseResult } from '../skill-server'

export interface PausableRuntime {
  status(): RuntimeStatus
  pause(): Promise<RuntimeStatus>
}

/** Old stop controls remain meaningful while employees migrate to the new workbench. */
export async function pauseAllReplyRuntimes(
  runtime: PausableRuntime | undefined,
  stopLegacy: () => Promise<SkillPauseResult>
): Promise<SkillPauseResult> {
  const results = await Promise.allSettled([
    runtime ? runtime.pause() : Promise.resolve(undefined),
    stopLegacy()
  ])
  const [reliable, legacy] = results
  if (
    reliable.status === 'rejected' ||
    legacy.status === 'rejected' ||
    (reliable.value && !reliable.value.pauseAcknowledged) ||
    (!legacy.value.ok && legacy.value.reason !== 'not_running')
  )
    return {
      ok: false,
      reason: 'pause_failed',
      message: '暂停尚未完成，请保持暂停并检查运行状态。'
    }
  if (reliable.value || legacy.value.ok) return { ok: true }
  return legacy.value
}
