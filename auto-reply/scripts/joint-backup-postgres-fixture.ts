import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { Ledger } from '../src/core/persistence/ledger'
import { KnowledgeStore } from '../src/core/knowledge/knowledge-store'
import { LearningStore } from '../src/core/memory/learning-store'
import {
  createJointBackup,
  stageJointRestore,
  verifyJointBackup
} from '../src/core/persistence/joint-backup'
import {
  createPostgresCentralArchive,
  importPostgresArchive,
  validatePostgresArchiveList
} from '../src/core/persistence/postgres-archive'
import { restoreCentralDatabase } from '../server/src/recovery/central-restoration'
import { tokenHash, AccountAuthority } from '../server/src/auth/account-authority'
import { Postgres } from '../server/src/database/postgres'

const execute = promisify(execFile)
let phase = 'setup'
let archiveFailure: string | null = null
async function docker(args: string[]): Promise<string> {
  try {
    return (
      await execute('docker', args, {
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024
      })
    ).stdout
  } catch {
    throw new Error('joint_postgres_fixture_command_failed')
  }
}
async function main(): Promise<void> {
  const container = process.env.AUTOREPLY_JOINT_CONTAINER,
    uri = process.env.AUTOREPLY_JOINT_URL,
    report = process.env.AUTOREPLY_JOINT_REPORT
  assert(container && /^autoreply-joint-[a-f0-9-]{36}$/.test(container) && uri && report)
  const url = new URL(uri)
  assert(url.hostname === '127.0.0.1' && /^\/autoreply_joint_[a-f0-9]{32}$/.test(url.pathname))
  const pool = new Pool({ connectionString: uri, max: 1 }),
    sourceDatabase = url.pathname.slice(1)
  let recovered: Pool | undefined
  const centralPools: Pool[] = []
  try {
    assert.equal(
      (await pool.query("SELECT 1 FROM pg_namespace WHERE nspname='autoreply'")).rowCount,
      0
    )
    const migrations = (await readdir(resolve('server/migrations')))
      .filter((p) => /^\d{3}-.+\.sql$/.test(p))
      .sort()
    for (const name of migrations) {
      phase = `migration:${name}`
      await pool.query(await readFile(resolve('server/migrations', name), 'utf8'))
    }
    phase = 'seed'
    await pool.query(`SET search_path=autoreply,public;
      INSERT INTO tenants VALUES('fixture-a','Business A'),('fixture-b','Business B');
      INSERT INTO employees VALUES('fixture-a','employee','employee',true),('fixture-b','employee','employee',true);
      INSERT INTO accounts VALUES('fixture-a','account','employee','wechat',true,false),('fixture-b','account','employee','wework',true,false);
      INSERT INTO audit_events(tenant_id,id,actor_id,kind,account_id) VALUES('fixture-a','audit-a','employee','backup_fixture','account'),('fixture-b','audit-b','employee','backup_fixture','account');
      INSERT INTO generation_publications(tenant_id,account_id,config_version,publication_hash,config_json,policy_json,evidence_json,text_generator_version)
        VALUES('fixture-a','account','config-v1','fixture-hash','{"business":"private-product-rules"}','{"decision":"jev"}','[{"id":"product-1","text":"fixture-knowledge"}]','fixture-model');
      INSERT INTO learning_memories(tenant_id,account_id,id,state,current_revision,created_at,updated_at)
        VALUES('fixture-a','account','00000000-0000-4000-8000-000000000001','pending',1,1000,1000);
      INSERT INTO learning_revisions(tenant_id,account_id,memory_id,revision,content_hash,payload)
        VALUES('fixture-a','account','00000000-0000-4000-8000-000000000001',1,'fixture-hash','{"method":"fixture-learning-method"}');`)
    phase = 'local-profile'
    const oldToken = 'A'.repeat(43),
      oldCode = 'B'.repeat(43)
    if (process.env.AUTOREPLY_CENTRAL_RESTORE_TEST === '1') {
      await pool.query(
        `INSERT INTO autoreply.agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('fixture-a','old-agent','account','employee',$1)`,
        [tokenHash(oldToken)]
      )
      await pool.query(
        `INSERT INTO autoreply.execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status) VALUES('fixture-a','account','unresolved-before-backup','old-agent',1,'old-task','old-draft','unknown')`
      )
      await pool.query(
        `INSERT INTO autoreply.account_leases VALUES('fixture-a','account','old-agent',1,'old-client',1,clock_timestamp()+interval '1 hour')`
      )
      await pool.query(
        `INSERT INTO autoreply.enrollment_codes(code_hash,tenant_id,account_id,employee_id,expires_at) VALUES($1,'fixture-a','account','employee',clock_timestamp()+interval '1 hour')`,
        [tokenHash(oldCode)]
      )
    }
    // Owned private output: do not weaken Windows ACLs to accommodate a public workspace volume.
    const artifacts = await mkdtemp(join(tmpdir(), 'autoreply-joint-pg-'))
    const profile = join(artifacts, 'profile')
    await mkdir(join(profile, 'agent'), { recursive: true })
    await mkdir(join(profile, 'knowledge'))
    await mkdir(join(profile, 'worktrace', 'memory'), { recursive: true })
    await writeFile(join(profile, 'settings.json'), '{"globalAutoReply":true,"modes":[]}')
    const ledger = new Ledger(join(profile, 'agent', 'ledger.sqlite'))
    ledger.close()
    const knowledge = new KnowledgeStore(join(profile, 'knowledge', 'knowledge.sqlite'))
    knowledge.close()
    const learning = new LearningStore(join(profile, 'worktrace', 'memory', 'learning.sqlite'))
    learning.close()
    const tools = createPostgresCentralArchive({
      dump: {
        executable: 'docker',
        prefix: [
          'exec',
          '--env',
          `PGDATABASE=${sourceDatabase}`,
          '--env',
          'PGUSER=postgres',
          container,
          'pg_dump'
        ]
      },
      restore: { executable: 'pg_restore' }
    })
    const archivePath = `/tmp/joint-${randomUUID()}.dump`
    const central = {
      exportTo: async (file: string) => {
        phase = 'central-export'
        try {
          return await tools.exportTo(file)
        } catch (error) {
          archiveFailure =
            error instanceof Error && /^postgres_archive_[a-z_]+$/.test(error.message)
              ? error.message
              : 'validation_failed'
          throw error
        }
      },
      inspect: async (file: string): Promise<void> => {
        phase = 'central-inspect'
        await docker(['cp', file, `${container}:${archivePath}`])
        phase = 'central-inspect-list'
        validatePostgresArchiveList(
          await docker(['exec', container, 'pg_restore', '--list', archivePath])
        )
        phase = 'central-inspect-complete'
      }
    }
    phase = 'joint-backup'
    const saved = await createJointBackup(profile, join(artifacts, 'backups'), central)
    assert.deepEqual(await verifyJointBackup(saved.directory, central), saved.manifest)
    phase = 'staged-restore'
    const staging = await stageJointRestore(saved.directory, join(artifacts, 'staged'), central)
    assert.equal(staging.readyForProfile, false)
    const restoredLedger = new Ledger(join(artifacts, 'staged', 'ledger', 'ledger.sqlite'))
    try {
      assert.equal(restoredLedger.requiresRestoreReview(), true)
    } finally {
      restoredLedger.close()
    }
    phase = 'isolated-postgres-restore'
    const target = `isolated_restore_${randomUUID().replaceAll('-', '')}`
    await pool.query(`CREATE DATABASE "${target}"`)
    await pool.query(`REVOKE CONNECT ON DATABASE "${target}" FROM PUBLIC`)
    for (const role of [
      'autoreply_app',
      'autoreply_admin',
      'autoreply_learning_worker',
      'autoreply_restore_reader'
    ])
      assert.equal(
        (
          await pool.query("SELECT has_database_privilege($1,$2,'CONNECT') AS allowed", [
            role,
            target
          ])
        ).rows[0].allowed,
        false
      )
    await docker([
      'exec',
      container,
      'pg_restore',
      '--single-transaction',
      '--exit-on-error',
      '--no-owner',
      '--no-privileges',
      '--no-password',
      '-U',
      'postgres',
      '-d',
      target,
      archivePath
    ])
    const restoredUrl = new URL(uri)
    restoredUrl.pathname = '/' + target
    recovered = new Pool({ connectionString: restoredUrl.href, max: 1 })
    phase = 'all-table-comparison'
    const tables = (
      await pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='autoreply' ORDER BY tablename"
      )
    ).rows.map((r) => String(r.tablename))
    for (const table of tables) {
      assert(/^[a-z_]+$/.test(table))
      const query = `SELECT count(*)::text AS count,md5(COALESCE(string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text),'')) AS digest FROM autoreply."${table}" t`
      assert.deepEqual(
        (await recovered.query(query)).rows,
        (await pool.query(query)).rows,
        `round-trip:${table}`
      )
    }
    assert.equal(
      (await recovered.query('SELECT count(*)::int AS n FROM autoreply.accounts')).rows[0].n,
      2
    )
    assert.equal(
      (await recovered.query('SELECT config_json FROM autoreply.generation_publications')).rows[0]
        .config_json.business,
      'private-product-rules'
    )
    assert.equal(
      (await recovered.query('SELECT payload FROM autoreply.learning_revisions')).rows[0].payload
        .method,
      'fixture-learning-method'
    )
    assert.equal(
      (
        await recovered.query(
          "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='autoreply' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity"
        )
      ).rows[0].n,
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='autoreply' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity"
        )
      ).rows[0].n
    )
    let centralRestore = null
    if (process.env.AUTOREPLY_CENTRAL_RESTORE_TEST === '1') {
      phase = 'central-restoration-orchestrator'
      const maintenance = {
        cluster: pool,
        centralArchive: central,
        connectDatabase: async (database: string) => {
          const connection = new URL(uri)
          connection.pathname = '/' + database
          const targetPool = new Pool({ connectionString: connection.href, max: 1 })
          centralPools.push(targetPool)
          return targetPool.connect()
        },
        importArchive: async (database: string, file: string): Promise<void> => {
          await docker(['cp', file, `${container}:${archivePath}`])
          await importPostgresArchive(
            {
              executable: 'docker',
              prefix: ['exec', '--env', 'PGUSER=postgres', container, 'pg_restore']
            },
            database,
            archivePath
          )
        }
      }
      const restored = await restoreCentralDatabase(
        saved.directory,
        join(artifacts, 'central-restored'),
        maintenance
      )
      assert.equal(restored.canRelease, false)
      assert.equal(restored.receipt.counts.unresolvedPermits, 1)
      const restoredUrl = new URL(uri)
      restoredUrl.pathname = '/' + restored.databaseName
      const control = new Pool({ connectionString: restoredUrl.href, max: 1 })
      centralPools.push(control)
      const changedByQuarantine = new Set([
        'accounts',
        'agents',
        'account_leases',
        'learning_background_leases',
        'enrollment_codes',
        'audit_events',
        'database_restore_quarantines'
      ])
      const preservedTables = tables.filter((table) => !changedByQuarantine.has(table))
      for (const table of preservedTables) {
        const query = `SELECT count(*)::text AS count,md5(COALESCE(string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text),'')) AS digest FROM autoreply."${table}" t`
        assert.deepEqual(
          (await control.query(query)).rows,
          (await pool.query(query)).rows,
          `quarantine-preserves:${table}`
        )
      }
      assert.deepEqual(
        (
          await control.query(
            'SELECT row_to_json(p) AS data FROM autoreply.execution_permits p ORDER BY id'
          )
        ).rows,
        (
          await pool.query(
            'SELECT row_to_json(p) AS data FROM autoreply.execution_permits p ORDER BY id'
          )
        ).rows
      )
      assert.equal(
        (await control.query('SELECT count(*)::int AS n FROM autoreply.accounts WHERE NOT paused'))
          .rows[0].n,
        0
      )
      assert.equal(
        (
          await control.query(
            'SELECT count(*)::int AS n FROM autoreply.agents WHERE revoked_at IS NULL'
          )
        ).rows[0].n,
        0
      )
      assert.equal(
        (
          await control.query(
            'SELECT count(*)::int AS n FROM autoreply.account_leases WHERE expires_at>clock_timestamp()'
          )
        ).rows[0].n,
        0
      )
      await assert.rejects(
        control.query("UPDATE autoreply.accounts SET paused=false WHERE id='account'"),
        /central_restore_review_pending/
      )
      await assert.rejects(
        control.query(
          "UPDATE autoreply.account_leases SET expires_at=clock_timestamp()+interval '1 minute'"
        ),
        /central_restore_review_pending/
      )
      await assert.rejects(
        control.query("UPDATE autoreply.execution_permits SET status='issued'"),
        /central_restore_review_pending/
      )
      await pool.query(
        'CREATE ROLE fixture_restore_app LOGIN NOSUPERUSER NOBYPASSRLS; GRANT autoreply_app TO fixture_restore_app'
      )
      assert.equal(
        (
          await pool.query(
            "SELECT has_database_privilege('fixture_restore_app',$1,'CONNECT') AS allowed",
            [restored.databaseName]
          )
        ).rows[0].allowed,
        false
      )
      // Temporarily allow only this synthetic login to prove SQL guards after maintenance isolation.
      await pool.query(
        `GRANT CONNECT ON DATABASE "${restored.databaseName}" TO fixture_restore_app`
      )
      await control.query(
        'GRANT USAGE ON SCHEMA autoreply TO fixture_restore_app; GRANT EXECUTE ON FUNCTION autoreply.authenticate_device(text),autoreply.redeem_enrollment(text,text,text) TO fixture_restore_app'
      )
      const app = new Pool({
        connectionString: restoredUrl.href,
        options: '-c role=fixture_restore_app',
        max: 1
      })
      centralPools.push(app)
      const authority = new AccountAuthority({ pool: app } as unknown as Postgres)
      await assert.rejects(
        authority.authenticate(oldToken),
        (e: unknown) => e instanceof Error && e.message === 'DENIED'
      )
      await assert.rejects(
        authority.register(oldCode, randomUUID()),
        (e: unknown) => e instanceof Error && e.message === 'DENIED'
      )
      await pool.query(
        `REVOKE CONNECT ON DATABASE "${restored.databaseName}" FROM fixture_restore_app`
      )
      await assert.rejects(
        restoreCentralDatabase(saved.directory, join(artifacts, 'central-restored'), maintenance),
        /central_restore_target_exists/
      )
      phase = 'central-import-failure'
      const failedTarget = join(artifacts, 'central-failed')
      await assert.rejects(
        restoreCentralDatabase(saved.directory, failedTarget, {
          ...maintenance,
          importArchive: async () => {
            throw new Error('PRIVATE_PROVIDER_DIAGNOSTIC')
          }
        }),
        /central_restore_failed/
      )
      const failedAttempt = JSON.parse(await readFile(join(failedTarget, 'attempt.json'), 'utf8'))
      await assert.rejects(
        readFile(join(failedTarget, 'restore-receipt.json')),
        (e: unknown) => typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT'
      )
      assert.equal(
        (
          await pool.query(
            "SELECT has_database_privilege('fixture_restore_app',$1,'CONNECT') AS allowed",
            [failedAttempt.databaseName]
          )
        ).rows[0].allowed,
        false
      )
      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM autoreply.accounts WHERE NOT paused'))
          .rows[0].n,
        2
      )
      centralRestore = {
        passed: true,
        databaseName: restored.databaseName,
        unknownHistoryUnchanged: true,
        unchangedBusinessTableCount: preservedTables.length,
        unchangedBusinessTableDigestsEqual: true,
        allAccountsPaused: true,
        oldCredentialsDenied: true,
        oldEnrollmentDenied: true,
        directSqlAdmissionDenied: true,
        existingTargetPreserved: true,
        failedImportNoReceipt: true,
        failedDatabaseRestricted: true,
        originalDatabaseUntouched: true,
        canRelease: false
      }
    }
    await writeFile(
      join(report, 'fixture-result.json'),
      JSON.stringify(
        {
          passed: true,
          centralRestore,
          migrations: migrations.length,
          tablesCompared: tables.length,
          multiTenantRows: 2,
          fullRowDigestsEqual: true,
          rowSecurityPreserved: true,
          normalRolesCannotConnect: true,
          ledgerFence: true,
          archiveId: saved.manifest.id,
          artifactDirectory: artifacts,
          archiveToolVersion: saved.manifest.centralToolVersion,
          realChatReads: 0,
          realMessagesSent: 0,
          providerCalls: 0,
          releaseReady: false
        },
        null,
        2
      )
    )
  } finally {
    await recovered?.end()
    await Promise.allSettled(centralPools.map((p) => p.end()))
    await pool.end()
  }
}
main().catch(async (error: unknown) => {
  const cause =
    error instanceof Error &&
    error.cause instanceof Error &&
    /^[a-zA-Z0-9_]+$/.test(error.cause.message)
      ? error.cause.message
      : null
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  if (process.env.AUTOREPLY_JOINT_REPORT)
    await writeFile(
      join(process.env.AUTOREPLY_JOINT_REPORT, 'fixture-failure.json'),
      JSON.stringify({
        phase,
        code: /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'validation_failed',
        archiveFailure,
        cause
      })
    )
  process.stderr.write('joint_postgres_fixture_failed\n')
  process.exitCode = 1
})
