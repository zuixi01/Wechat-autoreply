import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  WorkbenchPresentationCapture,
  type HostPresentationTarget
} from '../../src/main/services/workbench-presentation-capture'
import { taskFixture } from '../fixtures/task'

function fixture() {
  let now = 100,
    visible = true
  const target: HostPresentationTarget = {
    task: taskFixture().task,
    row: {
      taskId: 'task-A',
      conversationId: 'customer-A',
      version: 'a'.repeat(64),
      status: 'needs_human',
      inboundPreview: 'SYNTHETIC_INBOUND',
      replyText: 'SYNTHETIC_REPLY',
      createdAt: 1,
      updatedAt: 2,
      humanOwned: false,
      stopAcknowledged: true,
      canSkip: false,
      canRelease: false,
      canReview: false,
      canConfirm: false,
      canReadEvidence: false,
      canLearn: false,
      learningPending: false,
      reconciliationRequired: false,
      canReconcile: false
    }
  }
  let current: HostPresentationTarget | undefined = target
  const record = vi.fn(() => true),
    surface = {
      owner: 7,
      document: 'frame-1',
      visible: () => visible,
      inspect: vi.fn(async () => true),
      capture: vi.fn(async () => true)
    }
  const capture = new WorkbenchPresentationCapture(
    () => current,
    record,
    () => now
  )
  const issue = () =>
    capture.issue({ taskId: 'task-A', expectedVersion: target.row.version }, surface)
  const nonce = (): string => {
    const ticket = issue()
    if (!ticket.available) throw new Error('fixture_ticket_missing')
    return ticket.nonce
  }
  return {
    capture,
    surface,
    record,
    target,
    issue,
    nonce,
    clock: (value: number) => {
      now = value
    },
    visible: (value: boolean) => {
      visible = value
    },
    change: () => {
      current = { ...target, row: { ...target.row, replyText: 'changed' } }
    },
    remove: () => {
      current = undefined
    }
  }
}
describe('host workbench presentation receipts', () => {
  it('bounds outstanding private targets and releases expired capacity', () => {
    const f = fixture()
    for (let owner = 1; owner <= 64; owner++)
      expect(
        f.capture.issue(
          { taskId: 'task-A', expectedVersion: f.target.row.version },
          { ...f.surface, owner }
        ).available
      ).toBe(true)
    expect(
      f.capture.issue(
        { taskId: 'task-A', expectedVersion: f.target.row.version },
        { ...f.surface, owner: 65 }
      ).available
    ).toBe(false)
    f.clock(30100)
    expect(
      f.capture.issue(
        { taskId: 'task-A', expectedVersion: f.target.row.version },
        { ...f.surface, owner: 65 }
      ).available
    ).toBe(true)
  })
  it('allows only one compositor inspection at a time without consuming another document receipt', async () => {
    const f = fixture(),
      first = f.nonce(),
      other = { ...f.surface, owner: 8 }
    const ticket = f.capture.issue(
      { taskId: 'task-A', expectedVersion: f.target.row.version },
      other
    )
    if (!ticket.available) throw new Error('fixture_ticket_missing')
    let finish!: (value: boolean) => void
    f.surface.capture.mockImplementation(
      () =>
        new Promise<boolean>((done) => {
          finish = done
        })
    )
    const pending = f.capture.acknowledge({ nonce: first }, f.surface)
    await vi.waitFor(() => expect(f.surface.capture).toHaveBeenCalledOnce())
    expect(await f.capture.acknowledge({ nonce: ticket.nonce }, other)).toEqual({ accepted: false })
    expect(f.record).not.toHaveBeenCalled()
    finish(true)
    expect(await pending).toEqual({ accepted: true })
  })
  it('times out a stalled inspection and never records its late result', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture(),
        nonce = f.nonce()
      let finish!: (value: boolean) => void
      f.surface.inspect.mockImplementation(
        () =>
          new Promise<boolean>((done) => {
            finish = done
          })
      )
      const pending = f.capture.acknowledge({ nonce }, f.surface)
      await vi.advanceTimersByTimeAsync(2501)
      expect(await pending).toEqual({ accepted: false })
      finish(true)
      await Promise.resolve()
      expect(f.surface.capture).not.toHaveBeenCalled()
      expect(f.record).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('records the host clock after DOM, compositor and current-version rechecks, exactly once', async () => {
    const f = fixture(),
      nonce = f.nonce()
    f.surface.capture.mockImplementation(async () => {
      f.clock(200)
      return true
    })
    expect(await f.capture.acknowledge({ nonce }, f.surface)).toEqual({ accepted: true })
    expect(f.surface.inspect).toHaveBeenCalledTimes(2)
    expect(f.record).toHaveBeenCalledWith(
      expect.objectContaining({ atMs: 200, receiptId: nonce, webContentsId: 7 })
    )
    expect(await f.capture.acknowledge({ nonce }, f.surface)).toEqual({ accepted: false })
    expect(f.record).toHaveBeenCalledOnce()
  })
  it('rejects forged clocks, scope, unknown nonces and foreign documents without consuming the owner receipt', async () => {
    const f = fixture(),
      nonce = f.nonce()
    for (const input of [
      { nonce, atMs: 1 },
      { nonce, accountId: 'foreign' },
      { nonce: randomUUID() }
    ])
      expect(await f.capture.acknowledge(input, f.surface)).toEqual({ accepted: false })
    expect(await f.capture.acknowledge({ nonce }, { ...f.surface, owner: 8 })).toEqual({
      accepted: false
    })
    expect(
      await f.capture.acknowledge({ nonce }, { ...f.surface, document: 'new-document' })
    ).toEqual({ accepted: false })
    expect(await f.capture.acknowledge({ nonce }, f.surface)).toEqual({ accepted: true })
  })
  it.each(['hidden', 'expired', 'changed', 'removed', 'closed'] as const)(
    'rejects %s captures before inspecting the renderer',
    async (mode) => {
      const f = fixture(),
        nonce = f.nonce()
      if (mode === 'hidden') f.visible(false)
      if (mode === 'expired') f.clock(30100)
      if (mode === 'changed') f.change()
      if (mode === 'removed') f.remove()
      if (mode === 'closed') f.capture.close()
      expect(await f.capture.acknowledge({ nonce }, f.surface)).toEqual({ accepted: false })
      expect(f.surface.inspect).not.toHaveBeenCalled()
      expect(f.record).not.toHaveBeenCalled()
    }
  )
  it.each(['dom', 'compositor', 'focus', 'current', 'shutdown'] as const)(
    'keeps %s failure during frame capture unconfirmed',
    async (mode) => {
      const f = fixture(),
        nonce = f.nonce()
      if (mode === 'dom') f.surface.inspect.mockResolvedValue(false)
      if (mode === 'compositor') f.surface.capture.mockResolvedValue(false)
      if (mode === 'focus')
        f.surface.capture.mockImplementation(async () => {
          f.visible(false)
          return true
        })
      if (mode === 'current')
        f.surface.capture.mockImplementation(async () => {
          f.change()
          return true
        })
      if (mode === 'shutdown')
        f.surface.capture.mockImplementation(async () => {
          f.capture.close()
          return true
        })
      expect(await f.capture.acknowledge({ nonce }, f.surface)).toEqual({ accepted: false })
      expect(f.record).not.toHaveBeenCalled()
    }
  )
  it('does not issue hidden, malformed or replaced receipts', async () => {
    const f = fixture(),
      old = f.nonce(),
      next = f.nonce()
    expect(await f.capture.acknowledge({ nonce: old }, f.surface)).toEqual({ accepted: false })
    expect(await f.capture.acknowledge({ nonce: next }, f.surface)).toEqual({ accepted: true })
    f.visible(false)
    expect(f.issue()).toEqual({ available: false })
    expect(
      f.capture.issue({ taskId: 'task-A', expectedVersion: 'a'.repeat(64), atMs: 1 }, f.surface)
    ).toEqual({ available: false })
  })
})
