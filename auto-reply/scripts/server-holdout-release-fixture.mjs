import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

// Bootstrap data only. Every business module is loaded from the copied release
// with its isolated production dependencies, never from workspace TypeScript.
const env = process.env
const compiled = (name) => import(pathToFileURL(join(env.HOLDOUT_RELEASE_ROOT, name)).href)
let db,
  closePrivatePermissions,
  forbiddenFetchCalls = 0
globalThis.fetch = async () => {
  forbiddenFetchCalls++
  throw new Error('fixture_real_http_forbidden')
}
const assert = (condition) => {
  if (!condition) throw new Error('fixture_assertion_failed')
}
const read = async (name) => JSON.parse(await readFile(join(env.HOLDOUT_DIRECTORY, name), 'utf8'))
try {
  const [
    { Postgres },
    { Administration },
    { textGeneratorVersion },
    { JevReplayJournal },
    { createPrivateOutput, writePrivateJson }
  ] = await Promise.all([
    compiled('server/src/database/postgres.js'),
    compiled('server/src/admin/administration.js'),
    compiled('server/src/generation/text-generator.js'),
    compiled('server/src/generation/jev-replay-journal.js'),
    compiled('evals/memory/private-files.js')
  ])
  closePrivatePermissions = (await compiled('src/core/persistence/private-backup-directory.js'))
    .closePrivatePermissionWorker
  db = new Postgres(env.ADMIN_DATABASE_URL)
  const profileStarted = performance.now()
  const profile = { transactionCalls: 0, transactionMs: 0, queryCalls: 0, queryMs: 0, groups: {} }
  const originalTransaction = db.transaction.bind(db)
  // Fixture-only timing. Restore the actual PoolClient query after every
  // transaction; never stack wrappers on a reused connection or log SQL/values.
  if (env.HOLDOUT_PROFILE === '1')
    db.transaction = async (tenant, operation) => {
      const start = performance.now()
      profile.transactionCalls++
      try {
        return await originalTransaction(tenant, async (client) => {
          const originalQuery = client.query
          client.query = async function (...args) {
            const sql = typeof args[0] === 'string' ? args[0] : (args[0]?.text ?? '')
            const group = sql.includes('authenticate_admin')
              ? 'authenticate'
              : sql.includes('FOR UPDATE')
                ? 'account_lock'
                : sql.includes('SELECT e.*,s.case_id')
                  ? 'binding_read'
                  : /^\s*INSERT\b/i.test(sql)
                    ? 'insert'
                    : 'other'
            const measured = (profile.groups[group] ??= { calls: 0, milliseconds: 0 })
            const queryStart = performance.now()
            profile.queryCalls++
            measured.calls++
            try {
              return await originalQuery.apply(this, args)
            } finally {
              const elapsed = performance.now() - queryStart
              profile.queryMs += elapsed
              measured.milliseconds += elapsed
            }
          }
          try {
            return await operation(client)
          } finally {
            client.query = originalQuery
          }
        })
      } finally {
        profile.transactionMs += performance.now() - start
      }
    }
  const text = {
    baseUrl: env.TEXT_MODEL_BASE_URL,
    model: env.TEXT_MODEL_ID,
    expectedModel: env.TEXT_MODEL_EXPECTED_ID,
    apiKey: 'synthetic-text-key'
  }
  const version = textGeneratorVersion(text),
    admin = new Administration(db, version),
    journal = new JevReplayJournal(db, version)
  const scope = { tenantId: env.HOLDOUT_TENANT, accountId: env.HOLDOUT_ACCOUNT }
  const save = (name, value) => writePrivateJson(join(env.HOLDOUT_DIRECTORY, name), value)
  let result
  if (env.HOLDOUT_PHASE === 'setup') {
    const [{ PublicationSchema }, { replayCaseInputHash }, { JevCalibrationDeclarations }] =
      await Promise.all([
        compiled('server/src/generation/publication.js'),
        compiled('evals/jev/replay-input.js'),
        compiled('server/src/generation/jev-calibration-declarations.js')
      ])
    const publication = PublicationSchema.parse(
      JSON.parse(await readFile(env.HOLDOUT_PUBLICATION, 'utf8'))
    )
    publication.configuration.automaticEnabled = true
    publication.configuration.modelResolved = 'jev-resolved'
    publication.policy = {
      ...publication.policy,
      mode: 'enforced',
      evaluationApproved: true,
      modelAlias: 'jev-alias',
      modelResolved: 'jev-resolved'
    }
    publication.textGeneratorVersion = version
    publication.evidence = [
      {
        evidenceId: 'synthetic-faq',
        ...scope,
        conversationId: 'synthetic-peer',
        intent: 'faq',
        knowledgeVersion: publication.policy.knowledgeVersion,
        kind: 'approved_faq',
        content: '支持离线阅读。',
        source: 'synthetic compiled protocol fixture only',
        approvedBy: 'synthetic-author',
        validFrom: 0,
        expiresAt: Date.now() + 3600000
      }
    ]
    const cases = Array.from({ length: 300 }, (_, i) => ({
      caseId: `synthetic-${i}`,
      conversationGroup: `synthetic-group-${i}`,
      split: i < 100 ? 'calibration' : 'holdout',
      conversationId: 'synthetic-peer',
      inbound: ['支持离线阅读吗？']
    }))
    const plan = {
      datasetId: `synthetic-holdout-${randomUUID()}`,
      currency: 'CNY',
      maximumTurnCostMicros: 10000,
      maximumP95LatencyMs: 1000,
      replayProtocol: 'jev-abc-v1',
      assignments: cases.map((c) => ({
        caseId: c.caseId,
        conversationGroup: c.conversationGroup,
        split: c.split,
        inputHash: replayCaseInputHash(c)
      }))
    }
    const frozen = await admin.freezeEvaluation(scope.tenantId, scope.accountId, {
      publication,
      plan
    })
    const settings = {
      candidates: [publication.policy],
      targets: {
        maximumErrorReleaseRate: 0.01,
        minimumAutomaticCoverage: 0.5,
        minimumAutomaticReplies: 30
      }
    }
    await new JevCalibrationDeclarations(db, version).declare({
      ...scope,
      runId: frozen.runId,
      settings
    })
    // Synthetic acceptance workload: 600 calibration + 1200 holdout attempts.
    // This limit applies only to this isolated fixture account.
    await journal.setLimit(scope.tenantId, scope.accountId, { dailyAttemptLimit: 2000 })
    const input = { datasetId: plan.datasetId, split: 'calibration', cases: cases.slice(0, 100) }
    await journal.begin({
      ...scope,
      runId: frozen.runId,
      fullRawCases: input,
      maxRunAttempts: 1000
    })
    await createPrivateOutput(env.HOLDOUT_DIRECTORY)
    await save('seed.private.json', {
      ...scope,
      runId: frozen.runId,
      cases,
      input,
      publication,
      plan
    })
    await save('settings.private.json', settings)
    result = { runId: frozen.runId, cases: 300, calibrationCases: 100, holdoutCases: 200 }
  } else {
    const seed = await read('seed.private.json')
    if (/^arm-[ABC]$/.test(env.HOLDOUT_PHASE) || /^holdout-[ABC]-[12]$/.test(env.HOLDOUT_PHASE)) {
      const heldout = env.HOLDOUT_PHASE.startsWith('holdout-')
      const arm = heldout ? env.HOLDOUT_PHASE.split('-')[1] : env.HOLDOUT_PHASE.slice(-1)
      const batch = heldout ? Number(env.HOLDOUT_PHASE.slice(-1)) : null
      const runId = heldout
        ? (await read('frozen/holdout-receipt.private.json')).targetRunId
        : seed.runId
      const input = heldout
        ? { datasetId: seed.plan.datasetId, split: 'holdout', cases: seed.cases.slice(100) }
        : seed.input
      const [{ createJevReplayProviderFactory }, { executeJevReplayArm }] = await Promise.all([
        compiled('evals/jev/replay-providers.js'),
        compiled('evals/jev/replay.js')
      ])
      const prepared = await journal.begin({
        ...scope,
        runId,
        fullRawCases: input,
        maxRunAttempts: heldout ? 1200 : 1000
      })
      let simulatedRequests = 0,
        responsesWithoutUsage = 0
      const transport = async (_url, init) => {
        simulatedRequests++
        const body = JSON.parse(String(init.body))
        if (body.questions)
          return new Response(
            JSON.stringify({
              model: 'jev-resolved',
              usage: { input_tokens: 10, output_tokens: 5 },
              answers: Object.fromEntries(
                Object.entries(body.questions).map(([id, q]) => [
                  id,
                  q.type === 'choice'
                    ? {
                        type: 'choice',
                        choice: 'faq',
                        confidence: 1,
                        probabilities: { faq: 1, price: 0, order: 0, aftersales: 0, other: 0 }
                      }
                    : {
                        type: 'noul',
                        noul:
                          id === 'human_requested' || (id.startsWith('has_') && id !== 'has_faq')
                            ? 0
                            : 1
                      }
                ])
              )
            }),
            { status: 200, headers: { 'x-typesafe-request-id': randomUUID() } }
          )
        const omitUsage =
          env.HOLDOUT_OMIT_USAGE === 'one-target-text-response' &&
          heldout &&
          arm === 'A' &&
          batch === 1 &&
          simulatedRequests === 1
        if (omitUsage) responsesWithoutUsage++
        return new Response(
          JSON.stringify({
            model: 'text-resolved',
            ...(omitUsage ? {} : { usage: { prompt_tokens: 10, completion_tokens: 5 } }),
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    text: '支持离线阅读。',
                    evidenceIds: ['synthetic-faq']
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { 'x-request-id': randomUUID() } }
        )
      }
      const providers = createJevReplayProviderFactory(
        prepared.source,
        { jevApiKey: 'synthetic-jev-key', text, fetch: transport },
        journal
      )
      const artifacts = []
      // Both batches authenticate the complete immutable 200-case input. Each
      // executes 100 distinct cases under the existing 20-second phase bound.
      const batchCases = heldout ? input.cases.slice((batch - 1) * 100, batch * 100) : input.cases
      for (const caseInput of batchCases) {
        const assignment = {
          runId,
          caseId: caseInput.caseId,
          arm,
          assignmentId: randomUUID()
        }
        const binding = await journal.bindAssignment(assignment)
        const artifact = await executeJevReplayArm(
          arm,
          {
            frozen: prepared.source,
            caseInput,
            identity: {
              ...prepared.source.authenticatedScope,
              agentId: 'synthetic-release-evaluation',
              loginEpoch: 0,
              clientInstanceId: 'synthetic-release-instance'
            }
          },
          providers(assignment),
          undefined,
          assignment.assignmentId
        )
        assert(artifact.status === 'candidate')
        await journal.sealArtifact(binding, artifact)
        artifacts.push(artifact)
        if (env.HOLDOUT_PROFILE === '1' && artifacts.length % 25 === 0)
          await save(`profile-${env.HOLDOUT_PHASE}-${artifacts.length}.private.json`, {
            ...profile,
            completedCases: artifacts.length,
            elapsedMs: performance.now() - profileStarted
          })
      }
      assert(artifacts.length === 100 && simulatedRequests === { A: 100, B: 200, C: 300 }[arm])
      await save(
        heldout
          ? `holdout-artifacts-${arm}-${batch}.private.json`
          : `artifacts-${arm}.private.json`,
        artifacts
      )
      result = {
        arm,
        batch,
        fullInputCases: input.cases.length,
        cases: 100,
        artifacts: 100,
        simulatedRequests,
        responsesWithoutUsage,
        artifactsWithoutUsage: artifacts.filter((a) => a.usage === null).length
      }
    } else if (env.HOLDOUT_PHASE === 'blind' || env.HOLDOUT_PHASE === 'holdout-blind') {
      const heldout = env.HOLDOUT_PHASE === 'holdout-blind'
      const runId = heldout
        ? (await read('frozen/holdout-receipt.private.json')).targetRunId
        : seed.runId
      const input = heldout
        ? { datasetId: seed.plan.datasetId, split: 'holdout', cases: seed.cases.slice(100) }
        : seed.input
      const [{ createJevBlindReview }, { JevBlindPacketSeals }] = await Promise.all([
        compiled('evals/jev/blind-review.js'),
        compiled('server/src/generation/jev-blind-packet-seals.js')
      ])
      const artifacts = (
        await Promise.all(
          heldout
            ? ['A', 'B', 'C'].flatMap((arm) =>
                [1, 2].map((batch) => read(`holdout-artifacts-${arm}-${batch}.private.json`))
              )
            : ['A', 'B', 'C'].map((arm) => read(`artifacts-${arm}.private.json`))
        )
      ).flat()
      assert(artifacts.length === (heldout ? 600 : 300))
      const frozen = await admin.readFrozenEvaluation(scope.tenantId, scope.accountId, runId)
      const packet = createJevBlindReview({
        frozen,
        rawCases: input,
        artifacts,
        dataKind: heldout ? 'synthetic' : 'business',
        rubricRef: 'synthetic-compiled-rubric',
        priorAnnotations: {
          annotatedBy: 'synthetic-prior-author',
          cases: input.cases.map((c) => ({
            caseId: c.caseId,
            category: 'faq',
            eligible: true,
            expectedHandoff: false,
            intentCount: 1
          }))
        }
      }).privatePacket
      await new JevBlindPacketSeals(db, version).seal({
        ...scope,
        runId,
        packet,
        artifacts
      })
      const labels = {
        adjudicatedBy: env.HOLDOUT_REVIEWER,
        annotationSource: 'blinded_business_adjudication',
        labels: packet.mapping.map((m) => ({
          reviewId: m.reviewId,
          substantialCorrection: false,
          severeFactError: false,
          unauthorizedPromise: false,
          incorrectlyBlocked: false,
          coveredIntents: 1
        }))
      }
      const prefix = heldout ? 'holdout-' : ''
      await save(`${prefix}sealed-mapping.private.json`, packet)
      await save(`${prefix}artifacts.private.json`, artifacts)
      await save(`${prefix}labels.private.json`, labels)
      result = {
        packetId: packet.packetId,
        artifacts: artifacts.length,
        labels: labels.labels.length
      }
    } else if (env.HOLDOUT_PHASE === 'begin-holdout' || env.HOLDOUT_PHASE === 'refuse-calls') {
      const receipt = await read('frozen/holdout-receipt.private.json')
      const prepared = await journal.begin({
        ...scope,
        runId: receipt.targetRunId,
        fullRawCases: {
          datasetId: seed.plan.datasetId,
          split: 'holdout',
          cases: seed.cases.slice(100)
        },
        maxRunAttempts: 1200
      })
      assert(prepared.input.cases.length === 200)
      if (env.HOLDOUT_PHASE === 'refuse-calls') {
        let rejected = false
        try {
          await journal.bindAssignment({
            runId: receipt.targetRunId,
            caseId: seed.cases[100].caseId,
            arm: 'A',
            assignmentId: randomUUID()
          })
        } catch (error) {
          rejected = error.message === 'RECORD_UNAVAILABLE'
        }
        assert(rejected)
        result = { holdoutCases: 200, newAssignmentRejected: true }
      } else result = { holdoutCases: 200, targetRunId: receipt.targetRunId }
    } else if (
      env.HOLDOUT_PHASE === 'verify-holdout' ||
      env.HOLDOUT_PHASE.startsWith('verify-reject-') ||
      env.HOLDOUT_PHASE.startsWith('correlate-')
    ) {
      const { JevCalibratedHoldouts } = await compiled(
        'server/src/generation/jev-calibrated-holdouts.js'
      )
      const review = await read('review/review-receipt.private.json')
      const holdoutReview = await read('holdout-review/review-receipt.private.json')
      const request = {
        calibration: {
          ...scope,
          runId: seed.runId,
          reviewId: review.reviewId,
          packet: await read('sealed-mapping.private.json'),
          artifacts: await read('artifacts.private.json'),
          labels: await read('labels.private.json'),
          settings: await read('settings.private.json'),
          policyVersion: 'compiled-holdout-policy-2',
          configVersion: 'compiled-holdout-config-2'
        },
        holdout: {
          reviewId: holdoutReview.reviewId,
          packet: await read('holdout-sealed-mapping.private.json'),
          artifacts: await read('holdout-artifacts.private.json'),
          labels: await read('holdout-labels.private.json')
        }
      }
      const service = new JevCalibratedHoldouts(db, version)
      const rejection = env.HOLDOUT_PHASE.replace('verify-reject-', '')
      if (env.HOLDOUT_PHASE.startsWith('correlate-')) {
        const { hashContext } = await compiled('src/core/reply/hashes.js')
        const missingUsage = env.HOLDOUT_OMIT_USAGE === 'one-target-text-response'
        const checkCorrelation = (proof) => {
          const { correlationHash, ...body } = proof
          const report = proof.settlementReport
          const { reportHash, ...reportBody } = report
          assert(
            proof.protocol === 'jev-central-settlement-correlation-v1' &&
              proof.scope.tenantId === scope.tenantId &&
              proof.scope.accountId === scope.accountId &&
              proof.dataKind === 'synthetic' &&
              proof.businessTruthVerified === false &&
              proof.centralEvidenceVerified === true &&
              hashContext(body) === correlationHash &&
              hashContext(reportBody) === reportHash &&
              report.centralEvidenceVerified === false &&
              report.dataKind === 'unverified' &&
              report.cases.length === 900 &&
              report.attemptCount === 1800 &&
              proof.verifiedEvidence.centralEvidenceVerified === true &&
              proof.verifiedEvidence.holdout.billedCostMicros === null &&
              proof.verifiedEvidence.holdout.approvalSubmission === null
          )
          for (const value of [proof, report, proof.verifiedEvidence])
            assert(value.monetaryBudgetVerified === false && value.releaseAuthorized === false)
          for (const value of [proof, report])
            assert(
              value.rawExportContentVerified === false &&
                value.supplierAuthenticityVerified === false &&
                value.providerBillingAccountVerified === false
            )
          if (missingUsage)
            assert(
              proof.verifiedEvidence.statisticalEvaluation === null &&
                proof.verifiedEvidence.holdout.dataset === null &&
                proof.verifiedEvidence.holdout.status === 'usage_incomplete'
            )
          else
            assert(
              proof.verifiedEvidence.statisticalEvaluation.holdout.pairedConversationBootstrap
                .replicates === 2000
            )
        }
        if (env.HOLDOUT_PHASE === 'correlate-settlements') {
          const allArtifacts = [...request.calibration.artifacts, ...request.holdout.artifacts]
          assert(allArtifacts.length === 900)
          const claims = {
            declaredBillingAccounts: {
              jev: `synthetic-jev-${randomUUID()}`,
              text: `synthetic-text-${randomUUID()}`
            },
            exports: []
          }
          const ids = new Set()
          for (const provider of ['jev', 'text']) {
            const sourceId = `synthetic-${provider}-export-${randomUUID()}`
            const rows = allArtifacts
              .flatMap((a) => a.attempts.filter((t) => t.start.provider === provider))
              .map((attempt) => {
                const id = attempt.result?.providerRequestId
                assert(
                  attempt.result?.outcome === 'response' &&
                    id &&
                    id.header === (provider === 'jev' ? 'x-typesafe-request-id' : 'x-request-id') &&
                    !ids.has(id.value)
                )
                ids.add(id.value)
                return {
                  requestId: id.value,
                  status: 'settled',
                  settledCostMicros: provider === 'text' ? 100 : 20,
                  lineRef: `synthetic-${attempt.attemptId}`
                }
              })
            assert(rows.length === 900)
            claims.exports.push({
              sourceId,
              provider,
              billingAccountId: claims.declaredBillingAccounts[provider],
              currency: seed.plan.currency,
              rawExportSha256: hashContext({ syntheticExportMetadata: true, sourceId }),
              scope: 'experiment_subset',
              rows
            })
          }
          assert(ids.size === 1800)
          await save('settlement-claims.private.json', claims)
          const complete = await service.correlateSettlements({
            evidence: request,
            settlements: claims
          })
          checkCorrelation(complete)
          assert(
            complete.settlementReport.status === 'complete_declared' &&
              complete.settlementReport.declaredSettledCostMicros === 108000 &&
              complete.settlementReport.bySplit.calibration.declaredSettledCostMicros === 36000 &&
              complete.settlementReport.bySplit.holdout.declaredSettledCostMicros === 72000 &&
              complete.settlementReport.holdoutArms.C.maximumDeclaredTurnCostMicros === 140 &&
              complete.settlementReport.holdoutArms.C.p95DeclaredTurnCostMicros === 140 &&
              complete.settlementReport.declaredBudgetAssessment.status === 'within_declared'
          )
          await save('correlated-settlements.private.json', complete)
          const missing = structuredClone(claims)
          const target = request.holdout.artifacts.find((a) => a.arm === 'C')
          const requestId = target.attempts.find((t) => t.stage === 'text').result.providerRequestId
            .value
          const source = missing.exports.find((s) => s.provider === 'text')
          source.rows = source.rows.filter((r) => r.requestId !== requestId)
          assert(source.rows.length === 899)
          await save('missing-settlement-claims.private.json', missing)
          const incomplete = await service.correlateSettlements({
            evidence: request,
            settlements: missing
          })
          checkCorrelation(incomplete)
          assert(
            incomplete.settlementReport.status === 'incomplete' &&
              incomplete.settlementReport.declaredSettledCostMicros === null &&
              incomplete.settlementReport.knownMatchedSubtotalMicros === 107900 &&
              incomplete.settlementReport.unresolvedAttemptCount === 1 &&
              incomplete.settlementReport.holdoutArms.C.maximumDeclaredTurnCostMicros === null &&
              incomplete.settlementReport.holdoutArms.C.p95DeclaredTurnCostMicros === null &&
              incomplete.settlementReport.declaredBudgetAssessment.status === 'incomplete' &&
              incomplete.verifiedEvidence.evidenceHash === complete.verifiedEvidence.evidenceHash &&
              incomplete.correlationHash !== complete.correlationHash
          )
          const unknownCases = incomplete.settlementReport.cases.filter(
            (c) => c.unresolvedAttemptCount > 0
          )
          const unknownAttempts = unknownCases.flatMap((c) =>
            c.attempts.filter((a) => a.missingReason !== null)
          )
          assert(
            unknownCases.length === 1 &&
              unknownCases[0].split === 'holdout' &&
              unknownCases[0].arm === 'C' &&
              unknownCases[0].caseId === target.caseId &&
              unknownCases[0].stages.text.declaredSettledCostMicros === null &&
              unknownCases[0].stages.pre.declaredSettledCostMicros === 20 &&
              unknownCases[0].stages.post.declaredSettledCostMicros === 20 &&
              unknownAttempts.length === 1 &&
              unknownAttempts[0].stage === 'text' &&
              unknownAttempts[0].missingReason === 'row_missing' &&
              unknownAttempts[0].declaredSettledCostMicros === null
          )
          await save('missing-correlated-settlements.private.json', incomplete)
          result = {
            settlementCorrelationVerified: true,
            completePlanCases: 300,
            caseArmCount: 900,
            persistedProviderRequestIds: 1800,
            declaredSettledCostMicros: 108000,
            maximumDeclaredTargetCTurnCostMicros: 140,
            missingSettlementUnresolvedAttempts: 1,
            missingSettlementDeclaredCostMicros: null,
            missingUsageStatisticsRemainNull: missingUsage,
            supplierAuthenticityVerified: false,
            monetaryBudgetVerified: false,
            releaseAuthorized: false
          }
        } else {
          const claims = await read('settlement-claims.private.json')
          const reasons = {
            'correlate-reject-disabled': 'jev_blind_reviewer_denied',
            'correlate-reject-stale': 'jev_blind_review_stale'
          }
          assert(Object.hasOwn(reasons, env.HOLDOUT_PHASE))
          let refused = false
          try {
            await service.correlateSettlements({ evidence: request, settlements: claims })
          } catch (error) {
            refused = error.message === reasons[env.HOLDOUT_PHASE]
          }
          assert(refused)
          result = { settlementCorrelationRejected: true }
        }
      } else if (env.HOLDOUT_PHASE.startsWith('verify-reject-')) {
        const reasons = {
          'source-review': 'jev_holdout_lineage_required',
          'target-version': 'database_freeze_mismatch',
          'target-artifacts': 'jev_blind_packet_mapping_invalid',
          'target-labels': 'jev_blind_review_changed',
          'target-stale-review': 'jev_blind_review_stale'
        }
        assert(Object.hasOwn(reasons, rejection))
        if (rejection === 'source-review') request.calibration.reviewId = randomUUID()
        if (rejection === 'target-version')
          request.holdout.packet.frozen = request.calibration.packet.frozen
        if (rejection === 'target-artifacts')
          request.holdout.artifacts = request.holdout.artifacts.slice(1)
        if (rejection === 'target-labels') request.holdout.labels.labels[0].coveredIntents = 0
        let refused = false
        try {
          await service.verify(request)
        } catch (error) {
          refused = error.message === reasons[rejection]
        }
        assert(refused)
        result = { evidenceRejected: true, reason: rejection }
      } else {
        const proof = await service.verify(request)
        const held = await read('frozen/holdout-receipt.private.json')
        assert(
          proof.centralEvidenceVerified &&
            !proof.releaseAuthorized &&
            !proof.monetaryBudgetVerified &&
            proof.holdout.billedCostMicros === null &&
            proof.holdout.approvalSubmission === null &&
            held.targetSnapshotHash !== held.sourceSnapshotHash &&
            JSON.stringify(proof.lineage) === JSON.stringify(held)
        )
        const missingUsage = env.HOLDOUT_OMIT_USAGE === 'one-target-text-response'
        if (missingUsage) {
          const incomplete = request.holdout.artifacts.filter((a) => a.usage === null)
          const unknownOutcomes = proof.holdout.cases.flatMap((c) =>
            c.outcomes.filter((o) => o.inputTokens === null || o.outputTokens === null)
          )
          assert(
            proof.holdout.status === 'usage_incomplete' &&
              proof.holdout.dataset === null &&
              proof.statisticalEvaluation === null &&
              proof.holdout.cases.length === 200 &&
              request.holdout.artifacts.length === 600 &&
              incomplete.length === 1 &&
              incomplete[0].caseId === 'synthetic-100' &&
              incomplete[0].arm === 'A' &&
              incomplete[0].usageSource === 'unknown' &&
              unknownOutcomes.length === 1 &&
              unknownOutcomes[0].inputTokens === null &&
              unknownOutcomes[0].outputTokens === null &&
              proof.holdout.cases.every((c) => c.split === 'holdout' && c.outcomes.length === 3)
          )
        } else
          assert(
            proof.holdout.dataset.cases.length === 200 &&
              proof.holdout.dataset.cases.every(
                (c) => c.split === 'holdout' && c.outcomes.length === 3
              ) &&
              proof.holdout.dataset.experimentSnapshotHash === held.targetSnapshotHash &&
              held.targetSnapshotHash !== held.sourceSnapshotHash &&
              JSON.stringify(proof.lineage) === JSON.stringify(held) &&
              proof.statisticalEvaluation.protocol === 'jev-calibrated-holdout-metrics-v1' &&
              proof.statisticalEvaluation.dataKind === 'synthetic' &&
              proof.statisticalEvaluation.businessTruthVerified === false &&
              proof.statisticalEvaluation.calibration.experimentSnapshotHash ===
                held.sourceSnapshotHash &&
              proof.statisticalEvaluation.calibration.sampleCount === 100 &&
              proof.statisticalEvaluation.holdout.experimentSnapshotHash ===
                held.targetSnapshotHash &&
              proof.statisticalEvaluation.holdout.sample.holdout === 200 &&
              proof.statisticalEvaluation.holdout.pairedConversationBootstrap.replicates === 2000 &&
              proof.statisticalEvaluation.holdout.assessment.status === 'insufficient_evidence' &&
              proof.statisticalEvaluation.holdout.assessment.reasons.includes(
                'too_few_baseline_errors'
              ) &&
              !proof.statisticalEvaluation.holdout.assessment.reasons.includes(
                'calibration_below_100'
              )
          )
        await save('verified-holdout.private.json', proof)
        await save('verify-request.private.json', {
          calibration: {
            packet: `${env.HOLDOUT_DIRECTORY}/sealed-mapping.private.json`,
            artifacts: `${env.HOLDOUT_DIRECTORY}/artifacts.private.json`,
            labels: `${env.HOLDOUT_DIRECTORY}/labels.private.json`,
            settings: `${env.HOLDOUT_DIRECTORY}/settings.private.json`,
            reviewId: review.reviewId,
            policyVersion: request.calibration.policyVersion,
            configVersion: request.calibration.configVersion
          },
          holdout: {
            packet: `${env.HOLDOUT_DIRECTORY}/holdout-sealed-mapping.private.json`,
            artifacts: `${env.HOLDOUT_DIRECTORY}/holdout-artifacts.private.json`,
            labels: `${env.HOLDOUT_DIRECTORY}/holdout-labels.private.json`,
            reviewId: holdoutReview.reviewId
          }
        })
        await save('holdout-revised-labels.private.json', {
          ...request.holdout.labels,
          labels: [...request.holdout.labels.labels].reverse()
        })
        result = {
          holdoutCases: 200,
          holdoutArtifacts: 600,
          centralEvidenceVerified: true,
          statisticalAssessment:
            proof.statisticalEvaluation?.holdout.assessment.status ?? 'usage_incomplete',
          feesUnknown: true
        }
      }
    } else throw new Error('fixture_phase_invalid')
  }
  assert(forbiddenFetchCalls === 0)
  process.stdout.write(
    JSON.stringify({ ...result, forbiddenFetchCalls: 0, actualModelRequests: 0 }) + '\n'
  )
} catch {
  process.stderr.write('Compiled holdout fixture failed.\n')
  process.exitCode = 1
} finally {
  try {
    if (db) await db.close()
  } finally {
    closePrivatePermissions?.()
  }
}
