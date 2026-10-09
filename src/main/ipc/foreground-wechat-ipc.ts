import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { rendererTrust } from './trusted-ipc'
import {
  ForegroundStartSchema,
  ForegroundResolutionSchema
} from '../../shared/contracts/foreground-wechat'
import { ForegroundWechatRuntime } from '../../core/agent/foreground-wechat'
import { ForegroundBatchRuntime } from '../../core/agent/foreground-batch'
import { ForegroundBatchNavigator } from '../services/foreground-batch-navigator'
import { BatchStartSchema } from '../../shared/contracts/foreground-batch'
import { SqliteForegroundJournal } from '../../core/persistence/foreground-journal'
import {
  ForegroundWechatDriver,
  type ForegroundConfiguration
} from '../services/foreground-wechat-driver'

export function registerForegroundWechatIpc(
  rendererFile: string,
  userData: string,
  configuration: (target: string) => ForegroundConfiguration,
  developerOrigin?: string
): {
  runtime: ForegroundWechatRuntime
  batch: ForegroundBatchRuntime
  pause: () => Promise<void>
  close: () => Promise<void>
} {
  const journal = new SqliteForegroundJournal(join(userData, 'agent', 'foreground-wechat.sqlite'))
  const runtime = new ForegroundWechatRuntime(
    new ForegroundWechatDriver(() => configuration(runtime.status().target)),
    journal,
    true,
    (value) => journal.saveSingle(value)
  )
  const batch = new ForegroundBatchRuntime(
    new ForegroundBatchNavigator(
      new ForegroundWechatDriver(() => configuration(batch.status().targets[0] ?? 'Q')),
      () => batch.status().targets[0] ?? 'Q'
    ),
    (target) => {
      const driver = new ForegroundWechatDriver(() => configuration(target))
      return {
        connect: (_target, signal) => driver.connect(target, signal, 'current_chat', false),
        metrics: () => driver.metrics(),
        receiptText: () => driver.receiptText(),
        receiptFingerprint: () => driver.receiptFingerprint(),
        seed: (messages) => driver.seed(messages),
        accept: (observation) => driver.accept(observation),
        read: (signal, fresh) => driver.read(signal, fresh),
        generate: (observation, signal) => driver.generate(observation, signal),
        dispatch: (observation, text, signal) => driver.dispatch(observation, text, signal)
      }
    },
    journal,
    true,
    journal
  )
  const trusted = rendererTrust(rendererFile, developerOrigin)
  let starting = false,
    operation = 0
  ipcMain.handle('foreground-wechat:status', (event) => {
    trusted(event)
    return runtime.status()
  })
  ipcMain.handle('foreground-wechat:start', async (event, raw: unknown) => {
    trusted(event)
    const input = ForegroundStartSchema.parse(raw)
    if (starting) throw new Error('personal_mode_busy')
    starting = true
    const epoch = ++operation
    try {
      await batch.pause()
      if (epoch !== operation) return runtime.status()
      if (input.resetBaseline) journal.clearSingle(input.target)
      const status = await runtime.start(
        input.target,
        input.connectionMode,
        input.pendingPreview ? { count: 1, preview: input.pendingPreview } : undefined,
        journal.loadSingle(input.target)
      )
      if (status.state === 'paused' && status.reason !== 'user_pause') {
        const window = BrowserWindow.fromWebContents(event.sender)
        if (window && !window.isDestroyed()) {
          window.show()
          window.focus()
        }
      }
      return status
    } finally {
      starting = false
    }
  })
  ipcMain.handle('foreground-wechat:pause', (event) => {
    trusted(event)
    operation++
    return runtime.pause()
  })
  ipcMain.handle('foreground-wechat:resolve', async (event, raw: unknown) => {
    trusted(event)
    const input = ForegroundResolutionSchema.parse(raw)
    if (starting) throw new Error('personal_mode_busy')
    starting = true
    operation++
    try {
      await Promise.all([runtime.pause(), batch.pause()])
      journal.resolve(input)
      return runtime.status()
    } finally {
      starting = false
    }
  })
  ipcMain.handle('foreground-wechat:batch-status', (event) => {
    trusted(event)
    return batch.status()
  })
  ipcMain.handle('foreground-wechat:batch-start', async (event, raw: unknown) => {
    trusted(event)
    const input = BatchStartSchema.parse(raw)
    if (starting) throw new Error('personal_mode_busy')
    starting = true
    const epoch = ++operation
    try {
      await runtime.pause()
      if (epoch !== operation) return batch.status()
      return await batch.start(input.targets)
    } finally {
      starting = false
    }
  })
  ipcMain.handle('foreground-wechat:batch-pause', (event) => {
    trusted(event)
    operation++
    return batch.pause()
  })
  const pause = async (): Promise<void> => {
    operation++
    await Promise.all([runtime.pause(), batch.pause()])
  }
  return {
    runtime,
    batch,
    pause,
    close: async () => {
      await pause()
      journal.close()
    }
  }
}
