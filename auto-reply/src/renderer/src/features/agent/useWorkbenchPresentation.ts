import { useEffect, useRef } from 'react'
import type { WorkbenchRow } from '../../../../shared/contracts/workbench'
import {
  WorkbenchPresentationTicketSchema,
  WorkbenchPresentationResultSchema
} from '../../../../shared/contracts/workbench-presentation'

function displayed(row: WorkbenchRow): HTMLElement | undefined {
  if (document.visibilityState !== 'visible' || !document.hasFocus()) return undefined
  const element = [...document.querySelectorAll<HTMLElement>('[data-workbench-task]')].find(
    (node) =>
      node.dataset.workbenchTask === row.taskId && node.dataset.workbenchVersion === row.version
  )
  if (!element || element.querySelector('.enterprise-edit')) return undefined
  const text =
    element.querySelector<HTMLElement>('[data-workbench-reply]') ??
    element.querySelector<HTMLElement>('[data-workbench-inbound]')
  if (!text) return undefined
  const box = text.getBoundingClientRect()
  const front = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  if (!front || !element.contains(front)) return undefined
  return box.width > 0 &&
    box.height > 0 &&
    box.top >= 0 &&
    box.bottom <= innerHeight &&
    box.left >= 0 &&
    box.right <= innerWidth
    ? element
    : undefined
}
async function afterFrames(): Promise<boolean> {
  return new Promise((done) => {
    let first = 0,
      second = 0
    const timer = setTimeout(() => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
      done(false)
    }, 1500)
    first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        clearTimeout(timer)
        done(true)
      })
    })
  })
}
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('presentation_unconfirmed')), 8000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Display hint only: trusted main rechecks the actual row, window and compositor. */
export function useWorkbenchPresentation(rows: WorkbenchRow[], editingTaskId?: string): void {
  const acknowledged = useRef(new Set<string>()),
    pending = useRef(new Set<string>())
  useEffect(() => {
    const api = window.agentWorkbench
    if (!api?.presentationTicket || !api.presentationAck) return
    let active = true
    const attempted = new Set<string>(),
      markers = new Map<HTMLElement, string>()
    const present = async (row: WorkbenchRow): Promise<void> => {
      const key = `${row.taskId}:${row.version}`
      if (
        !active ||
        editingTaskId === row.taskId ||
        !['ready', 'needs_human'].includes(row.status) ||
        acknowledged.current.has(key) ||
        pending.current.has(key) ||
        attempted.has(key) ||
        !displayed(row)
      )
        return
      attempted.add(key)
      pending.current.add(key)
      let node: HTMLElement | undefined, nonce: string | undefined
      try {
        const ticket = WorkbenchPresentationTicketSchema.parse(
          await bounded(
            api.presentationTicket!({
              taskId: row.taskId,
              expectedVersion: row.version
            })
          )
        )
        if (!active || !ticket.available || !(node = displayed(row))) return
        nonce = ticket.nonce
        node.dataset.workbenchPresentation = nonce
        markers.set(node, nonce)
        if (!(await afterFrames()) || !active || displayed(row) !== node) return
        const result = WorkbenchPresentationResultSchema.parse(
          await bounded(api.presentationAck!({ nonce }))
        )
        if (result.accepted) {
          // Bound the client hint cache; server receipts remain authoritative.
          if (acknowledged.current.size >= 1000) acknowledged.current.clear()
          acknowledged.current.add(key)
        } else attempted.delete(key)
      } catch {
        /* A failed diagnostic cannot affect reviewing, learning or sending. */
      } finally {
        pending.current.delete(key)
        if (node && nonce && node.dataset.workbenchPresentation === nonce)
          delete node.dataset.workbenchPresentation
        if (node) markers.delete(node)
      }
    }
    const scan = (): void => {
      for (const row of rows) void present(row)
    }
    scan()
    const timer = setInterval(scan, 500)
    window.addEventListener('focus', scan)
    window.addEventListener('scroll', scan, true)
    document.addEventListener('visibilitychange', scan)
    return () => {
      active = false
      clearInterval(timer)
      window.removeEventListener('focus', scan)
      window.removeEventListener('scroll', scan, true)
      document.removeEventListener('visibilitychange', scan)
      for (const [node, nonce] of markers)
        if (node.dataset.workbenchPresentation === nonce) delete node.dataset.workbenchPresentation
    }
  }, [rows, editingTaskId])
}
