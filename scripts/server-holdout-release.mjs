import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, writeFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'

const check = (condition, code) => {
  if (!condition) throw new Error(code)
}
/** Execute 100 calibration and 200 held-out cases in all three arms, using
 * compiled modules and the packaged calibrate/freeze CLI with mock transport. */
export async function checkReleaseHoldout({
  root,
  release,
  operator,
  launch,
  environment,
  connection,
  tenant,
  account,
  login,
  recorded,
  omitHoldoutUsage = false,
  profile = false
}) {
  const suffix = randomUUID().replaceAll('-', ''),
    reviewerLogin = `release_holdout_review_${suffix}`,
    reviewer = `synthetic-reviewer-${suffix}`
  const password = randomBytes(32).toString('hex'),
    directory = `.local/compiled-holdout-${suffix}`
  const reviewUrl = new URL(connection)
  reviewUrl.username = reviewerLogin
  reviewUrl.password = password
  await operator.query(
    `CREATE ROLE ${reviewerLogin} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'; GRANT autoreply_jev_reviewer TO ${reviewerLogin}`
  )
  await operator.query(
    "INSERT INTO autoreply.employees(tenant_id,id,role) VALUES($1,$2,'employee')",
    [tenant, reviewer]
  )
  await operator.query(
    'INSERT INTO autoreply.jev_reviewer_database_principals(login_name,tenant_id,account_id,employee_id) VALUES($1,$2,$3,$4)',
    [reviewerLogin, tenant, account, reviewer]
  )
  const fixturePath = join(release, '.local', `holdout-bootstrap-${suffix}.mjs`)
  await writeFile(
    fixturePath,
    await readFile(join(root, 'scripts/server-holdout-release-fixture.mjs')),
    { flag: 'wx', mode: 0o600 }
  )
  const config = {
    ...environment,
    ADMIN_DATABASE_URL: connection,
    TEXT_MODEL_BASE_URL: 'https://text.invalid/v1/',
    TEXT_MODEL_ID: 'text-request',
    TEXT_MODEL_EXPECTED_ID: 'text-resolved',
    HOLDOUT_RELEASE_ROOT: release,
    HOLDOUT_DIRECTORY: directory,
    HOLDOUT_TENANT: tenant,
    HOLDOUT_ACCOUNT: account,
    HOLDOUT_REVIEWER: reviewer,
    HOLDOUT_OMIT_USAGE: omitHoldoutUsage ? 'one-target-text-response' : 'none',
    HOLDOUT_PROFILE: profile ? '1' : '0',
    HOLDOUT_PUBLICATION: join(root, 'server/admin/publication.example.json')
  }
  const run = async (args, phase, env = config, expectedCode = 0, timeout = 4000) => {
    const result = await launch(process.execPath, args, { cwd: release, env, timeout }).result
    if (
      result.code !== expectedCode ||
      result.failure ||
      (expectedCode === 0 && result.stderr.trim() !== '')
    ) {
      const error = new Error('release_holdout_command_failed')
      error.releaseDiagnostic = {
        phase: `holdout_${phase.replaceAll('-', '_').toLowerCase()}`,
        exitCode: result.code,
        failure: result.failure,
        elapsedMs: result.elapsedMs,
        stdoutEmpty: result.stdout.trim() === ''
      }
      throw error
    }
    return result
  }
  const phase = async (name, timeout = 4000) => {
    const result = await run([fixturePath], name, { ...config, HOLDOUT_PHASE: name }, 0, timeout)
    let parsed
    try {
      parsed = JSON.parse(result.stdout)
    } catch {
      throw new Error('release_holdout_fixture_output_invalid')
    }
    check(
      parsed.forbiddenFetchCalls === 0 && parsed.actualModelRequests === 0,
      'release_holdout_real_model_called'
    )
    return { ...parsed, elapsedMs: result.elapsedMs }
  }
  const seed = await phase('setup'),
    arms = []
  check(
    seed.cases === 300 && seed.calibrationCases === 100 && seed.holdoutCases === 200,
    'release_holdout_samples_changed'
  )
  for (const arm of ['A', 'B', 'C']) arms.push(await phase(`arm-${arm}`, 20000))
  check(
    arms.every((a) => a.cases === 100 && a.artifacts === 100) &&
      arms.reduce((n, a) => n + a.simulatedRequests, 0) === 600,
    'release_holdout_execution_incomplete'
  )
  const blind = await phase('blind')
  const entry = join(release, 'server/scripts/jev-replay.js')
  const scoped = ['--tenant', tenant, '--account', account, '--run', seed.runId]
  const reviewDirectory = `${directory}/review`
  await run(
    [
      entry,
      'review-submit',
      ...scoped,
      '--packet-id',
      blind.packetId,
      '--labels',
      `${directory}/labels.private.json`,
      '--out',
      reviewDirectory
    ],
    'independent-review',
    { ...environment, REVIEW_DATABASE_URL: reviewUrl.href }
  )
  const receipt = JSON.parse(
    await readFile(join(release, reviewDirectory, 'review-receipt.private.json'), 'utf8')
  )
  check(
    receipt.reviewerId === reviewer && receipt.releaseAuthorized === false,
    'release_holdout_reviewer_changed'
  )
  const evidence = [
    ...scoped,
    '--packet',
    `${directory}/sealed-mapping.private.json`,
    '--artifacts',
    `${directory}/artifacts.private.json`,
    '--labels',
    `${directory}/labels.private.json`,
    '--review-id',
    receipt.reviewId,
    '--settings',
    `${directory}/settings.private.json`
  ]
  await run([entry, 'calibrate', ...evidence, '--out', `${directory}/calibrated`], 'calibrate')
  const calibrated = JSON.parse(
    await readFile(join(release, directory, 'calibrated/status.json'), 'utf8')
  )
  check(
    calibrated.candidatePredeclarationVerified === true && calibrated.releaseAuthorized === false,
    'release_holdout_calibration_invalid'
  )
  const freeze = async (out, configVersion = 'compiled-holdout-config-2', expectedCode = 0) => {
    const result = await run(
      [
        entry,
        'freeze-holdout',
        ...evidence,
        '--policy-version',
        'compiled-holdout-policy-2',
        '--config-version',
        configVersion,
        '--out',
        `${directory}/${out}`
      ],
      `freeze-${out}`,
      config,
      expectedCode
    )
    if (expectedCode !== 0) {
      check(result.stdout.trim() === '', 'release_holdout_rejected_output_invalid')
      const absent = await lstat(join(release, directory, out)).then(
        () => false,
        (error) => error.code === 'ENOENT'
      )
      check(absent, 'release_holdout_rejection_created_directory')
    }
  }
  await freeze('frozen')
  await freeze('retry')
  await freeze('changed-rejected', 'changed-config', 1)
  const held = JSON.parse(
    await readFile(join(release, directory, 'frozen/holdout-receipt.private.json'), 'utf8')
  )
  const retry = JSON.parse(
    await readFile(join(release, directory, 'retry/holdout-receipt.private.json'), 'utf8')
  )
  check(
    JSON.stringify(held) === JSON.stringify(retry) &&
      held.evaluationOnly === true &&
      held.releaseAuthorized === false,
    'release_holdout_retry_changed'
  )
  await phase('begin-holdout')
  await freeze('retry-after-start')
  check(
    JSON.stringify(held) ===
      (await readFile(
        join(release, directory, 'retry-after-start/holdout-receipt.private.json'),
        'utf8'
      ).then((s) => JSON.stringify(JSON.parse(s)))),
    'release_holdout_started_retry_changed'
  )
  await operator.query(
    'UPDATE autoreply.employees SET enabled=false WHERE tenant_id=$1 AND id=$2',
    [tenant, reviewer]
  )
  try {
    await freeze('disabled-rejected', 'compiled-holdout-config-2', 1)
    check(
      (await phase('refuse-calls')).newAssignmentRejected === true,
      'release_holdout_disabled_call_accepted'
    )
  } finally {
    await operator.query(
      'UPDATE autoreply.employees SET enabled=true WHERE tenant_id=$1 AND id=$2',
      [tenant, reviewer]
    )
  }
  const holdoutArms = []
  for (const arm of ['A', 'B', 'C'])
    for (const batch of [1, 2]) holdoutArms.push(await phase(`holdout-${arm}-${batch}`, 20000))
  check(
    holdoutArms.every((a) => a.cases === 100 && a.artifacts === 100 && a.fullInputCases === 200) &&
      holdoutArms.reduce((n, a) => n + a.simulatedRequests, 0) === 1200 &&
      holdoutArms.reduce((n, a) => n + a.responsesWithoutUsage, 0) === (omitHoldoutUsage ? 1 : 0) &&
      holdoutArms.reduce((n, a) => n + a.artifactsWithoutUsage, 0) === (omitHoldoutUsage ? 1 : 0),
    'release_holdout_target_execution_incomplete'
  )
  const holdoutBlind = await phase('holdout-blind')
  check(
    holdoutBlind.artifacts === 600 && holdoutBlind.labels === 600,
    'release_holdout_target_blind_incomplete'
  )
  await run(
    [
      entry,
      'review-submit',
      '--tenant',
      tenant,
      '--account',
      account,
      '--run',
      held.targetRunId,
      '--packet-id',
      holdoutBlind.packetId,
      '--labels',
      `${directory}/holdout-labels.private.json`,
      '--out',
      `${directory}/holdout-review`
    ],
    'independent-holdout-review',
    { ...environment, REVIEW_DATABASE_URL: reviewUrl.href }
  )
  const verified = await phase('verify-holdout')
  check(
    verified.centralEvidenceVerified === true && verified.feesUnknown === true,
    'release_holdout_evidence_invalid'
  )
  const verifyArgs = [
    entry,
    'verify-holdout',
    ...scoped,
    '--request',
    `${directory}/verify-request.private.json`
  ]
  await run([...verifyArgs, '--out', `${directory}/verified-cli`], 'verify-holdout-cli', config, 2)
  const commandStatus = JSON.parse(
    await readFile(join(release, directory, 'verified-cli/status.json'), 'utf8')
  )
  const commandEvidence = JSON.parse(
    await readFile(join(release, directory, 'verified-cli/verified-evidence.private.json'), 'utf8')
  )
  const fixtureEvidence = JSON.parse(
    await readFile(join(release, directory, 'verified-holdout.private.json'), 'utf8')
  )
  check(
    commandStatus.centralEvidenceVerified === true &&
      commandStatus.statisticalAssessment ===
        (omitHoldoutUsage ? 'usage_incomplete' : 'insufficient_evidence') &&
      commandStatus.monetaryBudgetVerified === false &&
      commandStatus.releaseAuthorized === false &&
      commandEvidence.evidenceHash === fixtureEvidence.evidenceHash,
    'release_holdout_cli_statistics_invalid'
  )
  const statisticsFile = join(release, directory, 'verified-cli/statistical-report.private.json')
  if (omitHoldoutUsage) {
    check(
      commandEvidence.statisticalEvaluation === null &&
        commandEvidence.holdout.dataset === null &&
        commandEvidence.holdout.status === 'usage_incomplete' &&
        commandEvidence.holdout.billedCostMicros === null &&
        commandEvidence.holdout.approvalSubmission === null &&
        (await lstat(statisticsFile).then(
          () => false,
          (error) => error.code === 'ENOENT'
        )),
      'release_holdout_unknown_usage_became_statistics'
    )
  } else {
    const statistics = JSON.parse(await readFile(statisticsFile, 'utf8'))
    check(
      commandEvidence.statisticalEvaluation.dataKind === 'synthetic' &&
        commandEvidence.statisticalEvaluation.businessTruthVerified === false &&
        JSON.stringify(statistics) === JSON.stringify(commandEvidence.statisticalEvaluation),
      'release_holdout_separate_statistics_changed'
    )
  }
  const settlementFixture = await phase('correlate-settlements', 25000)
  check(
    settlementFixture.settlementCorrelationVerified === true &&
      settlementFixture.completePlanCases === 300 &&
      settlementFixture.caseArmCount === 900 &&
      settlementFixture.persistedProviderRequestIds === 1800 &&
      settlementFixture.declaredSettledCostMicros === 108000 &&
      settlementFixture.maximumDeclaredTargetCTurnCostMicros === 140 &&
      settlementFixture.missingSettlementUnresolvedAttempts === 1 &&
      settlementFixture.missingSettlementDeclaredCostMicros === null &&
      settlementFixture.missingUsageStatisticsRemainNull === omitHoldoutUsage &&
      settlementFixture.supplierAuthenticityVerified === false &&
      settlementFixture.monetaryBudgetVerified === false &&
      settlementFixture.releaseAuthorized === false,
    'release_holdout_settlement_fixture_invalid'
  )
  const correlateArgs = [
    entry,
    'correlate-settlements',
    ...scoped,
    '--request',
    `${directory}/verify-request.private.json`
  ]
  const correlate = async (out, claims = 'settlement-claims.private.json', expectedCode = 2) => {
    const result = await run(
      [...correlateArgs, '--settlements', `${directory}/${claims}`, '--out', `${directory}/${out}`],
      `correlate-${out}`,
      config,
      expectedCode
    )
    if (expectedCode !== 2) {
      check(result.stdout.trim() === '', 'release_holdout_settlement_rejection_output_invalid')
      check(
        await lstat(join(release, directory, out)).then(
          () => false,
          (error) => error.code === 'ENOENT'
        ),
        'release_holdout_settlement_rejection_created_output'
      )
      return
    }
    check(
      result.stderr.trim() === '' && result.stdout.trim() !== '',
      'release_holdout_settlement_cli_output_invalid'
    )
    const status = JSON.parse(await readFile(join(release, directory, out, 'status.json'), 'utf8'))
    const proof = JSON.parse(
      await readFile(join(release, directory, out, 'correlated-evidence.private.json'), 'utf8')
    )
    const fixtureProof = JSON.parse(
      await readFile(
        join(
          release,
          directory,
          claims === 'settlement-claims.private.json'
            ? 'correlated-settlements.private.json'
            : 'missing-correlated-settlements.private.json'
        ),
        'utf8'
      )
    )
    check(
      status.mode === 'central_settlement_correlation_pending_authentication' &&
        status.centralEvidenceVerified === true &&
        status.correlationHash === proof.correlationHash &&
        status.settlementStatus === proof.settlementReport.status &&
        status.declaredBudgetStatus === proof.settlementReport.declaredBudgetAssessment.status &&
        status.statisticalAssessment === commandStatus.statisticalAssessment &&
        proof.protocol === 'jev-central-settlement-correlation-v1' &&
        proof.centralEvidenceVerified === true &&
        proof.scope.tenantId === tenant &&
        proof.scope.accountId === account &&
        proof.dataKind === 'synthetic' &&
        proof.businessTruthVerified === false &&
        proof.correlationHash === fixtureProof.correlationHash &&
        proof.verifiedEvidence.evidenceHash === commandEvidence.evidenceHash &&
        proof.settlementReport.centralEvidenceVerified === false &&
        proof.settlementReport.dataKind === 'unverified' &&
        proof.settlementReport.cases.length === 900 &&
        proof.settlementReport.attemptCount === 1800,
      'release_holdout_settlement_cli_proof_invalid'
    )
    for (const value of [status, proof, proof.settlementReport])
      check(
        value.rawExportContentVerified === false &&
          value.supplierAuthenticityVerified === false &&
          value.providerBillingAccountVerified === false &&
          value.monetaryBudgetVerified === false &&
          value.releaseAuthorized === false,
        'release_holdout_settlement_authenticated_supplier'
      )
    if (omitHoldoutUsage)
      check(
        proof.verifiedEvidence.statisticalEvaluation === null &&
          proof.verifiedEvidence.holdout.dataset === null &&
          proof.verifiedEvidence.holdout.status === 'usage_incomplete',
        'release_holdout_settlement_completed_unknown_usage'
      )
    return proof
  }
  const correlated = await correlate('correlated-cli')
  check(
    correlated.settlementReport.status === 'complete_declared' &&
      correlated.settlementReport.declaredSettledCostMicros === 108000 &&
      correlated.settlementReport.holdoutArms.C.maximumDeclaredTurnCostMicros === 140 &&
      correlated.settlementReport.holdoutArms.C.p95DeclaredTurnCostMicros === 140 &&
      correlated.settlementReport.declaredBudgetAssessment.status === 'within_declared',
    'release_holdout_settlement_complete_cli_invalid'
  )
  const incompleteSettlements = await correlate(
    'missing-correlated-cli',
    'missing-settlement-claims.private.json'
  )
  check(
    incompleteSettlements.settlementReport.status === 'incomplete' &&
      incompleteSettlements.settlementReport.declaredSettledCostMicros === null &&
      incompleteSettlements.settlementReport.knownMatchedSubtotalMicros === 107900 &&
      incompleteSettlements.settlementReport.unresolvedAttemptCount === 1 &&
      incompleteSettlements.settlementReport.holdoutArms.C.maximumDeclaredTurnCostMicros === null &&
      incompleteSettlements.settlementReport.holdoutArms.C.p95DeclaredTurnCostMicros === null &&
      incompleteSettlements.settlementReport.declaredBudgetAssessment.status === 'incomplete',
    'release_holdout_settlement_missing_cli_invalid'
  )
  await operator.query(
    'UPDATE autoreply.employees SET enabled=false WHERE tenant_id=$1 AND id=$2',
    [tenant, reviewer]
  )
  try {
    await run(
      [...verifyArgs, '--out', `${directory}/disabled-verify-rejected`],
      'verify-disabled-cli',
      config,
      1
    )
    check(
      await lstat(join(release, directory, 'disabled-verify-rejected')).then(
        () => false,
        (error) => error.code === 'ENOENT'
      ),
      'release_holdout_disabled_cli_created_output'
    )
    check(
      (await phase('correlate-reject-disabled', 25000)).settlementCorrelationRejected === true,
      'release_holdout_settlement_disabled_service_accepted'
    )
    await correlate('disabled-correlate-rejected', 'settlement-claims.private.json', 1)
  } finally {
    await operator.query(
      'UPDATE autoreply.employees SET enabled=true WHERE tenant_id=$1 AND id=$2',
      [tenant, reviewer]
    )
  }
  for (const rejection of ['source-review', 'target-version', 'target-artifacts', 'target-labels'])
    check(
      (await phase(`verify-reject-${rejection}`)).evidenceRejected === true,
      'release_holdout_modified_evidence_accepted'
    )
  await run(
    [
      entry,
      'review-submit',
      '--tenant',
      tenant,
      '--account',
      account,
      '--run',
      held.targetRunId,
      '--packet-id',
      holdoutBlind.packetId,
      '--labels',
      `${directory}/holdout-revised-labels.private.json`,
      '--out',
      `${directory}/holdout-revised-review`
    ],
    'independent-holdout-review-revision',
    { ...environment, REVIEW_DATABASE_URL: reviewUrl.href }
  )
  check(
    (await phase('verify-reject-target-stale-review')).evidenceRejected === true,
    'release_holdout_stale_evidence_accepted'
  )
  await run(
    [...verifyArgs, '--out', `${directory}/stale-verify-rejected`],
    'verify-stale-cli',
    config,
    1
  )
  check(
    await lstat(join(release, directory, 'stale-verify-rejected')).then(
      () => false,
      (error) => error.code === 'ENOENT'
    ),
    'release_holdout_stale_cli_created_output'
  )
  check(
    (await phase('correlate-reject-stale', 25000)).settlementCorrelationRejected === true,
    'release_holdout_settlement_stale_service_accepted'
  )
  await correlate('stale-correlate-rejected', 'settlement-claims.private.json', 1)
  const records = (
    await operator.query(
      `SELECT
    (SELECT count(*)::int FROM autoreply.jev_holdout_lineages WHERE tenant_id=$1 AND account_id=$2 AND source_run_id=$3) AS lineages,
    (SELECT count(*)::int FROM autoreply.jev_replay_attempts t JOIN autoreply.jev_replay_assignments b ON (b.tenant_id,b.account_id,b.id)=(t.tenant_id,t.account_id,t.assignment_id)
      JOIN autoreply.jev_replay_executions e ON (e.tenant_id,e.account_id,e.id)=(b.tenant_id,b.account_id,b.execution_id) WHERE e.tenant_id=$1 AND e.account_id=$2 AND e.run_id=ANY($5::text[])) AS attempts,
    (SELECT count(*)::int FROM autoreply.evaluation_approvals WHERE tenant_id=$1) AS approvals,
    (SELECT count(*)::int FROM autoreply.execution_permits WHERE tenant_id=$1) AS permits,
    (SELECT count(*)::int FROM autoreply.accounts WHERE tenant_id=$1 AND NOT paused) AS unpaused,
    (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND usename=ANY($4::text[])) AS backends`,
      [tenant, account, seed.runId, [login, reviewerLogin], [seed.runId, held.targetRunId]]
    )
  ).rows[0]
  check(
    records.lineages === 1 &&
      records.attempts === 1800 &&
      records.approvals === 0 &&
      records.permits === 0 &&
      records.unpaused === 0 &&
      records.backends === 0,
    'release_holdout_database_state_changed'
  )
  const usageRows = (
    await operator.query(
      `SELECT e.split, count(*)::int AS results,
        count(*) FILTER (WHERE r.result_json->>'outcome'='response' AND NOT (r.result_json ? 'usage'))::int AS missing_usage,
        count(*) FILTER (WHERE r.result_json->>'outcome'<>'response')::int AS non_response,
        count(*) FILTER (WHERE NOT (r.result_json ? 'providerRequestId'))::int AS missing_request_ids,
        count(DISTINCT r.result_json->'providerRequestId'->>'value')::int AS distinct_request_ids
      FROM autoreply.jev_replay_executions e
      JOIN autoreply.jev_replay_assignments b ON (b.tenant_id,b.account_id,b.execution_id)=(e.tenant_id,e.account_id,e.id)
      JOIN autoreply.jev_replay_attempts t ON (t.tenant_id,t.account_id,t.assignment_id)=(b.tenant_id,b.account_id,b.id)
      JOIN autoreply.jev_replay_results r ON (r.tenant_id,r.account_id,r.attempt_id)=(t.tenant_id,t.account_id,t.id)
      WHERE e.tenant_id=$1 AND e.account_id=$2 AND e.run_id=ANY($3::text[]) GROUP BY e.split`,
      [tenant, account, [seed.runId, held.targetRunId]]
    )
  ).rows
  const calibrationUsage = usageRows.find((r) => r.split === 'calibration'),
    targetUsage = usageRows.find((r) => r.split === 'holdout')
  check(
    usageRows.length === 2 &&
      calibrationUsage?.results === 600 &&
      calibrationUsage.missing_usage === 0 &&
      calibrationUsage.non_response === 0 &&
      calibrationUsage.missing_request_ids === 0 &&
      calibrationUsage.distinct_request_ids === 600 &&
      targetUsage?.results === 1200 &&
      targetUsage.missing_usage === (omitHoldoutUsage ? 1 : 0) &&
      targetUsage.non_response === 0 &&
      targetUsage.missing_request_ids === 0 &&
      targetUsage.distinct_request_ids === 1200,
    'release_holdout_persisted_usage_invalid'
  )
  recorded(
    omitHoldoutUsage
      ? 'actual_compiled_holdout_missing_usage'
      : 'actual_compiled_calibrated_holdout',
    {
      completePlanCases: 300,
      calibrationCases: 100,
      holdoutCases: 200,
      sealedArtifacts: 300,
      simulatedHttpRequests: 600,
      holdoutSealedArtifacts: 600,
      holdoutSimulatedHttpRequests: 1200,
      holdoutCasesActuallyExecuted: 200,
      holdoutEvidenceVerified: true,
      distinctCalibrationAndHoldoutSnapshots: true,
      settledFeesUnknown: true,
      centralSettlementDataKind: correlated.dataKind,
      pureSettlementDataKind: correlated.settlementReport.dataKind,
      settlementCaseArmCount: 900,
      centralSettlementCorrelationVerified: true,
      pureSettlementCentralEvidenceVerified: false,
      correlateSettlementsCommandVerified: true,
      missingSettlementCommandVerified: true,
      persistedProviderRequestIds: 1800,
      declaredSettledCostMicros: correlated.settlementReport.declaredSettledCostMicros,
      maximumDeclaredTargetCTurnCostMicros:
        correlated.settlementReport.holdoutArms.C.maximumDeclaredTurnCostMicros,
      missingSettlementDeclaredCostMicros:
        incompleteSettlements.settlementReport.declaredSettledCostMicros,
      missingSettlementUnresolvedAttempts:
        incompleteSettlements.settlementReport.unresolvedAttemptCount,
      disabledSettlementServiceRejected: true,
      disabledSettlementCommandRejected: true,
      staleSettlementServiceRejected: true,
      staleSettlementCommandRejected: true,
      settlementCorrelationFixtureDeadlineMs: 25000,
      settlementCorrelationFixtureElapsedMs: settlementFixture.elapsedMs,
      rawExportContentVerified: false,
      supplierAuthenticityVerified: false,
      providerBillingAccountVerified: false,
      monetaryBudgetVerified: false,
      modifiedEvidenceRejected: true,
      latestHoldoutReviewRequired: true,
      verifyHoldoutCommandVerified: true,
      statisticalAssessment: commandStatus.statisticalAssessment,
      bootstrapReplicates:
        commandEvidence.statisticalEvaluation?.holdout.pairedConversationBootstrap.replicates ??
        null,
      staleReviewCommandRejected: true,
      disabledReviewCommandRejected: true,
      statisticalDataKind: commandEvidence.statisticalEvaluation?.dataKind ?? null,
      missingUsageResponses: omitHoldoutUsage ? 1 : 0,
      missingUsageArtifacts: omitHoldoutUsage ? 1 : 0,
      centralMissingUsageResponses: targetUsage.missing_usage,
      calibrationMissingUsageResponses: calibrationUsage.missing_usage,
      statisticalReportCreated: !omitHoldoutUsage,
      businessTruthVerified: false,
      actualModelRequests: 0,
      ordinaryAdminLogin: true,
      ordinaryIndependentReviewerLogin: true,
      calibrateCommandVerified: true,
      freezeCommandVerified: true,
      originalReceiptOnRetry: true,
      originalReceiptAfterStart: true,
      changedVersionRejected: true,
      reviewerDisabledRejected: true,
      newCallAfterStartRejected: true,
      armFixtureDeadlineMs: 20000,
      compiledCommandDeadlineMs: 4000,
      armElapsedMs: arms.map((a) => ({ arm: a.arm, elapsedMs: a.elapsedMs })),
      holdoutBatchElapsedMs: holdoutArms.map((a) => ({
        arm: a.arm,
        batch: a.batch,
        elapsedMs: a.elapsedMs
      })),
      databaseBackends: 0,
      modelsCalled: false,
      releaseAuthorized: false
    }
  )
}
