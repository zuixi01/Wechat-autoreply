// Real Electron processes, trusted preload/IPC, durable journal and actual SQLite contention.
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, ipcMain } = require('electron')
const { resolve, join, sep } = require('node:path')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { DatabaseSync } = require('node:sqlite')
const root = resolve(__dirname, '..')
const report = resolve(process.env.LEARNING_RESTART_REPORT || '')
const phase = process.env.LEARNING_RESTART_PHASE
if (
  !report.startsWith(join(root, '.local', 'reports', 'learning-restart') + sep) ||
  !['prepare', 'recover'].includes(phase)
)
  throw new Error('invalid_restart_fixture')
mkdirSync(report, { recursive: true })
app.disableHardwareAcceleration()
app.setPath('userData', join(report, 'data'))
app.setAppLogsPath(join(report, 'logs', phase))
delete process.env.ELECTRON_RENDERER_URL
delete process.env.AUTOREPLY_ENABLE_LEGACY_SKILL_SERVER
let request,
  lock,
  started = false
const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) =>
  originalHandle(channel, async (event, ...args) => {
    const result = await listener(event, ...args)
    if (channel === 'learning-submission:submit') request = args[0]
    return result
  })
const timeout = setTimeout(() => {
  process.stderr.write('restart_fixture_timeout\n')
  app.exit(1)
}, 30000)
app.on('will-quit', () => {
  if (lock) {
    lock.exec('ROLLBACK')
    lock.close()
    lock = undefined
  }
  clearTimeout(timeout)
})
app.on('browser-window-created', (_event, window) => {
  window.show = () => {}
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load', async () => {
    if (started) return
    started = true
    try {
      const scope = await window.webContents.executeJavaScript(`(async()=>{
        const until=async p=>{const end=Date.now()+12000;while(Date.now()<end){if(await p())return;await new Promise(r=>setTimeout(r,25))}throw new Error('restart_ui_timeout')};
        await until(()=>document.getElementById('workspace-tab-memory'));document.getElementById('workspace-tab-memory').click();
        await until(()=>document.querySelector('.learning-manual'));
        return (await window.learningMemory.snapshot()).scope;
      })()`)
      if (phase === 'prepare') {
        await window.webContents.executeJavaScript(
          `window.learningMemory.settings({scope:${JSON.stringify(scope)},patch:{mode:'off'}})`
        )
        lock = new DatabaseSync(join(report, 'data', 'worktrace', 'memory', 'learning.sqlite'))
        lock.exec('BEGIN EXCLUSIVE')
        const receipts = await window.webContents.executeJavaScript(`(async()=>{
          const panel=document.querySelector('.learning-panel');panel.querySelector('.learning-manual').open=true;
          for(const [id,value] of [['learning-manual-scenario','重启恢复订单核对'],['learning-manual-guidance','先核对订单号，再查询当前规则。'],['learning-manual-reason','合成重启恢复验收']]){
            const input=document.getElementById(id);const proto=input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));
          }
          await new Promise(r=>requestAnimationFrame(r));[...panel.querySelectorAll('button')].find(e=>e.textContent.trim()==='保存候选方法').click();
          const end=Date.now()+12000;while(Date.now()<end){const rows=await window.learningSubmissions.submissions({scope:${JSON.stringify(scope)}});if(rows.length)return rows;await new Promise(r=>setTimeout(r,25))}
          throw new Error('pending_journal_not_saved');
        })()`)
        if (!request || receipts.length !== 1 || receipts[0].state !== 'pending')
          throw new Error('contention_did_not_leave_durable_pending')
        writeFileSync(
          join(report, 'prepare.json'),
          JSON.stringify(
            {
              passed: true,
              pid: process.pid,
              request,
              receipts,
              provenance: 'actual-SQLite-write-contention'
            },
            null,
            2
          )
        )
      } else {
        const previous = JSON.parse(readFileSync(join(report, 'prepare.json'), 'utf8'))
        if (previous.pid === process.pid) throw new Error('main_process_did_not_restart')
        const recovered = await window.webContents.executeJavaScript(`(async()=>{
          const scope=${JSON.stringify(previous.request.input.scope)},sourceId=${JSON.stringify(previous.request.input.sourceId)};
          const end=Date.now()+12000;while(Date.now()<end){const rows=await window.learningSubmissions.submissions({scope});if(rows.find(row=>row.sourceId===sourceId)?.state==='saved'){
            const before=await window.learningMemory.snapshot({scope});await window.learningSubmissions.submit(${JSON.stringify(previous.request)});const after=await window.learningMemory.snapshot({scope});
            if(before.memories.length!==1||after.memories.length!==1||after.episodes.length!==1||before.memories[0].record.id!==after.memories[0].record.id)throw new Error('restart_duplicated_learning');
            return {receipts:rows,methodId:after.memories[0].record.id,episodes:after.episodes.length};
          }await new Promise(r=>setTimeout(r,25))}throw new Error('restart_pending_not_automatically_recovered');
        })()`)
        writeFileSync(
          join(report, 'recover.json'),
          JSON.stringify(
            {
              passed: true,
              pid: process.pid,
              ...recovered,
              limitations: [
                'synthetic-manual-teaching',
                'local-storage-contention',
                'does-not-prove-automatic-learning-or-business-improvement'
              ]
            },
            null,
            2
          )
        )
      }
      process.stdout.write(JSON.stringify({ passed: true, phase, report }) + '\n')
      app.quit()
    } catch (error) {
      writeFileSync(
        join(report, `${phase}.json`),
        JSON.stringify({ passed: false, message: String(error) }, null, 2)
      )
      process.stderr.write(String(error) + '\n')
      if (lock) {
        lock.exec('ROLLBACK')
        lock.close()
        lock = undefined
      }
      clearTimeout(timeout)
      app.exit(1)
    }
  })
})
require(join(root, 'out', 'main', 'index.js'))
