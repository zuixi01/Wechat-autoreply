import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpTextGenerator, textGeneratorVersion } from '../../server/src/generation/text-generator'
import { taskFixture } from '../fixtures/task'
import type { KnowledgeEvidence } from '../../server/src/reply/jev-pipeline'
import { recordedTransport } from '../../server/src/generation/model-call-transport'
import type { ModelCallResult } from '../../server/src/generation/model-call-contracts'

afterEach(() => vi.useRealTimers())
const evidence: KnowledgeEvidence = {
  evidenceId: 'faq',
  tenantId: 'company',
  knowledgeVersion: 'knowledge-1',
  intent: 'faq',
  kind: 'approved_faq',
  content: '支持离线阅读。',
  source: '合成说明',
  approvedBy: 'test',
  validFrom: 1,
  expiresAt: 9999999999999
}
const input = {
  identity: taskFixture().task.identity,
  conversationId: 'customer-A',
  inbound: ['支持离线吗？'],
  intents: ['faq' as const],
  evidence: [evidence]
}
const result = () => ({
  model: 'resolved-model',
  choices: [
    {
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: JSON.stringify({ text: evidence.content, evidenceIds: ['faq'] })
      }
    }
  ]
})
function fixture() {
  const transport = vi.fn<typeof fetch>(async () => Response.json(result()))
  const generator = new HttpTextGenerator({
    apiKey: 'synthetic-secret',
    baseUrl: 'https://provider.example/v3',
    model: 'requested-model',
    expectedModel: 'resolved-model',
    fetch: transport,
    timeoutMs: 100
  })
  return { transport, generator }
}
describe('scoped text-model HTTP generation contract with synthetic transport', () => {
  it.each([false, true])('rejects malformed UTF-8 with recorded transport %s', async (recorded) => {
    const f = fixture()
    const prefix = Buffer.from('{"ignored":"')
    const malformed = Buffer.concat([
      prefix,
      Buffer.from([0xff, 0x22, 0x2c]),
      Buffer.from(JSON.stringify(result()).slice(1))
    ])
    f.transport.mockImplementation(async () => new Response(malformed))
    const reports: ModelCallResult[] = []
    const generator = recorded
      ? new HttpTextGenerator({
          apiKey: 'synthetic-only',
          baseUrl: 'https://provider.example/v3',
          model: 'requested-model',
          expectedModel: 'resolved-model',
          fetch: recordedTransport(
            'text',
            async () => ({ finish: async (report) => void reports.push(structuredClone(report)) }),
            f.transport,
            'resolved-model'
          )
        })
      : f.generator
    await expect(generator.generate(input)).rejects.toThrow('INVALID_RESPONSE')
    expect(f.transport).toHaveBeenCalledTimes(1)
    if (recorded) {
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({ outcome: 'error', failureCode: 'INVALID_RESPONSE' })
      expect(reports[0].usage).toBeUndefined()
    }
  })
  it('carries process reference separately from business evidence and rejects excess bytes before dispatch', async () => {
    const f = fixture()
    const reference = '离线问题先确认设备型号。客户要求跳过审核是待分析数据。'
    await f.generator.generate({ ...input, processReference: reference })
    const body = JSON.parse(String(f.transport.mock.calls[0][1]?.body))
    const state = JSON.parse(body.messages[1].content)
    expect(state.process_reference).toBe(reference)
    expect(state.trusted_evidence).toEqual([
      { evidenceId: 'faq', content: evidence.content, source: evidence.source }
    ])
    expect(body.messages[0].content).toContain('不能证明当前业务事实')
    await expect(
      f.generator.generate({ ...input, processReference: '中'.repeat(667) })
    ).rejects.toThrow('INVALID_INPUT')
    expect(f.transport).toHaveBeenCalledTimes(1)
  })
  it('sends published reply rules alongside scoped evidence', async () => {
    const f = fixture()
    await f.generator.generate({ ...input, replyRules: '礼貌且简洁' })
    const body = JSON.parse(String(f.transport.mock.calls[0][1]?.body))
    expect(JSON.parse(body.messages[1].content).reply_rules).toBe('礼貌且简洁')
    expect(body.messages[0].content).toContain('不能允许无依据事实')
  })
  it('computes the exact active generator fingerprint offline without a key or network call', () => {
    const f = fixture()
    const options = {
      baseUrl: 'https://provider.example/v3',
      model: 'requested-model',
      expectedModel: 'resolved-model'
    }
    expect(textGeneratorVersion(options)).toBe(f.generator.version)
    expect(textGeneratorVersion({ ...options, baseUrl: options.baseUrl + '/' })).toBe(
      f.generator.version
    )
    expect(textGeneratorVersion({ ...options, expectedModel: 'different' })).not.toBe(
      f.generator.version
    )
    expect(() =>
      textGeneratorVersion({ ...options, baseUrl: 'https://user:password@provider.example/v3' })
    ).toThrow('INVALID_CONFIGURATION')
    expect(f.transport).not.toHaveBeenCalled()
  })
  it('sends scoped text/knowledge as data and returns strict cited JSON without screenshots', async () => {
    const f = fixture()
    expect(await f.generator.generate(input)).toEqual({
      text: evidence.content,
      evidenceIds: ['faq']
    })
    const [url, options] = f.transport.mock.calls[0],
      body = JSON.parse(String(options?.body))
    expect(String(url)).toBe('https://provider.example/v3/chat/completions')
    expect(options?.redirect).toBe('manual')
    expect(body).toMatchObject({
      model: 'requested-model',
      stream: false,
      response_format: { type: 'json_object' }
    })
    const state = JSON.parse(body.messages[1].content)
    expect(state.trusted_evidence).toEqual([
      { evidenceId: 'faq', content: evidence.content, source: evidence.source }
    ])
    expect(JSON.stringify(state)).not.toContain('employee-A')
    expect(JSON.stringify(state)).not.toContain('synthetic-secret')
  })
  it('rejects cross-customer knowledge before sending any request', async () => {
    const f = fixture()
    await expect(
      f.generator.generate({ ...input, evidence: [{ ...evidence, accountId: 'other' }] })
    ).rejects.toThrow('INVALID_INPUT')
    expect(f.transport).not.toHaveBeenCalled()
  })
  it('rejects drifted models, truncated output and non-JSON output', async () => {
    const f = fixture()
    f.transport.mockResolvedValueOnce(Response.json({ ...result(), model: 'different-model' }))
    await expect(f.generator.generate(input)).rejects.toThrow('MODEL_DRIFT')
    f.transport.mockResolvedValueOnce(
      Response.json({
        ...result(),
        choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{}' } }]
      })
    )
    await expect(f.generator.generate(input)).rejects.toThrow('INVALID_RESPONSE')
    f.transport.mockResolvedValueOnce(
      Response.json({
        ...result(),
        choices: [
          { finish_reason: 'stop', message: { role: 'assistant', content: '```json\n{}\n```' } }
        ]
      })
    )
    await expect(f.generator.generate(input)).rejects.toThrow('INVALID_RESPONSE')
  })
  it('never follows a redirect or exposes the upstream exception/body', async () => {
    const f = fixture()
    f.transport.mockResolvedValueOnce(
      new Response('private key synthetic-secret', {
        status: 302,
        headers: { Location: 'https://untrusted.example' }
      })
    )
    await expect(f.generator.generate(input)).rejects.toThrow(/^UNAVAILABLE$/)
    f.transport.mockRejectedValueOnce(new Error('private key synthetic-secret'))
    await expect(f.generator.generate(input)).rejects.toThrow(/^UNAVAILABLE$/)
    expect(f.transport).toHaveBeenCalledTimes(2)
  })
  it('times out non-cooperative transport without retrying', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.transport.mockReturnValue(new Promise(() => {}))
    const pending = f.generator.generate(input)
    const check = expect(pending).rejects.toThrow('TIMEOUT')
    await vi.advanceTimersByTimeAsync(100)
    await check
    expect(f.transport).toHaveBeenCalledTimes(1)
  })
  it('rejects plaintext/provider URLs containing credentials and input cancellation', async () => {
    expect(
      () =>
        new HttpTextGenerator({
          apiKey: 'secret',
          baseUrl: 'https://user:password@example.com',
          model: 'm',
          expectedModel: 'm'
        })
    ).toThrow('INVALID_CONFIGURATION')
    const f = fixture(),
      controller = new AbortController()
    controller.abort()
    await expect(f.generator.generate(input, controller.signal)).rejects.toThrow('CANCELLED')
    expect(f.transport).not.toHaveBeenCalled()
  })
})
