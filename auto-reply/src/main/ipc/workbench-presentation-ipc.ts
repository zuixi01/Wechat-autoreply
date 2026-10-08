import {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  type IpcMainInvokeEvent,
  type Rectangle
} from 'electron'
import { z } from 'zod'
import { rendererTrust } from './trusted-ipc'
import {
  WorkbenchPresentationCapture,
  type HostPresentationSurface
} from '../services/workbench-presentation-capture'
import type { DesktopAgentRuntime } from '../services/desktop-agent-runtime'

const RectangleSchema = z
  .strictObject({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().positive().max(4096),
    height: z.number().int().positive().max(4096)
  })
  .refine((rect) => rect.width * rect.height <= 4000000)
const labels = { ready: '回复待执行', needs_human: '需要人工处理' }

function surface(event: IpcMainInvokeEvent): HostPresentationSurface {
  const owner = event.sender,
    frame = event.senderFrame!,
    window = BrowserWindow.fromWebContents(owner)!
  const document = `${frame.processId}:${frame.routingId}:${frame.url}`
  let region: Rectangle | undefined
  const visible = (): boolean => {
    try {
      return (
        !window.isDestroyed() &&
        !owner.isDestroyed() &&
        window.isVisible() &&
        !window.isMinimized() &&
        window.isFocused() &&
        owner.mainFrame === frame &&
        `${frame.processId}:${frame.routingId}:${frame.url}` === document
      )
    } catch {
      return false
    }
  }
  return {
    owner: owner.id,
    document,
    visible,
    async inspect(nonce, target) {
      if (!visible()) return false
      const expected = {
        nonce,
        taskId: target.row.taskId,
        version: target.row.version,
        status: target.row.status,
        label: labels[target.row.status as keyof typeof labels],
        inbound: target.row.inboundPreview || '暂无文本消息',
        reply: target.row.replyText ?? null
      }
      // Run in the real main document, after committed animation frames. No renderer clock
      // or renderer-supplied text/hash authorizes the receipt. Body comparisons stay in memory.
      const raw: unknown = await owner.executeJavaScript(`(async()=>{
        await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
        const expected=${JSON.stringify(expected)};
        if(document.visibilityState!=='visible'||!document.hasFocus()) return null;
        const matches=[...document.querySelectorAll('[data-workbench-task]')].filter(e=>e.dataset.workbenchPresentation===expected.nonce);
        if(matches.length!==1) return null;
        const row=matches[0];
        if(row.dataset.workbenchTask!==expected.taskId||row.dataset.workbenchVersion!==expected.version||
          row.dataset.workbenchStatus!==expected.status||row.querySelector('.enterprise-edit')) return null;
        const heading=row.querySelector('.enterprise-task-heading'), inbound=row.querySelector('[data-workbench-inbound]'),
          reply=row.querySelector('[data-workbench-reply]');
        const body=e=>[...e.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join('');
        if(!heading||heading.querySelector('.enterprise-badge')?.textContent!==expected.label||!inbound||
          body(inbound)!==expected.inbound||(expected.reply===null?!!reply:!reply||body(reply)!==expected.reply)) return null;
        const elements=[heading,inbound,...(reply?[reply]:[])], rects=[];
        for(const element of elements){
          for(let e=element;e;e=e.parentElement){const s=getComputedStyle(e);
            if(s.display==='none'||s.visibility!=='visible'||Number(s.opacity)<0.95) return null;}
          const b=element.getBoundingClientRect();
          if(b.width<=0||b.height<=0||b.left<0||b.top<0||b.right>innerWidth||b.bottom>innerHeight) return null;
          for(const fraction of [0.1,0.5,0.9]){
            const front=document.elementFromPoint(b.left+b.width*fraction,b.top+b.height/2);
            if(!front||!row.contains(front)) return null;
          }
          rects.push(b);
        }
        const x=Math.floor(Math.min(...rects.map(r=>r.left))),y=Math.floor(Math.min(...rects.map(r=>r.top)));
        return {x,y,width:Math.ceil(Math.max(...rects.map(r=>r.right)))-x,
          height:Math.ceil(Math.max(...rects.map(r=>r.bottom)))-y};
      })()`)
      const parsed = RectangleSchema.safeParse(raw)
      if (!parsed.success || !visible()) return false
      const content = window.getContentBounds(),
        bounds = screen.getDisplayMatching(window.getBounds()).workArea
      const absolute = { x: content.x + parsed.data.x, y: content.y + parsed.data.y }
      if (
        absolute.x < bounds.x ||
        absolute.y < bounds.y ||
        absolute.x + parsed.data.width > bounds.x + bounds.width ||
        absolute.y + parsed.data.height > bounds.y + bounds.height
      )
        return false
      region = parsed.data
      return true
    },
    async capture() {
      if (!region || !visible()) return false
      const image = await owner.capturePage(region, { stayHidden: true })
      // Do not persist customer screenshots or return pixels through IPC.
      return (
        visible() && !image.isEmpty() && image.getSize().width > 0 && image.getSize().height > 0
      )
    }
  }
}

export function registerWorkbenchPresentationIpc(
  rendererFile: string,
  developerOrigin: string | undefined,
  runtime: Pick<DesktopAgentRuntime, 'presentationTarget' | 'recordPresentation'>
): WorkbenchPresentationCapture {
  const trusted = rendererTrust(rendererFile, developerOrigin),
    capture = new WorkbenchPresentationCapture(
      (input) => runtime.presentationTarget(input),
      (receipt) => runtime.recordPresentation(receipt)
    )
  ipcMain.handle('agent-workbench:presentation-ticket', (event, input: unknown) => {
    trusted(event)
    return capture.issue(input, surface(event))
  })
  ipcMain.handle('agent-workbench:presentation-ack', (event, input: unknown) => {
    trusted(event)
    return capture.acknowledge(input, surface(event))
  })
  app.once('before-quit', () => capture.close())
  return capture
}
