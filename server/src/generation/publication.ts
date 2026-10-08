import { z } from 'zod'
import type { PoolClient } from 'pg'
import type { AccountAuthority, Scope } from '../auth/account-authority'
import type { ExecutionAuthority } from '../execution/execution-authority'
import { AgentConfigurationSchema } from '../../../src/shared/contracts/generation'
import { Id } from '../../../src/shared/contracts/identity'
import {
  DecisionPolicySchema,
  KnowledgeEvidenceSchema,
  preQuestions,
  auditQuestions
} from '../reply/jev-pipeline'
import { hashContext } from '../../../src/core/reply/hashes'
import { evaluationAuthorized } from './evaluation-authorization'
import {
  EMPTY_ENTERPRISE_MEMORY_VERSION,
  PublishedMemoryManifestSchema,
  loadEnterpriseMemoryCatalog
} from '../learning/learning-publication'

export const PublicationSchema = z
  .strictObject({
    configuration: AgentConfigurationSchema,
    policy: DecisionPolicySchema,
    evidence: z.array(KnowledgeEvidenceSchema).max(100),
    textGeneratorVersion: Id,
    retrieval: z.literal('lexical-v1').optional(),
    replyRules: z.string().trim().min(1).max(12000).optional(),
    evaluationApprovalId: Id.optional(),
    memoryCorpusVersion: Id.optional(),
    memoryManifest: PublishedMemoryManifestSchema.optional()
  })
  .superRefine((p, c) => {
    const cfg = p.configuration,
      policy = p.policy
    if (
      cfg.memoryCorpusVersion !== undefined &&
      cfg.memoryCorpusVersion !== (p.memoryCorpusVersion ?? EMPTY_ENTERPRISE_MEMORY_VERSION)
    )
      c.addIssue({
        code: 'custom',
        message: 'Configuration and published memory catalogue disagree'
      })
    if ((p.memoryCorpusVersion === undefined) !== (p.memoryManifest === undefined))
      c.addIssue({
        code: 'custom',
        message: 'Published memory version and manifest must be supplied together'
      })
    if (
      cfg.decisionPolicyVersion !== policy.version ||
      cfg.knowledgeVersion !== policy.knowledgeVersion ||
      cfg.questionSetVersion !== policy.questionSetVersion ||
      cfg.modelResolved !== policy.modelResolved ||
      (cfg.automaticEnabled && (policy.mode !== 'enforced' || !policy.evaluationApproved))
    )
      c.addIssue({
        code: 'custom',
        message: 'Published configuration and decision policy disagree'
      })
    if (
      new Set(p.evidence.map((e) => e.evidenceId)).size !== p.evidence.length ||
      p.evidence.some((e) => e.knowledgeVersion !== cfg.knowledgeVersion)
    )
      c.addIssue({ code: 'custom', message: 'Knowledge versions or evidence IDs disagree' })
  })
export type Publication = z.infer<typeof PublicationSchema>
type BoundPublication = Publication & {
  memoryCorpusVersion: string
  memoryManifest: z.infer<typeof PublishedMemoryManifestSchema>
}
function bindMemory(input: unknown): BoundPublication {
  const parsed = PublicationSchema.parse(structuredClone(input))
  return {
    ...parsed,
    memoryCorpusVersion: parsed.memoryCorpusVersion ?? EMPTY_ENTERPRISE_MEMORY_VERSION,
    memoryManifest: parsed.memoryManifest ?? []
  }
}
export class GenerationError extends Error {
  constructor(
    readonly code:
      | 'CONFIGURATION_UNAVAILABLE'
      | 'CONFIGURATION_CHANGED'
      | 'TASK_EXPIRED'
      | 'TASK_CONFLICT'
      | 'GENERATION_IN_PROGRESS'
      | 'GENERATION_FAILED'
      | 'GENERATION_OVERLOADED'
      | 'SESSION_INVALID'
      | 'CANCELLED'
  ) {
    super(code)
    this.name = 'GenerationError'
  }
}
/** Trusted server administration only. Never exposed as a device HTTP route. */
export async function savePublication(
  authority: AccountAuthority,
  execution: ExecutionAuthority,
  credential: string,
  input: Publication
): Promise<void> {
  const p = bindMemory(input)
  await authority.withLockedAccount(
    credential,
    async (db, s) => {
      await storePublication(db, s, p)
    },
    true
  )
  // Activating only after the immutable publication exists avoids a broken current
  // version. A crash between these transactions leaves the old version active.
  await execution.publishConfiguration(credential, {
    ...p.configuration,
    memoryCorpusVersion: p.memoryCorpusVersion
  })
}

/** Shared by trusted administration and the internal publication fixture. */
export async function storePublication(
  db: PoolClient,
  s: { tenant_id: string; account_id: string },
  input: Publication
): Promise<void> {
  const p = bindMemory(input)
  const catalog = await loadEnterpriseMemoryCatalog(db, s)
  if (
    p.memoryCorpusVersion !== catalog.memoryCorpusVersion ||
    hashContext(p.memoryManifest) !== hashContext(catalog.memoryManifest)
  )
    throw new GenerationError('TASK_CONFLICT')
  const questionHash = hashContext({ pre: preQuestions(), post: auditQuestions() })
  const publicationHash = hashContext({ publication: p, questionHash })
  if (
    p.evidence.some(
      (e) => e.tenantId !== s.tenant_id || (e.accountId && e.accountId !== s.account_id)
    )
  )
    throw new GenerationError('TASK_CONFLICT')
  if (!(await evaluationAuthorized(db, s, p)))
    throw new GenerationError('CONFIGURATION_UNAVAILABLE')
  const inserted = await db.query(
    `INSERT INTO generation_publications(tenant_id,account_id,config_version,publication_hash,config_json,policy_json,evidence_json,text_generator_version,question_set_hash,evaluation_approval_id,memory_corpus_version,memory_manifest_json)
      VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12::jsonb) ON CONFLICT DO NOTHING RETURNING config_version`,
    [
      s.tenant_id,
      s.account_id,
      p.configuration.configVersion,
      publicationHash,
      JSON.stringify(p.configuration),
      JSON.stringify({
        ...p.policy,
        ...(p.retrieval ? { retrieval: p.retrieval } : {}),
        ...(p.replyRules ? { replyRules: p.replyRules } : {})
      }),
      JSON.stringify(p.evidence),
      p.textGeneratorVersion,
      questionHash,
      p.evaluationApprovalId ?? null,
      p.memoryCorpusVersion,
      JSON.stringify(p.memoryManifest)
    ]
  )
  if (!inserted.rowCount) {
    const old = await db.query(
      'SELECT publication_hash FROM generation_publications WHERE tenant_id=$1 AND account_id=$2 AND config_version=$3',
      [s.tenant_id, s.account_id, p.configuration.configVersion]
    )
    if (old.rows[0]?.publication_hash !== publicationHash)
      throw new GenerationError('TASK_CONFLICT')
  }
}

export async function loadPublication(
  db: PoolClient,
  s: Pick<Scope, 'tenant_id' | 'account_id'>
): Promise<BoundPublication> {
  const row = await db.query(
    `SELECT p.* FROM generation_publications p JOIN published_configurations c
    ON (c.tenant_id,c.account_id,c.config_version)=(p.tenant_id,p.account_id,p.config_version)
    WHERE p.tenant_id=$1 AND p.account_id=$2`,
    [s.tenant_id, s.account_id]
  )
  if (!row.rows[0]) throw new GenerationError('CONFIGURATION_UNAVAILABLE')
  const r = row.rows[0]
  if (r.question_set_hash !== hashContext({ pre: preQuestions(), post: auditQuestions() }))
    throw new GenerationError('CONFIGURATION_CHANGED')
  const p = bindMemory({
    configuration: r.config_json,
    policy: Object.fromEntries(
      Object.entries(r.policy_json).filter(([key]) => !['retrieval', 'replyRules'].includes(key))
    ),
    ...(r.policy_json.retrieval ? { retrieval: r.policy_json.retrieval } : {}),
    ...(r.policy_json.replyRules ? { replyRules: r.policy_json.replyRules } : {}),
    evidence: r.evidence_json,
    textGeneratorVersion: r.text_generator_version,
    memoryCorpusVersion: r.memory_corpus_version,
    memoryManifest: r.memory_manifest_json,
    ...(r.evaluation_approval_id ? { evaluationApprovalId: r.evaluation_approval_id } : {})
  })
  const catalog = await loadEnterpriseMemoryCatalog(db, s)
  if (
    p.memoryCorpusVersion !== catalog.memoryCorpusVersion ||
    hashContext(p.memoryManifest) !== hashContext(catalog.memoryManifest)
  )
    throw new GenerationError('CONFIGURATION_CHANGED')
  const current = await db.query(
    'SELECT * FROM published_configurations WHERE tenant_id=$1 AND account_id=$2',
    [s.tenant_id, s.account_id]
  )
  const c = current.rows[0],
    cfg = p.configuration
  if (
    !c ||
    c.knowledge_version !== cfg.knowledgeVersion ||
    c.policy_version !== cfg.decisionPolicyVersion ||
    c.questions_version !== cfg.questionSetVersion ||
    c.model_resolved !== cfg.modelResolved ||
    c.memory_corpus_version !== p.memoryCorpusVersion ||
    c.automatic_enabled !== cfg.automaticEnabled
  )
    throw new GenerationError('CONFIGURATION_CHANGED')
  if (!(await evaluationAuthorized(db, s, p)))
    throw new GenerationError('CONFIGURATION_UNAVAILABLE')
  return p
}
