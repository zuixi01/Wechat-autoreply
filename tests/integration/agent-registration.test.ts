import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentRegistration,
  serverOrigin,
  type EncryptedDeviceRecord
} from '../../src/main/services/agent-registration'
import { createDeviceCredentialCipher } from '../../src/main/services/device-credential-cipher'

const token = 'A'.repeat(43)
afterEach(() => vi.useRealTimers())
const scope = {
  tenant_id: 'company',
  employee_id: 'employee-A',
  account_id: 'account-A',
  agent_id: 'agent-A',
  platform: 'wework' as const
}
function fixture() {
  let record: EncryptedDeviceRecord | undefined
  const save = vi.fn((next: EncryptedDeviceRecord) => {
    record = next
  })
  const cipher = {
    available: vi.fn(() => true),
    encrypt: vi.fn(() => 'test-ciphertext'),
    decrypt: vi.fn(() => token)
  }
  const transport = vi.fn<typeof fetch>(async () => Response.json({ credential: token, scope }))
  const client = new AgentRegistration({ load: () => record, save }, cipher, transport, true)
  return { client, save, cipher, transport, record: () => record }
}
describe('main-process device registration and credential handling', () => {
  it('returns only public scope and stores encrypted credentials', async () => {
    const f = fixture()
    const result = await f.client.register({
      serverUrl: 'https://enterprise.example',
      enrollmentCode: token
    })
    expect(result).toMatchObject({ success: true, status: { state: 'connected', scope } })
    expect(JSON.stringify(result)).not.toContain(token)
    expect(JSON.stringify(f.client.status())).not.toContain('test-ciphertext')
    expect(f.record()?.encryptedCredential).toBe('test-ciphertext')
    expect(f.transport.mock.calls[0][1]?.redirect).toBe('manual')
    expect(JSON.parse(String(f.transport.mock.calls[0][1]?.body))).toMatchObject({
      enrollmentCode: token
    })
    expect(f.cipher.encrypt).toHaveBeenCalledWith(token, {
      serverUrl: 'https://enterprise.example',
      scope
    })
  })
  it.each([
    'http://external.example',
    'https://user:password@enterprise.example',
    'https://enterprise.example/path',
    'https://enterprise.example?credential=secret'
  ])('rejects an insecure or ambiguous service URL %s', async (url) => {
    const f = fixture()
    expect(await f.client.register({ serverUrl: url, enrollmentCode: token })).toMatchObject({
      success: false
    })
    expect(f.transport).not.toHaveBeenCalled()
  })
  it('allows loopback HTTP only when development explicitly permits it', () => {
    expect(serverOrigin('http://127.0.0.1:4782', true)).toBe('http://127.0.0.1:4782')
    expect(() => serverOrigin('http://127.0.0.1:4782', false)).toThrow('insecure_server')
  })
  it('refuses plaintext storage when OS encryption is unavailable', async () => {
    const f = fixture()
    f.cipher.available.mockReturnValue(false)
    expect(
      await f.client.register({ serverUrl: 'https://enterprise.example', enrollmentCode: token })
    ).toEqual({ success: false, code: 'storage_unavailable' })
    expect(f.transport).not.toHaveBeenCalled()
    expect(f.save).not.toHaveBeenCalled()
  })
  it('does not follow a redirect or retry a possibly consumed enrollment code', async () => {
    const f = fixture()
    f.transport.mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: 'https://untrusted.example' } })
    )
    expect(
      await f.client.register({ serverUrl: 'https://enterprise.example', enrollmentCode: token })
    ).toMatchObject({ success: false })
    expect(f.transport).toHaveBeenCalledTimes(1)
    expect(f.save).not.toHaveBeenCalled()
  })
  it('rejects extra credential-bearing response data rather than sending it to the renderer', async () => {
    const f = fixture()
    f.transport.mockResolvedValue(
      Response.json({ credential: token, scope, other_customer: 'private' })
    )
    expect(
      await f.client.register({ serverUrl: 'https://enterprise.example', enrollmentCode: token })
    ).toMatchObject({ success: false })
    expect(f.save).not.toHaveBeenCalled()
  })
  it('keeps refresh credentials in the main process and verifies the returned scope', async () => {
    const f = fixture()
    await f.client.register({ serverUrl: 'https://enterprise.example', enrollmentCode: token })
    f.transport.mockResolvedValue(Response.json(scope))
    expect(await f.client.refresh()).toMatchObject({ state: 'connected', scope })
    expect(f.cipher.decrypt).toHaveBeenCalledWith('test-ciphertext', {
      serverUrl: 'https://enterprise.example',
      scope
    })
    expect(f.transport.mock.calls[1][1]?.headers).toEqual({ Authorization: `Bearer ${token}` })
    f.transport.mockResolvedValue(Response.json({ ...scope, account_id: 'other-account' }))
    expect(await f.client.refresh()).toMatchObject({ state: 'unavailable' })
  })
  it('times out a transport that ignores cancellation and never saves its late result', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let finish!: (value: Response) => void
    f.transport.mockReturnValue(
      new Promise<Response>((resolve) => {
        finish = resolve
      })
    )
    const pending = f.client.register({
      serverUrl: 'https://enterprise.example',
      enrollmentCode: token
    })
    await vi.advanceTimersByTimeAsync(5000)
    expect(await pending).toEqual({ success: false, code: 'registration_failed' })
    finish(Response.json({ credential: token, scope }))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.save).not.toHaveBeenCalled()
  })
  it('rejects an oversized streaming response before accepting any credential', async () => {
    const f = fixture()
    f.transport.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(65537))
            controller.close()
          }
        })
      )
    )
    expect(
      await f.client.register({ serverUrl: 'https://enterprise.example', enrollmentCode: token })
    ).toEqual({ success: false, code: 'registration_failed' })
    expect(f.save).not.toHaveBeenCalled()
  })
})

describe('registration with the production contextual credential cipher', () => {
  // Only the OS encryption primitive is a test double. The actual envelope,
  // scope/origin checks and registration request path are production code.
  // These tests cannot prove Windows DPAPI or another user's access boundary.
  function contextualFixture() {
    let record: EncryptedDeviceRecord | undefined
    const payloads = new Map<string, string>()
    const storage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => {
        const ciphertext = Buffer.from(`fake-os-cipher-${payloads.size}`)
        payloads.set(ciphertext.toString('base64'), value)
        return ciphertext
      },
      decryptString: (value: Buffer) => {
        const plaintext = payloads.get(value.toString('base64'))
        if (plaintext === undefined) throw new Error('fake_os_decryption_failed')
        return plaintext
      }
    }
    const transport = vi.fn<typeof fetch>(async () => Response.json({ credential: token, scope }))
    const client = new AgentRegistration(
      {
        load: () => record,
        save: (next) => {
          record = next
        }
      },
      createDeviceCredentialCipher(storage, 'win32'),
      transport
    )
    return { client, storage, transport, record: () => record! }
  }

  async function enrolled() {
    const f = contextualFixture()
    expect(
      await f.client.register({
        serverUrl: 'https://enterprise.example',
        enrollmentCode: token
      })
    ).toMatchObject({ success: true })
    f.transport.mockClear()
    return f
  }

  it('refreshes only after the real envelope confirms the original origin and employee scope', async () => {
    const f = await enrolled()
    f.transport.mockResolvedValue(Response.json(scope))
    expect(await f.client.refresh()).toMatchObject({ state: 'connected', scope })
    expect(f.transport).toHaveBeenCalledTimes(1)
    expect(String(f.transport.mock.calls[0][0])).toBe('https://enterprise.example/v1/device')
    expect(f.transport.mock.calls[0][1]?.headers).toEqual({ Authorization: `Bearer ${token}` })
  })

  it.each(['serverUrl', 'tenant_id', 'employee_id', 'account_id', 'agent_id', 'platform'] as const)(
    'refuses changed %s before refresh or an authorized request can transmit the token',
    async (field) => {
      const f = await enrolled()
      if (field === 'serverUrl') f.record().serverUrl = 'https://changed-service.example'
      else if (field === 'platform') f.record().scope.platform = 'wechat'
      else f.record().scope[field] = 'changed-identity'
      expect(await f.client.refresh()).toMatchObject({ state: 'unavailable' })
      await expect(f.client.configuration()).rejects.toMatchObject({ code: 'NOT_REGISTERED' })
      expect(f.transport).not.toHaveBeenCalled()
    }
  )

  it('refuses an old bare-token ciphertext without silent migration or any authenticated request', async () => {
    const f = await enrolled()
    f.record().encryptedCredential = f.storage.encryptString(token).toString('base64')
    expect(await f.client.refresh()).toMatchObject({ state: 'unavailable' })
    await expect(f.client.configuration()).rejects.toMatchObject({ code: 'NOT_REGISTERED' })
    expect(f.transport).not.toHaveBeenCalled()
  })

  it('refuses damaged ciphertext without a plaintext fallback', async () => {
    const f = await enrolled()
    f.record().encryptedCredential = Buffer.from('unknown-ciphertext').toString('base64')
    expect(await f.client.refresh()).toMatchObject({ state: 'unavailable' })
    await expect(f.client.configuration()).rejects.toMatchObject({ code: 'NOT_REGISTERED' })
    expect(f.transport).not.toHaveBeenCalled()
  })
})
