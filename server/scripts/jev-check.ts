import { writeFile } from 'node:fs/promises'
import { TypeSafeClient, JevError } from '../src/decision/typesafe-client'

async function main(): Promise<void> {
  const key = process.env.TYPESAFE_API_KEY
  if (!key) throw new Error('TYPESAFE_API_KEY must be provided in the server environment')
  const client = new TypeSafeClient({ apiKey: key, timeoutMs: 10000, maxAttempts: 1 })
  const available = await client.listModels()
  const configured = process.env.JEV_MODEL
  const model =
    configured ||
    available.models.find((item) => /^jev-\d/.test(item.name))?.name ||
    available.models.find((item) => item.name === 'jev-latest')?.name
  if (!model || !available.models.some((item) => item.name === model))
    throw new Error('Configured model is not available')
  const started = Date.now()
  const result = await client.evaluate({
    model,
    state: {
      messages: [{ direction: 'inbound', text: '上次买的商品又坏了，请安排人工售后处理。' }]
    },
    questions: {
      intent: {
        type: 'choice',
        instructions: '判断客户当前主要诉求。',
        criteria: {
          presales: '购买前商品咨询',
          aftersales: '已购买商品的售后问题',
          other: '其他或不清楚'
        }
      },
      human_requested: { type: 'noul', instructions: '客户是否明确要求人工处理？' },
      urgency: {
        type: 'score',
        instructions: '判断客户表达的紧急程度。',
        criteria: ['没有明确表达紧急', '希望尽快处理', '明确有即时严重后果']
      }
    }
  })
  const report = {
    checkedAt: new Date().toISOString(),
    scope: 'Synthetic Chinese state only; no chat clients or customer messages',
    models: available.models,
    modelRequested: model,
    modelResolved: result.model,
    elapsedMs: Date.now() - started,
    answers: result.answers,
    usage: result.usage
  }
  if (process.env.JEV_CHECK_REPORT)
    await writeFile(process.env.JEV_CHECK_REPORT, JSON.stringify(report, null, 2), 'utf8')
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
}

main().catch((error: unknown) => {
  // Do not print arbitrary upstream messages or objects which may hold credentials.
  process.stderr.write(
    error instanceof JevError
      ? `${error.code}\n`
      : 'Jev connection check failed; check server configuration.\n'
  )
  process.exitCode = 1
})
