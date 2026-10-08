import { describe, expect, it, vi } from 'vitest'
import { ForegroundBatchRuntime } from '../../src/core/agent/foreground-batch'
import { scanForegroundList } from '../../src/core/agent/foreground-list-scan'
import type { ForegroundDriver, ForegroundJournal } from '../../src/core/agent/foreground-wechat'
import {
  BatchStartSchema,
  type BatchNavigator,
  type ListRow
} from '../../src/shared/contracts/foreground-batch'
import type {
  ForegroundObservation,
  ForegroundRecord
} from '../../src/shared/contracts/foreground-wechat'
import { SqliteForegroundJournal } from '../../src/core/persistence/foreground-journal'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

function fixture(count = 15, persisted?: SqliteForegroundJournal) {
  const rows: ListRow[] = Array.from({ length: count }, (_, i) => ({
    name: `客户${i}`,
    nameComplete: true,
    preview: `问题${i}`,
    unread: 1,
    point: [0.2, 0.2]
  }))
  let offset = 0,
    opened = '',
    maxSending = 0,
    sending = 0,
    foreground = true
  const observations = new Map(
    rows.map((row) => [
      row.name,
      {
        contact: row.name,
        privateChat: true,
        inputText: '',
        windowToken: 'window-1',
        revision: 'rules-1',
        messages: [
          { direction: 'outbound', text: '历史回复' },
          { direction: 'inbound', text: row.preview }
        ]
      } as ForegroundObservation
    ])
  )
  const records: ForegroundRecord[] = []
  const journal: ForegroundJournal = {
    list: (limit) => (persisted ? persisted.list(limit) : records),
    hasUnknown: () =>
      persisted ? persisted.hasUnknown() : records.some((record) => record.state === 'unknown'),
    save: (record) => {
      persisted?.save(record)
      const index = records.findIndex((value) => value.id === record.id)
      if (index < 0) records.push(record)
      else records[index] = record
    }
  }
  const navigator: BatchNavigator = {
    currentContact: () => opened,
    connect: vi.fn(async () => {}),
    top: vi.fn(async () => {
      if (!foreground) throw new Error('foreground_lost')
      offset = 0
    }),
    page: vi.fn(async () => {
      if (!foreground) throw new Error('foreground_lost')
      return {
        rows: structuredClone(rows.slice(offset, offset + 8)),
        atTop: offset === 0,
        atBottom: offset + 8 >= rows.length
      }
    }),
    down: vi.fn(async () => {
      offset = Math.min(Math.max(0, rows.length - 8), offset + 6)
    }),
    open: vi.fn(async (row) => {
      if (!foreground) throw new Error('foreground_lost')
      opened = row.name
      rows.find((value) => value.name === row.name)!.unread = 0
    })
  }
  const drivers = new Map<string, ForegroundDriver>()
  const factory = (target: string): ForegroundDriver => {
    const driver: ForegroundDriver = {
      connect: vi.fn(async () => {
        if (!foreground) throw new Error('foreground_lost')
      }),
      read: vi.fn(async () => {
        if (!foreground) throw new Error('foreground_lost')
        if (opened !== target) throw new Error('contact_mismatch')
        return structuredClone(observations.get(target)!)
      }),
      generate: vi.fn(async () => `回复${target}`),
      dispatch: vi.fn(async (_observation, text) => {
        sending++
        maxSending = Math.max(maxSending, sending)
        await Promise.resolve()
        observations.get(target)!.messages.push({ direction: 'outbound', text })
        sending--
        return 'sent' as const
      })
    }
    drivers.set(target, driver)
    return driver
  }
  const runtime = new ForegroundBatchRuntime(navigator, factory, journal, false, persisted)
  return {
    runtime,
    navigator,
    rows,
    drivers,
    observations,
    records,
    journal,
    maxSending: () => maxSending,
    foreground: (value: boolean) => {
      foreground = value
    }
  }
}
describe('foreground batch scanning and processing', () => {
  it('requires an explicit allowed scope and unread processing input', () => {
    expect(BatchStartSchema.safeParse({ targets: ['Q'], foregroundConsent: true }).success).toBe(
      false
    )
    expect(
      BatchStartSchema.safeParse({
        targets: ['Q', 'Q'],
        foregroundConsent: true,
        processUnread: true
      }).success
    ).toBe(false)
    expect(
      BatchStartSchema.safeParse({ targets: ['Q'], foregroundConsent: true, processUnread: true })
        .success
    ).toBe(true)
  })
  it('scans beyond one screen with overlap without inventing duplicate rows', async () => {
    const f = fixture(500)
    const rows = await scanForegroundList(f.navigator, new AbortController().signal)
    expect(rows).toHaveLength(500)
    expect(new Set(rows.map((row) => row.name)).size).toBe(500)
  })
  it('processes 500 allowed conversations serially and does not reply again on rescan', async () => {
    const database = new SqliteForegroundJournal(':memory:'),
      f = fixture(500, database)
    const directory = join(process.cwd(), '.local', 'reports', 'foreground-batch', randomUUID())
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, 'result.json'),
      JSON.stringify({ passed: false, syntheticOnly: true })
    )
    try {
      await f.runtime.start(f.rows.map((row) => row.name))
      for (let i = 0; i < 500; i++) await f.runtime.tick()
      expect(f.records).toHaveLength(500)
      expect(f.records.every((record) => record.state === 'sent')).toBe(true)
      expect(f.maxSending()).toBe(1)
      expect(f.runtime.status().scanComplete).toBe(true)
      expect(f.runtime.status().pending).toBe(0)
      await f.runtime.tick()
      expect(f.records).toHaveLength(500)
      // Next jobs continue from the current page rather than returning to the top for every customer.
      expect(f.navigator.top).toHaveBeenCalledTimes(3)
      expect(database.list()).toHaveLength(500)
      expect(database.loadBatch(f.rows.map((row) => row.name))).toHaveLength(0)
      expect(database.hasUnknown()).toBe(false)
      writeFileSync(
        join(directory, 'result.json'),
        JSON.stringify(
          {
            passed: true,
            syntheticOnly: true,
            actualSQLite: true,
            contacts: 500,
            confirmedSends: database.list().length,
            maximumConcurrentSend: f.maxSending(),
            duplicateSendsOnRescan: 0,
            pages: f.runtime.status().pages,
            unfinishedCheckpoints: 0,
            networkRequests: 0,
            nativeInputs: 0
          },
          null,
          2
        )
      )
      await f.runtime.pause()
    } finally {
      await f.runtime.pause()
      database.close()
    }
  })
  it('never opens a conversation outside the allowed names', async () => {
    const f = fixture()
    await f.runtime.start(['客户14'])
    await f.runtime.tick()
    expect(f.records.map((record) => record.target)).toEqual(['客户14'])
    expect(f.navigator.open).toHaveBeenCalledTimes(1)
  })
  it('continues monitoring the selected contact when visible messages have no unread badge', async () => {
    const f = fixture(1)
    f.rows[0].unread = 0
    await f.navigator.open(f.rows[0], new AbortController().signal)
    await f.runtime.start(['客户0'])
    await f.runtime.tick()
    expect(f.records).toHaveLength(0)
    f.observations.get('客户0')!.messages.push({ direction: 'inbound', text: '同样的新问题' })
    await f.runtime.tick()
    expect(f.records[0].question).toBe('同样的新问题')
    f.observations.get('客户0')!.messages.push({ direction: 'inbound', text: '同样的新问题' })
    await f.runtime.tick()
    expect(f.records).toHaveLength(2)
    expect(f.records[1].question).toBe('同样的新问题')
  })
  it('rejects duplicate names even when they occur on different pages', async () => {
    const f = fixture()
    f.rows[14].name = '客户0'
    await f.runtime.start(['客户0', '客户1'])
    await f.runtime.tick()
    expect(f.runtime.status().issues).toContainEqual({
      target: '客户0',
      reason: 'contact_not_unique'
    })
    expect(f.records.map((record) => record.target)).toEqual(['客户1'])
  })
  it('does not let an unrelated truncated name block known targets', async () => {
    const f = fixture()
    f.rows[14].name = '无关的长备注…'
    f.rows[14].nameComplete = false
    await f.runtime.start(['客户0'])
    await f.runtime.tick()
    expect(f.records.map((record) => record.target)).toEqual(['客户0'])
  })
  it('isolates a target when a truncated name might refer to the same allowed contact', async () => {
    const f = fixture()
    f.rows[14].name = '客户…'
    f.rows[14].nameComplete = false
    await f.runtime.start(['客户0'])
    await f.runtime.tick()
    expect(f.runtime.status().issues).toContainEqual({
      target: '客户0',
      reason: 'contact_not_unique'
    })
    expect(f.records).toHaveLength(0)
  })
  it('persists a pending hint before opening a chat even if the first message read fails', async () => {
    const f = fixture(1),
      journal = new SqliteForegroundJournal(':memory:')
    const driver: ForegroundDriver = {
      connect: async () => {},
      read: vi.fn(async () => structuredClone(f.observations.get('客户0')!)),
      generate: async () => '回复',
      dispatch: vi.fn(async () => 'sent' as const)
    }
    vi.mocked(driver.read).mockRejectedValueOnce(new Error('model_network_failed'))
    const first = new ForegroundBatchRuntime(f.navigator, () => driver, journal, false, journal)
    const second = new ForegroundBatchRuntime(f.navigator, () => driver, journal, false, journal)
    try {
      await first.start(['客户0'])
      await first.tick()
      await first.pause()
      expect(f.rows[0].unread).toBe(0)
      expect(journal.loadBatch(['客户0'])).toHaveLength(1)
      await second.start(['客户0'])
      await second.tick()
      expect(driver.dispatch).toHaveBeenCalledTimes(1)
      expect(journal.loadBatch(['客户0'])).toHaveLength(0)
    } finally {
      await first.pause()
      await second.pause()
      journal.close()
    }
  })
  it('does not declare complete when repeated captures cannot verify the bottom', async () => {
    const f = fixture()
    vi.mocked(f.navigator.down).mockImplementation(async () => {})
    await f.runtime.start(['客户0'])
    await f.runtime.tick()
    expect(f.runtime.status()).toMatchObject({
      state: 'paused',
      reason: 'list_incomplete',
      scanComplete: false
    })
    expect(f.records).toHaveLength(0)
  })
  it('restarts an unstable inventory without opening any chat', async () => {
    const f = fixture()
    vi.mocked(f.navigator.down).mockImplementationOnce(async () => {
      f.rows[0].preview = '排序已变化'
      f.rows.reverse()
    })
    await f.runtime.start(['客户0'])
    await f.runtime.tick()
    expect(f.runtime.status()).toMatchObject({
      state: 'scanning',
      reason: 'list_changed',
      scanComplete: false
    })
    expect(f.navigator.open).not.toHaveBeenCalled()
  })
  it('waits when foreground is lost and honors manual pause', async () => {
    const f = fixture()
    await f.runtime.start(['客户0'])
    f.foreground(false)
    await f.runtime.tick()
    expect(f.runtime.status().state).toBe('waiting_foreground')
    f.foreground(true)
    await f.runtime.tick()
    expect(f.records).toHaveLength(1)
    await f.runtime.pause()
    await f.runtime.tick()
    expect(f.runtime.status().reason).toBe('user_pause')
  })
  it('retains a job when incoming messages invalidate a generated draft', async () => {
    const f = fixture(1)
    const factory = () => {
      const driver: ForegroundDriver = {
        connect: async () => {},
        read: async () => structuredClone(f.observations.get('客户0')!),
        generate: vi.fn(async () => {
          if (f.observations.get('客户0')!.messages.length === 2)
            f.observations.get('客户0')!.messages.push({ direction: 'inbound', text: '补充问题' })
          return '回复'
        }),
        dispatch: vi.fn(async () => 'sent' as const)
      }
      return driver
    }
    const runtime = new ForegroundBatchRuntime(f.navigator, factory, f.journal, false)
    await runtime.start(['客户0'])
    await runtime.tick()
    expect(runtime.status().pending).toBe(1)
    expect(f.records).toHaveLength(0)
    await runtime.tick()
    expect(f.records).toHaveLength(1)
    expect(f.records[0].question).toContain('补充问题')
  })
  it('stops the whole account and never retries an unknown send', async () => {
    const f = fixture(2)
    const driver: ForegroundDriver = {
      connect: async () => {},
      read: async () => structuredClone(f.observations.get('客户0')!),
      generate: async () => '回复',
      dispatch: vi.fn(async () => 'unknown' as const)
    }
    const runtime = new ForegroundBatchRuntime(f.navigator, () => driver, f.journal, false)
    await runtime.start(['客户0', '客户1'])
    await runtime.tick()
    await runtime.tick()
    expect(runtime.status()).toMatchObject({ state: 'paused', reason: 'send_unknown' })
    expect(driver.dispatch).toHaveBeenCalledTimes(1)
    await runtime.start(['客户0'])
    expect(runtime.status().reason).toBe('send_unknown')
  })
  it('cancels generation before returning from pause', async () => {
    const f = fixture(1)
    let finish!: (value: string) => void
    const driver: ForegroundDriver = {
      connect: async () => {},
      read: async () => structuredClone(f.observations.get('客户0')!),
      generate: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      dispatch: vi.fn(async () => 'sent' as const)
    }
    const runtime = new ForegroundBatchRuntime(f.navigator, () => driver, f.journal, false)
    await runtime.start(['客户0'])
    const work = runtime.tick()
    while (!finish) await Promise.resolve()
    const pause = runtime.pause()
    finish('迟到回复')
    await pause
    await work
    expect(driver.dispatch).not.toHaveBeenCalled()
  })
  it('restores an unfinished message even after opening the chat cleared its unread badge', async () => {
    const f = fixture(1),
      journal = new SqliteForegroundJournal(':memory:')
    let finish!: (value: string) => void
    const driver: ForegroundDriver = {
      connect: async () => {},
      read: async () => structuredClone(f.observations.get('客户0')!),
      generate: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      dispatch: vi.fn(async () => 'sent' as const)
    }
    const first = new ForegroundBatchRuntime(f.navigator, () => driver, journal, false, journal)
    let second: ForegroundBatchRuntime | undefined
    try {
      await first.start(['客户0'])
      const work = first.tick()
      while (!finish) await Promise.resolve()
      const pause = first.pause()
      finish('作废草稿')
      await pause
      await work
      expect(f.rows[0].unread).toBe(0)
      expect(journal.loadBatch(['客户0'])).toHaveLength(1)
      driver.generate = async () => '重新生成的回复'
      second = new ForegroundBatchRuntime(f.navigator, () => driver, journal, false, journal)
      await second.start(['客户0'])
      await second.tick()
      expect(driver.dispatch).toHaveBeenCalledTimes(1)
      expect(journal.list()[0].question).toBe('问题0')
      expect(journal.loadBatch(['客户0'])).toHaveLength(0)
    } finally {
      await first.pause()
      await second?.pause()
      journal.close()
    }
  })
})
