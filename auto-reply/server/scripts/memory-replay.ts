import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  protectPrivateDirectory,
  verifyPrivatePaths
} from '../../src/core/persistence/private-backup-directory'
import { z } from 'zod'
import { Postgres } from '../src/database/postgres'
import { EnterpriseLearningWorkerAuthority } from '../src/learning/learning-worker-authority'
import { EnterpriseEvaluationEvidence } from '../src/learning/learning-evaluation-evidence'
import { EnterpriseForegroundEvidence } from '../src/learning/learning-foreground-evidence'
import {
  EnterpriseMemoryReplay,
  EnterpriseMemoryReplayInputSchema,
  type EnterpriseMemoryReplayPacket
} from '../src/learning/learning-memory-replay'
import {
  createPrivateOutput,
  readPrivateJson,
  writePrivateJson
} from '../../evals/memory/private-files'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(
      'memory:replay:enterprise INPUT OUTPUT_DIRECTORY\nmemory:replay:enterprise resume RUN_ID OUTPUT_DIRECTORY\nmemory:replay:enterprise verify RUN_ID PACKET OUTPUT_DIRECTORY\nmemory:replay:enterprise verify-foreground RUN_ID PACKET VAULT_ROOT SESSION_ID OUTPUT_DIRECTORY [reviewable|confirmed_sent]\nmemory:replay:enterprise adjudicate-foreground RUN_ID PACKET LABELS VAULT_ROOT SESSION_ID OUTPUT_DIRECTORY [reviewable|confirmed_sent]\nUses the authenticated learning worker database login and MEMORY_REPLAY_WORKER_REFERENCE. Verify only reads completed server evidence and needs MEMORY_REPLAY_DATABASE_URL and MEMORY_REPLAY_WORKER_REFERENCE; it never resumes or calls a model. Foreground modes reread the original sealed private journal and authenticate the original database run; exported verification JSON is never accepted as a credential. Adjudication preserves original freeze, replies, usage, costs and label origins, deriving only actual foreground timing. Native and business verification remain false. Collection requires MEMORY_REPLAY_TEXT_BASE_URL, MEMORY_REPLAY_TEXT_MODEL, MEMORY_REPLAY_TEXT_EXPECTED_MODEL, MEMORY_REPLAY_TEXT_API_KEY and MEMORY_REPLAY_JEV_API_KEY.\nConsumes up to 9 provider requests per case through the production Jev/text/audit pipeline; retains fees in the shared account ledger. Resume reads the original frozen server checkpoint, preserves paid stages and assignments, and requires a fresh private output directory. Exit 2 means waiting for the next UTC budget bucket, or insufficient independent adjudication/usage/cost evidence. Independent labels and metered costs remain required.\n'
    )
    return
  }
  if (args[0] === 'verify-foreground' || args[0] === 'adjudicate-foreground') {
    const adjudicate = args[0] === 'adjudicate-foreground'
    const length = adjudicate ? 7 : 6
    if (args.length !== length && args.length !== length + 1) throw new Error('usage')
    const id = z.uuid().parse(args[1])
    const endpoint = z.enum(['reviewable', 'confirmed_sent']).parse(args[length] ?? 'reviewable')
    const journalReference = {
      vaultRoot: z
        .string()
        .min(1)
        .parse(args[adjudicate ? 4 : 3]),
      sessionId: z.uuid().parse(args[adjudicate ? 5 : 4])
    }
    const reference = z.uuid().parse(process.env.MEMORY_REPLAY_WORKER_REFERENCE)
    const database = new Postgres(z.string().min(1).parse(process.env.MEMORY_REPLAY_DATABASE_URL))
    try {
      const evidence = new EnterpriseForegroundEvidence(
        database,
        new EnterpriseLearningWorkerAuthority(database)
      )
      const packet = await readPrivateJson(args[2])
      let verification: Awaited<ReturnType<EnterpriseForegroundEvidence['verify']>>
      let dataset:
        | Awaited<ReturnType<EnterpriseForegroundEvidence['adjudicate']>>['dataset']
        | undefined
      try {
        if (adjudicate) {
          const result = await evidence.adjudicate(
            reference,
            id,
            packet,
            await readPrivateJson(args[3]),
            journalReference,
            endpoint
          )
          verification = result.verification
          dataset = result.dataset
        } else {
          verification = await evidence.verify(reference, id, packet, journalReference, endpoint)
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : ''
        if (
          !adjudicate ||
          !['missing_adjudication', 'missing_metered_usage', 'missing_metered_cost'].includes(
            reason
          )
        )
          throw error
        const out = await createPrivateOutput(args[length - 1])
        await writePrivateJson(join(out, 'status.json'), {
          assessment: { status: 'insufficient', reasons: [reason] },
          businessVerified: false,
          nativePlatformVerified: false
        })
        process.stdout.write(
          'Foreground adjudication evidence insufficient; no labelled dataset or business approval produced.\n'
        )
        process.exitCode = 2
        return
      }
      const out = await createPrivateOutput(args[length - 1])
      await writePrivateJson(join(out, 'foreground-verification.private.json'), verification)
      if (dataset) await writePrivateJson(join(out, 'labelled.json'), dataset)
      process.stdout.write(
        adjudicate
          ? 'Foreground adjudication imported; run memory:evaluate separately. Native and business verification remain false.\n'
          : 'Foreground evidence verified read-only. Native platform and independent business verification remain false.\n'
      )
    } finally {
      await database.close()
    }
    return
  }
  if (args[0] === 'verify') {
    if (args.length !== 4) throw new Error('usage')
    const id = z.uuid().parse(args[1])
    const reference = z.uuid().parse(process.env.MEMORY_REPLAY_WORKER_REFERENCE)
    const database = new Postgres(z.string().min(1).parse(process.env.MEMORY_REPLAY_DATABASE_URL))
    try {
      const evidence = new EnterpriseEvaluationEvidence(
        database,
        new EnterpriseLearningWorkerAuthority(database)
      )
      const result = await evidence.verify(reference, id, await readPrivateJson(args[2]))
      const out = await createPrivateOutput(args[3])
      await protectPrivateDirectory(out)
      await verifyPrivatePaths(out, [])
      const output = join(out, 'frozen-verification.private.json')
      await writePrivateJson(output, result)
      await verifyPrivatePaths(out, [output])
      process.stdout.write(
        'Completed server freeze verified read-only. Foreground evidence and independent business review remain required.\n'
      )
    } finally {
      await database.close()
    }
    return
  }
  const resume = args[0] === 'resume'
  if (args.length !== (resume ? 3 : 2)) throw new Error('usage')
  const resumeId = resume ? z.uuid().parse(args[1]) : undefined
  const input = resume
    ? undefined
    : EnterpriseMemoryReplayInputSchema.parse(await readPrivateJson(args[0]))
  const required = (name: string): string => z.string().min(1).parse(process.env[name])
  const reference = z.string().uuid().parse(required('MEMORY_REPLAY_WORKER_REFERENCE'))
  const options = {
    text: {
      baseUrl: required('MEMORY_REPLAY_TEXT_BASE_URL'),
      model: required('MEMORY_REPLAY_TEXT_MODEL'),
      expectedModel: required('MEMORY_REPLAY_TEXT_EXPECTED_MODEL'),
      apiKey: required('MEMORY_REPLAY_TEXT_API_KEY')
    },
    jevApiKey: required('MEMORY_REPLAY_JEV_API_KEY'),
    workerId: randomUUID()
  }
  const database = new Postgres(required('MEMORY_REPLAY_DATABASE_URL'))
  let collector: EnterpriseMemoryReplay | undefined
  let runId: string | undefined = resumeId
  const controller = new AbortController()
  const stop = (): void => controller.abort('operator_cancelled')
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    const out = await createPrivateOutput(args[resume ? 2 : 1])
    await protectPrivateDirectory(out)
    const write = async (name: string, value: unknown): Promise<void> => {
      await verifyPrivatePaths(out, [])
      await writePrivateJson(join(out, name), value)
    }
    const ledger = async (value: unknown): Promise<void> => {
      await verifyPrivatePaths(out, [])
      await appendFile(join(out, 'ledger.jsonl'), JSON.stringify(value) + '\n')
      await verifyPrivatePaths(out, [join(out, 'ledger.jsonl')])
    }
    collector = new EnterpriseMemoryReplay(
      database,
      new EnterpriseLearningWorkerAuthority(database),
      {
        ...options,
        onRun: async (id) => {
          runId = id
          await ledger({ runId, state: resume ? 'resumed' : 'started', at: Date.now() })
        }
      }
    )
    try {
      const receipt = async (
        r: EnterpriseMemoryReplayPacket['receipts'][number]
      ): Promise<void> => {
        await ledger({
          runId,
          assignmentId: r.assignmentId,
          modelCallRefs: r.modelCallRefs,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          costUsd: null,
          state: 'arm_completed',
          at: r.generatedAt
        })
      }
      const packet = resumeId
        ? await collector.resume(reference, resumeId, controller.signal, receipt)
        : await collector.collect(reference, input!, controller.signal, receipt)
      await ledger({
        runId,
        state: 'evidence_exported',
        completedArms: packet.receipts.length,
        at: Date.now()
      })
      await write('packet.private.json', packet)
      await write('blind.json', packet.blind)
      await write('status.json', {
        status: 'awaiting_independent_labels_and_metered_costs',
        cases: packet.input.cases.length,
        runId,
        businessVerified: false
      })
      process.stdout.write(
        `Enterprise replay ${resume ? 'resumed' : 'collected'}: cases=${packet.input.cases.length}, arms=3. Independent labels and metered costs required.\n`
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      const waiting = reason === 'evaluation_budget_waiting'
      await write('status.json', {
        status: waiting ? 'waiting_budget' : 'incomplete',
        runId,
        businessVerified: false,
        usageReconciliationRequired: !waiting,
        ...(waiting
          ? { retryAfterUtc: Math.floor(Date.now() / 86400000) * 86400000 + 86400000 }
          : {})
      })
      if (waiting) {
        process.stdout.write(
          'Enterprise replay paused at shared budget. Resume the same run in the next UTC bucket.\n'
        )
        process.exitCode = 2
        return
      }
      throw error
    }
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    await collector?.drain()
    await database.close()
  }
}
main().catch(() => {
  process.stderr.write(
    'Enterprise memory replay failed. Check private inputs, worker binding, frozen publication, provider configuration and shared account budget. No bodies, database URL or credentials are printed.\n'
  )
  process.exitCode = 1
})
