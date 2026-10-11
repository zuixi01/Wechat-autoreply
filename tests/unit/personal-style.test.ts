import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PersonalStyle } from '../../src/core/memory/personal-style'

it('keeps curated wording editable and rollback usable after raw evidence ages out', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2024-01-01'))
  const style = new PersonalStyle(':memory:', 'local-profile', () => false)
  try {
    style.teach('a', '行呀 慢慢来')
    const entry = style.list('a')[0]
    vi.setSystemTime(new Date('2026-01-01'))
    expect(style.examples('a')).toEqual(['行呀 慢慢来'])
    style.correct('a', entry.id, '行呀 不着急')
    style.rollback('a', entry.id)
    expect(style.examples('a')).toEqual(['行呀 慢慢来'])
  } finally {
    style.close()
    vi.useRealTimers()
  }
})

it('reports invalid explicit teaching instead of silently accepting it', () => {
  const style = new PersonalStyle(':memory:', 'local-profile', (text) => text === 'generated')
  try {
    expect(() => style.teach('a', 'generated')).toThrow('style_text_invalid')
    expect(() => style.teach('a', '字'.repeat(161))).toThrow('style_text_invalid')
    expect(style.list('a')).toEqual([])
  } finally {
    style.close()
  }
})

it('persists owner wording, isolates contacts, and excludes generated text', () => {
  const root = mkdtempSync(join(tmpdir(), 'personal-style-')),
    path = join(root, 'style.sqlite')
  let style = new PersonalStyle(path, 'local-profile', (text) => text === 'generated')
  try {
    style.observe('a', 'source-1', '哈哈 好的')
    style.observe('a', 'source-2', 'generated')
    style.observe('b', 'source-3', '别急 慢慢来')
    expect(style.examples('a')).toEqual(['哈哈 好的'])
    expect(style.examples('b')).toEqual(['别急 慢慢来'])
    style.close()
    style = new PersonalStyle(path, 'local-profile', () => false)
    expect(style.examples('a')).toEqual(['哈哈 好的'])
    const entry = style.list('a')[0]
    style.correct('a', entry.id, '哈哈 行呀')
    expect(style.examples('a')).toEqual(['哈哈 行呀'])
    style.rollback('a', entry.id)
    expect(style.examples('a')).toEqual(['哈哈 好的'])
    style.delete('a', entry.id)
    expect(style.examples('a')).toEqual([])
  } finally {
    style.close()
    rmSync(root, { recursive: true, force: true })
  }
})
it('bounds context, deduplicates observed events and supports explicit common wording', () => {
  const style = new PersonalStyle(':memory:', 'local-profile', () => false)
  try {
    style.observe('a', 'same-event', '行呀')
    style.observe('a', 'same-event', '行呀')
    expect(style.list('a')).toHaveLength(1)
    style.teach('', 'common wording')
    for (let n = 0; n < 30; n++) style.observe('a', `event-${n}`, `${n} ${'字'.repeat(130)}`)
    expect(style.examples('a').join('').length).toBeLessThanOrEqual(1200)
    expect(style.examples('b')).toEqual(['common wording'])
    style.setEnabled(false)
    expect(style.examples('a')).toEqual([])
  } finally {
    style.close()
  }
})
