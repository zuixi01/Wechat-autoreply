import type { PoolClient } from 'pg'
import { AgentConfigurationSchema } from '../../../src/shared/contracts/generation'
import type { AgentConfiguration } from '../../../src/core/agent/reliable-agent'
import { EMPTY_ENTERPRISE_MEMORY_VERSION } from '../../../src/shared/contracts/learning-task'

/** Caller must hold the account lock and have authenticated its administrative scope. */
export async function writeConfiguration(
  db: PoolClient,
  scope: { tenant_id: string; account_id: string },
  input: AgentConfiguration
): Promise<void> {
  const c = AgentConfigurationSchema.parse(input)
  await db.query(
    `INSERT INTO published_configurations(tenant_id,account_id,config_version,knowledge_version,policy_version,questions_version,model_resolved,automatic_enabled,memory_corpus_version)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,account_id) DO UPDATE SET
    config_version=EXCLUDED.config_version,knowledge_version=EXCLUDED.knowledge_version,policy_version=EXCLUDED.policy_version,
    questions_version=EXCLUDED.questions_version,model_resolved=EXCLUDED.model_resolved,automatic_enabled=EXCLUDED.automatic_enabled,memory_corpus_version=EXCLUDED.memory_corpus_version`,
    [
      scope.tenant_id,
      scope.account_id,
      c.configVersion,
      c.knowledgeVersion,
      c.decisionPolicyVersion,
      c.questionSetVersion,
      c.modelResolved,
      c.automaticEnabled,
      c.memoryCorpusVersion ?? EMPTY_ENTERPRISE_MEMORY_VERSION
    ]
  )
}
