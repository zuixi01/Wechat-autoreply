/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- launched by Electron RUN_AS_NODE; this CJS harness cannot use TypeScript annotations. */
const { join, resolve } = require('node:path')
const { writeFileSync, appendFileSync } = require('node:fs')
const { DatabaseSync } = require('node:sqlite')
const { randomUUID } = require('node:crypto')
const directory = resolve(process.argv[2])
const phase = (event) =>
  appendFileSync(
    join(directory, 'lifecycle.jsonl'),
    JSON.stringify({ event, at: Date.now(), resources: process.getActiveResourcesInfo() }) + '\n'
  )
phase('bootstrap')
const resources = join(require('node:path').dirname(process.execPath), 'resources')
const { createPackagedWindowsBridge, nativeAdapterBuildInfo } = require(
  join(resources, 'app.asar', 'out/main/native-adapter.js')
)
// First execution from a new directory may spend tens of seconds verifying
// shipped files. This startup budget does not change native command deadlines.
const deadline = (stage, milliseconds) =>
  setTimeout(() => {
    phase(`deadline-expired:${stage}`)
    process.stderr.write(`packaged_native_smoke_timeout:${stage}\n`)
    process.exit(1)
  }, milliseconds)
let timer = deadline('factory', 60000)

async function run() {
  phase('factory-start')
  const bridge = await createPackagedWindowsBridge()
  phase('factory-ready')
  clearTimeout(timer)
  timer = deadline('checks', 15000)
  let info
  try {
    phase('info-start')
    info = await bridge.info()
    phase('info-ready')
  } finally {
    await bridge.stop()
    phase('bridge-closed')
  }
  const { verifyPublishedProvider } = require(
    join(resources, 'app.asar/out/main/provider-package.js')
  )
  const published = await verifyPublishedProvider(
    join(resources, 'app.asar.unpacked/resources/providers/volcengine-ark'),
    'volcengine-ark'
  )
  phase('provider-verified')
  const sqlite = new DatabaseSync(join(directory, 'smoke.sqlite'))
  sqlite.exec('CREATE TABLE smoke (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
  sqlite.prepare('INSERT INTO smoke(value) VALUES (?)').run('packaged')
  const row = sqlite.prepare('SELECT value FROM smoke').get()
  sqlite.close()
  if (row.value !== 'packaged') throw new Error('packaged_sqlite_failed')
  const { Ledger, createLedgerBackup, restoreLedgerBackup } = require(
    join(resources, 'app.asar/out/main/ledger-recovery.js')
  )
  const recoverySource = join(directory, 'recovery-source.sqlite')
  const originalLedger = new Ledger(recoverySource)
  const identity = {
    tenantId: 'synthetic-tenant',
    employeeId: 'synthetic-employee',
    accountId: 'synthetic-account',
    agentId: 'synthetic-agent',
    platform: 'wechat',
    loginEpoch: 1,
    clientInstanceId: 'synthetic-client'
  }
  try {
    originalLedger.observe({
      identity,
      conversationId: 'synthetic-customer',
      sourceMessageId: 'synthetic-source',
      direction: 'inbound',
      kind: 'text',
      text: '合成备份核对',
      observedAt: 1000,
      identityVerified: true,
      messageIdVerified: true
    })
    originalLedger.setHumanOwned(identity, 'synthetic-customer', true)
  } finally {
    originalLedger.close()
  }
  const recoveryRead = new DatabaseSync(recoverySource, { readOnly: true })
  let saved
  try {
    saved = await createLedgerBackup(recoveryRead, join(directory, 'backups'))
  } finally {
    recoveryRead.close()
  }
  const restored = await restoreLedgerBackup(saved.directory, join(directory, 'restored'))
  phase('ledger-restored')
  const restoredLedger = new Ledger(restored.databasePath)
  let pauseReport
  try {
    const state = restoredLedger.snapshot(identity, 'synthetic-customer')
    if (!restoredLedger.requiresRestoreReview() || !state.humanOwned || state.messages.length !== 1)
      throw new Error('packaged_recovery_failed')
    if (!restored.restoreContext || typeof restoredLedger.restoreContext !== 'function') {
      phase('restore-context-missing')
      throw new Error('packaged_restore_context_missing')
    }
    const context = restoredLedger.restoreContext()
    if (typeof restoredLedger.restoreInventory !== 'function')
      throw new Error('packaged_restore_inventory_missing')
    const inventory = restoredLedger.restoreInventory(
      {
        tenant_id: identity.tenantId,
        employee_id: identity.employeeId,
        account_id: identity.accountId,
        agent_id: identity.agentId,
        platform: identity.platform
      },
      { limit: 1 }
    )
    if (
      inventory.context.contextHash !== context.contextHash ||
      inventory.canRelease !== false ||
      inventory.externalEvidenceRequired !== true ||
      inventory.summary.messages !== 1 ||
      inventory.summary.unhandledInbound !== 1 ||
      inventory.items.length !== 1 ||
      inventory.items[0].sequenceComplete !== true ||
      inventory.items[0].humanOwned !== true ||
      JSON.stringify(inventory).includes('合成备份核对')
    )
      throw new Error('packaged_restore_inventory_invalid')
    phase('restore-inventory-verified')
    // Corrupt only this synthetic database to verify the shipped recovery guard.
    const orphanId = randomUUID(),
      corruption = new DatabaseSync(restored.databasePath)
    let orphanRejected = false
    try {
      corruption.exec('PRAGMA foreign_keys=OFF')
      corruption
        .prepare(
          'INSERT INTO central_attempts(execution_id,phase,request_json,updated_at) VALUES(?,?,?,?)'
        )
        .run(orphanId, 'requesting', '{}', 1000)
      try {
        restoredLedger.restoreInventory(inventory.scope)
      } catch (error) {
        orphanRejected = error.message === 'ledger_restore_inventory_invalid'
      }
    } finally {
      corruption.prepare('DELETE FROM central_attempts WHERE execution_id=?').run(orphanId)
      corruption.close()
    }
    if (!orphanRejected || !restoredLedger.requiresRestoreReview())
      throw new Error('packaged_restore_inventory_orphan_accepted')
    phase('restore-inventory-orphan-rejected')
    if (
      context.restoreId !== restored.restoreContext.restoreId ||
      context.contextHash !== restored.restoreContext.contextHash ||
      context.backupId !== saved.manifest.id ||
      context.sourceSha256 !== saved.manifest.sha256 ||
      context.requiresReconciliation !== true
    )
      throw new Error('packaged_restore_context_invalid')
    const now = Date.now()
    pauseReport = {
      challenge: {
        challengeId: randomUUID(),
        caseId: randomUUID(),
        requestId: randomUUID(),
        scope: {
          tenant_id: identity.tenantId,
          employee_id: identity.employeeId,
          account_id: identity.accountId,
          agent_id: identity.agentId,
          platform: identity.platform
        },
        context,
        frontierHash: 'a'.repeat(64),
        issuedAt: now,
        expiresAt: now + 30000
      },
      instanceId: randomUUID(),
      runtimeGeneration: 1,
      stoppedAt: now,
      observedAt: now,
      stopped: {
        observerStopped: true,
        senderQuiescent: true,
        settlementQuiescent: true,
        leaseStopped: true,
        platformStopped: true
      }
    }
    phase('restore-pause-write-start')
    const persisted = restoredLedger.saveRestorePauseReport(pauseReport)
    phase('restore-pause-written')
    if (
      JSON.stringify(persisted) !==
      JSON.stringify(restoredLedger.saveRestorePauseReport(pauseReport))
    )
      throw new Error('packaged_restore_pause_retry_changed')
  } finally {
    restoredLedger.close()
  }
  const reopenedLedger = new Ledger(restored.databasePath)
  try {
    if (
      JSON.stringify(reopenedLedger.restorePauseReport(pauseReport.challenge.challengeId)) !==
        JSON.stringify(pauseReport) ||
      !reopenedLedger.requiresRestoreReview()
    )
      throw new Error('packaged_restore_pause_persistence_failed')
    const changed = new DatabaseSync(restored.databasePath)
    try {
      changed.exec("UPDATE runtime_metadata SET value=0 WHERE key='restore_review_required'")
    } finally {
      changed.close()
    }
    if (!reopenedLedger.requiresRestoreReview()) throw new Error('packaged_restore_fence_lost')
    phase('restore-fence-verified')
  } finally {
    reopenedLedger.close()
  }
  phase('ledger-recovery-verified')
  const { LegacySettingsArchive } = require(
    join(resources, 'app.asar/out/main/legacy-migration.js')
  )
  const legacySource = join(directory, 'synthetic-legacy-settings.json')
  writeFileSync(
    legacySource,
    JSON.stringify({
      globalAutoReply: true,
      apiKey: 'SYNTHETIC_PRIVATE_KEY',
      modes: [
        {
          id: 'synthetic-mode',
          name: '合成规则',
          prompt: '核对型号',
          autoReply: true,
          specificObjects: [{ id: 'synthetic-object', name: '合成客户', autoReply: true }]
        }
      ]
    })
  )
  const legacyArchive = new LegacySettingsArchive(
    join(directory, 'legacy-drafts.sqlite'),
    'synthetic-workspace'
  )
  let migrated
  let legacyReview
  try {
    migrated = await legacyArchive.importFile(legacySource)
    const drafts = legacyArchive.list()
    const repeated = await legacyArchive.importFile(legacySource)
    if (
      migrated.createdDrafts !== 3 ||
      repeated.createdDrafts !== 0 ||
      drafts.some((d) => d.state !== 'pending' || d.automaticEnabled || d.identityVerified) ||
      JSON.stringify(drafts).includes('SYNTHETIC_PRIVATE_KEY')
    )
      throw new Error('packaged_legacy_migration_failed')
    const mode = drafts.find((draft) => draft.content.kind === 'mode')
    const input = {
      sourceId: 'synthetic-review',
      draftId: mode.id,
      expectedContentHash: mode.contentHash,
      expectedReviewRevision: 0,
      decision: 'accept',
      reason: '合成人工审核',
      replyRules: '核对型号后再答复'
    }
    legacyReview = legacyArchive.recordReview(input, 'synthetic-reviewer')
    legacyArchive.recordReview(
      {
        sourceId: 'synthetic-reopen',
        draftId: mode.id,
        expectedContentHash: mode.contentHash,
        expectedReviewRevision: 1,
        decision: 'reopen',
        reason: '合成重新审核'
      },
      'synthetic-reviewer'
    )
    const retry = legacyArchive.recordReview(input, 'synthetic-reviewer')
    if (
      legacyReview.record.revision !== 1 ||
      retry.currentReviewRevision !== 2 ||
      retry.isCurrent ||
      legacyArchive.reviewState(mode.id).decision !== 'reopen' ||
      legacyArchive.reviewHistory(mode.id).length !== 2 ||
      legacyReview.record.automaticEnabled ||
      legacyReview.record.identityVerified
    )
      throw new Error('packaged_legacy_review_failed')
  } finally {
    legacyArchive.close()
  }
  phase('legacy-migration-verified')
  phase('legacy-review-verified')
  writeFileSync(
    join(directory, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        electron: process.versions.electron,
        node: process.versions.node,
        sqlite: process.versions.sqlite,
        nativeAdapterBuildInfo,
        publishedProvider: published.published,
        info,
        childExitConfirmed: true,
        commandsExecuted: ['info'],
        chatWindowsRead: false,
        messagesSent: 0,
        providerCalls: 0,
        legacyMigration: {
          syntheticDrafts: migrated.createdDrafts,
          automaticEnabled: false,
          identityVerified: false,
          reviewRequired: true,
          repeatCreatedDrafts: 0
        },
        legacyReview: {
          acceptedRevision: legacyReview.record.revision,
          currentRevision: 2,
          state: 'reopen',
          staleRetryCurrent: false,
          automaticEnabled: false,
          identityVerified: false
        },
        ledgerRecovery: {
          schemaVersion: 11,
          syntheticMessages: 1,
          restoredHumanOwned: true,
          requiresReconciliation: true,
          restorationContextVerified: true,
          clearedLegacyMarkerStillBlocked: true,
          syntheticPauseReportPersisted: true,
          syntheticPauseReportRetryUnchanged: true,
          syntheticPauseReportReopened: true,
          pauseReportDoesNotReleaseRestoration: true,
          restoredMetadataInventoryVerified: true,
          restoredInventoryOrphanRejected: true
        }
      },
      null,
      2
    ) + '\n'
  )
}
run()
  .then(() => {
    clearTimeout(timer)
    phase('checks-complete')
  })
  .catch((error) => {
    clearTimeout(timer)
    const code = [
      'native_adapter_timeout',
      'native_adapter_exited',
      'native_adapter_stop_unconfirmed',
      'native_adapter_version_mismatch',
      'packaged_recovery_failed',
      'packaged_restore_context_missing',
      'packaged_restore_inventory_missing',
      'packaged_restore_inventory_invalid',
      'packaged_restore_inventory_orphan_accepted',
      'packaged_restore_context_invalid',
      'packaged_restore_fence_lost',
      'ledger_restore_pause_context_invalid',
      'ledger_restore_pause_invalid',
      'ledger_restore_pause_transaction_required',
      'packaged_restore_pause_retry_changed',
      'packaged_restore_pause_persistence_failed'
    ].includes(error?.message)
      ? error.message
      : 'packaged_native_smoke_failed'
    phase(`checks-failed:${code}`)
    process.stderr.write('packaged_native_smoke_failed\n')
    process.exitCode = 1
  })
