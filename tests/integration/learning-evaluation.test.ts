import { describe, expect, it, vi } from 'vitest'

// Cold tsx startup exceeds the ordinary 5 s unit-test budget on this PC.
vi.setConfig({ testTimeout: 30000 })
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { evaluateMemoryDataset, MEMORY_EVALUATION_THRESHOLDS } from '../../evals/memory/metrics'
import { LearningEvaluationDatasetSchema } from '../../src/shared/contracts/learning-evaluation'

const hash = 'a'.repeat(64)
function dataset() {
  const label = {
    origin: 'human' as const,
    reviewerId: 'independent-reviewer',
    evidenceRef: 'private-adjudication-001',
    blinded: true,
    assignmentRef: 'private-random-assignment-001',
    labelledAt: 3000
  }
  const outcome = (index: number, learned: boolean) => ({
    reply: 'Synthetic fixture reply; never business evidence.',
    humanReviewed: true,
    substantialCorrection: index < (learned ? 60 : 100),
    severeError: false,
    validAnswer: true,
    latencyMs: learned ? 200 : 100,
    latencyEvidenceRef: 'synthetic-observation-never-real-evidence',
    inputTokens: 100,
    outputTokens: 20,
    costUsd: learned ? 0.002 : 0.001,
    generatedAt: 2000,
    configurationHash: hash,
    memoryManifestHash: learned ? 'c'.repeat(64) : 'b'.repeat(64)
  })
  return {
    version: 2 as const,
    datasetId: 'synthetic-contract-test',
    // This unit fixture simulates business metadata to exercise the contract. It is not real evidence.
    origin: 'business_observation' as 'business_observation' | 'synthetic' | 'model',
    rubricRef: 'private-rubric-001',
    frozen: {
      frozenAt: 1000,
      sharedConfigurationHash: hash,
      staticMemoryManifestHash: 'b'.repeat(64),
      learnedMemoryManifestHash: 'c'.repeat(64),
      noMemoryManifestHash: 'd'.repeat(64),
      modelVersion: 'frozen-model',
      knowledgeVersion: 'frozen-knowledge',
      policyVersion: 'frozen-policy',
      retrievalVersion: 'frozen-retrieval',
      backgroundCostUsd: 0,
      latencyScope: 'foreground_end_to_end' as
        | 'knowledge_preview'
        | 'enterprise_pipeline'
        | 'foreground_end_to_end',
      methods: [{ id: 'method-1', revision: 1, contentHash: hash, sourceCaseIds: ['learn-0'] }]
    },
    cases: [
      ...Array.from({ length: 100 }, (_, i) => ({
        caseId: `learn-${i}`,
        conversationId: `learn-conversation-${i}`,
        split: 'learn' as const,
        label: { ...label, blinded: false, labelledAt: 500 }
      })),
      ...Array.from({ length: 100 }, (_, i) => ({
        caseId: `calibrate-${i}`,
        conversationId: `calibrate-conversation-${i}`,
        split: 'calibrate' as const,
        label: { ...label, blinded: false, labelledAt: 600 }
      })),
      ...Array.from({ length: 200 }, (_, i) => ({
        caseId: `evaluate-${i}`,
        conversationId: `evaluate-conversation-${Math.floor(i / 5)}`,
        split: 'evaluate' as const,
        label: { ...label },
        category: ['inquiry', 'complaint', 'handoff', 'multiple_intents'][i % 4] as
          | 'inquiry'
          | 'complaint'
          | 'handoff'
          | 'multiple_intents',
        none: { ...outcome(i, false), memoryManifestHash: 'd'.repeat(64) },
        baseline: outcome(i, false),
        learned: outcome(i, true)
      }))
    ]
  }
}
type Fixture = ReturnType<typeof dataset>
function evaluationCases(input: Fixture) {
  return input.cases.filter((c) => c.split === 'evaluate')
}

describe('independent memory evaluation', () => {
  it('uses the four user-confirmed gates and the reviewed draft denominator', () => {
    expect(MEMORY_EVALUATION_THRESHOLDS).toEqual({
      relativeCorrectionReduction: 0.2,
      severeErrors: 0,
      maxCoverageDropPp: 5,
      maxAddedP95LatencyMs: 500
    })
    const report = evaluateMemoryDataset(dataset())
    expect(report.assessment.status).toBe('passed')
    expect(report.sample).toMatchObject({
      learn: 100,
      calibrate: 100,
      evaluate: 200,
      conversations: 40
    })
    expect(report.arms.baseline.correction).toMatchObject({
      numerator: 100,
      denominator: 200,
      rate: 0.5
    })
    expect(report.arms.learned.correction.rate).toBe(0.3)
    expect(report.comparison.relativeCorrectionReduction).toBeCloseTo(0.4)
    expect(report.comparison.addedP95LatencyMs).toBe(100)
    expect(report.arms.learned.tokens).toEqual({ input: 20000, output: 4000 })
    expect(report.arms.learned.costUsd).toBeCloseTo(0.4)
    expect(report.uncertainty.conversationBootstrap.replicates).toBe(1000)
    expect(report.uncertainty.conversationBootstrap.relativeCorrectionReduction95).toHaveLength(2)
  })

  it('cannot pass synthetic or model labels, including synthetic data with human-looking metadata', () => {
    for (const origin of ['synthetic', 'model'] as const) {
      const input = dataset()
      input.origin = origin
      expect(evaluateMemoryDataset(input).assessment).toMatchObject({
        status: 'insufficient',
        reasons: expect.arrayContaining(['non_business_dataset'])
      })
      const labelled = dataset()
      const typed = LearningEvaluationDatasetSchema.parse(labelled)
      typed.cases[0].label.origin = origin
      expect(evaluateMemoryDataset(typed).assessment.status).toBe('insufficient')
    }
  })

  it('requires independent blinded human provenance, enough cases and conversations', () => {
    const input = dataset()
    evaluationCases(input)[0].label.blinded = false
    expect(evaluateMemoryDataset(input).assessment.reasons).toContain('unblinded_evaluation')
    const noHuman = LearningEvaluationDatasetSchema.parse(dataset())
    delete noHuman.cases[200].label.reviewerId
    expect(evaluateMemoryDataset(noHuman).assessment.status).toBe('insufficient')
    const tooSmall = dataset()
    tooSmall.cases.pop()
    expect(evaluateMemoryDataset(tooSmall).assessment.reasons).toContain('too_few_evaluation_cases')
    const grouped = dataset()
    evaluationCases(grouped).forEach((c) => {
      c.conversationId = 'same-conversation'
    })
    expect(evaluateMemoryDataset(grouped).assessment.reasons).toContain(
      'too_few_independent_conversations'
    )
  })

  it('rejects conversation overlap and learned source overlap without hiding the data leak', () => {
    const input = dataset()
    input.cases[0].conversationId = evaluationCases(input)[0].conversationId
    expect(evaluateMemoryDataset(input).assessment.reasons).toContain('conversation_split_overlap')
    const source = dataset()
    source.frozen.methods[0].sourceCaseIds = ['evaluate-0']
    expect(evaluateMemoryDataset(source).assessment.reasons).toContain(
      'learning_source_not_in_learn_split'
    )
    source.frozen.methods[0].sourceCaseIds = ['missing-source']
    expect(evaluateMemoryDataset(source).assessment.status).toBe('insufficient')
  })

  it('rejects missing pairs, duplicate IDs, severe labels without correction, and secret fields', () => {
    const input = dataset()
    const first = evaluationCases(input)[0]
    const missing = { ...first, learned: undefined }
    expect(() =>
      evaluateMemoryDataset({ ...input, cases: [...input.cases.slice(0, 200), missing] })
    ).toThrow()
    expect(() => evaluateMemoryDataset({ ...input, cases: [...input.cases, first] })).toThrow()
    first.learned.severeError = true
    first.learned.substantialCorrection = false
    expect(() => evaluateMemoryDataset(input)).toThrow()
    expect(() =>
      evaluateMemoryDataset({ ...dataset(), apiKey: 'fixture-secret-must-be-rejected' })
    ).toThrow()
  })

  it('requires the frozen configuration and arm-specific memory manifest on every output', () => {
    const input = dataset()
    evaluationCases(input)[0].learned.configurationHash = 'd'.repeat(64)
    expect(evaluateMemoryDataset(input).assessment.reasons).toContain('configuration_changed')
    const memory = dataset()
    evaluationCases(memory)[0].learned.memoryManifestHash = 'b'.repeat(64)
    expect(evaluateMemoryDataset(memory).assessment.reasons).toContain('memory_manifest_changed')
    const late = dataset()
    late.frozen.frozenAt = 2001
    expect(evaluateMemoryDataset(late).assessment.reasons).toContain('generation_before_freeze')
    const earlyLabels = dataset()
    evaluationCases(earlyLabels)[0].label.labelledAt = 1999
    expect(evaluateMemoryDataset(earlyLabels).assessment.reasons).toContain(
      'label_before_generation'
    )
    const lateLearning = dataset()
    lateLearning.cases[0].label.labelledAt = 1001
    expect(evaluateMemoryDataset(lateLearning).assessment.reasons).toContain(
      'source_label_after_freeze'
    )
  })

  it('uses nearest-rank p95 rather than interpolating or averaging paired per-case delays', () => {
    const input = dataset()
    evaluationCases(input).forEach((c, i) => {
      c.baseline.latencyMs = i + 1
      c.learned.latencyMs = i + 101
    })
    const report = evaluateMemoryDataset(input)
    expect(report.arms.baseline.p95LatencyMs).toBe(190)
    expect(report.arms.learned.p95LatencyMs).toBe(290)
    expect(report.comparison.addedP95LatencyMs).toBe(100)
  })

  it('reports undefined relative improvement as insufficient when baseline correction is zero', () => {
    const input = dataset()
    evaluationCases(input).forEach((c) => {
      c.baseline.substantialCorrection = false
    })
    const report = evaluateMemoryDataset(input)
    expect(report.comparison.relativeCorrectionReduction).toBeNull()
    expect(report.assessment).toMatchObject({
      status: 'insufficient',
      reasons: expect.arrayContaining(['zero_baseline_correction'])
    })
  })

  it('fails each confirmed gate and accepts exactly the boundary', () => {
    const boundary = dataset()
    evaluationCases(boundary).forEach((c, i) => {
      c.learned.substantialCorrection = i < 80
      c.learned.validAnswer = i >= 10
      c.learned.latencyMs = 600
    })
    expect(evaluateMemoryDataset(boundary).assessment.status).toBe('passed')
    const correction = dataset()
    evaluationCases(correction).forEach((c, i) => {
      c.learned.substantialCorrection = i < 81
    })
    expect(evaluateMemoryDataset(correction).assessment.failedGates).toContain(
      'relativeCorrectionReduction'
    )
    const severe = dataset()
    evaluationCases(severe)[0].learned.severeError = true
    expect(evaluateMemoryDataset(severe).assessment).toMatchObject({
      status: 'failed',
      failedGates: expect.arrayContaining(['severeErrors'])
    })
    const coverage = dataset()
    evaluationCases(coverage).forEach((c, i) => {
      c.learned.validAnswer = i >= 11
    })
    expect(evaluateMemoryDataset(coverage).assessment.failedGates).toContain('coverageDrop')
    const latency = dataset()
    evaluationCases(latency).forEach((c) => {
      c.learned.latencyMs = 601
    })
    expect(evaluateMemoryDataset(latency).assessment.failedGates).toContain('addedP95LatencyMs')
  })

  it('keeps report free of reply bodies, reviewer IDs and evidence references', () => {
    const input = dataset()
    evaluationCases(input)[0].baseline.reply = 'PRIVATE_CHAT_BODY'
    const output = JSON.stringify(evaluateMemoryDataset(input))
    expect(output).not.toContain('PRIVATE_CHAT_BODY')
    expect(output).not.toContain('independent-reviewer')
    expect(output).not.toContain('private-adjudication-001')
    expect(output).not.toContain('private-random-assignment-001')
  })
})

const runFile = promisify(execFile)
async function runCli(args: string[]) {
  try {
    const output = await runFile(
      process.execPath,
      [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/memory-evaluate.ts'), ...args],
      { cwd: process.cwd(), timeout: 10000 }
    )
    return { code: 0, ...output }
  } catch (error) {
    const output = error as { code: number; stdout: string; stderr: string }
    return output
  }
}

describe('memory:evaluate command', () => {
  async function inPrivateFolder(prefix: string, work: (folder: string) => Promise<void>) {
    const root = resolve('.local/memory-evaluation-contract-tests')
    await mkdir(root, { recursive: true })
    const folder = await mkdtemp(join(root, prefix))
    const boundedPath = relative(root, resolve(folder))
    if (!boundedPath || boundedPath === '..' || boundedPath.startsWith(`..${sep}`))
      throw new Error('evaluation_test_cleanup_outside_private_root')
    try {
      await work(folder)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  }

  it.each([
    { name: 'passed', code: 0 },
    { name: 'failed', code: 2 },
    { name: 'insufficient', code: 2 }
  ])('writes aggregate JSON and Markdown for $name with exit $code', async (item) => {
    await inPrivateFolder('evaluation-', async (folder) => {
      const input = join(folder, 'input.json')
      const data = dataset()
      if (item.name === 'failed') evaluationCases(data)[0].learned.severeError = true
      if (item.name === 'insufficient') data.origin = 'synthetic'
      await writeFile(input, JSON.stringify(data))
      const out = join(folder, item.name)
      const result = await runCli(
        item.name === 'passed' ? [input, out] : ['--dataset', input, '--out', out]
      )
      expect(result.code, result.stderr).toBe(item.code)
      expect(JSON.parse(await readFile(join(out, 'report.json'), 'utf8')).assessment.status).toBe(
        item.name
      )
      const markdown = await readFile(join(out, 'report.md'), 'utf8')
      expect(markdown).toContain('20%')
      expect(markdown).toContain('500ms')
      expect(markdown).not.toContain('Synthetic fixture reply')
      expect(result.stdout).not.toContain('private-adjudication')
    })
  })

  it('rejects invalid input with exit 1 without exposing its contents', async () => {
    await inPrivateFolder('invalid-', async (folder) => {
      const input = join(folder, 'input.json')
      await writeFile(input, '{"apiKey":"SECRET_SHOULD_NOT_APPEAR"}')
      const invalid = await runCli(['--dataset', input, '--out', join(folder, 'invalid')])
      expect(invalid.code).toBe(1)
      expect(invalid.stderr).not.toContain('SECRET_SHOULD_NOT_APPEAR')
      expect(invalid.stdout).toBe('')
    })
  })

  it.each(['existing', 'unsafe', 'duplicate'])('refuses %s output arguments', async (reason) => {
    await inPrivateFolder('paths-', async (folder) => {
      const input = join(folder, 'input.json')
      await writeFile(input, JSON.stringify(dataset()))
      const out = join(folder, 'reports')
      await mkdir(out)
      await writeFile(join(out, 'report.json'), 'PRESERVE')
      const args =
        reason === 'existing'
          ? ['--dataset', input, '--out', out]
          : reason === 'unsafe'
            ? ['--dataset', input, '--out', resolve('evals/memory/unsafe-report')]
            : ['--dataset', input, '--dataset', input, '--out', join(folder, 'duplicate')]
      expect((await runCli(args)).code).toBe(1)
      expect(await readFile(join(out, 'report.json'), 'utf8')).toBe('PRESERVE')
    })
  })

  it('ships a clearly synthetic input whose business verdict is always insufficient', async () => {
    const fixture = resolve('evals/memory/fixtures/synthetic.json')
    const data = JSON.parse(await readFile(fixture, 'utf8'))
    expect(data.origin).toBe('synthetic')
    expect(evaluateMemoryDataset(data).assessment.status).toBe('insufficient')
    await inPrivateFolder('fixture-', async (folder) => {
      const output = await runCli(['--dataset', fixture, '--out', join(folder, 'report')])
      expect(output.code, output.stderr).toBe(2)
    })
  })
})
