import { loadServiceTransport } from './http/server-transport'

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('database_not_configured')
  const transport = await loadServiceTransport({
    host: process.env.BIND_HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 4782),
    certificatePath: process.env.TLS_CERT_PATH,
    keyPath: process.env.TLS_KEY_PATH,
    allowLocalHttp: process.env.DEV_ALLOW_LOCAL_HTTP === '1'
  })
  // Configuration failures need no database, generation or learning modules.
  const { runManagementService } = await import('./service-runtime')
  await runManagementService(url, transport)
}

main().catch(() => {
  process.stderr.write(
    'Service startup failed; check database role, TLS and environment configuration.\n'
  )
  process.exitCode = 1
})
