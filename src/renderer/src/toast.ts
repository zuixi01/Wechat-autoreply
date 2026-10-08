export type ToastType = 'success' | 'error'

export interface ToastNotification {
  message: string
  type: ToastType
  duration?: number
}

type ToastListener = (notification: ToastNotification) => void

let listener: ToastListener | undefined
// The UI displays the latest notification, including one emitted before it mounts.
let pending: ToastNotification | undefined

export function showToast(message: string, type: ToastType, duration?: number): void {
  const notification = { message, type, duration }
  if (listener) {
    pending = undefined
    listener(notification)
  } else {
    pending = notification
  }
}

export function subscribeToast(next: ToastListener): () => void {
  listener = next
  queueMicrotask(() => {
    if (listener !== next || !pending) return
    const notification = pending
    pending = undefined
    next(notification)
  })
  return () => {
    if (listener === next) listener = undefined
  }
}
