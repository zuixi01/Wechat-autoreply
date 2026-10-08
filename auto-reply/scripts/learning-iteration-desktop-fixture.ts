import { app, BrowserWindow } from 'electron'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { writeFile } from 'node:fs/promises'
import {
  createLearningIterationFixture,
  iterationCalibration,
  ITERATION_V1,
  ITERATION_V2,
  type LearningIterationFixture
} from './learning-iteration-fixture'
import { registerLearningIpc } from '../src/main/ipc/learning-ipc'
import { registerLearningSubmissionIpc } from '../src/main/ipc/learning-submission-ipc'
import { registerKnowledgeIpc } from '../src/main/ipc/knowledge-ipc'
import { createLegacyIpc } from '../src/main/ipc/trusted-ipc'
import { Ledger } from '../src/core/persistence/ledger'
import { DesktopAgentRuntime } from '../src/main/services/desktop-agent-runtime'
import { AgentRegistration } from '../src/main/services/agent-registration'
import type { KnowledgeStore } from '../src/core/knowledge/knowledge-store'

const root = resolve(process.cwd()),
  report = resolve(process.argv[2])
const part = relative(join(root, '.local/reports/learning-iteration'), report)
if (!part || isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`))
  throw new Error('invalid_fixture_report')
app.disableHardwareAcceleration()
app.setPath('userData', join(report, 'user-data'))
let fixture: LearningIterationFixture | undefined,
  window: BrowserWindow | undefined,
  runtime: DesktopAgentRuntime | undefined,
  knowledge: KnowledgeStore | undefined
let phase = 'setup'
async function main(): Promise<void> {
  await app.whenReady()
  const f = (fixture = await createLearningIterationFixture(report))
  const client = new AgentRegistration(
    { load: () => undefined, save: () => {} },
    { available: () => true, encrypt: () => '', decrypt: () => '' }
  )
  runtime = new DesktopAgentRuntime(new Ledger(join(report, 'ledger.sqlite')), client)
  runtime.configureLearningSubmissions(f.service)
  const renderer = join(root, 'out/renderer/index.html')
  registerLearningIpc(
    renderer,
    undefined,
    f.service,
    () => f.scope,
    (scope) => runtime!.learningBackend(scope)
  )
  registerLearningSubmissionIpc(renderer, undefined, runtime)
  knowledge = registerKnowledgeIpc(renderer, report, undefined, (question, _modeId, objectId) => {
    if (objectId !== 'e7631a7e-52e0-4b15-a3ab-652ad1654a0e')
      throw new Error('unverified_fixture_object')
    return f.generate(question)
  })
  const legacy = createLegacyIpc(renderer, undefined)
  legacy.handle('settings:getAll', () => ({ locale: 'zh', theme: 'dark' }))
  legacy.handle('trace:listSessions', () => [])
  legacy.handle('memory:listCards', () => [])
  legacy.handle('mode:list', () => [])
  window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      preload: join(root, 'out/preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      offscreen: true,
      backgroundThrottling: false
    }
  })
  f.service.start()
  await window.loadFile(renderer, { query: { window: 'memory' } })
  const ui = (body: string): Promise<unknown> =>
    window!.webContents.executeJavaScript(`(async()=>{${helpers}${body}})()`)
  const helpers = `const until=async p=>{const end=Date.now()+12000;while(Date.now()<end){if(await p())return;await new Promise(r=>setTimeout(r,30))}throw new Error('iteration_ui_timeout')};
    const panel=()=>document.querySelector('.learning-panel');
    const click=async(label,node=panel())=>{await until(()=>[...node.querySelectorAll('button')].some(b=>b.textContent.trim()===label&&!b.disabled));[...node.querySelectorAll('button')].find(b=>b.textContent.trim()===label&&!b.disabled).click()};
    const fill=(e,value)=>{if(typeof e==='string')e=document.getElementById(e);const proto=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:e instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,value);e.dispatchEvent(new Event(e instanceof HTMLSelectElement?'change':'input',{bubbles:true}))};
    const data=()=>window.learningMemory.snapshot({scope:${JSON.stringify(f.scope)}});
    const generate=()=>window.knowledge.answer({question:'设备询价',modeId:'synthetic-mode',objectId:'e7631a7e-52e0-4b15-a3ab-652ad1654a0e'});
    const correct=async(id,text)=>{await click('案例与纠正');await click('刷新');await until(()=>panel().querySelector('[data-learning-episode="'+id+'"] .learning-correction'));const node=panel().querySelector('[data-learning-episode="'+id+'"] .learning-correction');node.open=true;fill(node.querySelectorAll('textarea')[0],text);fill(node.querySelectorAll('textarea')[1],'合成员工明确纠正遗漏核对项');await click('保存纠正并学习',node);await until(()=>node.textContent.includes('纠正已保存'))};
    const importCases=async(cases)=>{await click('校准与验证');await until(()=>!document.getElementById('learning-calibration-json').disabled);fill('learning-calibration-json',JSON.stringify({cases}));const checkbox=document.getElementById('learning-calibration-confirmed');if(!checkbox.checked)checkbox.click();await click('导入校准资料');await until(()=>panel().textContent.includes('校准资料已保存'))};`
  phase = 'first-correction'
  await ui(
    `await until(()=>panel());const reply=await generate();if(reply.text!=='请确认型号。')throw new Error('baseline_wrong');await correct(reply.learning.episodeId,${JSON.stringify(ITERATION_V1)});`
  )
  f.advance()
  await ui(`await until(async()=> (await data()).memories.length===1);`)
  f.advance()
  await ui(
    `await until(async()=> (await window.learningMemory.reports({scope:${JSON.stringify(f.scope)}})).validation.some(r=>r.result.status==='insufficient'));if((await data()).memories[0].record.activeRevision!==null)throw new Error('unlabelled_candidate_activated');await importCases(${JSON.stringify(iterationCalibration(1))});`
  )
  f.advance()
  phase = 'automatic-v1'
  const v1 = await ui(
    `await until(async()=> (await data()).memories[0].record.activeRevision===1);const reply=await generate();if(reply.text!=='请确认型号和数量。'||reply.learning.memoryRefs[0].revision!==1)throw new Error('v1_not_used');fill('learning-mode','suggest');await until(async()=> (await data()).settings.mode==='suggest');await correct(reply.learning.episodeId,${JSON.stringify(ITERATION_V2)});return reply;`
  )
  f.advance()
  phase = 'pending-v2'
  await ui(
    `await until(async()=> (await data()).memories[0].record.currentRevision===2);const current=(await data()).memories[0].record;if(current.activeRevision!==1)throw new Error('v2_overwrote_v1');const reply=await generate();if(reply.text!=='请确认型号和数量。'||reply.learning.memoryRefs[0].revision!==1)throw new Error('pending_v2_in_reply');await importCases(${JSON.stringify(iterationCalibration(2))});fill('learning-mode','auto');await until(async()=> (await data()).settings.mode==='auto');`
  )
  f.advance()
  phase = 'automatic-v2'
  const v2 = await ui(
    `await until(async()=> (await data()).memories[0].record.activeRevision===2);const reply=await generate();if(reply.text!=='请确认型号、数量和用途。'||reply.learning.memoryRefs[0].revision!==2)throw new Error('v2_not_used');await click('经验与版本');await click('刷新');await click('查看版本与来源');await until(()=>panel().querySelectorAll('.learning-version').length===2&&panel().textContent.includes('当前生效 V2')&&document.getElementById('learning-mode').value==='auto');await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));return reply;`
  )
  // Offscreen invalidation gives a fresh compositor frame after the checked DOM.
  // A hidden native window's capturePage may otherwise return an earlier frame.
  const painted = await new Promise<Buffer>((done, reject) => {
    const deadline = setTimeout(() => reject(new Error('iteration_paint_timeout')), 2000)
    window!.webContents.once('paint', (_event, _dirty, frame) => {
      clearTimeout(deadline)
      done(frame.toPNG())
    })
    window!.webContents.invalidate()
  })
  await writeFile(join(report, 'automatic-v2.png'), painted)
  phase = 'rollback'
  const restored = await ui(
    `await click('恢复 V1 的内容');await until(async()=> (await data()).memories[0].record.activeRevision===3);const reply=await generate();if(reply.text!=='请确认型号和数量。'||reply.learning.memoryRefs[0].revision!==3)throw new Error('rollback_not_used');return reply;`
  )
  const reviews = f.requests.filter((request) => request.kind === 'review')
  if (reviews.length !== 2 || f.store.list(f.scope).length !== 1)
    throw new Error('iteration_duplicated_method')
  if (
    f.requests.some(
      (request) =>
        request.kind === 'reply' &&
        (request.system.includes('human-only-rubric') || request.user.includes('human-only-rubric'))
    )
  )
    throw new Error('rubric_leaked')
  const receipts = runtime.learningSubmissions(f.scope)
  if (
    receipts.length !== 2 ||
    receipts.some((receipt) => receipt.kind !== 'correct' || receipt.state !== 'saved')
  )
    throw new Error('correction_journal_incomplete')
  await writeFile(
    join(report, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        provenance: 'synthetic-engineering-fixture',
        businessEffectVerified: false,
        actualElectron: true,
        automaticTimerTriggered: true,
        manualReviewOrValidationTriggerUsed: false,
        actualHttp: true,
        replies: { v1, v2, restored },
        reviewRequests: reviews.length,
        validationReports: f.store.validation.reportsForScope(f.scope),
        receipts,
        usage: f.store.jobs.usage(f.scope)
      },
      null,
      2
    )
  )
  process.stdout.write(JSON.stringify({ passed: true, report, stages: 6 }) + '\n')
}
async function cleanup(): Promise<void> {
  window?.destroy()
  await runtime?.close()
  knowledge?.close()
  await fixture?.close()
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
        : 'iteration_desktop_failed'
    await writeFile(
      join(report, 'result.json'),
      JSON.stringify({ passed: false, phase, code, provenance: 'synthetic-engineering-fixture' })
    )
    process.stderr.write(JSON.stringify({ passed: false, report, phase, code }) + '\n')
    try {
      if (window && !window.isDestroyed())
        await writeFile(
          join(report, 'failed.png'),
          (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG()
        )
    } catch {
      /* Screenshot diagnostics cannot prevent database and timer shutdown. */
    }
    await cleanup()
    app.exit(1)
  })
