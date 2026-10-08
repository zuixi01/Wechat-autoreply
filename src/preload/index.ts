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

const adminHandler: AdminDesktopApi = {
  status: () => ipcRenderer.invoke('admin:status'),
  connect: (input) => ipcRenderer.invoke('admin:connect', input),
  disconnect: () => ipcRenderer.invoke('admin:disconnect'),
  runtime: (input) => ipcRenderer.invoke('admin:runtime', input),
  pauseAll: (input) => ipcRenderer.invoke('admin:pause-all', input),
  pauseSummary: (input) => ipcRenderer.invoke('admin:pause-summary', input),
  pauseAccounts: (input) => ipcRenderer.invoke('admin:pause-accounts', input)
}

const runtimeHandler: RuntimeDesktopApi = {
  status: () => ipcRenderer.invoke('agent-runtime:status'),
  synchronize: () => ipcRenderer.invoke('agent-runtime:synchronize'),
  start: () => ipcRenderer.invoke('agent-runtime:start'),
  pause: () => ipcRenderer.invoke('agent-runtime:pause')
}
const restorationHandler: RestorationDesktopApi = {
  status: () => ipcRenderer.invoke('agent-restoration:status', {}),
  submitPause: () => ipcRenderer.invoke('agent-restoration:submit-pause', {}),
  submitInventory: () => ipcRenderer.invoke('agent-restoration:submit-inventory', {}),
  applyDecision: () => ipcRenderer.invoke('agent-restoration:apply-decision', {})
}
const workbenchHandler: WorkbenchDesktopApi = {
  presentationTicket: (input) => ipcRenderer.invoke('agent-workbench:presentation-ticket', input),
  presentationAck: (input) => ipcRenderer.invoke('agent-workbench:presentation-ack', input),
  learn: (input) => ipcRenderer.invoke('agent-workbench:learn', input),
  snapshot: () => ipcRenderer.invoke('agent-workbench:snapshot'),
  act: (input) => ipcRenderer.invoke('agent-workbench:act', input),
  reviewEdited: (input) => ipcRenderer.invoke('agent-workbench:review-edited', input),
  confirmSend: (input) => ipcRenderer.invoke('agent-workbench:confirm-send', input),
  evidence: (input) => ipcRenderer.invoke('agent-workbench:evidence', input),
  reconcile: (input) => ipcRenderer.invoke('agent-workbench:reconcile', input)
}

const agentHandler: AgentDesktopApi = {
  status: () => ipcRenderer.invoke('agent:status'),
  refresh: () => ipcRenderer.invoke('agent:refresh'),
  register: (input: RegistrationInput) => ipcRenderer.invoke('agent:register', input)
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
  submit: (input) => ipcRenderer.invoke('learning-submission:submit', input),
  submissions: async (input) =>
    parseLearningSubmissionReadResponse(
      await ipcRenderer.invoke('learning-submission:receipts', input)
    ),
  readSubmissions: async (input) =>
    parseLearningSubmissionReadResult(
      await ipcRenderer.invoke('learning-submission:receipts', input)
    )
}
const learningHandler: LearningMemoryDesktopApi = {
  episode: (input) => ipcRenderer.invoke('learning:episode', input),
  modelDirectory: (input) => ipcRenderer.invoke('learning:model-directory', input),
  calibration: (input) => ipcRenderer.invoke('learning:calibration', input),
  importCalibration: (input) => ipcRenderer.invoke('learning:import-calibration', input),
  validate: (input) => ipcRenderer.invoke('learning:validate', input),
  curate: (input) => ipcRenderer.invoke('learning:curate', input),
  searchEpisodes: (input) => ipcRenderer.invoke('learning:search', input),
  reports: (input) => ipcRenderer.invoke('learning:reports', input),
  snapshot: (input) => ipcRenderer.invoke('learning:snapshot', input),
  detail: (input) => ipcRenderer.invoke('learning:detail', input),
  settings: (input) => ipcRenderer.invoke('learning:settings', input),
  act: (input) => ipcRenderer.invoke('learning:act', input),
  correct: (input) => ipcRenderer.invoke('learning:correct', input),
  confirmResult: (input) => ipcRenderer.invoke('learning:result', input),
  feedback: (input) => ipcRenderer.invoke('learning:feedback', input),
  review: (input) => ipcRenderer.invoke('learning:review', input),
  cancel: (input) => ipcRenderer.invoke('learning:cancel', input),
  forgetScope: (input) => ipcRenderer.invoke('learning:forget-scope', input),
  manual: (input) => ipcRenderer.invoke('learning:manual', input),
  assignLegacy: (input) => ipcRenderer.invoke('learning:assign-legacy', input)
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
      batchStatus: () => ipcRenderer.invoke('foreground-wechat:batch-status'),
      batchStart: (input: unknown) => ipcRenderer.invoke('foreground-wechat:batch-start', input),
      batchPause: () => ipcRenderer.invoke('foreground-wechat:batch-pause')
    })
    contextBridge.exposeInMainWorld('osInfo', { platform: process.platform })
  } catch (error) {
    console.error(error)
  }
} else {
  throw new Error('AutoReply requires an isolated preload context')
}

export type ElectronHandler = typeof electronHandler
