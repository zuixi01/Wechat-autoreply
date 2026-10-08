import type { ReplyMode, SpecificObject } from '../core/types'

export function defaultReplyMode(modes: ReplyMode[], configuredId: string): ReplyMode | undefined {
  return (
    modes.find((mode) => mode.id === configuredId) ?? modes.find((mode) => mode.enabled) ?? modes[0]
  )
}

/** Keep old object policies intact until users explicitly save dedicated requirements. */
export function objectReplyPolicy(
  owner: ReplyMode,
  object: SpecificObject,
  common: ReplyMode | undefined
): ReplyMode {
  if (object.replyRules === undefined)
    return { ...owner, autoReply: object.autoReply ?? owner.autoReply }
  const base = common ?? owner
  const requirements = object.replyRules.trim()
  return {
    ...owner,
    prompt:
      base.prompt +
      (requirements
        ? `\n\n## 此对象的专属回复要求\n在遵守通用事实与业务限制的前提下，优先采用以下称呼、语气和处理方式：\n${requirements}`
        : ''),
    unifiedPrefix: base.unifiedPrefix,
    sentimentEnabled: base.sentimentEnabled,
    autoReply: object.autoReply ?? base.autoReply
  }
}
