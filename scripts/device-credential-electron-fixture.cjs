/* eslint-disable @typescript-eslint/no-require-imports -- Electron entry and production bundles use CommonJS. */
const { app, safeStorage } = require('electron')
const { randomBytes, randomUUID, createHash } = require('node:crypto')
const { readFile, writeFile } = require('node:fs/promises')
const { resolve, join, basename } = require('node:path')

let privatePermissions
let windowsCreated = 0
let webContentsCreated = 0
let networkCalls = 0
let failureCode = 'device_credential_fixture_failed'
const runtime = {
  electron: process.versions.electron,
  node: process.versions.node,
  arch: process.arch,
  platform: process.platform
}
const tokenHash = (token) => createHash('sha256').update(token, 'utf8').digest('hex')
const assert = (value) => {
  if (!value) throw new Error('device_credential_fixture_failed')
}
const args = process.argv.slice(2)
const validArguments =
  args.length === 2 &&
  ['producer', 'consumer'].includes(args[0]) &&
  resolve(args[1]) === resolve(__dirname) &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(basename(args[1]))

async function main() {
  if (!validArguments || process.platform !== 'win32') {
    failureCode = 'device_credential_fixture_arguments_invalid'
    throw new Error(failureCode)
  }
  const [phase, directory] = args
  app.setPath('userData', join(directory, 'user-data'))
  app.setPath('sessionData', join(directory, 'user-data'))
  app.commandLine.appendSwitch('disable-background-networking')
  privatePermissions = require(join(directory, 'private-directory.cjs'))
  await privatePermissions.verifyPrivatePaths(directory, [
    join(directory, 'factory.cjs'),
    join(directory, 'private-directory.cjs'),
    join(directory, 'user-data')
  ])
  app.on('browser-window-created', () => windowsCreated++)
  app.on('web-contents-created', () => webContentsCreated++)
  const forbidNetwork = () => {
    networkCalls++
    throw new Error('device_credential_fixture_network_forbidden')
  }
  globalThis.fetch = forbidNetwork
  for (const name of ['node:http', 'node:https']) {
    const api = require(name)
    api.request = forbidNetwork
    api.get = forbidNetwork
  }
  const net = require('node:net')
  net.connect = forbidNetwork
  net.createConnection = forbidNetwork
  require('node:tls').connect = forbidNetwork
  await app.whenReady()
  failureCode = 'device_credential_safe_storage_unavailable'
  assert(safeStorage.isEncryptionAvailable())
  failureCode = 'device_credential_fixture_failed'
  const { createDeviceCredentialCipher } = require(join(directory, 'factory.cjs'))
  const cipher = createDeviceCredentialCipher(safeStorage)
  assert(cipher.available() === true)
  const factoryHash = createHash('sha256')
    .update(await readFile(join(directory, 'factory.cjs')))
    .digest('hex')
  const recordPath = join(directory, 'encrypted-device.private.json')
  const tokenPath = join(directory, 'expected-token-hash.private.json')
  const writePrivate = async (path, value) => {
    await privatePermissions.verifyPrivatePaths(directory, [])
    await writeFile(path, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 })
    await privatePermissions.verifyPrivatePaths(directory, [path])
  }
  let rejectionCount = 0
  if (phase === 'producer') {
    const token = randomBytes(32).toString('base64url')
    const context = {
      serverUrl: 'https://device-credential.invalid/',
      scope: {
        tenant_id: `synthetic-tenant-${randomUUID()}`,
        employee_id: `synthetic-employee-${randomUUID()}`,
        account_id: `synthetic-account-${randomUUID()}`,
        agent_id: `synthetic-agent-${randomUUID()}`,
        platform: 'wechat'
      }
    }
    assert(/^[A-Za-z0-9_-]{43}$/.test(token))
    const ciphertext = cipher.encrypt(token, context)
    assert(typeof ciphertext === 'string' && ciphertext.length > 43 && !ciphertext.includes(token))
    assert(cipher.decrypt(ciphertext, context) === token)
    await writePrivate(recordPath, { ciphertext, context })
    await writePrivate(tokenPath, { tokenHash: tokenHash(token) })
  } else {
    await privatePermissions.verifyPrivatePaths(directory, [recordPath, tokenPath])
    const { ciphertext, context } = JSON.parse(await readFile(recordPath, 'utf8'))
    const { tokenHash: expectedTokenHash } = JSON.parse(await readFile(tokenPath, 'utf8'))
    assert(/^[a-f0-9]{64}$/.test(expectedTokenHash) && typeof ciphertext === 'string')
    const token = cipher.decrypt(ciphertext, context)
    assert(/^[A-Za-z0-9_-]{43}$/.test(token) && tokenHash(token) === expectedTokenHash)
    const rejects = (encrypted, expected) => {
      let refused = false
      try {
        cipher.decrypt(encrypted, expected)
      } catch {
        refused = true
      }
      assert(refused)
      rejectionCount++
    }
    rejects(ciphertext, { ...context, serverUrl: 'https://other-device-credential.invalid/' })
    rejects(ciphertext, { ...context, serverUrl: 'https://device-credential.invalid:444/' })
    for (const key of ['tenant_id', 'employee_id', 'account_id', 'agent_id', 'platform'])
      rejects(ciphertext, {
        ...context,
        scope: {
          ...context.scope,
          [key]: key === 'platform' ? 'wework' : `changed-${randomUUID()}`
        }
      })
    rejects('not-a-device-credential-envelope', context)
    const damaged = Buffer.from(ciphertext, 'base64')
    assert(damaged.length > 16)
    damaged[Math.floor(damaged.length / 2)] ^= 0xff
    rejects(damaged.toString('base64'), context)
    // A genuine safeStorage ciphertext of a bare token lacks the production
    // versioned envelope and must remain unusable after this migration.
    rejects(safeStorage.encryptString(token).toString('base64'), context)
    assert(rejectionCount === 10)
    assert(cipher.decrypt(ciphertext, context) === token)
  }
  assert(windowsCreated === 0 && webContentsCreated === 0 && networkCalls === 0)
  const result = {
    protocol: 'device-credential-electron-phase-v1',
    phase,
    runtime,
    pid: process.pid,
    passed: true,
    code: 'device_credential_phase_passed',
    factoryHash,
    realElectronSafeStorage: true,
    encryptionAvailable: true,
    crossProcessDecryptionVerified: phase === 'consumer',
    rejectionCount,
    windowsCreated,
    webContentsCreated,
    fixtureNetworkCalls: networkCalls,
    modelCalls: 0,
    chatClientsLoaded: false,
    mainApplicationLoaded: false,
    rendererLoaded: false,
    nativeAdapterLoaded: false,
    installedApplicationVerified: false,
    cleanPcVerified: false,
    realCustomerVerified: false,
    multiComputerVerified: false
  }
  await writePrivate(join(directory, `${phase}.json`), result)
  process.stdout.write(JSON.stringify(result) + '\n')
}

void main()
  .then(() => {
    process.exitCode = 0
  })
  .catch(() => {
    process.stdout.write(
      JSON.stringify({
        protocol: 'device-credential-electron-phase-v1',
        runtime,
        pid: process.pid,
        passed: false,
        code: failureCode
      }) + '\n'
    )
    process.exitCode = 1
  })
  .finally(() => {
    privatePermissions?.closePrivatePermissionWorker()
    app.quit()
  })
