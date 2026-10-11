import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import {
  protectPrivateDirectory,
  verifyPrivatePaths
} from '../../src/core/persistence/private-backup-directory'

const fixtureRoot = resolve('.local/testinputs')
// Cold tsx startup alone exceeds 4s on the acceptance PC; retain a bounded
// subprocess deadline without confusing toolchain startup with a CLI hang.
vi.setConfig({ testTimeout: 30000 })
let directory: string
const policy = {
  version: 'synthetic-policy',
  questionSetVersion: 'synthetic-questions',
  knowledgeVersion: 'synthetic-knowledge',
  mode: 'enforced',
  modelAlias: 'jev-latest',
  modelResolved: 'synthetic-model',
  evaluationApproved: true,
  automaticIntents: ['faq'],
  minimumChoiceProbability: 0.9,
  minimumChoiceConfidence: 0.8,
  minimumChoiceMargin: 0.3,
  presentIntentProbability: 0.9,
  humanRequestThreshold: 0.2,
  minimumAuditProbability: 0.95,
  reviewValidityMs: 5000,
  preBudgetMs: 2000,
  postBudgetMs: 2000
}
function fixture(): unknown {
  return {
    datasetId: 'synthetic-command-fixture',
    dataKind: 'synthetic',
    annotationSource: 'blinded_business_adjudication',
    adjudicatedBy: 'synthetic-reviewer',
    experimentSnapshotHash: 'a'.repeat(64),
    basePolicy: policy,
    candidates: [policy],
    targets: {
      maximumErrorReleaseRate: 0.01,
      minimumAutomaticCoverage: 0.5,
      minimumAutomaticReplies: 30
    },
    samples: Array.from({ length: 100 }, (_, i) => ({
      caseId: `case-${i}`,
      conversationGroup: `group-${i}`,
      split: 'calibration',
      eligible: true,
      expectedHandoff: false,
      explicitHumanRequest: false,
      deterministicPreconditionsPassed: true,
      factsVerified: true,
      draftAvailable: true,
      assessedIntents: ['faq'],
      substantialCorrection: false,
      severeFactError: false,
      unauthorizedPromise: false,
      pre: {
        model: policy.modelResolved,
        usage: { input_tokens: 10, output_tokens: 5 },
        answers: {
          primary_intent: {
            type: 'choice',
            choice: 'faq',
            confidence: 1,
            probabilities: { faq: 1, price: 0, order: 0, aftersales: 0, other: 0 }
          },
          human_requested: { type: 'noul', noul: 0 },
          has_faq: { type: 'noul', noul: 1 },
          has_price: { type: 'noul', noul: 0 },
          has_order: { type: 'noul', noul: 0 },
          has_aftersales: { type: 'noul', noul: 0 },
          has_other: { type: 'noul', noul: 0 }
        }
      },
      post: {
        model: policy.modelResolved,
        usage: { input_tokens: 10, output_tokens: 5 },
        answers: Object.fromEntries(
          [
            'supported',
            'within_scope',
            'covers_requests',
            'appropriate_tone',
            'resists_instructions'
          ].map((key) => [key, { type: 'noul', noul: 1 }])
        )
      }
    }))
  }
}
beforeAll(async () => {
  await mkdir(fixtureRoot, { recursive: true })
  directory = await mkdtemp(join(fixtureRoot, 'jev-calibrate-command-'))
  await protectPrivateDirectory(directory)
})
afterAll(async () => {
  if (!directory) return
  const target = resolve(directory)
  if (
    dirname(target) !== fixtureRoot ||
    !basename(target).startsWith('jev-calibrate-command-') ||
    relative(target, await realpath(target)) !== ''
  )
    throw new Error('unsafe_test_cleanup')
  await rm(target, { recursive: true, force: true })
})
async function file(
  name: string,
  body: string | Uint8Array = JSON.stringify(fixture())
): Promise<string> {
  const path = join(directory, name)
  await writeFile(path, body, { flag: 'wx', mode: 0o600 })
  return path
}
async function command(
  input: string,
  output: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'server/scripts/jev-calibrate.ts', input, output],
      { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stdout = '',
      stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, 20000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error('calibration_cli_timeout'))
      else resolvePromise({ code, stdout, stderr })
    })
  })
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
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe'
      ),
      ['-NoProfile', '-NonInteractive', '-Command', program],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] }
    )
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolvePromise() : reject(new Error('fixture_acl_failed'))
    )
    child.stdin.end(JSON.stringify({ path }))
  })
}
async function rejected(input: string, name: string): Promise<void> {
  const output = join(directory, name, 'report.json')
  const result = await command(input, output)
  expect(result.code).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).not.toContain('synthetic-model')
  await expect(readFile(output)).rejects.toThrow()
}
it('runs the real CLI on a complete synthetic calibration split and creates a private report without authorization', async () => {
  const input = await file('valid.json'),
    original = await readFile(input)
  const output = join(directory, 'valid-output', 'report.json')
  expect((await command(input, output)).code).toBe(2)
  expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({
    sampleCount: 100,
    dataKind: 'synthetic',
    status: 'insufficient_evidence',
    holdoutRequired: true,
    releaseAuthorized: false
  })
  await verifyPrivatePaths(dirname(output), [output])
  expect(await readFile(input)).toEqual(original)
})
it('never replaces a pre-existing report when the real CLI is retried', async () => {
  const input = await file('retry-input.json')
  const output = await file('existing-report.json', '{"original":"synthetic-sentinel"}')
  const original = await readFile(output)
  const result = await command(input, output)
  expect(result.code).toBe(1)
  expect(result.stdout).toBe('')
  expect(await readFile(output)).toEqual(original)
})
it('keeps a complete mixed split including human handoffs without inventing model responses', async () => {
  const data = fixture() as { samples: Record<string, unknown>[] }
  for (const sample of data.samples.slice(80)) {
    Object.assign(sample, {
      eligible: false,
      expectedHandoff: true,
      explicitHumanRequest: true,
      draftAvailable: false,
      factsVerified: false,
      assessedIntents: [],
      substantialCorrection: null,
      pre: null,
      post: null
    })
  }
  const input = await file('mixed-human-handoffs.json', JSON.stringify(data))
  const original = await readFile(input)
  const output = join(directory, 'mixed-output', 'report.json')
  expect((await command(input, output)).code).toBe(2)
  const report = JSON.parse(await readFile(output, 'utf8'))
  expect(report).toMatchObject({
    sampleCount: 100,
    independentConversations: 100,
    status: 'insufficient_evidence',
    releaseAuthorized: false,
    holdoutRequired: true
  })
  expect(report.candidates[0]).toMatchObject({
    automaticReplies: 80,
    eligibleCases: 80,
    automaticCoverage: 1,
    unobservedCounterfactuals: 0
  })
  await verifyPrivatePaths(dirname(output), [output])
  expect(await readFile(input)).toEqual(original)
})
it('refuses an actual publicly readable input', async () => {
  const input = await file('public.json')
  await grantPublicRead(input)
  await expect(verifyPrivatePaths(directory, [input])).rejects.toThrow()
  await rejected(input, 'public-output')
})
it('refuses input larger than 16 MiB without producing a report', async () => {
  const input = await file('oversized.json', JSON.stringify(fixture()) + ' '.repeat(16 * 1048576))
  await rejected(input, 'oversized-output')
})
it('refuses invalid UTF-8 instead of changing customer identifiers', async () => {
  const json = Buffer.from(JSON.stringify(fixture()))
  const position = json.indexOf(Buffer.from('case-0'))
  expect(position).toBeGreaterThan(0)
  json[position] = 0xc3
  const input = await file('invalid-utf8.json', json)
  await rejected(input, 'utf8-output')
})
it('refuses a junction input even when its target is private', async () => {
  const input = await file('linked.json')
  const link = join(directory, 'input-junction')
  await symlink(directory, link, process.platform === 'win32' ? 'junction' : 'dir')
  await rejected(join(link, basename(input)), 'linked-input-output')
})
it('refuses an output junction and never writes its target', async () => {
  const input = await file('output-link-input.json'),
    target = join(directory, 'output-target')
  await mkdir(target)
  const link = join(directory, 'output-junction')
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  const result = await command(input, join(link, 'report.json'))
  expect(result.code).toBe(1)
  await expect(readFile(join(target, 'report.json'))).rejects.toThrow()
  expect(relative(directory, target).startsWith('..' + sep)).toBe(false)
})
