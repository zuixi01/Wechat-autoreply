import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--help') {
  console.log(
    'Usage: node scripts/run-postgres-concurrency.mjs [--file tests/concurrency/NAME.test.ts ...]. No flags runs the full suite; selected reports are explicitly scoped.'
  )
  process.exit(0)
}
const selectedFiles = []
for (let i = 0; i < args.length; i += 2) {
  const path = args[i + 1]
  if (
    args[i] !== '--file' ||
    typeof path !== 'string' ||
    !/^tests\/concurrency\/[a-z0-9_-]+\.test\.ts$/.test(path) ||
    selectedFiles.includes(path) ||
    selectedFiles.length >= 8
  )
    throw new Error('postgres_runner_arguments_invalid')
  const absolute = join(root, path)
  if (
    !(await lstat(absolute)).isFile() ||
    (await lstat(absolute)).isSymbolicLink() ||
    (await realpath(absolute)).toLowerCase() !== absolute.toLowerCase()
  )
    throw new Error('postgres_runner_file_invalid')
  selectedFiles.push(path)
}
const id = randomUUID()
const name = `autoreply-concurrency-${id}`
const database = `autoreply_concurrency_${id.replaceAll('-', '')}`
const image = 'postgres:16'
const reportDir = join(root, '.local', 'reports', 'postgres-concurrency', id)
const password = randomBytes(32).toString('hex')
const environment = { ...process.env, POSTGRES_PASSWORD: password }
const report = {
  id,
  image,
  scope: selectedFiles.length ? 'selected' : 'full',
  selectedFiles,
  startedAt: new Date().toISOString(),
  passed: false,
  cleanedUp: false
}
await mkdir(reportDir, { recursive: true })

/** @returns {Promise<string>} Captured stdout, or an empty string for inherited output. */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- This standalone runner is JavaScript.
function command(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: options.env ?? environment,
      windowsHide: true,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout?.on('data', (chunk) => {
      output = (output + chunk).slice(-65536)
    })
    // Docker and connection errors are deliberately not copied to the report.
    child.stderr?.resume()
    const timer = setTimeout(() => child.kill(), options.timeout ?? 15000)
    child.once('error', () => {
      clearTimeout(timer)
      reject(new Error('command_unavailable'))
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(output.trim())
      else reject(new Error('command_failed'))
    })
  })
}

try {
  await command('docker', ['version', '--format', '{{.Server.Version}}'])
  const info = JSON.parse(await command('docker', ['image', 'inspect', image]))[0]
  report.imageId = info.Id
  report.imageDigests = info.RepoDigests ?? []
  // No existing container, external database, bind mount or persistent volume is reused.
  await command('docker', [
    'run',
    '--detach',
    '--pull',
    'never',
    '--name',
    name,
    '--label',
    `autoreply.test-run=${id}`,
    '--memory',
    '512m',
    '--cpus',
    '1',
    '--publish',
    '127.0.0.1::5432',
    '--tmpfs',
    '/var/lib/postgresql/data:rw',
    '--env',
    'POSTGRES_PASSWORD',
    '--env',
    `POSTGRES_DB=${database}`,
    image
  ])
  let ready = false
  for (let n = 0; n < 60; n++) {
    try {
      await command('docker', ['exec', name, 'pg_isready', '-U', 'postgres', '-d', database], {
        timeout: 3000
      })
      ready = true
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  if (!ready) throw new Error('database_not_ready')
  const state = JSON.parse(await command('docker', ['inspect', name]))[0]
  const port = state.NetworkSettings.Ports['5432/tcp'][0]
  if (port.HostIp !== '127.0.0.1' || !/^\d+$/.test(port.HostPort))
    throw new Error('loopback_binding_required')
  const url = `postgresql://postgres:${password}@127.0.0.1:${port.HostPort}/${database}`
  await command(
    process.execPath,
    [
      join(root, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      ...selectedFiles,
      '--config',
      'vitest.postgres.config.ts',
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${join(reportDir, 'tests.json')}`
    ],
    {
      inherit: true,
      timeout: 180000,
      env: {
        ...environment,
        AUTOREPLY_POSTGRES_TEST_URL: url,
        AUTOREPLY_POSTGRES_TEST_REPORT: reportDir,
        AUTOREPLY_POSTGRES_TEST_PASSWORD: randomBytes(32).toString('hex')
      }
    }
  )
  const tests = JSON.parse(await readFile(join(reportDir, 'tests.json'), 'utf8'))
  if (!tests.success || !tests.numPassedTests || tests.numPendingTests || tests.numFailedTests)
    throw new Error('tests_not_verified')
  report.testsPassed = tests.numPassedTests
  report.passed = true
} catch (error) {
  report.failureCode = [
    'command_unavailable',
    'command_failed',
    'database_not_ready',
    'loopback_binding_required',
    'tests_not_verified'
  ].includes(error.message)
    ? error.message
    : 'validation_failed'
  process.exitCode = 1
} finally {
  try {
    const state = JSON.parse(await command('docker', ['inspect', name]))[0]
    if (state.Config.Labels?.['autoreply.test-run'] === id) {
      await command('docker', ['rm', '--force', state.Id])
      report.cleanedUp = true
    }
  } catch {
    // If no container was ever created, there is nothing to remove.
    try {
      const leftovers = await command('docker', [
        'ps',
        '--all',
        '--quiet',
        '--filter',
        `label=autoreply.test-run=${id}`
      ])
      report.cleanedUp = leftovers === ''
    } catch {
      report.cleanedUp = false
    }
  }
  if (!report.cleanedUp) {
    report.passed = false
    process.exitCode = 1
  }
  report.finishedAt = new Date().toISOString()
  await writeFile(join(reportDir, 'result.json'), JSON.stringify(report, null, 2))
  process.stdout.write(
    `${report.passed ? 'Verified' : 'Not verified'} isolated PostgreSQL concurrency: ${join(reportDir, 'result.json')}\n`
  )
}
