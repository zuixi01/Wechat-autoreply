// Actual Electron renderer -> preload -> private IPC -> learning service/storage.
// This first desktop suite covers the management window. It is not business evaluation.
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, ipcMain } = require('electron')
const { join, resolve } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync } = require('node:fs')
const { DatabaseSync } = require('node:sqlite')
const { randomUUID } = require('node:crypto')
const { createServer } = require('node:http')
app.disableHardwareAcceleration()
const root = resolve(__dirname, '..')
const report = join(root, '.local', 'reports', 'learning-smoke', randomUUID())
mkdirSync(report, { recursive: true })
app.setPath('userData', report)
app.setAppLogsPath(join(report, 'logs'))
// Original-format synthetic legacy records, never a fabricated trusted customer binding.
const legacySessionId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-1234abcd`
const legacySessionRoot = join(report, 'worktrace', 'sessions', legacySessionId)
mkdirSync(legacySessionRoot, { recursive: true })
writeFileSync(
  join(legacySessionRoot, 'session.json'),
  JSON.stringify({
    sessionId: legacySessionId,
    appType: 'wechat',
    startedAt: Date.now(),
    engineVersion: 'synthetic-legacy',
    stepCount: 1
  })
)
writeFileSync(
  join(legacySessionRoot, 'trace.jsonl'),
  JSON.stringify({
    sessionId: legacySessionId,
    stepId: randomUUID(),
    seq: 1,
    ts: Date.now(),
    actor: 'agent',
    phase: 'think',
    summary: '合成旧轨迹：核对订单条件'
  }) + '\n'
)
const legacyCard = {
  cardId: randomUUID(),
  scenario: '合成旧卡核对',
  guidance: '先确认订单条件',
  rationale: '合成旧资料',
  source: 'manual',
  evidence: {},
  enabled: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  stats: { used: 0, success: 0 }
}
const legacyCardsPath = join(report, 'worktrace', 'memory', 'cards.json')
mkdirSync(join(report, 'worktrace', 'memory'), { recursive: true })
writeFileSync(legacyCardsPath, JSON.stringify({ version: 1, cards: [legacyCard] }))
delete process.env.ELECTRON_RENDERER_URL
delete process.env.AUTOREPLY_ENABLE_LEGACY_SKILL_SERVER
let started = false
let modelRequests = 0
const model = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    modelRequests++
    const input = JSON.parse(body)
    if (req.headers.authorization !== 'Bearer synthetic-key' || !Array.isArray(input.messages)) {
      res.writeHead(400)
      res.end('{}')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        model: 'synthetic-model',
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: '请提供订单号，我帮您核对。' }
          }
        ]
      })
    )
  })
})
const modelListening = new Promise((resolve) => model.listen(0, '127.0.0.1', resolve))
let heldDetail,
  failAfterManual = false,
  failNextSnapshot = false
const manualInputs = []
let receiptReadFault
const originalHandle = ipcMain.handle.bind(ipcMain)
// Hold/fail transport after the real trusted handler. Do not replace the bridge or data.
ipcMain.handle = (channel, listener) =>
  originalHandle(channel, async (event, ...args) => {
    const value = await listener(event, ...args)
    if (channel === 'learning-submission:receipts' && receiptReadFault) {
      if (receiptReadFault === 'storage_busy')
        return { status: 'unavailable', code: 'storage_busy' }
      throw new Error('synthetic_unknown_receipt_failure')
    }
    if (channel === 'learning-submission:submit' && args[0]?.kind === 'manual') {
      manualInputs.push(args[0].input)
      if (failAfterManual) {
        failAfterManual = false
        failNextSnapshot = true
      }
    }
    if (channel === 'learning:snapshot' && failNextSnapshot) {
      failNextSnapshot = false
      throw new Error('learning_smoke_refresh_failure')
    }
    if (channel === 'learning:detail' && heldDetail) {
      const held = heldDetail
      held.reached()
      await held.wait
      held.returned()
    }
    return value
  })
const timer = setTimeout(() => {
  writeFileSync(
    join(report, 'result.json'),
    JSON.stringify(
      { passed: false, message: 'desktop_timeout', limitations: ['management-window-only'] },
      null,
      2
    )
  )
  process.stderr.write(JSON.stringify({ passed: false, report, message: 'desktop_timeout' }) + '\n')
  app.exit(1)
}, 75000)
app.on('browser-window-created', (_event, window) => {
  window.show = () => {}
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load', async () => {
    if (started) return
    started = true
    try {
      window.setContentSize(1280, 900)
      const result = await window.webContents.executeJavaScript(`(async()=>{
        const scenarios=[];
        if(!window.learningSubmissions || typeof window.learningSubmissions.submit!=='function')throw new Error('durable_learning_bridge_missing');
        const until=async p=>{const end=Date.now()+12000;while(Date.now()<end){if(await p())return;await new Promise(r=>setTimeout(r,25))}throw new Error('learning_ui_timeout:'+document.body.innerText.slice(-2000))};
        const check=(value,reason)=>{if(!value)throw new Error(reason)};
        const panel=()=>document.querySelector('.learning-panel');
        const button=label=>[...panel().querySelectorAll('button')].find(e=>e.textContent.trim()===label);
        const click=async label=>{await until(()=>button(label)&&!button(label).disabled);await new Promise(r=>requestAnimationFrame(r));button(label).click()};
        const fill=(id,value)=>{const e=document.getElementById(id);check(e,'missing_input:'+id);const proto=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:e instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,value);e.dispatchEvent(new Event(e instanceof HTMLSelectElement?'change':'input',{bubbles:true}))};
        await until(()=>document.getElementById('workspace-tab-memory'));
        document.getElementById('workspace-tab-memory').click();
        await until(()=>panel()&&panel().querySelector('select option'));
        check(!!button('校准与验证'),'missing_calibration_validation_controls');
        check(!!button('整理与报告'),'missing_curation_report_controls');
        const scope=(await window.learningMemory.snapshot()).scope;
        await window.learningMemory.settings({scope,patch:{mode:'off'}});
        panel().querySelector('.learning-manual').open=true;
        fill('learning-manual-scenario','隔离报价核对');fill('learning-manual-guidance','先确认型号与数量，再查询当前知识资料。');
        fill('learning-manual-kind','skill');fill('learning-manual-rationale','避免报价前缺少必要条件。');fill('learning-manual-steps','确认型号\\n确认数量');fill('learning-manual-pitfalls','不要直接猜价格');fill('learning-manual-verification','已确认型号和数量');fill('learning-manual-reason','员工明确提供完整处理步骤');
        await click('保存候选方法');
        await until(()=>panel().textContent.includes('隔离报价核对')&&panel().textContent.includes('已保存为候选'));
        let data=await window.learningMemory.snapshot({scope});
        check(data.memories.length===1&&data.episodes.length===1,'manual_not_atomic');
        check(data.memories[0].record.activeRevision===null&&data.memories[0].metrics.adopted===0,'draft_is_not_success');
        check(data.memories[0].record.content.kind==='skill'&&data.memories[0].record.content.steps.join('|')==='确认型号|确认数量'&&data.memories[0].record.content.pitfalls[0]==='不要直接猜价格'&&data.memories[0].record.content.verification[0]==='已确认型号和数量','full_method_content_not_saved');
        check(!!panel().querySelector('[aria-label="学习提交状态"]'),'learning_submission_status_missing');
        const receipts=await window.learningSubmissions.submissions({scope});check(receipts.length===1&&receipts[0].state==='saved'&&receipts[0].kind==='manual','manual_missing_durable_receipt');
        scenarios.push({name:'manual_ui_atomic_candidate',trigger:'UI',passed:true});
        await click('查看版本与来源');await until(()=>panel().querySelector('.learning-version'));
        await click('查看案例');await until(()=>panel().querySelector('[aria-label="方法来源案例"]')?.textContent.includes('员工明确提供完整处理步骤'));
        check(panel().querySelector('[aria-label="方法来源案例"]').textContent.includes('先确认型号与数量'),'actual_source_body_missing');
        scenarios.push({name:'revision_detail_ui',trigger:'UI',passed:true});
        await click('校准与验证');await until(()=>document.getElementById('learning-calibration-json')&&!document.getElementById('learning-calibration-json').disabled&&document.getElementById('learning-calibration-json').value);
        const fixture={cases:[{caseId:'synthetic-case',conversationId:'synthetic-conversation',input:'请报价',expectedMethod:'先确认型号与数量',forbiddenClaims:[],humanLabelled:false,labelOrigin:'synthetic'}]};
        fill('learning-calibration-json',JSON.stringify(fixture));
        check(button('导入校准资料').disabled,'human_confirmation_missing');
        document.getElementById('learning-calibration-confirmed').click();await click('导入校准资料');
        await until(()=>panel().querySelector('[role="alert"]')?.textContent.includes('calibration_human_labels_required'));
        check((await window.learningMemory.calibration({scope})).cases.length===0,'unlabelled_fixture_accepted');
        fixture.cases[0].humanLabelled=true;fixture.cases[0].labelOrigin='human';fill('learning-calibration-json',JSON.stringify(fixture));await click('导入校准资料');
        await until(()=>panel().textContent.includes('校准资料已保存'));
        check((await window.learningMemory.calibration({scope})).cases.length===1,'calibration_not_persisted');
        fill('learning-mode','suggest');await until(async()=> (await window.learningMemory.snapshot({scope})).settings.mode==='suggest');
        await click('验证 V1');await until(()=>panel().textContent.includes('证据不足'));
        check((await window.learningMemory.snapshot({scope})).memories[0].record.activeRevision===null,'synthetic_evidence_activated');
        scenarios.push({name:'calibration_ui_and_insufficient_validation',trigger:'UI',passed:true,provenance:'synthetic-fixture-simulated-labels'});
        await click('整理与报告');await until(()=>button('预览整理'));
        await click('预览整理');await until(()=>panel().textContent.includes('整理预览'));
        await click('执行整理');await until(()=>panel().textContent.includes('整理报告'));
        const reports=await window.learningMemory.reports({scope});
        check(reports.curation.length>0,'curation_report_not_saved');
        scenarios.push({name:'curation_preview_and_report_ui',trigger:'UI',passed:true});
        await click('案例与纠正');fill('learning-case-query','隔离报价核对');await click('搜索案例');
        await until(()=>panel().textContent.includes('搜索结果：1'));
        check(!panel().querySelector('.learning-correction'),'manual_case_not_production_feedback');
        scenarios.push({name:'history_search_ui',trigger:'UI',passed:true});
        await click('经验与版本');
        const select=document.getElementById('learning-scope');
        const other=[...select.options].find(e=>JSON.parse(e.value).platform!==scope.platform);
        fill('learning-scope',other.value);await until(()=>panel().textContent.includes('此范围还没有方法'));
        check(!panel().querySelector('.learning-version')&&!panel().textContent.includes('先确认型号与数量，再查询'),'scope_clears_private_content');
        fill('learning-scope',JSON.stringify(scope));await until(()=>panel().querySelector('.learning-card'));
        scenarios.push({name:'scope_switch_ui',trigger:'UI',passed:true});
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        return {scenarios,scope,methodId:data.memories[0].record.id,limitations:['management-window-only','no-real-business-labels','enterprise-publication-and-learning-loop-pending']};
      })()`)
      let reached, release, returned
      const detailReached = new Promise((resolve) => {
        reached = resolve
      })
      const detailReturned = new Promise((resolve) => {
        returned = resolve
      })
      heldDetail = {
        reached,
        returned,
        wait: new Promise((resolve) => {
          release = resolve
        })
      }
      await window.webContents.executeJavaScript(
        `(()=>{const panel=document.querySelector('.learning-panel');[...panel.querySelectorAll('button')].find(e=>e.textContent.trim()==='查看版本与来源').click()})()`
      )
      await Promise.race([
        detailReached,
        new Promise((_, reject) => setTimeout(() => reject(new Error('detail_not_held')), 12000))
      ])
      const otherScope = await window.webContents.executeJavaScript(`(async()=>{
        const select=document.getElementById('learning-scope');const other=[...select.options].find(e=>JSON.parse(e.value).platform!=='${result.scope.platform}');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,other.value);select.dispatchEvent(new Event('change',{bubbles:true}));
        const end=Date.now()+12000;while(Date.now()<end){if(document.querySelector('.learning-panel').textContent.includes('此范围还没有方法'))return JSON.parse(other.value);await new Promise(r=>setTimeout(r,25))}throw new Error('late_detail_scope_change_timeout');
      })()`)
      release()
      await detailReturned
      heldDetail = undefined
      await window.webContents.executeJavaScript(`(async()=>{
        await window.learningMemory.snapshot({scope:${JSON.stringify(otherScope)}});
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        if(document.querySelector('.learning-version')||document.querySelector('.learning-panel').textContent.includes('先确认型号与数量，再查询'))throw new Error('late_detail_crossed_scope');
        const select=document.getElementById('learning-scope');const option=[...select.options].find(e=>JSON.parse(e.value).platform==='${result.scope.platform}');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,option.value);select.dispatchEvent(new Event('change',{bubbles:true}));
        const end=Date.now()+12000;while(Date.now()<end){if(document.querySelector('.learning-panel .learning-card'))return;await new Promise(r=>setTimeout(r,25))}throw new Error('scope_return_timeout');
      })()`)
      result.scenarios.push({
        name: 'held_actual_detail_rejected_after_scope_switch',
        trigger: 'UI-with-IPC-transport-delay',
        passed: true
      })
      failAfterManual = true
      await window.webContents.executeJavaScript(`(async()=>{
        const panel=()=>document.querySelector('.learning-panel');panel().querySelector('.learning-manual').open=true;
        for(const [id,value] of [['learning-manual-scenario','隔离保存确认'],['learning-manual-guidance','确认资料保存后再刷新显示。'],['learning-manual-reason','员工确认保存后的刷新不会重复学习']]){
          const e=document.getElementById(id);Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}));
        }
        await new Promise(r=>requestAnimationFrame(r));[...panel().querySelectorAll('button')].find(e=>e.textContent.trim()==='保存候选方法').click();
        const end=Date.now()+12000;while(Date.now()<end){if(panel().textContent.includes('已保存为候选')&&panel().textContent.includes('learning_smoke_refresh_failure'))break;await new Promise(r=>setTimeout(r,25))}
        if(!panel().textContent.includes('已保存为候选')||!panel().textContent.includes('learning_smoke_refresh_failure'))throw new Error('saved_ack_lost_on_refresh_failure');
        const data=await window.learningMemory.snapshot({scope:${JSON.stringify(result.scope)}});if(data.memories.length!==2||data.episodes.length!==2)throw new Error('saved_refresh_failure_duplicated_submission');
        [...panel().querySelectorAll('button')].find(e=>e.textContent.trim()==='刷新').click();
        while(Date.now()<end){if(panel().querySelectorAll('.learning-card > header').length===2)return;await new Promise(r=>setTimeout(r,25))}throw new Error('refresh_recovery_failed');
      })()`)
      if (manualInputs.length !== 2) throw new Error('refresh_retried_confirmed_manual')
      result.scenarios.push({
        name: 'saved_manual_survives_snapshot_transport_failure',
        trigger: 'UI-with-IPC-transport-failure',
        passed: true
      })
      writeFileSync(
        join(report, 'learning-window.png'),
        (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG()
      )
      window.setContentSize(920, 820)
      await window.webContents.executeJavaScript(
        'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'
      )
      const overflow = await window.webContents.executeJavaScript(
        'document.documentElement.scrollWidth>document.documentElement.clientWidth'
      )
      if (overflow) throw new Error('compact_horizontal_overflow')
      writeFileSync(
        join(report, 'learning-compact.png'),
        (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG()
      )
      const lastManual = manualInputs[manualInputs.length - 1]
      const reloaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
      window.webContents.reload()
      await reloaded
      await window.webContents.executeJavaScript(`(async()=>{
        const end=Date.now()+12000;while(Date.now()<end&&!document.getElementById('workspace-tab-memory'))await new Promise(r=>setTimeout(r,25));
        document.getElementById('workspace-tab-memory').click();
        while(Date.now()<end&&!document.querySelector('[aria-label="学习提交状态"]'))await new Promise(r=>setTimeout(r,25));
        const receipts=await window.learningSubmissions.submissions({scope:${JSON.stringify(result.scope)}});
        if(receipts.length!==2||receipts.some(value=>value.state!=='saved'))throw new Error('renderer_reload_lost_submission_receipts');
        const data=await window.learningMemory.snapshot({scope:${JSON.stringify(result.scope)}});if(data.memories.length!==2||data.episodes.length!==2)throw new Error('renderer_reload_duplicated_learning');
      })()`)
      result.scenarios.push({
        name: 'durable_receipts_survive_renderer_reload',
        trigger: 'actual-renderer-reload',
        passed: true
      })
      await window.webContents.executeJavaScript(`(async()=>{
        const end=Date.now()+12000;while(Date.now()<end&&document.querySelectorAll('.learning-submissions li').length!==2)await new Promise(r=>setTimeout(r,25));
        if(document.querySelectorAll('.learning-submissions li').length!==2)throw new Error('confirmed_receipts_not_displayed');
      })()`)
      receiptReadFault = 'storage_busy'
      await window.webContents.executeJavaScript(`(async()=>{
        const result=await window.learningSubmissions.readSubmissions({scope:${JSON.stringify(result.scope)}});
        if(result.status!=='unavailable'||result.code!=='storage_busy')throw new Error('plain_transient_result_lost_across_bridge');
        [...document.querySelector('.learning-panel').querySelectorAll('button')].find(e=>e.textContent.trim()==='刷新').click();
        const end=Date.now()+12000;while(Date.now()<end&&!document.querySelector('.learning-submissions').textContent.includes('上次已确认'))await new Promise(r=>setTimeout(r,25));
        if(document.querySelectorAll('.learning-submissions li').length!==2||!document.querySelector('.learning-submissions').textContent.includes('上次已确认'))throw new Error('transient_receipt_failure_lost_confirmed_rows');
      })()`)
      receiptReadFault = 'unknown'
      await window.webContents.executeJavaScript(`(async()=>{
        [...document.querySelector('.learning-panel').querySelectorAll('button')].find(e=>e.textContent.trim()==='刷新').click();
        const end=Date.now()+12000;while(Date.now()<end&&document.querySelectorAll('.learning-submissions li').length)await new Promise(r=>setTimeout(r,25));
        if(document.querySelectorAll('.learning-submissions li').length)throw new Error('unknown_receipt_failure_retained_private_rows');
      })()`)
      receiptReadFault = undefined
      await window.webContents.executeJavaScript(`(async()=>{
        [...document.querySelector('.learning-panel').querySelectorAll('button')].find(e=>e.textContent.trim()==='刷新').click();
        const end=Date.now()+12000;while(Date.now()<end&&document.querySelectorAll('.learning-submissions li').length!==2)await new Promise(r=>setTimeout(r,25));
        if(document.querySelectorAll('.learning-submissions li').length!==2)throw new Error('receipt_read_recovery_failed');
      })()`)
      result.scenarios.push({
        name: 'strict_receipt_result_retains_confirmed_only_on_transient_and_recovers',
        trigger: 'actual-IPC-preload-contextBridge-and-UI',
        passed: true
      })
      await window.webContents.executeJavaScript(`(async()=>{
        const panel=()=>document.querySelector('.learning-panel');
        const draft=document.getElementById('learning-manual-guidance');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(draft,'隔离客户的待遗忘私密草稿');draft.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>requestAnimationFrame(r));
        const details=[...panel().querySelectorAll('details')].find(e=>e.querySelector('summary').textContent==='遗忘当前范围的全部学习资料');details.open=true;
        details.querySelector('input[type="checkbox"]').click();await new Promise(r=>requestAnimationFrame(r));details.querySelector('button').click();
        const end=Date.now()+12000;while(Date.now()<end){if(panel().textContent.includes('当前范围的学习资料已遗忘'))break;await new Promise(r=>setTimeout(r,25))}
        const data=await window.learningMemory.snapshot({scope:${JSON.stringify(result.scope)}});
        const visibleDraft=document.getElementById('learning-manual-guidance');if(visibleDraft&&visibleDraft.value)throw new Error('forgotten_private_editor_survived');
        if(data.memories.length||data.episodes.length||(await window.learningMemory.searchEpisodes({scope:${JSON.stringify(result.scope)},query:'隔离',limit:10})).length)throw new Error('forgotten_private_content_survived');
        let rejected=false;try{await window.learningMemory.manual(${JSON.stringify(lastManual)})}catch(error){rejected=String(error).includes('episode_forgotten')}
        if(!rejected)throw new Error('forgotten_submission_resurrected');
        let durableRejected=false;try{await window.learningSubmissions.submit({kind:'manual',input:${JSON.stringify(lastManual)}})}catch(error){durableRejected=String(error).includes('learning_submission_forgotten')}
        if(!durableRejected)throw new Error('forgotten_durable_submission_resurrected');
      })()`)
      result.scenarios.push({
        name: 'scope_forget_ui_and_old_manual_replay_denied',
        trigger: 'UI-plus-actual-IPC-replay',
        passed: true
      })
      await modelListening
      const generated = await window.webContents.executeJavaScript(`(async()=>{
        const model=await window.electron.invoke('model:create',{name:'隔离学习模型',provider:'custom',modelName:'synthetic-model',apiKey:'synthetic-key',baseURL:'http://127.0.0.1:${model.address().port}/v1',capabilities:['text']});
        const mode=await window.electron.invoke('mode:create',{name:'隔离学习规则',prompt:'先询问订单号，再核对订单状态。'});
        const object=await window.electron.invoke('object:create',mode.mode.id,{name:'隔离客户',title:'隔离客户',relationship:'合成验收',autoReply:false});
        if(!model.success||!mode.success||!object.success)throw new Error('learning_reply_setup_failed');
        await window.electron.invoke('settings:set',{globalReplyModelId:model.model.id,globalDefaultModeId:mode.mode.id});
        await window.knowledge.save({name:'隔离退款说明',category:'合成验收',content:'隔离退款请求应核对订单号和购买时间，然后检查当前订单状态。'});
        const parent={workspaceId:${JSON.stringify(result.scope.workspaceId)},platform:'generic'};
        await window.learningMemory.settings({scope:parent,patch:{mode:'off'}});
        const answer=await window.knowledge.answer({question:'隔离退款应该提供什么？',modeId:mode.mode.id,objectId:object.object.id});
        if(!answer.learning||answer.text!=='请提供订单号，我帮您核对。')throw new Error('actual_reply_not_captured');
        const data=await window.learningMemory.snapshot({scope:answer.learning.scope});
        if(data.episodes.length!==1||data.episodes[0].outcome!=='unknown')throw new Error('generated_draft_claimed_success');
        return answer.learning;
      })()`)
      await window.webContents.executeJavaScript(`(async()=>{
        const until=async p=>{const end=Date.now()+12000;while(Date.now()<end){if(await p())return;await new Promise(r=>setTimeout(r,25))}throw new Error('feedback_ui_timeout:'+document.body.innerText.slice(-1400))};
        const panel=()=>document.querySelector('.learning-panel');
        const click=async(label,root=panel())=>{await until(()=>[...root.querySelectorAll('button')].some(e=>e.textContent.trim()===label&&!e.disabled));await new Promise(r=>requestAnimationFrame(r));[...root.querySelectorAll('button')].find(e=>e.textContent.trim()===label).click()};
        const fill=(e,value)=>{Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLSelectElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event(e instanceof HTMLSelectElement?'change':'input',{bubbles:true}))};
        await click('刷新');
        await until(()=>[...document.getElementById('learning-scope').options].some(e=>JSON.parse(e.value).conversationId===${JSON.stringify(generated.scope.conversationId)}));
        const option=[...document.getElementById('learning-scope').options].find(e=>JSON.parse(e.value).conversationId===${JSON.stringify(generated.scope.conversationId)});fill(document.getElementById('learning-scope'),option.value);
        await until(()=>panel().textContent.includes('此范围还没有方法'));await click('案例与纠正');
        const article=()=>panel().querySelector('[data-learning-episode="${generated.episodeId}"]');
        await until(()=>article()?.querySelector('.learning-correction'));
        const correction=article().querySelector('.learning-correction');correction.open=true;
        fill(correction.querySelectorAll('textarea')[0],'请先提供订单号和购买时间，我会核对订单状态。');fill(correction.querySelectorAll('textarea')[1],'原草稿遗漏购买时间，先确认再查订单。');
        await click('保存纠正并学习',correction);await until(()=>correction.textContent.includes('纠正已保存'));
        const feedback=article().querySelector('.learning-feedback');feedback.open=true;fill(feedback.querySelector('textarea'),'员工已核对并明确采纳此回复。');
        await click('记录质量反馈',feedback);await until(()=>feedback.textContent.includes('反馈已保存'));
        fill(feedback.querySelector('textarea'),'人工确认已完成订单状态核对。');fill(feedback.querySelectorAll('select')[0],'resolved');
        await click('记录处理结果',feedback);await until(()=>feedback.textContent.includes('处理结果已保存'));
        const data=await window.learningMemory.snapshot({scope:${JSON.stringify(generated.scope)}});
        if(!data.episodes.some(e=>e.correction==='请先提供订单号和购买时间，我会核对订单状态。')||!data.episodes.some(e=>e.outcome==='resolved'))throw new Error('real_feedback_not_persisted');
      })()`)
      if (modelRequests !== 1) throw new Error('feedback_triggered_unexpected_model_requests')
      result.scenarios.push({
        name: 'actual_generated_case_correction_adoption_result_ui',
        trigger: 'UI-with-real-knowledge-generation-setup',
        passed: true,
        provenance: 'synthetic-model-and-customer'
      })
      await window.webContents.executeJavaScript(`(async()=>{
        const settings=document.getElementById('learning-settings');
        if(!settings||!document.getElementById('learning-review-model')||!document.getElementById('learning-daily-budget')||!document.getElementById('learning-retention-days'))throw new Error('missing_review_settings_controls');
        settings.open=true;
        const until=async p=>{const end=Date.now()+12000;while(Date.now()<end){if(await p())return;await new Promise(r=>setTimeout(r,25))}throw new Error('settings_ui_timeout:'+settings.innerText)};
        const click=async label=>{await until(()=>[...settings.querySelectorAll('button')].some(e=>e.textContent.trim()===label&&!e.disabled));[...settings.querySelectorAll('button')].find(e=>e.textContent.trim()===label).click();await new Promise(r=>requestAnimationFrame(r))};
        const fill=(e,value)=>{Object.getOwnPropertyDescriptor(e instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event(e instanceof HTMLSelectElement?'change':'input',{bubbles:true}))};
        await click('刷新模型目录');
        await until(()=>[...document.getElementById('learning-review-model').options].some(e=>e.textContent==='隔离学习模型'));
        const selected=[...document.getElementById('learning-review-model').options].find(e=>e.textContent==='隔离学习模型');
        const directory=await window.learningMemory.modelDirectory({scope:${JSON.stringify(generated.scope)}});
        if(directory.length!==1||directory[0].id!==selected.value||Object.keys(directory[0]).sort().join(',')!=='id,label')throw new Error('model_directory_leaked_or_mismatched');
        fill(document.getElementById('learning-review-model'),selected.value);fill(document.getElementById('learning-daily-budget'),'0');fill(document.getElementById('learning-retention-days'),'7');
        await click('保存复盘设置');await until(()=>settings.textContent.includes('复盘设置已保存'));
        const data=await window.learningMemory.snapshot({scope:${JSON.stringify(generated.scope)}});
        if(data.settings.reviewModelId!==selected.value||data.settings.dailyReviewTokenBudget!==0||data.settings.caseRetentionDays!==7)throw new Error('review_settings_not_persisted');
        await until(()=>document.getElementById('learning-review-model').value===selected.value&&document.getElementById('learning-daily-budget').value==='0'&&document.getElementById('learning-retention-days').value==='7');
        fill(document.getElementById('learning-daily-budget'),'12345');
        await new Promise(r=>setTimeout(r,5200));
        if(document.getElementById('learning-daily-budget').value!=='12345')throw new Error('snapshot_poll_overwrote_unsaved_settings');
        fill(document.getElementById('learning-daily-budget'),'0');
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      })()`)
      result.scenarios.push({
        name: 'host_model_directory_and_review_budget_retention_ui',
        trigger: 'UI-with-actual-host-model-configuration',
        passed: true
      })
      writeFileSync(
        join(report, 'learning-settings.png'),
        (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG()
      )
      result.modelRequests = modelRequests
      result.manualRevision = await window.webContents.executeJavaScript(`(async()=>{
        const panel=()=>document.querySelector('.learning-panel');
        const until=async p=>{const end=Date.now()+12000;while(Date.now()<end){if(await p())return;await new Promise(r=>setTimeout(r,25))}throw new Error('revision_ui_timeout:'+panel().innerText.slice(-1400))};
        const click=async(label,root=panel)=>{await until(()=>[...root().querySelectorAll('button')].some(e=>e.textContent.trim()===label&&!e.disabled));await new Promise(r=>requestAnimationFrame(r));[...root().querySelectorAll('button')].find(e=>e.textContent.trim()===label).click()};
        const fill=(id,value)=>{const e=document.getElementById(id);if(!e)throw new Error('missing_revision_input:'+id);Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:e instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event(e instanceof HTMLSelectElement?'change':'input',{bubbles:true}))};
        const data=()=>window.learningMemory.snapshot({scope:${JSON.stringify(generated.scope)}});
        await click('经验与版本');await until(()=>document.getElementById('learning-manual-reason'));
        panel().querySelector('.learning-manual').open=true;
        fill('learning-manual-scenario','隔离修订核对');fill('learning-manual-guidance','先核对订单号');fill('learning-manual-steps','核对订单号');fill('learning-manual-reason','员工明确教导核对顺序');
        await click('保存候选方法');
        const card=()=>[...panel().querySelectorAll('.learning-card')].find(e=>e.querySelector('header strong')?.textContent==='隔离修订核对');
        await until(()=>card());await click('核对后使 V1 生效',card);
        await until(async()=> (await data()).memories.some(e=>e.record.activeRevision===1));
        await click('查看版本与来源',card);await until(()=>card().querySelector('.learning-method-edit'));
        card().querySelector('.learning-method-edit').open=true;
        fill('learning-revise-guidance','先核对订单号，再核对购买时间');fill('learning-revise-steps','核对订单号\\n核对购买时间');fill('learning-revise-pitfalls','不要遗漏购买时间');fill('learning-revise-verification','订单号和购买时间均已确认');fill('learning-revise-reason','员工修正遗漏的核对条件');
        await click('保存修订候选',card);await until(()=>panel().textContent.includes('修订已保存为候选'));
        let current=(await data()).memories[0].record;
        if(current.currentRevision!==2||current.activeRevision!==1||current.content.steps.length!==2||current.content.pitfalls[0]!=='不要遗漏购买时间')throw new Error('pending_revision_overrode_active_method');
        await click('核对后使 V2 生效',card);await until(async()=> (await data()).memories[0].record.activeRevision===2);
        await click('查看版本与来源',card);await until(()=>card().querySelectorAll('.learning-version').length===2);
        await click('恢复 V1 的内容',card);await until(async()=> (await data()).memories[0].record.currentRevision===3);
        current=(await data()).memories[0].record;
        if(current.activeRevision!==3||current.content.guidance!=='先核对订单号'||current.content.steps.join('|')!=='核对订单号')throw new Error('human_rollback_did_not_restore_content');
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        return {memoryId:current.id,currentRevision:current.currentRevision,activeRevision:current.activeRevision,trigger:'human-activation-synthetic-case'};
      })()`)
      result.scenarios.push({
        name: 'full_manual_revision_pending_active_version_and_rollback_ui',
        trigger: 'UI-with-human-activation',
        passed: true,
        provenance: 'synthetic-fixture'
      })
      const legacyTeaching = await window.webContents.executeJavaScript(`(async()=>{
        const until=async p=>{const end=Date.now()+12000;while(Date.now()<end){if(await p())return;await new Promise(r=>setTimeout(r,25))}throw new Error('legacy_teaching_ui_timeout')};
        const click=async label=>{await until(()=>[...document.querySelectorAll('button')].some(e=>e.textContent.trim()===label&&!e.disabled));[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===label&&!e.disabled).click();await new Promise(r=>requestAnimationFrame(r))};
        const fill=(e,value)=>{Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:e instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event(e instanceof HTMLSelectElement?'change':'input',{bubbles:true}))};
        await click('执行轨迹');await until(()=>document.querySelector('.step-detail'));
        await click('纠正这一步 → 沉淀为经验');await until(()=>document.querySelector('.correction-form'));
        const form=document.querySelector('.correction-form');const inputs=form.querySelectorAll('input');fill(inputs[0],'合成旧轨迹新教导');fill(form.querySelector('textarea'),'先询问订单条件，不直接承诺退款');fill(inputs[1],'员工复核旧轨迹内容');
        await click('转到新教导并核对范围');await until(()=>document.getElementById('learning-draft-scope'));
        if(document.getElementById('learning-manual-scenario'))throw new Error('legacy_draft_auto_assigned_scope');
        const selection=document.getElementById('learning-draft-scope');const choice=[...selection.options].find(e=>e.value);if(!choice)throw new Error('missing_authorized_teaching_scope');fill(selection,choice.value);
        await until(()=>document.getElementById('learning-draft-scope-confirm'));
        const save=()=>[...document.querySelector('.learning-panel').querySelectorAll('button')].find(e=>e.textContent.trim()==='保存候选方法');
        if(!save()?.disabled)throw new Error('legacy_draft_ignored_explicit_confirmation');
        document.getElementById('learning-draft-scope-confirm').click();await new Promise(r=>requestAnimationFrame(r));await click('保存候选方法');
        const scope=JSON.parse(document.getElementById('learning-scope').value);await until(async()=>(await window.learningMemory.snapshot({scope})).memories.some(e=>e.record.content.scenario==='合成旧轨迹新教导'));
        const data=await window.learningMemory.snapshot({scope});const method=data.memories.find(e=>e.record.content.scenario==='合成旧轨迹新教导').record;
        if(method.state!=='pending'||method.activeRevision!==null)throw new Error('legacy_teaching_auto_activated');
        const receipts=await window.learningSubmissions.submissions({scope});if(!receipts.some(e=>e.kind==='manual'&&e.state==='saved'))throw new Error('legacy_teaching_missing_durable_receipt');
        await until(()=>[...document.querySelectorAll('button')].some(e=>e.textContent.trim().startsWith('旧经验卡片')));[...document.querySelectorAll('button')].find(e=>e.textContent.trim().startsWith('旧经验卡片')).click();await until(()=>document.querySelector('.memory-cards-view'));
        const cards=document.querySelector('.memory-cards-view');if([...cards.querySelectorAll('button')].some(e=>['启用','停用','删除'].includes(e.textContent.trim())))throw new Error('legacy_cards_still_mutable');
        await click('移入新教导流程');await until(()=>document.getElementById('learning-draft-scope'));
        if(document.getElementById('learning-draft-scope').value||document.getElementById('learning-manual-scenario'))throw new Error('copied_legacy_card_skipped_scope_confirmation');
        await click('取消旧资料教导');return {pending:true,explicitScope:true,durableReceipt:true};
      })()`)
      if (JSON.parse(readFileSync(legacyCardsPath, 'utf8')).cards[0].cardId !== legacyCard.cardId)
        throw new Error('legacy_card_data_not_preserved')
      result.scenarios.push({
        name: 'legacy_trace_and_card_enter_authorized_durable_candidate_flow',
        trigger: 'actual-legacy-files-and-UI',
        passed: true,
        ...legacyTeaching
      })
      const auditDb = new DatabaseSync(join(report, 'worktrace', 'memory', 'learning.sqlite'), {
        readOnly: true
      })
      try {
        const hostAudit = auditDb.prepare('SELECT * FROM learning_host_model_audit').all()
        const settingsAudit = auditDb.prepare('SELECT * FROM learning_settings_audit').all()
        if (!hostAudit.some((row) => row.state === 'applied') || !settingsAudit.length)
          throw new Error('actual_model_configuration_audit_missing')
        const safeAudit = JSON.stringify([hostAudit, settingsAudit])
        if (safeAudit.includes('synthetic-key') || safeAudit.includes('http://127.0.0.1'))
          throw new Error('model_audit_leaked_credential_or_endpoint')
        result.scenarios.push({
          name: 'actual_host_and_learning_model_configuration_audit',
          trigger: 'actual-IPC-settings-and-SQLite',
          passed: true
        })
      } finally {
        auditDb.close()
      }
      writeFileSync(
        join(report, 'learning-revision.png'),
        (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG()
      )
      writeFileSync(
        join(report, 'learning-feedback.png'),
        (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG()
      )
      writeFileSync(
        join(report, 'result.json'),
        JSON.stringify({ passed: true, ...result }, null, 2)
      )
      process.stdout.write(
        JSON.stringify({ passed: true, report, scenarios: result.scenarios.length }) + '\n'
      )
      clearTimeout(timer)
      model.close()
      app.exit(0)
    } catch (error) {
      const diagnostics = await window.webContents
        .executeJavaScript(
          '({text:document.body.innerText.slice(-2200),calibrationText:document.getElementById("learning-calibration-json")?.value})'
        )
        .catch(() => undefined)
      writeFileSync(
        join(report, 'result.json'),
        JSON.stringify(
          {
            passed: false,
            message: String(error),
            diagnostics,
            limitations: ['management-window-only']
          },
          null,
          2
        )
      )
      process.stderr.write(JSON.stringify({ passed: false, report, message: String(error) }) + '\n')
      try {
        writeFileSync(
          join(report, 'failed.png'),
          (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG()
        )
      } catch (captureError) {
        process.stderr.write('failure_capture:' + String(captureError) + '\n')
      }
      clearTimeout(timer)
      model.close()
      app.exit(1)
    }
  })
})
require(join(root, 'out', 'main', 'index.js'))
