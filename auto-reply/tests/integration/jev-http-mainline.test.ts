import { describe, expect, it, vi } from 'vitest'
import {
  runOfflineJevDemo,
  runOfflineJevScenario
} from '../../server/src/generation/offline-jev-demo'

describe('offline Jev HTTP mainline', () => {
  it('runs actual HTTP clients through all three stages without global fetch or chat access', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network_forbidden'))
    try {
      const report = await runOfflineJevDemo()
      expect(report).toMatchObject({
        passed: true,
        mode: 'offline_simulation',
        realProviderCalled: false,
        messagesSent: 0,
        realAccuracyValidated: false,
        productionReady: false
      })
      expect(report.cases).toHaveLength(12)
      expect(network).not.toHaveBeenCalled()
      for (const platform of ['wechat', 'wework']) {
        const faq = report.cases.find(
          (item) => item.platform === platform && item.scenario === 'faq'
        )!
        expect(faq.calls).toEqual([
          { stage: 'pre', path: '/v1/systemone' },
          { stage: 'text', path: '/v1/chat/completions' },
          {
            stage: 'post',
            path: '/v1/systemone',
            finalDraft: '本产品支持离线阅读。',
            evidenceIds: [`offline-faq-${platform}`]
          }
        ])
        expect(faq.result).toMatchObject({
          automaticAllowed: true,
          factsVerified: true,
          review: { status: 'passed' }
        })
      }
    } finally {
      network.mockRestore()
    }
  })

  it('stops explicit human requests before HTTP and unsupported secondary requests before text generation', async () => {
    const human = await runOfflineJevScenario('human_request')
    expect(human.calls).toEqual([])
    expect(human.result).toMatchObject({
      status: 'handoff',
      automaticAllowed: false,
      reasons: ['explicit_human_request']
    })
    const mixed = await runOfflineJevScenario('mixed_requests')
    expect(mixed.calls.map((call) => call.stage)).toEqual(['pre'])
    expect(mixed.result).toMatchObject({
      status: 'handoff',
      automaticAllowed: false,
      reasons: ['intent_outside_scope'],
      intents: ['faq', 'aftersales']
    })
  })

  it('requires human confirmation for a failed audit or invented fact even with high model scores', async () => {
    const failed = await runOfflineJevScenario('audit_failure')
    expect(failed.result).toMatchObject({
      automaticAllowed: false,
      reasons: ['audit_supported'],
      review: { status: 'needs_human' }
    })
    const invented = await runOfflineJevScenario('invented_fact')
    expect(invented.calls[2].finalDraft).toBe('退款已到账，再优惠100元。')
    expect(invented.result).toMatchObject({
      automaticAllowed: false,
      factsVerified: false,
      reasons: ['freeform_requires_human'],
      review: { status: 'needs_human' }
    })
  })

  it('does not bypass a malformed successful HTTP response', async () => {
    const malformed = await runOfflineJevScenario('malformed_decision')
    expect(malformed.calls.map((call) => call.stage)).toEqual(['pre'])
    expect(malformed.result).toMatchObject({
      status: 'invalid',
      automaticAllowed: false,
      reasons: ['decision_or_generation_failed']
    })
  })
})
