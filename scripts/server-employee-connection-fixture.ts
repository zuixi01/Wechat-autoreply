import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  AgentRegistration,
  type EncryptedDeviceRecord
} from '../src/main/services/agent-registration'
import type { Identity } from '../src/shared/contracts/identity'
import type { DeviceScope } from '../src/shared/contracts/registration'

interface Case {
  code: string
  scope: Omit<DeviceScope, 'agent_id'>
}

async function main(): Promise<void> {
  const packet = JSON.parse(process.env.AUTOREPLY_EMPLOYEE_TLS_FIXTURE ?? '') as {
    serverUrl: string
    cases: Case[]
    paused?: boolean
  }
  assert.equal(packet.cases.length, 2)
  let requests = 0
  const configurationResponses: { status: number; code: unknown }[] = []
  const leaseResponses: { status: number; code: unknown }[] = []
  const transport: typeof fetch = async (input, init) => {
    requests++
    const response = await fetch(input, init)
    const url = input instanceof Request ? input.url : String(input)
    if (new URL(url).pathname === '/v1/configuration') {
      const body = (await response.clone().json()) as { error?: unknown }
      configurationResponses.push({ status: response.status, code: body.error })
    }
    if (packet.paused && new URL(url).pathname === '/v1/leases/acquire') {
      const body = (await response.clone().json()) as { error?: unknown }
      leaseResponses.push({ status: response.status, code: body.error })
    }
    return response
  }
  const createDevice = (): AgentRegistration => {
    let stored: EncryptedDeviceRecord | undefined
    const secrets = new Map<string, string>()
    return new AgentRegistration(
      {
        load: () => stored && structuredClone(stored),
        save: (record) => {
          stored = structuredClone(record)
        }
      },
      {
        available: () => true,
        encrypt: (value) => {
          const handle = randomUUID()
          secrets.set(handle, value)
          return handle
        },
        decrypt: (handle) => {
          const value = secrets.get(handle)
          if (!value) throw new Error('fixture_secret_missing')
          return value
        }
      },
      transport
    )
  }
  const devices = packet.cases.map(createDevice)
  const identities: Identity[] = []
  for (let index = 0; index < devices.length; index++) {
    const device = devices[index],
      expected = packet.cases[index]
    const result = await device.register({
      serverUrl: packet.serverUrl,
      enrollmentCode: expected.code
    })
    assert.equal(result.success, true)
    const current = await device.refresh()
    assert.equal(current.state, 'connected')
    assert.ok(current.scope)
    const { agent_id: agentId, ...scope } = current.scope
    assert.deepEqual(scope, expected.scope)
    assert.equal(Object.hasOwn(current, 'credential'), false)
    assert.equal(Object.hasOwn(current, 'encryptedCredential'), false)
    identities.push({
      tenantId: scope.tenant_id,
      employeeId: scope.employee_id,
      accountId: scope.account_id,
      agentId,
      platform: scope.platform,
      loginEpoch: 1,
      clientInstanceId: randomUUID()
    })
  }
  assert.notEqual(identities[0].agentId, identities[1].agentId)
  const replay = await createDevice().register({
    serverUrl: packet.serverUrl,
    enrollmentCode: packet.cases[0].code
  })
  assert.deepEqual(replay, { success: false, code: 'registration_failed' })
  if (packet.paused) {
    for (let index = 0; index < devices.length; index++)
      await assert.rejects(devices[index].acquireLease(identities[index]), {
        code: 'TASK_INVALIDATED'
      })
    assert.deepEqual(leaseResponses, [
      { status: 409, code: 'PAUSED' },
      { status: 409, code: 'PAUSED' }
    ])
    assert.ok(process.connected)
    process.disconnect()
    process.stdout.write(
      JSON.stringify({
        employees: 2,
        registrationVerified: true,
        oneUseEnrollmentVerified: true,
        refreshVerified: true,
        pausedAccountsBlocked: true,
        leaseGranted: false,
        localCipherMock: true,
        installedDesktopVerified: false,
        modelsCalled: false,
        clientOperations: false,
        requests
      }) + '\n'
    )
    return
  }
  const leases = await Promise.all(
    devices.map((device, index) => device.acquireLease(identities[index]))
  )
  assert.notEqual(leases[0].leaseId, leases[1].leaseId)
  for (let index = 0; index < devices.length; index++) {
    assert.deepEqual(leases[index].identity, identities[index])
    const renewed = await devices[index].acquireLease(identities[index])
    assert.equal(renewed.version, leases[index].version)
  }
  await assert.rejects(
    devices[0].acquireLease({ ...identities[0], clientInstanceId: randomUUID() }),
    { code: 'TASK_INVALIDATED' }
  )
  const before = requests
  await assert.rejects(devices[0].acquireLease(identities[1]), { code: 'DEVICE_SCOPE_CHANGED' })
  assert.equal(requests, before)
  await assert.rejects(devices[0].configuration(), { code: 'UNAVAILABLE' })
  assert.deepEqual(configurationResponses, [{ status: 503, code: 'generation_not_configured' }])
  assert.ok(process.send && process.connected)
  const revokeAcknowledged = new Promise<void>((accept, reject) => {
    process.once('message', (message) => {
      if (message === 'revoked') accept()
      else reject(new Error('fixture_revoke_failed'))
    })
  })
  process.send({ kind: 'revoke', agentId: identities[0].agentId })
  await revokeAcknowledged
  assert.equal((await devices[0].refresh()).state, 'unavailable')
  await assert.rejects(devices[0].acquireLease(identities[0]), { code: 'AUTHORIZATION_FAILED' })
  assert.equal((await devices[1].refresh()).state, 'connected')
  await devices[1].acquireLease(identities[1])
  process.disconnect()
  process.stdout.write(
    JSON.stringify({
      employees: 2,
      platforms: ['wechat', 'wework'],
      registrationVerified: true,
      oneUseEnrollmentVerified: true,
      refreshVerified: true,
      leaseRenewalVerified: true,
      leaseConflictRejected: true,
      crossScopeRejectedBeforeRequest: true,
      revokedCredentialRejected: true,
      otherEmployeeUnaffected: true,
      generationUnavailable: true,
      generationNotConfiguredVerified: true,
      localCipherMock: true,
      installedDesktopVerified: false,
      modelsCalled: false,
      clientOperations: false,
      requests
    }) + '\n'
  )
}

void main().catch(() => {
  if (process.connected) process.disconnect()
  process.stderr.write('Employee TLS fixture failed.\n')
  process.exitCode = 1
})
