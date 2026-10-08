/* eslint-disable @typescript-eslint/explicit-function-return-type -- standalone native test runner. */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const id = randomUUID(),
  directory = join(workspace, '.local/reports/native-probe-fixture', id)
const dotnet = join(workspace, '.local/toolchain/dotnet/dotnet.exe')
const operations = []
let phase = 'prepare',
  passed = false
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !/^(DOTNET_|COREHOST_|CORECLR_|COR_|COMPLUS_)/i.test(k)
  )
)

async function runChild(args, name, deadline) {
  phase = name
  const started = Date.now(),
    result = {
      name,
      exitCode: null,
      timedOut: false,
      closeConfirmed: false,
      pid: null,
      elapsedMs: null
    }
  operations.push(result)
  let stdout = '',
    stderr = ''
  await new Promise((done, reject) => {
    const child = spawn(dotnet, args, {
      cwd: workspace,
      windowsHide: true,
      shell: false,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.once('spawn', () => {
      result.pid = child.pid
    })
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 16384) stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 16384) stderr += chunk.toString()
    })
    const timer = setTimeout(() => {
      result.timedOut = true
      child.kill()
    }, deadline)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      result.exitCode = code
      result.closeConfirmed = true
      result.elapsedMs = Date.now() - started
      code === 0 && !result.timedOut ? done() : reject(new Error('native_fixture_child_failed'))
    })
  }).finally(async () => {
    await writeFile(join(directory, name + '.log'), stdout + '\n' + stderr)
  })
  return result
}
async function run() {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('native_fixture_platform_unsupported')
  await mkdir(directory, { recursive: true })
  if ((await realpath(directory)).toLowerCase() !== directory.toLowerCase())
    throw new Error('native_fixture_path_invalid')
  await runChild(
    [
      'build',
      'tests/native/ProbeFixture/ProbeFixture.csproj',
      '--configuration',
      'Release',
      '--nologo'
    ],
    'build',
    60000
  )
  const dll = join(
    workspace,
    'tests/native/ProbeFixture/bin/Release/net10.0-windows/NativeProbeFixture.dll'
  )
  const execution = await runChild([dll, join(directory, 'fixture-result.json')], 'fixture', 30000)
  const result = JSON.parse(await readFile(join(directory, 'fixture-result.json'), 'utf8'))
  const required = [
    'real_value_pattern_metadata',
    'real_button_metadata',
    'opaque_runtime_ids_present',
    'real_parent_links',
    'names_values_text_not_serialized',
    'no_platform_authority',
    'endpoint_observation_only',
    'node_limit_is_explicit',
    'depth_limit_is_explicit',
    'metadata_limit_is_explicit',
    'control_view_is_explicit',
    'raw_view_includes_filtered_metadata',
    'control_view_excludes_decoration',
    'raw_view_does_not_serialize_chat_text',
    'raw_node_limit_is_explicit',
    'reject_invalid_tree_view',
    'raw_depth_limit_is_explicit',
    'activity_observer_lifecycle_confirmed',
    'transient_win_events_recorded',
    'sample_excursion_and_wrap_detected',
    'activity_keeps_no_input_content_or_authority',
    'unavailable_sampling_is_incomplete',
    'unconfirmed_observer_stop_rejects_report'
  ]
  if (
    result.passed !== true ||
    result.fixtureOnly !== true ||
    result.realChatWindowsRead !== false ||
    result.messagesSent !== 0 ||
    result.modelCalls !== 0 ||
    required.some((check) => !result.checks.includes(check)) ||
    result.checks.length !== 28 ||
    result.checks.filter((c) => c === 'reject_process_changed').length !== 4 ||
    result.checks.filter((c) => c === 'reject_invalid_binding').length !== 1 ||
    Object.values(result.reports).some(
      (r) =>
        r.binding.processId !== execution.pid ||
        r.adapterVersion !== '0.4.0' ||
        r.formatVersion !== 3 ||
        !r.desktopActivity.observerStopped ||
        r.desktopActivity.noInterferenceVerified ||
        !['control', 'raw'].includes(r.treeView) ||
        r.identityVerified ||
        r.backgroundReadVerified ||
        r.nonInterferingSendVerified
    )
  )
    throw new Error('native_fixture_evidence_invalid')
  const sources = [
    'native/WindowsAdapter/WindowProbe.cs',
    'native/WindowsAdapter/DesktopActivityProbe.cs',
    'tests/native/ProbeFixture/Program.cs',
    'tests/native/ProbeFixture/ProbeFixture.csproj'
  ]
  await writeFile(
    join(directory, 'evidence.json'),
    JSON.stringify(
      {
        fixtureOnly: true,
        checks: result.checks,
        dllSha256: createHash('sha256')
          .update(await readFile(dll))
          .digest('hex'),
        sourceHashes: Object.fromEntries(
          await Promise.all(
            sources.map(async (source) => [
              source,
              createHash('sha256')
                .update(await readFile(join(workspace, source)))
                .digest('hex')
            ])
          )
        ),
        productionCapabilityAccepted: false,
        realChatWindowsRead: false,
        messagesSent: 0,
        modelCalls: 0
      },
      null,
      2
    )
  )
  passed = true
}
try {
  await run()
} catch {
  process.exitCode = 1
} finally {
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'runner-result.json'),
    JSON.stringify(
      {
        id,
        passed,
        phase,
        operations,
        fixtureOnly: true,
        productionCapabilityAccepted: false,
        realChatWindowsRead: false,
        messagesSent: 0,
        modelCalls: 0
      },
      null,
      2
    )
  )
  process.stdout.write(JSON.stringify({ passed, directory, fixtureOnly: true }) + '\n')
}
