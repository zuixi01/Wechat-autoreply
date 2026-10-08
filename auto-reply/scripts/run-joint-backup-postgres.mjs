import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const centralMode = process.argv.slice(2).join(' ') === '--central-restoration'
if (process.argv.length > 2 && !centralMode) throw new Error('joint_fixture_arguments_invalid')
const id = randomUUID(),
  name = `autoreply-joint-${id}`,
  database = `autoreply_joint_${id.replaceAll('-', '')}`
const reportDir = join(
  root,
  '.local',
  'reports',
  centralMode ? 'central-restoration-postgres' : 'joint-backup-postgres',
  id
)
const password = randomBytes(32).toString('hex'),
  environment = { ...process.env, POSTGRES_PASSWORD: password }
const report = { id, startedAt: new Date().toISOString(), passed: false, cleanedUp: false }
await mkdir(reportDir, { recursive: true })
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Standalone JavaScript runner.
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
    child.stderr?.resume()
    const timer = setTimeout(() => child.kill(), options.timeout ?? 15000)
    child.once('error', () => {
      clearTimeout(timer)
      reject(new Error('command_unavailable'))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      code === 0 ? resolve(output.trim()) : reject(new Error('command_failed'))
    })
  })
}
try {
  await command('docker', ['version', '--format', '{{.Server.Version}}'])
  const image = JSON.parse(await command('docker', ['image', 'inspect', 'postgres:16']))[0]
  report.imageId = image.Id
  await command('docker', [
    'run',
    '--detach',
    '--pull',
    'never',
    '--name',
    name,
    '--label',
    `autoreply.joint-test=${id}`,
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
    'postgres:16'
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
  const state = JSON.parse(await command('docker', ['inspect', name]))[0],
    port = state.NetworkSettings.Ports['5432/tcp'][0]
  if (port.HostIp !== '127.0.0.1' || !/^\d+$/.test(port.HostPort))
    throw new Error('loopback_binding_required')
  await command(
    process.execPath,
    ['--import', 'tsx', join(root, 'scripts', 'joint-backup-postgres-fixture.ts')],
    {
      inherit: true,
      timeout: 180000,
      env: {
        ...environment,
        AUTOREPLY_JOINT_CONTAINER: name,
        AUTOREPLY_JOINT_URL: `postgresql://postgres:${password}@127.0.0.1:${port.HostPort}/${database}`,
        AUTOREPLY_JOINT_REPORT: reportDir,
        AUTOREPLY_CENTRAL_RESTORE_TEST: centralMode ? '1' : '0'
      }
    }
  )
  const result = JSON.parse(await readFile(join(reportDir, 'fixture-result.json'), 'utf8'))
  if (
    !result.passed ||
    !result.fullRowDigestsEqual ||
    !result.tablesCompared ||
    !result.normalRolesCannotConnect ||
    !result.ledgerFence
  )
    throw new Error('fixture_not_verified')
  report.fixture = result
  if (centralMode && !result.centralRestore?.passed) throw new Error('fixture_not_verified')
  report.passed = true
} catch (error) {
  report.failureCode = [
    'command_unavailable',
    'command_failed',
    'database_not_ready',
    'loopback_binding_required',
    'fixture_not_verified'
  ].includes(error.message)
    ? error.message
    : 'validation_failed'
  process.exitCode = 1
} finally {
  try {
    const state = JSON.parse(await command('docker', ['inspect', name]))[0]
    if (state.Config.Labels?.['autoreply.joint-test'] === id) {
      await command('docker', ['rm', '--force', state.Id])
      report.cleanedUp = true
    }
  } catch {
    try {
      report.cleanedUp =
        (await command('docker', [
          'ps',
          '--all',
          '--quiet',
          '--filter',
          `label=autoreply.joint-test=${id}`
        ])) === ''
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
    `${report.passed ? 'Verified' : 'Not verified'} joint PostgreSQL round-trip: ${join(reportDir, 'result.json')}\n`
  )
}
