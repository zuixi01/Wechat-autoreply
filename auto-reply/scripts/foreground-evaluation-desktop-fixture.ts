import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Postgres } from '../server/src/database/postgres'
import { EnterpriseLearningWorkerAuthority } from '../server/src/learning/learning-worker-authority'
import { EnterpriseMemoryReplay } from '../server/src/learning/learning-memory-replay'
import { EnterpriseEvaluationEvidence } from '../server/src/learning/learning-evaluation-evidence'
import { EnterpriseForegroundEvidence } from '../server/src/learning/learning-foreground-evidence'
import {
  ForegroundEvaluationHost,
  ForegroundEvaluationRuntimeError
} from '../src/main/services/foreground-evaluation-host'
import {
  DesktopAgentRuntime,
  type RuntimePlatform
} from '../src/main/services/desktop-agent-runtime'
import { Ledger } from '../src/core/persistence/ledger'
import { SyntheticCollectionSource } from '../tests/fixtures/collection'
import { registerRuntimeWorkbenchIpc } from '../src/main/ipc/agent-ipc'
import { createLegacyIpc, rendererTrust } from '../src/main/ipc/trusted-ipc'
import { verifyPrivatePaths } from '../src/core/persistence/private-backup-directory'
import type { Identity } from '../src/shared/contracts/identity'
import type { AgentConfiguration } from '../src/shared/contracts/generation'

// Isolated engineering entry only. The actual reader is synthetic; Electron/PG/HTTP are real.
const root = resolve(process.cwd()),
  report = resolve(process.argv[2]),
  part = relative(join(root, '.local/reports/foreground-evaluation'), report)
if (
  !part ||
  isAbsolute(part) ||
  part === '..' ||
  part.startsWith('..' + sep) ||
  !/^[a-f0-9-]{36}$/.test(part) ||
  process.env.AUTOREPLY_FOREGROUND_EVALUATION_FIXTURE !== '1'
)
  throw new Error('foreground_evaluation_fixture_invalid')
const databaseUrl = new URL(process.env.AUTOREPLY_REPLAY_FIXTURE_DATABASE_URL ?? 'about:blank'),
  loopback = new URL(process.env.AUTOREPLY_REPLAY_FIXTURE_LOOPBACK ?? 'about:blank'),
  reference = process.env.AUTOREPLY_REPLAY_FIXTURE_REFERENCE ?? ''
if (
  databaseUrl.hostname !== '127.0.0.1' ||
  !/^\/replay_[a-f0-9]{32}$/.test(databaseUrl.pathname) ||
  loopback.hostname !== '127.0.0.1' ||
  loopback.protocol !== 'http:' ||
  !/^[a-f0-9-]{36}$/.test(reference)
)
  throw new Error('foreground_evaluation_loopback_required')
app.disableHardwareAcceleration()
app.setPath('userData', join(report, 'user-data'))
let window: BrowserWindow | undefined,
  host: ForegroundEvaluationHost | undefined,
  database: Postgres | undefined,
  collector: EnterpriseMemoryReplay | undefined,
  idle: DesktopAgentRuntime | undefined,
  phase = 'setup',
  http = 0,
  sends = 0,
  presentations = 0
const shots: Promise<void>[] = [],
  nativeFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (new URL(String(url)).origin !== loopback.origin)
    throw new Error('fixture_external_network_denied')
  http++
  return nativeFetch(url, init)
}
const forbidden = async (): Promise<never> => {
  throw new Error('fixture_readonly_operation_denied')
}
async function until(predicate: () => boolean, timeout = 8000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((done) => setTimeout(done, 25))
  }
  throw new Error('foreground_evaluation_fixture_timeout')
}
async function main(): Promise<void> {
  await app.whenReady()
  await verifyPrivatePaths(report, [join(report, 'input.private.json')])
  const input = JSON.parse(await readFile(join(report, 'input.private.json'), 'utf8')),
    configuration: AgentConfiguration = {
      configVersion: 'config-replay',
      knowledgeVersion: 'knowledge-replay',
      decisionPolicyVersion: 'policy-replay',
      questionSetVersion: 'questions-replay',
      modelResolved: 'synthetic-jev',
      automaticEnabled: true
    },
    identity: Identity = {
      tenantId: 'company',
      employeeId: 'employee',
      accountId: 'account-A',
      agentId: 'agent-A',
      platform: 'wework',
      loginEpoch: 7,
      clientInstanceId: 'synthetic-foreground-evaluation'
    },
    scope = {
      tenant_id: 'company',
      employee_id: 'employee',
      account_id: 'account-A',
      agent_id: 'agent-A',
      platform: 'wework' as const
    },
    client = {
      status: () => ({ state: 'registered' as const, scope }),
      acquireLease: async () => {
        const now = Date.now()
        return {
          identity,
          leaseId: 'synthetic-evaluation-lease',
          version: 1,
          serverIssuedAt: now,
          expiresAt: now + 20000
        }
      }
    }
  idle = new DesktopAgentRuntime(new Ledger(join(report, 'idle.sqlite')), {
    ...client,
    configuration: async () => ({ ...configuration, automaticEnabled: false }),
    generateCandidate: forbidden,
    reviewEdited: forbidden,
    issueExecution: forbidden,
    issueHumanExecution: forbidden,
    settleExecution: forbidden
  })
  host = new ForegroundEvaluationHost({
    directory: join(report, 'host'),
    client,
    configuration,
    onRuntime: (runtime) => {
      if (!runtime) return
      const original = runtime.recordPresentation.bind(runtime)
      runtime.recordPresentation = (receipt) => {
        const accepted = original(receipt)
        if (accepted) {
          presentations++
          const file = join(report, `presented-${presentations}.png`)
          shots.push(
            window!.webContents.capturePage().then((pixels) => writeFile(file, pixels.toPNG()))
          )
        }
        return accepted
      }
    },
    platform: (assignment): RuntimePlatform => {
      const source = new SyntheticCollectionSource(identity, 0),
        id = assignment.item.conversationId
      source.entries = [
        {
          binding: {
            identity,
            conversationId: id,
            bindingVersion: 1,
            identityVerified: true,
            identityEvidence: ['synthetic-not-native-attestation']
          },
          displayName: '合成三组客户',
          activityVersion: 'synthetic-activity'
        }
      ]
      source.history.set(id, [])
      for (const value of assignment.item.inbound) source.add(id, value)
      return {
        collectionSource: source,
        capabilities: () => ({ backgroundRead: true, nonInterferingSend: true }),
        binding: async () => ({ identity, conversations: [] }),
        observe: async () => {},
        stop: async () => {},
        readCurrent: forbidden,
        dispatch: async () => {
          sends++
          return forbidden()
        }
      }
    }
  })
  const active = (): DesktopAgentRuntime => host!.currentRuntime() ?? idle!,
    renderer = join(root, 'out/renderer/index.html'),
    trusted = rendererTrust(renderer)
  registerRuntimeWorkbenchIpc(renderer, undefined, active)
  const handlers: Record<string, (input: unknown) => unknown> = {
    'agent:status': () => client.status(),
    'agent:refresh': () => client.status(),
    'admin:status': () => ({ connected: false })
  }
  for (const [channel, handler] of Object.entries(handlers))
    ipcMain.handle(channel, (event, value) => {
      trusted(event)
      return handler(value)
    })
  const legacy = createLegacyIpc(renderer)
  legacy.handle('settings:getAll', () => ({ locale: 'zh', theme: 'dark' }))
  legacy.handle('trace:listSessions', () => [])
  legacy.handle('memory:listCards', () => [])
  legacy.handle('mode:list', () => [])
  const area = screen.getPrimaryDisplay().workArea
  window = new BrowserWindow({
    show: false,
    x: area.x + 10,
    y: area.y + 10,
    width: Math.min(1280, area.width - 20),
    height: Math.min(900, area.height - 20),
    webPreferences: {
      preload: join(root, 'out/preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false
    }
  })
  await window.loadFile(renderer, { query: { window: 'settings', section: 'enterprise' } })
  window.show()
  window.focus()
  await until(() => !!window?.isVisible() && window.isFocused())
  database = new Postgres(databaseUrl.href)
  const authority = new EnterpriseLearningWorkerAuthority(database)
  let runId = ''
  phase = 'three-arms'
  collector = new EnterpriseMemoryReplay(database, authority, {
    text: {
      apiKey: 'synthetic-text-key',
      baseUrl: 'https://synthetic.invalid/v1/',
      model: 'synthetic-text',
      expectedModel: 'synthetic-text'
    },
    jevApiKey: 'synthetic-jev-key',
    workerId: 'synthetic-foreground-engineering',
    onRun: async (id) => {
      runId = id
    },
    foregroundTask: host.foregroundTask,
    foregroundResult: async (assignment, signal) => {
      // Exercise the real workbench hook. Scrolling exposes the actual row; it supplies no
      // presentation nonce, reply body or timing value to the trusted main verifier.
      await Promise.all([
        host!.foregroundResult(assignment, signal),
        window!.webContents.executeJavaScript(`(async()=>{
          const deadline=Date.now()+8000;
          while(Date.now()<deadline){
            const row=[...document.querySelectorAll('[data-workbench-task]')]
              .find(node=>node.dataset.workbenchTask===${JSON.stringify(assignment.task.taskId)});
            const reply=row?.querySelector('[data-workbench-reply]');
            if(reply){reply.scrollIntoView({block:'center'});return;}
            await new Promise(done=>setTimeout(done,25));
          }
          throw new Error('foreground_evaluation_row_missing');
        })()`)
      ])
    },
    fetch: async (url, init) => {
      const address = String(url)
      if (address.startsWith('https://api.typesafe.ai/'))
        return fetch(new URL('/jev', loopback), init)
      if (!address.startsWith('https://synthetic.invalid/v1/'))
        throw new Error('fixture_provider_denied')
      return fetch(new URL('/v1/chat/completions', loopback), init)
    }
  })
  const packet = await collector.collect(reference, input)
  phase = 'original-server-verification'
  const original = await new EnterpriseEvaluationEvidence(database, authority).verify(
    reference,
    runId,
    packet
  )
  const sealed = await host.finish()
  phase = 'original-foreground-verification'
  const linked = await new EnterpriseForegroundEvidence(database, authority).verify(
    reference,
    runId,
    packet,
    { vaultRoot: join(report, 'host/timing-vault'), sessionId: sealed.sessionId }
  )
  await shots.reduce(async (previous, next) => {
    await previous
    await next
  }, Promise.resolve())
  await writeFile(join(report, 'packet.private.json'), JSON.stringify(packet, null, 2) + '\n', {
    flag: 'wx'
  })
  await verifyPrivatePaths(report, [join(report, 'packet.private.json')])
  const passed =
    original.serverFrozenBatchVerified &&
    linked.foregroundVerified &&
    linked.observations.length === 3 &&
    sealed.observations === 3 &&
    presentations === 3 &&
    http === 9 &&
    sends === 0
  await writeFile(
    join(report, 'result.json'),
    JSON.stringify(
      {
        passed,
        phase,
        runId,
        http,
        sends,
        presentations,
        original,
        linked,
        sealed,
        actualForegroundPresentation: presentations === 3,
        nativePlatformVerified: false,
        businessEffectVerified: false,
        electron: process.versions.electron,
        node: process.versions.node
      },
      null,
      2
    ) + '\n'
  )
  if (!passed) throw new Error('foreground_evaluation_fixture_incomplete')
}
void main()
  .then(async () => {
    await collector?.drain()
    await idle?.close()
    await database?.close()
    window?.destroy()
    app.exit(0)
  })
  .catch(async (error) => {
    await writeFile(
      join(report, 'result.json'),
      JSON.stringify(
        {
          passed: false,
          phase,
          code: error instanceof Error ? error.message : 'fixture_failed',
          ...(error instanceof ForegroundEvaluationRuntimeError
            ? { runtime: error.runtimeStatus }
            : {}),
          http,
          sends,
          presentations,
          nativePlatformVerified: false,
          businessEffectVerified: false
        },
        null,
        2
      ) + '\n'
    )
    await collector?.drain().catch(() => {})
    await host?.close().catch(() => {})
    await idle?.close().catch(() => {})
    await database?.close().catch(() => {})
    window?.destroy()
    app.exit(1)
  })
