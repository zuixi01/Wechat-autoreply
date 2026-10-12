import { describe, expect, it, vi } from 'vitest'
import { ForegroundBatchNavigator } from '../../src/main/services/foreground-batch-navigator'
import type { ForegroundWechatDriver } from '../../src/main/services/foreground-wechat-driver'
import type { ListRow } from '../../src/shared/contracts/foreground-batch'

describe('production batch navigation', () => {
  it('falls back to a complete list scan when local search is incomplete', async () => {
    const rows: ListRow[] = [
      { name: 'A', nameComplete: true, preview: '新消息', unread: 1, point: [0.2, 0.3] }
    ]
    const driver = {
      showChatList: vi.fn(async () => {}),
      listPage: vi.fn(async () => ({ rows, atTop: true, atBottom: false })),
      verifyListName: vi.fn(async () => {
        throw new Error('list_incomplete')
      })
    }
    const navigator = new ForegroundBatchNavigator(
      driver as unknown as ForegroundWechatDriver,
      () => 'A'
    )
    expect(await navigator.inventory(['A'], new AbortController().signal)).toBeUndefined()
  })
  it('independently checks every visible target and isolates ambiguous names without opening a chat', async () => {
    const rows: ListRow[] = ['A', 'B'].map((name) => ({
      name,
      nameComplete: true,
      unread: 1,
      preview: '消息',
      point: [0.2, 0.3]
    }))
    const driver = {
      showChatList: vi.fn(async () => {}),
      listPage: vi.fn(async () => ({ rows, atTop: true, atBottom: false })),
      verifyListName: vi.fn(async (name: string) => name === 'B'),
      listOpen: vi.fn()
    }
    const navigator = new ForegroundBatchNavigator(
      driver as unknown as ForegroundWechatDriver,
      () => 'A'
    )
    const inventory = await navigator.inventory(['A', 'B'], new AbortController().signal)
    expect(inventory?.filter((row) => row.name === 'A')).toHaveLength(2)
    expect(inventory?.filter((row) => row.name === 'B')).toHaveLength(1)
    expect(driver.verifyListName.mock.calls.map(([name]) => name)).toEqual(['A', 'B'])
    expect(driver.listOpen).not.toHaveBeenCalled()
    expect(await navigator.inventory(['A', 'C'], new AbortController().signal)).toBeUndefined()
    expect(driver.verifyListName).toHaveBeenCalledTimes(2)
  })
  it('allows the native two-wheel edge proof to finish and rejects an unverified stationary list', async () => {
    const row: ListRow = {
      name: 'A',
      nameComplete: true,
      unread: 1,
      preview: '消息',
      point: [0.2, 0.3]
    }
    const page = { rows: [row], atTop: false, atBottom: false }
    const driver = { listPage: vi.fn(async () => page), listScroll: vi.fn(async () => {}) }
    driver.listPage
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce({ ...page, atTop: true })
    const navigator = new ForegroundBatchNavigator(
      driver as unknown as ForegroundWechatDriver,
      () => 'A'
    )
    // top() normally follows connect(); isolate its actual scrolling contract.
    Object.assign(driver, { showChatList: vi.fn(async () => {}) })
    await navigator.top(new AbortController().signal)
    expect(driver.listScroll).toHaveBeenCalledTimes(2)
    driver.listPage.mockReset().mockResolvedValue(page)
    driver.listScroll.mockClear()
    await expect(navigator.top(new AbortController().signal)).rejects.toThrow('list_incomplete')
    expect(driver.listScroll).toHaveBeenCalledTimes(2)
  })
  it('updates the selected-contact hint after every successful automatic switch', async () => {
    const driver = {
      connect: vi.fn(async () => {}),
      showChatList: vi.fn(async () => {}),
      listPage: vi.fn(async () => ({ rows: [], currentContact: 'A', atTop: true, atBottom: true })),
      listOpen: vi.fn(async () => {})
    }
    const navigator = new ForegroundBatchNavigator(
      driver as unknown as ForegroundWechatDriver,
      () => 'A'
    )
    const signal = new AbortController().signal
    await navigator.connect(signal, false)
    expect(driver.connect).toHaveBeenCalledWith('A', signal, 'current_chat', false)
    await navigator.page(signal)
    const row: ListRow = {
      name: 'B',
      nameComplete: true,
      unread: 1,
      preview: '新消息',
      point: [0.2, 0.3]
    }
    await navigator.open(row, signal)
    expect(navigator.currentContact()).toBe('B')
    driver.listOpen.mockRejectedValueOnce(new Error('list_changed'))
    await expect(navigator.open({ ...row, name: 'A' }, signal)).rejects.toThrow('list_changed')
    expect(navigator.currentContact()).toBe('B')
  })
})
