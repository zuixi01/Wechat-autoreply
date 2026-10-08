import { randomUUID } from 'node:crypto'
import { KnowledgeBundleSchema } from '../../../src/shared/contracts/knowledge'
import { splitKnowledge } from '../../../src/core/knowledge/retrieval'
import { hashContext } from '../../../src/core/reply/hashes'
import { PublicationSchema, type Publication } from './publication'
import { z } from 'zod'
import { Id } from '../../../src/shared/contracts/identity'

const PreparationSchema = z.strictObject({
  publication: PublicationSchema,
  bundle: KnowledgeBundleSchema,
  approvedBy: z.string().min(1).max(128),
  expiresAt: z.number().int().positive(),
  intents: z.record(z.string(), z.enum(['faq', 'price', 'order', 'aftersales', 'other'])),
  replyRules: z.string().trim().min(1).max(12000)
})
/** Produces a reviewable publication; never publishes, approves evaluation or enables sending. */
export function prepareKnowledgePublication(
  input: unknown,
  tenantId: string,
  accountId: string,
  now = Date.now()
): Publication {
  const request = PreparationSchema.parse(input)
  tenantId = Id.parse(tenantId)
  accountId = Id.parse(accountId)
  if (request.expiresAt <= now) throw new Error('知识有效期必须晚于当前时间。')
  if (!request.bundle.settings.enabled) throw new Error('导出的知识库已暂停，请先启用后再发布。')
  const version = hashContext(request.bundle)
  const evidence = request.bundle.documents.flatMap((document) => {
    const intent = request.intents[document.id]
    if (!intent) throw new Error(`请为资料 ${document.name} 指定业务类别。`)
    return splitKnowledge(document.content).map((content, index) => ({
      evidenceId: `${document.id}-${document.version}-${index}`,
      tenantId,
      accountId,
      intent,
      knowledgeVersion: version,
      kind: 'approved_faq' as const,
      content,
      source: document.name,
      approvedBy: request.approvedBy,
      validFrom: now,
      expiresAt: request.expiresAt
    }))
  })
  if (!evidence.length || evidence.length > 100)
    throw new Error('企业发布需包含 1 至 100 个知识片段，请精简资料后再发布。')
  return PublicationSchema.parse({
    configuration: {
      ...request.publication.configuration,
      configVersion: randomUUID(),
      knowledgeVersion: version,
      automaticEnabled: false
    },
    policy: {
      ...request.publication.policy,
      knowledgeVersion: version,
      mode: 'shadow',
      evaluationApproved: false
    },
    evidence,
    textGeneratorVersion: request.publication.textGeneratorVersion,
    ...(request.publication.memoryCorpusVersion === undefined
      ? {}
      : {
          memoryCorpusVersion: request.publication.memoryCorpusVersion,
          memoryManifest: request.publication.memoryManifest
        }),
    retrieval: 'lexical-v1',
    replyRules: request.replyRules
  })
}
