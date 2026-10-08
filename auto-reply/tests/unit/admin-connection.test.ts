import { afterEach, expect, it, vi } from 'vitest'
import { AdminConnection } from '../../src/main/services/admin-connection'
const token = 'G'.repeat(43),
  requestId = '21ca9f0f-1e81-4378-b837-885c7b063d70'
const identity = { tenantId: 'A', actorId: 'admin' }
const summary = {
  requestId,
  actorId: 'admin',
  issuedAt: 1,
  accountCount: 1,
  activeAccounts: 1,
  outsideAccounts: 0,
  targetCount: 1,
  reportedTargets: 0,
  physicalStopVerified: false,
  canAuthorizeSend: false
}
const response = (result: unknown) => Response.json({ result })
afterEach(() => vi.useRealTimers())
it('retains the operator token only in memory and uses a dedicated, bounded, redirect-free transport', async () => {
  const transport = vi.fn<typeof fetch>(async () => response(identity)),
    client = new AdminConnection(transport)
  expect(await client.status()).toEqual({ connected: false })
  expect(await client.connect({ serverUrl: 'https://operator.invalid', token })).toEqual({
    success: true,
    value: { connected: true, serverUrl: 'https://operator.invalid', identity }
  })
  expect(JSON.stringify(await client.status())).not.toContain(token)
  expect(transport.mock.calls[0][1]).toMatchObject({
    redirect: 'manual',
    headers: { authorization: `Bearer ${token}` }
  })
  transport.mockResolvedValue(response(summary))
  expect(await client.pauseAll({ requestId })).toEqual({ success: true, value: summary })
  expect(JSON.parse(String(transport.mock.calls.at(-1)![1]!.body))).toEqual({
    operation: 'request-pause-all',
    requestId
  })
  await client.disconnect()
  expect(await client.pauseAll({ requestId })).toEqual({ success: false, code: 'not_connected' })
})
it('rejects unsafe origins and extra scope before sending any credentials', async () => {
  const transport = vi.fn<typeof fetch>(),
    client = new AdminConnection(transport)
  for (const serverUrl of [
    'http://external.invalid',
    'http://127.0.0.1:4783',
    'https://user:pass@operator.invalid',
    'https://operator.invalid/path',
    'https://operator.invalid?token=x'
  ])
    expect(await client.connect({ serverUrl, token })).toEqual({
      success: false,
      code: 'invalid_input'
    })
  expect(
    await client.connect({ serverUrl: 'https://operator.invalid', token, tenantId: 'B' })
  ).toEqual({ success: false, code: 'invalid_input' })
  expect(transport).not.toHaveBeenCalled()
})
it('invalidates concurrent and disconnected late login responses', async () => {
  const pending: Array<(value: Response) => void> = []
  const transport = vi.fn<typeof fetch>(() => new Promise((resolve) => pending.push(resolve))),
    client = new AdminConnection(transport)
  const one = client.connect({ serverUrl: 'https://one.invalid', token })
  const two = client.connect({ serverUrl: 'https://two.invalid', token })
  pending[1](response(identity))
  expect((await two).success).toBe(true)
  pending[0](response({ tenantId: 'B', actorId: 'other' }))
  expect((await one).success).toBe(false)
  expect((await client.status()).serverUrl).toBe('https://two.invalid')
  const three = client.connect({ serverUrl: 'https://three.invalid', token })
  await client.disconnect()
  expect((await three).success).toBe(false)
  pending[2](response(identity))
  await Promise.resolve()
  expect(await client.status()).toEqual({ connected: false })
})
it('joins cancellation even when transport ignores abort, and stops a hung request within 8 seconds', async () => {
  vi.useFakeTimers()
  const transport = vi.fn<typeof fetch>(async () => response(identity)),
    client = new AdminConnection(transport)
  await client.connect({ serverUrl: 'https://operator.invalid', token })
  transport.mockImplementation(() => new Promise(() => {}))
  const pause = client.pauseAll({ requestId })
  await client.disconnect()
  expect(await pause).toEqual({ success: false, code: 'operation_unconfirmed' })
  const connect = client.connect({ serverUrl: 'https://operator.invalid', token })
  await vi.advanceTimersByTimeAsync(8000)
  expect(await connect).toEqual({ success: false, code: 'operation_unconfirmed' })
})
it('clears access on server permission revocation and rejects forged send or physical-stop authority', async () => {
  const transport = vi.fn<typeof fetch>(async () => response(identity)),
    client = new AdminConnection(transport)
  await client.connect({ serverUrl: 'https://operator.invalid', token })
  transport.mockResolvedValue(response({ ...summary, physicalStopVerified: true }))
  expect((await client.pauseAll({ requestId })).success).toBe(false)
  transport.mockResolvedValue(Response.json({ code: 'denied', secret: token }, { status: 403 }))
  expect(await client.pauseSummary({ requestId })).toEqual({ success: false, code: 'denied' })
  expect(await client.status()).toEqual({ connected: false })
})
it('rejects oversized and malformed upstream responses without exposing content', async () => {
  const transport = vi.fn<typeof fetch>(),
    client = new AdminConnection(transport)
  for (const r of [
    new Response('x'.repeat(2097153), { headers: { 'content-type': 'application/json' } }),
    new Response(Buffer.from([0xff]), { headers: { 'content-type': 'application/json' } }),
    Response.json({ result: identity }, { status: 302 })
  ]) {
    transport.mockResolvedValue(r)
    expect(await client.connect({ serverUrl: 'https://operator.invalid', token })).toEqual({
      success: false,
      code: 'operation_unconfirmed'
    })
  }
})
