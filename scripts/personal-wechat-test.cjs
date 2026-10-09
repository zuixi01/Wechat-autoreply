/* eslint-disable @typescript-eslint/no-require-imports -- Real Electron acceptance bootstrap. */
const { app } = require('electron')
const { join, resolve } = require('node:path')
const { mkdirSync, writeFileSync, appendFileSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const root = resolve(__dirname, '..')
const target = process.env.AUTOREPLY_WECHAT_TEST_TARGET?.trim()
if (
  !target ||
  target.length > 128 ||
  Array.from(target).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
)
  throw new Error('explicit_test_target_required')
const timeout = Number(process.env.AUTOREPLY_WECHAT_TEST_TIMEOUT || 180000)
if (!Number.isInteger(timeout) || timeout < 30000 || timeout > 600000)
  throw new Error('test_timeout_invalid')
const expectedReplies = Number(process.env.AUTOREPLY_WECHAT_TEST_REPLIES || 1)
if (!Number.isInteger(expectedReplies) || expectedReplies < 1 || expectedReplies > 10)
  throw new Error('test_replies_invalid')
app.setAppPath(root)
const name = require(join(root, 'package.json')).name
app.setName(name)
app.setPath('userData', join(app.getPath('appData'), name))
delete process.env.ELECTRON_RENDERER_URL
if (
  process.env.AUTOREPLY_WECHAT_TEST_ID &&
  !/^[a-f0-9-]{36}$/.test(process.env.AUTOREPLY_WECHAT_TEST_ID)
)
  throw new Error('test_id_invalid')
const directory = join(
  root,
  '.local',
  'reports',
  'personal-wechat',
  process.env.AUTOREPLY_WECHAT_TEST_ID || randomUUID()
)
mkdirSync(directory, { recursive: true })
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {})
const originalFetch = globalThis.fetch
globalThis.fetch = async (input, options) => {
  const started = Date.now()
  let tracked = false
  try {
    tracked = new URL(String(input)).pathname.endsWith('/chat/completions')
  } catch {
    /* Other requests are unchanged. */
  }
  if (!tracked) return originalFetch(input, options)
  try {
    const response = await originalFetch(input, options)
    appendFileSync(
      join(directory, 'provider-requests.jsonl'),
      JSON.stringify({ at: started, status: response.status, durationMs: Date.now() - started }) +
        '\n'
    )
    return response
  } catch (error) {
    appendFileSync(
      join(directory, 'provider-requests.jsonl'),
      JSON.stringify({
        at: started,
        error: error.name,
        cause: error.cause?.code,
        durationMs: Date.now() - started
      }) + '\n'
    )
    throw error
  }
}
let attached = false,
  timer,
  finished = false
const initialIds = new Set()
const measuredIds = new Set()
const replyDurationsMs = []
async function finish(window, passed, code, status) {
  if (finished) return
  finished = true
  clearInterval(timer)
  await window.webContents.executeJavaScript('window.foregroundWechat.pause()').catch(() => {})
  writeFileSync(
    join(directory, 'result.json'),
    JSON.stringify(
      {
        passed,
        code,
        target,
        realDesktop: true,
        realProvider: true,
        expectedReplies,
        resetBaseline: process.env.AUTOREPLY_WECHAT_TEST_RESET_BASELINE === '1',
        replyDurationsMs,
        performance: status?.performance,
        newSent:
          status?.records.filter(
            (row) => row.target === target && row.state === 'sent' && !initialIds.has(row.id)
          ).length || 0,
        finishedAt: new Date().toISOString()
      },
      null,
      2
    )
  )
  process.stdout.write(
    'Personal WeChat acceptance: ' + code + '; report=' + join(directory, 'result.json') + '\n'
  )
  app.quit()
}
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    if (attached || window.isDestroyed()) return
    try {
      if (
        !(await window.webContents.executeJavaScript(
          'Boolean(document.querySelector("#personal-wechat-target"))'
        ))
      )
        return
      attached = true
      // did-finish-load can precede the main window's first ready-to-show.
      // Wait for that show to finish before focusing WeChat, otherwise it can
      // steal foreground back in the middle of the first screenshot request.
      const visibleDeadline = Date.now() + 10000
      while (!window.isVisible() && Date.now() < visibleDeadline)
        await new Promise((resolve) => setTimeout(resolve, 50))
      if (!window.isVisible()) throw new Error('test_window_not_ready')
      const initial = await window.webContents.executeJavaScript('window.foregroundWechat.status()')
      for (const row of initial.records) initialIds.add(row.id)
      const models = await window.webContents.executeJavaScript(`(async()=>{
        const settings=await window.electron.invoke('settings:getAll');
        const ids=[...new Set([settings.globalVisionModelId,settings.globalReplyModelId].filter(Boolean))];
        if(!ids.length)return false;
        for(const id of ids){if(!(await window.electron.invoke('model:testConnection',id)).success)return false;}
        return true;
      })()`)
      if (!models) return finish(window, false, 'model_connection_failed')
      await window.webContents.executeJavaScript(`(async()=>{
        const preview=${JSON.stringify(process.env.AUTOREPLY_WECHAT_TEST_PENDING_PREVIEW || '')};
        if (preview) return window.foregroundWechat.start({target:${JSON.stringify(target)},foregroundConsent:true,connectionMode:'current_chat',currentChatSelected:true,resetBaseline:true,pendingPreview:preview});
        const input=document.querySelector('#personal-wechat-target');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(target)});
        input.dispatchEvent(new Event('input',{bubbles:true}));
        if (${process.env.AUTOREPLY_WECHAT_TEST_RESET_BASELINE === '1'}) {
          const checkbox = document.querySelector('[aria-labelledby="personal-wechat-heading"] input[type="checkbox"]');
          if (checkbox && !checkbox.checked) checkbox.click();
        }
        const deadline=Date.now()+5000;
        let button;
        do {
          button=Array.from(document.querySelector('[aria-labelledby="personal-wechat-heading"]').querySelectorAll('button')).find(element=>element.textContent.includes(${JSON.stringify(process.env.AUTOREPLY_WECHAT_TEST_CURRENT_CHAT === '1' ? '接入已打开的聊天' : '启动个人微信')}));
          if(button&&!button.disabled&&input.value===${JSON.stringify(target)})break;
          await new Promise(resolve=>setTimeout(resolve,50));
        }while(Date.now()<deadline);
        if(!button||button.disabled)throw new Error('test_start_unavailable');
        button.click();
      })()`)
      const started = Date.now()
      let reading = false,
        lastStage = ''
      timer = setInterval(async () => {
        if (reading || finished || window.isDestroyed()) return
        reading = true
        try {
          const status = await window.webContents.executeJavaScript(
            'window.foregroundWechat.status()'
          )
          const summary = {
            state: status.state,
            reason: status.reason,
            target: status.target,
            recoveryAttempts: status.recoveryAttempts,
            lastReplyDurationMs: status.lastReplyDurationMs,
            performance: status.performance,
            records: status.records.map((row) => ({
              id: row.id,
              state: row.state,
              createdAt: row.createdAt
            })),
            at: Date.now()
          }
          writeFileSync(join(directory, 'status.json'), JSON.stringify(summary, null, 2))
          const stage = status.state + ':' + status.reason
          if (stage !== lastStage) {
            lastStage = stage
            process.stdout.write('Personal WeChat: ' + stage + '; target=' + status.target + '\n')
            appendFileSync(join(directory, 'transitions.jsonl'), JSON.stringify(summary) + '\n')
          }
          const sent = status.records.filter(
            (row) => row.target === target && row.state === 'sent' && !initialIds.has(row.id)
          )
          for (const row of sent)
            if (!measuredIds.has(row.id)) {
              measuredIds.add(row.id)
              replyDurationsMs.push(status.lastReplyDurationMs ?? null)
              process.stdout.write(
                `Personal WeChat confirmed ${measuredIds.size}/${expectedReplies} replies\n`
              )
            }
          if (sent.length >= expectedReplies)
            return finish(
              window,
              true,
              expectedReplies === 1 ? 'reply_echo_verified' : 'consecutive_replies_echo_verified',
              status
            )
          if (status.state === 'paused' && status.reason !== 'user_pause')
            return finish(window, false, status.reason, status)
          if (Date.now() - started > timeout)
            return finish(window, false, 'new_inbound_not_received_or_flow_incomplete', status)
        } catch {
          /* Shutdown can close the renderer between observations. */
        } finally {
          reading = false
        }
      }, 1000)
      process.stdout.write(
        'Personal WeChat waiting for a NEW inbound message from ' +
          target +
          '; report=' +
          join(directory, 'status.json') +
          '\n'
      )
    } catch (error) {
      await finish(
        window,
        false,
        /^[a-z_]+$/.test(error.message) ? error.message : 'test_launch_failed'
      )
    }
  })
})
app.on('will-quit', () => clearInterval(timer))
require(join(root, 'out', 'main', 'index.js'))
