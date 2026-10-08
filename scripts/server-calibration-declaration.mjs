import { randomUUID } from 'node:crypto'
import { readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'

function check(condition, code) {
  if (!condition) throw new Error(code)
}

/** Actual packaged command with a real ordinary PostgreSQL login. All examples
 * are synthetic; this fixture does not execute providers or authorize sending. */
export async function checkReleaseCalibrationDeclaration({
  root,
  release,
  operator,
  launch,
  environment,
  connection,
  tenant,
  account,
  login,
  recorded
}) {
  const directory = `.local/calibration-declaration-${randomUUID()}`
  const config = {
    ...environment,
    ADMIN_DATABASE_URL: connection,
    TEXT_MODEL_BASE_URL: 'https://synthetic-text.invalid/v1/',
    TEXT_MODEL_ID: 'synthetic-text',
    TEXT_MODEL_EXPECTED_ID: 'synthetic-text',
    DECLARATION_DIRECTORY: directory,
    DECLARATION_TENANT: tenant,
    DECLARATION_ACCOUNT: account,
    DECLARATION_PUBLICATION: join(root, 'server', 'admin', 'publication.example.json')
  }
  const setup = `
    import {readFile} from 'node:fs/promises';
    import {Postgres} from './server/src/database/postgres.js';
    import {Administration} from './server/src/admin/administration.js';
    import {PublicationSchema} from './server/src/generation/publication.js';
    import {textGeneratorVersion} from './server/src/generation/text-generator.js';
    import {JevReplayJournal} from './server/src/generation/jev-replay-journal.js';
    import {replayCaseInputHash} from './evals/jev/replay-input.js';
    import {writePrivateAdminOutput} from './server/scripts/private-admin-output.js';
    import {hashContext} from './src/core/reply/hashes.js';
    globalThis.fetch=async()=>{throw new Error('model_http_forbidden')};
    const env=process.env, db=new Postgres(env.ADMIN_DATABASE_URL);
    try {
      const publication=PublicationSchema.parse(JSON.parse(await readFile(env.DECLARATION_PUBLICATION,'utf8')));
      publication.configuration.automaticEnabled=true;
      publication.policy.mode='enforced';publication.policy.evaluationApproved=true;
      publication.textGeneratorVersion=textGeneratorVersion({baseUrl:env.TEXT_MODEL_BASE_URL,model:env.TEXT_MODEL_ID,expectedModel:env.TEXT_MODEL_EXPECTED_ID});
      const cases=Array.from({length:300},(_,i)=>({caseId:'synthetic-'+i,conversationGroup:'synthetic-group-'+i,split:i<100?'calibration':'holdout',conversationId:'synthetic-peer-'+i,inbound:['请转人工客服']}));
      const plan={datasetId:'synthetic-declaration',currency:'CNY',maximumTurnCostMicros:10000,maximumP95LatencyMs:1000,replayProtocol:'jev-abc-v1',
        assignments:cases.map(c=>({caseId:c.caseId,conversationGroup:c.conversationGroup,split:c.split,inputHash:replayCaseInputHash(c)}))};
      const admin=new Administration(db,publication.textGeneratorVersion);
      const settings={candidates:[publication.policy],targets:{maximumErrorReleaseRate:0.01,minimumAutomaticCoverage:0.5,minimumAutomaticReplies:30}};
      await writePrivateAdminOutput(env.DECLARATION_DIRECTORY+'/settings.private.json',settings);
      const changed=structuredClone(settings);changed.targets.maximumErrorReleaseRate=0.02;
      await writePrivateAdminOutput(env.DECLARATION_DIRECTORY+'/changed.private.json',changed);
      const run=await admin.freezeEvaluation(env.DECLARATION_TENANT,env.DECLARATION_ACCOUNT,{publication,plan});
      const late=await admin.freezeEvaluation(env.DECLARATION_TENANT,env.DECLARATION_ACCOUNT,{publication,plan});
      const begun=await new JevReplayJournal(db,publication.textGeneratorVersion).begin({tenantId:env.DECLARATION_TENANT,accountId:env.DECLARATION_ACCOUNT,runId:late.runId,
        fullRawCases:{datasetId:plan.datasetId,split:'holdout',cases:cases.slice(100)},maxRunAttempts:10});
      if(begun.input.cases.length!==200)throw new Error('fixture_cases_changed');
      console.log(JSON.stringify({runId:run.runId,lateRunId:late.runId,settingsHash:hashContext(settings)}));
    } finally {await db.close()}
  `
  const initialized = await launch(process.execPath, ['--input-type=module', '-e', setup], {
    cwd: release,
    env: config,
    timeout: 4000
  }).result
  check(
    initialized.code === 0 && !initialized.failure && initialized.stderr.trim() === '',
    'release_calibration_fixture_failed'
  )
  const prepared = JSON.parse(initialized.stdout)
  const command = async (
    out,
    settings = 'settings.private.json',
    runId = prepared.runId,
    expectedCode = 0
  ) => {
    const result = await launch(
      process.execPath,
      [
        join(release, 'server', 'scripts', 'jev-replay.js'),
        'declare',
        '--tenant',
        tenant,
        '--account',
        account,
        '--run',
        runId,
        '--settings',
        `${directory}/${settings}`,
        '--out',
        `${directory}/${out}`
      ],
      { cwd: release, env: config, timeout: 4000 }
    ).result
    check(result.code === expectedCode && !result.failure, 'release_calibration_command_failed')
    if (expectedCode === 0)
      check(result.stderr.trim() === '', 'release_calibration_command_diagnostic_invalid')
    else {
      check(result.stdout.trim() === '', 'release_calibration_rejection_output_invalid')
      const absent = await lstat(join(release, directory, out)).then(
        () => false,
        (error) => error.code === 'ENOENT'
      )
      check(absent, 'release_calibration_rejection_created_output')
    }
  }
  await command('declared')
  await command('retry')
  await command('changed-rejected', 'changed.private.json', prepared.runId, 1)
  await command('late-rejected', 'settings.private.json', prepared.lateRunId, 1)
  const receipt = JSON.parse(
    await readFile(join(release, directory, 'declared', 'declaration-receipt.private.json'), 'utf8')
  )
  const retry = JSON.parse(
    await readFile(join(release, directory, 'retry', 'declaration-receipt.private.json'), 'utf8')
  )
  const stored = (
    await operator.query(
      'SELECT settings_hash,actor_id,login_name,declared_at FROM autoreply.jev_calibration_declarations WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3',
      [tenant, account, prepared.runId]
    )
  ).rows
  check(
    stored.length === 1 &&
      stored[0].login_name === login &&
      receipt.settingsHash === prepared.settingsHash &&
      stored[0].settings_hash === receipt.settingsHash &&
      receipt.candidatePredeclarationVerified === true &&
      receipt.releaseAuthorized === false &&
      JSON.stringify(receipt) === JSON.stringify(retry),
    'release_calibration_record_changed'
  )
  const backends = (
    await operator.query(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=$1',
      [login]
    )
  ).rows[0].n
  check(backends === 0, 'release_calibration_connections_not_closed')
  recorded('actual_compiled_calibration_declaration', {
    ordinaryLogin: true,
    completePlanCases: 300,
    holdoutExecutionCases: 200,
    declaredRecords: 1,
    identicalRetryVerified: true,
    changedSettingsRejected: true,
    lateRegistrationRejected: true,
    missingOutputOnRejection: true,
    databaseBackends: 0,
    modelsCalled: false,
    releaseAuthorized: false
  })
}
