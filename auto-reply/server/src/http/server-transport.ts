import { readFile } from 'node:fs/promises'
import { createSecureContext } from 'node:tls'

export interface ServiceTransportInput {
  host: string
  port: number
  certificatePath?: string
  keyPath?: string
  allowLocalHttp: boolean
}
export interface ServiceTransport {
  host: string
  port: number
  tls?: { cert: Buffer; key: Buffer }
}

/** Validate the listener before opening a database pool or starting background work.
 * A broken TLS configuration must never silently become an HTTP listener. */
export async function loadServiceTransport(
  input: ServiceTransportInput
): Promise<ServiceTransport> {
  if (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65535)
    throw new Error('invalid_port')
  if (!input.host || input.host !== input.host.trim()) throw new Error('invalid_host')
  const certificate = input.certificatePath
  const key = input.keyPath
  if (Boolean(certificate) !== Boolean(key)) throw new Error('tls_pair_required')
  if (!certificate || !key) {
    if (!input.allowLocalHttp || !['127.0.0.1', '::1'].includes(input.host))
      throw new Error('https_required')
    return { host: input.host, port: input.port }
  }
  const [cert, privateKey] = await Promise.all([readFile(certificate), readFile(key)])
  createSecureContext({ cert, key: privateKey })
  return { host: input.host, port: input.port, tls: { cert, key: privateKey } }
}
