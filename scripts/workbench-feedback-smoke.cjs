/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- Electron CJS test harness. */
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')

module.exports = async ({ window, ipcMain, outRoot, directory, capture }) => {
  const replace = (channel, handler) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, handler)
  }
  let snapshots = 0,
    readFails = false,
    reconcileFails = false
  let row = {
    taskId: 'synthetic-feedback-task',
    conversationId: '合成反馈会话',
    status: 'unknown',
    version: 'a'.repeat(64),
    inboundPreview: '合成核对问题',
    createdAt: 1000,
    updatedAt: 1000,
    humanOwned: true,
    stopAcknowledged: true,
    canSkip: false,
    canRelease: false,
    reconciliationRequired: true,
    canReconcile: true
  }
  replace('agent-workbench:snapshot', () => {
    snapshots++
    if (readFails) throw new Error('synthetic_read_failure')
    return { state: 'available', rows: [row] }
  })
  replace('agent-workbench:reconcile', () => {
    if (reconcileFails) return { success: false, code: 'execution_pending' }
    row = {
      ...row,
      status: 'not_sent',
      version: 'b'.repeat(64),
      canRelease: true,
      canReconcile: false,
      reconciliationRequired: false
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
  const ui = async (code) => {
    const result = await window.webContents.executeJavaScript(`(async()=>{
      const until=async predicate=>{const deadline=Date.now()+5000;while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('feedback_ui_timeout');};
      const panel=()=>document.querySelector('.enterprise-workbench');
      const refresh=()=>panel().querySelector('.enterprise-card-heading button');
      const reconcile=()=>Array.from(panel().querySelectorAll('button')).find(button=>button.textContent==='核对发送结果');
      const notice=()=>panel().querySelector('[role="status"]')?.textContent??'';
      const alerts=()=>Array.from(panel().querySelectorAll('[role="alert"]')).map(item=>item.textContent).join(' ');
      try{return await(async()=>{${code}})();}catch(error){return{error:error.message};}
    })()`)
    if (result?.error) throw new Error(result.error)
    return result
  }
  const waitForPoll = async () => {
    const before = snapshots,
      deadline = Date.now() + 5000
    while (snapshots <= before && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25))
    if (snapshots <= before) throw new Error('feedback_poll_missing')
    // Let the real IPC response commit in the renderer; do not replace its timer.
    await window.webContents.executeJavaScript('new Promise(resolve=>setTimeout(resolve,100))')
  }
  window.setContentSize(900, 720)
  await window.loadFile(join(outRoot, 'renderer/index.html'), {
    query: { window: 'settings', section: 'enterprise' }
  })
  await ui(
    "await until(()=>reconcile()?.disabled===false);reconcile().click();await until(()=>notice().includes('已核实原回复未发送'));"
  )
  await ui("panel().scrollIntoView({block:'start'});return true;")
  writeFileSync(join(directory, 'feedback-before-poll.png'), await capture())
  await waitForPoll()
  writeFileSync(join(directory, 'feedback-after-poll.png'), await capture())
  if (!(await ui("return notice().includes('已核实原回复未发送')&&!reconcile();")))
    throw new Error('feedback_notice_disappeared_after_poll')
  await ui("refresh().click();await until(()=>notice()===''&&alerts()==='');")
  row = {
    ...row,
    status: 'unknown',
    version: 'c'.repeat(64),
    canRelease: false,
    canReconcile: true,
    reconciliationRequired: true
  }
  reconcileFails = true
  await ui(
    "refresh().click();await until(()=>reconcile()?.disabled===false);reconcile().click();await until(()=>alerts().includes('发送仍在处理中'));"
  )
  await waitForPoll()
  if (!(await ui("return alerts().includes('发送仍在处理中');")))
    throw new Error('feedback_error_disappeared_after_poll')
  readFails = true
  await waitForPoll()
  await ui(
    "await until(()=>alerts().includes('暂时无法读取回复记录')&&alerts().includes('发送仍在处理中'));return true;"
  )
  writeFileSync(join(directory, 'feedback-read-failed.png'), await capture())
  readFails = false
  await waitForPoll()
  await ui(
    "await until(()=>!alerts().includes('暂时无法读取回复记录')&&alerts().includes('发送仍在处理中')&&reconcile()?.disabled===false);return true;"
  )
  await ui("refresh().click();await until(()=>alerts()==='');")
  const paused = await window.webContents.executeJavaScript('window.agentRuntime.status()')
  if (paused.state !== 'paused' || paused.pauseAcknowledged !== true)
    throw new Error('feedback_runtime_changed')
  writeFileSync(join(directory, 'feedback-read-recovered.png'), await capture())
  return {
    passed: true,
    mode: 'workbench-feedback',
    automaticRefreshPreservesNotice: true,
    automaticRefreshPreservesActionError: true,
    manualRefreshClearsFeedback: true,
    readFailureRecovers: true,
    backgroundPollsObserved: snapshots,
    runtimeStillPaused: true,
    chatWindowsRead: false,
    messagesSent: 0,
    providerCalls: 0
  }
}
