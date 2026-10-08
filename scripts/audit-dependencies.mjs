/* eslint-disable @typescript-eslint/explicit-function-return-type -- standalone Node release verification. */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const id = randomUUID()
const report = join(workspace, '.local', 'reports', 'dependency-audit', id)
const npm =
  process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
async function audit(scope) {
  const args = [npm, 'audit', '--json', '--registry=https://registry.npmjs.org/']
  if (scope === 'production') args.push('--omit=dev')
  const result = await new Promise((done, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: workspace,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = '',
      size = 0,
      expired = false
    const timer = setTimeout(() => {
      expired = true
      child.kill()
    }, 60000)
    child.stderr.resume()
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > 4_000_000) {
        expired = true
        child.kill()
        return
      }
      stdout += chunk.toString('utf8')
    })
    child.once('error', () => {
      clearTimeout(timer)
      reject(new Error('dependency_audit_unavailable'))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (expired) {
        reject(new Error('dependency_audit_unavailable'))
        return
      }
      try {
        done({ exitCode: code, data: JSON.parse(stdout) })
      } catch {
        reject(new Error('dependency_audit_unavailable'))
      }
    })
  })
  await writeFile(join(report, `${scope}.json`), JSON.stringify(result.data, null, 2) + '\n')
  const counts = result.data.metadata?.vulnerabilities
  const keys = ['info', 'low', 'moderate', 'high', 'critical', 'total']
  if (
    result.data.error ||
    !counts ||
    !keys.every((key) => Number.isSafeInteger(counts[key]) && counts[key] === 0) ||
    result.exitCode !== 0 ||
    !result.data.vulnerabilities ||
    Object.keys(result.data.vulnerabilities).length !== 0
  )
    throw new Error('dependency_audit_rejected')
  return { scope, counts, exitCode: result.exitCode }
}
async function run() {
  await mkdir(report, { recursive: true })
  const before = hash(await readFile(join(workspace, 'package-lock.json')))
  const results = []
  for (const scope of ['production', 'all']) results.push(await audit(scope))
  const after = hash(await readFile(join(workspace, 'package-lock.json')))
  if (before !== after) throw new Error('dependency_audit_lock_changed')
  const result = {
    passed: true,
    id,
    packageLockSha256: after,
    results,
    checkedAt: new Date().toISOString(),
    registry: 'https://registry.npmjs.org/',
    runtimeCompatibilityVerified: false,
    futureVulnerabilityAbsenceGuaranteed: false
  }
  await writeFile(join(report, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(
    JSON.stringify({ passed: true, report, packageLockSha256: after, knownVulnerabilities: 0 })
  )
}
run().catch(async (error) => {
  const code =
    error instanceof Error && /^dependency_audit_[a-z_]+$/.test(error.message)
      ? error.message
      : 'dependency_audit_unavailable'
  await mkdir(report, { recursive: true })
  await writeFile(
    join(report, 'result.json'),
    JSON.stringify({ passed: false, id, code, checkedAt: new Date().toISOString() }) + '\n'
  )
  console.error(`${code}; report: ${report}`)
  process.exitCode = 1
})
