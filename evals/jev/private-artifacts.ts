import { join, dirname } from 'node:path'
import { z } from 'zod'
import { Hash, Id } from '../../src/shared/contracts/identity'
import { hashContext } from '../../src/core/reply/hashes'
import { BlindReviewArtifactSchema } from './blind-review'
import { MAX_PRIVATE_JSON_BYTES, writePrivateJson } from '../memory/private-files'

const Source = z.strictObject({
  executionId: z.uuid(),
  runId: Id,
  datasetId: Id,
  split: z.enum(['calibration', 'holdout']),
  inputHash: Hash
})
const Part = z
  .strictObject({
    assignmentId: z.uuid(),
    caseId: Id,
    arm: z.enum(['A', 'B', 'C']),
    artifactHash: Hash,
    file: z.string().regex(/^[a-f0-9-]{36}\.private\.json$/)
  })
  .refine((p) => p.file === `${p.assignmentId}.private.json`, 'Artifact file must match assignment')
const Body = z.strictObject({
  protocol: z.literal('jev-replay-artifacts-v1'),
  source: Source,
  parts: z.array(Part).min(3).max(6000)
})
export const JevReplayArtifactManifestSchema = Body.extend({ manifestHash: Hash })
type Artifact = z.infer<typeof BlindReviewArtifactSchema>
export type JevReplayArtifactSource = z.infer<typeof Source>
type ReadPrivate = (path: string, maximum?: number) => Promise<unknown>
type ReadPrivateParts = (
  paths: string[],
  maximum: number,
  parse: (value: unknown, index: number) => Artifact
) => Promise<Artifact[]>

/** Each arm was already saved and sealed by the executor. A manifest avoids a
 * late aggregate-file overflow without lowering the frozen sample count. */
export async function writeJevReplayArtifactIndex(
  directory: string,
  source: JevReplayArtifactSource,
  artifacts: readonly Artifact[]
): Promise<{ file: string; aggregateAvailable: boolean }> {
  const plan = planJevReplayArtifactIndex(source, artifacts)
  const file = 'artifacts.manifest.private.json'
  await writePrivateJson(join(directory, file), plan.manifest)
  if (plan.aggregateAvailable)
    await writePrivateJson(join(directory, 'artifacts.private.json'), artifacts)
  return { file, aggregateAvailable: plan.aggregateAvailable }
}

export function planJevReplayArtifactIndex(
  source: JevReplayArtifactSource,
  artifacts: readonly Artifact[],
  maximumBytes = MAX_PRIVATE_JSON_BYTES
): {
  manifest: z.infer<typeof JevReplayArtifactManifestSchema>
  aggregateAvailable: boolean
  aggregateBytes: number
} {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > MAX_PRIVATE_JSON_BYTES
  )
    throw new Error('invalid_artifact_index_budget')
  const parsed = z.array(BlindReviewArtifactSchema).max(6000).parse(artifacts)
  if (hashContext(parsed) !== hashContext(artifacts)) throw new Error('artifact_index_changed')
  const body = Body.parse({
    protocol: 'jev-replay-artifacts-v1',
    source,
    parts: artifacts.map((a) => ({
      assignmentId: a.assignmentId,
      caseId: a.caseId,
      arm: a.arm,
      artifactHash: hashContext(a),
      file: `${a.assignmentId}.private.json`
    }))
  })
  const ids = new Set(body.parts.map((p) => p.assignmentId))
  const pairs = new Set(body.parts.map((p) => `${p.caseId}\0${p.arm}`))
  if (
    ids.size !== artifacts.length ||
    pairs.size !== artifacts.length ||
    artifacts.some((a) => a.runId !== source.runId)
  )
    throw new Error('artifact_index_scope_invalid')
  // The array is retained for compatible small runs. It is never required to
  // complete a large run; callers can always pass the manifest to blind/import.
  const encoded = JSON.stringify(artifacts, null, 2) + '\n'
  const aggregateBytes = Buffer.byteLength(encoded, 'utf8')
  return {
    manifest: { ...body, manifestHash: hashContext(body) },
    aggregateAvailable: aggregateBytes <= maximumBytes,
    aggregateBytes
  }
}

/** The reader still delegates every piece to the exact same bounded ACL/path
 * checks as ordinary CLI inputs. It never follows nested manifests or links. */
export async function readJevReplayArtifacts(
  path: string,
  readPrivate: ReadPrivate,
  expected: Omit<JevReplayArtifactSource, 'executionId'>,
  readPrivateParts?: ReadPrivateParts
): Promise<Artifact[]> {
  const raw = await readPrivate(path, MAX_PRIVATE_JSON_BYTES)
  if (Array.isArray(raw)) return z.array(BlindReviewArtifactSchema).max(6000).parse(raw)
  const manifest = JevReplayArtifactManifestSchema.parse(raw)
  const { manifestHash, ...body } = manifest
  if (
    hashContext(raw) !== hashContext(manifest) ||
    hashContext(body) !== manifestHash ||
    manifest.source.runId !== expected.runId ||
    manifest.source.datasetId !== expected.datasetId ||
    manifest.source.split !== expected.split ||
    manifest.source.inputHash !== expected.inputHash
  )
    throw new Error('artifact_manifest_changed')
  const ids = new Set<string>(),
    pairs = new Set<string>()
  for (const part of manifest.parts) {
    const pair = `${part.caseId}\0${part.arm}`
    if (ids.has(part.assignmentId) || pairs.has(pair))
      throw new Error('artifact_manifest_duplicate')
    ids.add(part.assignmentId)
    pairs.add(pair)
  }
  const parsePart = (original: unknown, index: number): Artifact => {
    const part = manifest.parts[index]
    if (!part) throw new Error('artifact_manifest_parts_incomplete')
    const artifact = BlindReviewArtifactSchema.parse(original)
    if (
      hashContext(original) !== hashContext(artifact) ||
      hashContext(artifact) !== part.artifactHash ||
      artifact.runId !== expected.runId ||
      artifact.assignmentId !== part.assignmentId ||
      artifact.caseId !== part.caseId ||
      artifact.arm !== part.arm
    )
      throw new Error('artifact_manifest_piece_changed')
    return artifact
  }
  if (readPrivateParts) {
    // Parse immediately after each read, before retaining raw later pieces.
    const artifacts = await readPrivateParts(
      manifest.parts.map((part) => join(dirname(path), part.file)),
      MAX_PRIVATE_JSON_BYTES,
      parsePart
    )
    if (artifacts.length !== manifest.parts.length)
      throw new Error('artifact_manifest_parts_incomplete')
    // An injected reader must not be able to skip the manifest's exact-content
    // checks by ignoring the early parser supplied to it.
    return artifacts.map(parsePart)
  }
  const artifacts: Artifact[] = []
  for (const [index, part] of manifest.parts.entries()) {
    const original = await readPrivate(join(dirname(path), part.file), MAX_PRIVATE_JSON_BYTES)
    artifacts.push(parsePart(original, index))
  }
  return artifacts
}
