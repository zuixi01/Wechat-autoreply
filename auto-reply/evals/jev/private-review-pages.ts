import { join } from 'node:path'
import { z } from 'zod'
import { Hash } from '../../src/shared/contracts/identity'
import { ConversationContextSchema } from '../../src/shared/contracts/context'
import { hashContext } from '../../src/core/reply/hashes'
import { ReplayCaseInputSchema } from './replay-input'
import type { JevBlindReviewPackage } from './blind-review'
import { MAX_PRIVATE_JSON_BYTES, writePrivateJson } from '../memory/private-files'

export type JevBlindReviewRecord = JevBlindReviewPackage['blind'][number]
const RecordSchema = z.strictObject({
  reviewId: z.uuid(),
  inbound: ReplayCaseInputSchema.shape.inbound,
  context: z.union([z.tuple([]), ConversationContextSchema]),
  draft: z.string().min(1).max(10000).nullable()
})
const RecordsSchema = z
  .array(RecordSchema)
  .min(1)
  .max(6000)
  .superRefine((records, c) => {
    if (new Set(records.map((r) => r.reviewId)).size !== records.length)
      c.addIssue({ code: 'custom', message: 'Duplicate blind review ID' })
  })
export const JevBlindReviewPagesManifestSchema = z
  .strictObject({
    protocol: z.literal('jev-blind-review-pages-v1'),
    records: z.number().int().min(1).max(6000),
    parts: z
      .array(
        z.strictObject({
          file: z.string().regex(/^page-\d{4}\.private\.json$/),
          records: z.number().int().min(1).max(6000),
          hash: Hash
        })
      )
      .min(1)
      .max(6000)
  })
  .superRefine((manifest, c) => {
    if (
      new Set(manifest.parts.map((p) => p.file)).size !== manifest.parts.length ||
      manifest.parts.reduce((n, p) => n + p.records, 0) !== manifest.records
    )
      c.addIssue({ code: 'custom', message: 'Review pages missing, duplicate or miscounted' })
  })
export type JevBlindReviewPagesManifest = z.infer<typeof JevBlindReviewPagesManifestSchema>
export interface JevBlindReviewPagePlan {
  kind: 'single' | 'manifest'
  reviews: number
  file: string
  pages: { file: string; records: JevBlindReviewRecord[]; bytes: number; hash: string }[]
  manifest: JevBlindReviewPagesManifest | null
}

/** Uses the writer's exact pretty JSON + newline format, measured as UTF-8.
 * The array wrapper contributes three bytes plus two bytes per record; each
 * record line additionally receives two spaces from its array indentation.
 * This avoids serializing a potentially oversized complete view just to size it.
 * Input order has already been cryptographically shuffled by blind-review.ts. */
export function planJevBlindReviewPages(
  blind: readonly JevBlindReviewRecord[],
  maximumBytes = MAX_PRIVATE_JSON_BYTES
): JevBlindReviewPagePlan {
  z.number().int().positive().safe().max(MAX_PRIVATE_JSON_BYTES).parse(maximumBytes)
  const records = RecordsSchema.parse(blind)
  const sizes = records.map((record) => {
    const json = JSON.stringify(record, null, 2)
    return Buffer.byteLength(json, 'utf8') + 2 * json.split('\n').length
  })
  if (sizes.some((size) => size + 5 > maximumBytes))
    throw new Error('blind_review_record_too_large')
  const total = 3 + sizes.reduce((n, size) => n + size + 2, 0)
  if (total <= maximumBytes) {
    return {
      kind: 'single',
      reviews: records.length,
      file: 'reviewer-view.private.json',
      pages: [
        { file: 'reviewer-view.private.json', records, bytes: total, hash: hashContext(records) }
      ],
      manifest: null
    }
  }
  const pages: JevBlindReviewPagePlan['pages'] = []
  let page: JevBlindReviewRecord[] = [],
    bytes = 3
  const finish = (): void => {
    const file = `page-${String(pages.length + 1).padStart(4, '0')}.private.json`
    pages.push({ file, records: page, bytes, hash: hashContext(page) })
    page = []
    bytes = 3
  }
  records.forEach((record, i) => {
    if (bytes + sizes[i] + 2 > maximumBytes) finish()
    page.push(record)
    bytes += sizes[i] + 2
  })
  finish()
  const manifest = JevBlindReviewPagesManifestSchema.parse({
    protocol: 'jev-blind-review-pages-v1',
    records: records.length,
    parts: pages.map((p) => ({ file: p.file, records: p.records.length, hash: p.hash }))
  })
  return {
    kind: 'manifest',
    reviews: records.length,
    file: 'reviewer-view.manifest.private.json',
    pages,
    manifest
  }
}

/** Uses the existing private ACL/no-overwrite writer. Parts are written first;
 * the manifest appears only after every page succeeds. Failures propagate and
 * partial files must never be presented as a completed reviewer package. */
export async function writeJevBlindReviewPages(
  directory: string,
  blind: readonly JevBlindReviewRecord[]
): Promise<{ file: string; kind: 'single' | 'manifest'; reviews: number }> {
  const plan = planJevBlindReviewPages(blind)
  for (const page of plan.pages) await writePrivateJson(join(directory, page.file), page.records)
  if (plan.manifest) await writePrivateJson(join(directory, plan.file), plan.manifest)
  return { file: plan.file, kind: plan.kind, reviews: plan.reviews }
}
