import { expect, it, vi } from 'vitest'
import { AdminConnection } from '../../src/main/services/admin-connection'
import { MemoryAdminPauseJournal } from '../../src/main/services/admin-pause-journal'

const identity = { tenantId: 'A', actorId: 'admin' },
  token = 'G'.repeat(43)
const login = { serverUrl: 'https://operator.invalid', token }
const id = '21ca9f0f-1e81-4378-b837-885c7b063d70',
  other = '21ca9f0f-1e81-4378-b837-885c7b063d71'
const scope = { origin: login.serverUrl, ...identity }
const summary = {
  requestId: id,
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
const response = (value: unknown) => Response.json({ result: value })
const operation = (init?: RequestInit) => JSON.parse(String(init?.body)).operation as string
function transport() {
  return vi.fn<typeof fetch>(async (_url, init) =>
    response(operation(init) === 'identity' ? identity : summary)
  )
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
it('commits the original intent before HTTP and restores it only after authenticating the same scope', async () => {
  const journal = new MemoryAdminPauseJournal(),
    send = transport(),
    client = new AdminConnection(send, false, journal)
  await client.connect(login)
  send.mockImplementation(async (_url, init) => {
    expect(operation(init)).toBe('request-pause-all')
    expect(await journal.latest(scope)).toMatchObject({ requestId: id, confirmed: false })
    throw new Error('synthetic_lost_response')
  })
  expect(await client.pauseAll({ requestId: id.toUpperCase() })).toEqual({
    success: false,
    code: 'operation_unconfirmed'
  })
  await client.disconnect()
  expect(await client.status()).toEqual({ connected: false })
  const restarted = new AdminConnection(transport(), false, journal)
  expect(await restarted.connect(login)).toMatchObject({
    success: true,
    value: { latestPause: { requestId: id, confirmed: false, recovered: true } }
  })
  expect(await restarted.pauseAll({ requestId: other })).toEqual({
    success: false,
    code: 'pause_pending',
    requestId: id
  })
  expect(await restarted.pauseAll({ requestId: id })).toEqual({ success: true, value: summary })
})
it('refuses to submit if the journal cannot commit or a pause operation is already running', async () => {
  const journal = new MemoryAdminPauseJournal(),
    send = transport(),
    client = new AdminConnection(send, false, journal)
  await client.connect(login)
  const begin = vi.spyOn(journal, 'begin').mockRejectedValueOnce(new Error('disk_full'))
  expect(await client.pauseAll({ requestId: id })).toEqual({
    success: false,
    code: 'journal_unavailable',
    requestId: id
  })
  expect(send).toHaveBeenCalledTimes(1)
  const gate = deferred<Awaited<ReturnType<typeof journal.begin>>>()
  begin.mockReturnValueOnce(gate.promise)
  const pause = client.pauseAll({ requestId: id })
  expect(await client.pauseAll({ requestId: other })).toEqual({
    success: false,
    code: 'operation_busy'
  })
  await client.disconnect()
  gate.resolve({ accepted: true, record: { requestId: id, confirmed: false, createdAt: 1 } })
  expect(await pause).toEqual({ success: false, code: 'operation_unconfirmed' })
  expect(send).toHaveBeenCalledTimes(1)
})
it('does not install a late authenticated session while loading its disk record', async () => {
  const journal = new MemoryAdminPauseJournal(),
    send = transport(),
    client = new AdminConnection(send, false, journal)
  const reached = deferred<void>(),
    gate = deferred<null>()
  vi.spyOn(journal, 'latest').mockImplementationOnce(() => {
    reached.resolve()
    return gate.promise
  })
  const connecting = client.connect(login)
  await reached.promise
  await client.disconnect()
  gate.resolve(null)
  expect(await connecting).toEqual({ success: false, code: 'operation_unconfirmed' })
  expect(await client.status()).toEqual({ connected: false })
})
it('rejects a response from another batch and keeps the original pending across reauthentication', async () => {
  const journal = new MemoryAdminPauseJournal(),
    send = transport(),
    client = new AdminConnection(send, false, journal)
  await client.connect(login)
  send.mockImplementation(async () => response({ ...summary, requestId: other }))
  expect((await client.pauseAll({ requestId: id })).success).toBe(false)
  expect((await client.pauseSummary({ requestId: id })).success).toBe(false)
  expect(await journal.latest(scope)).toMatchObject({ requestId: id, confirmed: false })
  expect(await client.pauseAll({ requestId: other })).toEqual({
    success: false,
    code: 'pause_pending',
    requestId: id
  })
})
it('keeps unknown intent when confirmation cannot persist and never creates a pause from a known historical batch', async () => {
  const journal = new MemoryAdminPauseJournal(),
    send = transport(),
    client = new AdminConnection(send, false, journal)
  await client.connect(login)
  const confirm = vi.spyOn(journal, 'confirm').mockRejectedValueOnce(new Error('disk_full'))
  expect(await client.pauseAll({ requestId: id })).toEqual({
    success: false,
    code: 'journal_unavailable',
    requestId: id
  })
  expect(await journal.latest(scope)).toMatchObject({ confirmed: false })
  confirm.mockRestore()
  expect((await client.pauseSummary({ requestId: id })).success).toBe(true)
  send.mockClear()
  expect((await client.pauseAll({ requestId: id })).success).toBe(true)
  expect(send).toHaveBeenCalledTimes(1)
  expect(operation(send.mock.calls[0][1])).toBe('pause-all-request')
})
it('does not let a late historical confirmation mark a newer in-flight batch as confirmed', async () => {
  const journal = new MemoryAdminPauseJournal(),
    send = transport(),
    client = new AdminConnection(send, false, journal)
  await client.connect(login)
  send.mockRejectedValueOnce(new Error('synthetic_lost_response'))
  await client.pauseAll({ requestId: id })
  const reached = deferred<void>(),
    gate = deferred<Awaited<ReturnType<typeof journal.confirm>>>()
  const originalConfirm = journal.confirm.bind(journal)
  vi.spyOn(journal, 'confirm').mockImplementationOnce(async (scope, requestId) => {
    await originalConfirm(scope, requestId)
    reached.resolve()
    return gate.promise
  })
  const historical = client.pauseSummary({ requestId: id })
  await reached.promise
  const newSent = deferred<void>(),
    reply = deferred<Response>()
  send.mockImplementationOnce(() => {
    newSent.resolve()
    return reply.promise
  })
  const newer = client.pauseAll({ requestId: other })
  await newSent.promise
  gate.resolve({ requestId: id, confirmed: true, createdAt: 1 })
  expect((await historical).success).toBe(true)
  expect((await client.status()).latestPause).toEqual({ requestId: other, confirmed: false })
  await client.disconnect()
  expect((await newer).success).toBe(false)
  reply.resolve(response({ ...summary, requestId: other }))
})
it('allows read-only diagnostics when storage is unavailable and isolates recovered records by identity and origin', async () => {
  const journal = new MemoryAdminPauseJournal(),
    send = transport(),
    client = new AdminConnection(send, false, journal)
  await journal.begin(scope, id)
  await client.connect({ ...login, serverUrl: 'https://other.invalid' })
  expect((await client.status()).latestPause).toBeUndefined()
  send.mockImplementation(async () => response({ tenantId: 'B', actorId: 'other' }))
  await client.connect(login)
  expect((await client.status()).latestPause).toBeUndefined()
  send.mockImplementation(async () => response(identity))
  vi.spyOn(journal, 'latest').mockRejectedValueOnce(new Error('acl_changed'))
  expect(await client.connect(login)).toMatchObject({
    success: true,
    value: { connected: true, journalUnavailable: true }
  })
  await client.close()
  expect(await client.connect(login)).toEqual({ success: false, code: 'not_connected' })
})
