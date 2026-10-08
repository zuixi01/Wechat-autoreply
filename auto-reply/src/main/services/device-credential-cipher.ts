import { z } from 'zod'
import { DeviceScopeSchema, type DeviceScope } from '../../shared/contracts/registration'
import type { SecretCipher } from './agent-registration'

/** Structural subset of Electron safeStorage; no Electron import or fallback. */
export interface DeviceCredentialStorage {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}
export interface DeviceCredentialContext {
  serverUrl: string
  scope: DeviceScope
}
const MaximumCiphertextBytes = 65536
const MaximumPlaintextBytes = 16384
const MaximumBase64Characters = Math.ceil(MaximumCiphertextBytes / 3) * 4
const Token = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]{43}$/)
const Context = z.strictObject({
  serverUrl: z.string().min(1).max(2048),
  scope: DeviceScopeSchema
})
const Envelope = Context.extend({
  protocol: z.literal('autoreply-device-credential-v1'),
  credential: Token
})
function invalid(): never {
  throw new Error('device_credential_invalid')
}
function unavailable(): never {
  throw new Error('device_credential_unavailable')
}
function normalizedContext(raw: DeviceCredentialContext): DeviceCredentialContext {
  try {
    const context = Context.parse(raw)
    const url = new URL(context.serverUrl)
    if (
      context.serverUrl.includes('?') ||
      context.serverUrl.includes('#') ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
    )
      return invalid()
    // HTTP loopback is a development context. AgentRegistration independently
    // requires its explicit allowLocalHttp flag before using such an origin.
    return { serverUrl: url.origin, scope: context.scope }
  } catch {
    return invalid()
  }
}
function decodeCiphertext(value: string): Buffer {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MaximumBase64Characters ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    return invalid()
  const bytes = Buffer.from(value, 'base64')
  if (
    bytes.length === 0 ||
    bytes.length > MaximumCiphertextBytes ||
    bytes.toString('base64') !== value
  )
    return invalid()
  return bytes
}

/** Windows DPAPI is supplied by the actual Electron safeStorage instance.
 * Legacy bare-token ciphertext is intentionally rejected: register again.
 * The public record's origin/scope cannot substitute for its encrypted binding. */
export function createDeviceCredentialCipher(
  storage: DeviceCredentialStorage,
  platform: NodeJS.Platform = process.platform
): SecretCipher {
  const available = (): boolean => {
    try {
      return platform === 'win32' && storage.isEncryptionAvailable() === true
    } catch {
      return false
    }
  }
  return {
    available,
    encrypt(value: string, context: DeviceCredentialContext): string {
      if (!available()) return unavailable()
      const bound = normalizedContext(context)
      if (!Token.safeParse(value).success) return invalid()
      const plaintext = JSON.stringify({
        protocol: 'autoreply-device-credential-v1',
        ...bound,
        credential: value
      })
      if (Buffer.byteLength(plaintext, 'utf8') > MaximumPlaintextBytes) return invalid()
      let bytes: Buffer
      try {
        bytes = storage.encryptString(plaintext)
      } catch {
        return unavailable()
      }
      if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MaximumCiphertextBytes)
        return invalid()
      return bytes.toString('base64')
    },
    decrypt(value: string, context: DeviceCredentialContext): string {
      if (!available()) return unavailable()
      const expected = normalizedContext(context)
      const bytes = decodeCiphertext(value)
      let plaintext: string
      try {
        plaintext = storage.decryptString(bytes)
      } catch {
        return unavailable()
      }
      if (
        typeof plaintext !== 'string' ||
        Buffer.byteLength(plaintext, 'utf8') > MaximumPlaintextBytes
      )
        return invalid()
      let envelope: z.infer<typeof Envelope>
      try {
        envelope = Envelope.parse(JSON.parse(plaintext))
      } catch {
        return invalid()
      }
      if (
        envelope.serverUrl !== expected.serverUrl ||
        (Object.keys(DeviceScopeSchema.shape) as (keyof DeviceScope)[]).some(
          (key) => envelope.scope[key] !== expected.scope[key]
        )
      )
        return invalid()
      return envelope.credential
    }
  }
}
