import { app } from 'electron'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { z } from 'zod'
import { nativeChildEnvironment } from '../../core/adapters/windows-bridge'

declare const __FOREGROUND_WINDOW_SHA256__: string
export const ForegroundWindowSchema = z.strictObject({
  id: z.string().regex(/^[1-9]\d*$/),
  pid: z.number().int().positive(),
  path: z.string().max(4096),
  startTicks: z.string().regex(/^[1-9]\d*$/),
  bounds: z.strictObject({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive()
  })
})
const StateSchema = z.strictObject({
  id: z.string().uuid(),
  ok: z.literal(true),
  windows: z.array(ForegroundWindowSchema).max(16),
  foreground: z.string().regex(/^\d+$/),
  editorText: z.string().max(4096).nullable().optional()
})
export type ForegroundWindow = z.infer<typeof ForegroundWindowSchema>
export interface ForegroundWindows {
  inspect(signal: AbortSignal): Promise<z.infer<typeof StateSchema>>
  focus(binding: ForegroundWindow, signal: AbortSignal): Promise<void>
  typeText(binding: ForegroundWindow, text: string, signal: AbortSignal): Promise<void | string>
  readEditorText?(binding: ForegroundWindow, signal: AbortSignal): Promise<string>
}
const liveBridges = new Set<ForegroundWindowBridge>()
let quitHookInstalled = false
/** The pinned helper pastes and reads back Unicode in the bound editor; never Enter. */
export class ForegroundWindowBridge implements ForegroundWindows {
  private child?: ChildProcessWithoutNullStreams
  private queue: Promise<unknown> = Promise.resolve()
  private idleTimer?: ReturnType<typeof setTimeout>
  private closed = false
  constructor() {
    if (!quitHookInstalled) {
      quitHookInstalled = true
      app.once('will-quit', () => {
        for (const bridge of liveBridges) bridge.close()
      })
    }
  }
  close(): void {
    this.closed = true
    this.release()
  }
  private release(): void {
    clearTimeout(this.idleTimer)
    const child = this.child
    this.child = undefined
    liveBridges.delete(this)
    child?.stdin.end()
    child?.kill()
  }
  async inspect(signal: AbortSignal): Promise<z.infer<typeof StateSchema>> {
    return this.request('inspect', signal)
  }
  async focus(binding: ForegroundWindow, signal: AbortSignal): Promise<void> {
    await this.request('focus', signal, binding)
  }
  async typeText(binding: ForegroundWindow, text: string, signal: AbortSignal): Promise<string> {
    if (
      !text ||
      text.length > 4096 ||
      Array.from(text).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ) ||
      Buffer.from(text, 'utf8').toString('utf8') !== text
    )
      throw new Error('text_invalid')
    const response = await this.request('type', signal, binding, text)
    if (typeof response.editorText !== 'string') throw new Error('editor_text_unavailable')
    return response.editorText
  }
  async readEditorText(binding: ForegroundWindow, signal: AbortSignal): Promise<string> {
    const response = await this.request('read_editor', signal, binding)
    if (typeof response.editorText !== 'string') throw new Error('editor_text_unavailable')
    return response.editorText
  }
  private request(
    command: 'inspect' | 'focus' | 'type' | 'read_editor',
    signal: AbortSignal,
    binding?: ForegroundWindow,
    text?: string
  ): Promise<z.infer<typeof StateSchema>> {
    // One helper owns one serialized stream. Cancellation never leaves a typing
    // request executing while another request starts on the same process.
    const work = this.queue.then(() => this.exchange(command, signal, binding, text))
    this.queue = work.catch(() => {})
    return work
  }
  private async exchange(
    command: 'inspect' | 'focus' | 'type' | 'read_editor',
    signal: AbortSignal,
    binding?: ForegroundWindow,
    text?: string
  ): Promise<z.infer<typeof StateSchema>> {
    if (signal.aborted) throw new Error('cancelled')
    if (this.closed) throw new Error('desktop_input_unavailable')
    clearTimeout(this.idleTimer)
    const path = app.isPackaged
      ? join(process.resourcesPath, 'native', 'foreground', 'ForegroundWindow.exe')
      : join(app.getAppPath(), '.local', 'foreground-native', 'windows-x64', 'ForegroundWindow.exe')
    if (!this.child) {
      // Verify every new process, then keep using that pinned process. Its loaded
      // executable does not depend on later replacements of the file on disk.
      if (
        !__FOREGROUND_WINDOW_SHA256__ ||
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex') !== __FOREGROUND_WINDOW_SHA256__
      )
        throw new Error('desktop_input_unavailable')
      if (signal.aborted) throw new Error('cancelled')
      const child = spawn(path, [], {
        windowsHide: true,
        stdio: 'pipe',
        shell: false,
        env: nativeChildEnvironment(process.env)
      })
      this.child = child
      liveBridges.add(this)
      child.stdout.setEncoding('utf8')
      child.stderr.resume()
      child.on('error', () => {
        if (this.child === child) this.release()
      })
      child.on('exit', () => {
        if (this.child === child) this.release()
      })
      child.stdin.on('error', () => {
        if (this.child === child) this.release()
      })
    }
    if (signal.aborted) throw new Error('cancelled')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const child = this.child!
      let timer: ReturnType<typeof setTimeout> | undefined,
        finished = false,
        buffer = '',
        requestWritten = false,
        cancelledAfterWrite = false
      const finish = (
        error?: Error,
        value?: z.infer<typeof StateSchema>,
        validResponse = false
      ): void => {
        if (finished) return
        finished = true
        if (cancelledAfterWrite) error = new Error('cancelled')
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        child.stdout.removeListener('data', data)
        child.removeListener('error', unavailable)
        child.removeListener('exit', failed)
        child.stdin.removeListener('error', failed)
        if (error && !validResponse) this.release()
        else this.idleTimer = setTimeout(() => this.release(), 30000)
        if (error) reject(error)
        else resolve(value!)
      }
      const abort = (): void => {
        // An active paste must finish restoring the clipboard. The helper cannot
        // press Enter; the runtime will discard its result after cancellation.
        if (['type', 'read_editor'].includes(command) && requestWritten) cancelledAfterWrite = true
        else finish(new Error('cancelled'))
      }
      const unavailable = (): void => finish(new Error('desktop_input_unavailable'))
      const failed = (): void => finish(new Error('window_query_failed'))
      const data = (chunk: string): void => {
        buffer += chunk
        if (buffer.length > 131072) return finish(new Error('window_query_failed'))
        if (!buffer.includes('\n')) return
        try {
          if (buffer.slice(buffer.indexOf('\n') + 1).trim()) throw new Error()
          const response = JSON.parse(buffer.slice(0, buffer.indexOf('\n')))
          if (
            response.id === id &&
            response.ok === false &&
            [
              'window_changed',
              'foreground_lost',
              'text_invalid',
              'input_failed',
              'input_state_changed',
              'clipboard_unavailable',
              'clipboard_state_changed',
              'editor_text_unavailable'
            ].includes(response.error)
          ) {
            finish(new Error(response.error), undefined, true)
            return
          }
          const result = StateSchema.parse(response)
          if (result.id !== id) throw new Error()
          finish(undefined, result, true)
        } catch {
          finish(new Error('window_query_failed'))
        }
      }
      try {
        child.on('error', unavailable)
        child.on('exit', failed)
        child.stdin.on('error', failed)
        child.stdout.on('data', data)
        // A clipboard operation restores its snapshot before cancellation settles.
        // No character-by-character delay is needed for a single Unicode paste.
        const timeoutMs = 5000
        timer = setTimeout(() => finish(new Error('window_query_failed')), timeoutMs)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) {
          abort()
          return
        }
        requestWritten = true
        child.stdin.write(
          JSON.stringify({
            id,
            command,
            ...(binding ? { binding } : {}),
            ...(text !== undefined ? { text } : {})
          }) + '\n'
        )
      } catch {
        finish(new Error('desktop_input_unavailable'))
      }
    })
  }
}
