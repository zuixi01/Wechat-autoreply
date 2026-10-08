import { appendFile, lstat, readdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { protectPrivateDirectory, verifyPrivatePaths } from './private-backup-directory'

const Limits = z.strictObject({
  maxPending: z.number().int().min(1).max(64).default(64),
  maxRecords: z.number().int().min(1).max(10000).default(10000),
  maxBytes: z
    .number()
    .int()
    .min(1024)
    .max(64 * 1024 * 1024)
    .default(64 * 1024 * 1024)
})
export interface TimingJournalHealth {
  sessionId: string
  records: number
  dropped: number
  pending: number
  bytes: number
  closed: boolean
  reason?: 'journal_capacity_exceeded' | 'journal_write_failed' | 'journal_record_invalid'
}
export interface TimingJournalPolicy {
  /** A durable storage fence, run before append, seal and report writes. No renderer input. */
  beforeWrite(record?: unknown): Promise<void>
}
/** One bounded, private session. offer is synchronous; reply processing never waits for disk. */
export class PrivateRuntimeTimingJournal {
  readonly sessionId: string
  private readonly queue: string[] = []
  private readonly limits: z.infer<typeof Limits>
  private work?: Promise<void>
  private records = 0
  private accepted = 0
  private dropped = 0
  private bytes = 0
  private inFlight = 0
  private closed = false
  private closing?: Promise<TimingJournalHealth>
  private forgetting?: Promise<void>
  private broken = false
  private forgotten = false
  private directoryIdentity?: { dev: number; ino: number }
  private reason?: TimingJournalHealth['reason']
  readonly directory: string
  private constructor(
    directory: string,
    limits: unknown,
    private readonly policy?: TimingJournalPolicy,
    sessionId?: string
  ) {
    this.sessionId = z.uuid().parse(sessionId ?? randomUUID())
    this.directory = resolve(directory)
    this.limits = Limits.parse(limits)
  }
  static async open(
    directory: string,
    limits: unknown = {},
    policy?: TimingJournalPolicy,
    sessionId?: string
  ): Promise<PrivateRuntimeTimingJournal> {
    const journal = new PrivateRuntimeTimingJournal(directory, limits, policy, sessionId)
    directory = journal.directory
    await protectPrivateDirectory(directory)
    const info = await lstat(directory)
    journal.directoryIdentity = { dev: info.dev, ino: info.ino }
    const header =
      JSON.stringify({
        schema: 'autoreply-runtime-timing-v1',
        sessionId: journal.sessionId,
        openedAt: Date.now()
      }) + '\n'
    await writeFile(join(directory, 'events.private.jsonl'), header, {
      flag: 'wx',
      mode: 0o600,
      flush: true
    })
    await journal.verifyLog()
    journal.bytes = Buffer.byteLength(header)
    return journal
  }
  offer(value: unknown): boolean {
    if (this.closed || this.reason) {
      if (this.closed && !this.reason) this.reason = 'journal_record_invalid'
      this.dropped++
      return false
    }
    let line: string
    try {
      line = JSON.stringify(value) + '\n'
      if (line === 'undefined\n') throw new Error('invalid_record')
    } catch {
      this.reason = 'journal_record_invalid'
      this.dropped++
      return false
    }
    const size = Buffer.byteLength(line)
    if (
      size > 256 * 1024 ||
      this.accepted >= this.limits.maxRecords ||
      this.queue.length + this.inFlight >= this.limits.maxPending ||
      this.bytes + size + 512 > this.limits.maxBytes
    ) {
      this.reason = 'journal_capacity_exceeded'
      this.dropped++
      return false
    }
    this.accepted++
    this.bytes += size
    this.queue.push(line)
    this.pump()
    return true
  }
  private pump(): void {
    if (this.work || this.broken || !this.queue.length) return
    this.work = this.writeQueue().finally(() => {
      this.work = undefined
      this.pump()
    })
  }
  private async verifyLog(): Promise<void> {
    const path = join(this.directory, 'events.private.jsonl')
    await verifyPrivatePaths(this.directory, [path])
    const root = await lstat(this.directory),
      file = await lstat(path)
    if (
      root.dev !== this.directoryIdentity?.dev ||
      root.ino !== this.directoryIdentity?.ino ||
      !file.isFile() ||
      file.nlink !== 1 ||
      file.size > this.limits.maxBytes
    )
      throw new Error('runtime_timing_log_invalid')
  }
  private async writeQueue(): Promise<void> {
    while (this.queue.length && !this.broken) {
      const line = this.queue.shift()!
      this.inFlight = 1
      try {
        await this.policy?.beforeWrite(JSON.parse(line))
        await this.verifyLog()
        await appendFile(join(this.directory, 'events.private.jsonl'), line)
        this.records++
      } catch {
        this.reason = 'journal_write_failed'
        this.broken = true
        this.dropped += 1 + this.queue.length
        this.queue.length = 0
      } finally {
        this.inFlight = 0
      }
    }
  }
  health(): TimingJournalHealth {
    return {
      ...{
        sessionId: this.sessionId,
        records: this.records,
        dropped: this.dropped,
        pending: this.queue.length + this.inFlight,
        bytes: this.bytes,
        closed: this.closed
      },
      ...(this.reason ? { reason: this.reason } : {})
    }
  }
  async drain(): Promise<TimingJournalHealth> {
    while (this.work) await this.work
    return this.health()
  }
  close(): Promise<TimingJournalHealth> {
    if (this.closing) return this.closing
    if (this.closed) return this.drain()
    const work = this.closeCore()
    this.closing = work
    const settled = (): void => {
      if (this.closing === work) this.closing = undefined
    }
    void work.then(settled, settled)
    return work
  }
  private async closeCore(): Promise<TimingJournalHealth> {
    this.closed = true
    await this.drain()
    if (!this.broken) {
      try {
        await this.policy?.beforeWrite()
        await this.verifyLog()
        const footer = JSON.stringify({ kind: 'session_closed', ...this.health() }) + '\n'
        if (Buffer.byteLength(footer) > 512) throw new Error('footer_limit')
        // Flush the complete event stream before allowing a report to claim a sealed session.
        await appendFile(join(this.directory, 'events.private.jsonl'), footer, { flush: true })
        this.bytes += Buffer.byteLength(footer)
      } catch {
        this.reason = 'journal_write_failed'
        this.broken = true
      }
    }
    return this.health()
  }
  async export(value: unknown): Promise<string> {
    await this.close()
    if (this.reason) throw new Error('runtime_evidence_incomplete')
    const file = join(this.directory, 'report.private.json')
    const body = JSON.stringify(value, null, 2) + '\n'
    if (this.bytes + Buffer.byteLength(body) > this.limits.maxBytes)
      throw new Error('runtime_evidence_too_large')
    try {
      await this.policy?.beforeWrite()
      await verifyPrivatePaths(this.directory, [])
      await writeFile(file, body, { flag: 'wx', mode: 0o600, flush: true })
      await verifyPrivatePaths(this.directory, [file])
      const info = await lstat(file)
      if (!info.isFile() || info.nlink !== 1) throw new Error('runtime_timing_report_invalid')
    } catch {
      this.reason = 'journal_write_failed'
      throw new Error('runtime_evidence_export_failed')
    }
    return file
  }
  /** Deletes only this owned session's known files; never follows links or removes recursively. */
  forget(): Promise<void> {
    if (this.forgotten) return Promise.resolve()
    if (this.forgetting) return this.forgetting
    const work = this.forgetCore()
    this.forgetting = work
    const settled = (): void => {
      if (this.forgetting === work) this.forgetting = undefined
    }
    void work.then(settled, settled)
    return work
  }
  private async forgetCore(): Promise<void> {
    await this.close()
    this.reason ??= 'journal_record_invalid'
    try {
      await verifyPrivatePaths(this.directory, [])
      const info = await lstat(this.directory)
      if (info.dev !== this.directoryIdentity?.dev || info.ino !== this.directoryIdentity?.ino)
        throw new Error('session_replaced')
      const names = await readdir(this.directory)
      if (names.some((name) => name !== 'events.private.jsonl' && name !== 'report.private.json'))
        throw new Error('unexpected_session_file')
      const files = names.map((name) => join(this.directory, name))
      await verifyPrivatePaths(this.directory, files)
      for (const file of files) {
        const item = await lstat(file)
        if (!item.isFile() || item.nlink !== 1) throw new Error('invalid_session_file')
      }
      for (const file of files) await unlink(file)
      await rmdir(this.directory)
      this.forgotten = true
    } catch {
      throw new Error('runtime_timing_forget_failed')
    }
  }
}
