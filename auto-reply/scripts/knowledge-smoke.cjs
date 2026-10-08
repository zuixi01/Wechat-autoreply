// Real desktop UI/private IPC with isolated data and a synthetic loopback model.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { app } = require('electron')
const { createServer } = require('node:http')
const { join, resolve } = require('node:path')
const { mkdirSync, writeFileSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const ExcelJS = require('exceljs')
const AdmZip = require('adm-zip')
const root = resolve(__dirname, '..')
const report = join(root, '.local', 'reports', 'knowledge-smoke', randomUUID())
mkdirSync(report, { recursive: true })
app.setPath('userData', report)
app.setAppLogsPath(join(report, 'logs'))
delete process.env.ELECTRON_RENDERER_URL
delete process.env.AUTOREPLY_ENABLE_LEGACY_SKILL_SERVER
let requests = 0,
  validRules = true
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    const input = JSON.parse(body)
    requests++
    const prompt = input.messages.find((m) => m.role === 'system')?.content ?? ''
    validRules &&=
      req.headers.authorization === 'Bearer synthetic-key' &&
      prompt.includes('礼貌简洁') &&
      prompt.includes('王经理') &&
      prompt.includes('合作客户') &&
      prompt.includes('您好') &&
      prompt.includes('09:00') &&
      prompt.includes('询问订单号')
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        model: 'synthetic-model',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '王经理您好，服务时间为周一至周五 09:00—18:00。'
            }
          }
        ]
      })
    )
  })
})
const listening = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
async function fixtures() {
  const zip = new AdmZip()
  zip.addFile(
    '[Content_Types].xml',
    Buffer.from(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    )
  )
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>售后支持请提供产品名称。</w:t></w:r></w:p></w:body></w:document>'
    )
  )
  const book = new ExcelJS.Workbook()
  book.addWorksheet('商品').addRows([
    ['产品', '价格'],
    ['基础套餐', 199]
  ])
  const stream = 'BT /F1 12 Tf 50 700 Td (Business hours: 09:00 to 18:00.) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((n) => String(n).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return [
    ['服务.txt', Buffer.from('服务时间为周一至周五 09:00—18:00。')],
    ['说明.md', Buffer.from('# 产品说明\n蓝牙设备支持离线使用。')],
    ['商品.csv', Buffer.from('产品,价格\n基础套餐,199')],
    ['数据.json', Buffer.from('{"服务":"售后协助"}')],
    ['售后.docx', zip.toBuffer()],
    ['商品.xlsx', Buffer.from(await book.xlsx.writeBuffer())],
    ['business.pdf', Buffer.from(pdf)]
  ].map(([name, bytes]) => ({ name, bytes: [...bytes] }))
}
const timer = setTimeout(() => {
  process.stderr.write('Knowledge smoke timed out\n')
  app.exit(1)
}, 75000)
app.on('browser-window-created', (_event, window) => {
  window.show = () => {}
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load', async () => {
    try {
      await listening
      const files = await fixtures()
      const configured = await window.webContents.executeJavaScript(`(async()=>{
        const model = await window.electron.invoke('model:create', {name:'隔离模型',provider:'custom',modelName:'synthetic-model',apiKey:'synthetic-key',baseURL:'http://127.0.0.1:${server.address().port}/v1',capabilities:['text']});
        const mode = await window.electron.invoke('mode:create',{name:'隔离规则',prompt:'礼貌简洁',unifiedPrefix:'您好'});
        const object = await window.electron.invoke('object:create',mode.mode.id,{name:'王经理',title:'王经理',relationship:'合作客户',autoReply:false});
        if(!model.success||!mode.success||!object.success)throw new Error('configuration_failed');
        await window.electron.invoke('settings:set',{globalReplyModelId:model.model.id,globalDefaultModeId:mode.mode.id,theme:'light'});
        return {modeId:mode.mode.id,objectId:object.object.id};
      })()`)
      const reloaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
      window.webContents.reload()
      await reloaded
      window.setContentSize(1280, 900)
      const result = await window.webContents.executeJavaScript(`(async()=>{
        const until=async predicate=>{const end=Date.now()+12000;while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,25))}throw new Error('knowledge_ui_timeout_'+document.body.innerText.slice(-2500))};
        const fill=(id,value)=>{const e=document.getElementById(id); const proto=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:e instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,value);e.dispatchEvent(new Event(e instanceof HTMLSelectElement?'change':'input',{bubbles:true}))};
        const click=async(label,scope=document)=>{await until(()=>[...scope.querySelectorAll('button')].some(e=>e.textContent.trim()===label&&!e.disabled));const e=[...scope.querySelectorAll('button')].find(e=>e.textContent.trim()===label);e.click()};
        const check=(value,message)=>{if(!value)throw new Error(message)};
        await until(()=>document.getElementById('workspace-tab-objects'));
        check(!document.getElementById('workspace-tab-mode')&&!document.getElementById('home-active-mode')&&!document.getElementById('home-default-mode'),'mode_ui_removed');
        document.getElementById('workspace-tab-objects').click();await until(()=>document.querySelector('[data-object-id="${configured.objectId}"]'));
        document.querySelector('[data-object-id="${configured.objectId}"] button').click();await until(()=>document.getElementById('object-reply-requirements'));
        check(!document.getElementById('object-edit-mode'),'object_mode_selection_removed');
        fill('object-reply-requirements','询问订单号后再解答。');await click('保存',document.querySelector('[role="dialog"]'));await until(()=>!document.querySelector('[role="dialog"]'));
        let savedObject=(await window.electron.invoke('mode:list')).flatMap(m=>m.specificObjects).find(o=>o.id==='${configured.objectId}');
        check(savedObject.replyRules==='询问订单号后再解答。'&&savedObject.autoReply===false,'dedicated_saved_and_disabled_preserved');
        const files=${JSON.stringify(files)};
        for(const f of files){const r=await window.knowledge.importFile({...f,bytes:new Uint8Array(f.bytes),category:'隔离测试'});check(r.success,'import_'+f.name+'_'+r.error)}
        const imported=await window.knowledge.snapshot();check(imported.documents.length===7&&imported.documents.every(d=>d.state==='ready'),'all_formats_ready');
        check((await window.knowledge.search('Business hours')).hits.some(h=>h.name==='business.pdf'),'pdf_indexed');
        check((await window.knowledge.search('基础套餐')).hits.some(h=>h.name==='商品.xlsx'),'spreadsheet_indexed');
        const failed=await window.knowledge.importFile({name:'不支持.doc',bytes:new Uint8Array([1,2])});check(!failed.success&&(await window.knowledge.snapshot()).documents.some(d=>d.state==='failed'),'failed_visible');
        await until(()=>document.getElementById('workspace-tab-knowledge'));document.getElementById('workspace-tab-knowledge').click();
        await until(()=>document.querySelector('.knowledge-table'));await click('手动录入');await until(()=>document.getElementById('knowledge-name'));
        check([...document.querySelectorAll('[role="dialog"] button')].find(e=>e.textContent==='保存资料').disabled,'empty_manual_blocked');
        fill('knowledge-name','人工规则资料');fill('knowledge-category','业务');fill('knowledge-content','开票申请需要提供完整抬头。');await until(()=>!document.querySelector('[role="dialog"] button:last-child').disabled);await click('保存资料');await until(()=>!document.querySelector('[role="dialog"]'));
        let manual=(await window.knowledge.snapshot()).documents.find(d=>d.name==='人工规则资料');check(!!manual,'manual_saved');
        const row=[...document.querySelectorAll('.knowledge-table tr')].find(r=>r.textContent.includes('人工规则资料'));row.querySelector('button').click();await until(()=>document.getElementById('knowledge-content'));
        fill('knowledge-content','开票申请需要提供完整抬头及税号。');await click('保存资料');await until(()=>!document.querySelector('[role="dialog"]'));check((await window.knowledge.detail(manual.id)).document.version===2,'edited_version');
        document.getElementById('knowledge-tab-test').click();await until(()=>document.getElementById('knowledge-object').options.length===2);check(!document.getElementById('knowledge-mode'),'trial_mode_selection_removed');fill('knowledge-object',${JSON.stringify(configured.objectId)});fill('knowledge-question','服务时间是什么？');await click('生成试答');
        await until(()=>document.querySelector('.knowledge-answer-text')?.textContent.includes('王经理'));check(document.querySelector('.knowledge-evidence article').textContent.includes('服务.txt'),'trial_sources');
        const oldText=document.querySelector('.knowledge-answer-text').textContent;fill('knowledge-question','量子火箭燃料成分是什么？');await until(()=>!document.querySelector('.knowledge-answer-text'));await click('生成试答');await until(()=>document.querySelector('.knowledge-answer-text'));check(document.querySelector('.knowledge-answer-text').textContent!==oldText,'fallback_without_model');
        const service=imported.documents.find(d=>d.name==='服务.txt');await window.knowledge.update({id:service.id,enabled:false});check(!(await window.knowledge.search('服务时间')).hits.some(h=>h.documentId===service.id),'disabled_excluded');await window.knowledge.update({id:service.id,enabled:true});
        await window.knowledge.remove(manual.id);check(!(await window.knowledge.search('税号')).hits.length,'deleted_excluded');
        let complete=false,pings=0,maxLatency=0;const started=Date.now();const large=window.knowledge.save({name:'索引响应测试',category:'测试',content:('设备型号说明与操作方法。\\n').repeat(100000)}).then(d=>{complete=true;return d});
        while(!complete){const tick=Date.now();await window.knowledge.snapshot();maxLatency=Math.max(maxLatency,Date.now()-tick);pings++;await new Promise(r=>setTimeout(r,30))}const indexed=await large;check(pings>2&&maxLatency<1500,'main_thread_unresponsive_'+maxLatency);await window.knowledge.remove(indexed.id);
        fill('knowledge-question','服务时间是什么？');await click('生成试答');await until(()=>document.querySelector('.knowledge-answer-text')?.textContent.includes('王经理'));
        check((await window.knowledge.export()).documents.every(d=>d.id!==manual.id),'export_filters_deleted');
        document.getElementById('workspace-tab-objects').click();await until(()=>document.querySelector('[data-object-id="${configured.objectId}"]'));document.querySelector('[data-object-id="${configured.objectId}"] button').click();await until(()=>document.getElementById('object-reply-requirements'));
        check(document.getElementById('object-reply-requirements').value==='询问订单号后再解答。','dedicated_persisted');fill('object-reply-requirements','');await click('保存',document.querySelector('[role="dialog"]'));await until(()=>!document.querySelector('[role="dialog"]'));
        await until(()=>document.querySelector('[data-object-id="${configured.objectId}"]').textContent.includes('通用规则'));
        savedObject=(await window.electron.invoke('mode:list')).flatMap(m=>m.specificObjects).find(o=>o.id==='${configured.objectId}');check(savedObject.replyRules===''&&savedObject.autoReply===false,'clear_inherits_and_disabled_preserved');
        document.getElementById('workspace-tab-knowledge').click();await until(()=>!document.querySelector('.knowledge-answer-text'));
        return {modeUiRemoved:true,dedicatedSaved:true,dedicatedPersisted:true,clearInherits:true,disabledUserPreserved:true,ruleChangeHidesOldAnswer:true,allFormatsReady:true,pdfIndexed:true,spreadsheetIndexed:true,failedVisible:true,manualSaved:true,editedVersion:true,trialSources:true,fallback:true,disabledExcluded:true,deletedExcluded:true,staleAnswerHidden:true,backgroundIndexResponsive:true,pings,maxLatency,indexMs:Date.now()-started};
      })()`)
      if (!validRules || requests !== 2)
        throw new Error(
          'model_rules_or_fallback_failed_' + JSON.stringify({ validRules, requests })
        )
      const capture = async (name) => {
        await window.webContents.capturePage(undefined, { stayHidden: true })
        await window.webContents.executeJavaScript(
          'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'
        )
        writeFileSync(
          join(report, name),
          (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG()
        )
      }
      await capture('knowledge-trial.png')
      await window.webContents.executeJavaScript(
        "document.getElementById('knowledge-tab-documents').click()"
      )
      await capture('knowledge-library.png')
      window.setContentSize(920, 820)
      await capture('knowledge-library-compact.png')
      if (
        !(await window.webContents.executeJavaScript(
          'document.documentElement.scrollWidth<=window.innerWidth'
        ))
      )
        throw new Error('knowledge_page_overflow')
      writeFileSync(
        join(report, 'result.json'),
        JSON.stringify({ passed: true, ...result, validRules, requests }, null, 2)
      )
      process.stdout.write(
        'Knowledge desktop UI, parsing, indexing and loopback rules verified: ' + report + '\n'
      )
      clearTimeout(timer)
      server.close()
      app.exit(0)
    } catch (error) {
      writeFileSync(
        join(report, 'result.json'),
        JSON.stringify({ passed: false, message: error.message }, null, 2)
      )
      process.stderr.write('Knowledge smoke failed: ' + report + ' ' + error.message + '\n')
      clearTimeout(timer)
      server.close()
      app.exit(1)
    }
  })
})
require(join(root, 'out', 'main', 'index.js'))
