import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { reconcileJevSettlements } from '../../evals/jev/settlement-reconciliation'
import { hashContext } from '../../src/core/reply/hashes'
import {
  protectPrivateDirectory,
  verifyPrivatePaths
} from '../../src/core/persistence/private-backup-directory'
import { createSyntheticJevSettlementInput } from '../fixtures/jev-settlement-data'

const fixtureRoot = resolve('.local/testinputs')
const publicRoot = resolve(tmpdir())
let directory: string, publicDirectory: string
const profiling = process.env.JEV_SETTLEMENT_TEST_PROFILE === '1'
const profileStarted = performance.now()
const profileEvents: { stage: string; elapsedMs: number }[] = []
type ProfileStage =
  | 'fixture_start'
  | 'fixture_end'
  | 'input_encode_start'
  | 'input_encode_end'
  | 'input_write_start'
  | 'input_write_end'
  | 'command_spawn'
  | 'command_spawn_error'
  | 'command_timer_fired'
  | 'command_stdout_first'
  | 'command_stderr_first'
  | 'command_close'
  | 'summary_read_start'
  | 'summary_read_end'
  | 'parent_acl_start'
  | 'parent_acl_end'
  | 'full_recompute_start'
  | 'full_recompute_end'
  | 'input_reread_start'
  | 'input_reread_end'
  | 'same_original_read_start'
  | 'same_original_read_end'
  | 'input_bytes_compare_start'
  | 'input_bytes_compare_end'
function profile(stage: ProfileStage): void {
  if (!profiling) return
  const event = { stage, elapsedMs: Math.round((performance.now() - profileStarted) * 1000) / 1000 }
  profileEvents.push(event)
  process.stdout.write(JSON.stringify(event) + '\n')
}
function createInputFixture() {
  profile('fixture_start')
  const value = createSyntheticJevSettlementInput()
  profile('fixture_end')
  return value
}
const falseFlags = [
  'centralEvidenceVerified',
  'rawExportContentVerified',
  'supplierAuthenticityVerified',
  'providerBillingAccountVerified',
  'monetaryBudgetVerified',
  'releaseAuthorized'
] as const
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    [
      'PATH',
      'SYSTEMROOT',
      'WINDIR',
      'TEMP',
      'TMP',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'COMSPEC',
      'PATHEXT',
      'HOME'
    ].includes(name.toUpperCase())
  )
)

beforeAll(async () => {
  await mkdir(fixtureRoot, { recursive: true })
  directory = await mkdtemp(join(fixtureRoot, 'jev-settlement-command-'))
  await protectPrivateDirectory(directory)
  publicDirectory = await mkdtemp(join(publicRoot, 'jev-settlement-command-public-'))
})
afterAll(async () => {
  for (const [candidate, parent, prefix] of [
    [directory, fixtureRoot, 'jev-settlement-command-'],
    [publicDirectory, publicRoot, 'jev-settlement-command-public-']
  ]) {
    if (!candidate) continue
    const target = resolve(candidate)
    if (
      dirname(target) !== parent ||
      !basename(target).startsWith(prefix) ||
      relative(target, await realpath(target)) !== ''
    )
      throw new Error('unsafe_test_cleanup')
    await rm(target, { recursive: true, force: true })
  }
  if (profiling) {
    const reports = resolve('.local/reports')
    await mkdir(reports, { recursive: true })
    await writeFile(
      join(reports, `jev-settlement-command-profile-${randomUUID()}.json`),
      JSON.stringify(
        {
          protocol: 'jev-settlement-command-test-profile-v1',
          completeAcceptance: false,
          events: profileEvents
        },
        null,
        2
      ) + '\n',
      { flag: 'wx', mode: 0o600 }
    )
  }
})
async function file(name: string, body: unknown = createInputFixture()): Promise<string> {
  const path = join(directory, name)
  profile('input_encode_start')
  const encoded = JSON.stringify(body)
  profile('input_encode_end')
  profile('input_write_start')
  await writeFile(path, encoded, { flag: 'wx', mode: 0o600 })
  profile('input_write_end')
  return path
}
async function command(
  args: string[],
  deadlineMs = 4000
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const release = process.env.JEV_SETTLEMENT_COMPILED_RELEASE
    const entry = release
      ? resolve(release, 'server/scripts/jev-settlements.js')
      : 'server/scripts/jev-settlements.ts'
    profile('command_spawn')
    const child = spawn(
      process.execPath,
      [...(release ? [] : ['--import', 'tsx']), entry, ...args],
      {
        cwd: process.cwd(),
        env: environment,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let stdout = '',
      stderr = '',
      timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      profile('command_timer_fired')
      child.kill()
    }, deadlineMs)
    child.stdout.on('data', (chunk) => {
      if (!stdout) profile('command_stdout_first')
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      if (!stderr) profile('command_stderr_first')
      stderr += chunk.toString()
    })
    child.on('error', () => {
      profile('command_spawn_error')
      clearTimeout(timer)
      reject(new Error('settlement_cli_spawn_failed'))
    })
    child.on('close', (code) => {
      profile('command_close')
      clearTimeout(timer)
      if (timedOut) reject(new Error('settlement_cli_timeout'))
      else done({ code, stdout, stderr })
    })
  })
}
async function summary(path: string) {
  profile('summary_read_start')
  const result = JSON.parse(await readFile(path, 'utf8'))
  profile('summary_read_end')
  profile('parent_acl_start')
  try {
    await verifyPrivatePaths(dirname(path), [path])
  } finally {
    profile('parent_acl_end')
  }
  expect(result.protocol).toBe('jev-settlement-correlation-summary-v1')
  expect(result.dataKind).toBe('unverified')
  expect(result.caseArmCount).toBe(900)
  expect(result).not.toHaveProperty('cases')
  expect(result.details).toBe('recompute_from_retained_private_input')
  for (const flag of falseFlags) expect(result[flag]).toBe(false)
  const { summaryHash, ...body } = result
  expect(summaryHash).toBe(hashContext(body))
  return result
}
async function rejected(input: string, output: string) {
  const result = await command([input, output])
  expect(result.code).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe(
    'Settlement correlation failed. Check the private normalized input and a fresh .local output path. No models called or messages sent.\n'
  )
  await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
}
async function grantPublicRead(path: string): Promise<void> {
  if (process.platform !== 'win32') return chmod(path, 0o644)
  const program = `$ErrorActionPreference='Stop'
    $testInput=[Console]::In.ReadToEnd() | ConvertFrom-Json
    $testAcl=[IO.File]::GetAccessControl($testInput.path)
    $testSid=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')
    $testRule=[Security.AccessControl.FileSystemAccessRule]::new($testSid,[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow)
    $testAcl.AddAccessRule($testRule)
    [IO.File]::SetAccessControl($testInput.path,$testAcl)`
  await new Promise<void>((done, reject) => {
    const child = spawn(
      join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe'
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(program, 'utf16le').toString('base64')
      ],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] }
    )
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, 4000)
    child.on('error', () => {
      clearTimeout(timer)
      reject(new Error('fixture_acl_failed'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && !timedOut) done()
      else reject(new Error('fixture_acl_failed'))
    })
    child.stdin.end(JSON.stringify({ path }))
  })
}

describe('actual offline settlement CLI with private synthetic inputs', () => {
  it('summarizes all 900 case-arms and 1800 attempts, preserving private input and refusing authorization', async () => {
    const data = createInputFixture(),
      input = await file('complete.private.json', data)
    const original = await readFile(input),
      output = join(directory, 'complete', 'summary.private.json')
    // The full 900-case fixture starts a cold TypeScript process and checks
    // Windows ACLs. Keep its deadline separate from the small rejection cases.
    const execution = await command([input, output], 10000)
    expect(execution.code).toBe(2)
    expect(execution.stderr).toBe('')
    expect(execution.stdout).toContain('No models called or messages sent.')
    expect(execution.stdout).not.toContain('synthetic-model')
    expect(execution.stdout).not.toContain('Synthetic draft')
    const result = await summary(output)
    profile('full_recompute_start')
    const fullReportHash = reconcileJevSettlements(data).reportHash
    profile('full_recompute_end')
    expect(result).toMatchObject({
      status: 'complete_declared',
      attemptCount: 1800,
      declaredSettledCostMicros: 108000,
      fullReportHash,
      inputHash: hashContext(data)
    })
    profile('input_reread_start')
    const reread = await readFile(input)
    profile('input_reread_end')
    profile('input_bytes_compare_start')
    expect(reread.equals(original)).toBe(true)
    profile('input_bytes_compare_end')
  }, 15000)
  it('keeps a missing target settlement unknown with exit 2 and no zero substitution', async () => {
    const data = createSyntheticJevSettlementInput()
    const artifact = data.artifacts.find((a) => a.runId === data.holdout.runId && a.arm === 'C')!
    const requestId = artifact.attempts![0].result!.providerRequestId!.value
    data.exports[0].rows = data.exports[0].rows.filter((r) => r.requestId !== requestId)
    const input = await file('missing.private.json', data),
      output = join(directory, 'missing', 'summary.private.json')
    expect((await command([input, output])).code).toBe(2)
    const result = await summary(output)
    expect(result).toMatchObject({
      status: 'incomplete',
      unresolvedAttemptCount: 1,
      declaredSettledCostMicros: null,
      knownMatchedSubtotalMicros: 107980,
      inputHash: hashContext(data),
      fullReportHash: reconcileJevSettlements(data).reportHash
    })
    expect(result.bySplit.holdout.declaredSettledCostMicros).toBeNull()
    expect(result.holdoutArms.C.p95DeclaredTurnCostMicros).toBeNull()
    expect(result.declaredBudgetAssessment.status).toBe('incomplete')
  })
  it('reports over-budget declarations with exit 2, preserving the C maximum rule', async () => {
    const data = createSyntheticJevSettlementInput()
    const artifact = data.artifacts.find((a) => a.runId === data.holdout.runId && a.arm === 'C')!
    const requestId = artifact.attempts!.find((a) => a.stage === 'text')!.result!.providerRequestId!
      .value
    Object.assign(data.exports[1].rows.find((r) => r.requestId === requestId)!, {
      settledCostMicros: 10001
    })
    const input = await file('exceeded.private.json', data),
      output = join(directory, 'exceeded', 'summary.private.json')
    expect((await command([input, output])).code).toBe(2)
    const result = await summary(output)
    expect(result.declaredBudgetAssessment.status).toBe('exceeded_declared')
    expect(result.holdoutArms.C.maximumDeclaredTurnCostMicros).toBe(10041)
    expect(result.holdoutArms.C.p95DeclaredTurnCostMicros).toBe(140)
  })
  it('refuses retry overwrite and preserves the exact existing summary bytes', async () => {
    const input = await file('retry.private.json'),
      output = await file('original-summary.private.json', { original: 'synthetic-sentinel' })
    const original = await readFile(output),
      execution = await command([input, output])
    expect(execution.code).toBe(1)
    expect(execution.stdout).toBe('')
    expect((await readFile(output)).equals(original)).toBe(true)
  })
  it('rejects malformed schema without disclosing a private unknown key or value', async () => {
    const data = createSyntheticJevSettlementInput(),
      secret = 'synthetic-private-bill-secret'
    Object.assign(data.exports[0].rows[0], { [secret]: 'synthetic-private-bill-value' })
    const input = await file('invalid.private.json', data),
      output = join(directory, 'invalid', 'summary.private.json')
    await rejected(input, output)
  })
  it('rejects an actual publicly readable input before producing a summary', async () => {
    const input = await file('public-acl.private.json')
    await grantPublicRead(input)
    await expect(verifyPrivatePaths(directory, [input])).rejects.toThrow()
    await rejected(input, join(directory, 'public-acl', 'summary.private.json'))
  })
  it('refuses a public input path outside the allowed private roots', async () => {
    const input = join(publicDirectory, 'outside.private.json')
    await writeFile(input, JSON.stringify(createSyntheticJevSettlementInput()), {
      flag: 'wx',
      mode: 0o600
    })
    await rejected(input, join(directory, 'outside-input', 'summary.private.json'))
  })
  it('refuses an output path outside .local', async () => {
    const input = await file('outside-output-input.private.json')
    await rejected(input, join(publicDirectory, 'outside-summary.private.json'))
  })
  it('never replaces the retained input when input and output are the same path', async () => {
    const input = await file('same-path.private.json')
    profile('same_original_read_start')
    const original = await readFile(input)
    profile('same_original_read_end')
    expect((await command([input, input])).code).toBe(1)
    profile('input_reread_start')
    const reread = await readFile(input)
    profile('input_reread_end')
    profile('input_bytes_compare_start')
    expect(reread.equals(original)).toBe(true)
    profile('input_bytes_compare_end')
  })
  it('runs actual help without input, output, credentials, or authorization', async () => {
    const execution = await command(['--help'])
    expect(execution.code).toBe(0)
    expect(execution.stderr).toBe('')
    expect(execution.stdout).toContain(
      'Usage: jev:settlements INPUT.private.json OUTPUT-summary.private.json'
    )
    expect(execution.stdout).toContain('No models called or messages sent.')
  })
})
