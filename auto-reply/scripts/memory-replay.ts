import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  MemoryReplayInputSchema,
  replayMemoryCases,
  adjudicateMemoryReplay,
  replayHash
} from '../evals/memory/replay'
import { replayHttpGenerator } from '../evals/memory/replay-http'
import {
  createPrivateOutput,
  readPrivateJson,
  writePrivateJson
} from '../evals/memory/private-files'
import { adjudicateEnterpriseMemoryReplay } from '../server/src/learning/learning-memory-replay'

async function main(): Promise<void> {
  const [mode, ...args] = process.argv.slice(2)
  if (mode === '--help' || (args.length === 1 && args[0] === '--help')) {
    process.stdout.write(
      'memory:replay INPUT OUTPUT_DIRECTORY\nmemory:adjudicate PACKET LABELS OUTPUT_DIRECTORY\nPrivate paths only; replay uses MEMORY_REPLAY_API_KEY, consumes up to 3 model calls per holdout case, and never labels or learns.\n'
    )
    return
  }
  if (mode === 'adjudicate' && args.length === 3) {
    const [packet, labels] = await Promise.all([readPrivateJson(args[0]), readPrivateJson(args[1])])
    let dataset: ReturnType<typeof adjudicateMemoryReplay>
    try {
      dataset =
        typeof packet === 'object' &&
        packet !== null &&
        'schema' in packet &&
        packet.schema === 'autoreply-enterprise-memory-replay-v1'
          ? adjudicateEnterpriseMemoryReplay(packet, labels)
          : adjudicateMemoryReplay(packet, labels)
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      if (
        !['missing_adjudication', 'missing_metered_usage', 'missing_metered_cost'].includes(reason)
      )
        throw error
      const out = await createPrivateOutput(args[2])
      await writePrivateJson(join(out, 'status.json'), {
        assessment: { status: 'insufficient', reasons: [reason] },
        businessVerified: false
      })
      process.stdout.write(
        'Adjudication evidence insufficient; no labelled dataset or business approval produced.\n'
      )
      process.exitCode = 2
      return
    }
    const out = await createPrivateOutput(args[2])
    await writePrivateJson(join(out, 'labelled.json'), dataset)
    process.stdout.write(
      'Adjudication imported; run memory:evaluate separately. No business verdict or publication grant issued.\n'
    )
    return
  }
  if (mode !== 'replay' || args.length !== 2) throw new Error('usage')
  const input = MemoryReplayInputSchema.parse(await readPrivateJson(args[0]))
  const generate = replayHttpGenerator(input.model, process.env.MEMORY_REPLAY_API_KEY ?? '')
  const out = await createPrivateOutput(args[1])
  const journal = join(out, 'requests.jsonl')
  try {
    const packet = await replayMemoryCases(input, async (system, question, requestId) => {
      await appendFile(
        journal,
        JSON.stringify({
          requestId,
          state: 'dispatched',
          at: Date.now(),
          requestHash: replayHash({ system, question })
        }) + '\n'
      )
      try {
        const result = await generate(system, question, requestId)
        await appendFile(
          journal,
          JSON.stringify({
            requestId,
            state: 'reported',
            at: Date.now(),
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            costUsd: null
          }) + '\n'
        )
        return result
      } catch (error) {
        await appendFile(
          journal,
          JSON.stringify({
            requestId,
            state: 'failed_usage_unknown',
            at: Date.now(),
            costUsd: null
          }) + '\n'
        )
        throw error
      }
    })
    await writePrivateJson(join(out, 'packet.private.json'), packet)
    await writePrivateJson(join(out, 'blind.json'), packet.blind)
    await writePrivateJson(join(out, 'status.json'), {
      status: 'awaiting_independent_labels_and_metered_costs',
      cases: input.cases.length,
      businessVerified: false
    })
    process.stdout.write(
      `Replay collected: cases=${input.cases.length}, arms=3. Independent labels and observed costs required.\n`
    )
  } catch (error) {
    await writePrivateJson(join(out, 'status.json'), {
      status: 'incomplete',
      businessVerified: false,
      usageReconciliationRequired: true
    })
    throw error
  }
}
main().catch(() => {
  process.stderr.write(
    'Memory replay/import failed. Verify private inputs, strict evidence, model configuration and a fresh .local output directory. No input bodies or credentials are printed.\n'
  )
  process.exitCode = 1
})
