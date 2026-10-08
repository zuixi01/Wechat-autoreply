import { isAbsolute, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PrivateRuntimeTimingVault } from '../../src/core/persistence/runtime-timing-vault'
import { RuntimeTimingEvidence } from '../../src/core/agent/runtime-timing-evidence'
import { taskFixture } from './task'

// Isolated synthetic storage process only. No provider, customer API or platform is installed.
async function main(): Promise<void> {
  const [mode, requested] = process.argv.slice(2)
  const directory = resolve(requested ?? ''),
    part = relative(resolve('.local/reports'), directory)
  if (
    process.env.AUTOREPLY_RUNTIME_VAULT_FIXTURE !== '1' ||
    !['sealed', 'crash', 'live'].includes(mode) ||
    !part ||
    isAbsolute(part) ||
    part === '..' ||
    part.startsWith('..' + sep) ||
    !part.startsWith('runtime-vault-') ||
    !process.send
  )
    throw new Error('isolated_fixture_required')
  const vault = await PrivateRuntimeTimingVault.open(directory),
    journal = await vault.createSession(),
    evidence = new RuntimeTimingEvidence(journal),
    runtimeInstanceId = randomUUID()
  const observed = (sourceMessageId: string): void =>
    evidence.record({
      kind: 'agent',
      runtimeInstanceId,
      event: {
        stage: 'observed',
        identity: { ...taskFixture().task.identity, accountId: 'account-A' },
        conversationId: 'customer-A',
        sourceMessageId,
        atMs: performance.now()
      }
    })
  observed('synthetic-child-source')
  await journal.drain()
  if (journal.health().records !== 1) throw new Error('initial_record_not_saved')
  process.send({ kind: 'ready', pid: process.pid, sessionId: journal.sessionId })
  if (mode === 'sealed') {
    await vault.finishSession(journal, () => evidence.export())
    await vault.shutdown()
  } else {
    await new Promise<void>((resolve) => process.once('message', () => resolve()))
    if (mode === 'crash') process.exit(17)
    observed('synthetic-late-source')
    await journal.drain()
    await journal.close()
    await vault.finishSession(journal)
    process.send({
      kind: 'finished',
      pid: process.pid,
      records: journal.health().records,
      dropped: journal.health().dropped,
      reason: journal.health().reason
    })
    await vault.shutdown()
  }
  if (process.connected) process.disconnect()
}
void main().catch(() => {
  process.stderr.write('runtime_vault_fixture_failed\n')
  process.exitCode = 1
})
