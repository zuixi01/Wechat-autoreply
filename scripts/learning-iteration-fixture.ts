import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { z } from 'zod'
import { LearningStore } from '../src/core/memory/learning-store'
import { KnowledgeStore } from '../src/core/knowledge/knowledge-store'
import { KnowledgeReplyService } from '../src/core/knowledge/knowledge-reply'
import { StructuredLearningReviewer } from '../src/core/memory/learning-reviewer'
import { HttpLearningReviewTransport } from '../src/core/memory/learning-transport'
import { LearningService } from '../src/main/services/learning-service'
import { LearningProductValidation } from '../src/main/services/learning-product-validation'
import { LearningKnowledgeAnswers } from '../src/main/services/learning-knowledge'
import type { LearningValidationCase, MemoryScope } from '../src/shared/contracts/learning-memory'
import type { KnowledgeReply } from '../src/shared/contracts/knowledge'

export const ITERATION_V1 = '先确认型号和数量，再查询有效资料'
export const ITERATION_V2 = '先确认型号、数量和用途，再查询有效资料'
export interface IterationModelRequest {
  kind: 'review' | 'risk' | 'reply'
  system: string
  user: string
}
export interface LearningIterationFixture {
  scope: MemoryScope
  store: LearningStore
  knowledge: KnowledgeStore
  service: LearningService
  transport: HttpLearningReviewTransport
  requests: IterationModelRequest[]
  generate(question?: string): Promise<KnowledgeReply>
  advance(ms?: number): void
  close(): Promise<void>
}
export function iterationCalibration(version: 1 | 2): LearningValidationCase[] {
  return Array.from({ length: 5 }, (_, index) => ({
    caseId: `synthetic-calibration-${version}-${index}`,
    conversationId: `synthetic-independent-${index}`,
    input: '设备询价',
    expectedMethod: `human-only-rubric-${version}`,
    requiredTerms: version === 1 ? ['型号', '数量'] : ['型号', '数量', '用途'],
    forbiddenClaims: ['无条件退款'],
    humanLabelled: true,
    labelOrigin: 'human' // Simulated human declaration, never business-effect evidence.
  }))
}

/** A loopback-only fake model; storage, HTTP, review, validation and reply services are real. */
export async function createLearningIterationFixture(
  root: string
): Promise<LearningIterationFixture> {
  let now = Date.now()
  const scope: MemoryScope = {
    workspaceId: 'synthetic-iteration',
    platform: 'generic',
    conversationId: 'synthetic-customer'
  }
  const store = new LearningStore(join(root, 'memory.sqlite'), () => now)
  const knowledge = new KnowledgeStore(join(root, 'knowledge', 'knowledge.sqlite'))
  const document = knowledge.begin('合成设备资料', 'txt', '产品')
  knowledge.finish(document.id, '设备询价应查询当前产品资料，不得猜测价格或作出无据承诺。')
  const requests: IterationModelRequest[] = []
  const model: Server = createServer(async (request, response) => {
    try {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      if (request.headers.authorization !== 'Bearer synthetic-loopback-key')
        throw new Error('invalid_fixture_authority')
      const value = z
        .object({ messages: z.array(z.object({ content: z.string() })).length(2) })
        .parse(JSON.parse(body))
      const [system, user] = value.messages.map((entry) => entry.content)
      let output: unknown
      let kind: IterationModelRequest['kind']
      if (system.includes('loadedMemoryRefs')) {
        kind = 'review'
        const input = z
          .object({
            episodes: z.array(
              z.object({ episodeId: z.string(), correction: z.string().optional() })
            ),
            memories: z.array(z.object({ memoryId: z.string(), expectedRevision: z.number() }))
          })
          .parse(JSON.parse(user))
        const evidence = [...input.episodes].reverse().find((episode) => episode.correction)
        if (!evidence) throw new Error('fixture_correction_missing')
        const memory = input.memories[0]
        output = {
          operations: [
            {
              ...(memory
                ? {
                    action: 'revise',
                    memoryId: memory.memoryId,
                    expectedRevision: memory.expectedRevision
                  }
                : { action: 'create' }),
              proposal: {
                content: {
                  kind: 'lesson',
                  scenario: '设备询价',
                  guidance: evidence.correction,
                  rationale: '合成员工明确纠正',
                  steps: [],
                  pitfalls: [],
                  verification: []
                },
                evidence: [{ episodeId: evidence.episodeId }],
                reason: '合成员工纠正来源'
              }
            }
          ]
        }
      } else if (system.includes('逐项核对外部记忆的语义')) {
        kind = 'risk'
        const input = z
          .object({ contentHash: z.string(), units: z.array(z.object({ path: z.string() })) })
          .parse(JSON.parse(user))
        output = {
          contentHash: input.contentHash,
          units: input.units.map((unit) => ({
            path: unit.path,
            category: 'method',
            reason: '仅为核对流程'
          }))
        }
      } else {
        kind = 'reply'
        const memoryJson = system.split('工作记忆：')[1]?.split('\n')[1]
        const methods = memoryJson
          ? z.array(z.object({ guidance: z.string() })).parse(JSON.parse(memoryJson))
          : []
        output = {
          text: methods.some((method) => method.guidance === ITERATION_V2)
            ? '请确认型号、数量和用途。'
            : methods.some((method) => method.guidance === ITERATION_V1)
              ? '请确认型号和数量。'
              : '请确认型号。'
        }
      }
      requests.push({ kind, system, user })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(output) } }],
          usage: { prompt_tokens: 20, completion_tokens: 10 }
        })
      )
    } catch {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end('{}')
    }
  })
  await new Promise<void>((done) => model.listen(0, '127.0.0.1', done))
  const transport = new HttpLearningReviewTransport({
    baseURL: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
    apiKey: 'synthetic-loopback-key',
    model: 'synthetic-iteration-model'
  })
  const rules = '礼貌回复，业务事实以当前有效资料为准。'
  const validation = new LearningProductValidation(store, {
    knowledge: () => knowledge,
    policy: () => ({ rules, validatorVersion: 'synthetic-product-human-origin-v2' }),
    transport
  })
  const service = new LearningService(store, new StructuredLearningReviewer(transport), {
    workspaceId: scope.workspaceId,
    now: () => now,
    validation
  })
  store.settings(scope, { mode: 'auto', idleDelayMs: 1000 })
  const answers = new LearningKnowledgeAnswers(new KnowledgeReplyService(knowledge), service)
  const Reply = z.strictObject({ text: z.string().min(1) })
  const generate = async (question = '设备询价'): Promise<KnowledgeReply> =>
    answers.answer(
      question,
      rules,
      async (system, user) => {
        const result = await transport.complete(
          { system, user, maxOutputTokens: 2000 },
          new AbortController().signal
        )
        return Reply.parse(JSON.parse(result.text)).text
      },
      scope
    )
  return {
    scope,
    store,
    knowledge,
    service,
    transport,
    requests,
    generate,
    advance: (ms = 1100): void => {
      now += ms
    },
    close: async (): Promise<void> => {
      await service.shutdown()
      model.closeAllConnections()
      await new Promise<void>((done) => model.close(() => done()))
      store.close()
      knowledge.close()
    }
  }
}
