// Verify the development package; no main UI, client window enumeration or message sending.
/* eslint-disable @typescript-eslint/explicit-function-return-type -- standalone Node JavaScript runner. */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile, listPackage } from '@electron/asar'
import inventoryPolicy from './package-inventory-policy.cjs'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const directory = join(workspace, '.local', 'reports', 'packaged-native-smoke', randomUUID())
async function run() {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('platform_unsupported')
  const requestedIndex = process.argv.indexOf('--build-id')
  if (requestedIndex !== process.argv.lastIndexOf('--build-id'))
    throw new Error('package_build_id_invalid')
  const build =
    requestedIndex < 0
      ? JSON.parse(
          await readFile(
            join(workspace, '.local', 'reports', 'windows-dev-build', 'latest.json'),
            'utf8'
          )
        )
      : { id: process.argv[requestedIndex + 1] }
  if (
    typeof build.id !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(build.id)
  )
    throw new Error('package_build_id_invalid')
  const packageRoot = join(workspace, 'dist', `windows-dev-${build.id}`, 'win-unpacked')
  if ((await realpath(packageRoot)).toLowerCase() !== packageRoot.toLowerCase())
    throw new Error('package_path_invalid')
  await mkdir(directory, { recursive: true })
  const archive = join(packageRoot, 'resources', 'app.asar')
  const paths = listPackage(archive).map((path) => path.replaceAll('\\', '/').replace(/^\//, ''))
  inventoryPolicy.assertPackageInventory(paths)
  const factory = extractFile(archive, join('out', 'main', 'native-adapter.js'))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(DOTNET_|COREHOST_|CORECLR_|COR_|COMPLUS_)/i.test(key)
    )
  )
  env.ELECTRON_RUN_AS_NODE = '1'
  // The executable must run from its shipped resources; no SDK/toolchain is on PATH.
  env.PATH = `${process.env.SystemRoot || 'C:\\Windows'}\\System32`
  await new Promise((done, reject) => {
    const child = spawn(
      join(packageRoot, 'AutoReply.exe'),
      [join(workspace, 'scripts', 'packaged-native-smoke.cjs'), directory],
      { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env, cwd: directory }
    )
    let stderr = ''
    child.stdout.resume()
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk.toString()
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('packaged_smoke_timeout'))
    }, 90000) // Cold executable startup + bounded factory verification + checks.
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      code === 0 ? done() : reject(new Error(`packaged_smoke_failed:${stderr}`))
    })
  })
  const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
  if (
    result.passed !== true ||
    result.messagesSent !== 0 ||
    result.chatWindowsRead !== false ||
    result.childExitConfirmed !== true ||
    result.ledgerRecovery?.restorationContextVerified !== true ||
    result.ledgerRecovery.clearedLegacyMarkerStillBlocked !== true ||
    result.ledgerRecovery.syntheticPauseReportPersisted !== true ||
    result.ledgerRecovery.syntheticPauseReportRetryUnchanged !== true ||
    result.ledgerRecovery.syntheticPauseReportReopened !== true ||
    result.ledgerRecovery.pauseReportDoesNotReleaseRestoration !== true ||
    result.ledgerRecovery.restoredMetadataInventoryVerified !== true ||
    result.ledgerRecovery.restoredInventoryOrphanRejected !== true ||
    result.legacyMigration?.syntheticDrafts !== 3 ||
    result.legacyMigration.automaticEnabled !== false ||
    result.legacyMigration.identityVerified !== false ||
    result.legacyMigration.reviewRequired !== true ||
    result.legacyMigration.repeatCreatedDrafts !== 0 ||
    result.legacyReview?.acceptedRevision !== 1 ||
    result.legacyReview.currentRevision !== 2 ||
    result.legacyReview.state !== 'reopen' ||
    result.legacyReview.staleRetryCurrent !== false ||
    result.legacyReview.automaticEnabled !== false ||
    result.legacyReview.identityVerified !== false
  )
    throw new Error('packaged_smoke_failed')
  await writeFile(
    join(directory, 'inventory.json'),
    JSON.stringify(
      {
        buildId: build.id,
        paths: paths.length,
        privateBuildFilesExcluded: true,
        factorySha256: createHash('sha256').update(factory).digest('hex'),
        appAsarSha256: createHash('sha256')
          .update(await readFile(archive))
          .digest('hex'),
        signatureVerified: false,
        cleanMachineInstallVerified: false,
        checkedAt: new Date().toISOString()
      },
      null,
      2
    ) + '\n'
  )
  console.log(JSON.stringify({ passed: true, directory, paths: paths.length, messagesSent: 0 }))
}
run().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
