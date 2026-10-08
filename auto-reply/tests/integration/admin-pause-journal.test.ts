import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { FileAdminPauseJournal } from '../../src/main/services/admin-pause-journal'
import { AdminConnection } from '../../src/main/services/admin-connection'

const scope = { origin: 'https://operator.invalid', tenantId: 'A', actorId: 'admin' }
const roots: string[] = [],
  journals: FileAdminPauseJournal[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'autoreply-admin-pause-'))
  roots.push(root)
  const directory = join(root, 'operations'),
    journal = new FileAdminPauseJournal(directory)
  journals.push(journal)
  return { root, directory, journal }
}
afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close()
  for (const root of roots.splice(0)) {
    if (
      !resolve(root).startsWith(resolve(tmpdir()) + sep) ||
      !root.includes('autoreply-admin-pause-')
    )
      throw new Error('unsafe_test_cleanup')
    await rm(root, { recursive: true, force: true })
  }
})
it('reopens actual SQLite after an unconfirmed commit and blocks replacement of the original UUID', async () => {
  const { directory, journal } = await fixture(),
    id = randomUUID(),
    other = randomUUID()
  expect(await journal.begin(scope, id.toUpperCase())).toMatchObject({
    accepted: true,
    record: { requestId: id, confirmed: false }
  })
  await journal.close()
  const reopened = new FileAdminPauseJournal(directory)
  journals.push(reopened)
  expect(await reopened.latest(scope)).toMatchObject({ requestId: id, confirmed: false })
  expect(await reopened.begin(scope, other)).toMatchObject({
    accepted: false,
    record: { requestId: id }
  })
  expect(await reopened.confirm(scope, id)).toMatchObject({ confirmed: true })
  expect(await reopened.begin(scope, other)).toMatchObject({
    accepted: true,
    record: { requestId: other, confirmed: false }
  })
  expect(await reopened.begin(scope, id)).toMatchObject({
    accepted: false,
    record: { requestId: other }
  })
  expect(await reopened.confirm(scope, randomUUID())).toBeNull()
})
it('keeps server, tenant, and authenticated actor records separate and stores no login credentials', async () => {
  const { directory, journal } = await fixture(),
    id = randomUUID()
  await journal.begin(scope, id)
  for (const other of [
    { ...scope, origin: 'https://other.invalid' },
    { ...scope, tenantId: 'B' },
    { ...scope, actorId: 'other' }
  ]) {
    expect(await journal.latest(other)).toBeNull()
    expect((await journal.begin(other, randomUUID())).accepted).toBe(true)
  }
  await journal.close()
  const content = await readFile(join(directory, 'pause.sqlite'))
  expect(content.toString()).not.toContain('G'.repeat(43))
  expect(content.toString()).not.toContain('authorization')
})
it('rejects foreign files and cannot reopen or write after close', async () => {
  const { directory, journal } = await fixture()
  await journal.begin(scope, randomUUID())
  await writeFile(join(directory, 'foreign.txt'), 'synthetic')
  await expect(journal.begin(scope, randomUUID())).rejects.toThrow()
  await journal.close()
  await expect(journal.latest(scope)).rejects.toThrow('admin_journal_closed')
})
it('recovers an actual desktop intent after response loss without persisting bearer or submitting automatically on login', async () => {
  const { directory, journal } = await fixture(),
    id = randomUUID(),
    token = 'G'.repeat(43)
  const identity = { tenantId: scope.tenantId, actorId: scope.actorId },
    calls: string[] = []
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
  let loseResponse = true
  const send: typeof fetch = async (_url, init) => {
    const operation = JSON.parse(String(init?.body)).operation
    calls.push(operation)
    if (operation === 'identity') return Response.json({ result: identity })
    if (loseResponse) throw new Error('synthetic_lost_response')
    return Response.json({ result: summary })
  }
  const first = new AdminConnection(send, false, journal)
  await first.connect({ serverUrl: scope.origin, token })
  expect((await first.pauseAll({ requestId: id })).success).toBe(false)
  await first.close()
  const recoveredJournal = new FileAdminPauseJournal(directory)
  journals.push(recoveredJournal)
  const recovered = new AdminConnection(send, false, recoveredJournal)
  calls.length = 0
  expect(await recovered.connect({ serverUrl: scope.origin, token })).toMatchObject({
    success: true,
    value: { latestPause: { requestId: id, recovered: true, confirmed: false } }
  })
  expect(calls).toEqual(['identity'])
  loseResponse = false
  expect((await recovered.pauseAll({ requestId: id })).success).toBe(true)
  await recovered.close()
  expect((await readFile(join(directory, 'pause.sqlite'))).toString()).not.toContain(token)
})
