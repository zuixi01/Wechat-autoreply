/** Bounds network generation, independently of the one physical desktop send. */
export class ForegroundGenerationGate {
  private active = 0
  private waiting: (() => void)[] = []
  constructor(private readonly limit = 2) {}
  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    while (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          signal.removeEventListener('abort', abort)
          resolve()
        }
        const abort = (): void => {
          this.waiting = this.waiting.filter((value) => value !== wake)
          reject(new Error('cancelled'))
        }
        if (signal.aborted) {
          abort()
          return
        }
        this.waiting.push(wake)
        signal.addEventListener('abort', abort, { once: true })
      })
    }
    if (signal.aborted) throw new Error('cancelled')
    this.active++
    try {
      return await operation()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}
