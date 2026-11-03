import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const checkerUrl = pathToFileURL(resolve('scripts/check-source.mjs')).href
// A computed import loads the standalone, dependency-free CLI without adding
// allowJs or an ambient module declaration to production TypeScript settings.
const { checkSource } = await import(checkerUrl)
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(join(tmpdir(), 'autoreply-source-hygiene-')))
      throw new Error('unsafe_fixture_cleanup')
    await rm(root, { recursive: true, force: true })
  }
})

async function put(root: string, path: string, text: string) {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), text)
}

function track(root: string, paths: string[] = ['.']) {
  execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '--force', '--', ...paths], {
    cwd: root,
    windowsHide: true
  })
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'autoreply-source-hygiene-'))
  roots.push(root)
  execFileSync('git', ['init', '--quiet'], { cwd: root, windowsHide: true })
  const pkg = {
    name: 'source-fixture',
    version: '1.0.0',
    private: true,
    license: 'Apache-2.0',
    homepage: 'https://github.com/example/source-fixture',
    repository: { type: 'git', url: 'https://github.com/example/source-fixture.git' },
    bugs: { url: 'https://github.com/example/source-fixture/issues' },
    engines: { node: '>=24.21.0 <25' },
    dependencies: { zod: '^4.6.0', pg: '^8.23.1' },
    devDependencies: { typescript: '^5.9.3' }
  }
  // npm's root lock entry records dependencies, license and engines; private,
  // repository and bugs need not be copied into package-lock.json.
  const lock = {
    name: pkg.name,
    version: pkg.version,
    lockfileVersion: 3,
    packages: {
      '': {
        name: pkg.name,
        version: pkg.version,
        license: pkg.license,
        engines: pkg.engines,
        dependencies: { pg: '^8.23.1', zod: '^4.6.0' },
        devDependencies: pkg.devDependencies
      }
    }
  }
  await put(root, 'package.json', JSON.stringify(pkg))
  await put(root, 'package-lock.json', JSON.stringify(lock))
  await put(root, '.node-version', '24.21.0\n')
  await put(root, 'LICENSE', 'fixture license')
  await put(root, 'NOTICE', 'fixture attribution')
  track(root)
  return root
}

it('accepts a clean checkout with encoded paths, images, reference links and GitHub directory links', async () => {
  const root = await fixture()
  await put(root, 'docs/指南 (a)#1.md', '# Guide')
  await put(root, 'docs/with(parentheses).md', '# Nested parentheses')
  await put(root, 'docs/image sample.png', 'synthetic image bytes')
  await put(
    root,
    'README.md',
    [
      '[encoded](docs/%E6%8C%87%E5%8D%97%20(a)%231.md#overview)',
      '[angle](<docs/指南 (a)#1.md>)',
      '[parentheses](docs/with(parentheses).md "title")',
      '![image](docs/image%20sample.png)',
      '[directory](docs/)',
      '[reference][guide]',
      '[guide]: docs/with(parentheses).md',
      '<a href="docs/with(parentheses).md">HTML link</a>',
      '<img src="docs/image%20sample.png" alt="Synthetic image">',
      '[root](/package.json?raw=1)',
      '[remote](https://example.com/not-checked.md)',
      '[mail](mailto:maintainer@example.com)',
      '[section](#overview)',
      '`[inline example](not-a-real-file.md)`',
      '```markdown',
      '[fenced example](not-a-real-file.md)',
      '```',
      '<!-- [comment example](not-a-real-file.md) -->'
    ].join('\n')
  )
  // The raw # in an angle-bracket destination is still a URI fragment. Use
  // percent encoding for the literal filename character as GitHub requires.
  const readme = await readFile(join(root, 'README.md'), 'utf8')
  await put(root, 'README.md', readme.replace('指南 (a)#1.md>', '指南 (a)%231.md>'))
  await put(root, '.github/PULL_REQUEST_TEMPLATE.md', '[placeholder](example-only.md)')
  track(root)
  const result = await checkSource(root)
  expect(result.issues).toEqual([])
  expect(result.markdownChecked).toBe(3)
})

it('rejects missing, wrongly cased, ignored-only and escaped-outside links without reading their contents', async () => {
  const root = await fixture()
  await put(root, '.gitignore', 'private-note.md\n')
  await put(root, 'private-note.md', 'PRIVATE_CONTENT_MUST_NOT_APPEAR')
  await put(root, 'docs/Guide.md', '# Existing guide')
  await put(
    root,
    'docs/entry.md',
    [
      '[missing](missing.md)',
      '![missing image](missing.png)',
      '[wrong case](guide.md)',
      '[ignored](../private-note.md)',
      '[outside](../../outside.md)',
      '[encoded outside](%2E%2E/%2E%2E/outside.md)',
      '[invalid encoding](%E0%A4%A.md)',
      '[machine path](E:/private/report.md)',
      '[file URI](file:///E:/private/report.md)',
      '[encoded machine path](E%3A/private/report.md)'
    ].join('\n')
  )
  track(root, ['.gitignore', 'docs'])
  const { issues } = await checkSource(root)
  expect(issues.map((issue: { code: string }) => issue.code)).toEqual([
    'markdown_link_missing',
    'markdown_link_missing',
    'markdown_link_missing',
    'markdown_link_missing',
    'markdown_link_outside_repository',
    'markdown_link_outside_repository',
    'markdown_link_invalid_encoding',
    'markdown_local_absolute_path',
    'markdown_local_absolute_path',
    'markdown_local_absolute_path'
  ])
  expect(JSON.stringify(issues)).not.toContain('PRIVATE_CONTENT_MUST_NOT_APPEAR')
})

it('blocks forced-in private and generated paths while keeping examples and source bin directories', async () => {
  const root = await fixture()
  const blocked = [
    '.env',
    'server/.env.production',
    'nested/service/.env.local',
    '.LOCAL/reports/result.json',
    'evals/private/customer.md',
    'config/credentials.json',
    'keys/release.pfx',
    'profile.sqlite-wal',
    'cache.db',
    'nested/profile/ledger.sqlite3',
    'out/main/index.js',
    'native/Bridge/bin/Release/bridge.dll',
    'tests/native/Fixture/obj/project.assets.json',
    'diagnostic.log.1'
  ]
  for (const path of blocked) await put(root, path, 'PRIVATE_BYTES_MUST_NOT_BE_READ')
  await put(root, 'server/.env.example', 'EXAMPLE_KEY=replace-me\n')
  await put(root, 'src/bin/worker.ts', 'export const worker = true\n')
  track(root)
  const { issues } = await checkSource(root)
  expect(issues.map((issue: { path: string }) => issue.path).sort()).toEqual(blocked.sort())
  expect(JSON.stringify(issues)).not.toContain('PRIVATE_BYTES_MUST_NOT_BE_READ')
})

it('reads current package changes and rejects lock drift and unsupported Node metadata', async () => {
  const root = await fixture()
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  pkg.private = false
  pkg.dependencies.zod = '^5.0.0'
  pkg.engines.node = '>=22'
  pkg.bugs.url = 'https://example.com/unrelated'
  await put(root, 'package.json', JSON.stringify(pkg))
  const { issues } = await checkSource(root)
  expect(issues.map((issue: { code: string }) => issue.code)).toEqual([
    'package_private_required',
    'package_repository_metadata_invalid',
    'package_node_version_mismatch',
    'package_lock_root_engines_mismatch',
    'package_lock_dependencies_mismatch'
  ])
})

it('checks new non-ignored documents before staging them', async () => {
  const root = await fixture()
  await put(root, 'draft.md', '[new link](not-yet-created.md)')
  const { issues } = await checkSource(root)
  expect(issues).toEqual([
    { code: 'markdown_link_missing', path: 'draft.md', line: 1, target: 'not-yet-created.md' }
  ])
})

it('rejects a deleted tracked asset instead of trusting its stale Git index entry', async () => {
  const root = await fixture()
  await put(root, 'image.png', 'synthetic bytes')
  await put(root, 'README.md', '![image](image.png)')
  track(root)
  await rm(join(root, 'image.png'))
  expect((await checkSource(root)).issues).toEqual([
    { code: 'markdown_link_missing', path: 'README.md', line: 1, target: 'image.png' }
  ])
})

it('requires attribution and reports malformed lock JSON without exposing its source', async () => {
  const root = await fixture()
  await rm(join(root, 'NOTICE'))
  await put(root, 'package-lock.json', '{PRIVATE_MALFORMED_JSON')
  const { issues } = await checkSource(root)
  expect(issues).toEqual([
    { code: 'required_source_missing', path: 'NOTICE' },
    { code: 'source_json_unreadable', path: 'package-lock.json' }
  ])
  expect(JSON.stringify(issues)).not.toContain('PRIVATE_MALFORMED_JSON')
})
