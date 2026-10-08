// Run with the project's Electron binary after building. No native client automation.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- Electron's CJS bootstrap sets an isolated profile before synchronously loading the real CJS entry; this JavaScript harness has no TS signature syntax. */
const { app, ipcMain } = require('electron')
const { join, resolve } = require('node:path')
const { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
// Diagnostic mode affects this isolated harness only, never the employee app.
if (process.env.AUTOREPLY_DESKTOP_SMOKE_SOFTWARE_RENDERING === '1')
  app.disableHardwareAcceleration()
const root = resolve(__dirname, '..')
// Match the default Electron launcher's application-root setup for bundled resources.
app.setAppPath(root)
const buildId = process.env.AUTOREPLY_DESKTOP_SMOKE_BUILD_ID
if (buildId && !/^[a-f0-9-]{36}$/.test(buildId)) throw new Error('desktop_smoke_build_id_invalid')
const outRoot = buildId ? join(root, '.local', 'release-build', buildId, 'out') : join(root, 'out')
const requestedId = process.argv[2]
const reportId = requestedId && /^[0-9a-f-]{36}$/.test(requestedId) ? requestedId : randomUUID()
const directory = join(root, '.local', 'reports', 'desktop-smoke', reportId)
mkdirSync(directory, { recursive: true })
app.setPath('userData', directory)
app.setAppLogsPath(join(directory, 'logs'))
const lifecycle = (event, details = {}) =>
  appendFileSync(
    join(directory, 'lifecycle.jsonl'),
    JSON.stringify({ event, at: Date.now(), ...details }) + '\n'
  )
app.on('before-quit', (event) => {
  setImmediate(() => lifecycle('before-quit', { prevented: event.defaultPrevented }))
})
app.on('will-quit', () => lifecycle('will-quit'))
app.on('will-quit', () => {
  const output = join(directory, 'result.json')
  if (!existsSync(output)) return
  const previous = JSON.parse(readFileSync(output, 'utf8'))
  if (previous.passed !== true) return
  let index
  try {
    const vault = join(directory, 'agent', 'runtime-timing')
    index = new DatabaseSync(join(vault, 'index.private.sqlite'), { readOnly: true })
    const rows = index.prepare('SELECT id,state FROM sessions').all()
    if (rows.length !== 1 || rows[0].state !== 'sealed' || !/^[a-f0-9-]{36}$/.test(rows[0].id))
      throw new Error('timing_capture_not_sealed')
    const evidence = JSON.parse(
      readFileSync(join(vault, rows[0].id, 'report.private.json'), 'utf8')
    )
    if (
      evidence.schema !== 'autoreply-runtime-timing-evidence-v1' ||
      evidence.businessVerified !== false ||
      evidence.status !== 'insufficient' ||
      evidence.health.closed !== true ||
      evidence.health.pending !== 0 ||
      evidence.health.dropped !== 0
    )
      throw new Error('timing_capture_not_insufficient')
    writeFileSync(
      output,
      JSON.stringify(
        {
          ...previous,
          timingCapture: {
            configuredByProductionMain: true,
            sealedAfterRuntimeShutdown: true,
            businessVerified: false,
            foregroundPresentationVerified: false,
            status: evidence.status
          }
        },
        null,
        2
      ) + '\n'
    )
  } catch {
    writeFileSync(
      output,
      JSON.stringify({ ...previous, passed: false, code: 'timing_capture_unverified' }, null, 2) +
        '\n'
    )
  } finally {
    index?.close()
  }
})
app.on('quit', (_event, code) => lifecycle('quit', { code }))
delete process.env.ELECTRON_RENDERER_URL
delete process.env.AUTOREPLY_ENABLE_LEGACY_SKILL_SERVER
let unexpectedNetworkRequests = 0
// Every mode uses an empty private profile and synthetic UI data. Block accidental HTTP.
globalThis.fetch = async () => {
  unexpectedNetworkRequests++
  throw new Error('desktop_unexpected_network_request')
}
let done = false
// Includes the personal-mode UI check and the full enterprise action suite.
// Each UI predicate still has its own five-second deadline.
const timer = setTimeout(() => fail('timeout'), 45000)
function fail(code, error) {
  if (done) {
    writeFileSync(
      join(directory, 'postcheck-failure.json'),
      JSON.stringify({ code, message: error instanceof Error ? error.message : undefined })
    )
    return
  }
  done = true
  clearTimeout(timer)
  // This harness uses an empty private profile and never makes model/customer requests.
  // Keep diagnostics local; never copy exceptions into ordinary application logs.
  writeFileSync(
    join(directory, 'result.json'),
    JSON.stringify(
      {
        passed: false,
        code,
        diagnostic:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : undefined
      },
      null,
      2
    )
  )
  process.stderr.write(`Desktop smoke failed: ${code}\n`)
  app.exit(1)
}
app.on('browser-window-created', (_event, window) => {
  window.on('closed', () => lifecycle('window-closed'))
  // The production window starts hidden; suppress its later show callback in this harness.
  window.show = () => {}
  window.webContents.setBackgroundThrottling(false)
  // Hidden capture can return the previously committed compositor frame. Flush
  // a capture, then two new rendering frames before retaining visual evidence.
  let firstCapture = true
  const capture = async () => {
    lifecycle('capture-start', { gpu: app.getGPUFeatureStatus() })
    // The initial surface needs a committed frame before its first capture.
    // Later captures already flush and await frames below; repeating this wait
    // can cost two seconds per hidden-window capture on this Windows host.
    if (firstCapture) {
      await window.webContents.executeJavaScript(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
      )
      firstCapture = false
    }
    await window.webContents.capturePage(undefined, { stayHidden: true })
    lifecycle('capture-flush-complete')
    await window.webContents.executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
    )
    const result = (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG()
    lifecycle('capture-complete')
    return result
  }
  window.webContents.once('did-fail-load', () => fail('renderer_load_failed'))
  window.webContents.once('did-finish-load', async () => {
    if (done) return
    try {
      if (process.env.AUTOREPLY_DESKTOP_SMOKE_ADMIN_ONLY === '1') {
        const report = await require('./admin-console-smoke.cjs')({
          window,
          ipcMain,
          outRoot,
          directory,
          capture
        })
        if (unexpectedNetworkRequests !== 0) throw new Error('admin_unexpected_network_request')
        report.networkAttempts = unexpectedNetworkRequests
        done = true
        clearTimeout(timer)
        writeFileSync(join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n')
        process.stdout.write(
          `Administrator desktop smoke passed: ${join(directory, 'result.json')}\n`
        )
        app.quit()
        return
      }
      if (process.env.AUTOREPLY_DESKTOP_SMOKE_RESTORATION_ONLY === '1') {
        const report = await require('./restoration-smoke.cjs')({
          window,
          ipcMain,
          outRoot,
          directory,
          capture
        })
        if (unexpectedNetworkRequests !== 0)
          throw new Error('restoration_unexpected_network_request')
        report.networkAttempts = unexpectedNetworkRequests
        done = true
        clearTimeout(timer)
        writeFileSync(join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n')
        process.stdout.write(
          `Restoration desktop smoke passed: ${join(directory, 'result.json')}\n`
        )
        app.quit()
        return
      }
      if (process.env.AUTOREPLY_DESKTOP_SMOKE_FEEDBACK_ONLY === '1') {
        const report = await require('./workbench-feedback-smoke.cjs')({
          window,
          ipcMain,
          outRoot,
          directory,
          capture
        })
        if (unexpectedNetworkRequests !== 0) throw new Error('feedback_unexpected_network_request')
        report.networkAttempts = unexpectedNetworkRequests
        done = true
        clearTimeout(timer)
        writeFileSync(join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n')
        process.stdout.write(`Workbench feedback smoke passed: ${join(directory, 'result.json')}\n`)
        app.quit()
        return
      }
      const bundled = require(join(outRoot, 'main/provider-bundle.js'))
      const originalFetch = globalThis.fetch
      let providerInitializationRequests = 0
      globalThis.fetch = async () => {
        providerInitializationRequests++
        throw new Error('unexpected_provider_initialization_request')
      }
      let publishedProviderLoaded = false
      try {
        const loaded = await bundled.loadBuiltinDoubaoProvider({ apiKey: 'synthetic-unused-key' })
        publishedProviderLoaded = typeof loaded.provider.run === 'function'
      } finally {
        globalThis.fetch = originalFetch
      }
      if (!publishedProviderLoaded || providerInitializationRequests !== 0)
        return fail('published_provider_initialization_failed')
      if (
        existsSync(join(directory, 'agent', 'ledger.sqlite')) ||
        existsSync(join(directory, 'worktrace', 'memory', 'learning.sqlite'))
      )
        return fail('advanced_services_started_before_use')
      const dto = JSON.parse(
        await window.webContents.executeJavaScript(`(async () => {
        const legacySettings = await window.electron.invoke('settings:getAll');
        const publishedProvider = await window.electron.invoke('provider:getInstalled');
        const rejectedProviderInstall = await window.electron.invoke('provider:installFromUrl', '');
        const legacyStart = await window.electron.invoke('engine:start', {appType:'generic'});
        const legacySend = await window.electron.invoke('reply:send', 'synthetic-unsent');
        if((await window.foregroundWechat.status()).state!=='idle')throw new Error('personal_startup_not_idle');
        const legacyStop = await window.electron.invoke('engine:stop');
        const device = await window.agentDesktop.status();
        const initial = await window.agentRuntime.status();
        const foregroundInitial = await window.foregroundWechat.status();
        let foregroundBridgeBlocked = false;
        try { await window.electron.invoke('foreground-wechat:start', {target:'Q',foregroundConsent:true}) } catch { foregroundBridgeBlocked = true }
        const synchronized = await window.agentRuntime.synchronize();
        const started = await window.agentRuntime.start();
        const paused = await window.agentRuntime.pause();
        const workbench = await window.agentWorkbench.snapshot();
        const unavailableAction = await window.agentWorkbench.act({taskId:'synthetic-task',expectedVersion:'a'.repeat(64),action:'takeover'});
        const unavailableEdit = await window.agentWorkbench.reviewEdited({taskId:'synthetic-task',expectedVersion:'a'.repeat(64),text:'合成编辑'});
        const unavailableConfirm = await window.agentWorkbench.confirmSend({taskId:'synthetic-task',expectedVersion:'a'.repeat(64)});
        const unavailableEvidence = await window.agentWorkbench.evidence({taskId:'synthetic-task',expectedVersion:'a'.repeat(64),offset:0});
        const unavailableReconciliation = await window.agentWorkbench.reconcile({taskId:'synthetic-task',expectedVersion:'a'.repeat(64)});
        const forgedReconciliation = await window.agentWorkbench.reconcile({taskId:'synthetic-task',expectedVersion:'a'.repeat(64),observation:{status:'confirmed'}});
        let privateBridgeBlocked = false;
        try { await window.electron.invoke('agent:status') } catch { privateBridgeBlocked = true }
        let workbenchBridgeBlocked = false;
        try { await window.electron.invoke('agent-workbench:snapshot') } catch { workbenchBridgeBlocked = true }
        let editBridgeBlocked = false;
        try { await window.electron.invoke('agent-workbench:review-edited', {}) } catch { editBridgeBlocked = true }
        let confirmBridgeBlocked = false;
        try { await window.electron.invoke('agent-workbench:confirm-send', {}) } catch { confirmBridgeBlocked = true }
        let evidenceBridgeBlocked = false;
        try { await window.electron.invoke('agent-workbench:evidence', {}) } catch { evidenceBridgeBlocked = true }
        let reconciliationBridgeBlocked = false;
        try { await window.electron.invoke('agent-workbench:reconcile', {}) } catch { reconciliationBridgeBlocked = true }
        return JSON.stringify({ foregroundInitial, foregroundBridgeBlocked, publishedProvider, rejectedProviderInstall, legacySettingsAvailable: Boolean(legacySettings), legacyStart, legacySend, legacyStop, device, initial, synchronized, started, paused, workbench, unavailableAction, unavailableEdit, unavailableConfirm, unavailableEvidence, unavailableReconciliation, forgedReconciliation, reconciliationBridgeBlocked, evidenceBridgeBlocked, confirmBridgeBlocked, editBridgeBlocked, privateBridgeBlocked,workbenchBridgeBlocked });
      })()`)
      )
      if (
        !dto.legacySettingsAvailable ||
        dto.publishedProvider.manifest?.id !== 'volcengine-ark' ||
        dto.publishedProvider.isBuiltinDefault !== true ||
        dto.rejectedProviderInstall.success !== false ||
        !dto.rejectedProviderInstall.error?.includes('此版本仅支持随应用发布的聊天服务') ||
        dto.legacyStart.success !== false ||
        dto.legacySend.success !== false ||
        dto.legacyStop.success !== true ||
        dto.device.state !== 'unregistered' ||
        dto.initial.state !== 'paused' ||
        dto.foregroundInitial.state !== 'paused' ||
        dto.foregroundInitial.reason !== 'user_pause' ||
        dto.foregroundInitial.records.length !== 0 ||
        !dto.foregroundBridgeBlocked ||
        dto.synchronized.reason !== 'not_registered' ||
        dto.started.reason !== 'not_registered' ||
        dto.paused.state !== 'paused' ||
        !dto.paused.pauseAcknowledged ||
        !dto.privateBridgeBlocked ||
        !dto.workbenchBridgeBlocked ||
        !dto.editBridgeBlocked ||
        !dto.confirmBridgeBlocked ||
        !dto.evidenceBridgeBlocked ||
        !dto.reconciliationBridgeBlocked ||
        dto.unavailableReconciliation.success !== false ||
        dto.unavailableReconciliation.code !== 'unavailable' ||
        dto.forgedReconciliation.success !== false ||
        dto.forgedReconciliation.code !== 'invalid_input' ||
        dto.unavailableEvidence.success !== false ||
        dto.unavailableEvidence.code !== 'unavailable' ||
        dto.unavailableConfirm.success !== false ||
        dto.unavailableConfirm.code !== 'unavailable' ||
        dto.unavailableEdit.code !== 'unavailable' ||
        dto.unavailableEdit.success !== false ||
        dto.workbench.state !== 'not_registered' ||
        dto.workbench.rows.length !== 0 ||
        dto.unavailableAction.success !== false ||
        dto.unavailableAction.code !== 'unavailable'
      )
        return fail('runtime_contract_failed')
      const path = join(directory, 'agent', 'ledger.sqlite')
      if (!existsSync(path)) return fail('ledger_missing')
      const db = new DatabaseSync(path, { readOnly: true })
      const schemaVersion = db.prepare('PRAGMA user_version').get().user_version
      const epoch = db
        .prepare("SELECT value FROM runtime_metadata WHERE key='run_epoch'")
        .get().value
      db.close()
      // Fresh runtime ledgers must use the current v13 schema; v11/v12 are migration sources.
      if (schemaVersion !== 13 || epoch < 1) return fail('ledger_contract_failed')
      const personalUi = await window.webContents.executeJavaScript(`(async()=>{
        const deadline=Date.now()+5000;
        while(!document.querySelector('#personal-wechat-target')&&Date.now()<deadline) await new Promise(r=>setTimeout(r,25));
        const input=document.querySelector('#personal-wechat-target');
        const section=document.querySelector('[aria-labelledby="personal-wechat-heading"]');
        const button=Array.from(section?.querySelectorAll('button')||[]).find(b=>b.textContent.includes('启动个人微信'));
        if(!input||!button) throw new Error('personal_controls_missing');
        const initialTargetBlank=input.value==='';
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Q');
        input.dispatchEvent(new Event('input',{bubbles:true}));
        await new Promise(resolve=>setTimeout(resolve,50));
        const targetIsQ=input.value==='Q' && initialTargetBlank;
        const currentChatButton=Array.from(section.querySelectorAll('button')).find(b=>b.textContent.includes('接入已打开的聊天'));
        const currentChatAvailable=Boolean(currentChatButton&&!currentChatButton.disabled);
        let missingSelectionRejected=false;
        try {await window.foregroundWechat.start({target:'Q',foregroundConsent:true,connectionMode:'current_chat'});} catch {missingSelectionRejected=true;}
        button.click();
        let status;
        while(Date.now()<deadline) {status=await window.foregroundWechat.status();if(status.state==='paused')break;await new Promise(r=>setTimeout(r,25));}
        while(!section.textContent.includes('请先在模型配置中填写密钥')&&Date.now()<deadline) await new Promise(r=>setTimeout(r,25));
        return {targetIsQ,currentChatAvailable,missingSelectionRejected,missingModelVisible:section.textContent.includes('请先在模型配置中填写密钥'),reason:status?.reason,noDispatch:status?.records.length===0};
      })()`)
      if (
        !personalUi.targetIsQ ||
        !personalUi.currentChatAvailable ||
        !personalUi.missingSelectionRejected ||
        !personalUi.missingModelVisible ||
        personalUi.reason !== 'model_not_configured' ||
        !personalUi.noDispatch
      )
        return fail('personal_controls_failed')
      const personalBatchUi = await window.webContents.executeJavaScript(`(async()=>{
        Array.from(document.querySelectorAll('details')).find(element=>element.querySelector('summary')?.textContent.includes('多联系人批量')).open=true;
        const mountDeadline=Date.now()+5000;
        while(!document.querySelector('#personal-wechat-batch-targets')&&Date.now()<mountDeadline)await new Promise(resolve=>setTimeout(resolve,25));
        const panel=document.querySelector('[aria-labelledby="personal-wechat-batch-heading"]');
        const target=document.getElementById('personal-wechat-batch-targets');
        const button=Array.from(panel?.querySelectorAll('button')||[]).find(value=>value.textContent.includes('启动批量'));
        if(!panel||!target||!button)throw new Error('personal_batch_missing');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(target,'Q');
        target.dispatchEvent(new Event('input',{bubbles:true}));
        await new Promise(resolve=>setTimeout(resolve,50));
        let invalidScopeRejected=false;
        try{await window.foregroundWechat.batchStart({targets:[],foregroundConsent:true,processUnread:true});}catch{invalidScopeRejected=true;}
        const visible=panel.getBoundingClientRect().height>0;
        button.click();
        const deadline=Date.now()+5000;
        while(!panel.textContent.includes('已配置密钥')&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
        const status=await window.foregroundWechat.batchStatus();
        return {visible,targetIsQ:target.value==='Q',invalidScopeRejected,missingModelVisible:panel.textContent.includes('已配置密钥'),reason:status.reason,noDispatch:status.records.length===0};
      })()`)
      if (
        !personalBatchUi.visible ||
        !personalBatchUi.targetIsQ ||
        !personalBatchUi.invalidScopeRejected ||
        !personalBatchUi.missingModelVisible ||
        personalBatchUi.reason !== 'model_not_configured' ||
        !personalBatchUi.noDispatch
      )
        return fail('personal_batch_failed')
      await window.webContents.executeJavaScript('window.foregroundWechat.batchPause()')
      // Exercise the production settings component against the real named IPC bridge.
      // This isolated unregistered profile cannot start customer automation.
      window.setContentSize(900, 720)
      await window.loadFile(join(outRoot, 'renderer', 'index.html'), {
        query: { window: 'settings', section: 'enterprise' }
      })
      const controls = await window.webContents.executeJavaScript(`(async () => {
        const until = async (predicate) => {
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            if (predicate()) return;
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          throw new Error('runtime_controls_timeout');
        };
        await until(() => document.querySelector('.enterprise-runtime-status')?.textContent.includes('已确认停止'));
        const buttons = Array.from(document.querySelectorAll('.enterprise-runtime-actions button'));
        const before = {
          synchronizeDisabled: buttons[0]?.disabled,
          startDisabled: buttons[1]?.disabled,
          missingRegistrationVisible: document.querySelector('[aria-label="自动回复启动条件"]')?.textContent.includes('尚未连接回复服务') === true,
          missingChatAdapterVisible: document.querySelector('[aria-label="自动回复启动条件"]')?.textContent.includes('尚未接通微信或企业微信的真实收发') === true,
          pauseEnabled: buttons[2]?.disabled === false
        };
        buttons[2].click();
        await until(() => document.querySelector('.enterprise-runtime-reason')?.textContent.includes('已收到暂停请求'));
        await until(() => document.querySelector('.enterprise-runtime-status')?.textContent.includes('已确认停止'));
        return { ...before,
          pauseConfirmed: (await window.agentRuntime.status()).pauseAcknowledged,
          renderedPaused: document.querySelector('.enterprise-runtime-status').textContent.includes('已暂停'),
          alertCount: document.querySelectorAll('[role="alert"]').length
        };
      })()`)
      if (
        !controls.synchronizeDisabled ||
        !controls.startDisabled ||
        !controls.missingRegistrationVisible ||
        !controls.missingChatAdapterVisible ||
        !controls.pauseEnabled ||
        !controls.pauseConfirmed ||
        !controls.renderedPaused ||
        controls.alertCount !== 0
      )
        return fail('runtime_controls_contract_failed')
      writeFileSync(join(directory, 'enterprise-controls.png'), await capture())
      // UI races use explicit synthetic IPC responses, never a customer adapter.
      // The preceding checks used real production handlers and an unregistered device.
      let uiStatus = {
        state: 'paused',
        reason: 'none',
        lease: 'stopped',
        pauseAcknowledged: true,
        readiness: { registered: true, backgroundRead: false, nonInterferingSend: false }
      }
      let resolveStart
      let startRequests = 0
      let pauseFails = false
      const replace = (channel, handler) => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, handler)
      }
      replace('agent:status', () => ({
        state: 'registered',
        scope: {
          tenant_id: 'synthetic-tenant',
          employee_id: 'synthetic-employee',
          account_id: 'synthetic-account',
          agent_id: 'synthetic-agent',
          platform: 'wechat'
        }
      }))
      replace('agent-runtime:status', () => uiStatus)
      replace('agent-runtime:start', () => {
        startRequests++
        return new Promise((resolve) => {
          resolveStart = resolve
        })
      })
      replace('agent-runtime:pause', () => {
        if (pauseFails) throw new Error('synthetic_private_failure')
        uiStatus = {
          state: 'pausing',
          reason: 'user_pause',
          lease: 'stopped',
          pauseAcknowledged: false
        }
        return uiStatus
      })
      const reloaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
      window.reload()
      await reloaded
      const ui = async (operation) => {
        const result = await window.webContents.executeJavaScript(`(async () => {
        try { return await (async () => {
        const until = async (predicate) => {
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            if (predicate()) return;
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          const workbench=document.querySelector('.enterprise-workbench');
          throw new Error(JSON.stringify({code:'synthetic_ui_timeout',predicate:String(predicate),
            status:workbench?.querySelector('[role="status"]')?.textContent,
            alert:workbench?.querySelector('[role="alert"]')?.textContent,
            task:workbench?.querySelector('.enterprise-task')?.textContent.slice(0,1500),
            buttons:Array.from(workbench?.querySelectorAll('button')??[]).map(button=>({text:button.textContent,disabled:button.disabled}))}));
        };
        const panel = () => document.querySelector('.enterprise-runtime-status');
        const buttons = () => Array.from(document.querySelectorAll('.enterprise-runtime-actions button'));
        ${operation}
        })(); } catch(error) {
          return {__harnessError: String(error?.message ?? error), stack: error?.stack};
        }
      })()`)
        if (result?.__harnessError) throw new Error(JSON.stringify(result))
        return result
      }
      const capabilityBlocked = await ui(`
        await until(() => buttons()[0]?.disabled === false);
        const blocked = buttons()[1].disabled &&
          document.querySelector('[aria-label="自动回复启动条件"]')?.textContent.includes('完成电脑登记也不会自动接通微信');
        buttons()[1].click();
        return blocked;
      `)
      lifecycle('synthetic-capability-checked')
      if (!capabilityBlocked || startRequests !== 0)
        return fail('unavailable_platform_start_enabled')
      uiStatus.readiness = { registered: true, backgroundRead: true, nonInterferingSend: true }
      const interruptible = await ui(`
        await until(() => buttons()[1]?.disabled === false);
        buttons()[1].click();
        await until(() => panel().textContent.includes('正在请求启动'));
        const pauseAvailableDuringStart = buttons()[2].disabled === false;
        buttons()[2].click();
        await until(() => panel().textContent.includes('正在停止'));
        return { pauseAvailableDuringStart, startDisabled: buttons()[1].disabled,
          unacknowledged: panel().textContent.includes('尚未确认停止') };
      `)
      lifecycle('synthetic-pause-checked')
      if (
        !resolveStart ||
        !interruptible.pauseAvailableDuringStart ||
        !interruptible.startDisabled ||
        !interruptible.unacknowledged
      )
        return fail('ui_interrupt_failed')
      resolveStart({ state: 'running', reason: 'none', lease: 'active', pauseAcknowledged: false })
      // A later status response completes a subsequent turn through the renderer IPC loop.
      const lateStartIgnored = await ui(`
        await window.agentRuntime.status();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return panel().textContent.includes('正在停止') && buttons()[1].disabled;
      `)
      if (!lateStartIgnored) return fail('ui_late_start_overwrote_pause')
      uiStatus = { state: 'paused', reason: 'locked', lease: 'stopped', pauseAcknowledged: true }
      const lateStopAcknowledged = await ui(`
        await until(() => panel().textContent.includes('已确认停止') && buttons()[1]?.disabled === false);
        return document.querySelector('.enterprise-runtime-reason').textContent.includes('需要手动启动');
      `)
      lifecycle('synthetic-stop-checked')
      if (!lateStopAcknowledged) return fail('ui_stop_ack_missing')
      pauseFails = true
      const privateErrorHidden = await ui(`
        buttons()[2].click();
        await until(() => document.querySelector('[role="alert"]'));
        return buttons()[1].disabled && panel().textContent.includes('尚未确认停止') &&
          document.querySelector('[role="alert"]').textContent.includes('操作结果尚未确认') &&
          !document.body.textContent.includes('synthetic_private_failure');
      `)
      if (!privateErrorHidden) return fail('ui_error_contract_failed')
      lifecycle('synthetic-private-error-checked')
      pauseFails = false
      await ui(
        `await until(() => !document.querySelector('[role="alert"]') && panel().textContent.includes('已确认停止'));`
      )
      const syntheticControls = {
        capabilityBlocked,
        interruptible,
        lateStartIgnored,
        lateStopAcknowledged,
        privateErrorHidden
      }
      // Explicit synthetic collection progress: no chat window or native reader is used.
      uiStatus.collection = {
        coverage: 'scanning',
        reason: 'none',
        knownConversations: 500,
        pendingReads: 20,
        needsHuman: 2,
        lastCompletedAt: null
      }
      const collectionUi = await ui(`
        await until(() => panel().textContent.includes('已发现 500 个会话'));
        return panel().textContent.includes('正在检查') &&
          panel().textContent.includes('待读取 20 个') &&
          panel().textContent.includes('读取异常需人工核对 2 个');
      `)
      if (!collectionUi) return fail('collection_progress_missing')
      uiStatus.collection = {
        ...uiStatus.collection,
        coverage: 'incomplete',
        reason: 'inventory_changed'
      }
      const collectionIncompleteUi = await ui(`
        await until(() => panel().textContent.includes('本轮检查不完整，仍需补查'));
        return panel().textContent.includes('列表检查完成不代表消息全部处理完成');
      `)
      if (!collectionIncompleteUi) return fail('collection_incomplete_hidden')
      writeFileSync(join(directory, 'collection-incomplete.png'), await capture())
      uiStatus.collection = {
        ...uiStatus.collection,
        coverage: 'complete',
        reason: 'none',
        pendingReads: 0,
        lastCompletedAt: 10000
      }
      await ui(`await until(() => panel().textContent.includes('本轮列表检查完成'));`)
      writeFileSync(join(directory, 'collection-complete.png'), await capture())
      window.setContentSize(860, 640)
      const collectionSmallFits = await ui(`
        await until(() => innerWidth === 860 && innerHeight === 640);
        const progress = document.querySelector('[aria-label="会话采集进度"]');
        progress.scrollIntoView({block:'center'});
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const bounds = progress.getBoundingClientRect();
        return bounds.top >= 0 && bounds.bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth;
      `)
      if (!collectionSmallFits) return fail('collection_progress_small_window_overflow')
      writeFileSync(join(directory, 'collection-small.png'), await capture())
      window.setContentSize(900, 720)
      delete uiStatus.collection
      // Catalogue UI checks use declared synthetic IPC state. Actual scoped ledger
      // mutations and cancellation are verified by integration/regression tests.
      let row = {
        taskId: 'synthetic-task',
        conversationId: '合成测试会话',
        status: 'needs_human',
        version: 'a'.repeat(64),
        inboundPreview: '合成客户问题',
        replyText: '合成回复建议',
        createdAt: 1000,
        updatedAt: 1000,
        humanOwned: false,
        stopAcknowledged: true,
        canSkip: true,
        canRelease: false
      }
      let actionRequest
      replace('agent-workbench:snapshot', () => ({ state: 'available', rows: [row] }))
      replace('agent-workbench:act', (_event, input) => {
        actionRequest = input
        row = {
          ...row,
          version: 'b'.repeat(64),
          humanOwned: true,
          stopAcknowledged: false,
          canSkip: false,
          canRelease: false
        }
        return {
          success: true,
          stopAcknowledged: false,
          snapshot: { state: 'available', rows: [row] }
        }
      })
      const workbenchUi = await ui(`
        const refresh = document.querySelector('.enterprise-workbench .enterprise-card-heading button');
        refresh.click();
        await until(() => document.querySelector('.enterprise-task')?.textContent.includes('合成测试会话'));
        const taskButtons = () => Array.from(document.querySelectorAll('.enterprise-task button'));
        const visibleSuggestion = document.querySelector('.enterprise-task').textContent.includes('合成回复建议');
        taskButtons().find(button => button.textContent === '人工接管').click();
        await until(() => document.querySelector('.enterprise-workbench').textContent.includes('停止尚待确认'));
        return {visibleSuggestion, releaseBlocked:taskButtons().find(button => button.textContent === '交还自动处理').disabled,
          ownershipVisible:document.querySelector('.enterprise-task').textContent.includes('人工已接管，停止待确认')};
      `)
      if (
        !workbenchUi.visibleSuggestion ||
        !workbenchUi.releaseBlocked ||
        !workbenchUi.ownershipVisible ||
        actionRequest?.taskId !== 'synthetic-task' ||
        actionRequest?.expectedVersion !== 'a'.repeat(64) ||
        actionRequest?.action !== 'takeover' ||
        Object.keys(actionRequest).length !== 3
      )
        return fail('workbench_ui_contract_failed')
      await window.webContents.executeJavaScript(
        `document.querySelector('.enterprise-workbench').scrollIntoView({block:'end'});`
      )
      writeFileSync(join(directory, 'workbench-synthetic.png'), await capture())
      row = {
        ...row,
        version: 'c'.repeat(64),
        stopAcknowledged: true,
        canReview: true,
        canRelease: true
      }
      let editRequest,
        resolveEdit,
        editCount = 0
      replace('agent-workbench:review-edited', (_event, input) => {
        editRequest = input
        editCount++
        return new Promise((resolve) => {
          resolveEdit = resolve
        })
      })
      const editorOpened = await ui(`
        document.querySelector('.enterprise-workbench .enterprise-card-heading button').click();
        await until(() => Array.from(document.querySelectorAll('.enterprise-task button')).find(button => button.textContent === '编辑并重新审核')?.disabled === false);
        Array.from(document.querySelectorAll('.enterprise-task button')).find(button => button.textContent === '编辑并重新审核').click();
        await until(() => document.querySelector('.enterprise-edit textarea'));
        const textarea = document.querySelector('.enterprise-edit textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, '员工改写的合成回复');
        textarea.dispatchEvent(new Event('input', { bubbles:true }));
        await until(() => textarea.value === '员工改写的合成回复');
        document.querySelector('.enterprise-edit').scrollIntoView({block:'center'});
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return document.querySelector('.enterprise-edit').textContent.includes('修改中的内容尚未审核');
      `)
      writeFileSync(join(directory, 'workbench-edit-synthetic.png'), await capture())
      window.setContentSize(860, 640)
      const editorFits = await ui(`
        await until(() => innerWidth === 860 && innerHeight === 640);
        document.querySelector('.enterprise-edit button').scrollIntoView({block:'center'});
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const main = document.querySelector('main');
        const button = document.querySelector('.enterprise-edit button').getBoundingClientRect();
        return button.top >= 0 && button.bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth && (!main || main.scrollWidth <= main.clientWidth + 1);
      `)
      writeFileSync(join(directory, 'workbench-edit-small.png'), await capture())
      window.setContentSize(900, 720)
      const editBusy = await ui(`
        const button = Array.from(document.querySelectorAll('.enterprise-edit button')).find(button => button.textContent === '重新审核');
        button.click();button.click();
        await until(() => button.textContent.includes('正在重新审核'));
        return button.disabled;
      `)
      if (
        !editorOpened ||
        !editorFits ||
        !editBusy ||
        editCount !== 1 ||
        !resolveEdit ||
        editRequest?.taskId !== 'synthetic-task' ||
        editRequest?.expectedVersion !== 'c'.repeat(64) ||
        editRequest?.text !== '员工改写的合成回复' ||
        Object.keys(editRequest).length !== 3
      )
        return fail('edited_review_ui_request_failed')
      row = {
        ...row,
        taskId: 'synthetic-edited-task',
        version: 'd'.repeat(64),
        canReview: false,
        replyText: editRequest.text,
        reviewStatus: 'needs_human',
        reviewReasons: ['audit_supported', 'audit_covers_requests', 'freeform_requires_human'],
        canConfirm: true,
        canReadEvidence: true,
        explanation: {
          taskId: 'synthetic-edited-task',
          contextHash: 'a'.repeat(64),
          knowledgeVersion: 'synthetic-knowledge',
          draftHash: 'b'.repeat(64),
          draftRevision: 2,
          intents: ['faq', 'price'],
          recommendation: 'review',
          factsVerified: false,
          totalReferences: 3,
          unavailableReferences: 1,
          omittedReferences: 1,
          evidence: [
            {
              evidenceId: 'synthetic-faq',
              intent: 'faq',
              kind: 'approved_faq',
              source: '合成产品手册，章节：离线使用',
              excerpt: '支持离线阅读，先同步所需内容。',
              excerptTruncated: true,
              validFrom: Date.now() - 60000,
              expiresAt: Date.now() + 60000
            }
          ]
        }
      }
      resolveEdit({
        success: true,
        stopAcknowledged: true,
        snapshot: { state: 'available', rows: [row] }
      })
      const editedReviewUi = await ui(`
        await until(() => !document.querySelector('.enterprise-edit') && document.querySelector('.enterprise-workbench').textContent.includes('尚未发送'));
        return { editorOpened:${editorOpened}, doubleClickBlocked:${editBusy},
          smallWindowFits:${editorFits},
          reviewedTextVisible:document.querySelector('.enterprise-task').textContent.includes('员工改写的合成回复'),
          takeoverRetained:document.querySelector('.enterprise-task').textContent.includes('由人工处理'),
          confirmationEnabled:Array.from(document.querySelectorAll('.enterprise-task button')).find(button => button.textContent.includes('确认发送'))?.disabled === false };
      `)
      if (
        !editedReviewUi.reviewedTextVisible ||
        !editedReviewUi.takeoverRetained ||
        !editedReviewUi.confirmationEnabled
      )
        return fail('edited_review_ui_result_failed')
      await ui(
        `document.querySelector('.enterprise-task').scrollIntoView({block:'center'});await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));`
      )
      writeFileSync(join(directory, 'workbench-edited-result-synthetic.png'), await capture())
      const assessmentUi = await ui(`
        const disclosure=document.querySelector('.enterprise-evidence');
        const task=document.querySelector('.enterprise-task');
        const before=disclosure.open === false;
        disclosure.querySelector('summary').click();await until(()=>disclosure.open);
        disclosure.scrollIntoView({block:'center'});
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        return {collapsedByDefault:before, readableIntents:task.textContent.includes('产品或服务咨询、价格与报价'),
          readableRecommendation:task.textContent.includes('核对草稿后由员工确认发送'),
          readableReasons:task.textContent.includes('未能确认草稿中的事实或承诺有充分依据')&&task.textContent.includes('可能没有覆盖客户的全部待处理问题'),
          evidenceVisible:disclosure.isConnected&&disclosure.open&&disclosure.textContent.includes('合成产品手册，章节：离线使用')&&disclosure.textContent.includes('支持离线阅读，先同步所需内容。'),
          unavailableHonest:disclosure.textContent.includes('有 1 条引用未通过本任务'),
          noAutomaticClaim:task.textContent.includes('业务事实仍需员工核实')&&!task.textContent.includes('草稿与经审核的知识原文一致')};
      `)
      if (Object.values(assessmentUi).some((value) => value !== true))
        return fail('assessment_ui_failed')
      writeFileSync(join(directory, 'workbench-assessment-expanded.png'), await capture())
      window.setContentSize(860, 640)
      const assessmentSmallFits = await ui(`
        await until(()=>innerWidth===860&&innerHeight===640);
        const button=Array.from(document.querySelectorAll('.enterprise-task button')).find(button=>button.textContent.includes('确认发送'));
        button.scrollIntoView({block:'center'});
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const rect=button.getBoundingClientRect(),main=document.querySelector('main');
        return rect.top>=0&&rect.bottom<=innerHeight&&document.documentElement.scrollWidth<=innerWidth&&(!main||main.scrollWidth<=main.clientWidth+1);
      `)
      if (!assessmentSmallFits) return fail('assessment_small_overflow')
      writeFileSync(join(directory, 'workbench-assessment-small.png'), await capture())
      let evidenceCount = 0,
        evidenceRequest,
        resolveEvidence
      const referencePage = (offset) => ({
        taskId: row.explanation.taskId,
        contextHash: row.explanation.contextHash,
        knowledgeVersion: row.explanation.knowledgeVersion,
        draftHash: row.explanation.draftHash,
        draftRevision: row.explanation.draftRevision,
        offset,
        assessedAt: Date.now(),
        totalAvailable: 2,
        unavailableReferences: 1,
        ...(offset === 0 ? { nextOffset: 1 } : {}),
        evidence: [
          {
            evidenceId: offset === 0 ? 'synthetic-faq' : 'synthetic-price',
            intent: 'faq',
            kind: 'approved_faq',
            source: offset === 0 ? '合成产品手册，章节：离线使用' : '合成完整知识库：价格说明',
            content:
              offset === 0
                ? '支持离线阅读，先同步所需内容。\n' +
                  '这是完整资料正文，包含摘录之外的条件。\n'.repeat(100) +
                  '完整正文结尾。'
                : '第二条完整引用资料。',
            validFrom: Date.now() - 60000,
            expiresAt: Date.now() + 60000
          }
        ]
      })
      replace('agent-workbench:evidence', (_event, input) => {
        evidenceCount++
        evidenceRequest = input
        return new Promise((resolve) => {
          resolveEvidence = resolve
        })
      })
      const evidenceBusy = await ui(`
        const button=Array.from(document.querySelectorAll('.enterprise-reference-viewer button')).find(button=>button.textContent==='查看完整引用资料');
        button.click();button.click();await until(()=>button.disabled);return button.disabled;
      `)
      if (
        !evidenceBusy ||
        evidenceCount !== 1 ||
        !resolveEvidence ||
        evidenceRequest.taskId !== row.taskId ||
        evidenceRequest.expectedVersion !== row.version ||
        evidenceRequest.offset !== 0 ||
        Object.keys(evidenceRequest).length !== 3
      )
        return fail('evidence_request_failed')
      resolveEvidence({ success: true, page: referencePage(0) })
      const referencesUi = await ui(`
        await until(()=>document.querySelector('.enterprise-reference-original'));
        const viewer=document.querySelector('.enterprise-reference-viewer'),original=document.querySelector('.enterprise-reference-original');
        original.focus();original.scrollTop=original.scrollHeight;
        viewer.scrollIntoView({block:'center'});
        const confirm=Array.from(document.querySelectorAll('.enterprise-task button')).find(button=>button.textContent.includes('确认发送'));
        confirm.scrollIntoView({block:'center'});
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        return {doubleClickBlocked:${evidenceBusy},fullOriginalVisible:original.textContent.includes('完整正文结尾。'),
          scrollable:original.scrollHeight>original.clientHeight&&original.scrollTop>0,
          keyboardFocusable:document.activeElement===original,
          correctPage:viewer.textContent.includes('第 1 / 2 条可查看资料'),
          historicalWarning:viewer.textContent.includes('后续发布可能已更新'),
          unavailableHonest:viewer.textContent.includes('有 1 条引用不适用于这次评估'),
          smallFits:document.documentElement.scrollWidth<=innerWidth,
          confirmationFits:confirm.getBoundingClientRect().top>=0&&confirm.getBoundingClientRect().bottom<=innerHeight};
      `)
      if (Object.values(referencesUi).some((value) => value !== true))
        return fail('references_ui_failed')
      writeFileSync(join(directory, 'workbench-full-reference-small.png'), await capture())
      replace('agent-workbench:evidence', (_event, input) => {
        evidenceCount++
        evidenceRequest = input
        return { success: true, page: referencePage(input.offset) }
      })
      const referencesNext = await ui(`
        const viewer=document.querySelector('.enterprise-reference-viewer');
        Array.from(viewer.querySelectorAll('button')).find(button=>button.textContent==='下一条资料').click();
        await until(()=>viewer.textContent.includes('第 2 / 2 条可查看资料'));
        return viewer.textContent.includes('第二条完整引用资料。')&&!viewer.textContent.includes('完整正文结尾。')&&
          !Array.from(viewer.querySelectorAll('button')).some(button=>button.textContent==='下一条资料');
      `)
      if (!referencesNext || evidenceCount !== 2 || evidenceRequest.offset !== 1)
        return fail('references_paging_failed')
      await ui(`document.querySelector('.enterprise-evidence summary').click();`)
      window.setContentSize(900, 720)
      let confirmRequest,
        resolveConfirm,
        confirmCount = 0
      replace('agent-workbench:confirm-send', (_event, input) => {
        confirmRequest = input
        confirmCount++
        return new Promise((resolve) => {
          resolveConfirm = resolve
        })
      })
      const confirmingUi = await ui(`
        const button=Array.from(document.querySelectorAll('.enterprise-task button')).find(button=>button.textContent.includes('确认发送'));
        button.click();button.click();await until(()=>button.disabled);
        return button.disabled;
      `)
      if (
        !confirmingUi ||
        confirmCount !== 1 ||
        !resolveConfirm ||
        confirmRequest?.taskId !== 'synthetic-edited-task' ||
        confirmRequest?.expectedVersion !== 'd'.repeat(64) ||
        Object.keys(confirmRequest).length !== 2
      )
        return fail('human_confirmation_request_failed')
      row = {
        ...row,
        status: 'unknown',
        version: 'e'.repeat(64),
        canConfirm: false,
        canRelease: false,
        canReview: false,
        canSkip: false
      }
      resolveConfirm({
        success: true,
        snapshot: { state: 'available', rows: [row] },
        stopAcknowledged: true
      })
      const humanConfirmationUi = await ui(`
        await until(()=>document.querySelector('.enterprise-task').textContent.includes('发送结果待核对'));
        const taskButtons=Array.from(document.querySelectorAll('.enterprise-task button'));
        document.querySelector('.enterprise-task').scrollIntoView({block:'center'});
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        return {doubleClickBlocked:${confirmingUi},unknownNoRetry:taskButtons.find(button=>button.textContent.includes('确认发送')).disabled,
          releaseBlocked:taskButtons.find(button=>button.textContent==='交还自动处理').disabled,
          noFalseConfirmation:!document.querySelector('.enterprise-task').textContent.includes('已确认发送')};
      `)
      if (
        !humanConfirmationUi.unknownNoRetry ||
        !humanConfirmationUi.releaseBlocked ||
        !humanConfirmationUi.noFalseConfirmation
      )
        return fail('human_confirmation_unknown_ui_failed')
      const referenceStaleCleared = await ui(`
        return !document.querySelector('.enterprise-reference-original') && !document.querySelector('.enterprise-task').textContent.includes('第二条完整引用资料。');
      `)
      if (!referenceStaleCleared) return fail('references_stale_not_cleared')
      writeFileSync(join(directory, 'workbench-human-unknown-synthetic.png'), await capture())
      row = { ...row, version: 'f'.repeat(64), canReconcile: true, reconciliationRequired: true }
      let reconciliationRequest,
        resolveReconciliation,
        reconciliationCount = 0
      replace('agent-workbench:reconcile', (_event, input) => {
        reconciliationRequest = input
        reconciliationCount++
        return new Promise((resolve) => {
          resolveReconciliation = resolve
        })
      })
      const reconciliationBusy = await ui(`
        document.querySelector('.enterprise-workbench .enterprise-card-heading button').click();
        const find=()=>Array.from(document.querySelectorAll('.enterprise-task button')).find(button=>button.textContent==='核对发送结果');
        await until(()=>find()?.disabled===false);
        const button=find();button.click();button.click();
        await until(()=>Array.from(document.querySelectorAll('.enterprise-task button')).some(button=>button.textContent==='正在核对…'));
        return Array.from(document.querySelectorAll('.enterprise-task > .enterprise-runtime-actions button')).every(button=>button.disabled);
      `)
      if (
        !reconciliationBusy ||
        reconciliationCount !== 1 ||
        !resolveReconciliation ||
        Object.keys(reconciliationRequest).length !== 2 ||
        reconciliationRequest.taskId !== 'synthetic-edited-task' ||
        reconciliationRequest.expectedVersion !== 'f'.repeat(64)
      )
        return fail('reconciliation_ui_request_failed')
      const reconciliationAck = {
        success: true,
        caseId: 'fca55e8a-0bb4-40cc-a3c0-d4e6eb647a21',
        reportHash: 'a'.repeat(64),
        status: 'evidence_recorded'
      }
      resolveReconciliation(reconciliationAck)
      const evidenceStillBlocked = await ui(`
        await until(()=>document.querySelector('.enterprise-workbench [role="status"]')?.textContent.includes('等待管理员结案'));
        const confirm=Array.from(document.querySelectorAll('.enterprise-task button')).find(button=>button.textContent.includes('确认发送'));
        document.querySelector('.enterprise-task').scrollIntoView({block:'end'});
        return confirm.disabled&&document.querySelector('.enterprise-task').textContent.includes('发送结果待核对');
      `)
      writeFileSync(
        join(directory, 'workbench-reconciliation-evidence-synthetic.png'),
        await capture()
      )
      window.setContentSize(860, 640)
      const unknownReconciliationFits = await ui(`
        await until(()=>innerWidth===860&&innerHeight===640);
        const actions=document.querySelector('.enterprise-task > .enterprise-runtime-actions');
        actions.scrollIntoView({block:'center'});
        const main=document.querySelector('main');
        return Array.from(actions.querySelectorAll('button')).every(button=>{
          const box=button.getBoundingClientRect();return box.top>=0&&box.bottom<=innerHeight;
        })&&document.documentElement.scrollWidth<=innerWidth&&(!main||main.scrollWidth<=main.clientWidth+1);
      `)
      if (!unknownReconciliationFits) return fail('unknown_reconciliation_small_overflow')
      writeFileSync(join(directory, 'workbench-reconciliation-evidence-small.png'), await capture())
      window.setContentSize(900, 720)
      replace('agent-workbench:reconcile', (_event, input) => {
        reconciliationRequest = input
        reconciliationCount++
        row = {
          ...row,
          version: '9'.repeat(64),
          status: 'not_sent',
          reconciliationRequired: false,
          canReconcile: false,
          canRelease: true,
          humanOwned: true
        }
        return { ...reconciliationAck, resolution: 'not_sent', applicationAcknowledged: true }
      })
      const resolutionStillPaused = await ui(`
        const find=()=>Array.from(document.querySelectorAll('.enterprise-task button')).find(button=>button.textContent==='核对发送结果');
        await until(()=>find()?.disabled===false);find().click();
        await until(()=>document.querySelector('.enterprise-workbench [role="status"]')?.textContent.includes('已核实原回复未发送'));
        return document.querySelector('.enterprise-task').textContent.includes('由人工处理')&&
          document.querySelector('.enterprise-workbench [role="status"]').textContent.includes('自动回复仍暂停')&&
          !Array.from(document.querySelectorAll('.enterprise-task button')).some(button=>button.textContent==='核对发送结果');
      `)
      window.setContentSize(860, 640)
      const reconciliationSmallFits = await ui(`
        await until(()=>innerWidth===860&&innerHeight===640);
        const confirm=Array.from(document.querySelectorAll('.enterprise-task button')).find(button=>button.textContent.includes('确认发送'));
        confirm.scrollIntoView({block:'center'});
        const box=confirm.getBoundingClientRect();const main=document.querySelector('main');
        return box.top>=0&&box.bottom<=innerHeight&&document.documentElement.scrollWidth<=innerWidth&&(!main||main.scrollWidth<=main.clientWidth+1);
      `)
      if (
        !evidenceStillBlocked ||
        !resolutionStillPaused ||
        !reconciliationSmallFits ||
        reconciliationCount !== 2 ||
        confirmCount !== 1
      )
        return fail('reconciliation_ui_result_failed')
      writeFileSync(join(directory, 'workbench-reconciliation-result-small.png'), await capture())
      row = {
        ...row,
        version: '8'.repeat(64),
        reconciliationRequired: true,
        canReconcile: true,
        canRelease: false
      }
      replace('agent-workbench:reconcile', (_event, input) => {
        reconciliationRequest = input
        reconciliationCount++
        row = {
          ...row,
          version: '7'.repeat(64),
          reconciliationRequired: false,
          canReconcile: false,
          canRelease: true
        }
        return {
          success: true,
          status: 'request_sealed',
          sealId: 'd3ca50c4-5229-42c0-af6d-b2d78894fd85',
          sealHash: 'b'.repeat(64),
          resolution: 'not_sent',
          applicationAcknowledged: true
        }
      })
      const requestSealUi = await ui(`
        document.querySelector('.enterprise-workbench .enterprise-card-heading button').click();
        const find=()=>Array.from(document.querySelectorAll('.enterprise-task button')).find(button=>button.textContent==='核对发送结果');
        await until(()=>find()?.disabled===false);
        const button=find();button.click();button.click();
        await until(()=>!find()&&document.querySelector('.enterprise-workbench [role="status"]')?.textContent.includes('已核实原回复未发送'));
        const actions=document.querySelector('.enterprise-task > .enterprise-runtime-actions');actions.scrollIntoView({block:'center'});
        return {humanOwned:document.querySelector('.enterprise-task').textContent.includes('由人工处理'),
          stillPaused:document.querySelector('.enterprise-workbench [role="status"]').textContent.includes('自动回复仍暂停'),
          controlsFit:Array.from(actions.querySelectorAll('button')).every(button=>{const b=button.getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight;})&&document.documentElement.scrollWidth<=innerWidth};
      `)
      if (
        !requestSealUi.humanOwned ||
        !requestSealUi.stillPaused ||
        !requestSealUi.controlsFit ||
        reconciliationCount !== 3 ||
        reconciliationRequest.taskId !== 'synthetic-edited-task' ||
        reconciliationRequest.expectedVersion !== '8'.repeat(64) ||
        Object.keys(reconciliationRequest).length !== 2
      )
        return fail('request_seal_ui_result_failed')
      writeFileSync(join(directory, 'workbench-request-seal-result-small.png'), await capture())
      row = {
        ...row,
        version: '7'.repeat(64),
        status: 'needs_human',
        replyText: undefined,
        reviewStatus: undefined,
        explanation: undefined,
        canReview: false,
        canConfirm: false,
        canReadEvidence: false,
        canRelease: false,
        reviewReasons: [
          'model_call_limit_reached',
          'model_call_limit_unconfigured',
          'model_call_record_unavailable'
        ]
      }
      const modelQuotaUi = await ui(`
        document.querySelector('.enterprise-workbench .enterprise-card-heading button').click();
        await until(()=>document.querySelector('.enterprise-task')?.textContent.includes('今日模型请求额度已用完'));
        const task=document.querySelector('.enterprise-task');
        const actions=task.querySelector(':scope > .enterprise-runtime-actions');actions.scrollIntoView({block:'center'});
        const labels=task.textContent.includes('管理员尚未配置模型请求额度')&&task.textContent.includes('模型调用记录未能确认');
        const confirm=Array.from(task.querySelectorAll('button')).find(button=>button.textContent.includes('确认发送'));
        return {labels,sendDisabled:!confirm||confirm.disabled,
          noRawCodes:!task.textContent.includes('model_call_'),
          controlsFit:Array.from(actions.querySelectorAll('button')).every(button=>{const b=button.getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight;})&&document.documentElement.scrollWidth<=innerWidth};
      `)
      if (
        !modelQuotaUi.labels ||
        !modelQuotaUi.sendDisabled ||
        !modelQuotaUi.noRawCodes ||
        !modelQuotaUi.controlsFit
      )
        return fail('model_quota_ui_failed')
      writeFileSync(join(directory, 'workbench-model-quota-small.png'), await capture())
      const reconciliationUi = {
        reconciliationBusy,
        evidenceStillBlocked,
        resolutionStillPaused,
        reconciliationSmallFits,
        unknownReconciliationFits,
        doubleClickBlocked: reconciliationCount === 3,
        requestSealUi,
        requestFields: Object.keys(reconciliationRequest)
      }
      if (unexpectedNetworkRequests !== 0) return fail('desktop_unexpected_network_request')
      done = true
      clearTimeout(timer)
      writeFileSync(
        join(directory, 'result.json'),
        JSON.stringify(
          {
            passed: true,
            electron: process.versions.electron,
            node: process.versions.node,
            softwareRendering: process.env.AUTOREPLY_DESKTOP_SMOKE_SOFTWARE_RENDERING === '1',
            networkAttempts: unexpectedNetworkRequests,
            schemaVersion,
            initial: dto.initial,
            personalUi,
            personalBatchUi,
            foregroundBridgeBlocked: dto.foregroundBridgeBlocked,
            synchronized: dto.synchronized,
            started: dto.started,
            paused: dto.paused,
            privateBridgeBlocked: dto.privateBridgeBlocked,
            controls,
            syntheticControls,
            collectionUi,
            collectionIncompleteUi,
            collectionSmallFits,
            workbench: dto.workbench,
            workbenchBridgeBlocked: dto.workbenchBridgeBlocked,
            workbenchUi,
            modelQuotaUi,
            editBridgeBlocked: dto.editBridgeBlocked,
            editedReviewUi,
            confirmBridgeBlocked: dto.confirmBridgeBlocked,
            evidenceBridgeBlocked: dto.evidenceBridgeBlocked,
            reconciliationBridgeBlocked: dto.reconciliationBridgeBlocked,
            unavailableReconciliation: dto.unavailableReconciliation,
            legacySettingsAvailable: dto.legacySettingsAvailable,
            publishedProviderVerified: dto.publishedProvider.manifest.id,
            publishedProviderLoaded,
            providerInitializationRequests,
            externalProviderInstallRejected: dto.rejectedProviderInstall.success === false,
            legacyStart: dto.legacyStart,
            legacySend: dto.legacySend,
            legacyStop: dto.legacyStop,
            forgedReconciliation: dto.forgedReconciliation,
            assessmentUi,
            assessmentSmallFits,
            referencesUi,
            referencesNext,
            referenceStaleCleared,
            humanConfirmationUi,
            reconciliationUi
          },
          null,
          2
        )
      )
      process.stdout.write(`Desktop smoke passed; report: ${join(directory, 'result.json')}\n`)
      app.quit()
    } catch (error) {
      fail('runtime_or_ipc_failed', error)
    }
  })
})
process.on('uncaughtException', (error) => fail('uncaught_exception', error))
process.on('unhandledRejection', (error) => fail('unhandled_rejection', error))
try {
  require(join(outRoot, 'main', 'index.js'))
} catch (error) {
  fail('main_load_failed', error)
}
