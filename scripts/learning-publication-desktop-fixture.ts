import { app, BrowserWindow } from 'electron'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { embeddedPostgres } from '../tests/fixtures/embedded-postgres'
import { Administration } from '../server/src/admin/administration'
import { executeAdminCommand, parseAdminCommand } from '../server/src/admin/command'
import { writePrivateAdminOutput } from '../server/scripts/private-admin-output'
import { PublicationSchema } from '../server/src/generation/publication'
import { AccountAuthority } from '../server/src/auth/account-authority'
import { createApplication } from '../server/src/http/application'
import { EnterpriseLearningManagement } from '../server/src/learning/learning-service'
import { AgentRegistration } from '../src/main/services/agent-registration'
import { DesktopAgentRuntime } from '../src/main/services/desktop-agent-runtime'
import { LearningStore } from '../src/core/memory/learning-store'
import { LearningService } from '../src/main/services/learning-service'
import { Ledger } from '../src/core/persistence/ledger'
import { registerLearningIpc } from '../src/main/ipc/learning-ipc'
import { registerLearningSubmissionIpc } from '../src/main/ipc/learning-submission-ipc'
import { createLegacyIpc } from '../src/main/ipc/trusted-ipc'

const root = resolve(process.cwd())
const report = resolve(process.argv[2])
const reportPart = relative(join(root, '.local', 'reports', 'learning-publication'), report)
if (
  !reportPart ||
  isAbsolute(reportPart) ||
  reportPart.startsWith(`..${sep}`) ||
  reportPart === '..'
)
  throw new Error('invalid_fixture_report')
app.disableHardwareAcceleration()
app.setPath('userData', join(report, 'user-data'))
let window: BrowserWindow | undefined
let server: Server | undefined
let postgres: Awaited<ReturnType<typeof embeddedPostgres>> | undefined
let runtime: DesktopAgentRuntime | undefined
let service: LearningService | undefined
let store: LearningStore | undefined
let phase = 'initialize'

async function main(): Promise<void> {
  await app.whenReady()
  postgres = await embeddedPostgres()
  const pg = postgres
  await pg.sql.exec(`CREATE ROLE synthetic_publication_admin LOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT autoreply_admin TO synthetic_publication_admin;
    INSERT INTO tenants(id,name) VALUES('synthetic-company','合成企业');
    INSERT INTO employees(tenant_id,id,role) VALUES('synthetic-company','synthetic-admin','admin');
    INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES('synthetic_publication_admin','synthetic-company','synthetic-admin');`)
  const login = async (name: string): Promise<void> => {
    await pg.sql.exec(
      `SET SESSION AUTHORIZATION postgres; RESET ROLE; SET SESSION AUTHORIZATION ${name}`
    )
  }
  const admin = new Administration(pg.db, 'synthetic-generator-v1')
  await login('synthetic_publication_admin')
  await admin.provision('synthetic-company', {
    employeeId: 'synthetic-employee',
    accountId: 'synthetic-account',
    platform: 'wework'
  })
  const enrollment = await admin.enroll('synthetic-company', 'synthetic-account')
  await login('autoreply_app')
  const authority = new AccountAuthority(pg.db)
  const device = await authority.register(enrollment.enrollmentCode, randomUUID())
  const application = createApplication(authority, {
    learning: new EnterpriseLearningManagement(pg.db, authority)
  })
  server = createServer(application)
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done))
  const serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const client = new AgentRegistration(
    {
      load: () => ({
        serverUrl,
        encryptedCredential: 'synthetic-private-cipher',
        scope: device.scope
      }),
      save: () => {}
    },
    { available: () => true, encrypt: () => '', decrypt: () => device.credential },
    fetch,
    true
  )
  store = new LearningStore(join(report, 'unused-local-memory.sqlite'))
  service = new LearningService(
    store,
    { review: async () => ({ operations: [], usage: { inputTokens: 0, outputTokens: 0 } }) },
    { workspaceId: 'synthetic-local' }
  )
  runtime = new DesktopAgentRuntime(new Ledger(join(report, 'device-ledger.sqlite')), client)
  runtime.configureLearningSubmissions(service)
  const renderer = join(root, 'out', 'renderer', 'index.html')
  registerLearningIpc(
    renderer,
    undefined,
    service,
    () => ({ workspaceId: 'synthetic-local', platform: 'wework' }),
    (scope) => runtime!.learningBackend(scope)
  )
  registerLearningSubmissionIpc(renderer, undefined, runtime)
  // Appearance and legacy trace lists only. Learning data uses the real scoped backend.
  const legacy = createLegacyIpc(renderer, undefined)
  legacy.handle('settings:getAll', () => ({ locale: 'zh', theme: 'dark' }))
  legacy.handle('trace:listSessions', () => [])
  legacy.handle('memory:listCards', () => [])
  legacy.handle('mode:list', () => [])
  window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      preload: join(root, 'out', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false
    }
  })
  await window.loadFile(renderer, { query: { window: 'memory' } })
  phase = 'initial-snapshot-and-teaching'
  const ui = (source: string): Promise<unknown> =>
    window!.webContents.executeJavaScript(`(async()=>{${source}})()`)
  const helpers = `const until=async f=>{const end=Date.now()+12000;while(Date.now()<end){if(await f())return;await new Promise(r=>setTimeout(r,25))}throw new Error('publication_ui_timeout')};
    const panel=()=>document.querySelector('.learning-panel');
    const text=()=>panel()?.querySelector('[aria-label="企业正式发布"]')?.textContent||'';
    const click=async label=>{await until(()=>[...panel().querySelectorAll('button')].some(b=>b.textContent.trim()===label&&!b.disabled));[...panel().querySelectorAll('button')].find(b=>b.textContent.trim()===label&&!b.disabled).click()};
    const fill=(id,value)=>{const e=document.getElementById(id);const proto=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}))};`
  await ui(`${helpers}
    await until(()=>text().includes('尚未正式发布'));
    panel().querySelector('.learning-manual').open=true;
    fill('learning-manual-scenario','合成企业设备询价');fill('learning-manual-guidance','先核对型号和数量，再查询有效资料');fill('learning-manual-reason','合成员工明确教导');
    await click('保存候选方法');await until(()=>panel().textContent.includes('已保存为候选'));
    await click('核对后使 V1 生效');await click('刷新');await until(()=>text().includes('全账号有效方法 1 条'));
    const scope=(await window.learningMemory.snapshot()).scope;
    const receipts=await window.learningSubmissions.submissions({scope});
    if(receipts.length!==1||receipts[0].state!=='saved')throw new Error('enterprise_submission_not_saved');`)
  const at = Date.now()
  phase = 'prepare-publication'
  const template = PublicationSchema.parse({
    configuration: {
      configVersion: 'synthetic-template',
      knowledgeVersion: 'synthetic-knowledge',
      decisionPolicyVersion: 'synthetic-policy',
      questionSetVersion: 'synthetic-questions',
      modelResolved: 'synthetic-model',
      automaticEnabled: false
    },
    policy: {
      version: 'synthetic-policy',
      knowledgeVersion: 'synthetic-knowledge',
      questionSetVersion: 'synthetic-questions',
      modelAlias: 'synthetic-model',
      modelResolved: 'synthetic-model',
      mode: 'shadow',
      evaluationApproved: false,
      automaticIntents: ['faq'],
      minimumChoiceProbability: 0.9,
      minimumChoiceConfidence: 0.8,
      minimumChoiceMargin: 0.3,
      presentIntentProbability: 0.9,
      humanRequestThreshold: 0.2,
      minimumAuditProbability: 0.95,
      reviewValidityMs: 5000,
      preBudgetMs: 1000,
      postBudgetMs: 1000
    },
    textGeneratorVersion: 'synthetic-generator-v1',
    evidence: [
      {
        evidenceId: 'synthetic-faq',
        tenantId: 'synthetic-company',
        knowledgeVersion: 'synthetic-knowledge',
        intent: 'faq',
        kind: 'approved_faq',
        content: '合成有效资料',
        source: '合成来源',
        approvedBy: 'synthetic-business-reviewer',
        validFrom: at - 1000,
        expiresAt: at + 600000
      }
    ]
  })
  // The private writer protects a fresh, empty directory before its first draft byte.
  // The report root already holds fixture/UI artifacts and cannot be used for this.
  const draftPath = join(report, 'private-publication', 'prepared.json')
  await login('synthetic_publication_admin')
  try {
    await executeAdminCommand(
      admin,
      parseAdminCommand([
        'prepare-learning',
        '--tenant',
        'synthetic-company',
        '--account',
        'synthetic-account',
        '--file',
        'synthetic-template',
        '--out',
        draftPath
      ]),
      async () => template,
      writePrivateAdminOutput
    )
  } finally {
    await login('autoreply_app')
  }
  await ui(`${helpers}await click('刷新');await until(()=>text().includes('尚未正式发布'));`)
  const prepared = PublicationSchema.parse(JSON.parse(await readFile(draftPath, 'utf8')))
  phase = 'publish-and-render-v1'
  await login('synthetic_publication_admin')
  try {
    await admin.publish('synthetic-company', 'synthetic-account', prepared)
  } finally {
    await login('autoreply_app')
  }
  await ui(
    `${helpers}await click('刷新');await until(()=>text().includes('正式配置已包含当前有效方法'));if(!text().includes('账号处于暂停状态'))throw new Error('publication_resumed_account');`
  )
  await ui('await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));')
  await writeFile(
    join(report, 'current.png'),
    (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG()
  )
  phase = 'revise-and-render-v2'
  await ui(`${helpers}await click('查看版本与来源');await until(()=>panel().querySelector('.learning-method-edit'));panel().querySelector('.learning-method-edit').open=true;
    fill('learning-revise-guidance','先核对型号、数量和用途，再查询有效资料');fill('learning-revise-reason','合成员工补充用途');await click('保存修订候选');await until(()=>panel().textContent.includes('修订已保存为候选'));
    await click('核对后使 V2 生效');await click('刷新');await until(()=>text().includes('方法已变化，需要重新准备并发布'));`)
  await ui('await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));')
  await writeFile(
    join(report, 'outdated.png'),
    (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG()
  )
  await login('synthetic_publication_admin')
  try {
    phase = 'reject-stale-and-republish'
    let rejected = false
    try {
      await admin.publish('synthetic-company', 'synthetic-account', prepared)
    } catch (error) {
      rejected = error instanceof Error && error.message === 'TASK_CONFLICT'
    }
    if (!rejected) throw new Error('stale_publication_not_rejected')
    const fresh = await admin.prepareLearningPublication(
      'synthetic-company',
      'synthetic-account',
      template
    )
    await admin.publish('synthetic-company', 'synthetic-account', fresh.publication)
  } finally {
    await login('autoreply_app')
  }
  await ui(
    `${helpers}await click('刷新');await until(()=>text().includes('正式配置已包含当前有效方法'));`
  )
  await writeFile(
    join(report, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        provenance: 'synthetic-engineering-fixture',
        businessEffectVerified: false,
        automaticSendingEnabled: false,
        actualElectron: true,
        actualHttp: true,
        embeddedPostgres: true,
        scenarios: [
          'durable-enterprise-teaching',
          'prepare-does-not-publish',
          'administrator-publication-visible',
          'v2-requires-republication',
          'stale-draft-rejected',
          'fresh-publication-visible'
        ]
      },
      null,
      2
    )
  )
  process.stdout.write(JSON.stringify({ passed: true, report, scenarios: 6 }) + '\n')
}

main()
  .then(async () => {
    await cleanup()
    app.exit(0)
  })
  .catch(async (error: unknown) => {
    // Do not print raw database, IPC or private draft errors.
    await writeFile(
      join(report, 'result.json'),
      JSON.stringify({
        passed: false,
        code: 'PUBLICATION_DESKTOP_FAILED',
        phase,
        reason:
          error instanceof Error &&
          [
            'private_backup_permissions_invalid',
            'private_admin_output_required',
            'TASK_CONFLICT'
          ].includes(error.message)
            ? error.message
            : error instanceof Error && error.message.includes('publication_ui_timeout')
              ? 'publication_ui_timeout'
              : 'operation_failed',
        provenance: 'synthetic-engineering-fixture'
      })
    )
    if (window && !window.isDestroyed())
      await writeFile(
        join(report, 'failed.png'),
        (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG()
      ).catch(() => {})
    process.stderr.write(
      JSON.stringify({ passed: false, report, code: 'PUBLICATION_DESKTOP_FAILED' }) + '\n'
    )
    await cleanup()
    app.exit(1)
  })

async function cleanup(): Promise<void> {
  window?.destroy()
  await runtime?.close()
  await service?.shutdown()
  store?.close()
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((done) => server!.close(() => done()))
  }
  await postgres?.db.close()
}
