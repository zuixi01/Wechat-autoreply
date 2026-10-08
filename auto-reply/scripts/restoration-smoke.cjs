/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- Electron CJS test harness. */
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')

// Actual production renderer/preload, synthetic metadata only. Main-process/HTTP
// restoration behavior is verified separately with restored SQLite and PGlite.
module.exports = async ({ window, ipcMain, outRoot, directory, capture }) => {
  const replace = (channel, handler) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, handler)
  }
  let readFails = false
  let state = 'review_required',
    polls = 0,
    submissions = 0,
    resolveSubmission,
    inventorySubmissions = 0,
    resolveInventorySubmission,
    applicationSubmissions = 0,
    resolveApplication
  const scope = {
    tenant_id: 'synthetic-tenant',
    employee_id: 'synthetic-employee',
    account_id: 'synthetic-account',
    agent_id: 'synthetic-agent',
    platform: 'wechat'
  }
  replace('agent:status', () => ({ state: 'registered', scope }))
  replace('agent-runtime:status', () => ({
    state: 'paused',
    reason: 'execution_reconciliation_required',
    lease: 'stopped',
    pauseAcknowledged: true,
    readiness: { registered: true, backgroundRead: false, nonInterferingSend: false }
  }))
  replace('agent-restoration:status', (_event, input) => {
    if (JSON.stringify(input) !== '{}') throw new Error('restoration_renderer_authority')
    polls++
    if (readFails) throw new Error('synthetic_restoration_read_failure')
    return { state }
  })
  replace('agent-restoration:submit-pause', (_event, input) => {
    if (JSON.stringify(input) !== '{}') throw new Error('restoration_renderer_authority')
    submissions++
    return new Promise((resolve) => {
      resolveSubmission = resolve
    })
  })
  replace('agent-restoration:submit-inventory', (_event, input) => {
    if (JSON.stringify(input) !== '{}') throw new Error('restoration_renderer_authority')
    inventorySubmissions++
    return new Promise((resolve) => {
      resolveInventorySubmission = resolve
    })
  })
  replace('agent-restoration:apply-decision', (_event, input) => {
    if (JSON.stringify(input) !== '{}') throw new Error('application_renderer_authority')
    applicationSubmissions++
    return new Promise((resolve) => {
      resolveApplication = resolve
    })
  })
  const ui = async (code) => {
    const result = await window.webContents.executeJavaScript(`(async()=>{
      const until=async predicate=>{const deadline=Date.now()+5000;while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('restoration_ui_timeout');};
      const panel=()=>document.querySelector('[aria-label="恢复记录核对"]');
      const button=()=>panel()?.querySelector('button');
      const inventoryButton=()=>panel()?.querySelectorAll('button')[1];
      const applicationButton=()=>panel()?.querySelectorAll('button')[2];
      const notice=()=>panel()?.querySelector('[role="status"]')?.textContent??'';
      const alert=()=>Array.from(panel()?.querySelectorAll('[role="alert"]')??[]).map(item=>item.textContent).join(' ');
      try{return await(async()=>{${code}})();}catch(error){return{error:error.message};}
    })()`)
    if (result?.error) throw new Error(result.error)
    return result
  }
  const waitForPoll = async () => {
    const before = polls,
      deadline = Date.now() + 5000
    while (polls <= before && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25))
    if (polls <= before) throw new Error('restoration_poll_missing')
    await window.webContents.executeJavaScript('new Promise(resolve=>setTimeout(resolve,100))')
  }
  window.setContentSize(900, 720)
  await window.loadFile(join(outRoot, 'renderer/index.html'), {
    query: { window: 'settings', section: 'enterprise' }
  })
  const privateBridgeBlocked = await ui(
    "try{await window.electron.invoke('agent-restoration:submit-pause',{});return false;}catch{return true;}"
  )
  if (!privateBridgeBlocked) throw new Error('restoration_legacy_bridge_allowed')
  await ui(
    "await until(()=>button()?.disabled===false);button().click();button().click();await until(()=>button()?.textContent==='正在提交…');"
  )
  if (submissions !== 1) throw new Error('restoration_duplicate_submission')
  resolveSubmission({ success: false, code: 'execution_pending' })
  await ui("await until(()=>alert().includes('暂停尚未确认')&&button()?.disabled===false);")
  await waitForPoll()
  if (!(await ui("return alert().includes('暂停尚未确认')&&!notice().includes('已提交');")))
    throw new Error('restoration_failure_erased')
  await ui("panel().scrollIntoView({block:'center'});return true;")
  writeFileSync(join(directory, 'restoration-failed.png'), await capture())
  readFails = true
  await waitForPoll()
  await ui(
    "await until(()=>alert().includes('暂时无法确认恢复状态')&&alert().includes('暂停尚未确认')&&button()?.disabled===true);"
  )
  readFails = false
  await waitForPoll()
  await ui(
    "await until(()=>!alert().includes('暂时无法确认恢复状态')&&alert().includes('暂停尚未确认')&&button()?.disabled===false);"
  )
  await ui('button().click();await until(()=>button()?.disabled===true);')
  const submittedBy = Date.now() + 5000
  while (submissions < 2 && Date.now() < submittedBy)
    await new Promise((resolve) => setTimeout(resolve, 25))
  if (submissions !== 2) throw new Error('restoration_retry_not_received')
  resolveSubmission({
    success: true,
    caseId: 'invalid',
    challengeId: 'invalid',
    reportHash: 'a'.repeat(64),
    status: 'target_pause_report_recorded'
  })
  await ui(
    "await until(()=>alert().includes('提交结果尚未确认')&&button()?.disabled===false);if(notice().includes('已提交'))throw new Error('invalid_receipt_accepted');button().click();await until(()=>button()?.disabled===true);"
  )
  const thirdBy = Date.now() + 5000
  while (submissions < 3 && Date.now() < thirdBy)
    await new Promise((resolve) => setTimeout(resolve, 25))
  if (submissions !== 3) throw new Error('restoration_valid_retry_not_received')
  resolveSubmission({
    success: true,
    caseId: '570eb60f-13ab-47e4-9dd2-caf2d2e3a200',
    challengeId: '0c8be37f-a682-4a7f-8c15-648aa0892b48',
    reportHash: 'a'.repeat(64),
    status: 'target_pause_report_recorded'
  })
  state = 'pause_report_recorded'
  await ui("await until(()=>notice().includes('已提交暂停状态')&&alert()==='');")
  await waitForPoll()
  if (!(await ui("return notice().includes('等待管理员核对')&&button()?.disabled===false;")))
    throw new Error('restoration_receipt_erased')
  writeFileSync(join(directory, 'restoration-recorded.png'), await capture())
  if (
    !(await ui(
      "try{await window.electron.invoke('agent-restoration:submit-inventory',{});return false;}catch{return true;}"
    ))
  )
    throw new Error('inventory_legacy_bridge_allowed')
  await ui(
    'await until(()=>inventoryButton()?.disabled===false);inventoryButton().click();inventoryButton().click();await until(()=>inventoryButton()?.disabled===true);'
  )
  if (inventorySubmissions !== 1) throw new Error('inventory_duplicate_submission')
  resolveInventorySubmission({ success: false, code: 'unavailable' })
  await ui(
    "await until(()=>alert().includes('尚未提交')&&inventoryButton()?.disabled===false);inventoryButton().click();await until(()=>inventoryButton()?.disabled===true);"
  )
  if (inventorySubmissions !== 2) throw new Error('inventory_retry_not_received')
  resolveInventorySubmission({ success: true, canRelease: true })
  await ui(
    "await until(()=>alert().includes('清单接收结果尚未确认')&&inventoryButton()?.disabled===false);if(notice().includes('完整恢复清单已接收'))throw new Error('inventory_invalid_receipt_accepted');inventoryButton().click();await until(()=>inventoryButton()?.disabled===true);"
  )
  if (inventorySubmissions !== 3) throw new Error('inventory_valid_retry_not_received')
  resolveInventorySubmission({
    success: true,
    caseId: '570eb60f-13ab-47e4-9dd2-caf2d2e3a200',
    uploadId: '0c8be37f-a682-4a7f-8c15-648aa0892b48',
    manifestHash: 'a'.repeat(64),
    basisHash: 'b'.repeat(64),
    itemCount: 125,
    pageCount: 2,
    status: 'inventory_received',
    canRelease: false,
    externalEvidenceRequired: true
  })
  state = 'inventory_received'
  await ui(
    "await until(()=>notice().includes('完整恢复清单已接收')&&alert()===''&&inventoryButton()?.disabled===true);"
  )
  await waitForPoll()
  writeFileSync(join(directory, 'restoration-inventory-recorded.png'), await capture())
  if (
    !(await ui(
      "try{await window.electron.invoke('agent-restoration:apply-decision',{});return false;}catch{return true;}"
    ))
  )
    throw new Error('application_legacy_bridge_allowed')
  await ui(
    'await until(()=>applicationButton()?.disabled===false);applicationButton().click();applicationButton().click();await until(()=>applicationButton()?.disabled===true);'
  )
  if (applicationSubmissions !== 1) throw new Error('application_duplicate_submission')
  resolveApplication({ success: true, status: 'quarantine_recorded', canRelease: true })
  await ui(
    "await until(()=>alert().includes('应用结果尚未确认')&&applicationButton()?.disabled===false);if(notice().includes('隔离已完成'))throw new Error('application_invalid_receipt_accepted');applicationButton().click();await until(()=>applicationButton()?.disabled===true);"
  )
  if (applicationSubmissions !== 2) throw new Error('application_retry_missing')
  resolveApplication({ success: true, status: 'quarantine_recorded', canRelease: false })
  state = 'quarantine_recorded'
  await ui(
    "await until(()=>notice().includes('隔离已完成')&&notice().includes('仍需管理员核对')&&alert()===''&&applicationButton()?.disabled===true);"
  )
  await waitForPoll()
  await ui("panel().scrollIntoView({block:'center'});return true;")
  writeFileSync(join(directory, 'restoration-quarantine-recorded.png'), await capture())
  state = 'context_unavailable'
  await waitForPoll()
  await ui("await until(()=>notice().includes('无法核验')&&button()?.disabled===true);")
  window.setContentSize(720, 600)
  await ui("panel().scrollIntoView({block:'center'});return true;")
  writeFileSync(join(directory, 'restoration-unavailable-small.png'), await capture())
  state = 'not_required'
  await waitForPoll()
  await ui('await until(()=>!panel());')
  return {
    passed: true,
    mode: 'restoration',
    source: 'production-renderer-preload-with-synthetic-ipc',
    submissions,
    inventorySubmissions,
    applicationSubmissions,
    applicationRetryAndDuplicateClickChecked: true,
    invalidApplicationReceiptRejected: true,
    historicalQuarantineReceiptVisible: true,
    recoveryRemainsPaused: true,
    completeInventoryReceiptVisible: true,
    invalidInventoryReceiptRejected: true,
    inventoryRetryAndDuplicateClickChecked: true,
    backgroundPollsObserved: polls,
    duplicateClickRejected: true,
    failurePreservedAfterPoll: true,
    historicalReceiptVisibleAfterPoll: true,
    invalidContextBlocksSubmission: true,
    malformedReceiptRejected: true,
    readFailureRecoversWithoutErasingActionError: true,
    absentRestorationHidden: true,
    privateBridgeBlocked,
    chatWindowsRead: false,
    messagesSent: 0,
    providerCalls: 0
  }
}
