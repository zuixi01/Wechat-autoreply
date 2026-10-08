import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { Ledger } from '../src/core/persistence/ledger'
import {
  DesktopAgentRuntime,
  type RuntimePlatform
} from '../src/main/services/desktop-agent-runtime'
import { registerWorkbenchPresentationIpc } from '../src/main/ipc/workbench-presentation-ipc'
import { registerRestorationIpc } from '../src/main/ipc/restoration-ipc'
import { createLegacyIpc, rendererTrust } from '../src/main/ipc/trusted-ipc'
import { hashContext, hashDraft } from '../src/core/reply/hashes'
import { taskFixture } from '../tests/fixtures/task'
import { SyntheticCollectionSource } from '../tests/fixtures/collection'
import type { RuntimePresentationReceipt } from '../src/core/agent/runtime-timing'
import type { WorkbenchPresentationCapture } from '../src/main/services/workbench-presentation-capture'
import type { RuntimeTimingEvidenceReport } from '../src/core/agent/runtime-timing-evidence'

const root = resolve(process.cwd()),
  report = resolve(process.argv[2]),
  part = relative(join(root, '.local/reports/workbench-presentation'), report)
if (
  !part ||
  isAbsolute(part) ||
  part === '..' ||
  part.startsWith('..' + sep) ||
  !/^[a-f0-9-]{36}$/.test(part) ||
  process.env.AUTOREPLY_PRESENTATION_FIXTURE !== '1'
)
  throw new Error('presentation_fixture_path_invalid')
app.disableHardwareAcceleration()
app.setPath('userData', join(report, 'user-data'))
let window: BrowserWindow | undefined,
  runtime: DesktopAgentRuntime | undefined,
  capture: WorkbenchPresentationCapture | undefined,
  phase = 'setup',
  network = 0,
  sends = 0
const receipts: RuntimePresentationReceipt[] = []
const ticketChecks: unknown[] = []
globalThis.fetch = async () => {
  network++
  throw new Error('presentation_unexpected_network')
}
async function until(predicate: () => boolean, milliseconds = 8000): Promise<void> {
  const expires = Date.now() + milliseconds
  while (Date.now() < expires) {
    if (predicate()) return
    await new Promise((done) => setTimeout(done, 30))
  }
  throw new Error('presentation_fixture_timeout')
}
async function main(): Promise<void> {
  await app.whenReady()
  const f = taskFixture(),
    identity = f.task.identity,
    source = new SyntheticCollectionSource(identity, 1),
    configuration = {
      configVersion: f.task.configVersion,
      knowledgeVersion: f.task.knowledgeVersion,
      decisionPolicyVersion: f.task.decisionPolicyVersion,
      questionSetVersion: f.task.questionSetVersion,
      modelResolved: 'synthetic-presentation-model',
      automaticEnabled: false
    }
  source.add('customer-0', 'SYNTHETIC_CUSTOMER_SECRET：请核对订单。')
  const forbidden = async (): Promise<never> => {
    throw new Error('presentation_operation_forbidden')
  }
  const client: ConstructorParameters<typeof DesktopAgentRuntime>[1] = {
    status: () => ({
      state: 'registered',
      scope: {
        tenant_id: identity.tenantId,
        employee_id: identity.employeeId,
        account_id: identity.accountId,
        agent_id: identity.agentId,
        platform: identity.platform
      }
    }),
    configuration: async () => configuration,
    generateCandidate: async (input) => ({
      task: input.task,
      status: 'handoff',
      automaticAllowed: false,
      factsVerified: false,
      reasons: ['shadow_mode'],
      intents: ['faq'],
      usage: { input_tokens: 0, output_tokens: 0 },
      draft: {
        taskId: input.task.taskId,
        draftRevision: 1,
        action: 'clarify',
        text: 'SYNTHETIC_REPLY_SECRET：请提供订单号。',
        draftHash: hashDraft('SYNTHETIC_REPLY_SECRET：请提供订单号。'),
        evidenceIds: []
      }
    }),
    acquireLease: async () => {
      const now = Date.now()
      return {
        identity,
        leaseId: 'synthetic-presentation-lease',
        version: 1,
        serverIssuedAt: now,
        expiresAt: now + 20000
      }
    },
    issueExecution: forbidden,
    issueHumanExecution: forbidden,
    reviewEdited: forbidden,
    settleExecution: forbidden
  }
  const platform: RuntimePlatform = {
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
  let ready = false
  const ledger = new Ledger(join(report, 'ledger.sqlite'))
  runtime = new DesktopAgentRuntime(ledger, client, platform, (event) => {
    if (event.kind === 'agent' && event.event.stage === 'candidate_ready') {
      const task = event.event.task
      runtime!.bindTimingEvaluation(task, {
        batchId: 'synthetic-presentation-only',
        assignmentId: randomUUID(),
        caseId: 'synthetic-case',
        arm: 'learned',
        expectedTaskHash: hashContext(task),
        sharedConfigurationHash: 'a'.repeat(64),
        memoryManifestHash: 'b'.repeat(64),
        policyVersion: 'synthetic-policy',
        retrievalVersion: 'synthetic-retrieval',
        modelVersion: 'synthetic-model-version',
        knowledgeVersion: task.knowledgeVersion,
        modelResolved: configuration.modelResolved
      })
      ready = true
    }
    if (event.kind === 'presentation') receipts.push(event.event)
  })
  await runtime.configureManagedTimingCapture(join(report, 'timing-vault'))
  if ((await runtime.start()).state !== 'running')
    throw new Error('presentation_runtime_not_started')
  await until(() => ready)
  const initialRow = runtime.workbench().rows[0],
    initialRecord = initialRow && ledger.replies.get(identity, initialRow.taskId)
  await writeFile(
    join(report, 'target-preflight.json'),
    JSON.stringify(
      {
        state: runtime.status().state,
        rowStatus: initialRow?.status,
        targetAvailable:
          initialRow &&
          Boolean(
            runtime.presentationTarget({
              taskId: initialRow.taskId,
              expectedVersion: initialRow.version
            })
          ),
        recordRevision: initialRecord?.task.conversationRevision,
        conversationRevision:
          initialRecord &&
          ledger.conversationState(identity, initialRecord.task.conversationId).revision,
        edited: initialRecord?.edited ?? false
      },
      null,
      2
    ) + '\n'
  )
  const renderer = join(root, 'out/renderer/index.html'),
    trusted = rendererTrust(renderer)
  capture = registerWorkbenchPresentationIpc(renderer, undefined, runtime)
  const issue = capture.issue.bind(capture)
  capture.issue = (input, surface) => {
    const result = issue(input, surface),
      frame = window?.webContents.mainFrame
    if (ticketChecks.length < 64)
      ticketChecks.push({
        phase,
        available: result.available,
        visible: surface.visible(),
        targetAvailable: Boolean(runtime!.presentationTarget(input)),
        windowVisible: window?.isVisible(),
        focused: window?.isFocused(),
        minimized: window?.isMinimized(),
        ownerMatches: window?.webContents.id === surface.owner,
        documentMatches:
          !!frame && `${frame.processId}:${frame.routingId}:${frame.url}` === surface.document
      })
    return result
  }
  registerRestorationIpc(renderer, undefined, runtime)
  const handlers: Record<string, (input: unknown) => unknown> = {
    'agent:status': () => client.status(),
    'agent:refresh': () => client.status(),
    'agent-runtime:status': () => runtime!.status(),
    'agent-runtime:start': () => runtime!.start(),
    'agent-runtime:pause': () => runtime!.pause(),
    'agent-runtime:synchronize': () => runtime!.synchronize(),
    'agent-workbench:snapshot': () => runtime!.workbench(),
    'admin:status': () => ({ connected: false })
  }
  for (const [channel, handler] of Object.entries(handlers))
    ipcMain.handle(channel, (event, input: unknown) => {
      trusted(event)
      return handler(input)
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
  const ui = (code: string): Promise<unknown> =>
    window!.webContents.executeJavaScript(`(async()=>{${code}})()`)
  phase = 'hidden-window'
  const hidden = (await ui(`const row=(await window.agentWorkbench.snapshot()).rows[0];
    const ticket=await window.agentWorkbench.presentationTicket({taskId:row.taskId,expectedVersion:row.version});
    const forged=await window.agentWorkbench.presentationAck({nonce:${JSON.stringify(randomUUID())},atMs:1});
    let privateBridgeBlocked=false;
    try{await window.electron.invoke('agent-workbench:presentation-ack',{});}catch{privateBridgeBlocked=true;}
    return {hiddenRejected:ticket.available===false,forgedRejected:forged.accepted===false,privateBridgeBlocked};`)) as {
    hiddenRejected: boolean
    forgedRejected: boolean
    privateBridgeBlocked: boolean
  }
  if (
    !hidden.hiddenRejected ||
    !hidden.forgedRejected ||
    !hidden.privateBridgeBlocked ||
    receipts.length
  )
    throw new Error('presentation_hidden_not_rejected')
  await ui(`const cover=document.createElement('div');cover.id='synthetic-presentation-cover';
    cover.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#111;color:white';
    cover.textContent='合成工作台显示验收';document.body.append(cover);`)
  phase = 'occluded-visible-row'
  window.show()
  window.focus()
  await until(() => !!window?.isFocused() && window.isVisible())
  const occluded = (await ui(`const deadline=Date.now()+5000;
    while(!document.querySelector('[data-workbench-task]')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
    const node=document.querySelector('[data-workbench-task]');
    if(!node)throw new Error('presentation_row_missing');
    node.querySelector('[data-workbench-reply]').scrollIntoView({block:'center'});
    const row=(await window.agentWorkbench.snapshot()).rows[0];
    const ticket=await window.agentWorkbench.presentationTicket({taskId:row.taskId,expectedVersion:row.version});
    if(!ticket.available)throw new Error('presentation_ticket_missing');
    node.dataset.workbenchPresentation=ticket.nonce;
    const result=await window.agentWorkbench.presentationAck({nonce:ticket.nonce});
    delete node.dataset.workbenchPresentation;return result;`)) as { accepted: boolean }
  if (occluded.accepted || receipts.length) throw new Error('presentation_occluded_accepted')
  phase = 'hidden-after-ticket'
  window.show()
  window.focus()
  await until(() => !!window?.isFocused() && window.isVisible())
  const ticket = (await ui(`const row=(await window.agentWorkbench.snapshot()).rows[0];
    return window.agentWorkbench.presentationTicket({taskId:row.taskId,expectedVersion:row.version});`)) as {
    available: boolean
    nonce?: string
  }
  if (!ticket.available || !ticket.nonce) throw new Error('presentation_ticket_missing')
  window.hide()
  const hiddenAck = (await ui(
    `return window.agentWorkbench.presentationAck({nonce:${JSON.stringify(ticket.nonce)}});`
  )) as { accepted: boolean }
  if (hiddenAck.accepted || receipts.length) throw new Error('presentation_hidden_ack_accepted')
  phase = 'actual-visible-row'
  window.show()
  window.focus()
  await until(() => !!window?.isFocused() && window.isVisible())
  await ui(`const deadline=Date.now()+5000;
    while(!document.querySelector('[data-workbench-task]')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
    const row=document.querySelector('[data-workbench-task]');
    if(!row)throw new Error('presentation_row_missing');
    document.getElementById('synthetic-presentation-cover').remove();
    row.querySelector('[data-workbench-reply]').scrollIntoView({block:'center'});`)
  await until(() => receipts.length === 1)
  await writeFile(
    join(report, 'visible-workbench.png'),
    (await window.webContents.capturePage()).toPNG()
  )
  window.hide()
  phase = 'sealed-evidence'
  await runtime.close()
  const path = await runtime.exportTimingEvidence(),
    evidence = JSON.parse(await readFile(path, 'utf8')) as RuntimeTimingEvidenceReport
  if (
    evidence.status !== 'captured' ||
    evidence.tasks.length !== 1 ||
    !evidence.tasks[0].latencyComplete ||
    evidence.tasks[0].presentation?.receiptId !== receipts[0].receiptId ||
    evidence.tasks[0].endedAtMs !== receipts[0].atMs ||
    evidence.businessVerified !== false ||
    evidence.health.pending ||
    evidence.health.dropped ||
    !evidence.health.closed ||
    sends ||
    network
  )
    throw new Error('presentation_evidence_unconfirmed')
  const log = await readFile(join(resolve(path, '..'), 'events.private.jsonl'), 'utf8')
  if (log.includes('SYNTHETIC_CUSTOMER_SECRET') || log.includes('SYNTHETIC_REPLY_SECRET'))
    throw new Error('presentation_body_leaked')
  await writeFile(
    join(report, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        provenance: 'synthetic-engineering-fixture',
        businessEffectVerified: false,
        actualElectron: true,
        actualForegroundPresentation: true,
        serviceFrozenBatchVerified: false,
        nativePlatformVerified: false,
        endpoint: 'reviewable',
        hidden,
        hiddenAckRejected: true,
        occludedAckRejected: true,
        displayedReceipts: receipts.length,
        networkAttempts: network,
        sends,
        evidencePath: path,
        latencyMs: evidence.tasks[0].latencyMs,
        preservedAfterShutdown: true,
        privateJournalHasNoBodies: true,
        electron: process.versions.electron,
        node: process.versions.node
      },
      null,
      2
    ) + '\n'
  )
  process.stdout.write(
    JSON.stringify({ passed: true, report, provenance: 'synthetic-engineering-fixture' }) + '\n'
  )
}
async function cleanup(): Promise<void> {
  capture?.close()
  await runtime?.close()
  if (window && !window.isDestroyed()) window.destroy()
}
main()
  .then(async () => {
    await cleanup()
    app.exit(0)
  })
  .catch(async (error) => {
    const code =
      error instanceof Error && /^[a-z_]{1,80}$/.test(error.message)
        ? error.message
        : 'presentation_desktop_failed'
    await mkdir(report, { recursive: true })
    await writeFile(
      join(report, 'result.json'),
      JSON.stringify({
        passed: false,
        phase,
        code,
        provenance: 'synthetic-engineering-fixture',
        businessEffectVerified: false
      }) + '\n'
    )
    await writeFile(
      join(report, 'ticket-checks.json'),
      JSON.stringify(ticketChecks, null, 2) + '\n'
    )
    process.stderr.write(JSON.stringify({ passed: false, report, phase, code }) + '\n')
    await cleanup()
    app.exit(1)
  })
