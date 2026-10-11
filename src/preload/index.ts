import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AgentDesktopApi, RegistrationInput } from '../shared/contracts/registration'
import type { RuntimeDesktopApi } from '../shared/contracts/runtime'
import type { RestorationDesktopApi } from '../shared/contracts/restoration'
import type { WorkbenchDesktopApi } from '../shared/contracts/workbench'
import type { KnowledgeDesktopApi } from '../shared/contracts/knowledge'
import type { LearningMemoryDesktopApi } from '../shared/contracts/learning-desktop'
import {
  parseLearningSubmissionReadResponse,
  parseLearningSubmissionReadResult,
  type LearningSubmissionDesktopApi
} from '../shared/contracts/learning-submission-desktop'
import { assertLegacyChannel } from './legacy-channels'
import type { AdminDesktopApi } from '../shared/contracts/admin-gateway'

let advancedReady: Promise<void> | undefined
async function invokeAdvanced(
  channel: string,
  ...args: unknown[]
): ReturnType<typeof ipcRenderer.invoke> {
  await (advancedReady ??= ipcRenderer.invoke('features:advanced-enable'))
  return ipcRenderer.invoke(channel, ...args)
}

const adminHandler: AdminDesktopApi = {
  status: () => invokeAdvanced('admin:status'),
  connect: (input) => invokeAdvanced('admin:connect', input),
  disconnect: () => invokeAdvanced('admin:disconnect'),
  runtime: (input) => invokeAdvanced('admin:runtime', input),
  pauseAll: (input) => invokeAdvanced('admin:pause-all', input),
  pauseSummary: (input) => invokeAdvanced('admin:pause-summary', input),
  pauseAccounts: (input) => invokeAdvanced('admin:pause-accounts', input)
}

const runtimeHandler: RuntimeDesktopApi = {
  status: () => invokeAdvanced('agent-runtime:status'),
  synchronize: () => invokeAdvanced('agent-runtime:synchronize'),
  start: () => invokeAdvanced('agent-runtime:start'),
  pause: () => invokeAdvanced('agent-runtime:pause')
}
const restorationHandler: RestorationDesktopApi = {
  status: () => invokeAdvanced('agent-restoration:status', {}),
  submitPause: () => invokeAdvanced('agent-restoration:submit-pause', {}),
  submitInventory: () => invokeAdvanced('agent-restoration:submit-inventory', {}),
  applyDecision: () => invokeAdvanced('agent-restoration:apply-decision', {})
}
const workbenchHandler: WorkbenchDesktopApi = {
  presentationTicket: (input) => invokeAdvanced('agent-workbench:presentation-ticket', input),
  presentationAck: (input) => invokeAdvanced('agent-workbench:presentation-ack', input),
  learn: (input) => invokeAdvanced('agent-workbench:learn', input),
  snapshot: () => invokeAdvanced('agent-workbench:snapshot'),
  act: (input) => invokeAdvanced('agent-workbench:act', input),
  reviewEdited: (input) => invokeAdvanced('agent-workbench:review-edited', input),
  confirmSend: (input) => invokeAdvanced('agent-workbench:confirm-send', input),
  evidence: (input) => invokeAdvanced('agent-workbench:evidence', input),
  reconcile: (input) => invokeAdvanced('agent-workbench:reconcile', input)
}

const agentHandler: AgentDesktopApi = {
  status: () => invokeAdvanced('agent:status'),
  refresh: () => invokeAdvanced('agent:refresh'),
  register: (input: RegistrationInput) => invokeAdvanced('agent:register', input)
}

const knowledgeHandler: KnowledgeDesktopApi = {
  snapshot: () => ipcRenderer.invoke('knowledge:snapshot'),
  importFile: (input) => ipcRenderer.invoke('knowledge:import', input),
  save: (input) => ipcRenderer.invoke('knowledge:save', input),
  detail: (id) => ipcRenderer.invoke('knowledge:detail', id),
  update: (input) => ipcRenderer.invoke('knowledge:update', input),
  remove: (id) => ipcRenderer.invoke('knowledge:remove', id),
  settings: (input) => ipcRenderer.invoke('knowledge:settings', input),
  search: (query) => ipcRenderer.invoke('knowledge:search', query),
  answer: (input) => ipcRenderer.invoke('knowledge:answer', input),
  export: () => ipcRenderer.invoke('knowledge:export')
}
const learningSubmissionHandler: LearningSubmissionDesktopApi = {
  submit: (input) => invokeAdvanced('learning-submission:submit', input),
  submissions: async (input) =>
    parseLearningSubmissionReadResponse(
      await invokeAdvanced('learning-submission:receipts', input)
    ),
  readSubmissions: async (input) =>
    parseLearningSubmissionReadResult(await invokeAdvanced('learning-submission:receipts', input))
}
const learningHandler: LearningMemoryDesktopApi = {
  episode: (input) => invokeAdvanced('learning:episode', input),
  modelDirectory: (input) => invokeAdvanced('learning:model-directory', input),
  calibration: (input) => invokeAdvanced('learning:calibration', input),
  importCalibration: (input) => invokeAdvanced('learning:import-calibration', input),
  validate: (input) => invokeAdvanced('learning:validate', input),
  curate: (input) => invokeAdvanced('learning:curate', input),
  searchEpisodes: (input) => invokeAdvanced('learning:search', input),
  reports: (input) => invokeAdvanced('learning:reports', input),
  snapshot: (input) => invokeAdvanced('learning:snapshot', input),
  detail: (input) => invokeAdvanced('learning:detail', input),
  settings: (input) => invokeAdvanced('learning:settings', input),
  act: (input) => invokeAdvanced('learning:act', input),
  correct: (input) => invokeAdvanced('learning:correct', input),
  confirmResult: (input) => invokeAdvanced('learning:result', input),
  feedback: (input) => invokeAdvanced('learning:feedback', input),
  review: (input) => invokeAdvanced('learning:review', input),
  cancel: (input) => invokeAdvanced('learning:cancel', input),
  forgetScope: (input) => invokeAdvanced('learning:forget-scope', input),
  manual: (input) => invokeAdvanced('learning:manual', input),
  assignLegacy: (input) => invokeAdvanced('learning:assign-legacy', input)
}

const electronHandler = {
  // Keep the old native invoke return contract until each legacy screen is migrated.
  invoke: (channel: string, ...args: unknown[]): ReturnType<typeof ipcRenderer.invoke> => {
    assertLegacyChannel('invoke', channel)
    return ipcRenderer.invoke(channel, ...args)
  },
  on: <Payload extends unknown[]>(
    channel: string,
    callback: (...args: Payload) => void
  ): (() => void) => {
    assertLegacyChannel('on', channel)
    const handler = (_: IpcRendererEvent, ...args: unknown[]): void =>
      callback(...(args as Payload))
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  },
  send: (channel: string, ...args: unknown[]): void => {
    assertLegacyChannel('send', channel)
    ipcRenderer.send(channel, ...args)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronHandler)
    contextBridge.exposeInMainWorld('agentDesktop', agentHandler)
    contextBridge.exposeInMainWorld('adminDesktop', adminHandler)
    contextBridge.exposeInMainWorld('agentRuntime', runtimeHandler)
    contextBridge.exposeInMainWorld('agentRestoration', restorationHandler)
    contextBridge.exposeInMainWorld('agentWorkbench', workbenchHandler)
    contextBridge.exposeInMainWorld('knowledge', knowledgeHandler)
    contextBridge.exposeInMainWorld('learningMemory', learningHandler)
    contextBridge.exposeInMainWorld('learningSubmissions', learningSubmissionHandler)
    contextBridge.exposeInMainWorld('foregroundWechat', {
      status: () => ipcRenderer.invoke('foreground-wechat:status'),
      start: (input: unknown) => ipcRenderer.invoke('foreground-wechat:start', input),
      pause: () => ipcRenderer.invoke('foreground-wechat:pause'),
      resolve: (input: unknown) => ipcRenderer.invoke('foreground-wechat:resolve', input),
      acknowledgeHandoff: (id: string) =>
        ipcRenderer.invoke('foreground-wechat:acknowledge-handoff', id),
      batchStatus: () => ipcRenderer.invoke('foreground-wechat:batch-status'),
      batchStart: (input: unknown) => ipcRenderer.invoke('foreground-wechat:batch-start', input),
      batchPause: () => ipcRenderer.invoke('foreground-wechat:batch-pause'),
      resources: (target: string) => ipcRenderer.invoke('foreground-wechat:resources', target),
      importSticker: () => ipcRenderer.invoke('foreground-wechat:import-sticker'),
      editSticker: (input: unknown) => ipcRenderer.invoke('foreground-wechat:edit-sticker', input),
      editStyle: (input: unknown) => ipcRenderer.invoke('foreground-wechat:edit-style', input),
      enableLearning: (enabled: boolean) =>
        ipcRenderer.invoke('foreground-wechat:enable-learning', enabled)
    })
    contextBridge.exposeInMainWorld('osInfo', { platform: process.platform })
  } catch (error) {
    console.error(error)
  }
} else {
  throw new Error('AutoReply requires an isolated preload context')
}

export type ElectronHandler = typeof electronHandler
