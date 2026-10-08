import { describe, expect, it, vi } from 'vitest'
import {
  pauseAllReplyRuntimes,
  type PausableRuntime
} from '../../src/main/services/legacy-runtime-control'

function runtime(acknowledged: boolean): PausableRuntime {
  return {
    pause: vi.fn(async () => ({ pauseAcknowledged: acknowledged }) as never),
    status: vi.fn()
  }
}

describe('legacy stop control migration', () => {
  it('pauses the reliable runtime even when the legacy engine or mode is absent', async () => {
    const reliable = runtime(true)
    expect(
      await pauseAllReplyRuntimes(reliable, async () => ({ ok: false, reason: 'not_running' }))
    ).toEqual({ ok: true })
    expect(reliable.pause).toHaveBeenCalledOnce()
  })
  it('never reports success before the actual reliable stop acknowledgement', async () => {
    expect(await pauseAllReplyRuntimes(runtime(false), async () => ({ ok: true }))).toMatchObject({
      ok: false,
      reason: 'pause_failed'
    })
  })
  it('still attempts both stops if either rejects, without leaking the exception', async () => {
    const reliable = runtime(true)
    const legacy = vi.fn(async () => {
      throw new Error('private-secret')
    })
    const result = await pauseAllReplyRuntimes(reliable, legacy)
    expect(result).toMatchObject({ ok: false, reason: 'pause_failed' })
    expect(JSON.stringify(result)).not.toContain('private-secret')
    expect(reliable.pause).toHaveBeenCalledOnce()
    expect(legacy).toHaveBeenCalledOnce()
  })
  it('retains the not-running result if neither runtime exists', async () => {
    expect(
      await pauseAllReplyRuntimes(undefined, async () => ({ ok: false, reason: 'not_running' }))
    ).toEqual({ ok: false, reason: 'not_running' })
  })
})
