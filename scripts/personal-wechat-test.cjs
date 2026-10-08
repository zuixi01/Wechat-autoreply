/* eslint-disable @typescript-eslint/no-require-imports -- Electron project acceptance entry. */
// Launches the actual project/profile and clicks its own controls. No Codex/Computer Use driver.
const { app } = require('electron')
const { join, resolve } = require('node:path')
const { mkdirSync, writeFileSync, appendFileSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
// GUI launches can outlive the invoking terminal's output pipe.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', () => {})
}
const root = resolve(__dirname, '..'),
  name = require(join(root, 'package.json')).name
app.setAppPath(root)
app.setName(name)
app.setPath('userData', join(app.getPath('appData'), name))
delete process.env.ELECTRON_RENDERER_URL
const directory = join(root, '.local', 'reports', 'personal-wechat', randomUUID())
mkdirSync(directory, { recursive: true })
const providerFetch = globalThis.fetch
globalThis.fetch = async (input, options) => {
  let provider = false
  try {
    provider = new URL(String(input)).hostname === 'router.keenlight.ai'
  } catch {
    /* Non-provider requests are untouched. */
  }
  if (!provider) return providerFetch(input, options)
  const started = Date.now()
  const details = {
    at: started,
    bodyBytes: typeof options?.body === 'string' ? Buffer.byteLength(options.body) : 0
  }
  try {
    const response = await providerFetch(input, options)
    appendFileSync(
      join(directory, 'provider-requests.jsonl'),
      JSON.stringify({ ...details, status: response.status, durationMs: Date.now() - started }) +
        '\n'
    )
    return response
  } catch (error) {
    appendFileSync(
      join(directory, 'provider-requests.jsonl'),
      JSON.stringify({
        ...details,
        error: error.name,
        cause: typeof error.cause?.code === 'string' ? error.cause.code : undefined,
        durationMs: Date.now() - started
      }) + '\n'
    )
    throw error
  }
}
let attached = false,
  timer
const batchTest = process.env.AUTOREPLY_WECHAT_TEST_BATCH === '1'
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    if (attached || window.isDestroyed()) return
    try {
      const isMain = await window.webContents.executeJavaScript(
        'Boolean(document.querySelector("#personal-wechat-target"))'
      )
      if (!isMain) return
      attached = true
      if (!window.isVisible()) {
        await new Promise((resolve) => window.once('ready-to-show', () => setImmediate(resolve)))
      }
      writeFileSync(
        join(directory, 'project-controls.png'),
        (await window.webContents.capturePage()).toPNG()
      )
      await window.webContents.executeJavaScript(`(async()=>{
        const input=document.querySelector(${JSON.stringify(batchTest ? '#personal-wechat-batch-targets' : '#personal-wechat-target')});
        if(input.value!=='Q')throw new Error('test_target_mismatch');
        const section=document.querySelector(${JSON.stringify(batchTest ? '[aria-labelledby="personal-wechat-batch-heading"]' : '[aria-labelledby="personal-wechat-heading"]')});
        let button;
        const deadline=Date.now()+5000;
        do {
          button=Array.from(section.querySelectorAll('button')).find(b=>b.textContent.includes(${JSON.stringify(batchTest ? '启动批量自动回复' : process.env.AUTOREPLY_WECHAT_TEST_CURRENT_CHAT === '1' ? '接入已打开的聊天' : '启动个人微信')}));
          if(button&&!button.disabled)break;
          await new Promise(resolve=>setTimeout(resolve,50));
        } while(Date.now()<deadline);
        if(!button||button.disabled)throw new Error('test_start_unavailable');button.click();
      })()`)
      let reading = false,
        lastStage = ''
      timer = setInterval(async () => {
        if (reading || window.isDestroyed()) return
        reading = true
        try {
          const status = await window.webContents.executeJavaScript(
            batchTest ? 'window.foregroundWechat.batchStatus()' : 'window.foregroundWechat.status()'
          )
          const summary = {
            state: status.state,
            reason: status.reason,
            target: batchTest ? 'Q' : status.target,
            ...(batchTest
              ? {
                  mode: 'batch',
                  discovered: status.discovered,
                  pages: status.pages,
                  pending: status.pending,
                  scanComplete: status.scanComplete,
                  issues: status.issues
                    .filter((issue) => issue.target === 'Q')
                    .map((issue) => ({ target: 'Q', reason: issue.reason }))
                }
              : {}),
            records: status.records.map((r) => ({
              id: r.id,
              state: r.state,
              createdAt: r.createdAt
            })),
            at: Date.now()
          }
          writeFileSync(join(directory, 'status.json'), JSON.stringify(summary, null, 2) + '\n')
          const stage = status.state + ':' + status.reason
          if (stage !== lastStage) {
            lastStage = stage
            process.stdout.write(
              'Project WeChat test: ' +
                stage +
                '; target=' +
                (batchTest ? 'Q' : status.target) +
                '\n'
            )
            if (status.state === 'paused') {
              await window.webContents.executeJavaScript(
                'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
              )
              writeFileSync(
                join(directory, 'project-result.png'),
                (await window.webContents.capturePage()).toPNG()
              )
            }
          }
        } catch {
          process.stderr.write('Project WeChat status unavailable\n')
        } finally {
          reading = false
        }
      }, 2000)
      process.stdout.write('Project WeChat test report: ' + join(directory, 'status.json') + '\n')
    } catch (error) {
      writeFileSync(
        join(directory, 'launch-error.json'),
        JSON.stringify({
          code: /^[a-z_]+$/.test(error.message) ? error.message : 'project_test_launch_failed'
        }) + '\n'
      )
      process.stderr.write('Project WeChat test launch failed: ' + error.message + '\n')
    }
  })
})
app.on('will-quit', () => clearInterval(timer))
require(join(root, 'out', 'main', 'index.js'))
