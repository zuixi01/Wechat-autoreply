import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { Ledger } from '../../src/core/persistence/ledger'
import { createLedgerBackup, restoreLedgerBackup } from '../../src/core/persistence/ledger-backup'
import { hashContext } from '../../src/core/reply/hashes'
import { requestNonDispatchProof } from '../../src/core/sending/request-seal-proof'
import { RestoreRecoveryPackageSchema } from '../../src/shared/contracts/restore-recovery'
import {
  restoreExecutionPrincipalHash,
  parseRestoreResolutionPackage,
  type RestoreResolutionRecord
} from '../../src/shared/contracts/restore-resolution'
import { type RestoreExecutionSubject } from '../../src/shared/contracts/restore-execution'
import { type RestoreInventoryItem } from '../../src/shared/contracts/restore-inventory'
import { taskFixture } from './task'

/** Synthetic facts only. Real SQLite backup/provenance; no physical source trust. */
export async function restoreResolutionFixture(
  registerRoot: (root: string) => void,
  count = 61,
  restoreAgain = false
) {
  const root = mkdtempSync(join(tmpdir(), 'restore-resolution-'))
  registerRoot(root)
  const file = join(root, 'source.sqlite'),
    source = new Ledger(file),
    f = taskFixture(),
    scope = {
      tenant_id: f.task.identity.tenantId,
      account_id: f.task.identity.accountId,
      employee_id: f.task.identity.employeeId,
      agent_id: f.task.identity.agentId,
      platform: f.task.identity.platform
    }
  source.observe({
    identity: f.task.identity,
    conversationId: f.task.conversationId,
    sourceMessageId: 'inbound-1',
    direction: 'inbound',
    kind: 'text',
    text: 'synthetic',
    observedAt: 1000,
    identityVerified: true,
    messageIdVerified: true
  })
  for (let i = 0; i < count; i++)
    source.prepare(
      { ...f.task, taskId: `prepared-${i}`, inboundRange: { from: 1, to: 1 } },
      f.draft.draftHash,
      1000
    )
  const requestFor = (task: typeof f.task) => ({
    taskId: task.taskId,
    taskHash: hashContext(task),
    draftHash: f.draft.draftHash,
    draftRevision: 1,
    loginEpoch: task.identity.loginEpoch,
    clientInstanceId: task.identity.clientInstanceId,
    leaseVersion: 1
  })
  const unresolved = (name: string) => {
    const task = { ...f.task, taskId: name, inboundRange: { from: 1, to: 1 } },
      s = source.prepare(task, f.draft.draftHash, 1000).record,
      request = requestFor(task)
    source.transition(s.executionId, 'prepared', 'dispatching', 1001)
    source.central.begin(s.executionId, request, 1002)
    return { task, s, request }
  }
  const sealAttempt = unresolved('sealed-request')
  source.central.unresolved(sealAttempt.s.executionId, 1003)
  source.transition(sealAttempt.s.executionId, 'dispatching', 'unknown', 1004)
  const reconciliation = unresolved('reconciled-send'),
    permit = {
      permitId: 'permit-1',
      identity: f.task.identity,
      taskId: reconciliation.task.taskId,
      conversationId: f.task.conversationId,
      taskHash: hashContext(reconciliation.task),
      draftHash: f.draft.draftHash,
      draftRevision: 1,
      leaseVersion: 1,
      issuedAt: 1000,
      expiresAt: 5000,
      status: 'issued' as const,
      newlyIssued: true
    }
  source.central.issued(reconciliation.s.executionId, permit, 1003)
  source.central.dispatching(reconciliation.s.executionId, 1004)
  source.central.recordReceipt(
    reconciliation.s.executionId,
    { permitId: permit.permitId, draftHash: permit.draftHash, status: 'unknown' },
    1005
  )
  source.prepare(
    { ...f.task, identity: { ...f.task.identity, accountId: 'foreign' }, taskId: 'foreign' },
    f.draft.draftHash,
    1000
  )
  const db = new DatabaseSync(file)
  let backup
  try {
    backup = await createLedgerBackup(db, join(root, 'backup'))
  } finally {
    db.close()
    source.close()
  }
  let restored = await restoreLedgerBackup(backup.directory, join(root, 'restored'))
  if (restoreAgain) {
    const db = new DatabaseSync(restored.databasePath)
    let nextBackup
    try {
      nextBackup = await createLedgerBackup(db, join(root, 'second-backup'))
    } finally {
      db.close()
    }
    restored = await restoreLedgerBackup(nextBackup.directory, join(root, 'second-restored'))
  }
  const ledger = new Ledger(restored.databasePath),
    locals: RestoreInventoryItem[] = []
  const inventory = ledger.visitRestoreInventory(scope, (item) => {
    if (item.kind === 'execution') locals.push(item)
  })
  const { items: _items, nextAfter: _after, ...manifest } = inventory
  void _items
  void _after
  const caseId = randomUUID(),
    uploadId = randomUUID(),
    reviewId = randomUUID(),
    authorizationId = randomUUID(),
    proofId = randomUUID(),
    assessmentBasisHash = 'a'.repeat(64),
    historyReceiptHash = 'b'.repeat(64),
    subjects: RestoreExecutionSubject[] = locals.map((l) => {
      if (l.kind !== 'execution') throw Error('fixture')
      return {
        subjectKey: `l:${l.key}`,
        subjectHash: hashContext(l),
        kind: 'local_execution',
        executionGroup: l.permitId ? `permit:${l.permitId}` : `local:${l.executionId}`,
        principalHash: restoreExecutionPrincipalHash({
          agentId: l.identity.agentId,
          loginEpoch: l.identity.loginEpoch,
          clientInstanceId: l.identity.clientInstanceId,
          taskId: l.taskId,
          taskHash: l.taskHash,
          draftHash: l.draftHash,
          conversationId: l.conversationId
        }),
        conversationId: l.conversationId,
        draftHash: l.draftHash,
        earliestSendAt: l.createdAt,
        recordedOutcome: null
      }
    })
  subjects.push({
    subjectKey: `p:${hashContext({ permitId: permit.permitId })}`,
    subjectHash: 'c'.repeat(64),
    kind: 'central_permit',
    executionGroup: `permit:${permit.permitId}`,
    principalHash: restoreExecutionPrincipalHash({
      agentId: permit.identity.agentId,
      loginEpoch: permit.identity.loginEpoch,
      clientInstanceId: permit.identity.clientInstanceId,
      taskId: permit.taskId,
      taskHash: permit.taskHash,
      draftHash: permit.draftHash,
      conversationId: permit.conversationId
    }),
    conversationId: permit.conversationId,
    draftHash: permit.draftHash,
    earliestSendAt: permit.issuedAt,
    recordedOutcome: null
  })
  subjects.sort((a, b) => (a.subjectKey < b.subjectKey ? -1 : 1))
  const stopped = {
      stoppedAt: 5100,
      observerStopped: true as const,
      senderQuiescent: true as const,
      settlementQuiescent: true as const,
      leaseStopped: true as const,
      verifiedDriverStopped: true as const
    },
    challenge = {
      caseId: randomUUID(),
      snapshotHash: 'd'.repeat(64),
      openedAt: 5050,
      permit: { ...permit, status: 'unknown' as const, newlyIssued: false }
    },
    report = {
      caseId: challenge.caseId,
      snapshotHash: challenge.snapshotHash,
      request: reconciliation.request,
      stopped,
      observation: {
        executionId: reconciliation.s.executionId,
        identity: f.task.identity,
        conversationId: permit.conversationId,
        permitId: permit.permitId,
        taskHash: permit.taskHash,
        draftHash: permit.draftHash,
        draftRevision: 1,
        leaseVersion: 1,
        observedAt: 6500,
        verificationProofHash: 'e'.repeat(64),
        status: 'confirmed' as const,
        sourceMessageId: 'independent-echo'
      }
    },
    decision = {
      decisionId: randomUUID(),
      caseId: challenge.caseId,
      snapshotHash: challenge.snapshotHash,
      reportHash: hashContext(report),
      noteId: randomUUID(),
      outcome: 'confirmed' as const,
      decidedBy: 'reviewer',
      decidedAt: 6600
    },
    sealInput = {
      executionId: sealAttempt.s.executionId,
      identity: f.task.identity,
      request: sealAttempt.request,
      stopped,
      verificationProofHash: requestNonDispatchProof({
        executionId: sealAttempt.s.executionId,
        identity: f.task.identity,
        request: sealAttempt.request
      })
    },
    seal = {
      sealId: randomUUID(),
      input: sealInput,
      requestHash: hashContext(sealInput),
      sealedAt: 5200
    },
    records: RestoreResolutionRecord[] = [
      {
        kind: 'reconciled',
        challenge,
        report,
        decision,
        fact: {
          permitId: permit.permitId,
          caseId: challenge.caseId,
          snapshotHash: challenge.snapshotHash,
          reportHash: hashContext(report),
          decisionHash: hashContext(decision),
          appliedAgent: scope.agent_id,
          appliedAt: 6700
        }
      },
      {
        kind: 'request_seal',
        seal,
        fact: {
          sealId: seal.sealId,
          sealHash: hashContext(seal),
          requestHash: seal.requestHash,
          executionId: sealInput.executionId,
          appliedAgent: scope.agent_id,
          appliedAt: 5300
        }
      }
    ],
    review = {
      reviewId,
      tenantId: scope.tenant_id,
      accountId: scope.account_id,
      caseId,
      uploadId,
      historyProofId: proofId,
      assessmentBasisHash,
      reviewerId: 'independent',
      reviewedAt: 7000,
      outcomes: subjects.map((s) =>
        s.executionGroup === `permit:${permit.permitId}`
          ? {
              subjectKey: s.subjectKey,
              subjectHash: s.subjectHash,
              conversationId: s.conversationId,
              evidenceSha256: 'f'.repeat(64),
              observedAt: 7000,
              outcome: 'confirmed' as const,
              sourceMessageId: 'independent-echo',
              sourceContentHash: '1'.repeat(64),
              draftTextHash: s.draftHash,
              causalAttributionVerified: true as const
            }
          : {
              subjectKey: s.subjectKey,
              subjectHash: s.subjectHash,
              conversationId: s.conversationId,
              evidenceSha256: 'f'.repeat(64),
              observedAt: 7000,
              outcome: 'not_sent' as const,
              dispatchStarted: false as const,
              quiescent: true as const,
              dispatchJournalEntrySha256: hashContext({ group: s.executionGroup }),
              nonDispatchJournalVerified: true as const
            }
      )
    },
    reviewReceipt = {
      formatVersion: 1,
      reviewId,
      tenantId: scope.tenant_id,
      accountId: scope.account_id,
      caseId,
      uploadId,
      historyProofId: proofId,
      assessmentBasisHash,
      historyReceiptHash,
      subjectsSnapshotHash: hashContext(subjects),
      requestHash: hashContext(review),
      outcomesHash: hashContext(review.outcomes),
      subjects: subjects.length,
      confirmed: 2,
      notSent: subjects.length - 2,
      executionGroups: subjects.length - 1,
      recordedBy: 'maintenance',
      recordedAt: 7100,
      maintenanceReviewRecorded: true,
      physicalOutcomeVerifiedByThisCommand: false,
      separateReconciliationRequired: true,
      automaticStart: false,
      canRelease: false
    },
    resolutionBasisHash = hashContext({
      formatVersion: 1,
      tenantId: scope.tenant_id,
      accountId: scope.account_id,
      caseId,
      uploadId,
      reviewId,
      assessmentBasisHash,
      subjects,
      facts: records.map((r) => r.fact)
    }),
    history = {
      formatVersion: 1,
      kind: 'restore-account-history',
      proofId,
      caseId,
      uploadId,
      restoreId: manifest.context.restoreId,
      contextHash: manifest.context.contextHash,
      inventoryBasisHash: manifest.basisHash,
      scope,
      platformAccountIdHash: '2'.repeat(64),
      source: { sourceId: 'synthetic', keyId: 'key', version: '1', releaseSha256: '3'.repeat(64) },
      historyFrom: 0,
      observedThrough: 7000,
      capturedAt: 7000,
      complete: true,
      allConversationsEnumerated: true,
      nextPageToken: null,
      conversations: [
        {
          conversationId: f.task.conversationId,
          complete: true,
          hasGap: false,
          nextPageToken: null,
          messages: [
            {
              sourceMessageId: 'inbound-1',
              position: 1,
              direction: 'inbound',
              sentAt: 1000,
              contentHash: hashContext({ direction: 'inbound', kind: 'text', text: 'synthetic' })
            },
            {
              sourceMessageId: 'independent-echo',
              position: 2,
              direction: 'automation_outbound',
              sentAt: 6000,
              contentHash: '1'.repeat(64)
            }
          ]
        }
      ]
    },
    boundary = {
      formatVersion: 1,
      kind: 'restore-account-boundary',
      authorizationId,
      manifest,
      history,
      historyReceiptHash,
      executionReceiptHash: hashContext(reviewReceipt),
      resolutionBasisHash,
      humanOwnershipPolicy: 'all_restored_conversations'
    },
    approved = RestoreRecoveryPackageSchema.parse({
      boundary,
      authorization: {
        formatVersion: 1,
        authorizationId,
        scope,
        caseId,
        uploadId,
        reviewId,
        restoreId: history.restoreId,
        contextHash: history.contextHash,
        inventoryBasisHash: manifest.basisHash,
        assessmentBasisHash,
        historyProofId: proofId,
        historyReceiptHash,
        executionReceiptHash: hashContext(reviewReceipt),
        resolutionBasisHash,
        boundaryHash: hashContext(boundary),
        requestHash: '4'.repeat(64),
        historyPolicy: 'quarantine_all_history',
        recordedBy: 'maintenance',
        recordedAt: 7200,
        expiresAt: 37000,
        status: 'approved_for_boundary',
        localDurableApplicationRequired: true,
        centralCompletionRequired: true,
        physicalFactsVerifiedByThisCommand: false,
        automaticStart: false,
        canRelease: false
      }
    }),
    resolutions = parseRestoreResolutionPackage(
      {
        formatVersion: 1,
        authorizationId,
        authorizationHash: hashContext(approved.authorization),
        boundaryHash: approved.authorization.boundaryHash,
        resolutionBasisHash,
        review,
        reviewReceipt,
        subjects,
        localExecutions: locals,
        records,
        automaticStart: false,
        canRelease: false
      },
      approved
    )
  return { root, restored, ledger, f, scope, approved, resolutions, reconciliation, sealAttempt }
}
