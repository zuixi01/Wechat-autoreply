import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { hashContext } from '../../src/core/reply/hashes'
import {
  JEV_REPLAY_PROTOCOL,
  JEV_BASELINE_ROUTE,
  type JevReplayArmArtifact
} from '../../evals/jev/replay'
import {
  planJevReplayArtifactIndex,
  readJevReplayArtifacts
} from '../../evals/jev/private-artifacts'
import { MAX_PRIVATE_JSON_BYTES } from '../../evals/memory/private-files'

function fixture() {
  const source = {
    executionId: randomUUID(),
    runId: 'run-A',
    datasetId: 'dataset-A',
    split: 'calibration' as const,
    inputHash: 'a'.repeat(64)
  }
  const artifacts = (['A', 'B', 'C'] as const).map((arm) => ({
    runId: source.runId,
    caseId: 'case-A',
    arm,
    assignmentId: randomUUID(),
    protocol: JEV_REPLAY_PROTOCOL,
    baselineRoute: JEV_BASELINE_ROUTE,
    inputHash: 'b'.repeat(64),
    executionPlanHash: 'c'.repeat(64),
    snapshotHash: 'd'.repeat(64),
    status: 'handoff' as const,
    wouldRelease: false,
    releaseAuthorized: false as const,
    factsVerified: false,
    intents: [],
    reasons: ['explicit_human_request'],
    draft: null,
    pre: null,
    post: null,
    stages: [],
    latencyMs: 0,
    otherProcessingMs: 0,
    attempts: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    usageSource: 'recorded_http_attempts' as const,
    billedCostMicros: null
  }))
  const index = planJevReplayArtifactIndex(source, artifacts)
  const path = join('.local', 'private-test', 'artifacts.manifest.private.json')
  const files = new Map<string, unknown>([
    [path, index.manifest],
    ...artifacts.map(
      (a) =>
        [join('.local', 'private-test', `${a.assignmentId}.private.json`), a] as [string, unknown]
    )
  ])
  const read = vi.fn(async (file: string, maximum?: number) => {
    if (maximum !== MAX_PRIVATE_JSON_BYTES) throw new Error('unexpected_read_budget')
    if (!files.has(file)) throw new Error('private_input_missing')
    return structuredClone(files.get(file))
  })
  return { source, artifacts, index, path, files, read }
}
function reseal(manifest: ReturnType<typeof fixture>['index']['manifest']) {
  const body = { protocol: manifest.protocol, source: manifest.source, parts: manifest.parts }
  return { ...body, manifestHash: hashContext(body) }
}
describe('private Jev artifact index', () => {
  it('keeps the complete assignment set when the aggregate exceeds its byte budget', () => {
    const f = fixture()
    const plan = planJevReplayArtifactIndex(f.source, f.artifacts, 1)
    expect(plan.aggregateAvailable).toBe(false)
    expect(plan.manifest.parts).toHaveLength(3)
    expect(plan.aggregateBytes).toBe(Buffer.byteLength(JSON.stringify(f.artifacts, null, 2) + '\n'))
    expect(
      planJevReplayArtifactIndex(f.source, f.artifacts, plan.aggregateBytes).aggregateAvailable
    ).toBe(true)
    expect(
      planJevReplayArtifactIndex(f.source, f.artifacts, plan.aggregateBytes - 1).aggregateAvailable
    ).toBe(false)
    expect(plan.manifest.parts.map((p) => p.arm)).toEqual(['A', 'B', 'C'])
    for (const maximum of [0, 1.5, Infinity, MAX_PRIVATE_JSON_BYTES + 1])
      expect(() => planJevReplayArtifactIndex(f.source, f.artifacts, maximum)).toThrow()
  })
  it('reads every opaque piece with the same bounded private reader and validates its exact contents', async () => {
    const f = fixture()
    expect(await readJevReplayArtifacts(f.path, f.read, f.source)).toEqual(f.artifacts)
    expect(f.read.mock.calls).toHaveLength(4)
    expect(f.read.mock.calls.every((call) => call[1] === MAX_PRIVATE_JSON_BYTES)).toBe(true)
    expect(JSON.stringify(f.index.manifest)).not.toContain('explicit_human_request')
  })
  it('retains compatibility with complete array files without registering any central evidence', async () => {
    const f = fixture()
    f.files.set(f.path, f.artifacts)
    expect(await readJevReplayArtifacts(f.path, f.read, f.source)).toEqual(f.artifacts)
    expect(f.read).toHaveBeenCalledTimes(1)
  })
  it('validates batched parts immediately and rechecks outputs even if an injected reader ignores parsing', async () => {
    const f = fixture()
    const batch = vi.fn(
      async (
        paths: string[],
        maximum: number,
        parse: (raw: unknown, index: number) => JevReplayArmArtifact
      ) => {
        expect(maximum).toBe(MAX_PRIVATE_JSON_BYTES)
        return paths.map((path, index) => parse(structuredClone(f.files.get(path)), index))
      }
    )
    expect(await readJevReplayArtifacts(f.path, f.read, f.source, batch)).toEqual(f.artifacts)
    expect(batch).toHaveBeenCalledOnce()
    expect(f.read).toHaveBeenCalledTimes(1)
    const ignoredParser = async () => [
      { ...f.artifacts[0], reasons: ['edited'] },
      ...f.artifacts.slice(1)
    ]
    await expect(readJevReplayArtifacts(f.path, f.read, f.source, ignoredParser)).rejects.toThrow(
      'artifact_manifest_piece_changed'
    )
    await expect(readJevReplayArtifacts(f.path, f.read, f.source, async () => [])).rejects.toThrow(
      'artifact_manifest_parts_incomplete'
    )
    f.files.set(join('.local', 'private-test', f.index.manifest.parts[0].file), {
      ...f.artifacts[0],
      reasons: ['edited']
    })
    await expect(readJevReplayArtifacts(f.path, f.read, f.source, batch)).rejects.toThrow(
      'artifact_manifest_piece_changed'
    )
  })
  it.each(['runId', 'datasetId', 'split', 'inputHash'] as const)(
    'rejects changed frozen source %s before reading parts',
    async (key) => {
      const f = fixture(),
        m = structuredClone(f.index.manifest)
      if (key === 'split') m.source.split = 'holdout'
      else if (key === 'inputHash') m.source.inputHash = 'f'.repeat(64)
      else m.source[key] = 'different'
      f.files.set(f.path, reseal(m))
      await expect(readJevReplayArtifacts(f.path, f.read, f.source)).rejects.toThrow(
        'artifact_manifest_changed'
      )
      expect(f.read).toHaveBeenCalledTimes(1)
    }
  )
  it('rejects self-inconsistent hashes, missing pieces and rewritten piece contents', async () => {
    const f = fixture()
    f.files.set(f.path, { ...f.index.manifest, manifestHash: '0'.repeat(64) })
    await expect(readJevReplayArtifacts(f.path, f.read, f.source)).rejects.toThrow()
    f.files.set(f.path, f.index.manifest)
    const piece = f.index.manifest.parts[0]
    const path = join('.local', 'private-test', piece.file)
    f.files.delete(path)
    await expect(readJevReplayArtifacts(f.path, f.read, f.source)).rejects.toThrow(
      'private_input_missing'
    )
    f.files.set(path, { ...f.artifacts[0], reasons: ['different_reason'] })
    await expect(readJevReplayArtifacts(f.path, f.read, f.source)).rejects.toThrow(
      'artifact_manifest_piece_changed'
    )
  })
  it('rejects traversal, nested manifests and reassigned filenames even after resealing', async () => {
    for (const file of [
      '../outside.private.json',
      'nested/part.private.json',
      `${randomUUID()}.private.json`
    ]) {
      const f = fixture(),
        m = structuredClone(f.index.manifest)
      m.parts[0].file = file
      f.files.set(f.path, reseal(m))
      await expect(readJevReplayArtifacts(f.path, f.read, f.source)).rejects.toThrow()
      expect(f.read).toHaveBeenCalledTimes(1)
    }
    const f = fixture()
    f.files.set(join('.local', 'private-test', f.index.manifest.parts[0].file), f.index.manifest)
    await expect(readJevReplayArtifacts(f.path, f.read, f.source)).rejects.toThrow()
  })
  it('rejects duplicate case/arm pairs and duplicate assignments instead of treating them as completeness', async () => {
    const f = fixture()
    expect(() =>
      planJevReplayArtifactIndex(f.source, [f.artifacts[0], f.artifacts[0], f.artifacts[2]])
    ).toThrow()
    const m = structuredClone(f.index.manifest)
    m.parts[1] = m.parts[0]
    f.files.set(f.path, reseal(m))
    await expect(readJevReplayArtifacts(f.path, f.read, f.source)).rejects.toThrow(
      'artifact_manifest_duplicate'
    )
  })
})
