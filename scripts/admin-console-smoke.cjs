/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- synthetic Electron UI fixture. */
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
module.exports = async ({ window, ipcMain, outRoot, directory, capture }) => {
  const observedAt = Date.now()
  const requests = [],
    identity = { tenantId: 'synthetic-company', actorId: 'synthetic-admin' }
  let connected = false,
    latestPause,
    runtimeCalls = 0,
    journalUnavailable = false,
    storageFailure = false,
    denied = false
  const device = {
    accountId: 'synthetic-account',
    employeeId: 'synthetic-employee',
    agentId: 'synthetic-agent',
    platform: 'wework',
    accountEnabled: true,
    employeeEnabled: true,
    serverPaused: false,
    revoked: false,
    configurationVersion: null,
    automaticEnabled: null,
    leaseLive: false,
    leaseAgentId: null,
    freshness: 'recent',
    receivedAt: observedAt,
    observation: null,
    pauseRequestId: null,
    pauseConfirmation: 'pending',
    physicalStopVerified: false,
    canAuthorizeSend: false
  }
  const summary = (id) => ({
    requestId: id,
    actorId: identity.actorId,
    issuedAt: observedAt,
    accountCount: 208,
    activeAccounts: 208,
    outsideAccounts: 0,
    targetCount: 207,
    reportedTargets: 0,
    physicalStopVerified: false,
    canAuthorizeSend: false
  })
  const status = () =>
    connected
      ? {
          connected: true,
          serverUrl: 'https://operator.invalid',
          identity,
          ...(journalUnavailable ? { journalUnavailable: true } : {}),
          ...(latestPause ? { latestPause } : {})
        }
      : { connected: false }
  const replace = (name, handler) => {
    ipcMain.removeHandler(name)
    ipcMain.handle(name, handler)
  }
  replace('admin:status', status)
  replace('admin:connect', (_event, input) => {
    if (input.token !== 'G'.repeat(43) || input.serverUrl !== 'https://operator.invalid')
      throw new Error('synthetic_login_mismatch')
    connected = true
    return { success: true, value: status() }
  })
  replace('admin:disconnect', () => {
    connected = false
    return status()
  })
  replace('admin:runtime', (_event, input) => {
    runtimeCalls++
    if (denied) {
      connected = false
      return { success: false, code: 'denied' }
    }
    return {
      success: true,
      value: {
        serverTime: observedAt + 1000,
        totalDevices: 207,
        revokedDevices: 0,
        rows: [
          {
            ...device,
            agentId: input.after ? 'synthetic-agent-next' : 'synthetic-agent',
            freshness: input.after ? 'stale' : 'recent',
            serverPaused: requests.length > 1
          }
        ],
        nextCursor: input.after ? null : 'synthetic-device-page'
      }
    }
  })
  replace('admin:pause-all', (_event, input) => {
    if (storageFailure)
      return { success: false, code: 'journal_unavailable', requestId: input.requestId }
    requests.push(input.requestId)
    latestPause = { requestId: input.requestId, confirmed: requests.length > 1 }
    return requests.length === 1
      ? { success: false, code: 'operation_unconfirmed' }
      : { success: true, value: summary(input.requestId) }
  })
  replace('admin:pause-summary', (_event, input) => ({
    success: true,
    value: summary(input.requestId)
  }))
  replace('admin:pause-accounts', (_event, input) => ({
    success: true,
    value: {
      summary: summary(input.requestId),
      rows: [
        {
          accountId: input.page.after ? 'synthetic-account-last' : 'synthetic-account-first',
          requestId: input.requestId,
          employeeId: 'synthetic-employee',
          platform: 'wework',
          enabled: true,
          active: true,
          targetCount: 1,
          reportedTargets: 0
        }
      ],
      nextCursor: input.page.after ? null : 'synthetic-account-page'
    }
  }))
  window.setContentSize(1080, 900)
  const load = () =>
    window.loadFile(join(outRoot, 'renderer', 'index.html'), {
      query: { window: 'settings', section: 'enterprise' }
    })
  let uiStep = 0
  const ui = (code) => {
    const step = ++uiStep
    return window.webContents.executeJavaScript(`(async()=>{
    const until=async p=>{const deadline=Date.now()+5000;while(Date.now()<deadline){if(p())return;await new Promise(r=>setTimeout(r,25));}throw new Error('admin_ui_timeout_step_${step}:'+document.querySelector('.admin-console')?.textContent);};
    const panel=()=>document.querySelector('.admin-console');
    const button=text=>Array.from(panel().querySelectorAll('button')).find(b=>b.textContent===text);
    const set=(id,value)=>{const input=document.getElementById(id);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));};
    ${code}
  })()`)
  }
  await load()
  await ui(
    `await until(()=>panel());panel().open=true;set('admin-server','https://operator.invalid');set('admin-token','G'.repeat(43));await until(()=>button('连接管理服务')&&!button('连接管理服务').disabled);button('连接管理服务').click();await until(()=>button('刷新设备状态')&&!button('刷新设备状态').disabled);if(document.getElementById('admin-token'))throw new Error('admin_secret_still_rendered');button('下一页设备').click();await until(()=>panel().textContent.includes('synthetic-agent-next'));`
  )
  await ui(
    `button('暂停本企业全部账号').click();await until(()=>button('重试原暂停批次')&&!button('重试原暂停批次').disabled);if(!panel().querySelector('[role=alert]').textContent.includes('操作未确认'))throw new Error('admin_unknown_hidden');`
  )
  // Remount the actual component while preserving the synthetic main-process session.
  await load()
  latestPause = { ...latestPause, recovered: true }
  await ui(
    `await until(()=>button('重试原暂停批次'));panel().open=true;button('断开管理连接').click();await until(()=>button('连接管理服务')&&!button('连接管理服务').disabled);set('admin-token','G'.repeat(43));await until(()=>document.getElementById('admin-token').value.length===43);button('连接管理服务').click();await until(()=>button('重试原暂停批次')&&!button('重试原暂停批次').disabled);if(!panel().textContent.includes('已恢复此管理员的上次暂停编号'))throw new Error('admin_recovery_notice_missing');`
  )
  if (requests.length !== 1) throw new Error('admin_reconnect_submitted_pause')
  await ui(
    `await until(()=>button('重试原暂停批次'));panel().open=true;if(!document.getElementById('admin-batch-id').value)throw new Error('admin_batch_lost');button('重试原暂停批次').click();await until(()=>button('下一页账号')&&!button('下一页账号').disabled);panel().scrollIntoView({block:'start'});`
  )
  if (requests.length !== 2 || requests[0] !== requests[1])
    throw new Error('admin_retry_changed_batch')
  writeFileSync(join(directory, 'admin-console-paused.png'), await capture())
  await ui(
    `button('下一页账号').click();await until(()=>panel().textContent.includes('synthetic-account-last'));if(button('下一页账号'))throw new Error('admin_terminal_page_has_next');button('返回账号首页').click();await until(()=>panel().textContent.includes('synthetic-account-first'));if(!panel().textContent.includes('尚未验证设备实际停止'))throw new Error('admin_physical_stop_claim');`
  )
  journalUnavailable = true
  storageFailure = true
  latestPause = { ...latestPause, recovered: true }
  await ui(
    `button('断开管理连接').click();await until(()=>button('连接管理服务')&&!button('连接管理服务').disabled);set('admin-token','G'.repeat(43));await until(()=>document.getElementById('admin-token').value.length===43);button('连接管理服务').click();await until(()=>button('核对原暂停批次')&&!button('核对原暂停批次').disabled);if(!panel().textContent.includes('本机暂停记录不可用'))throw new Error('admin_storage_warning_missing');button('核对原暂停批次').click();await until(()=>button('重试原暂停批次')&&!button('重试原暂停批次').disabled);if(!panel().textContent.includes('暂停记录无法保存'))throw new Error('admin_storage_failure_hidden');`
  )
  if (requests.length !== 2) throw new Error('admin_storage_failure_submitted_pause')
  await ui(`panel().scrollIntoView({block:'start'});`)
  writeFileSync(join(directory, 'admin-console-storage-failure.png'), await capture())
  denied = true
  await ui(
    `button('刷新设备状态').click();await until(()=>button('连接管理服务'));if(panel().textContent.includes('synthetic-account-first'))throw new Error('admin_revoked_data_visible');if(!panel().querySelector('[role=alert]').textContent.includes('权限已失效'))throw new Error('admin_revocation_hidden');panel().scrollIntoView({block:'start'});`
  )
  writeFileSync(join(directory, 'admin-console-revoked.png'), await capture())
  return {
    passed: true,
    synthetic: true,
    credentialNotPersisted: true,
    retryBatchUnchanged: true,
    batchSurvivesPanelRemount: true,
    batchRestoredAfterAuthenticatedReconnect: true,
    reconnectDoesNotSubmitPause: true,
    storageFailureVisible: true,
    devicePaging: true,
    accountPaging: true,
    permissionRevocation: true,
    physicalStopVerified: false,
    canAuthorizeSend: false,
    pauseCalls: requests.length,
    runtimeCalls,
    realChatOperations: 0,
    realModelCalls: 0
  }
}
