import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import electronPath from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url))),
  report = resolve(process.argv[2] ?? ''),
  part = relative(join(root, '.local/reports/foreground-evaluation'), report)
if (
  !part ||
  isAbsolute(part) ||
  part === '..' ||
  part.startsWith('..' + sep) ||
  !/^[a-f0-9-]{36}$/.test(part) ||
  process.env.AUTOREPLY_FOREGROUND_EVALUATION_FIXTURE !== '1'
)
  throw new Error('use_isolated_postgres_foreground_fixture')
const fixture = join(report, 'fixture.cjs')
const anchoredSources = new Set([
  join(root, 'server/src/learning/learning-memory-replay.ts'),
  join(root, 'evals/memory/replay.ts')
])
await build({
  entryPoints: [join(root, 'scripts/foreground-evaluation-desktop-fixture.ts')],
  outfile: fixture,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  logLevel: 'silent',
  // The CJS fixture runs the original TS implementation and fingerprints those exact source files.
  // Anchors are build-host constants; no dataset, renderer or exported hash selects a module path.
  plugins: [
    {
      name: 'fixture-source-module-anchors',
      setup(builder) {
        builder.onLoad({ filter: /\.ts$/ }, async (args) => {
          if (!anchoredSources.has(args.path)) return undefined
          const contents = await readFile(args.path, 'utf8')
          return {
            contents: contents.replaceAll(
              'import.meta.url',
              JSON.stringify(pathToFileURL(args.path).href)
            ),
            loader: 'ts'
          }
        })
      }
    }
  ]
})
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
const started = Date.now(),
  child = spawn(electronPath, [fixture, report], {
    cwd: root,
    env: environment,
    windowsHide: false,
    stdio: 'inherit'
  })
let timedOut = false
const timer = setTimeout(() => {
  timedOut = true
  child.kill()
}, 50000)
const exitCode = await new Promise((done) => {
  child.once('error', () => done(1))
  child.once('exit', (code) => done(code ?? 1))
})
clearTimeout(timer)
await writeFile(
  join(report, 'runner-result.json'),
  JSON.stringify({ exitCode, timedOut, elapsedMs: Date.now() - started }, null, 2) + '\n'
)
try {
  const result = JSON.parse(await readFile(join(report, 'result.json'), 'utf8'))
  if (
    timedOut ||
    exitCode !== 0 ||
    result.passed !== true ||
    result.actualForegroundPresentation !== true ||
    result.original?.serverFrozenBatchVerified !== true ||
    result.linked?.foregroundVerified !== true ||
    result.linked?.observations?.length !== 3 ||
    result.http !== 9 ||
    result.sends !== 0 ||
    result.nativePlatformVerified !== false ||
    result.businessEffectVerified !== false
  )
    throw new Error('foreground_evaluation_unconfirmed')
  process.stdout.write(
    `Verified actual foreground three-arm engineering: ${join(report, 'result.json')}\n`
  )
} catch {
  process.stderr.write(`Foreground three-arm not verified: ${join(report, 'result.json')}\n`)
  process.exitCode = 1
}
