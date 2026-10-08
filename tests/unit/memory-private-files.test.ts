import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, stat, rm, chmod } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import * as privateFiles from '../../evals/memory/private-files'
import { MemoryReplayInputSchema, replayMemoryCases } from '../../evals/memory/replay'
import { EnterpriseMemoryReplayInputSchema } from '../../server/src/learning/learning-memory-replay'
import {
  protectPrivateDirectory,
  verifyPrivatePaths
} from '../../src/core/persistence/private-backup-directory'

let directory: string
beforeAll(async () => {
  const root = resolve('.local/tests')
  await mkdir(root, { recursive: true })
  directory = await mkdtemp(join(root, 'memory-private-'))
  await protectPrivateDirectory(directory)
})
afterAll(async () => {
  if (!directory) return
  const root = resolve('.local/tests'),
    part = relative(root, directory)
  if (!part || part.startsWith('..') || isAbsolute(part)) throw new Error('unsafe_test_cleanup')
  await rm(directory, { recursive: true, force: true })
})

describe('usable private memory evidence artifacts', () => {
  it('rejects an actual UTF-8 packet over the reader limit before creating a file', async () => {
    expect(privateFiles.writePrivateJson).toBeTypeOf('function')
    const file = join(directory, 'oversized.json')
    // 23 Mi Chinese characters exceed the real 64 MiB import cap; the string character count
    // alone would incorrectly admit this output. This is synthetic, with no business text.
    await expect(
      privateFiles.writePrivateJson(file, { text: '汉'.repeat(23 * 1024 * 1024) })
    ).rejects.toThrow('private_output_too_large')
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('round-trips a permitted private output, refuses overwrites and requires a private directory', async () => {
    expect(privateFiles.writePrivateJson).toBeTypeOf('function')
    const file = join(directory, 'packet.json'),
      data = { provenance: 'synthetic', text: '合成测试' }
    await privateFiles.writePrivateJson(file, data)
    await verifyPrivatePaths(directory, [file])
    expect(await privateFiles.readPrivateJson(file)).toEqual(data)
    await expect(privateFiles.writePrivateJson(file, { replaced: true })).rejects.toMatchObject({
      code: 'EEXIST'
    })
    await expect(
      privateFiles.writePrivateJson(resolve('evals/memory/disallowed-output.json'), data)
    ).rejects.toThrow('local_output_required')
  })

  it('refuses an unprotected output directory before writing any evidence body', async () => {
    const unprotected = join(directory, 'unprotected')
    await mkdir(unprotected)
    if (process.platform !== 'win32') await chmod(unprotected, 0o755)
    const file = join(unprotected, 'refused.json')
    await expect(privateFiles.writePrivateJson(file, { provenance: 'synthetic' })).rejects.toThrow(
      'private_backup_permissions_invalid'
    )
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects the combined learning and holdout case overflow before generating either replay', async () => {
    const raw = JSON.parse(
      await readFile(resolve('evals/memory/fixtures/replay.synthetic.json'), 'utf8')
    )
    const count = 100000 - raw.sources.length
    raw.sources.push(
      ...Array.from({ length: count }, (_, i) => ({
        caseId: `capacity-source-${i}`,
        conversationId: `capacity-source-${i}`,
        split: 'learn',
        label: { origin: 'synthetic', blinded: false, labelledAt: 1 }
      }))
    )
    expect(MemoryReplayInputSchema.safeParse(raw).success).toBe(false)
    let calls = 0
    await expect(
      replayMemoryCases(raw, async () => {
        calls++
        return { text: 'synthetic', inputTokens: 1, outputTokens: 1 }
      })
    ).rejects.toThrow('dataset_case_limit_exceeded')
    expect(calls).toBe(0)
    const enterprise = {
      version: 1,
      datasetId: 'synthetic-capacity',
      origin: 'synthetic',
      rubricRef: 'synthetic-rubric',
      maxRequests: raw.cases.length * 9,
      backgroundCostUsd: 0,
      legacy: raw.legacy,
      sources: raw.sources,
      cases: raw.cases.map(
        (c: { caseId: string; conversationId: string; category: string; question: string }) => ({
          caseId: c.caseId,
          conversationId: c.conversationId,
          category: c.category,
          inbound: [c.question]
        })
      )
    }
    expect(() => EnterpriseMemoryReplayInputSchema.parse(enterprise)).toThrow(
      'dataset_case_limit_exceeded'
    )
  })
})
