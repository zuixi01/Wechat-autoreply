import type { ReplyMode } from '../../core/types'
import type { MemoryScope } from '../../shared/contracts/learning-memory'
import { learningHash } from '../../core/memory/learning-scope'
import { buildContextSection } from '../../core/ai-client'
import { defaultReplyMode, objectReplyPolicy } from '../../shared/reply-rules'

/** Match the host's object ID hash, never the customer's display name. */
export function learningCalibrationRules(
  scope: MemoryScope,
  modeId: string | undefined,
  modes: ReplyMode[],
  defaultModeId: string
): string {
  const objectMatch = modes
    .flatMap((mode) => mode.specificObjects.map((object) => ({ mode, object })))
    .find(
      ({ mode, object }) =>
        scope.conversationId === `object:${learningHash({ modeId: mode.id, objectId: object.id })}`
    )
  if (scope.conversationId?.startsWith('object:') && !objectMatch)
    throw new Error('calibration_object_unavailable')
  if (objectMatch && modeId && objectMatch.mode.id !== modeId)
    throw new Error('calibration_mode_scope_mismatch')
  const selectedId = modeId || objectMatch?.mode.id || defaultModeId
  const mode = selectedId
    ? modes.find((entry) => entry.id === selectedId)
    : modes.find((entry) => entry.enabled)
  if (!mode) throw new Error('calibration_mode_unavailable')
  const policy = objectMatch
    ? objectReplyPolicy(mode, objectMatch.object, defaultReplyMode(modes, defaultModeId))
    : mode
  return (
    policy.prompt +
    (policy.unifiedPrefix ? `\n回复使用统一开头：${policy.unifiedPrefix}` : '') +
    buildContextSection({
      objectTitle: objectMatch?.object.title,
      objectRelation: objectMatch?.object.relationship
    })
  )
}
