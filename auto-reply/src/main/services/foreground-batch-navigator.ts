import { hashContext } from '../../core/reply/hashes'
import { rowKey } from '../../core/agent/foreground-list-scan'
import type { BatchNavigator, ListPage, ListRow } from '../../shared/contracts/foreground-batch'
import { ForegroundWechatDriver } from './foreground-wechat-driver'

export class ForegroundBatchNavigator implements BatchNavigator {
  private current = ''
  private prepared = false
  currentContact(): string {
    return this.current
  }
  constructor(
    private readonly driver: ForegroundWechatDriver,
    private readonly target: () => string
  ) {}
  async connect(signal: AbortSignal): Promise<void> {
    this.prepared = false
    this.current = ''
    await this.driver.connect(this.target(), signal, 'current_chat')
    await this.driver.showChatList(signal)
    this.prepared = true
  }
  async top(signal: AbortSignal): Promise<void> {
    let previous = ''
    for (let attempt = 0; attempt < 100; attempt++) {
      const page = await this.page(signal)
      const key = hashContext(page.rows.map(rowKey))
      if (key === previous) {
        if (!page.atTop) throw new Error('list_incomplete')
        return
      }
      previous = key
      await this.driver.listScroll(true, signal)
    }
    throw new Error('list_limit')
  }
  async page(signal: AbortSignal): Promise<ListPage> {
    if (!this.prepared) {
      await this.driver.showChatList(signal)
      this.prepared = true
    }
    const page = await this.driver.listPage(signal)
    this.current = page.currentContact ?? ''
    return page
  }
  down(signal: AbortSignal): Promise<void> {
    return this.driver.listScroll(false, signal)
  }
  open(row: ListRow, signal: AbortSignal): Promise<void> {
    return this.driver.listOpen(row, signal)
  }
}
