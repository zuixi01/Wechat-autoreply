import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { prepareKnowledgePublication } from '../src/generation/knowledge-publication'

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      output: { type: 'string' },
      tenant: { type: 'string' },
      account: { type: 'string' }
    }
  })
  if (!values.input || !values.output || !values.tenant || !values.account)
    throw new Error(
      '用法：npm run knowledge:prepare -- --input 准备文件.json --output 待审核发布.json --tenant 企业ID --account 账号ID'
    )
  const bytes = await readFile(values.input)
  if (bytes.length > 16 * 1048576) throw new Error('准备文件超过 16 MB，请精简资料。')
  const publication = prepareKnowledgePublication(
    JSON.parse(bytes.toString('utf8')),
    values.tenant,
    values.account
  )
  await writeFile(values.output, JSON.stringify(publication, null, 2), { flag: 'wx' })
  process.stdout.write('知识发布文件已生成；自动发送保持关闭，请由管理员审核发布、评测和启用。\n')
}
void main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : '知识发布准备失败') + '\n')
  process.exitCode = 1
})
