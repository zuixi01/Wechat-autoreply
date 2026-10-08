import { createServer as httpServer } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { loadServiceTransport } from '../src/http/server-transport'
import { Postgres } from '../src/database/postgres'
import { Administration } from '../src/admin/administration'
import { createAdminGateway } from '../src/admin/gateway'
import { assertDedicatedAdminRole } from '../src/admin/database-role'

async function main(): Promise<void> {
  const connection = process.env.ADMIN_DATABASE_URL
  const tenantId = process.env.ADMIN_TENANT_ID
  const token = process.env.ADMIN_GATEWAY_TOKEN
  if (!connection || !tenantId || !token) throw new Error('admin_gateway_not_configured')
  const transport = await loadServiceTransport({
    host: process.env.ADMIN_BIND_HOST ?? '127.0.0.1',
    port: Number(process.env.ADMIN_PORT ?? 4783),
    certificatePath: process.env.ADMIN_TLS_CERT_PATH,
    keyPath: process.env.ADMIN_TLS_KEY_PATH,
    allowLocalHttp: process.env.DEV_ALLOW_LOCAL_HTTP === '1'
  })
  const { host, port } = transport
  const db = new Postgres(connection)
  let server: ReturnType<typeof httpServer> | undefined
  let shuttingDown: Promise<void> | undefined
  const cleanup = (): Promise<void> => {
    return (shuttingDown ??= (async () => {
      let failed = false
      const serverClosed = new Promise<void>((resolve) => {
        if (!server) return resolve()
        try {
          server.close((error?: Error) => {
            if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING')
              failed = true
            resolve()
          })
        } catch {
          failed = true
          resolve()
        }
      })
      try {
        server?.closeIdleConnections()
      } catch {
        failed = true
      }
      await serverClosed
      try {
        await db.close()
      } catch {
        failed = true
      }
      if (failed) throw new Error('admin_gateway_shutdown_failed')
    })())
  }
  try {
    await assertDedicatedAdminRole(db)
    const admin = new Administration(db)
    const handler = createAdminGateway(admin, { tenantId, token })
    await admin.identity(tenantId)
    server = transport.tls ? httpsServer(transport.tls, handler) : httpServer(handler)
    server.requestTimeout = 10000
    server.headersTimeout = 5000
    server.timeout = 15000
    server.maxRequestsPerSocket = 100
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(port, host, () => {
        server!.removeListener('error', reject)
        resolve()
      })
    })
    const stop = (): void => {
      void cleanup().catch(reportFailure)
    }
    server.on('error', () => {
      reportFailure()
      stop()
    })
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    process.stdout.write('Administrator gateway ready.\n')
  } catch (error) {
    await cleanup()
    throw error
  }
}
function reportFailure(): void {
  process.stderr.write('Administrator gateway unavailable. Check private configuration.\n')
  process.exitCode = 1
}
void main().catch(reportFailure)
