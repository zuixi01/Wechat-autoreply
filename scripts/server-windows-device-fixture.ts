import { app, safeStorage } from 'electron'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import {
  AgentRegistration,
  serverOrigin,
  type DeviceStore,
  type EncryptedDeviceRecord
} from '../src/main/services/agent-registration'
import { createDeviceCredentialCipher } from '../src/main/services/device-credential-cipher'
import { DeviceScopeSchema, type DeviceScope } from '../src/shared/contracts/registration'
import { IdentitySchema, type Identity } from '../src/shared/contracts/identity'
import {
  closePrivatePermissionWorker,
  verifyPrivatePaths
} from '../src/core/persistence/private-backup-directory'

// Actual isolated Electron/DPAPI + HTTPS registration only. No application,
// renderer, native adapter, chat client, model provider or customer is loaded.
const Config = z.strictObject({
  protocol: z.literal('windows-device-connection-v1'),
  serverUrl: z.string().min(1).max(2048),
  cases: z
    .array(
      z.strictObject({
        code: z
          .string()
          .length(43)
          .regex(/^[A-Za-z0-9_-]{43}$/),
        scope: DeviceScopeSchema.omit({ agent_id: true })
      })
    )
    .length(2)
})
const DeviceRecord = z.strictObject({
  serverUrl: z.string().min(1).max(2048),
  scope: DeviceScopeSchema,
  encryptedCredential: z.string().min(1).max(87384)
})
const Identities = z.strictObject({
  protocol: z.literal('windows-device-identities-v1'),
  identities: z.array(IdentitySchema).length(2),
  leaseVersions: z.array(z.number().int().positive().safe()).length(2)
})
const runtime = {
  electron: process.versions.electron,
  node: process.versions.node,
  arch: process.arch,
  platform: process.platform
}
let windowsCreated = 0,
  webContentsCreated = 0
app.on('browser-window-created', () => windowsCreated++)
app.on('web-contents-created', () => webContentsCreated++)
const args = process.argv.slice(2)
let phase = 'invalid',
  failureCode = 'windows_device_connection_failed'

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}
function ordinaryPath(path: string, directory = false): void {
  const info = lstatSync(path)
  assert.equal(info.isSymbolicLink(), false)
  assert.equal(directory ? info.isDirectory() : info.isFile(), true)
  assert.equal(samePath(resolve(path), realpathSync(path)), true)
}
function privateJson(path: string): unknown {
  ordinaryPath(path)
  assert.ok(lstatSync(path).size <= 131072)
  return JSON.parse(readFileSync(path, 'utf8'))
}
function writeNewPrivate(path: string, value: unknown): void {
  ordinaryPath(dirname(path), true)
  const bytes = JSON.stringify(value) + '\n'
  assert.ok(Buffer.byteLength(bytes, 'utf8') <= 131072)
  const descriptor = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(descriptor, bytes, 'utf8')
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  ordinaryPath(path)
}

async function main(): Promise<void> {
  assert.equal(args.length, 2)
  assert.ok(['producer', 'restart', 'revoked'].includes(args[0]))
  phase = args[0]
  const directory = resolve(args[1]),
    entry = resolve(process.argv[1])
  assert.equal(samePath(dirname(entry), directory), true)
  assert.equal(process.platform, 'win32')
  ordinaryPath(directory, true)
  ordinaryPath(entry)
  const userData = join(directory, 'user-data')
  ordinaryPath(userData, true)
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-background-networking')
  const configPath = join(directory, 'config.private.json')
  const recordPaths = [0, 1].map((index) => join(directory, `device-${index}.private.json`))
  const identitiesPath = join(directory, 'identities.private.json')
  const checkedFiles = (): string[] => [
    entry,
    userData,
    configPath,
    ...recordPaths.filter(existsSync),
    ...(existsSync(identitiesPath) ? [identitiesPath] : [])
  ]
  const checkPrivate = (): Promise<void> => verifyPrivatePaths(directory, checkedFiles())
  await checkPrivate()
  const config = Config.parse(privateJson(configPath))
  const origin = serverOrigin(config.serverUrl, false),
    url = new URL(origin)
  assert.equal(config.serverUrl, origin)
  assert.ok(['127.0.0.1', '[::1]'].includes(url.hostname))
  assert.equal(url.protocol, 'https:')
  assert.equal(config.cases[0].scope.tenant_id, config.cases[1].scope.tenant_id)
  assert.notEqual(config.cases[0].scope.account_id, config.cases[1].scope.account_id)
  assert.notEqual(config.cases[0].scope.employee_id, config.cases[1].scope.employee_id)
  await app.whenReady()
  failureCode = 'windows_device_safe_storage_unavailable'
  assert.equal(safeStorage.isEncryptionAvailable(), true)
  const cipher = createDeviceCredentialCipher(safeStorage)
  assert.equal(cipher.available(), true)
  failureCode = 'windows_device_connection_failed'
  let requests = 0,
    transportAttempts = 0
  const observations: { path: string; status: number; code: unknown }[] = []
  const actualFetch = globalThis.fetch
  const transport: typeof fetch = async (input, init) => {
    transportAttempts++ // A wrong-context call must never even reach this guard.
    const target = new URL(input instanceof Request ? input.url : String(input))
    assert.equal(target.origin, origin)
    assert.equal(target.username, '')
    assert.equal(target.password, '')
    assert.equal(target.search, '')
    assert.equal(target.hash, '')
    assert.ok(
      ['/v1/devices/register', '/v1/device', '/v1/leases/acquire', '/v1/configuration'].includes(
        target.pathname
      )
    )
    requests++
    const response = await actualFetch(input, init)
    let code: unknown = null
    if (!response.ok) {
      const body = (await response.clone().json()) as { error?: unknown }
      code = body.error
    }
    observations.push({ path: target.pathname, status: response.status, code })
    return response
  }
  const store = (index: number): DeviceStore => ({
    load: () =>
      existsSync(recordPaths[index])
        ? DeviceRecord.parse(privateJson(recordPaths[index]))
        : undefined,
    save: (record) => writeNewPrivate(recordPaths[index], DeviceRecord.parse(record))
  })
  const devices = config.cases.map(
    (_, index) => new AgentRegistration(store(index), cipher, transport)
  )
  const assertScope = (index: number, scope: DeviceScope): void => {
    const { agent_id, ...binding } = scope
    assert.deepEqual(binding, config.cases[index].scope)
    assert.ok(z.uuid().safeParse(agent_id).success)
  }
  const connected = async (index: number): Promise<DeviceScope> => {
    await checkPrivate()
    const status = await devices[index].refresh()
    assert.equal(status.state, 'connected')
    assert.ok(status.scope)
    assertScope(index, status.scope)
    assert.equal(Object.hasOwn(status, 'credential'), false)
    assert.equal(Object.hasOwn(status, 'encryptedCredential'), false)
    return status.scope
  }
  const phaseResult: Record<string, boolean | number> = {}
  if (phase === 'producer') {
    assert.equal(recordPaths.some(existsSync), false)
    assert.equal(existsSync(identitiesPath), false)
    for (let index = 0; index < devices.length; index++) {
      await checkPrivate()
      const result = await devices[index].register({
        serverUrl: origin,
        enrollmentCode: config.cases[index].code
      })
      assert.equal(result.success, true)
      assert.equal(Object.hasOwn(result, 'credential'), false)
      await checkPrivate() // Verify inherited Windows ACL after synchronous save.
      assertScope(index, DeviceRecord.parse(privateJson(recordPaths[index])).scope)
      await connected(index)
    }
    const replay = new AgentRegistration(
      {
        load: () => undefined,
        save: () => {
          throw new Error('windows_device_replay_store_forbidden')
        }
      },
      cipher,
      transport
    )
    assert.deepEqual(
      await replay.register({ serverUrl: origin, enrollmentCode: config.cases[0].code }),
      { success: false, code: 'registration_failed' }
    )
    assert.deepEqual(observations.at(-1), {
      path: '/v1/devices/register',
      status: 401,
      code: 'DENIED'
    })
    phaseResult.registrationVerified = true
    phaseResult.oneUseEnrollmentVerified = true
    phaseResult.refreshVerified = true
  } else if (phase === 'restart') {
    const identities: Identity[] = []
    const leaseVersions: number[] = []
    for (let index = 0; index < devices.length; index++) {
      const scope = await connected(index)
      const identity = IdentitySchema.parse({
        tenantId: scope.tenant_id,
        employeeId: scope.employee_id,
        accountId: scope.account_id,
        agentId: scope.agent_id,
        platform: scope.platform,
        loginEpoch: 1,
        clientInstanceId: randomUUID()
      })
      identities.push(identity)
      const lease = await devices[index].acquireLease(identity)
      assert.deepEqual(lease.identity, identity)
      const renewed = await devices[index].acquireLease(identity)
      assert.equal(renewed.version, lease.version)
      leaseVersions.push(renewed.version)
    }
    await assert.rejects(
      devices[0].acquireLease({ ...identities[0], clientInstanceId: randomUUID() }),
      { code: 'TASK_INVALIDATED' }
    )
    assert.deepEqual(observations.at(-1), {
      path: '/v1/leases/acquire',
      status: 409,
      code: 'LEASE_CONFLICT'
    })
    const beforeCrossScope = transportAttempts
    await assert.rejects(devices[0].acquireLease(identities[1]), { code: 'DEVICE_SCOPE_CHANGED' })
    assert.equal(transportAttempts, beforeCrossScope)
    await assert.rejects(devices[0].configuration(), { code: 'UNAVAILABLE' })
    assert.deepEqual(observations.at(-1), {
      path: '/v1/configuration',
      status: 503,
      code: 'generation_not_configured'
    })
    const record = DeviceRecord.parse(privateJson(recordPaths[0]))
    const differentPort = Number(url.port) === 65535 ? 65534 : Number(url.port) + 1
    const changedOrigin = `https://127.0.0.1:${differentPort}`
    assert.equal(new URL(changedOrigin).origin, changedOrigin)
    assert.notEqual(changedOrigin, origin)
    const mutations: EncryptedDeviceRecord[] = [
      { ...structuredClone(record), serverUrl: changedOrigin }
    ]
    for (const field of Object.keys(DeviceScopeSchema.shape) as (keyof DeviceScope)[]) {
      const changed = structuredClone(record)
      if (field === 'platform')
        changed.scope.platform = changed.scope.platform === 'wechat' ? 'wework' : 'wechat'
      else changed.scope[field] = `changed-${field}`
      mutations.push(changed)
    }
    const beforeMutations = transportAttempts
    for (const changed of mutations) {
      const mirror = new AgentRegistration(
        {
          load: () => structuredClone(changed),
          save: () => {
            throw new Error('windows_device_mirror_write_forbidden')
          }
        },
        cipher,
        transport
      )
      assert.equal((await mirror.refresh()).state, 'unavailable')
      assert.equal(transportAttempts, beforeMutations)
    }
    assert.equal(mutations.length, 6)
    await connected(0) // Original file/envelope still works and was never overwritten.
    // Refresh the actual ten-second leases immediately before the next native
    // Electron phase. Expiry still fails the same-version assertion honestly.
    for (let index = 0; index < devices.length; index++) {
      const renewed = await devices[index].acquireLease(identities[index])
      assert.equal(renewed.version, leaseVersions[index])
      leaseVersions[index] = renewed.version
    }
    await checkPrivate()
    writeNewPrivate(
      identitiesPath,
      Identities.parse({ protocol: 'windows-device-identities-v1', identities, leaseVersions })
    )
    await checkPrivate()
    Object.assign(phaseResult, {
      crossProcessDecryptionVerified: true,
      leaseRenewalVerified: true,
      leaseConflictRejected: true,
      crossScopeRejectedBeforeRequest: true,
      contextRejectionsBeforeRequest: 6,
      generationNotConfiguredVerified: true
    })
  } else {
    const saved = Identities.parse(privateJson(identitiesPath))
    const revoked = await devices[0].refresh()
    assert.equal(revoked.state, 'unavailable')
    assert.deepEqual(observations.at(-1), { path: '/v1/device', status: 401, code: 'DENIED' })
    await assert.rejects(devices[0].acquireLease(saved.identities[0]), {
      code: 'AUTHORIZATION_FAILED'
    })
    assert.deepEqual(observations.at(-1), {
      path: '/v1/leases/acquire',
      status: 401,
      code: 'DENIED'
    })
    await connected(1)
    const lease = await devices[1].acquireLease(saved.identities[1])
    assert.deepEqual(lease.identity, saved.identities[1])
    assert.equal(lease.version, saved.leaseVersions[1])
    Object.assign(phaseResult, {
      revokedCredentialRejected: true,
      otherEmployeeUnaffected: true,
      sameLeaseVersionVerified: true
    })
  }
  await checkPrivate()
  assert.equal(windowsCreated, 0)
  assert.equal(webContentsCreated, 0)
  const summary = {
    protocol: 'windows-device-connection-phase-v1',
    phase,
    runtime,
    pid: process.pid,
    fixtureSha256: createHash('sha256').update(readFileSync(entry)).digest('hex'),
    passed: true,
    code: 'windows_device_connection_phase_passed',
    actualElectronSafeStorage: true,
    localCipherMock: false,
    requests,
    windowsCreated,
    webContentsCreated,
    modelCalls: 0,
    clientOperations: 0,
    installedDesktopVerified: false,
    ...phaseResult
  }
  writeNewPrivate(join(directory, `${phase}.json`), summary)
  await verifyPrivatePaths(directory, [...checkedFiles(), join(directory, `${phase}.json`)])
  process.stdout.write(JSON.stringify(summary) + '\n')
}

void main()
  .catch(() => {
    process.exitCode = 1
    process.stdout.write(
      JSON.stringify({
        protocol: 'windows-device-connection-phase-v1',
        phase,
        runtime,
        pid: process.pid,
        passed: false,
        code: failureCode
      }) + '\n'
    )
  })
  .finally(() => {
    closePrivatePermissionWorker()
    app.quit()
  })
