import { z } from 'zod'
import { CalibrationInputSchema, type CalibrationInput } from './calibration'
import {
  BlindReviewArtifactSchema,
  BlindLabelsSchema,
  PrivateBlindReviewPacketSchema,
  importJevBlindLabels,
  type JevBlindImportResult
} from './blind-review'
import { isExplicitHumanRequest } from '../../server/src/reply/jev-pipeline'

export const CalibrationSettingsSchema = z.strictObject({
  candidates: CalibrationInputSchema.shape.candidates,
  targets: CalibrationInputSchema.shape.targets
})

/** Local consistency only. The command must authenticate the freeze, artifact
 * and packet seals and latest independent review before and after this work.
 * Candidate predeclaration, fees and business truth are not established here. */
export function prepareJevReplayCalibration(
  rawPacket: unknown,
  rawArtifacts: unknown,
  rawLabels: unknown,
  rawSettings: unknown
): {
  input: CalibrationInput
  settings: z.infer<typeof CalibrationSettingsSchema>
  adjudication: JevBlindImportResult
} {
  const packet = PrivateBlindReviewPacketSchema.parse(rawPacket)
  if (packet.input.split !== 'calibration') throw new Error('calibration_split_required')
  const settings = CalibrationSettingsSchema.parse(rawSettings)
  const labels = BlindLabelsSchema.parse(rawLabels)
  const adjudication = importJevBlindLabels(packet, rawArtifacts, rawLabels)
  const artifacts = z.array(BlindReviewArtifactSchema).parse(rawArtifacts)
  const byCase = new Map(artifacts.filter((a) => a.arm === 'C').map((a) => [a.caseId, a]))
  const inputCases = new Map(packet.input.cases.map((item) => [item.caseId, item]))
  const samples = adjudication.cases.map((item) => {
    const artifact = byCase.get(item.caseId)!
    const outcome = item.outcomes.find((o) => o.arm === 'C')!
    const humanRequested = isExplicitHumanRequest(inputCases.get(item.caseId)!.inbound)
    if (
      humanRequested &&
      (artifact.status !== 'handoff' ||
        !artifact.reasons.includes('explicit_human_request') ||
        artifact.pre !== null ||
        artifact.post !== null ||
        artifact.draft !== null ||
        artifact.intents.length !== 0 ||
        artifact.factsVerified ||
        artifact.wouldRelease ||
        artifact.attempts === null ||
        artifact.attempts.length !== 0 ||
        artifact.stages.length !== 0)
    )
      throw new Error('calibration_human_observation_changed')
    return {
      caseId: item.caseId,
      conversationGroup: item.conversationGroup,
      split: 'calibration' as const,
      eligible: item.eligible,
      expectedHandoff: item.expectedHandoff,
      explicitHumanRequest: humanRequested,
      // bindArtifacts rejects invalid/cancelled observations. A recorded predecision
      // crossed the original fixed preconditions; later missing drafts stay unknown
      // counterfactuals rather than being hidden with a false prerequisite flag.
      deterministicPreconditionsPassed: true,
      factsVerified: artifact.factsVerified,
      draftAvailable: artifact.draft !== null,
      assessedIntents: artifact.intents,
      substantialCorrection: outcome.substantialCorrection,
      severeFactError: outcome.severeFactError,
      unauthorizedPromise: outcome.unauthorizedPromise,
      pre: artifact.pre,
      post: artifact.post
    }
  })
  const input = CalibrationInputSchema.parse({
    datasetId: packet.input.datasetId,
    dataKind: packet.dataKind,
    annotationSource: 'blinded_business_adjudication',
    adjudicatedBy: labels.adjudicatedBy,
    experimentSnapshotHash: packet.frozen.snapshotHash,
    basePolicy: packet.frozen.publication.policy,
    ...settings,
    samples
  })
  return { input, settings, adjudication }
}
