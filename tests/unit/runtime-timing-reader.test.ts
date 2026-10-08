import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { appendFile, link, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PrivateRuntimeTimingVault } from '../../src/core/persistence/runtime-timing-vault'
import { readSealedRuntimeTimingJournal } from '../../src/core/persistence/runtime-timing-reader'
import { protectPrivateDirectory } from '../../src/core/persistence/private-backup-directory'
import { taskFixture } from '../fixtures/task'
import { learningHash } from '../../src/core/memory/learning-scope'

const roots: string[] = []
const vaults: PrivateRuntimeTimingVault[] = []
const localRoot = resolve('.local/reports')
afterEach(async () => {
  for (const vault of vaults.splice(0)) await vault.shutdown()
  for (const root of roots.splice(0)) {
    const part = relative(localRoot, root)
    if (!part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part))
      throw new Error('unsafe_reader_fixture_cleanup')
    await rm(root, { recursive: true, force: true })
  }
})

// Actual disk/index checks; the event and task are synthetic engineering inputs.
async function fixture() {
  await mkdir(localRoot, { recursive: true })
  const root = await mkdtemp(join(localRoot, 'timing-reader-'))
  roots.push(root)
  await protectPrivateDirectory(root)
  const directory = join(root, 'vault')
  const vault = await PrivateRuntimeTimingVault.open(directory)
  vaults.push(vault)
  const journal = await vault.createSession()
  const task = taskFixture().task
  const record = {
    kind: 'event',
    value: {
      kind: 'agent',
      runtimeInstanceId: randomUUID(),
      event: {
        stage: 'observed',
        identity: task.identity,
        conversationId: task.conversationId,
        sourceMessageId: 'synthetic-source',
        atMs: 10
      }
    }
  }
  expect(journal.offer(record)).toBe(true)
  await vault.finishSession(journal, () =>
    journal.export({ untrustedReportClaims: 'never consumed as evidence' })
  )
  const sessionId = journal.sessionId
  const eventPath = join(directory, sessionId, 'events.private.jsonl')
  return { root, directory, vault, journal, sessionId, eventPath, record, task }
}

describe('sealed timing journal readonly reader', () => {
  it('reads original records and rechecks authority without rewriting disk or trusting a report', async () => {
    const f = await fixture()
    const before = await stat(join(f.directory, 'index.private.sqlite'))
    const source = await readFile(f.eventPath, 'utf8')
    const read = await readSealedRuntimeTimingJournal(f.directory, f.sessionId)
    expect(read.records).toEqual([f.record])
    expect(read.health).toMatchObject({ records: 1, closed: true, pending: 0, dropped: 0 })
    await read.assertCurrent()
    expect(await readFile(f.eventPath, 'utf8')).toBe(source)
    const after = await stat(join(f.directory, 'index.private.sqlite'))
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.size).toBe(before.size)
  })
  it('rejects an unsealed original session even if a report path exists', async () => {
    const f = await fixture()
    const db = new DatabaseSync(join(f.directory, 'index.private.sqlite'))
    try {
      db.prepare("UPDATE sessions SET state='incomplete' WHERE id=?").run(f.sessionId)
    } finally {
      db.close()
    }
    await expect(readSealedRuntimeTimingJournal(f.directory, f.sessionId)).rejects.toThrow(
      'runtime_timing_vault_revoked'
    )
  })
  it('rejects history at the 90-day boundary', async () => {
    const f = await fixture()
    const db = new DatabaseSync(join(f.directory, 'index.private.sqlite'), { readOnly: true })
    let createdAt: number
    try {
      createdAt = Number(
        db.prepare('SELECT created_at FROM sessions WHERE id=?').get(f.sessionId)?.created_at
      )
    } finally {
      db.close()
    }
    await expect(
      readSealedRuntimeTimingJournal(f.directory, f.sessionId, () => createdAt + 90 * 86400000)
    ).rejects.toThrow('runtime_timing_vault_revoked')
  })
  it('checks durable forgetting again after reading a sealed session', async () => {
    const f = await fixture()
    const read = await readSealedRuntimeTimingJournal(f.directory, f.sessionId)
    await f.vault.forgetScope({
      workspaceId: `enterprise:${learningHash({ tenant: f.task.identity.tenantId, account: f.task.identity.accountId })}`,
      tenantId: f.task.identity.tenantId,
      accountId: f.task.identity.accountId,
      platform: f.task.identity.platform,
      conversationId: f.task.conversationId
    })
    await expect(read.assertCurrent()).rejects.toThrow('runtime_timing_vault_revoked')
  })
  it('rejects changed raw events instead of accepting the unchanged exported report', async () => {
    const f = await fixture()
    const read = await readSealedRuntimeTimingJournal(f.directory, f.sessionId)
    await appendFile(f.eventPath, '\n')
    await expect(read.assertCurrent()).rejects.toThrow()
    await expect(readSealedRuntimeTimingJournal(f.directory, f.sessionId)).rejects.toThrow()
  })
  it('rejects a second hard link to the journal', async () => {
    const f = await fixture()
    await link(f.eventPath, join(f.root, 'duplicate-events'))
    await expect(readSealedRuntimeTimingJournal(f.directory, f.sessionId)).rejects.toThrow(
      'runtime_timing_reader_file_invalid'
    )
  })
  it('requires every original event scope to match the durable index scope set', async () => {
    const f = await fixture()
    const db = new DatabaseSync(join(f.directory, 'index.private.sqlite'))
    try {
      db.prepare('DELETE FROM scopes WHERE session_id=?').run(f.sessionId)
    } finally {
      db.close()
    }
    await expect(readSealedRuntimeTimingJournal(f.directory, f.sessionId)).rejects.toThrow(
      'runtime_timing_scope_invalid'
    )
  })
})
