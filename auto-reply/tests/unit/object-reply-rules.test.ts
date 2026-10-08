import { describe, expect, it } from 'vitest'
import type { ReplyMode, SpecificObject } from '../../src/core/types'
import { learningCalibrationRules } from '../../src/main/services/learning-validation-policy'
import { learningHash } from '../../src/core/memory/learning-scope'
import { defaultReplyMode, objectReplyPolicy } from '../../src/shared/reply-rules'

const common: ReplyMode = {
  id: 'common',
  name: '通用',
  source: 'custom',
  prompt: '不要承诺未经确认的价格。',
  unifiedPrefix: '您好',
  sentimentEnabled: false,
  enabled: true,
  running: false,
  autoReply: true,
  createdAt: 1,
  updatedAt: 1,
  specificObjects: []
}
function rules(replyRules?: string): string {
  const object = {
    id: 'customer',
    name: '客户',
    title: '王经理',
    relationship: '合作客户',
    modeId: 'legacy',
    autoReply: false,
    ...(replyRules === undefined ? {} : { replyRules })
  } as SpecificObject
  const legacy = {
    ...common,
    id: 'legacy',
    prompt: '使用过去的售后规则。',
    unifiedPrefix: '原开头',
    specificObjects: [object]
  }
  return learningCalibrationRules(
    {
      workspaceId: 'profile',
      platform: 'generic',
      conversationId: `object:${learningHash({ modeId: 'legacy', objectId: 'customer' })}`
    },
    undefined,
    [legacy, common],
    'common'
  )
}
describe('object reply requirements', () => {
  it('keeps the configured common policy even when paused, without enabling it', () => {
    const paused = { ...common, enabled: false }
    expect(defaultReplyMode([{ ...common, id: 'other' }, paused], 'common')).toBe(paused)
    expect(paused.enabled).toBe(false)
  })
  it('preserves a user explicitly opted out of automatic sending', () => {
    const object: SpecificObject = {
      id: 'c',
      name: '客户',
      title: '',
      relationship: '',
      modeId: 'common',
      autoReply: false,
      replyRules: '先询问订单号。'
    }
    expect(objectReplyPolicy(common, object, common).autoReply).toBe(false)
    expect(common.autoReply).toBe(true)
  })
  it('combines dedicated requirements with the common factual constraints', () => {
    const result = rules('语气轻松，先问订单号。')
    expect(result).toContain('不要承诺未经确认的价格。')
    expect(result).toContain('语气轻松，先问订单号。')
    expect(result).toContain('王经理')
    expect(result).not.toContain('使用过去的售后规则。')
  })
  it('clearing dedicated requirements follows the common rules and prefix', () => {
    const result = rules('')
    expect(result).toContain('不要承诺未经确认的价格。')
    expect(result).toContain('回复使用统一开头：您好')
    expect(result).not.toContain('原开头')
    expect(result).not.toContain('使用过去的售后规则。')
  })
  it('preserves an existing object configuration until it is edited', () => {
    const result = rules()
    expect(result).toContain('使用过去的售后规则。')
    expect(result).toContain('回复使用统一开头：原开头')
    expect(result).not.toContain('不要承诺未经确认的价格。')
  })
})
