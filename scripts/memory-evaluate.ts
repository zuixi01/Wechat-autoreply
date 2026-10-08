import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep, join } from 'node:path'
import { evaluateMemoryDataset, type MemoryEvaluationReport } from '../evals/memory/metrics'
import {
  protectPrivateDirectory,
  verifyPrivatePaths
} from '../src/core/persistence/private-backup-directory'

function inside(path: string, root: string): boolean {
  const part = relative(root, path)
  return part !== '' && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part)
}
async function existingAncestor(path: string): Promise<string> {
  let cursor = path
  while (true) {
    try {
      return await realpath(cursor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw new Error('missing_ancestor')
      cursor = parent
    }
  }
}
function markdown(report: MemoryEvaluationReport): string {
  const percent = (n: number | null): string =>
    n === null ? '不可定义' : `${(100 * n).toFixed(2)}%`
  const number = (n: number | null): string => (n === null ? '不可定义' : String(n))
  const status = { passed: '通过', insufficient: '资料不足', failed: '门槛未通过' }[
    report.assessment.status
  ]
  return [
    '# 工作记忆独立效果评估',
    '',
    `结论：**${status}**（${report.assessment.status}）。`,
    '',
    `数据来源：${report.origin}；数据 SHA256：${report.datasetHash}。`,
    '',
    `样本：学习 ${report.sample.learn}，校准 ${report.sample.calibrate}，评估 ${report.sample.evaluate}，独立评估会话 ${report.sample.conversations}。`,
    '',
    '| 指标 | 静态记忆基线 | 加入学习方法 | 用户确认门槛 |',
    '| --- | ---: | ---: | --- |',
    `| 实质修改率 | ${percent(report.arms.baseline.correction.rate)} | ${percent(report.arms.learned.correction.rate)} | 相对下降 ≥20% |`,
    `| 严重错误 | ${report.arms.baseline.severeErrors} | ${report.arms.learned.severeErrors} | 学习组 0 |`,
    `| 覆盖率 | ${percent(report.arms.baseline.coverage.rate)} | ${percent(report.arms.learned.coverage.rate)} | 下降 ≤5 个百分点 |`,
    `| p95 时延（ms） | ${number(report.arms.baseline.p95LatencyMs)} | ${number(report.arms.learned.p95LatencyMs)} | 新增 ≤500ms |`,
    `| 观测费用（USD） | ${report.arms.baseline.costUsd.toFixed(6)} | ${report.arms.learned.costUsd.toFixed(6)} | 报告成本 |`,
    '',
    `相对修改率改善：${percent(report.comparison.relativeCorrectionReduction)}；覆盖率变化：${number(report.comparison.coverageChangePp)} 个百分点；新增 p95：${number(report.comparison.addedP95LatencyMs)}ms。`,
    '',
    `资料问题：${report.assessment.reasons.length ? report.assessment.reasons.join(', ') : '无'}。`,
    '',
    `未通过门槛：${report.assessment.failedGates.length ? report.assessment.failedGates.join(', ') : '无'}。`,
    '',
    '## 不确定性和适用范围',
    '',
    `保留会话内成对结果的 bootstrap：${report.uncertainty.conversationBootstrap.replicates} 次。完整区间见 report.json。`,
    '',
    '人工来源、盲评分配和原始时延/费用记录由输入声明，需独立核查私密记录；本工具不能鉴定标注人身份。合成或模型标注不能通过业务验收。',
    '',
    '本结论仅针对冻结样本的点估计。样本起点不是统计充分性保证；区间及业务代表性仍需人工审阅。此报告不授予方法自动生效、企业发布或发送权限。',
    '',
    `人工评审草稿：基线 ${report.arms.baseline.correction.denominator}，学习组 ${report.arms.learned.correction.denominator}。实质修改率以各组实际人工评审草稿为分母；覆盖率保留全部样本。`,
    '',
    `无记忆组：修改率 ${percent(report.arms.none?.correction.rate ?? null)}，覆盖率 ${percent(report.arms.none?.coverage.rate ?? null)}，p95 ${number(report.arms.none?.p95LatencyMs ?? null)}ms。后台学习/校准费用：${number(report.frozen.backgroundCostUsd)} USD。`,
    `计时范围：${report.frozen.latencyScope ?? 'unverified'}。完整前台门槛需要 foreground_end_to_end 和各组私密观察凭据；局部管线计时不能通过此门槛。`,
    '',
    '| 业务类别 | 样本 | 基线修改率 | 学习修改率 | 覆盖变化（pp） | 新增 p95（ms） |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(report.strata).map(
      ([category, value]) =>
        `| ${category} | ${value.sample.evaluate} | ${percent(value.arms.baseline.correction.rate)} | ${percent(value.arms.learned.correction.rate)} | ${number(value.comparison.coverageChangePp)} | ${number(value.comparison.addedP95LatencyMs)} |`
    ),
    '',
    '观察到严重错误为 0 不代表严重错误风险为 0。p95 使用第 ceil(0.95×N) 个排序值；新增 p95 为学习组与基线的 p95 相减。',
    '',
    '报告不导出原回复、客户身份、标注人或私密证据引用。',
    ''
  ].join('\n')
}
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(
      'memory:evaluate INPUT OUTPUT_DIRECTORY\nAlso: --dataset <json> --out <new .local directory>\nExit: 0 passed, 1 invalid/execution error, 2 insufficient or gates failed.\n'
    )
    return
  }
  const options = new Map<string, string>()
  if (args.length === 2 && args.every((arg) => !arg.startsWith('--')))
    args.splice(0, 2, '--dataset', args[0], '--out', args[1])
  if (args.length !== 4) throw new Error('usage')
  for (let i = 0; i < args.length; i += 2) {
    if (
      !['--dataset', '--out'].includes(args[i]) ||
      options.has(args[i]) ||
      args[i + 1].startsWith('--')
    )
      throw new Error('usage')
    options.set(args[i], args[i + 1])
  }
  if (!options.has('--dataset') || !options.has('--out')) throw new Error('usage')
  const root = await realpath(process.cwd())
  const input = await realpath(resolve(options.get('--dataset')!))
  const output = resolve(options.get('--out')!)
  const privateRoots = [resolve(root, '.local'), resolve(root, 'evals/private')]
  const fixtureRoot = resolve(root, 'evals/memory/fixtures')
  const fixture = inside(input, fixtureRoot)
  if (!fixture && !privateRoots.some((parent) => inside(input, parent)))
    throw new Error('private_input_required')
  const outputRoot = resolve(root, '.local')
  if (!inside(output, outputRoot)) throw new Error('local_output_required')
  const ancestor = await existingAncestor(dirname(output))
  if (ancestor !== root && ancestor !== outputRoot && !inside(ancestor, outputRoot))
    throw new Error('linked_output_forbidden')
  const info = await stat(input)
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('invalid_input_file')
  const report = evaluateMemoryDataset(JSON.parse(await readFile(input, 'utf8')))
  if (fixture && report.origin !== 'synthetic') throw new Error('fixture_must_be_synthetic')
  await mkdir(dirname(output), { recursive: true })
  const actualParent = await realpath(dirname(output))
  if (actualParent !== outputRoot && !inside(actualParent, outputRoot))
    throw new Error('linked_output_forbidden')
  await mkdir(output) // A fresh directory is mandatory; preserve previous reports on every exit.
  const actualOutput = await realpath(output)
  if (!inside(actualOutput, outputRoot)) throw new Error('linked_output_forbidden')
  await protectPrivateDirectory(actualOutput)
  await verifyPrivatePaths(actualOutput, [])
  await writeFile(join(actualOutput, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx'
  })
  await verifyPrivatePaths(actualOutput, [join(actualOutput, 'report.json')])
  await writeFile(join(actualOutput, 'report.md'), markdown(report), { flag: 'wx' })
  await verifyPrivatePaths(actualOutput, [
    join(actualOutput, 'report.json'),
    join(actualOutput, 'report.md')
  ])
  process.stdout.write(
    `Memory evaluation: ${report.assessment.status}; cases=${report.sample.evaluate}, conversations=${report.sample.conversations}\n`
  )
  process.exitCode = report.assessment.status === 'passed' ? 0 : 2
}
main().catch(() => {
  // Do not print contract errors: they can include private input bodies, keys or paths.
  process.stderr.write(
    'Memory evaluation failed: verify the strict dataset, private input path, and new .local output directory. Use --help for usage.\n'
  )
  process.exitCode = 1
})
