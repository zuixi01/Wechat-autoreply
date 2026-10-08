import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'

interface Request {
  id: string
  input: { root: string; paths: string[]; protect: boolean }
  done(): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}
const failure = (): Error => new Error('private_backup_permissions_invalid')

/** Reuses only the interpreter. Every request performs fresh operating-system ACL checks. */
export class WindowsPrivatePermissionWorker {
  private child?: ChildProcessWithoutNullStreams
  private active?: Request
  private readonly queue: Request[] = []
  private buffer = ''
  private idle?: ReturnType<typeof setTimeout>
  private closed = false
  constructor(
    private readonly executable: string,
    private readonly program: string,
    private readonly launch: () => ChildProcessWithoutNullStreams = () =>
      spawn(
        this.executable,
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(this.program, 'utf16le').toString('base64')
        ],
        { windowsHide: true, shell: false, stdio: 'pipe' }
      )
  ) {}

  request(root: string, paths: string[], protect: boolean): Promise<void> {
    if (this.closed || this.queue.length + Number(!!this.active) >= 64)
      return Promise.reject(failure())
    return new Promise<void>((done, reject) => {
      const item: Request = {
        id: randomUUID(),
        input: { root, paths: [...paths], protect },
        done,
        reject,
        // Includes time queued behind another check, not just interpreter execution.
        timer: setTimeout(() => this.fail(), 15000)
      }
      this.queue.push(item)
      this.pump()
    })
  }

  private pump(): void {
    if (this.active || !this.queue.length) return
    clearTimeout(this.idle)
    this.idle = undefined
    const item = (this.active = this.queue.shift()!)
    try {
      if (!this.child) {
        const child = (this.child = this.launch())
        child.stdout.setEncoding('utf8')
        child.stderr.resume()
        child.once('error', () => {
          if (this.child === child) this.fail()
        })
        child.once('close', () => {
          if (this.child === child) this.fail()
        })
        child.stdin.on('error', () => {
          if (this.child === child) this.fail()
        })
        child.stdout.on('error', () => {
          if (this.child === child) this.fail()
        })
        child.stdout.on('data', (chunk: string) => this.receive(child, chunk))
      }
      const child = this.child
      child.stdin.write(JSON.stringify({ id: item.id, ...item.input }) + '\n', (error) => {
        if (error && this.child === child) this.fail()
      })
    } catch {
      this.fail()
    }
  }

  private receive(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (this.child !== child) return
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer, 'utf8') > 4096) {
      this.fail()
      return
    }
    const newline = this.buffer.indexOf('\n')
    if (newline < 0) return
    try {
      const response: unknown = JSON.parse(this.buffer.slice(0, newline))
      // There is only one in-flight check. Extra output is never attributed to the next root.
      if (this.buffer.slice(newline + 1).trim()) throw failure()
      this.buffer = ''
      if (!response || typeof response !== 'object' || Array.isArray(response)) throw failure()
      const value = response as Record<string, unknown>
      if (
        Object.keys(value).length !== 2 ||
        value.id !== this.active?.id ||
        typeof value.ok !== 'boolean'
      )
        throw failure()
      const item = this.active!
      this.active = undefined
      clearTimeout(item.timer)
      if (value.ok) item.done()
      else item.reject(failure())
      this.pump()
      if (!this.active && !this.queue.length) this.idle = setTimeout(() => this.retire(child), 1000)
    } catch {
      this.fail()
    }
  }

  private retire(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return
    this.child = undefined
    this.buffer = ''
    child.stdin.end()
    child.kill()
  }
  private fail(): void {
    clearTimeout(this.idle)
    this.idle = undefined
    if (this.child) this.retire(this.child)
    const pending = [...(this.active ? [this.active] : []), ...this.queue.splice(0)]
    this.active = undefined
    for (const item of pending) {
      clearTimeout(item.timer)
      item.reject(failure())
    }
  }
  close(): void {
    this.closed = true
    this.fail()
  }
}
