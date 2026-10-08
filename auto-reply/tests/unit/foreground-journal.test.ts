import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { SqliteForegroundJournal } from '../../src/core/persistence/foreground-journal'

describe('foreground durable execution journal', () => {
  it('retains unknown execution after close and reopen, and updates only the same execution', () => {
    const directory = mkdtempSync(join(tmpdir(), 'foreground-journal-')),
      path = join(directory, 'journal.sqlite')
    let journal = new SqliteForegroundJournal(path)
    const record = {
      id: randomUUID(),
      target: 'Q',
      question: '合成问题',
      reply: '合成回复',
      state: 'unknown' as const,
      createdAt: Date.now()
    }
    try {
      journal.save(record)
      journal.close()
      journal = new SqliteForegroundJournal(path)
      expect(journal.list()).toEqual([record])
      expect(journal.hasUnknown()).toBe(true)
      journal.save({ ...record, state: 'sent' })
      expect(journal.list()).toEqual([{ ...record, state: 'sent' }])
      expect(journal.hasUnknown()).toBe(false)
    } finally {
      journal.close()
      rmSync(directory, { recursive: true })
    }
  })
  it('persists unfinished contact checkpoints and excludes completed or unselected scopes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'foreground-checkpoint-')),
      path = join(directory, 'journal.sqlite')
    let journal = new SqliteForegroundJournal(path)
    const row = {
      name: 'Q',
      nameComplete: true,
      preview: '新问题',
      unread: 1,
      point: [0.2, 0.3] as [number, number]
    }
    const checkpoint = {
      baseline: {
        windowToken: 'window',
        contact: 'Q',
        privateChat: true,
        inputText: '',
        messages: [],
        revision: 'rules'
      },
      pending: true
    }
    try {
      journal.saveBatch(row, checkpoint)
      journal.close()
      journal = new SqliteForegroundJournal(path)
      expect(journal.loadBatch(['Q'])).toEqual([{ row, checkpoint }])
      expect(journal.loadBatch(['其他客户'])).toEqual([])
      expect(() => journal.saveBatch({ ...row, name: '其他客户' }, checkpoint)).toThrow(
        'contact_mismatch'
      )
      journal.saveBatch(row, { ...checkpoint, pending: false })
      expect(journal.loadBatch(['Q'])).toEqual([])
    } finally {
      journal.close()
      rmSync(directory, { recursive: true })
    }
  })
  it('limits recent status reads without hiding older unknown executions', () => {
    const journal = new SqliteForegroundJournal(':memory:')
    try {
      for (let i = 0; i < 100; i++)
        journal.save({
          id: randomUUID(),
          target: 'Q',
          question: '问题',
          reply: '回复',
          state: i === 0 ? 'unknown' : 'sent',
          createdAt: i
        })
      expect(journal.list(50)).toHaveLength(50)
      expect(journal.list(50)[0].createdAt).toBe(50)
      expect(journal.hasUnknown()).toBe(true)
    } finally {
      journal.close()
    }
  })
})
