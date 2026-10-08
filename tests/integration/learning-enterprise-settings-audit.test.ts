import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { EnterpriseLearningRepository } from '../../server/src/learning/learning-repository'
import { learningHash } from '../../src/core/memory/learning-scope'
import type { LearningSettings } from '../../src/shared/contracts/learning-memory'

const credentials = ['A'.repeat(43), 'B'.repeat(43)]
const kind = 'learning_model_configuration_changed'
let db: Awaited<ReturnType<typeof embeddedPostgres>>
let repository: EnterpriseLearningRepository

beforeAll(async () => {
  db = await embeddedPostgres()
  await db.adminExec(
    "INSERT INTO tenants(id,name) VALUES('company','synthetic'); INSERT INTO employees(tenant_id,id,role) VALUES('company','employee-A','employee'),('company','employee-B','employee'); INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('company','account-A','employee-A','wework',false),('company','account-B','employee-B','wework',false)"
  )
  for (const [i, suffix] of ['A', 'B'].entries()) {
    await db.adminQuery(
      'INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES($1,$2,$3,$4,$5)',
      [
        'company',
        `agent-${suffix}`,
        `account-${suffix}`,
        `employee-${suffix}`,
        tokenHash(credentials[i])
      ]
    )
  }
  repository = new EnterpriseLearningRepository(new AccountAuthority(db.db))
}, 20000)

afterAll(async () => {
  await db?.db.close()
})

beforeEach(async () => {
  await db.adminExec('TRUNCATE learning_settings,learning_context_epochs,audit_events CASCADE')
})

async function audits(): Promise<Awaited<ReturnType<typeof db.adminQuery>>['rows']> {
  return (
    await db.adminQuery('SELECT * FROM audit_events WHERE kind=$1 ORDER BY created_at,id', [kind])
  ).rows
}

describe('enterprise learning model configuration audit', () => {
  it('records trusted account and actor with bounded hashed model and customer identifiers', async () => {
    const conversation = 'private-customer-13800000000'
    const model = 'private-review-model'
    await repository.settings(credentials[0], conversation, {
      reviewModelId: model,
      maxReviewInputTokens: 4096,
      dailyReviewTokenBudget: 12000
    })
    const rows = await audits()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tenant_id: 'company',
      actor_id: 'employee-A',
      account_id: 'account-A',
      kind,
      details_json: {
        conversationHash: learningHash(conversation),
        changedFields: ['dailyReviewTokenBudget', 'maxReviewInputTokens', 'reviewModelIdHash'],
        before: {
          reviewModelIdHash: learningHash(''),
          maxReviewInputTokens: 8000,
          dailyReviewTokenBudget: 50000
        },
        after: {
          reviewModelIdHash: learningHash(model),
          maxReviewInputTokens: 4096,
          dailyReviewTokenBudget: 12000
        }
      }
    })
    const encoded = JSON.stringify(rows)
    for (const privateValue of [...credentials, conversation, model])
      expect(encoded).not.toContain(privateValue)
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM execution_permits')).rows[0]
    ).toEqual({ n: 0 })
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM learning_activation_grants')).rows[0]
    ).toEqual({ n: 0 })
  })

  it('audits budget, timeout, attempts and idle changes without requiring a model selection change', async () => {
    await repository.settings(credentials[0], null, {
      maxReviewInputTokens: 1024,
      dailyReviewTokenBudget: 0,
      reviewTimeoutMs: 2000,
      maxAttempts: 2,
      idleDelayMs: 1000
    })
    expect(await audits()).toMatchObject([
      {
        details_json: {
          conversationHash: learningHash(''),
          changedFields: [
            'dailyReviewTokenBudget',
            'idleDelayMs',
            'maxAttempts',
            'maxReviewInputTokens',
            'reviewTimeoutMs'
          ],
          after: { reviewTimeoutMs: 2000, maxAttempts: 2, idleDelayMs: 1000 }
        }
      }
    ])
  })

  it('does not record reads, same values or a child override equal to its inherited configuration', async () => {
    await repository.settings(credentials[0], null)
    await repository.settings(credentials[0], null, {
      reviewModelId: '',
      maxReviewInputTokens: 8000
    })
    expect(await audits()).toEqual([])
    await repository.settings(credentials[0], null, {
      reviewModelId: 'review-model',
      dailyReviewTokenBudget: 9000
    })
    await repository.settings(credentials[0], 'customer', {
      reviewModelId: 'review-model',
      dailyReviewTokenBudget: 9000
    })
    await repository.settings(credentials[0], 'customer')
    expect(await audits()).toHaveLength(1)
  })

  it('keeps a child override under a parent off switch without claiming an effective mode change', async () => {
    await repository.settings(credentials[0], null, { mode: 'off' })
    const before = await audits()
    expect(before).toHaveLength(1)
    expect(await repository.settings(credentials[0], 'customer', { mode: 'auto' })).toMatchObject({
      mode: 'off'
    })
    expect(await audits()).toEqual(before)
    expect(
      (
        await db.adminQuery(
          'SELECT payload FROM learning_settings WHERE account_id=$1 AND conversation_id=$2',
          ['account-A', 'customer']
        )
      ).rows[0]
    ).toMatchObject({ payload: { mode: 'auto' } })
  })

  it('derives another account from its credential and refuses forged configuration authority and revoked devices', async () => {
    const hostile = {
      reviewModelId: 'forged',
      accountId: 'account-B',
      apiKey: 'private-key',
      endpoint: 'https://private.invalid'
    }
    await expect(
      repository.settings(credentials[0], null, hostile as Partial<LearningSettings>)
    ).rejects.toThrow()
    expect(await audits()).toEqual([])
    await repository.settings(credentials[1], null, { reviewModelId: 'model-B' })
    expect((await audits())[0]).toMatchObject({ account_id: 'account-B', actor_id: 'employee-B' })
    expect((await repository.settings(credentials[0], null)).reviewModelId).toBe('')
    await db.adminExec("UPDATE agents SET revoked_at=clock_timestamp() WHERE id='agent-A'")
    try {
      await expect(
        repository.settings(credentials[0], null, { reviewModelId: 'late' })
      ).rejects.toThrow('DENIED')
      expect(await audits()).toHaveLength(1)
    } finally {
      await db.adminExec("UPDATE agents SET revoked_at=NULL WHERE id='agent-A'")
    }
  })

  it('rolls back the setting and context version when the audit insert is denied', async () => {
    await repository.settings(credentials[0], null, { reviewModelId: 'before' })
    const before = await db.adminQuery('SELECT payload FROM learning_settings')
    const epoch = await db.adminQuery('SELECT * FROM learning_context_epochs')
    await db.adminExec('REVOKE INSERT ON audit_events FROM autoreply_app')
    try {
      await expect(
        repository.settings(credentials[0], null, {
          reviewModelId: 'after',
          dailyReviewTokenBudget: 7000
        })
      ).rejects.toThrow('permission denied')
      expect((await db.adminQuery('SELECT payload FROM learning_settings')).rows).toEqual(
        before.rows
      )
      expect((await db.adminQuery('SELECT * FROM learning_context_epochs')).rows).toEqual(
        epoch.rows
      )
      expect(await audits()).toHaveLength(1)
    } finally {
      await db.adminExec('GRANT INSERT ON audit_events TO autoreply_app')
    }
  })

  it('retains only anonymous configuration evidence after scoped forgetting', async () => {
    const conversation = 'private-forgotten-customer'
    const model = 'private-forgotten-model'
    await repository.settings(credentials[0], conversation, { reviewModelId: model })
    await repository.forgetScope(credentials[0], conversation)
    expect((await db.adminQuery('SELECT payload FROM learning_settings')).rows).toEqual([])
    const rows = await audits()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      details_json: { conversationHash: learningHash(conversation) }
    })
    const encoded = JSON.stringify(rows)
    expect(encoded).not.toContain(conversation)
    expect(encoded).not.toContain(model)
  })
})
