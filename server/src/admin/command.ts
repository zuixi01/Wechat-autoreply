import { parseArgs } from 'node:util'
import { z } from 'zod'
import { Id } from '../../../src/shared/contracts/identity'
import type { Administration } from './administration'
import { PublicationSchema } from '../generation/publication'

const base = { tenant: Id }
const PageLimit = z.union([
  z.number().int().min(1).max(100),
  z
    .string()
    .regex(/^[1-9][0-9]{0,2}$/)
    .transform(Number)
    .pipe(z.number().int().max(100))
])
const commands = z.discriminatedUnion('command', [
  z.strictObject({ ...base, command: z.literal('restore-completion-audit'), account: Id }),
  z.strictObject({
    ...base,
    command: z.literal('restore-recovery-preview'),
    account: Id,
    case: z.uuid(),
    upload: z.uuid(),
    review: z.uuid()
  }),
  z.strictObject({
    ...base,
    command: z.literal('restore-recovery-authorization'),
    account: Id,
    case: z.uuid(),
    authorization: z.uuid()
  }),
  z.strictObject({
    ...base,
    command: z.literal('restore-resolution-basis'),
    account: Id,
    case: z.uuid(),
    review: z.uuid()
  }),
  z.strictObject({
    ...base,
    command: z.literal('restore-execution-review'),
    account: Id,
    case: z.uuid(),
    review: z.uuid()
  }),
  z.strictObject({
    ...base,
    command: z.literal('record-restore-history-proof'),
    account: Id,
    case: z.uuid(),
    upload: z.uuid(),
    file: z.string().min(1).max(2048)
  }),
  z.strictObject({
    ...base,
    command: z.literal('restore-history-proof'),
    account: Id,
    case: z.uuid(),
    proof: z.uuid()
  }),
  z.strictObject({
    ...base,
    command: z.literal('request-pause-all'),
    request: z.uuid().optional()
  }),
  z.strictObject({ ...base, command: z.literal('pause-all-request'), request: z.uuid() }),
  z.strictObject({
    ...base,
    command: z.literal('pause-all-accounts'),
    request: z.uuid(),
    after: z.string().min(1).max(2048).optional(),
    limit: PageLimit.optional()
  }),
  z.strictObject({
    ...base,
    command: z.enum(['request-pause', 'pause-request']),
    account: Id,
    request: z.uuid().optional()
  }),
  z.strictObject({
    ...base,
    command: z.literal('runtime-status'),
    account: Id.optional(),
    after: z.string().min(1).max(2048).optional(),
    limit: PageLimit.optional()
  }),
  z
    .strictObject({
      ...base,
      command: z.literal('restore-rulings'),
      account: Id,
      case: z.uuid(),
      upload: z.uuid(),
      after: z.string().min(1).max(256).optional(),
      limit: PageLimit.optional(),
      basis: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      rulings: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional()
    })
    .refine((c) => !c.after || (!!c.basis && !!c.rulings)),
  z.strictObject({
    ...base,
    command: z.enum(['record-restore-ruling', 'seal-restore-decision']),
    account: Id,
    case: z.uuid(),
    upload: z.uuid(),
    file: z.string().min(1).max(2048)
  }),
  z.strictObject({
    ...base,
    command: z.literal('restore-decision'),
    account: Id,
    case: z.uuid(),
    upload: z.uuid(),
    decision: z.uuid()
  }),
  z
    .strictObject({
      ...base,
      command: z.literal('restore-assessment'),
      account: Id,
      case: z.uuid(),
      upload: z.uuid(),
      after: z.string().min(1).max(256).optional(),
      limit: PageLimit.optional(),
      basis: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional()
    })
    .refine((c) => !c.after || !!c.basis),
  z.strictObject({
    ...base,
    command: z.literal('restore-evidence'),
    account: Id,
    case: z.uuid(),
    upload: z.uuid(),
    after: z.uuid().optional(),
    limit: PageLimit.optional()
  }),
  z.strictObject({
    ...base,
    command: z.literal('record-restore-evidence'),
    account: Id,
    case: z.uuid(),
    upload: z.uuid(),
    file: z.string().min(1).max(2048)
  }),
  z.strictObject({
    ...base,
    command: z.literal('restore-inventories'),
    account: Id,
    case: z.uuid(),
    after: z.uuid().optional(),
    limit: PageLimit.optional()
  }),
  z.strictObject({
    ...base,
    command: z.literal('restore-inventory-items'),
    account: Id,
    case: z.uuid(),
    upload: z.uuid(),
    after: z.string().min(1).max(256).optional(),
    limit: PageLimit.optional()
  }),
  z.strictObject({
    ...base,
    command: z.literal('restore-permit-audit'),
    account: Id,
    case: z.uuid(),
    after: Id.optional(),
    limit: PageLimit.optional(),
    basis: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
  }),
  z.strictObject({ ...base, command: z.literal('accounts') }),
  z.strictObject({
    ...base,
    command: z.literal('provision'),
    account: Id,
    employee: Id,
    platform: z.enum(['wechat', 'wework'])
  }),
  ...(
    [
      'enroll',
      'pause',
      'resume',
      'unresolved',
      'evaluations',
      'reconciliations',
      'request-seals',
      'model-limits',
      'restore-reviews'
    ] as const
  ).map((command) => z.strictObject({ ...base, command: z.literal(command), account: Id })),
  z.strictObject({ ...base, command: z.literal('model-runs'), account: Id, task: Id }),
  z.strictObject({
    ...base,
    command: z.literal('open-restore-review'),
    account: Id,
    file: z.string().min(1).max(2048)
  }),
  z.strictObject({ ...base, command: z.literal('restore-review'), account: Id, case: z.uuid() }),
  z.strictObject({
    ...base,
    command: z.literal('restore-pause-report'),
    account: Id,
    case: z.uuid(),
    challenge: z.uuid()
  }),
  z.strictObject({
    ...base,
    command: z.literal('restore-pause-reports'),
    account: Id,
    case: z.uuid(),
    after: z.uuid().optional(),
    limit: PageLimit.optional()
  }),
  z.strictObject({
    ...base,
    command: z.literal('restore-review-permits'),
    account: Id,
    case: z.uuid(),
    after: Id.optional(),
    limit: PageLimit.optional()
  }),
  z.strictObject({ ...base, command: z.literal('model-usage'), account: Id, date: z.iso.date() }),
  z.strictObject({ ...base, command: z.literal('revoke'), account: Id, agent: Id }),
  z.strictObject({ ...base, command: z.literal('open-reconciliation'), account: Id, permit: Id }),
  z.strictObject({
    ...base,
    command: z.literal('reconciliation'),
    account: Id,
    case: z.string().uuid()
  }),
  z.strictObject({
    ...base,
    command: z.enum(['record-reconciliation-note', 'decide-reconciliation']),
    account: Id,
    case: z.string().uuid(),
    file: z.string().min(1).max(2048)
  }),
  z.strictObject({ ...base, command: z.literal('revoke-evaluation'), account: Id, approval: Id }),
  z.strictObject({
    ...base,
    command: z.literal('approve-evaluation'),
    account: Id,
    run: Id,
    file: z.string().min(1).max(2048)
  }),
  z.strictObject({
    ...base,
    command: z.literal('prepare-learning'),
    account: Id,
    file: z.string().min(1).max(2048),
    out: z.string().min(1).max(2048)
  }),
  z.strictObject({
    ...base,
    command: z.enum(['publish', 'freeze-evaluation', 'set-model-limits']),
    account: Id,
    file: z.string().min(1).max(2048)
  })
])
export type AdminCommand = z.infer<typeof commands>
export function parseAdminCommand(args: string[]): AdminCommand {
  const { positionals, values, tokens } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    tokens: true,
    options: {
      tenant: { type: 'string' },
      account: { type: 'string' },
      employee: { type: 'string' },
      platform: { type: 'string' },
      agent: { type: 'string' },
      file: { type: 'string' },
      out: { type: 'string' },
      run: { type: 'string' },
      approval: { type: 'string' },
      permit: { type: 'string' },
      case: { type: 'string' },
      task: { type: 'string' },
      date: { type: 'string' },
      after: { type: 'string' },
      limit: { type: 'string' },
      challenge: { type: 'string' },
      basis: { type: 'string' },
      upload: { type: 'string' },
      rulings: { type: 'string' },
      decision: { type: 'string' },
      request: { type: 'string' },
      proof: { type: 'string' },
      review: { type: 'string' },
      authorization: { type: 'string' }
    }
  })
  const seen = new Set<string>()
  for (const token of tokens) {
    if (token.kind !== 'option') continue
    if (seen.has(token.name)) throw new Error('duplicate_admin_option')
    seen.add(token.name)
  }
  if (positionals.length !== 1) throw new Error('invalid_admin_command')
  return commands.parse({ command: positionals[0], ...values })
}
export async function executeAdminCommand(
  admin: Administration,
  command: AdminCommand,
  readPublication: (path: string) => Promise<unknown>,
  writePrivatePublication?: (path: string, publication: unknown) => Promise<void>
): Promise<unknown> {
  const c = commands.parse(command)
  switch (c.command) {
    case 'restore-completion-audit':
      return admin.restoreCompletionAudit(c.tenant, c.account)
    case 'restore-recovery-preview':
      return admin.previewRestoreRecovery(c.tenant, c.account, c.case, c.upload, c.review)
    case 'restore-recovery-authorization':
      return admin.restoreRecoveryAuthorization(c.tenant, c.account, c.case, c.authorization)
    case 'restore-resolution-basis':
      return admin.restoreResolutionBasis(c.tenant, c.account, c.case, c.review)
    case 'restore-execution-review':
      return admin.restoreExecutionReview(c.tenant, c.account, c.case, c.review)
    case 'record-restore-history-proof':
      // Authenticate before opening the administrator file; the mutation authenticates again.
      await admin.identity(c.tenant)
      return admin.recordRestoreHistoryProof(
        c.tenant,
        c.account,
        c.case,
        c.upload,
        await readPublication(c.file)
      )
    case 'restore-history-proof':
      return admin.restoreHistoryProof(c.tenant, c.account, c.case, c.proof)
    case 'request-pause-all':
      return admin.requestPauseAll(c.tenant, c.request)
    case 'pause-all-request':
      return admin.pauseAllRequest(c.tenant, c.request)
    case 'pause-all-accounts':
      return admin.pauseAllAccounts(c.tenant, c.request, { after: c.after, limit: c.limit })
    case 'request-pause':
      return admin.requestPause(c.tenant, c.account, c.request)
    case 'pause-request':
      return admin.pauseRequest(c.tenant, c.account, c.request)
    case 'prepare-learning': {
      if (!writePrivatePublication) throw new Error('private_admin_writer_required')
      const prepared = await admin.prepareLearningPublication(
        c.tenant,
        c.account,
        await readPublication(c.file)
      )
      await writePrivatePublication(c.out, prepared.publication)
      return prepared.summary
    }
    case 'runtime-status':
      return admin.runtimeStatus(c.tenant, { accountId: c.account, after: c.after, limit: c.limit })
    case 'restore-rulings':
      return admin.restoreRulings(c.tenant, c.account, c.case, c.upload, {
        after: c.after,
        limit: c.limit,
        expectedBasisHash: c.basis,
        expectedRulingsHash: c.rulings
      })
    case 'record-restore-ruling':
      return admin.recordRestoreRuling(
        c.tenant,
        c.account,
        c.case,
        c.upload,
        await readPublication(c.file)
      )
    case 'seal-restore-decision':
      return admin.sealRestoreDecision(
        c.tenant,
        c.account,
        c.case,
        c.upload,
        await readPublication(c.file)
      )
    case 'restore-decision':
      return admin.restoreDecision(c.tenant, c.account, c.case, c.upload, c.decision)
    case 'restore-assessment':
      return admin.restoreAssessment(c.tenant, c.account, c.case, c.upload, {
        after: c.after,
        limit: c.limit,
        expectedBasisHash: c.basis
      })
    case 'restore-evidence':
      return admin.restoreEvidence(c.tenant, c.account, c.case, c.upload, {
        after: c.after,
        limit: c.limit
      })
    case 'record-restore-evidence':
      return admin.recordRestoreEvidence(
        c.tenant,
        c.account,
        c.case,
        c.upload,
        await readPublication(c.file)
      )
    case 'restore-inventories':
      return {
        inventories: await admin.restoreInventories(c.tenant, c.account, c.case, {
          after: c.after,
          limit: c.limit
        })
      }
    case 'restore-inventory-items':
      return admin.restoreInventoryItems(c.tenant, c.account, c.case, c.upload, {
        after: c.after,
        limit: c.limit
      })
    case 'restore-permit-audit':
      return admin.restorePermitAudit(c.tenant, c.account, c.case, {
        after: c.after,
        limit: c.limit,
        expectedBasisHash: c.basis
      })
    case 'accounts':
      return { accounts: await admin.accounts(c.tenant) }
    case 'open-restore-review':
      return admin.openRestoreReview(c.tenant, c.account, await readPublication(c.file))
    case 'restore-reviews':
      return { restoreReviews: await admin.restoreReviews(c.tenant, c.account) }
    case 'restore-review':
      return admin.restoreReview(c.tenant, c.account, c.case)
    case 'restore-pause-report':
      return admin.restorePauseReport(c.tenant, c.account, c.case, c.challenge)
    case 'restore-pause-reports':
      return {
        reports: await admin.restorePauseReports(c.tenant, c.account, c.case, {
          after: c.after,
          limit: c.limit
        })
      }
    case 'restore-review-permits':
      return {
        permits: await admin.restoreReviewPermits(c.tenant, c.account, c.case, {
          after: c.after,
          limit: c.limit
        })
      }
    case 'unresolved':
      return { executions: await admin.unresolved(c.tenant, c.account) }
    case 'request-seals':
      return { requestSeals: await admin.requestSeals(c.tenant, c.account) }
    case 'model-limits':
      return admin.modelLimits(c.tenant, c.account)
    case 'set-model-limits':
      return admin.setModelLimits(c.tenant, c.account, await readPublication(c.file))
    case 'model-runs':
      return { modelRuns: await admin.modelRuns(c.tenant, c.account, c.task) }
    case 'model-usage':
      return {
        date: c.date,
        timezone: 'UTC',
        stages: await admin.modelUsage(c.tenant, c.account, c.date)
      }
    case 'open-reconciliation':
      return admin.openReconciliation(c.tenant, c.account, c.permit)
    case 'reconciliations':
      return { cases: await admin.reconciliations(c.tenant, c.account) }
    case 'reconciliation':
      return admin.reconciliation(c.tenant, c.account, c.case)
    case 'record-reconciliation-note':
      return admin.recordReconciliationNote(
        c.tenant,
        c.account,
        c.case,
        await readPublication(c.file)
      )
    case 'decide-reconciliation':
      return admin.decideReconciliation(c.tenant, c.account, c.case, await readPublication(c.file))
    case 'enroll':
      return admin.enroll(c.tenant, c.account)
    case 'evaluations':
      return { evaluations: await admin.evaluations(c.tenant, c.account) }
    case 'freeze-evaluation':
      return admin.freezeEvaluation(c.tenant, c.account, await readPublication(c.file))
    case 'approve-evaluation':
      return admin.approveEvaluation(c.tenant, c.account, c.run, await readPublication(c.file))
    case 'revoke-evaluation':
      await admin.revokeEvaluation(c.tenant, c.account, c.approval)
      break
    case 'provision':
      await admin.provision(c.tenant, {
        employeeId: c.employee,
        accountId: c.account,
        platform: c.platform
      })
      break
    case 'pause':
      await admin.pause(c.tenant, c.account)
      break
    case 'resume':
      await admin.resume(c.tenant, c.account)
      break
    case 'revoke':
      await admin.revoke(c.tenant, c.account, c.agent)
      break
    case 'publish':
      await admin.publish(
        c.tenant,
        c.account,
        PublicationSchema.parse(await readPublication(c.file))
      )
      break
  }
  // Central allow/deny is not an acknowledgment from the employee's machine.
  return {
    success: true,
    command: c.command,
    tenantId: c.tenant,
    accountId: c.account,
    devicePauseAcknowledged: null
  }
}
