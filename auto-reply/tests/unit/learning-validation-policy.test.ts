import { describe, expect, it } from 'vitest'
import { learningCalibrationRules } from '../../src/main/services/learning-validation-policy'
import { learningHash } from '../../src/core/memory/learning-scope'
import type { ReplyMode } from '../../src/core/types'

const modes: ReplyMode[] = [
  {
    id: 'sales',
    name: '销售',
    source: 'custom',
    prompt: '先问需求',
    sentimentEnabled: false,
    unifiedPrefix: '您好',
    enabled: true,
    running: false,
    autoReply: false,
    createdAt: 1,
    updatedAt: 1,
    specificObjects: [
      {
        id: 'c1',
        name: '同昵称',
        title: '经理',
        relationship: '客户',
        modeId: 'sales',
        autoReply: null
      }
    ]
  },
  {
    id: 'support',
    name: '售后',
    source: 'custom',
    prompt: '先问故障',
    sentimentEnabled: false,
    unifiedPrefix: '',
    enabled: true,
    running: false,
    autoReply: false,
    createdAt: 1,
    updatedAt: 1,
    specificObjects: []
  }
]
const scope = { workspaceId: 'profile', platform: 'generic' as const }
describe('host calibration policy selection', () => {
  it('uses the exact object scope and includes its real rules, prefix and relationship', () => {
    const rules = learningCalibrationRules(
      { ...scope, conversationId: `object:${learningHash({ modeId: 'sales', objectId: 'c1' })}` },
      undefined,
      modes,
      'support'
    )
    expect(rules).toContain('先问需求')
    expect(rules).toContain('您好')
    expect(rules).toContain('经理')
    expect(rules).toContain('客户')
  })
  it('rejects missing objects and unrelated explicit modes instead of silently using another policy', () => {
    expect(() =>
      learningCalibrationRules(
        { ...scope, conversationId: 'object:deleted' },
        undefined,
        modes,
        'sales'
      )
    ).toThrow('calibration_object_unavailable')
    const objectScope = {
      ...scope,
      conversationId: `object:${learningHash({ modeId: 'sales', objectId: 'c1' })}`
    }
    expect(() => learningCalibrationRules(objectScope, 'support', modes, 'sales')).toThrow(
      'calibration_mode_scope_mismatch'
    )
    expect(() => learningCalibrationRules(scope, 'deleted', modes, 'sales')).toThrow(
      'calibration_mode_unavailable'
    )
  })
  it('binds the default or explicitly selected mode rules for a non-object scope', () => {
    expect(learningCalibrationRules(scope, undefined, modes, 'support')).toContain('先问故障')
    expect(learningCalibrationRules(scope, 'sales', modes, 'support')).toContain('先问需求')
  })
})
