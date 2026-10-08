import { afterEach, describe, expect, it } from 'vitest'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PrivateRuntimeTimingVault } from '../../src/core/persistence/runtime-timing-vault'
import { RuntimeTimingEvidence } from '../../src/core/agent/runtime-timing-evidence'
import { verifyPrivatePaths } from '../../src/core/persistence/private-backup-directory'
import { learningHash } from '../../src/core/memory/learning-scope'
import { taskFixture } from '../fixtures/task'
import type { PrivateRuntimeTimingJournal } from '../../src/core/persistence/runtime-timing-journal'
import { spawn, type ChildProcess } from 'node:child_process'

const roots: string[] = [],
  vaults: PrivateRuntimeTimingVault[] = [],
  journals: { vault: PrivateRuntimeTimingVault; journal: PrivateRuntimeTimingJournal }[] = []
const children: { child: ChildProcess; exited: Promise<number> }[] = []
function childHost(directory: string, mode: 'sealed' | 'crash' | 'live') {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', resolve('tests/fixtures/runtime-timing-vault-process.ts'), mode, directory],
    {
      cwd: process.cwd(),
      env: { ...process.env, AUTOREPLY_RUNTIME_VAULT_FIXTURE: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    }
  )
  child.stdout?.resume()
  child.stderr?.resume()
  const messages: Record<string, unknown>[] = []
  child.on('message', (value) => {
    if (value && typeof value === 'object') messages.push(value as Record<string, unknown>)
  })
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? -1))
  })
  children.push({ child, exited })
  const message = async (kind: string): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      const value = messages.find((value) => value.kind === kind)
      if (value) return value
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error('fixture_exited_before_message')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('fixture_message_timeout')
  }
  return { child, exited, message }
}
async function root(): Promise<string> {
  const base = resolve('.local/reports')
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(join(base, 'runtime-vault-'))
  roots.push(directory)
  return directory
}
async function opened(
  directory: string,
  limits: unknown = {},
  now?: () => number
): Promise<PrivateRuntimeTimingVault> {
  const vault = await PrivateRuntimeTimingVault.open(directory, limits, now)
  vaults.push(vault)
  return vault
}
async function session(vault: PrivateRuntimeTimingVault) {
  const journal = await vault.createSession()
  journals.push({ vault, journal })
  return { journal, evidence: new RuntimeTimingEvidence(journal) }
}
function observe(
  evidence: RuntimeTimingEvidence,
  accountId = 'account-A',
  conversationId = 'customer-A'
): void {
  const identity = { ...taskFixture().task.identity, accountId }
  evidence.record({
    kind: 'agent',
    runtimeInstanceId: randomUUID(),
    event: {
      stage: 'observed',
      identity,
      conversationId,
      sourceMessageId: 'synthetic-source',
      atMs: performance.now()
    }
  })
}
function scope(accountId = 'account-A', conversationId?: string) {
  const identity = { ...taskFixture().task.identity, accountId }
  return {
    workspaceId: `enterprise:${learningHash({ tenant: identity.tenantId, account: accountId })}`,
    tenantId: identity.tenantId,
    accountId,
    platform: identity.platform,
    ...(conversationId ? { conversationId } : {})
  }
}
afterEach(async () => {
  for (const host of children.splice(0)) {
    if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill()
    await host.exited
  }
  for (const item of journals.splice(0)) {
    await item.journal.close()
    await item.vault.finishSession(item.journal)
  }
  for (const vault of vaults.splice(0)) await vault.shutdown()
  for (const directory of roots.splice(0)) {
    const part = relative(resolve('.local/reports'), directory)
    if (
      !part ||
      isAbsolute(part) ||
      part === '..' ||
      part.startsWith('..' + sep) ||
      !part.startsWith('runtime-vault-')
    )
      throw new Error('fixture_cleanup_boundary')
    await rm(directory, { recursive: true, force: true })
  }
})

describe('private bounded runtime timing vault (synthetic engineering metadata)', () => {
  it('checks actual sealed files before new admission instead of trusting an old byte counter', async () => {
    const directory = await root(),
      vault = await opened(directory, {
        maxSessionBytes: 2 * 1024 * 1024,
        maxTotalBytes: 36 * 1024 * 1024
      }),
      f = await session(vault)
    observe(f.evidence)
    const output = await vault.finishSession(f.journal, () => f.evidence.export())
    await writeFile(output!, 'x'.repeat(3 * 1024 * 1024))
    const names = await readdir(directory)
    await expect(vault.createSession()).rejects.toThrow('runtime_timing_vault_capacity')
    await expect(vault.assertReadable(f.journal.sessionId)).rejects.toThrow(
      'runtime_timing_vault_capacity'
    )
    expect(await readdir(directory)).toEqual(names)
  })
  it('forgets a sealed capture from an actual earlier OS process', async () => {
    const directory = await root(),
      host = childHost(directory, 'sealed'),
      ready = await host.message('ready')
    expect(ready.pid).toBe(host.child.pid)
    expect(ready.pid).not.toBe(process.pid)
    expect(await host.exited).toBe(0)
    const vault = await opened(directory),
      id = String(ready.sessionId)
    await vault.assertReadable(id)
    await vault.forgetScope(scope())
    await expect(access(join(directory, id))).rejects.toBeDefined()
    expect((await vault.inventory()).sessions).toBe(0)
  }, 15000)
  it('keeps a killed process interval incomplete and releases only its conservative storage reservation', async () => {
    const directory = await root(),
      host = childHost(directory, 'crash'),
      ready = await host.message('ready')
    host.child.send('exit-without-seal')
    expect(await host.exited).toBe(17)
    const vault = await opened(directory),
      id = String(ready.sessionId)
    expect(await vault.inventory()).toMatchObject({ sessions: 1, active: 0 })
    expect((await vault.inventory()).reservedBytes).toBeLessThan(64 * 1024 * 1024)
    await expect(vault.assertReadable(id)).rejects.toThrow('runtime_timing_vault_revoked')
    await expect(access(join(directory, id, 'report.private.json'))).rejects.toBeDefined()
    expect(await readFile(join(directory, id, 'events.private.jsonl'), 'utf8')).not.toContain(
      'session_closed'
    )
  }, 15000)
  it('fences an actual live foreign writer before cleanup and reports busy until it acknowledges quiescence', async () => {
    const directory = await root(),
      host = childHost(directory, 'live'),
      ready = await host.message('ready'),
      vault = await opened(directory),
      id = String(ready.sessionId)
    await expect(vault.forgetScope(scope())).rejects.toThrow('runtime_timing_vault_writer_busy')
    await access(join(directory, id))
    host.child.send('write-after-forget')
    expect(await host.message('finished')).toMatchObject({
      records: 1,
      dropped: 1,
      reason: 'journal_write_failed'
    })
    expect(await host.exited).toBe(0)
    expect(await readFile(join(directory, id, 'events.private.jsonl'), 'utf8')).not.toContain(
      'synthetic-late-source'
    )
    await vault.forgetScope(scope())
    await expect(access(join(directory, id))).rejects.toBeDefined()
  }, 15000)
  it('protects the actual index and session, freezes a report and charges actual sealed bytes', async () => {
    const directory = await root(),
      vault = await opened(directory),
      f = await session(vault)
    observe(f.evidence)
    const output = await vault.finishSession(f.journal, () => f.evidence.export())
    expect(output).toBe(join(f.journal.directory, 'report.private.json'))
    await verifyPrivatePaths(directory, [
      join(directory, 'index.private.sqlite'),
      f.journal.directory
    ])
    await verifyPrivatePaths(f.journal.directory, [
      output!,
      join(f.journal.directory, 'events.private.jsonl')
    ])
    expect(JSON.parse(await readFile(output!, 'utf8'))).toMatchObject({
      status: 'insufficient',
      businessVerified: false
    })
    expect(await vault.inventory()).toMatchObject({ sessions: 1, active: 0 })
    expect((await vault.inventory()).reservedBytes).toBeLessThan(64 * 1024 * 1024)
  })
  it('reserves future bytes and rejects session/aggregate overcommit before creating another directory', async () => {
    const directory = await root(),
      vault = await opened(directory, { maxSessions: 1 }),
      f = await session(vault)
    const names = await readdir(directory)
    await expect(vault.createSession()).rejects.toThrow('runtime_timing_vault_capacity')
    expect(await readdir(directory)).toEqual(names)
    await vault.finishSession(f.journal)
    await expect(vault.createSession()).rejects.toThrow('runtime_timing_vault_capacity')
    const small = await opened(await root(), {
      maxTotalBytes: 34 * 1024 * 1024,
      maxSessionBytes: 2 * 1024 * 1024
    })
    await session(small)
    await expect(small.createSession()).rejects.toThrow('runtime_timing_vault_capacity')
  })
  it('forgets a sealed matching conversation across a reopened host while preserving other accounts and conversations', async () => {
    const directory = await root(),
      first = await opened(directory)
    const a = await session(first),
      b = await session(first),
      c = await session(first)
    observe(a.evidence, 'account-A', 'customer-A')
    observe(b.evidence, 'account-A', 'customer-B')
    observe(c.evidence, 'account-B', 'customer-A')
    for (const item of [a, b, c])
      await first.finishSession(item.journal, () => item.evidence.export())
    const second = await opened(directory)
    await second.forgetScope(scope('account-A', 'customer-A'))
    await expect(access(a.journal.directory)).rejects.toBeDefined()
    await access(b.journal.directory)
    await access(c.journal.directory)
    await second.forgetScope(scope('account-A'))
    await expect(access(b.journal.directory)).rejects.toBeDefined()
    await access(c.journal.directory)
  })
  it('makes a durable forget fence invalidate an older writer before it can log a newly encountered matching scope', async () => {
    const directory = await root(),
      first = await opened(directory),
      f = await session(first),
      second = await opened(directory)
    await second.forgetScope(scope())
    observe(f.evidence)
    await f.journal.drain()
    expect(f.journal.health()).toMatchObject({ records: 0, reason: 'journal_write_failed' })
    expect(await readFile(join(f.journal.directory, 'events.private.jsonl'), 'utf8')).not.toContain(
      'synthetic-source'
    )
    await expect(f.evidence.export()).rejects.toThrow('runtime_evidence_incomplete')
  })
  it('expires historical and its own live capture at 90 days using a controlled host clock, without touching fresh sessions', async () => {
    let time = Date.now()
    const directory = await root(),
      vault = await opened(directory, {}, () => time),
      old = await session(vault)
    observe(old.evidence)
    await vault.finishSession(old.journal, () => old.evidence.export())
    time += 89 * 86400000
    const live = await session(vault)
    await vault.pruneExpired()
    await access(old.journal.directory)
    time += 86400000
    await vault.pruneExpired()
    await expect(access(old.journal.directory)).rejects.toBeDefined()
    await access(live.journal.directory)
    time += 90 * 86400000
    await vault.pruneExpired()
    await expect(access(live.journal.directory)).rejects.toBeDefined()
    expect(live.journal.offer({ late: true })).toBe(false)
  })
  it('retains failed cleanup as unavailable, never recursively deletes an unexpected file, and succeeds after repair', async () => {
    const directory = await root(),
      vault = await opened(directory),
      f = await session(vault)
    observe(f.evidence)
    await vault.finishSession(f.journal, () => f.evidence.export())
    const unknown = join(f.journal.directory, 'unrelated.private.json')
    await writeFile(unknown, 'synthetic unrelated data')
    await expect(vault.forgetScope(scope())).rejects.toThrow('runtime_timing_vault_cleanup_failed')
    expect(await readFile(unknown, 'utf8')).toBe('synthetic unrelated data')
    await expect(vault.assertReadable(f.journal.sessionId)).rejects.toThrow()
    await rm(unknown)
    await vault.forgetScope(scope())
    await expect(access(f.journal.directory)).rejects.toBeDefined()
  })
})
