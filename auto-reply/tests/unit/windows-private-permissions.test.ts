import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WindowsPrivatePermissionWorker } from '../../src/core/persistence/windows-private-permissions'

const workers: WindowsPrivatePermissionWorker[] = []
afterEach(() => {
  for (const worker of workers.splice(0)) worker.close()
  vi.useRealTimers()
})
function fixture() {
  vi.useFakeTimers()
  const messages: { id: string; root: string; paths: string[]; protect: boolean }[] = []
  const events = new EventEmitter()
  const child = Object.assign(events, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      events.emit('close', null)
      return true
    })
  })
  child.stdin.on('data', (data) => messages.push(JSON.parse(String(data))))
  const launch = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams)
  const worker = new WindowsPrivatePermissionWorker('synthetic-never-executed', '', launch)
  workers.push(worker)
  const reply = (value: unknown): void => {
    child.stdout.write(JSON.stringify(value) + '\n')
  }
  return { worker, child, messages, launch, reply }
}
describe('fresh private-permission worker protocol', () => {
  it('serializes fresh roots on one interpreter and expires its idle process', async () => {
    const f = fixture()
    const one = f.worker.request('one', ['one/file'], true)
    const two = f.worker.request('two', ['two/file'], false)
    expect(f.messages).toHaveLength(1)
    f.reply({ id: f.messages[0].id, ok: true })
    await one
    expect(f.messages.map((m) => [m.root, m.paths, m.protect])).toEqual([
      ['one', ['one/file'], true],
      ['two', ['two/file'], false]
    ])
    f.reply({ id: f.messages[1].id, ok: true })
    await two
    expect(f.launch).toHaveBeenCalledTimes(1)
    expect(f.child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.child.kill).toHaveBeenCalledTimes(1)
  })
  it('closes a completed standalone worker immediately without waiting for idle expiry', async () => {
    const f = fixture()
    const one = f.worker.request('one', ['one/file'], false)
    f.reply({ id: f.messages[0].id, ok: true })
    await one
    expect(f.child.kill).not.toHaveBeenCalled()
    f.worker.close()
    expect(f.child.kill).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.child.kill).toHaveBeenCalledTimes(1)
    await expect(f.worker.request('after-terminal-cleanup', [], false)).rejects.toThrow(
      'private_backup_permissions_invalid'
    )
  })
  it.each(['foreign-id', 'extra-fields', 'oversized', 'crash', 'timeout'])(
    'rejects the active and queued checks on %s without accepting old permission results',
    async (failure) => {
      const f = fixture()
      const one = f.worker.request('one', [], false),
        two = f.worker.request('two', [], false)
      const result = Promise.allSettled([one, two])
      if (failure === 'foreign-id') f.reply({ id: 'not-the-request', ok: true })
      else if (failure === 'extra-fields') f.reply({ id: f.messages[0].id, ok: true, root: 'one' })
      else if (failure === 'oversized') f.child.stdout.write('x'.repeat(4097))
      else if (failure === 'crash') f.child.emit('close', 1)
      else await vi.advanceTimersByTimeAsync(15000)
      expect((await result).map((r) => r.status)).toEqual(['rejected', 'rejected'])
      for (const item of await result)
        if (item.status === 'rejected')
          expect(item.reason.message).toBe('private_backup_permissions_invalid')
      expect(f.messages).toHaveLength(1)
      expect(f.child.kill).toHaveBeenCalledTimes(1)
    }
  )
  it('denies one check without reusing its result or denying an unrelated queued root', async () => {
    const f = fixture()
    const one = f.worker.request('denied', [], false)
    const rejected = expect(one).rejects.toThrow('private_backup_permissions_invalid')
    const two = f.worker.request('different', [], false)
    f.reply({ id: f.messages[0].id, ok: false })
    await rejected
    expect(f.messages[1].root).toBe('different')
    expect(f.messages[1].id).not.toBe(f.messages[0].id)
    f.reply({ id: f.messages[1].id, ok: true })
    await two
    expect(f.launch).toHaveBeenCalledTimes(1)
  })
  it('bounds outstanding checks and cannot reopen after explicit close', async () => {
    const f = fixture()
    const queued = Array.from({ length: 64 }, () => f.worker.request('one', [], false))
    const all = Promise.allSettled(queued)
    await expect(f.worker.request('overflow', [], false)).rejects.toThrow(
      'private_backup_permissions_invalid'
    )
    f.worker.close()
    expect((await all).every((r) => r.status === 'rejected')).toBe(true)
    await expect(f.worker.request('after-close', [], false)).rejects.toThrow(
      'private_backup_permissions_invalid'
    )
    expect(f.launch).toHaveBeenCalledTimes(1)
  })
})
