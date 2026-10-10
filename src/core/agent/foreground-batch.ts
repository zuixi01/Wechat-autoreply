import {
  ForegroundWechatRuntime,
  type ForegroundDriver,
  type ForegroundJournal
} from './foreground-wechat'
import {
  findForegroundRow,
  scanForegroundList,
  mayMatchTruncatedName
} from './foreground-list-scan'
import type { BatchNavigator, BatchStatus, ListRow } from '../../shared/contracts/foreground-batch'
import type { ForegroundCheckpoint } from '../../shared/contracts/foreground-wechat'

export interface ForegroundBatchStore {
  loadBatch(
    targets: string[],
    includeCompleted?: boolean
  ): { row: ListRow; checkpoint?: ForegroundCheckpoint }[]
  loadSingle?(target: string): ForegroundCheckpoint | undefined
  saveBatchHint(row: ListRow): void
  saveBatch(row: ListRow, checkpoint: ForegroundCheckpoint): void
}

const active = new Set(['connecting', 'scanning', 'processing', 'waiting_foreground', 'recovering'])
const transient = new Set([
  'model_network_failed',
  'model_timeout',
  'model_busy',
  'model_response_invalid',
  'visual_response_invalid',
  'capture_failed',
  'window_query_failed',
  'wechat_window_unavailable',
  'list_incomplete',
  'list_unavailable'
])
/** One physical desktop, one serialized work loop, independent per-contact history baselines. */
export class ForegroundBatchRuntime {
  private state: BatchStatus['state'] = 'idle'
  private reason = 'none'
  private targets: string[] = []
  private current = ''
  private discovered = 0
  private pages = 0
  private complete = false
  private navigationReady = false
  private connected = false
  private recoveryAttempts = 0
  private nextRetryAt?: number
  private queue: ListRow[] = []
  private issues = new Map<string, string>()
  private sessions = new Map<string, ForegroundWechatRuntime>()
  private checkpoints = new Map<string, { row: ListRow; checkpoint?: ForegroundCheckpoint }>()
  private controller?: AbortController
  private work?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  constructor(
    private readonly navigator: BatchNavigator,
    private readonly driver: (target: string) => ForegroundDriver,
    private readonly journal: ForegroundJournal,
    private readonly polling = true,
    private readonly store?: ForegroundBatchStore
  ) {}
  status(): BatchStatus {
    return {
      state: this.state,
      reason: this.reason,
      targets: [...this.targets],
      current: this.current,
      discovered: this.discovered,
      pages: this.pages,
      pending: this.queue.length,
      scanComplete: this.complete,
      nextRetryAt: this.nextRetryAt,
      issues: [...this.issues].map(([target, reason]) => ({ target, reason })),
      records: [
        ...(this.journal.unresolved?.() ?? []).slice(0, 50),
        ...this.journal.list(50).slice(-50).reverse()
      ]
        .filter((record, index, all) => all.findIndex((value) => value.id === record.id) === index)
        .slice(0, 50)
    }
  }
  async start(targets: string[]): Promise<BatchStatus> {
    if (active.has(this.state) || this.work) return this.status()
    if (
      this.journal.hasUnknown?.() ??
      this.journal.list().some((record) => record.state === 'unknown')
    ) {
      this.state = 'paused'
      this.reason = 'send_unknown'
      return this.status()
    }
    this.targets = [...targets]
    this.checkpoints.clear()
    for (const value of this.store?.loadBatch(targets, true) ?? [])
      this.checkpoints.set(value.row.name, value)
    this.sessions.clear()
    this.issues.clear()
    this.queue = []
    this.discovered = 0
    this.pages = 0
    this.complete = false
    this.current = ''
    this.connected = false
    this.recoveryAttempts = 0
    this.nextRetryAt = undefined
    this.reason = 'none'
    this.state = 'connecting'
    const controller = new AbortController()
    this.controller = controller
    const work = (async () => {
      try {
        await this.navigator.connect(controller.signal)
        this.connected = true
        if (!controller.signal.aborted) this.state = 'scanning'
      } catch (error) {
        if (!controller.signal.aborted) {
          const code = this.code(error)
          this.recover(code)
        }
      }
    })()
    this.work = work
    try {
      await work
    } finally {
      if (this.work === work) this.work = undefined
    }
    this.schedule()
    return this.status()
  }
  async pause(): Promise<BatchStatus> {
    this.controller?.abort()
    clearTimeout(this.timer)
    this.state = 'paused'
    this.reason = 'user_pause'
    this.nextRetryAt = undefined
    // Pause children immediately; never wait for the parent while a child can still dispatch.
    await Promise.all([...this.sessions.values()].map((session) => session.pause()))
    await this.work
    return this.status()
  }
  tick(): Promise<void> {
    if (this.work) return this.work
    const work = this.cycle()
    this.work = work
    return work.finally(() => {
      if (this.work === work) this.work = undefined
    })
  }
  private schedule(): void {
    if (!this.polling || !active.has(this.state)) return
    const delay =
      this.state === 'recovering'
        ? Math.min(30000, 1000 * 2 ** Math.max(0, this.recoveryAttempts - 1))
        : this.state === 'waiting_foreground'
          ? 1000
          : 1500
    this.nextRetryAt = this.state === 'recovering' ? Date.now() + delay : undefined
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule())
    }, delay)
  }
  private code(error: unknown): string {
    if (error instanceof Error && error.name === 'ZodError') return 'visual_response_invalid'
    return error instanceof Error && /^[a-z_]{1,128}$/.test(error.message)
      ? error.message
      : 'read_failed'
  }
  private fail(reason: string): void {
    this.controller?.abort()
    clearTimeout(this.timer)
    this.reason = reason
    this.state = 'paused'
    this.nextRetryAt = undefined
    for (const session of this.sessions.values()) void session.pause()
  }
  private recover(code: string): void {
    this.navigationReady = false
    this.reason = code
    this.nextRetryAt = undefined
    if (code === 'foreground_lost' || code === 'screen_obscured') this.state = 'waiting_foreground'
    else if (transient.has(code)) {
      this.recoveryAttempts = Math.min(6, this.recoveryAttempts + 1)
      this.state = 'recovering'
    } else this.fail(code)
  }
  private pendingCheckpoint(name: string): boolean {
    const value = this.checkpoints.get(name)
    return Boolean(value && (value.checkpoint?.pending ?? true))
  }
  private async cycle(): Promise<void> {
    const signal = this.controller?.signal
    if (!signal || signal.aborted || !active.has(this.state)) return
    try {
      if (!this.connected) {
        await this.navigator.connect(signal, false)
        this.connected = true
      }
      if (!this.queue.length) {
        this.navigationReady = false
        this.state = 'scanning'
        this.current = ''
        this.complete = false
        const rows = await scanForegroundList(this.navigator, signal, (pages, rows) => {
          if (signal.aborted) return
          this.pages = pages
          this.discovered = rows.length
        })
        if (signal.aborted) return
        const names = new Map<string, number>()
        for (const row of rows)
          if (row.nameComplete) names.set(row.name, (names.get(row.name) ?? 0) + 1)
        for (const name of this.targets) {
          if ((names.get(name) ?? 0) > 1 || rows.some((row) => mayMatchTruncatedName(row, name)))
            this.issues.set(name, 'contact_not_unique')
          else if (!names.has(name)) this.issues.set(name, 'target_not_found')
          else if (['target_not_found', 'contact_not_unique'].includes(this.issues.get(name) ?? ''))
            this.issues.delete(name)
          else if (this.issues.get(name) === 'unread_message_unverified') {
            const row = rows.find((value) => value.name === name && value.nameComplete)!
            if (row.unreadDot || (row.unread !== null && row.unread <= 80)) this.issues.delete(name)
          }
        }
        this.queue = rows
          .filter(
            (row) =>
              this.targets.includes(row.name) &&
              row.nameComplete &&
              !this.issues.has(row.name) &&
              (row.unread !== 0 ||
                row.name === this.navigator.currentContact?.() ||
                this.sessions.get(row.name)?.hasPending() ||
                this.pendingCheckpoint(row.name))
          )
          .map((row) =>
            row.unread === 0 && this.pendingCheckpoint(row.name)
              ? this.checkpoints.get(row.name)!.row
              : row
          )
        this.complete = true
        this.recoveryAttempts = 0
      }
      this.reason = 'none'
      this.nextRetryAt = undefined
      const row = this.queue[0]
      if (!row) {
        this.state = 'scanning'
        return
      }
      this.current = row.name
      this.state = 'processing'
      if ((row.unread === null && !row.unreadDot) || (row.unread !== null && row.unread > 80)) {
        this.issues.set(row.name, 'unread_message_unverified')
        this.queue.shift()
        return
      }
      const verifyPreview = !this.sessions.has(row.name) && !this.pendingCheckpoint(row.name)
      if (!this.checkpoints.has(row.name)) {
        const checkpoint = this.store?.loadSingle?.(row.name)
        if (checkpoint) this.checkpoints.set(row.name, { row, checkpoint })
      }
      if (
        row.unread !== 0 &&
        !this.checkpoints.get(row.name)?.checkpoint &&
        !this.sessions.has(row.name)
      ) {
        this.store?.saveBatchHint(row)
        this.checkpoints.set(row.name, { row })
      }
      if (row.name !== this.navigator.currentContact?.())
        await findForegroundRow(this.navigator, row, signal, verifyPreview, this.navigationReady)
      this.navigationReady = true
      if (signal.aborted) return
      let session = this.sessions.get(row.name)
      if (!session) {
        session = new ForegroundWechatRuntime(
          this.driver(row.name),
          this.journal,
          false,
          (checkpoint) => {
            this.checkpoints.set(row.name, { row, checkpoint })
            this.store?.saveBatch(row, checkpoint)
          }
        )
        this.sessions.set(row.name, session)
        await session.start(
          row.name,
          'current_chat',
          row.unread === 0 ? undefined : { count: row.unread, preview: row.preview },
          this.checkpoints.get(row.name)?.checkpoint
        )
      } else if (
        session.status().state === 'paused' &&
        session.status().reason === 'foreground_lost'
      ) {
        await session.start(row.name, 'current_chat', { count: row.unread, preview: row.preview })
      }
      if (signal.aborted) return
      await session.tick()
      if (signal.aborted) return
      const status = session.status()
      if (status.reason === 'send_unknown') {
        this.fail('send_unknown')
        return
      }
      if (status.state === 'waiting_foreground' || status.reason === 'foreground_lost') {
        this.state = 'waiting_foreground'
        this.reason = status.reason
        return
      }
      if (status.state === 'paused') this.issues.set(row.name, status.reason)
      if (status.state === 'recovering') {
        this.state = 'recovering'
        this.reason = status.reason
        this.recoveryAttempts = status.recoveryAttempts ?? 1
        return
      }
      if (status.state === 'running' && session.hasPending()) return
      this.queue.shift()
    } catch (error) {
      if (signal.aborted) return
      const code = this.code(error)
      if (code === 'list_changed') {
        this.queue = []
        this.complete = false
        this.state = 'scanning'
        this.reason = code
      } else this.recover(code)
    }
  }
}
