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
  foreground: z.string().regex(/^\d+$/)
})
export type ForegroundWindow = z.infer<typeof ForegroundWindowSchema>
export interface ForegroundWindows {
  inspect(signal: AbortSignal): Promise<z.infer<typeof StateSchema>>
  focus(binding: ForegroundWindow, signal: AbortSignal): Promise<void>
  typeText(binding: ForegroundWindow, text: string, signal: AbortSignal): Promise<void>
}
/** The pinned helper types Unicode into the bound foreground window; it cannot press Enter. */
export class ForegroundWindowBridge implements ForegroundWindows {
  async inspect(signal: AbortSignal): Promise<z.infer<typeof StateSchema>> {
    return this.request('inspect', signal)
  }
  async focus(binding: ForegroundWindow, signal: AbortSignal): Promise<void> {
    await this.request('focus', signal, binding)
  }
  async typeText(binding: ForegroundWindow, text: string, signal: AbortSignal): Promise<void> {
    if (
      !text ||
      text.length > 4096 ||
      Array.from(text).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ) ||
      Buffer.from(text, 'utf8').toString('utf8') !== text
    )
      throw new Error('text_invalid')
    await this.request('type', signal, binding, text)
  }
  private async request(
    command: 'inspect' | 'focus' | 'type',
    signal: AbortSignal,
    binding?: ForegroundWindow,
    text?: string
  ): Promise<z.infer<typeof StateSchema>> {
    if (signal.aborted) throw new Error('cancelled')
    const path = app.isPackaged
      ? join(process.resourcesPath, 'native', 'foreground', 'ForegroundWindow.exe')
      : join(app.getAppPath(), '.local', 'foreground-native', 'windows-x64', 'ForegroundWindow.exe')
    if (
      !__FOREGROUND_WINDOW_SHA256__ ||
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex') !== __FOREGROUND_WINDOW_SHA256__
    )
      throw new Error('desktop_input_unavailable')
    if (signal.aborted) throw new Error('cancelled')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams | undefined,
        timer: ReturnType<typeof setTimeout> | undefined,
        finished = false,
        buffer = ''
      const finish = (error?: Error, value?: z.infer<typeof StateSchema>): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        child?.stdin.end()
        child?.kill()
        if (error) reject(error)
        else resolve(value!)
      }
      const abort = (): void => finish(new Error('cancelled'))
      try {
        child = spawn(path, [], {
          windowsHide: true,
          stdio: 'pipe',
          shell: false,
          env: nativeChildEnvironment(process.env)
        })
        child.stdout.setEncoding('utf8')
        child.stderr.resume()
        child.on('error', () => finish(new Error('desktop_input_unavailable')))
        child.on('exit', () => {
          if (!finished) finish(new Error('window_query_failed'))
        })
        child.stdin.on('error', () => finish(new Error('window_query_failed')))
        child.stdout.on('data', (chunk: string) => {
          buffer += chunk
          if (buffer.length > 131072) {
            finish(new Error('window_query_failed'))
            return
          }
          if (!buffer.includes('\n')) return
          try {
            const response = JSON.parse(buffer.slice(0, buffer.indexOf('\n')))
            if (
              response.id === id &&
              response.ok === false &&
              [
                'window_changed',
                'foreground_lost',
                'text_invalid',
                'input_failed',
                'input_state_changed'
              ].includes(response.error)
            ) {
              finish(new Error(response.error))
              return
            }
            const result = StateSchema.parse(response)
            if (result.id !== id) throw new Error()
            finish(undefined, result)
          } catch {
            finish(new Error('window_query_failed'))
          }
        })
        // Native typing paces complete Unicode characters. Allow that bounded
        // duration while retaining immediate cancellation and foreground checks.
        const timeoutMs = 5000 + (command === 'type' ? (text?.length ?? 0) * 40 : 0)
        timer = setTimeout(() => finish(new Error('window_query_failed')), timeoutMs)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) {
          abort()
          return
        }
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
