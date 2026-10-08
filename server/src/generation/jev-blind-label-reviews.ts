import { z } from 'zod'
import { Id, Hash } from '../../../src/shared/contracts/identity'
import { hashContext } from '../../../src/core/reply/hashes'
import { BlindLabelsSchema } from '../../../evals/jev/blind-review'
import type { Postgres } from '../database/postgres'

const Submit = z.strictObject({
  tenantId: Id,
  accountId: Id,
  runId: Id,
  packetId: z.uuid().transform((value) => value.toLowerCase()),
  labels: z.unknown()
})
const Verify = Submit.extend({
  packetHash: Hash,
  reviewId: z.uuid().transform((value) => value.toLowerCase())
})
export interface JevBlindLabelReviewReceipt {
  reviewId: string
  packetId: string
  packetHash: string
  labelsHash: string
  reviewerId: string
  revision: number
  reviewedAt: string
  centralReviewVerified: true
  releaseAuthorized: false
}
/** Submission uses a separately provisioned reviewer DB login. The caller sees
 * no private mapping or drafts; labels and identity are bound centrally.
 * This proves the submitting principal, not that a human actually reviewed blindly. */
export class JevBlindLabelReviews {
  constructor(private readonly db: Postgres) {}
  async submit(raw: z.infer<typeof Submit>): Promise<JevBlindLabelReviewReceipt> {
    const request = Submit.parse(structuredClone(raw)),
      labels = this.parseLabels(request.labels)
    return this.db.transaction(request.tenantId, async (db) => {
      const result = await db.query(
        'SELECT * FROM autoreply.submit_jev_blind_labels($1,$2,$3,$4,$5::jsonb)',
        [
          request.tenantId,
          request.accountId,
          request.runId,
          request.packetId,
          JSON.stringify(labels)
        ]
      )
      return this.receipt(result.rows[0], request, labels)
    })
  }
  async verify(raw: z.infer<typeof Verify>): Promise<JevBlindLabelReviewReceipt> {
    const request = Verify.parse(structuredClone(raw)),
      labels = this.parseLabels(request.labels)
    return this.db.transaction(request.tenantId, async (db) => {
      const result = await db.query(
        'SELECT * FROM autoreply.verify_jev_blind_labels($1,$2,$3,$4,$5,$6,$7::jsonb)',
        [
          request.tenantId,
          request.accountId,
          request.runId,
          request.packetId,
          request.packetHash,
          request.reviewId,
          JSON.stringify(labels)
        ]
      )
      const receipt = this.receipt(result.rows[0], request, labels)
      if (receipt.reviewId !== request.reviewId || receipt.packetHash !== request.packetHash)
        throw new Error('jev_blind_review_changed')
      return receipt
    })
  }
  private parseLabels(raw: unknown): z.infer<typeof BlindLabelsSchema> {
    const labels = BlindLabelsSchema.parse(raw)
    if (
      labels.labels.length > 6000 ||
      new Set(labels.labels.map((l) => l.reviewId.toLowerCase())).size !== labels.labels.length ||
      hashContext(labels) !== hashContext(raw)
    )
      throw new Error('jev_blind_labels_invalid')
    return labels
  }
  private receipt(
    row: Record<string, unknown> | undefined,
    request: z.infer<typeof Submit>,
    labels: z.infer<typeof BlindLabelsSchema>
  ): JevBlindLabelReviewReceipt {
    if (
      !row ||
      row.tenant_id !== request.tenantId ||
      row.account_id !== request.accountId ||
      row.run_id !== request.runId ||
      row.packet_id !== request.packetId ||
      row.reviewer_id !== labels.adjudicatedBy ||
      row.labels_hash !== hashContext(labels) ||
      hashContext(row.labels_json) !== hashContext(labels)
    )
      throw new Error('jev_blind_review_changed')
    const revision = z.number().int().positive().safe().parse(Number(row.revision))
    const reviewedAt = new Date(row.reviewed_at as Date).toISOString()
    return {
      reviewId: z.uuid().parse(row.id),
      packetId: z.uuid().parse(row.packet_id),
      packetHash: Hash.parse(row.packet_hash),
      labelsHash: Hash.parse(row.labels_hash),
      reviewerId: Id.parse(row.reviewer_id),
      revision,
      reviewedAt,
      centralReviewVerified: true,
      releaseAuthorized: false
    }
  }
}
