import { describe, expect, it, vi } from 'vitest'
import { ForegroundBatchNavigator } from '../../src/main/services/foreground-batch-navigator'
import type { ForegroundWechatDriver } from '../../src/main/services/foreground-wechat-driver'
import type { ListRow } from '../../src/shared/contracts/foreground-batch'

describe('production batch navigation', () => {
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
