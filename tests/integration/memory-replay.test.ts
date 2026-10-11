import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
vi.setConfig({ testTimeout: 30000 })
import {
  replayMemoryCases,
  adjudicateMemoryReplay,
  replayHash,
  MemoryReplayAdjudicationSchema
} from '../../evals/memory/replay'
import { evaluateMemoryDataset } from '../../evals/memory/metrics'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { replayHttpGenerator } from '../../evals/memory/replay-http'
import { verifyPrivatePaths } from '../../src/core/persistence/private-backup-directory'

const execute = promisify(execFile)

const deployment = vi.hoisted(() => ({ changedFile: '' }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const value = actual.readFileSync(...args)
      return deployment.changedFile &&
        String(args[0]).endsWith(deployment.changedFile) &&
        typeof value === 'string'
        ? value + '\n// synthetic deployed implementation change\n'
        : value
    }
  }
})
beforeEach(() => {
  deployment.changedFile = ''
})

function annotations(
  packet: Awaited<ReturnType<typeof replayMemoryCases>>
): ReturnType<typeof MemoryReplayAdjudicationSchema.parse> {
  return packet.receipts.map((r) => ({
    assignmentId: r.assignmentId,
    origin: 'synthetic',
    reviewerId: 'fixture',
    evidenceRef: 'synthetic-only',
    labelledAt: Date.now(),
    blinded: true,
    humanReviewed: true,
    substantialCorrection: false,
    severeError: false,
    validAnswer: true,
    costUsd: 0,
    costEvidenceRef: 'synthetic-zero-charge'
  }))
}

function input() {
  const label = { origin: 'synthetic', blinded: false, labelledAt: 1 }
  return {
    version: 1,
    datasetId: 'synthetic-replay',
    origin: 'synthetic',
    rubricRef: 'private-rubric',
    model: {
      baseURL: 'http://127.0.0.1:9999/v1',
      model: 'fake-model',
      expectedModel: 'fake-model',
      maxOutputTokens: 100
    },
    maxRequests: 3,
    backgroundCostUsd: 0,
    knowledge: {
      schema: 'autoreply-knowledge-v1',
      version: 'frozen-knowledge',
      settings: { enabled: true, fallbackReply: '请转人工核实' },
      documents: [
        {
          id: 'ecf1a7d2-5272-4488-829b-1aa8bf16e316',
          name: '设备资料',
          category: '产品',
          content: '设备报价需要查询有效资料，禁止猜测价格。',
          version: 1
        }
      ]
    },
    rules: '回复简短',
    legacy: [{ scenario: '设备报价', guidance: '静态方法', rationale: '' }],
    methods: [
      {
        id: 'method-1',
        revision: 2,
        content: {
          kind: 'lesson',
          scenario: '设备报价',
          guidance: '先确认型号数量',
          rationale: '',
          steps: [],
          pitfalls: [],
          verification: []
        },
        sourceCaseIds: ['learn-1']
      }
    ],
    sources: [
      { caseId: 'learn-1', conversationId: 'learn-conversation', split: 'learn', label },
      { caseId: 'calibrate-1', conversationId: 'calibrate-conversation', split: 'calibrate', label }
    ],
    cases: [
      {
        caseId: 'holdout-1',
        conversationId: 'holdout-conversation',
        category: 'inquiry',
        question: '设备报价'
      }
    ]
  }
}

describe('isolated frozen three-arm replay', () => {
  it('keeps asynchronous timing failures handled in a real separate Node event loop', async () => {
    const result = await execute(
      process.execPath,
      [resolve('node_modules/tsx/dist/cli.mjs'), resolve('tests/fixtures/timing-sink-probe.ts')],
      { timeout: 20000 }
    )
    expect(JSON.parse(result.stdout)).toEqual({
      origin: 'synthetic',
      candidates: 1,
      committedReads: 1,
      sends: 0,
      unhandledRejections: 0
    })
  })
  it('refuses labels after the deployed static renderer changes, without modifying source files', async () => {
    const packet = await replayMemoryCases(input(), async () => ({
      text: '合成设备回复',
      inputTokens: 1,
      outputTokens: 1
    }))
    deployment.changedFile = '/src/core/ai-client.ts'
    expect(() => adjudicateMemoryReplay(packet, annotations(packet))).toThrow(
      'frozen_packet_changed'
    )
  })

  it('rejects a self-consistent rewritten policy fingerprint and all receipt configuration hashes', async () => {
    const packet = await replayMemoryCases(input(), async () => ({
      text: '合成设备回复',
      inputTokens: 1,
      outputTokens: 1
    }))
    packet.frozen.policyVersion = 'a'.repeat(64)
    packet.frozen.sharedConfigurationHash = replayHash({
      model: packet.input.model,
      knowledge: packet.input.knowledge,
      rules: packet.input.rules,
      policyVersion: packet.frozen.policyVersion,
      retrievalVersion: packet.frozen.retrievalVersion
    })
    for (const receipt of packet.receipts)
      receipt.configurationHash = packet.frozen.sharedConfigurationHash
    expect(() => adjudicateMemoryReplay(packet, annotations(packet))).toThrow(
      'frozen_packet_changed'
    )
  })

  it('stops local collection after a deployed retrieval change and dispatches no next arm', async () => {
    let calls = 0
    await expect(
      replayMemoryCases(input(), async () => {
        calls++
        deployment.changedFile = '/src/core/knowledge/retrieval.ts'
        return { text: '合成设备回复', inputTokens: 1, outputTokens: 1 }
      })
    ).rejects.toThrow('evaluation_environment_changed')
    expect(calls).toBe(1)
  })

  it('uses the real knowledge reply pipeline, freezes manifests and exports blind assignments without labels', async () => {
    const prompts: string[] = []
    const raw = input()
    const frozen = JSON.stringify(raw)
    const packet = await replayMemoryCases(raw, async (system, question) => {
      prompts.push(system)
      expect(question).toBe('设备报价')
      expect(system).toContain('知识依据')
      expect(system).not.toContain('private-rubric')
      expect(system).not.toContain('holdout-1')
      return {
        text: system.includes('工作记忆：')
          ? '学习回复'
          : system.includes('静态方法')
            ? '静态回复'
            : '无记忆回复',
        inputTokens: 20,
        outputTokens: 5
      }
    })
    expect(JSON.stringify(raw)).toBe(frozen)
    expect(prompts).toHaveLength(3)
    expect(prompts.filter((p) => p.includes('先确认型号数量'))).toHaveLength(1)
    expect(prompts.filter((p) => p.includes('静态方法'))).toHaveLength(1)
    expect(packet.receipts.map((r) => r.arm).sort()).toEqual(['baseline', 'learned', 'none'])
    expect(new Set(packet.receipts.map((r) => r.configurationHash)).size).toBe(1)
    expect(new Set(packet.receipts.map((r) => r.memoryManifestHash)).size).toBe(3)
    expect(packet.blind).toHaveLength(3)
    expect(JSON.stringify(packet.blind)).not.toMatch(
      /"arm"|memoryManifestHash|configurationHash|rubricRef|inputTokens/
    )
    expect(packet.receipts.every((r) => r.costUsd === null)).toBe(true)
    expect(() => adjudicateMemoryReplay(packet, [])).toThrow('missing_adjudication')
    const labels = packet.receipts.map((r) => ({
      assignmentId: r.assignmentId,
      origin: 'synthetic',
      reviewerId: 'fixture',
      evidenceRef: 'synthetic-only',
      labelledAt: Date.now() + 1,
      blinded: true,
      humanReviewed: true,
      substantialCorrection: r.arm !== 'learned',
      severeError: false,
      validAnswer: true,
      costUsd: 0,
      costEvidenceRef: 'fake-model-zero-charge'
    }))
    const dataset = adjudicateMemoryReplay(packet, labels)
    expect(evaluateMemoryDataset(dataset).assessment.status).toBe('insufficient')
    expect(dataset.frozen.methods[0].revision).toBe(2)
    expect(dataset.cases.filter((c) => c.split === 'evaluate')).toHaveLength(1)
  })

  it('rejects leakage and request-budget errors before making any model call', async () => {
    for (const mutate of [
      (raw: ReturnType<typeof input>) => {
        raw.cases[0].conversationId = 'learn-conversation'
      },
      (raw: ReturnType<typeof input>) => {
        raw.methods[0].sourceCaseIds = ['holdout-1']
      },
      (raw: ReturnType<typeof input>) => {
        raw.maxRequests = 2
      }
    ]) {
      const raw = input()
      mutate(raw)
      let called = false
      await expect(
        replayMemoryCases(raw, async () => {
          called = true
          throw new Error('must_not_call')
        })
      ).rejects.toThrow()
      expect(called).toBe(false)
    }
  })

  describe('real loopback collection and separate CLI adjudication', () => {
    const requests: unknown[] = []
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      requests.push(JSON.parse(body))
      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify({
          model: 'fake-model',
          choices: [{ finish_reason: 'stop', message: { content: '合成设备回复' } }],
          usage: { prompt_tokens: 12, completion_tokens: 4 }
        })
      )
    })
    const root = resolve('.local/memory-replay-contract-tests')
    const cli = resolve('scripts/memory-replay.ts'),
      tsx = resolve('node_modules/tsx/dist/cli.mjs')
    type Packet = Awaited<ReturnType<typeof replayMemoryCases>>
    let folder: string | undefined,
      packet: Packet,
      crossPacket: Packet,
      packetFile: string,
      labels: ReturnType<typeof annotations>,
      labelsFile: string,
      crossFile: string,
      crossLabels: string,
      emptyLabels: string,
      output: string,
      collectedStdout: string,
      cliRequestCount: number

    beforeAll(async () => {
      deployment.changedFile = ''
      await mkdir(root, { recursive: true })
      folder = await mkdtemp(join(root, 'cli-'))
      await new Promise<void>((resolveReady) => server.listen(0, '127.0.0.1', resolveReady))
      const raw = input()
      raw.model.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
      const file = join(folder, 'input.json')
      output = join(folder, 'replay')
      await writeFile(file, JSON.stringify(raw))
      const collected = await execute(process.execPath, [tsx, cli, 'replay', file, output], {
        env: { ...process.env, MEMORY_REPLAY_API_KEY: 'synthetic-loopback-key' },
        timeout: 10000
      })
      cliRequestCount = requests.length
      collectedStdout = collected.stdout
      packetFile = join(output, 'packet.private.json')
      packet = JSON.parse(await readFile(packetFile, 'utf8')) as Packet
      labels = annotations(packet).map((label, index) => ({
        ...label,
        substantialCorrection: packet.receipts[index].arm !== 'learned',
        costEvidenceRef: 'loopback-no-charge'
      }))
      labelsFile = join(folder, 'labels.json')
      emptyLabels = join(folder, 'empty-labels.json')
      await writeFile(emptyLabels, '[]')
      await writeFile(labelsFile, JSON.stringify(labels))
      // Actual HTTP collection in Vitest and import in tsx exercise different transformations.
      crossPacket = await replayMemoryCases(
        raw,
        replayHttpGenerator(raw.model, 'synthetic-loopback-key')
      )
      crossFile = join(folder, 'cross-packet.json')
      crossLabels = join(folder, 'cross-labels.json')
      await writeFile(crossFile, JSON.stringify(crossPacket))
      await writeFile(
        crossLabels,
        JSON.stringify(
          crossPacket.receipts.map((r, i) => ({
            ...labels[i],
            assignmentId: r.assignmentId,
            labelledAt: Date.now()
          }))
        )
      )
    })

    afterAll(async () => {
      if (server.listening) {
        const closed = new Promise<void>((resolveClosed, reject) =>
          server.close((error) => (error ? reject(error) : resolveClosed()))
        )
        server.closeAllConnections()
        await closed
      }
      if (folder) {
        const relativeFolder = relative(root, resolve(folder))
        if (!relativeFolder || relativeFolder.startsWith('..') || isAbsolute(relativeFolder))
          throw new Error('unsafe_test_folder')
        await rm(folder, { recursive: true, force: true })
      }
    })

    it('collects actual CLI receipts and omits credentials and reply bodies from its journal', async () => {
      expect(cliRequestCount).toBe(3)
      expect(requests).toHaveLength(6)
      expect(collectedStdout).not.toContain('synthetic-loopback-key')
      expect(
        packet.receipts.every(
          (r) => r.inputTokens === 12 && r.outputTokens === 4 && r.costUsd === null
        )
      ).toBe(true)
      const journal = await readFile(join(output, 'requests.jsonl'), 'utf8')
      expect(journal.trim().split('\n')).toHaveLength(6)
      expect(journal).not.toContain('合成设备回复')
      expect(JSON.parse(await readFile(join(output, 'status.json'), 'utf8')).businessVerified).toBe(
        false
      )
      await verifyPrivatePaths(
        output,
        ['packet.private.json', 'blind.json', 'status.json', 'requests.jsonl'].map((name) =>
          join(output, name)
        )
      )
    })

    it('refuses empty independent labels with exit 2 and creates no labelled dataset', async () => {
      const insufficient = join(folder!, 'insufficient')
      await expect(
        execute(process.execPath, [tsx, cli, 'adjudicate', packetFile, emptyLabels, insufficient], {
          timeout: 10000
        })
      ).rejects.toMatchObject({ code: 2 })
      expect(
        JSON.parse(await readFile(join(insufficient, 'status.json'), 'utf8')).assessment
      ).toEqual({ status: 'insufficient', reasons: ['missing_adjudication'] })
      await expect(readFile(join(insufficient, 'labelled.json'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
      await verifyPrivatePaths(insufficient, [join(insufficient, 'status.json')])
    })

    it('imports real CLI-produced packets in a separate process and retains the synthetic verdict', async () => {
      const imported = join(folder!, 'imported')
      await execute(process.execPath, [tsx, cli, 'adjudicate', packetFile, labelsFile, imported], {
        timeout: 10000
      })
      expect(
        evaluateMemoryDataset(JSON.parse(await readFile(join(imported, 'labelled.json'), 'utf8')))
          .assessment.status
      ).toBe('insufficient')
      await verifyPrivatePaths(imported, [join(imported, 'labelled.json')])
    })

    it('protects actual evaluation report files while retaining the synthetic insufficient exit', async () => {
      const evaluated = join(folder!, 'evaluated')
      await expect(
        execute(
          process.execPath,
          [
            tsx,
            resolve('scripts/memory-evaluate.ts'),
            resolve('evals/memory/fixtures/synthetic.json'),
            evaluated
          ],
          { timeout: 10000 }
        )
      ).rejects.toMatchObject({ code: 2 })
      expect(
        JSON.parse(await readFile(join(evaluated, 'report.json'), 'utf8')).assessment.status
      ).toBe('insufficient')
      await verifyPrivatePaths(evaluated, [
        join(evaluated, 'report.json'),
        join(evaluated, 'report.md')
      ])
    })

    it('agrees on deployment hashes across Vitest collection and a separate tsx import', async () => {
      const crossOutput = join(folder!, 'cross-imported')
      await execute(
        process.execPath,
        [tsx, cli, 'adjudicate', crossFile, crossLabels, crossOutput],
        {
          timeout: 10000
        }
      )
      const crossDataset = JSON.parse(await readFile(join(crossOutput, 'labelled.json'), 'utf8'))
      expect(crossDataset.frozen.policyVersion).toBe(crossPacket.frozen.policyVersion)
      expect(evaluateMemoryDataset(crossDataset).assessment.status).toBe('insufficient')
    })

    it('rejects altered receipt manifests and missing metered costs', () => {
      const corrupt = structuredClone(packet)
      corrupt.receipts[0].memoryManifestHash = 'f'.repeat(64)
      expect(() => adjudicateMemoryReplay(corrupt, labels)).toThrow('receipt_configuration_changed')
      const noCost = labels.map((l) => ({ ...l, costUsd: undefined }))
      expect(() => adjudicateMemoryReplay(packet, noCost)).toThrow('missing_metered_cost')
    })
  })

  it('rejects remote HTTP and model drift and retains unknown metering', async () => {
    expect(() =>
      replayHttpGenerator(
        {
          baseURL: 'http://example.com/v1',
          model: 'fake-model',
          expectedModel: 'fake-model',
          maxOutputTokens: 100
        },
        'fake-key'
      )
    ).toThrow()
    let drift = false
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify({
          model: drift ? 'different-model' : 'fake-model',
          choices: [{ finish_reason: 'stop', message: { content: '合成回复' } }]
        })
      )
    })
    await new Promise<void>((resolveReady) => server.listen(0, '127.0.0.1', resolveReady))
    try {
      const generate = replayHttpGenerator(
        {
          baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
          model: 'fake-model',
          expectedModel: 'fake-model',
          maxOutputTokens: 100
        },
        'fake-key'
      )
      expect(await generate('test', 'test', 'test')).toMatchObject({
        inputTokens: null,
        outputTokens: null
      })
      drift = true
      await expect(generate('test', 'test', 'test')).rejects.toThrow('model_changed')
    } finally {
      await new Promise<void>((resolveClosed, reject) =>
        server.close((error) => (error ? reject(error) : resolveClosed()))
      )
    }
  })
})
