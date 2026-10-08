import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  JevBlindReviewPagesManifestSchema,
  planJevBlindReviewPages,
  writeJevBlindReviewPages,
  type JevBlindReviewRecord
} from '../../evals/jev/private-review-pages'
import { MAX_PRIVATE_JSON_BYTES, writePrivateJson } from '../../evals/memory/private-files'
import { hashContext } from '../../src/core/reply/hashes'

vi.mock('../../evals/memory/private-files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../evals/memory/private-files')>()),
  writePrivateJson: vi.fn()
}))
function record(i = 0): JevBlindReviewRecord {
  return {
    reviewId: randomUUID(),
    inbound: [`Synthetic question ${i}: 中文😀\n"quoted"\t\\`],
    context: [
      {
        sequence: 1,
        sourceMessageId: `prior-${i}`,
        direction: 'human_outbound',
        kind: 'text',
        text: 'Synthetic prior\n中文😀'
      }
    ],
    draft: i % 2 ? null : `Synthetic reply ${i}: 中文😀\n"quoted"\t\\`
  }
}
function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2) + '\n', 'utf8')
}

describe('bounded private reviewer pages (synthetic data only)', () => {
  it('matches the existing writer byte-for-byte at the single-file boundary', () => {
    const input = [record(), record(1), record(2)]
    const limit = bytes(input)
    const exact = planJevBlindReviewPages(input, limit)
    expect(exact.kind).toBe('single')
    expect(exact.pages[0].bytes).toBe(limit)
    expect(exact.pages[0].hash).toBe(hashContext(input))
    const overflow = planJevBlindReviewPages(input, limit - 1)
    expect(overflow.kind).toBe('manifest')
    expect(overflow.pages.every((p) => bytes(p.records) <= limit - 1)).toBe(true)
  })
  it('retains the complete pre-shuffled sequence, actual text and null drafts across pages', () => {
    const input = Array.from({ length: 13 }, (_, i) => record(i)).reverse()
    const limit = Math.max(...input.map((r) => bytes([r]))) + 1
    const plan = planJevBlindReviewPages(input, limit)
    expect(plan.kind).toBe('manifest')
    expect(plan.pages).toHaveLength(input.length)
    expect(plan.pages.flatMap((p) => p.records)).toEqual(input)
    expect(plan.manifest!.records).toBe(input.length)
    plan.pages.forEach((p, i) => {
      expect(p.bytes).toBe(bytes(p.records))
      expect(p.bytes).toBeLessThanOrEqual(limit)
      expect(plan.manifest!.parts[i]).toEqual({
        file: `page-${String(i + 1).padStart(4, '0')}.private.json`,
        records: p.records.length,
        hash: hashContext(p.records)
      })
      expect(Object.keys(p.records[0]).sort()).toEqual(['context', 'draft', 'inbound', 'reviewId'])
    })
  })
  it('packs several records per page while respecting commas, indentation and UTF-8', () => {
    const input = Array.from({ length: 9 }, (_, i) => record(i))
    const limit = bytes(input.slice(0, 3))
    const plan = planJevBlindReviewPages(input, limit)
    expect(plan.pages.length).toBeGreaterThan(1)
    expect(plan.pages.some((p) => p.records.length > 1)).toBe(true)
    for (const p of plan.pages) {
      expect(p.bytes).toBe(bytes(p.records))
      expect(p.bytes).toBeLessThanOrEqual(limit)
    }
    expect(plan.pages.flatMap((p) => p.records)).toEqual(input)
  })
  it('sizes empty context and null drafts correctly', () => {
    const r = { ...record(1), context: [] }
    const p = planJevBlindReviewPages([r], bytes([r]))
    expect(p.pages[0].bytes).toBe(bytes([r]))
    expect(p.pages[0].records[0]).toEqual(r)
  })
  it('refuses a single over-limit record before planning partial pages', () => {
    const input = [record(), { ...record(2), draft: '中'.repeat(1000) }]
    expect(() => planJevBlindReviewPages(input, bytes([input[0]]))).toThrow(
      'blind_review_record_too_large'
    )
  })
  it.each([0, -1, 1.5, Infinity, NaN, MAX_PRIVATE_JSON_BYTES + 1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid byte limit: %s',
    (limit) => {
      expect(() => planJevBlindReviewPages([record()], limit)).toThrow()
    }
  )
  it('rejects missing, duplicate and over-6000 review records', () => {
    expect(() => planJevBlindReviewPages([])).toThrow()
    const r = record()
    expect(() => planJevBlindReviewPages([r, r])).toThrow('Duplicate blind review ID')
    expect(() => planJevBlindReviewPages(Array(6001).fill(r))).toThrow()
  })
  it('refuses metadata leakage and malformed context instead of silently stripping it', () => {
    expect(() =>
      planJevBlindReviewPages([{ ...record(), arm: 'C' } as JevBlindReviewRecord])
    ).toThrow()
    const r = record()
    Object.assign(r.context[0], { modelScore: 1 })
    expect(() => planJevBlindReviewPages([r])).toThrow()
  })
  it('strictly validates manifest counts, duplicate paths, traversal and unknown fields', () => {
    const input = [record(), record(1)]
    const limit = Math.max(...input.map((r) => bytes([r])))
    const manifest = planJevBlindReviewPages(input, limit).manifest!
    expect(JevBlindReviewPagesManifestSchema.parse(manifest)).toEqual(manifest)
    expect(() =>
      JevBlindReviewPagesManifestSchema.parse({ ...manifest, records: manifest.records + 1 })
    ).toThrow()
    expect(() =>
      JevBlindReviewPagesManifestSchema.parse({
        ...manifest,
        parts: [manifest.parts[0], manifest.parts[0]]
      })
    ).toThrow()
    expect(() =>
      JevBlindReviewPagesManifestSchema.parse({
        ...manifest,
        parts: [{ ...manifest.parts[0], file: '../public.json' }]
      })
    ).toThrow()
    expect(() =>
      JevBlindReviewPagesManifestSchema.parse({ ...manifest, provider: 'jev' })
    ).toThrow()
  })
  it('uses the private no-overwrite writer and reports the actual single view filename', async () => {
    const input = [record(), record(1)]
    expect(await writeJevBlindReviewPages('synthetic-directory', input)).toEqual({
      file: 'reviewer-view.private.json',
      kind: 'single',
      reviews: 2
    })
    expect(writePrivateJson).toHaveBeenCalledExactlyOnceWith(
      join('synthetic-directory', 'reviewer-view.private.json'),
      input
    )
  })
  it('propagates private writer failure without reporting a successful packet', async () => {
    vi.mocked(writePrivateJson).mockRejectedValueOnce(new Error('synthetic EEXIST or ACL failure'))
    await expect(writeJevBlindReviewPages('synthetic-directory', [record()])).rejects.toThrow(
      'synthetic EEXIST or ACL failure'
    )
  })
})
