import { z } from 'zod'
import type { LegacySettingsArchive } from '../../../src/core/persistence/legacy-settings-archive'
import { Hash } from '../../../src/shared/contracts/identity'
import { hashContext } from '../../../src/core/reply/hashes'
import { PublicationSchema, type Publication } from '../generation/publication'

export interface LegacyPublicationDraft {
  publication: Publication
  provenance: {
    workspaceId: string
    draftId: string
    contentHash: string
    reviewRevision: number
    reviewHash: string
    reviewer: string
    publicationHash: string
    preparedAt: number
    automaticEnabled: false
    identityVerified: false
  }
}

/** Produces a private draft. Review labels never establish central administrator authority. */
export function prepareLegacyPublication(
  archive: LegacySettingsArchive,
  draftId: string,
  revision: number,
  template: unknown
): LegacyPublicationDraft {
  try {
    Hash.parse(draftId)
    z.number().int().positive().safe().parse(revision)
  } catch {
    throw new Error('legacy_settings_review_required')
  }
  const draft = archive.list().find((d) => d.id === draftId),
    review = archive.reviewState(draftId)
  if (
    !draft ||
    draft.content.kind !== 'mode' ||
    !review ||
    review.revision !== revision ||
    review.decision !== 'accept' ||
    !review.replyRules
  )
    throw new Error('legacy_settings_review_required')
  let publication: z.infer<typeof PublicationSchema>
  try {
    publication = PublicationSchema.parse(structuredClone(template))
    if (
      publication.configuration.automaticEnabled ||
      publication.policy.mode !== 'shadow' ||
      publication.policy.evaluationApproved ||
      publication.evaluationApprovalId !== undefined
    )
      throw new Error('invalid')
    publication.replyRules = review.replyRules
    publication = PublicationSchema.parse(publication)
  } catch {
    throw new Error('legacy_settings_publication_invalid')
  }
  return {
    publication,
    provenance: {
      workspaceId: draft.workspaceId,
      draftId: draft.id,
      contentHash: draft.contentHash,
      reviewRevision: review.revision,
      reviewHash: review.recordHash,
      reviewer: review.reviewer,
      publicationHash: hashContext(publication),
      preparedAt: Date.now(),
      automaticEnabled: false as const,
      identityVerified: false as const
    }
  }
}
