import { loadServiceTransport } from '../src/http/server-transport'
import { HttpTextGenerator } from '../src/generation/text-generator'
import { TypeSafeClient } from '../src/decision/typesafe-client'

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error('usage')
  const transport = await loadServiceTransport({
    host: process.env.BIND_HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 4782),
    certificatePath: process.env.TLS_CERT_PATH,
    keyPath: process.env.TLS_KEY_PATH,
    allowLocalHttp: process.env.DEV_ALLOW_LOCAL_HTTP === '1'
  })
  const required = [
    'TYPESAFE_API_KEY',
    'TEXT_MODEL_API_KEY',
    'TEXT_MODEL_BASE_URL',
    'TEXT_MODEL_ID',
    'TEXT_MODEL_EXPECTED_ID'
  ]
  const missingGenerationVariables = required.filter((name) => !process.env[name]?.trim())
  if (!missingGenerationVariables.length) {
    // Constructors perform the same local validation as normal startup, without requests.
    new TypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY! })
    new HttpTextGenerator({
      apiKey: process.env.TEXT_MODEL_API_KEY!,
      baseUrl: process.env.TEXT_MODEL_BASE_URL!,
      model: process.env.TEXT_MODEL_ID!,
      expectedModel: process.env.TEXT_MODEL_EXPECTED_ID!
    })
  }
  const databaseConfigured = Boolean(process.env.DATABASE_URL?.trim())
  process.stdout.write(
    JSON.stringify(
      {
        mode: 'local_configuration_only',
        protocol: transport.tls ? 'https' : 'http',
        host: transport.host,
        port: transport.port,
        databaseConfigured,
        generationConfigured: missingGenerationVariables.length === 0,
        missingGenerationVariables,
        databaseConnected: false,
        modelsCalled: false,
        clientCapabilitiesValidated: false,
        productionReady: false
      },
      null,
      2
    ) + '\n'
  )
  if (!databaseConfigured || missingGenerationVariables.length) process.exitCode = 2
}

void main().catch(() => {
  // File paths, database connection strings, certificates and keys stay private.
  process.stderr.write(
    'Service configuration check failed; check listener/TLS and model configuration.\n'
  )
  process.exitCode = 1
})
