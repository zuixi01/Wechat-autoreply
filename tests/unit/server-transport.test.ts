import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve, join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer, get } from 'node:https'
import { createServer as createTcpServer, type Socket } from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadServiceTransport } from '../../server/src/http/server-transport'
import { certificate, privateKey } from '../fixtures/service-test-tls'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep + 'service-transport-'))
      throw new Error('invalid_fixture_directory')
    await rm(directory, { recursive: true, force: true })
  }
})
async function tlsFixture(key = privateKey) {
  const directory = await mkdtemp(join(tmpdir(), 'service-transport-'))
  directories.push(directory)
  const certificatePath = join(directory, 'test-certificate.pem')
  const keyPath = join(directory, 'test-key.pem')
  await Promise.all([writeFile(certificatePath, certificate), writeFile(keyPath, key)])
  return { host: '127.0.0.1', port: 4782, certificatePath, keyPath, allowLocalHttp: false }
}

describe('central service transport before database startup', () => {
  it('rejects missing database configuration promptly in the actual entrypoint', async () => {
    const environment = Object.fromEntries(
      ['SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'PATH', 'Path']
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]])
    )
    const result = await promisify(execFile)(
      process.execPath,
      [resolve('node_modules/tsx/dist/cli.mjs'), resolve('server/src/index.ts')],
      { timeout: 4000, windowsHide: true, env: environment }
    ).then(
      () => undefined,
      (error: { code: unknown; killed?: boolean; stdout?: string; stderr?: string }) => error
    )
    expect(result).toMatchObject({ code: 1, killed: false, stdout: '' })
    expect(result?.stderr).toBe(
      'Service startup failed; check database role, TLS and environment configuration.\n'
    )
  })

  it('allows HTTP only on an explicitly selected loopback address', async () => {
    const input = { host: '127.0.0.1', port: 4782, allowLocalHttp: false }
    await expect(loadServiceTransport(input)).rejects.toThrow('https_required')
    for (const host of ['0.0.0.0', '::', 'localhost', 'employee.example'])
      await expect(loadServiceTransport({ ...input, host, allowLocalHttp: true })).rejects.toThrow(
        'https_required'
      )
    expect(await loadServiceTransport({ ...input, allowLocalHttp: true })).toEqual({
      host: input.host,
      port: input.port
    })
    expect(await loadServiceTransport({ ...input, host: '::1', allowLocalHttp: true })).toEqual({
      host: '::1',
      port: input.port
    })
  })

  it('never downgrades a partially configured TLS pair to development HTTP', async () => {
    const input = { host: '127.0.0.1', port: 4782, allowLocalHttp: true }
    await expect(
      loadServiceTransport({ ...input, certificatePath: 'certificate.pem' })
    ).rejects.toThrow('tls_pair_required')
    await expect(loadServiceTransport({ ...input, keyPath: 'key.pem' })).rejects.toThrow(
      'tls_pair_required'
    )
    await expect(loadServiceTransport({ ...input, port: NaN })).rejects.toThrow('invalid_port')
    await expect(loadServiceTransport({ ...input, host: ' 127.0.0.1' })).rejects.toThrow(
      'invalid_host'
    )
  })

  it('creates an actual HTTPS listener with a matching pair and client certificate verification', async () => {
    const transport = await loadServiceTransport(await tlsFixture())
    const server = createServer(transport.tls!, (_request, response) =>
      response.end('synthetic-https-response')
    )
    try {
      await new Promise<void>((accept, reject) => {
        server.once('error', reject)
        server.listen(0, transport.host, () => {
          server.off('error', reject)
          accept()
        })
      })
      const port = (server.address() as { port: number }).port
      const response = await new Promise<string>((accept, reject) => {
        const request = get(`https://127.0.0.1:${port}/`, { ca: certificate }, (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => {
            body += chunk
          })
          response.once('end', () => accept(body))
          response.once('error', reject)
        })
        request.once('error', reject)
      })
      expect(response).toBe('synthetic-https-response')
    } finally {
      server.closeAllConnections()
      await new Promise<void>((accept) => server.close(() => accept()))
    }
  })

  it('refuses malformed and mismatched material before creating a listener', async () => {
    await expect(loadServiceTransport(await tlsFixture('not-a-private-key'))).rejects.toThrow()
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs8',
      format: 'pem'
    })
    await expect(loadServiceTransport(await tlsFixture(String(other)))).rejects.toThrow()
  })

  it('terminates the actual entrypoint promptly on bad TLS without waiting on the database', async () => {
    const result = await promisify(execFile)(
      process.execPath,
      [resolve('node_modules/tsx/dist/cli.mjs'), resolve('server/src/index.ts')],
      {
        timeout: 4000,
        windowsHide: true,
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://synthetic:private-test-value@127.0.0.1:9/unused',
          TLS_CERT_PATH: 'nonexistent-test-certificate.pem',
          TLS_KEY_PATH: '',
          DEV_ALLOW_LOCAL_HTTP: '1',
          BIND_HOST: '127.0.0.1'
        }
      }
    ).then(
      () => undefined,
      (error: { code: unknown; killed?: boolean; stderr?: string }) => error
    )
    expect(result).toMatchObject({ code: 1, killed: false })
    expect(result?.stderr).toContain('Service startup failed')
    expect(result?.stderr).not.toContain('private-test-value')
  })

  it.each(['malformed', 'mismatched'] as const)(
    'rejects %s TLS in the actual administrator entrypoint before contacting the database',
    async (material) => {
      const key =
          material === 'malformed'
            ? 'synthetic-not-a-private-key'
            : String(
                generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
                  type: 'pkcs8',
                  format: 'pem'
                })
              ),
        fixture = await tlsFixture(key),
        sockets = new Set<Socket>()
      let databaseConnections = 0
      // A reachable socket that never speaks PostgreSQL makes a premature database
      // connection observable and cannot disguise it as a fast connection refusal.
      const unavailableDatabase = createTcpServer((socket) => {
        databaseConnections++
        sockets.add(socket)
        socket.once('error', () => socket.destroy())
        socket.once('close', () => sockets.delete(socket))
      })
      await new Promise<void>((accept, reject) => {
        unavailableDatabase.once('error', reject)
        unavailableDatabase.listen(0, '127.0.0.1', () => {
          unavailableDatabase.off('error', reject)
          accept()
        })
      })
      const port = (unavailableDatabase.address() as { port: number }).port,
        databaseCredential = 'private-admin-database-value',
        tenant = 'synthetic-admin-tenant',
        token = 'synthetic-private-admin-gateway-token'
      try {
        const result = await promisify(execFile)(
          process.execPath,
          [resolve('node_modules/tsx/dist/cli.mjs'), resolve('server/scripts/admin-server.ts')],
          {
            timeout: 4000,
            windowsHide: true,
            env: {
              ...process.env,
              ADMIN_DATABASE_URL: `postgresql://synthetic:${databaseCredential}@127.0.0.1:${port}/unused`,
              ADMIN_TENANT_ID: tenant,
              ADMIN_GATEWAY_TOKEN: token,
              ADMIN_TLS_CERT_PATH: fixture.certificatePath,
              ADMIN_TLS_KEY_PATH: fixture.keyPath,
              DEV_ALLOW_LOCAL_HTTP: '1',
              ADMIN_BIND_HOST: '127.0.0.1',
              ADMIN_PORT: '4783'
            }
          }
        ).then(
          () => undefined,
          (error: { code: unknown; killed?: boolean; stdout?: string; stderr?: string }) => error
        )
        expect(result).toMatchObject({ code: 1, killed: false, stdout: '' })
        expect(result?.stderr).toBe(
          'Administrator gateway unavailable. Check private configuration.\n'
        )
        expect(databaseConnections).toBe(0)
        for (const value of [
          databaseCredential,
          tenant,
          token,
          fixture.certificatePath,
          fixture.keyPath,
          '-----BEGIN PRIVATE KEY-----'
        ])
          expect((result?.stdout ?? '') + (result?.stderr ?? '')).not.toContain(value)
      } finally {
        for (const socket of sockets) socket.destroy()
        await new Promise<void>((accept) => unavailableDatabase.close(() => accept()))
      }
    }
  )

  it('checks a complete private configuration locally without printing secrets or claiming production readiness', async () => {
    const f = await tlsFixture()
    const result = await promisify(execFile)(
      process.execPath,
      [resolve('node_modules/tsx/dist/cli.mjs'), resolve('server/scripts/server-check.ts')],
      {
        timeout: 4000,
        windowsHide: true,
        env: {
          ...process.env,
          TLS_CERT_PATH: f.certificatePath,
          TLS_KEY_PATH: f.keyPath,
          DATABASE_URL: 'postgresql://synthetic:private-database-value@127.0.0.1:9/unused',
          TYPESAFE_API_KEY: 'private-decision-value',
          TEXT_MODEL_API_KEY: 'private-text-value',
          TEXT_MODEL_BASE_URL: 'https://never-contact.invalid/v1/',
          TEXT_MODEL_ID: 'test-alias',
          TEXT_MODEL_EXPECTED_ID: 'test-resolved',
          BIND_HOST: '127.0.0.1',
          PORT: '4782'
        }
      }
    )
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: 'local_configuration_only',
      protocol: 'https',
      databaseConfigured: true,
      generationConfigured: true,
      missingGenerationVariables: [],
      databaseConnected: false,
      modelsCalled: false,
      clientCapabilitiesValidated: false,
      productionReady: false
    })
    for (const value of [
      'private-database-value',
      'private-decision-value',
      'private-text-value',
      f.keyPath
    ])
      expect(result.stdout + result.stderr).not.toContain(value)
  })
})
