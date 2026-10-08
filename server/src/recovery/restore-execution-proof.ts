import { z } from 'zod'
import { hashContext } from '../../../src/core/reply/hashes'
import {
  RestoreExecutionReviewInputSchema,
  RestoreExecutionSubjectSchema,
  type RestoreExecutionReviewInput,
  type RestoreExecutionSubject
} from '../../../src/shared/contracts/restore-execution'
import type { RestoreHistoryProof } from '../../../src/shared/contracts/restore-history'
import { RestoreInventoryItemSchema } from '../../../src/shared/contracts/restore-inventory'
import type { RestoreAssessment } from '../admin/restore-assessment'
import type { RestorePermitAuditItem } from '../admin/restore-permit-audit'

export class RestoreExecutionError extends Error {
  constructor(readonly code: 'restore_execution_conflict' | 'restore_execution_not_ready') {
    super(code)
  }
}
function fail(): never {
  throw new RestoreExecutionError('restore_execution_conflict')
}
function principalHash(principal: {
  agentId: string
  loginEpoch: number | string
  clientInstanceId: string
  taskId: string
  taskHash: string
  draftHash: string
  conversationId: string
}): string {
  return hashContext({ ...principal, loginEpoch: String(principal.loginEpoch) })
}
/** Derived only from the full authenticated assessment, never from a submitter's page. */
export function restoreExecutionSubjects(assessment: RestoreAssessment): RestoreExecutionSubject[] {
  const centralByPrincipal = new Map<string, string[]>()
  const centralByTask = new Map<string, string[]>()
  for (const s of assessment.items) {
    if (s.kind !== 'central_permit') continue
    const audit = s.metadata as RestorePermitAuditItem,
      c = audit.current
    if (
      !c ||
      !audit.metadataComplete ||
      audit.comparison === 'identity_changed' ||
      audit.comparison === 'missing_current' ||
      !c.taskHash ||
      c.loginEpoch === null ||
      !c.clientInstanceId ||
      !c.conversationId
    )
      continue
    const key = principalHash({
      agentId: c.agentId,
      loginEpoch: c.loginEpoch,
      clientInstanceId: c.clientInstanceId,
      taskId: c.taskId,
      taskHash: c.taskHash,
      draftHash: c.draftHash,
      conversationId: c.conversationId
    })
    const ids = centralByPrincipal.get(key) ?? []
    ids.push(c.permitId)
    centralByPrincipal.set(key, ids)
    const principals = centralByTask.get(c.taskId) ?? []
    principals.push(key)
    centralByTask.set(c.taskId, principals)
  }
  return assessment.items
    .filter((s) => s.requiredEvidence === 'execution_outcome')
    .map((s) => {
      let group: string,
        principal: unknown,
        conversation: string,
        draft: string,
        earliest: number,
        outcome: 'confirmed' | 'not_sent' | null = null
      if (s.kind === 'local_execution') {
        const local = RestoreInventoryItemSchema.parse((s.metadata as { local: unknown }).local)
        if (
          local.kind !== 'execution' ||
          s.reasons.some((r) =>
            [
              'central_permit_missing',
              'central_identity_mismatch',
              'central_task_mismatch'
            ].includes(r)
          )
        )
          fail()
        group = local.permitId ? `permit:${local.permitId}` : `local:${local.executionId}`
        principal = {
          agentId: local.identity.agentId,
          loginEpoch: String(local.identity.loginEpoch),
          clientInstanceId: local.identity.clientInstanceId,
          taskId: local.taskId,
          taskHash: local.taskHash,
          draftHash: local.draftHash,
          conversationId: local.conversationId
        }
        if (!local.permitId) {
          if ((centralByTask.get(local.taskId) ?? []).some((key) => key !== hashContext(principal)))
            fail()
          const found = centralByPrincipal.get(hashContext(principal)) ?? []
          if (found.length > 1) fail()
          if (found.length === 1) group = `permit:${found[0]}`
        }
        conversation = local.conversationId
        draft = local.draftHash
        earliest = local.createdAt
        const confirmed =
          local.status === 'confirmed' ||
          local.receiptStatus === 'confirmed' ||
          local.permitStatus === 'confirmed'
        const notSent =
          ['cancelled', 'rejected'].includes(local.status) ||
          local.receiptStatus === 'not_sent' ||
          local.permitStatus === 'not_sent'
        if (confirmed && notSent) fail()
        outcome = confirmed ? 'confirmed' : notSent ? 'not_sent' : null
      } else if (s.kind === 'central_permit') {
        const central = s.metadata as RestorePermitAuditItem,
          c = central.current
        if (
          !c ||
          !central.metadataComplete ||
          central.comparison === 'identity_changed' ||
          central.comparison === 'missing_current' ||
          !c.taskHash ||
          c.loginEpoch === null ||
          !c.clientInstanceId ||
          !c.conversationId
        )
          fail()
        group = `permit:${c.permitId}`
        principal = {
          agentId: c.agentId,
          loginEpoch: String(c.loginEpoch),
          clientInstanceId: c.clientInstanceId,
          taskId: c.taskId,
          taskHash: c.taskHash,
          draftHash: c.draftHash,
          conversationId: c.conversationId
        }
        conversation = c.conversationId
        draft = c.draftHash
        earliest = Date.parse(c.issuedAt)
        outcome =
          c.status === 'confirmed' ? 'confirmed' : c.status === 'not_sent' ? 'not_sent' : null
      } else fail()
      return RestoreExecutionSubjectSchema.parse({
        subjectKey: s.key,
        subjectHash: s.subjectHash,
        kind: s.kind,
        executionGroup: group,
        principalHash: hashContext(principal),
        conversationId: conversation,
        draftHash: draft,
        earliestSendAt: earliest,
        recordedOutcome: outcome
      })
    })
    .sort((a, b) => (a.subjectKey < b.subjectKey ? -1 : a.subjectKey > b.subjectKey ? 1 : 0))
}
/** Matches authenticated source anchors to an independent maintenance review.
 * Does not verify physical causality/journal contents or grant reconciliation rights. */
export function checkRestoreExecutionOutcomes(
  raw: unknown,
  rawSubjects: unknown,
  history: RestoreHistoryProof,
  stoppedAt: number,
  now: number
): {
  input: RestoreExecutionReviewInput
  subjects: RestoreExecutionSubject[]
  confirmed: number
  notSent: number
  executionGroups: number
  outcomesHash: string
} {
  z.number().int().nonnegative().safe().parse(stoppedAt)
  z.number().int().nonnegative().safe().parse(now)
  if (
    !Array.isArray(rawSubjects) ||
    rawSubjects.length > 2000000 ||
    Buffer.byteLength(JSON.stringify(raw) ?? '') > 1048576
  )
    fail()
  const input = RestoreExecutionReviewInputSchema.parse(raw),
    subjects = z.array(RestoreExecutionSubjectSchema).max(2000000).parse(rawSubjects)
  if (
    input.caseId !== history.caseId ||
    input.uploadId !== history.uploadId ||
    input.historyProofId !== history.proofId ||
    input.tenantId !== history.scope.tenant_id ||
    input.accountId !== history.scope.account_id ||
    input.reviewedAt < history.capturedAt ||
    input.reviewedAt > now ||
    now - input.reviewedAt > 300000 ||
    history.observedThrough < stoppedAt ||
    subjects.length !== input.outcomes.length
  )
    fail()
  const byKey = new Map(subjects.map((s) => [s.subjectKey, s]))
  if (
    byKey.size !== subjects.length ||
    subjects.some((s, i) => i > 0 && subjects[i - 1].subjectKey >= s.subjectKey)
  )
    fail()
  const seen = new Set<string>(),
    groups = new Map<
      string,
      { principal: string; outcome: string; evidence: string; local: number; central: number }
    >()
  const usedEvidence = new Map<string, string>()
  const conversations = new Map(
    history.conversations.map((c) => [
      c.conversationId,
      new Map(c.messages.map((m) => [m.sourceMessageId, m]))
    ])
  )
  let confirmed = 0,
    notSent = 0
  for (const outcome of input.outcomes) {
    const s = byKey.get(outcome.subjectKey)
    if (
      !s ||
      seen.has(s.subjectKey) ||
      outcome.subjectHash !== s.subjectHash ||
      outcome.conversationId !== s.conversationId ||
      outcome.observedAt < Math.max(stoppedAt, s.earliestSendAt) ||
      outcome.observedAt > history.observedThrough ||
      outcome.observedAt > input.reviewedAt ||
      (s.recordedOutcome !== null && s.recordedOutcome !== outcome.outcome)
    )
      fail()
    seen.add(s.subjectKey)
    let evidence: string
    if (outcome.outcome === 'confirmed') {
      const m = conversations.get(s.conversationId)?.get(outcome.sourceMessageId)
      if (
        !m ||
        m.direction !== 'automation_outbound' ||
        m.contentHash !== outcome.sourceContentHash ||
        outcome.draftTextHash !== s.draftHash ||
        m.sentAt < s.earliestSendAt ||
        m.sentAt > outcome.observedAt
      )
        fail()
      evidence = `message:${hashContext({ conversationId: s.conversationId, sourceMessageId: m.sourceMessageId })}`
      confirmed++
    } else {
      evidence = `journal:${outcome.dispatchJournalEntrySha256}`
      notSent++
    }
    if (usedEvidence.has(evidence) && usedEvidence.get(evidence) !== s.executionGroup) fail()
    usedEvidence.set(evidence, s.executionGroup)
    const group = groups.get(s.executionGroup) ?? {
      principal: s.principalHash,
      outcome: outcome.outcome,
      evidence,
      local: 0,
      central: 0
    }
    if (
      group.principal !== s.principalHash ||
      group.outcome !== outcome.outcome ||
      group.evidence !== evidence
    )
      fail()
    group[s.kind === 'local_execution' ? 'local' : 'central']++
    if (group.local > 1 || group.central > 1) fail()
    groups.set(s.executionGroup, group)
  }
  return {
    input,
    subjects,
    confirmed,
    notSent,
    executionGroups: groups.size,
    outcomesHash: hashContext(
      [...input.outcomes].sort((a, b) => (a.subjectKey < b.subjectKey ? -1 : 1))
    )
  }
}
