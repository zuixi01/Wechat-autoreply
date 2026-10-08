import { parseArgs } from 'node:util'
import { createReadStream, existsSync } from 'node:fs'
import { lstat, realpath, open, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { LegacySettingsArchive } from '../src/core/persistence/legacy-settings-archive'
import { LegacyReviewInputSchema } from '../src/shared/contracts/legacy-migration'
import { prepareLegacyPublication } from '../server/src/admin/legacy-publication'

const equalPath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
async function readJson(file: string): Promise<unknown> {
  try {
    const path = resolve(file),
      info = await lstat(path)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size > 1024 * 1024 ||
      !equalPath(await realpath(path), path)
    )
      throw new Error('invalid')
    const chunks: Buffer[] = []
    let size = 0
    for await (const bytes of createReadStream(path)) {
      size += bytes.length
      if (size > 1024 * 1024) throw new Error('invalid')
      chunks.push(bytes)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('legacy_settings_input_invalid')
  }
}
async function parentChecked(path: string): Promise<void> {
  try {
    if (!equalPath(await realpath(dirname(path)), dirname(path))) throw new Error('invalid')
  } catch {
    throw new Error('legacy_settings_output_invalid')
  }
}
async function writeNew(file: string, value: unknown): Promise<{ bytes: number; sha256: string }> {
  const path = resolve(file)
  await parentChecked(path)
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, 'wx', 0o600)
  } catch (error) {
    throw new Error(
      (error as NodeJS.ErrnoException).code === 'EEXIST'
        ? 'legacy_settings_output_conflict'
        : 'legacy_settings_output_invalid'
    )
  }
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return { bytes: bytes.length, sha256: sha(bytes) }
}
const integer = (text: string | undefined, fallback: number, min: number, max: number): number => {
  const n = text === undefined ? fallback : /^\d+$/.test(text) ? Number(text) : NaN
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error('legacy_settings_arguments_invalid')
  return n
}
async function main(): Promise<void> {
  const { values, positionals, tokens } = parseArgs({
    allowPositionals: true,
    strict: true,
    tokens: true,
    options: {
      archive: { type: 'string' },
      workspace: { type: 'string' },
      output: { type: 'string' },
      file: { type: 'string' },
      reviewer: { type: 'string' },
      template: { type: 'string' },
      draft: { type: 'string' },
      revision: { type: 'string' },
      offset: { type: 'string' },
      limit: { type: 'string' },
      help: { type: 'boolean' }
    }
  })
  const names = tokens.filter((t) => t.kind === 'option').map((t) => t.name)
  if (new Set(names).size !== names.length) throw new Error('legacy_settings_arguments_invalid')
  if (values.help || !positionals.length) {
    process.stdout.write(
      'Private legacy review (offline)\nAll commands: --archive <existing.sqlite> --workspace <private-profile-id>\ncatalogue --output <new-private.json> [--offset 0 --limit 50]\nreview --file <private-review.json> --reviewer <human-label>\nprepare --draft <id> --revision <current-review-number> --template <shadow-publication.json> --output <new-private-directory>\nHuman labels confer no administrator authority. Nothing is published or enabled.\n'
    )
    return
  }
  const command = positionals[0],
    allowed: Record<string, string[]> = {
      catalogue: ['output', 'offset', 'limit'],
      review: ['file', 'reviewer'],
      prepare: ['draft', 'revision', 'template', 'output']
    }
  if (
    positionals.length !== 1 ||
    !values.archive ||
    !values.workspace ||
    !allowed[command] ||
    names.some((n) => !['archive', 'workspace', ...allowed[command]].includes(n)) ||
    (command === 'catalogue' && !values.output) ||
    (command === 'review' && (!values.file || !values.reviewer?.trim())) ||
    (command === 'prepare' &&
      (!values.draft || !values.revision || !values.template || !values.output))
  )
    throw new Error('legacy_settings_arguments_invalid')
  let request: unknown
  if (command === 'review') {
    const parsed = LegacyReviewInputSchema.safeParse(await readJson(values.file!))
    if (!parsed.success || values.reviewer!.trim().length > 200)
      throw new Error('legacy_settings_review_invalid')
    request = parsed.data
  }
  const offset = integer(values.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    limit = integer(values.limit, 50, 1, 100)
  const revision =
    command === 'prepare' ? integer(values.revision, 0, 1, Number.MAX_SAFE_INTEGER) : 0
  if (!existsSync(values.archive)) throw new Error('legacy_settings_archive_path_invalid')
  // Validate an existing archive before permitting the explicit writable upgrade.
  const inspection = new LegacySettingsArchive(values.archive, values.workspace, { readOnly: true })
  inspection.close()
  const archive = new LegacySettingsArchive(values.archive, values.workspace, {
    readOnly: command !== 'review'
  })
  try {
    if (command === 'catalogue') {
      const all = archive.list(),
        selected = all.slice(offset, offset + limit)
      const file = await writeNew(values.output!, {
        workspaceId: values.workspace,
        offset,
        total: all.length,
        nextOffset: offset + selected.length < all.length ? offset + selected.length : null,
        items: selected.map((draft) => ({ draft, review: archive.reviewState(draft.id) }))
      })
      process.stdout.write(
        JSON.stringify({
          passed: true,
          command,
          count: selected.length,
          total: all.length,
          ...file
        }) + '\n'
      )
    } else if (command === 'review') {
      const result = archive.recordReview(request, values.reviewer!)
      process.stdout.write(
        JSON.stringify({
          passed: true,
          command,
          currentReviewRevision: result.currentReviewRevision,
          isCurrent: result.isCurrent,
          reviewHash: result.record.recordHash,
          automaticEnabled: false,
          identityVerified: false
        }) + '\n'
      )
    } else {
      const prepared = prepareLegacyPublication(
        archive,
        values.draft!,
        revision,
        await readJson(values.template!)
      )
      const directory = resolve(values.output!)
      await parentChecked(directory)
      try {
        await mkdir(directory, { mode: 0o700 })
      } catch (error) {
        throw new Error(
          (error as NodeJS.ErrnoException).code === 'EEXIST'
            ? 'legacy_settings_output_conflict'
            : 'legacy_settings_output_invalid'
        )
      }
      const publication = await writeNew(join(directory, 'publication.json'), prepared.publication)
      const provenance = await writeNew(join(directory, 'provenance.json'), prepared.provenance)
      await writeNew(join(directory, 'manifest.json'), {
        formatVersion: 1,
        publication,
        provenance,
        automaticEnabled: false,
        identityVerified: false
      })
      process.stdout.write(
        JSON.stringify({
          passed: true,
          command,
          publicationHash: prepared.provenance.publicationHash,
          reviewRevision: revision,
          automaticEnabled: false,
          identityVerified: false
        }) + '\n'
      )
    }
  } finally {
    archive.close()
  }
}
main().catch((error: unknown) => {
  const code =
    error instanceof Error && /^legacy_settings_[a-z_]+$/.test(error.message)
      ? error.message
      : 'legacy_settings_failed'
  process.stderr.write(code + '\n')
  process.exitCode = 1
})
