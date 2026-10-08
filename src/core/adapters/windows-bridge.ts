import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { verifyNativePackage } from './native-package'
import { NativeAdapterInfoSchema } from '../../shared/contracts/native-package'
import {
  NativeWindowBindingSchema,
  NativeProbeSchema,
  NativeTreeViewSchema,
  type NativeProbe
} from '../../shared/contracts/native-probe'

export const WindowBindingSchema = NativeWindowBindingSchema
export const WindowListSchema = z
  .strictObject({
    windows: z.array(WindowBindingSchema).max(1024),
    identityVerified: z.literal(false)
  })
  .superRefine((value, context) => {
    if (new Set(value.windows.map((window) => window.handle)).size !== value.windows.length)
      context.addIssue({ code: 'custom', message: 'duplicate_window_binding' })
  })
const ResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    protocolVersion: z.literal(1),
    requestId: z.string().uuid(),
    ok: z.literal(true),
    result: z.unknown()
  }),
  z.strictObject({
    protocolVersion: z.literal(1),
    requestId: z.string().uuid().nullable(),
    ok: z.literal(false),
    error: z.string().max(128)
  })
])
interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
export function nativeChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) => !/^(DOTNET_|COREHOST_|CORECLR_|COR_|COMPLUS_)/i.test(key)
    )
  )
}

/** A pinned passive helper; arbitrary programs/arguments cannot be supplied to the bridge. */
export class WindowsBridge {
  private process?: ChildProcessWithoutNullStreams
  private closed?: Promise<void>
  private starting?: Promise<void>
  private stopping?: Promise<void>
  private stopUnconfirmed = false
  private epoch = 0
  private buffer = ''
  private readonly pending = new Map<string, Pending>()
  private constructor(
    private readonly root: string,
    private readonly expectedHash: string,
    private readonly adapterVersion: '0.2.0' | '0.3.0' | '0.4.0'
  ) {}

  static async fromPackage(root: string, expectedHash: string): Promise<WindowsBridge> {
    const manifest = await verifyNativePackage(root, expectedHash)
    return new WindowsBridge(root, expectedHash, manifest.adapterVersion)
  }
  async info(signal?: AbortSignal): Promise<z.infer<typeof NativeAdapterInfoSchema>> {
    const value = await this.request('info', undefined, signal)
    const parsed = NativeAdapterInfoSchema.safeParse(value)
    if (!parsed.success || parsed.data.adapterVersion !== this.adapterVersion) {
      await this.stop()
      throw new Error('native_adapter_version_mismatch')
    }
    return parsed.data
  }
  async listWindows(signal?: AbortSignal): Promise<z.infer<typeof WindowListSchema>> {
    const result = WindowListSchema.safeParse(await this.request('listWindows', undefined, signal))
    if (!result.success) {
      await this.stop()
      throw new Error('native_window_evidence_invalid')
    }
    return result.data
  }
  async probe(
    binding: z.infer<typeof WindowBindingSchema>,
    signal?: AbortSignal,
    treeView: z.infer<typeof NativeTreeViewSchema> = 'control'
  ): Promise<NativeProbe> {
    const requested = WindowBindingSchema.parse(binding)
    treeView = NativeTreeViewSchema.parse(treeView)
    if (treeView === 'raw' && this.adapterVersion === '0.2.0')
      throw new Error('native_probe_view_unsupported')
    const parsed = NativeProbeSchema.safeParse(
      await this.request(
        'probe',
        requested,
        signal,
        this.adapterVersion !== '0.2.0' ? treeView : undefined
      )
    )
    if (
      !parsed.success ||
      parsed.data.adapterVersion !== this.adapterVersion ||
      (parsed.data.formatVersion !== 1 && parsed.data.treeView !== treeView) ||
      (['handle', 'processId', 'processName', 'processStartTicks'] as const).some(
        (key) => parsed.data.binding[key] !== requested[key]
      )
    ) {
      await this.stop()
      throw new Error('native_probe_evidence_invalid')
    }
    return parsed.data
  }
  private async start(): Promise<void> {
    if (this.stopping || this.stopUnconfirmed) throw new Error('native_adapter_stop_unconfirmed')
    if (this.process) return
    if (this.starting) return this.starting
    const epoch = this.epoch
    const launch = (async (): Promise<void> => {
      const manifest = await verifyNativePackage(this.root, this.expectedHash)
      if (manifest.adapterVersion !== this.adapterVersion)
        throw new Error('native_adapter_version_mismatch')
      if (epoch !== this.epoch || this.stopping) throw new Error('native_adapter_stopped')
      const child = spawn(join(this.root, 'WindowsAdapter.exe'), [], {
        windowsHide: true,
        stdio: 'pipe',
        shell: false,
        cwd: this.root,
        env: nativeChildEnvironment(process.env)
      })
      this.process = child
      this.closed = new Promise<void>((done) =>
        child.once('close', () => {
          if (this.process === child) {
            this.process = undefined
            this.stopUnconfirmed = false
            this.failAll('native_adapter_exited')
          }
          done()
        })
      )
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        if (this.process === child) this.consume(chunk)
      })
      child.stderr.resume()
      const stop = (): void => {
        if (this.process === child) void this.stop().catch(() => {})
      }
      child.on('error', stop)
      child.stdin.on('error', stop)
    })()
    this.starting = launch
    try {
      await launch
    } finally {
      if (this.starting === launch) this.starting = undefined
    }
  }
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.epoch++
    this.failAll('native_adapter_stopped')
    const child = this.process,
      closed = this.closed
    if (!child || !closed) return
    const stopping = (async (): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const force = setTimeout(() => {
        if (this.process === child) {
          try {
            child.kill()
          } catch {
            /* Deadline below must still report an unconfirmed stop. */
          }
        }
      }, 150)
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('native_adapter_stop_unconfirmed')), 1500)
      })
      try {
        try {
          child.stdin.end()
        } catch {
          try {
            child.kill()
          } catch {
            /* Await close; a kill error never confirms exit. */
          }
        }
        await Promise.race([closed, timeout])
      } catch {
        this.stopUnconfirmed = true
        throw new Error('native_adapter_stop_unconfirmed')
      } finally {
        clearTimeout(timer)
        clearTimeout(force)
      }
    })()
    this.stopping = stopping
    try {
      await stopping
    } finally {
      if (this.stopping === stopping) this.stopping = undefined
    }
  }
  private async request(
    command: 'info' | 'listWindows' | 'probe',
    binding?: z.infer<typeof WindowBindingSchema>,
    signal?: AbortSignal,
    treeView?: 'control' | 'raw'
  ): Promise<unknown> {
    if (signal?.aborted) throw new Error('native_adapter_cancelled')
    const epoch = this.epoch
    const abort = (): void => {
      void this.stop().catch(() => {})
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await this.start()
      if (signal?.aborted || epoch !== this.epoch || !this.process)
        throw new Error('native_adapter_stopped')
      if (this.pending.size >= 16) throw new Error('native_adapter_overloaded')
      const child = this.process,
        requestId = randomUUID()
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(requestId)
          reject(new Error('native_adapter_timeout'))
          void this.stop().catch(() => {})
        }, 5000)
        this.pending.set(requestId, { resolve, reject, timer })
        try {
          child.stdin.write(
            JSON.stringify({
              protocolVersion: 1,
              requestId,
              command,
              binding,
              ...(treeView ? { treeView } : {})
            }) + '\n'
          )
        } catch {
          void this.stop().catch(() => {})
        }
      })
    } catch (error) {
      if (signal?.aborted) throw new Error('native_adapter_cancelled')
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }
  private consume(chunk: string): void {
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer, 'utf8') > 2_000_000) {
      void this.stop().catch(() => {})
      return
    }
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      try {
        const response = ResponseSchema.parse(JSON.parse(line))
        if (response.requestId === null) {
          void this.stop().catch(() => {})
          return
        }
        const pending = this.pending.get(response.requestId)
        if (!pending) continue
        this.pending.delete(response.requestId)
        clearTimeout(pending.timer)
        if (response.ok) pending.resolve(response.result)
        else pending.reject(new Error('native_probe_rejected'))
      } catch {
        void this.stop().catch(() => {})
        return
      }
    }
  }
  private failAll(code: string): void {
    this.buffer = ''
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(code))
    }
    this.pending.clear()
  }
}
