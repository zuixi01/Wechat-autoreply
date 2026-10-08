import { describe, expect, it, vi } from 'vitest'
import {
  createDeviceCredentialCipher,
  type DeviceCredentialContext
} from '../../src/main/services/device-credential-cipher'

// Fake storage exposes the envelope in plaintext. These unit tests establish
// binding/format checks only; they do not prove Electron, Windows or DPAPI.
const token = 'A'.repeat(43)
const context: DeviceCredentialContext = {
  serverUrl: 'https://enterprise.example:4782',
  scope: {
    tenant_id: 'company',
    employee_id: 'employee',
    account_id: 'account',
    agent_id: 'agent',
    platform: 'wework'
  }
}
function encoded(plaintext: string): string {
  return Buffer.from(`fake:${plaintext}`, 'utf8').toString('base64')
}
function fixture(platform: NodeJS.Platform = 'win32') {
  const storage = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`fake:${value}`, 'utf8')),
    decryptString: vi.fn((bytes: Buffer) => {
      const value = bytes.toString('utf8')
      if (!value.startsWith('fake:')) throw new Error('synthetic OS private diagnostic')
      return value.slice(5)
    })
  }
  const cipher = createDeviceCredentialCipher(storage, platform)
  return { cipher, storage }
}
function envelope() {
  return {
    protocol: 'autoreply-device-credential-v1',
    ...structuredClone(context),
    credential: token
  }
}

describe('device credential binding with fake storage, not Windows DPAPI proof', () => {
  it('encrypts the strict versioned binding and roundtrips only with its context', () => {
    const { cipher, storage } = fixture()
    const encrypted = cipher.encrypt(token, context)
    expect(cipher.available()).toBe(true)
    expect(JSON.parse(storage.encryptString.mock.calls[0][0])).toEqual(envelope())
    expect(cipher.decrypt(encrypted, context)).toBe(token)
    expect(storage.decryptString).toHaveBeenCalledWith(Buffer.from(encrypted, 'base64'))
  })
  it('permits semantically identical scope key ordering and canonical origin spelling', () => {
    const { cipher } = fixture()
    const encrypted = cipher.encrypt(token, {
      ...context,
      serverUrl: 'HTTPS://Enterprise.Example:4782/'
    })
    const reordered = Object.fromEntries(
      Object.entries(context.scope).reverse()
    ) as typeof context.scope
    expect(cipher.decrypt(encrypted, { ...context, scope: reordered })).toBe(token)
  })
  it.each(['http://127.0.0.1:4782', 'http://[::1]:4782'])(
    'supports bounded development loopback binding %s',
    (serverUrl) => {
      const { cipher } = fixture()
      const bound = { ...context, serverUrl }
      expect(cipher.decrypt(cipher.encrypt(token, bound), bound)).toBe(token)
    }
  )
  it.each(['tenant_id', 'employee_id', 'account_id', 'agent_id', 'platform'] as const)(
    'rejects changing scope field %s',
    (field) => {
      const { cipher } = fixture(),
        encrypted = cipher.encrypt(token, context)
      const scope = {
        ...context.scope,
        [field]: field === 'platform' ? 'wechat' : 'other'
      } as typeof context.scope
      expect(() => cipher.decrypt(encrypted, { ...context, scope })).toThrow(
        'device_credential_invalid'
      )
    }
  )
  it.each([
    'https://other.example:4782',
    'https://enterprise.example:4783',
    'http://127.0.0.1:4782'
  ])('rejects moving ciphertext to origin %s', (serverUrl) => {
    const { cipher } = fixture(),
      encrypted = cipher.encrypt(token, context)
    expect(() => cipher.decrypt(encrypted, { ...context, serverUrl })).toThrow(
      'device_credential_invalid'
    )
  })
  it.each([
    'http://remote.example',
    'https://user:secret@enterprise.example',
    'https://enterprise.example/path',
    'https://enterprise.example?',
    'https://enterprise.example#',
    'file:///C:/private'
  ])('rejects unsafe or ambiguous context URL %s before OS storage', (serverUrl) => {
    const { cipher, storage } = fixture()
    expect(() => cipher.encrypt(token, { ...context, serverUrl })).toThrow(
      'device_credential_invalid'
    )
    expect(() =>
      cipher.decrypt(encoded(JSON.stringify(envelope())), { ...context, serverUrl })
    ).toThrow('device_credential_invalid')
    expect(storage.encryptString).not.toHaveBeenCalled()
    expect(storage.decryptString).not.toHaveBeenCalled()
  })
  it('rejects unknown scope/context fields and missing context without a fallback', () => {
    const { cipher, storage } = fixture()
    const scope = { ...context.scope, customer: 'private-extra-field' }
    expect(() => cipher.encrypt(token, { ...context, scope })).toThrow('device_credential_invalid')
    expect(() =>
      cipher.encrypt(token, { ...context, secret: 'private-extra' } as DeviceCredentialContext)
    ).toThrow('device_credential_invalid')
    expect(() =>
      cipher.decrypt(encoded(token), undefined as unknown as DeviceCredentialContext)
    ).toThrow('device_credential_invalid')
    expect(storage.decryptString).not.toHaveBeenCalled()
  })
  it.each(['', ' ', 'Zg', 'Zg=', 'Zh==', 'Zg===', 'Zg==\n', 'AA-_', '%%%%'])(
    'rejects empty or noncanonical base64 %j before OS decryption',
    (value) => {
      const { cipher, storage } = fixture()
      expect(() => cipher.decrypt(value, context)).toThrow('device_credential_invalid')
      expect(storage.decryptString).not.toHaveBeenCalled()
    }
  )
  it('rejects ciphertext larger than 64 KiB and oversized OS encryption output', () => {
    const { cipher, storage } = fixture()
    expect(() => cipher.decrypt(Buffer.alloc(65537).toString('base64'), context)).toThrow(
      'device_credential_invalid'
    )
    expect(storage.decryptString).not.toHaveBeenCalled()
    storage.encryptString.mockReturnValue(Buffer.alloc(65537))
    expect(() => cipher.encrypt(token, context)).toThrow('device_credential_invalid')
    storage.encryptString.mockReturnValue(Buffer.alloc(0))
    expect(() => cipher.encrypt(token, context)).toThrow('device_credential_invalid')
  })
  it.each([
    token,
    JSON.stringify(token),
    JSON.stringify({ ...context, credential: token }),
    JSON.stringify({ ...envelope(), protocol: 'old-version' }),
    JSON.stringify({ ...envelope(), unknownPrivateText: 'secret' })
  ])('rejects legacy/unknown decrypted envelopes without migration or fallback', (plaintext) => {
    const { cipher } = fixture()
    expect(() => cipher.decrypt(encoded(plaintext), context)).toThrow('device_credential_invalid')
  })
  it('rejects decrypted documents over the 16 KiB UTF8 limit, including multibyte data', () => {
    const { cipher, storage } = fixture()
    storage.decryptString.mockReturnValue('中'.repeat(5500))
    expect(() => cipher.decrypt(encoded('small ciphertext'), context)).toThrow(
      'device_credential_invalid'
    )
  })
  it.each([
    '',
    'A'.repeat(42),
    'A'.repeat(44),
    '+'.repeat(43),
    'A'.repeat(42) + '\n',
    'A'.repeat(43) + '\n'
  ])('rejects malformed tokens on encryption and decryption', (credential) => {
    const { cipher, storage } = fixture()
    expect(() => cipher.encrypt(credential, context)).toThrow('device_credential_invalid')
    expect(storage.encryptString).not.toHaveBeenCalled()
    expect(() =>
      cipher.decrypt(encoded(JSON.stringify({ ...envelope(), credential })), context)
    ).toThrow('device_credential_invalid')
  })
  it.each(['linux', 'darwin'] as const)(
    'refuses non-Windows platform %s even when fake OS encryption is available',
    (platform) => {
      const { cipher, storage } = fixture(platform)
      expect(cipher.available()).toBe(false)
      expect(() => cipher.encrypt(token, context)).toThrow('device_credential_unavailable')
      expect(() => cipher.decrypt(encoded(JSON.stringify(envelope())), context)).toThrow(
        'device_credential_unavailable'
      )
      expect(storage.isEncryptionAvailable).not.toHaveBeenCalled()
      expect(storage.encryptString).not.toHaveBeenCalled()
      expect(storage.decryptString).not.toHaveBeenCalled()
    }
  )
  it('requires actual OS availability, including loss of availability after encryption', () => {
    const { cipher, storage } = fixture()
    const encrypted = cipher.encrypt(token, context)
    storage.isEncryptionAvailable.mockReturnValue(false)
    expect(cipher.available()).toBe(false)
    expect(() => cipher.decrypt(encrypted, context)).toThrow('device_credential_unavailable')
    expect(() => cipher.encrypt(token, context)).toThrow('device_credential_unavailable')
    expect(storage.decryptString).not.toHaveBeenCalled()
  })
  it('sanitizes availability and storage exceptions without secret or OS diagnostics', () => {
    const { cipher, storage } = fixture()
    const sensitive = `${token} synthetic OS private diagnostic`
    storage.isEncryptionAvailable.mockImplementationOnce(() => {
      throw new Error(sensitive)
    })
    expect(cipher.available()).toBe(false)
    storage.encryptString.mockImplementation(() => {
      throw new Error(sensitive)
    })
    storage.decryptString.mockImplementation(() => {
      throw new Error(sensitive)
    })
    for (const action of [
      () => cipher.encrypt(token, context),
      () => cipher.decrypt(encoded(JSON.stringify(envelope())), context)
    ]) {
      try {
        action()
        throw new Error('expected storage rejection')
      } catch (error) {
        expect((error as Error).message).toBe('device_credential_unavailable')
        expect(String(error)).not.toContain(token)
        expect(String(error)).not.toContain('OS private diagnostic')
      }
    }
  })
})
