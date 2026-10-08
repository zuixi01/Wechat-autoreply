import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Postgres } from '../../server/src/database/postgres'
import { EnterpriseLearningWorkerAuthority } from '../../server/src/learning/learning-worker-authority'
import {
  EnterpriseMemoryReplay,
  EnterpriseMemoryReplayInputSchema
} from '../../server/src/learning/learning-memory-replay'
import {
  createPrivateOutput,
  readPrivateJson,
  writePrivateJson
} from '../../evals/memory/private-files'
import { protectPrivateDirectory } from '../../src/core/persistence/private-backup-directory'

// Isolated engineering child process only. No provider credentials or business labels are used.
async function main(): Promise<void> {
  const [mode, source, output] = process.argv.slice(2)
  if (
    !['collect', 'resume'].includes(mode) ||
    !source ||
    !output ||
    !process.env.AUTOREPLY_POSTGRES_TEST_REPORT
  )
    throw new Error('fixture_only')
  const databaseUrl = new URL(process.env.AUTOREPLY_REPLAY_FIXTURE_DATABASE_URL ?? 'about:blank')
  const loopback = new URL(process.env.AUTOREPLY_REPLAY_FIXTURE_LOOPBACK ?? 'about:blank')
  if (
    databaseUrl.hostname !== '127.0.0.1' ||
    !/^replay_worker_[a-f0-9]{32}$/.test(databaseUrl.username) ||
    loopback.hostname !== '127.0.0.1' ||
    loopback.protocol !== 'http:'
  )
    throw new Error('isolated_fixture_required')
  const reference = z.uuid().parse(process.env.AUTOREPLY_REPLAY_FIXTURE_REFERENCE)
  const out = await createPrivateOutput(output)
  await protectPrivateDirectory(out)
  const database = new Postgres(databaseUrl.href)
  let runId = mode === 'resume' ? z.uuid().parse(source) : ''
  const collector = new EnterpriseMemoryReplay(
    database,
    new EnterpriseLearningWorkerAuthority(database),
    {
      text: {
        baseUrl: 'https://synthetic.invalid/v1/',
        model: 'synthetic-text',
        expectedModel: 'synthetic-text',
        apiKey: 'synthetic-text-key'
      },
      jevApiKey: 'synthetic-jev-key',
      workerId: 'synthetic-process-' + randomUUID(),
      onRun: async (id) => {
        runId = id
      },
      fetch: (url, init) => {
        const address = String(url)
        if (
          !address.startsWith('https://api.typesafe.ai/') &&
          !address.startsWith('https://synthetic.invalid/v1/')
        )
          throw new Error('loopback_only')
        return fetch(
          new URL(
            address.startsWith('https://api.typesafe.ai/') ? '/jev' : '/v1/chat/completions',
            loopback
          ),
          init
        )
      }
    }
  )
  try {
    if (mode === 'collect') {
      const input = EnterpriseMemoryReplayInputSchema.parse(await readPrivateJson(source))
      if (input.origin !== 'synthetic') throw new Error('synthetic_only')
      let saved = false
      try {
        await collector.collect(reference, input, undefined, async (receipt) => {
          await writePrivateJson(join(out, 'receipt.private.json'), receipt)
          saved = true
          throw new Error('synthetic_restart_after_first_group')
        })
        throw new Error('expected_incomplete')
      } catch (error) {
        if (
          !saved ||
          !(error instanceof Error) ||
          error.message !== 'synthetic_restart_after_first_group'
        )
          throw error
      }
      await writePrivateJson(join(out, 'status.json'), {
        state: 'incomplete',
        runId,
        processId: process.pid,
        businessVerified: false
      })
    } else {
      const packet = await collector.resume(reference, runId)
      await writePrivateJson(join(out, 'packet.private.json'), packet)
      await writePrivateJson(join(out, 'status.json'), {
        state: 'completed',
        runId,
        processId: process.pid,
        businessVerified: false
      })
    }
    process.stdout.write('Synthetic replay child finished.\n')
  } finally {
    await collector.drain()
    await database.close()
  }
}
main().catch(() => {
  process.stderr.write('Synthetic replay child failed.\n')
  process.exitCode = 1
})
