import { afterEach, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { LegacySettingsArchive } from '../../src/core/persistence/legacy-settings-archive'

const roots: string[] = []
afterEach(() =>
  roots.splice(0).forEach((root) => {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'legacy-review-cli-'))
      throw new Error('unexpected_fixture_path')
    rmSync(root, { recursive: true, force: true })
  })
)
it('runs a private catalogue, manual review and shadow publication handoff without printing private content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-review-cli-'))
  roots.push(root)
  const db = join(root, 'archive.sqlite'),
    source = join(root, 'source.json'),
    catalogue = join(root, 'catalogue.json')
  writeFileSync(
    source,
    JSON.stringify({
      modes: [{ id: 'mode', name: 'PRIVATE_CUSTOMER_RULE', prompt: 'PRIVATE_ORIGINAL_RULE' }]
    })
  )
  const archive = new LegacySettingsArchive(db, 'workspace')
  let draft: ReturnType<LegacySettingsArchive['list']>[number]
  try {
    await archive.importFile(source)
    draft = archive.list().find((d) => d.content.kind === 'mode')!
  } finally {
    archive.close()
  }
  const cli = join(process.cwd(), 'scripts/legacy-settings-review.ts')
  const invoke = (command: string, ...args: string[]) =>
    spawnSync(
      process.execPath,
      ['--import', 'tsx', cli, command, '--archive', db, '--workspace', 'workspace', ...args],
      { encoding: 'utf8', timeout: 15000 }
    )
  const listing = invoke('catalogue', '--output', catalogue)
  expect(listing.status, listing.stderr).toBe(0)
  const items = JSON.parse(readFileSync(catalogue, 'utf8'))
  expect(items.items.find((i: { draft: { id: string } }) => i.draft.id === draft.id)).toMatchObject(
    { draft: { state: 'pending', automaticEnabled: false }, review: null }
  )
  const reviewFile = join(root, 'review.json')
  writeFileSync(
    reviewFile,
    JSON.stringify({
      sourceId: 'manual-1',
      draftId: draft.id,
      expectedContentHash: draft.contentHash,
      expectedReviewRevision: 0,
      decision: 'accept',
      reason: 'PRIVATE_REVIEW_REASON',
      replyRules: 'PRIVATE_REVIEWED_RULE'
    })
  )
  const review = invoke('review', '--file', reviewFile, '--reviewer', 'private-reviewer')
  expect(review.status, review.stderr).toBe(0)
  expect(JSON.parse(review.stdout)).toMatchObject({
    currentReviewRevision: 1,
    isCurrent: true,
    automaticEnabled: false,
    identityVerified: false
  })
  const template = join(root, 'template.json')
  writeFileSync(
    template,
    readFileSync(join(process.cwd(), 'server/admin/publication.example.json'))
  )
  const output = join(root, 'prepared')
  const prepared = invoke(
    'prepare',
    '--draft',
    draft.id,
    '--revision',
    '1',
    '--template',
    template,
    '--output',
    output
  )
  expect(prepared.status, prepared.stderr).toBe(0)
  expect(JSON.parse(readFileSync(join(output, 'publication.json'), 'utf8'))).toMatchObject({
    replyRules: 'PRIVATE_REVIEWED_RULE',
    configuration: { automaticEnabled: false },
    policy: { mode: 'shadow' }
  })
  expect(JSON.parse(readFileSync(join(output, 'provenance.json'), 'utf8'))).toMatchObject({
    draftId: draft.id,
    reviewRevision: 1
  })
  expect(existsSync(join(output, 'manifest.json'))).toBe(true)
  for (const secret of [
    'PRIVATE_CUSTOMER_RULE',
    'PRIVATE_ORIGINAL_RULE',
    'PRIVATE_REVIEW_REASON',
    'PRIVATE_REVIEWED_RULE',
    'private-reviewer'
  ])
    expect(
      listing.stdout +
        listing.stderr +
        review.stdout +
        review.stderr +
        prepared.stdout +
        prepared.stderr
    ).not.toContain(secret)
  const again = invoke('catalogue', '--output', catalogue)
  expect(again.status).toBe(1)
  expect(JSON.parse(readFileSync(catalogue, 'utf8'))).toEqual(items)
  const dup = invoke(
    'prepare',
    '--draft',
    draft.id,
    '--revision',
    '1',
    '--template',
    template,
    '--output',
    output
  )
  expect(dup.status).toBe(1)
  expect(dup.stderr).toContain('legacy_settings_output_conflict')
}, 15000)

it('refuses invalid review files before creating a new archive and denies ambiguous repeated flags', () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-review-cli-'))
  roots.push(root)
  const db = join(root, 'missing.sqlite'),
    file = join(root, 'invalid.json')
  writeFileSync(file, JSON.stringify({ apiKey: 'PRIVATE_KEY' }))
  const cli = join(process.cwd(), 'scripts/legacy-settings-review.ts')
  const run = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      cli,
      'review',
      '--archive',
      db,
      '--workspace',
      'workspace',
      '--file',
      file,
      '--reviewer',
      'r'
    ],
    { encoding: 'utf8' }
  )
  expect(run.status).toBe(1)
  expect(existsSync(db)).toBe(false)
  const duplicate = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      cli,
      'catalogue',
      '--archive',
      db,
      '--workspace',
      'A',
      '--workspace',
      'B',
      '--output',
      join(root, 'out.json')
    ],
    { encoding: 'utf8' }
  )
  expect(duplicate.status).toBe(1)
  expect(duplicate.stderr).toContain('legacy_settings_arguments_invalid')
  expect(run.stderr + duplicate.stderr).not.toContain('PRIVATE_KEY')
})
