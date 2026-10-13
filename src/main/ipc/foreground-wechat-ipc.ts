import { BrowserWindow, ipcMain, dialog } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { z } from 'zod'
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
import { PersonalStyle } from '../../core/memory/personal-style'
import { PersonalStickerStore } from '../services/personal-sticker-store'
import { StyleEditSchema } from '../../shared/contracts/personal-resources'
import { hashContext } from '../../core/reply/hashes'
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
  const style = new PersonalStyle(
    join(userData, 'agent', 'personal-style.sqlite'),
    userData,
    (text) => journal.isGenerated(text)
  )
  const stickers = new PersonalStickerStore(join(userData, 'agent', 'stickers'))
  const modelCompatibility = {
    unsupportedReasoning: new Set<string>(),
    unsupportedStructuredVision: new Set<string>()
  }
  let closed = false
  let listTarget = 'Q'
  const configured = (target: string): ForegroundConfiguration => ({
    ...configuration(target),
    ownerStyle: () => style.examples(target),
    stickers: () => stickers.available(target),
    stickerStore: stickers,
    manual: (observation, messages) => {
      setImmediate(() => {
        if (closed) return
        try {
          messages.forEach((message, index) =>
            style.observe(target, hashContext([observation, index]), message.text)
          )
        } catch {
          console.warn('[PersonalStyle] observation_not_saved')
        }
      })
    }
  })
  const personalDriver = new ForegroundWechatDriver(
    () => configured(runtime.activity().target),
    undefined,
    modelCompatibility
  )
  const runtime = new ForegroundWechatRuntime(personalDriver, journal, true, (value) =>
    journal.saveSingle(value)
  )
  const batch = new ForegroundBatchRuntime(
    new ForegroundBatchNavigator(
      new ForegroundWechatDriver(() => configured(listTarget), undefined, modelCompatibility),
      () => listTarget
    ),
    (target) => {
      const driver = new ForegroundWechatDriver(
        () => configured(target),
        undefined,
        modelCompatibility
      )
      return {
        connect: (_target, signal) => driver.connect(target, signal, 'current_chat', false),
        metrics: () => driver.metrics(),
        dispatchFailure: () => driver.dispatchFailure(),
        receiptText: () => driver.receiptText(),
        receiptFingerprint: () => driver.receiptFingerprint(),
        receiptBaseline: () => driver.receiptBaseline(),
        reconcileHistory: (baseline, next, signal) =>
          driver.reconcileHistory(baseline, next, signal),
        seed: (messages) => driver.seed(messages),
        accept: (observation) => driver.accept(observation),
        read: (signal, fresh) => driver.read(signal, fresh),
        generate: (observation, signal, incoming) => driver.generate(observation, signal, incoming),
        generatePlan: (observation, signal, incoming) =>
          driver.generatePlan(observation, signal, incoming),
        dispatchImage: (observation, part, signal) =>
          driver.dispatchImage(observation, part, signal),
        manual: (observation, messages) => driver.manual(observation, messages),
        dispatch: (observation, text, signal) => driver.dispatch(observation, text, signal),
        verifyReceipt: (observation, text, signal) =>
          driver.verifyReceipt(observation, text, signal)
      }
    },
    journal,
    true,
    journal
  )
  const trusted = rendererTrust(rendererFile, developerOrigin)
  ipcMain.handle('foreground-wechat:resources', (event, raw: unknown) => {
    trusted(event)
    const target = z.string().trim().max(128).parse(raw)
    return {
      stickers: stickers.list(),
      style: style.list(target),
      learningEnabled: style.enabled()
    }
  })
  ipcMain.handle('foreground-wechat:import-sticker', async (event) => {
    trusted(event)
    const result = await dialog.showOpenDialog({
      title: '导入本地静态表情图片',
      properties: ['openFile'],
      filters: [{ name: 'PNG / JPEG', extensions: ['png', 'jpg', 'jpeg'] }]
    })
    if (result.canceled || result.filePaths.length !== 1) return null
    const path = result.filePaths[0]
    if ((await stat(path)).size > 4 * 1024 * 1024) throw new Error('image_invalid')
    return stickers.import(
      await readFile(path),
      basename(path)
        .replace(/\.[^.]+$/, '')
        .slice(0, 40) || '表情',
      []
    )
  })
  ipcMain.handle('foreground-wechat:edit-sticker', (event, raw: unknown) => {
    trusted(event)
    const input = z
      .strictObject({
        id: z.string().uuid(),
        enabled: z.boolean().optional(),
        label: z.string().trim().min(1).max(40).optional(),
        tags: z.array(z.string().trim().min(1).max(20)).max(8).optional(),
        delete: z.boolean().optional()
      })
      .parse(raw)
    if (input.delete) stickers.delete(input.id)
    else {
      const { id, ...patch } = input
      delete patch.delete
      stickers.update(id, patch)
    }
  })
  ipcMain.handle('foreground-wechat:edit-style', (event, raw: unknown) => {
    trusted(event)
    const input = StyleEditSchema.parse(raw)
    if (input.action === 'teach' && input.text) style.teach(input.target, input.text)
    else if (input.action === 'correct' && input.id && input.text)
      style.correct(input.target, input.id, input.text)
    else if (input.action === 'delete' && input.id) style.delete(input.target, input.id)
    else if (input.action === 'rollback' && input.id) style.rollback(input.target, input.id)
    else throw new Error('style_edit_invalid')
  })
  ipcMain.handle('foreground-wechat:enable-learning', (event, raw: unknown) => {
    trusted(event)
    style.setEnabled(z.boolean().parse(raw))
  })
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
      if (input.resetBaseline) {
        await runtime.pause()
        if (epoch !== operation) return runtime.status()
        journal.clearSingle(input.target)
        personalDriver.resetHistory()
      }
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
  ipcMain.handle('foreground-wechat:acknowledge-handoff', (event, raw: unknown) => {
    trusted(event)
    journal.acknowledgeHandoff(z.string().uuid().parse(raw))
  })
  ipcMain.handle('foreground-wechat:batch-start', async (event, raw: unknown) => {
    trusted(event)
    const input = BatchStartSchema.parse(raw)
    listTarget = input.targets[0]
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
      closed = true
      style.close()
      journal.close()
    }
  }
}
