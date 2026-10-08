import { ipcMain, safeStorage } from 'electron'
import { rendererTrust } from './trusted-ipc'
import Store from 'electron-store'
import { AgentRegistration, type EncryptedDeviceRecord } from '../services/agent-registration'
import { createDeviceCredentialCipher } from '../services/device-credential-cipher'
import type { RegistrationInput } from '../../shared/contracts/registration'
import { join } from 'node:path'
import { DesktopAgentRuntime } from '../services/desktop-agent-runtime'
import { Ledger } from '../../core/persistence/ledger'
import { registerRestorationIpc } from './restoration-ipc'
import { registerWorkbenchPresentationIpc } from './workbench-presentation-ipc'

export async function registerAgentIpc(
  rendererFile: string,
  userData: string,
  developerOrigin?: string,
  /** Trusted main host only. No IPC channel can install or switch this provider. */
  evaluationRuntime?: () => DesktopAgentRuntime | undefined
): Promise<DesktopAgentRuntime> {
  // Electron's CJS main bundle can receive the ESM module namespace from require().
  const StoreConstructor =
    typeof Store === 'function' ? Store : (Store as unknown as { default: typeof Store }).default
  const store = new StoreConstructor<{ device?: EncryptedDeviceRecord }>({ name: 'agent-device' })
  const client = new AgentRegistration(
    { load: () => store.get('device'), save: (record) => store.set('device', record) },
    createDeviceCredentialCipher(safeStorage),
    fetch,
    Boolean(developerOrigin)
  )
  // No platform adapter is installed until its native capabilities and permit lifecycle pass.
  // Initializing this runtime never reads or operates a chat client.
  const runtime = new DesktopAgentRuntime(
    new Ledger(join(userData, 'agent', 'ledger.sqlite')),
    client
  )
  // Host-owned private capture; neither paths nor recording permissions come from IPC.
  // Collection remains disabled until a verified native platform is separately installed.
  // Finish installation before exposing runtime IPC or loading the first renderer. A
  // legitimate startup pause must not race the still-opening private capture.
  await runtime
    .configureManagedTimingCapture(join(userData, 'agent', 'runtime-timing'))
    .catch(() => {
      console.error('[Agent] 私有计时证据采集未能初始化；运行与发送权限未改变。')
    })
  const trusted = rendererTrust(rendererFile, developerOrigin)
  runtime.configureMonitoring()
  ipcMain.handle('agent:status', (event) => {
    trusted(event)
    return client.status()
  })
  ipcMain.handle('agent:refresh', (event) => {
    trusted(event)
    return client.refresh()
  })
  ipcMain.handle('agent:register', async (event, input: RegistrationInput) => {
    trusted(event)
    if (evaluationRuntime?.()) return { success: false, code: 'runtime_busy' }
    if (!(await runtime.deviceChanged()).pauseAcknowledged)
      return { success: false, code: 'runtime_busy' }
    return client.register(input)
  })
  registerRuntimeWorkbenchIpc(rendererFile, developerOrigin, () => evaluationRuntime?.() ?? runtime)
  return runtime
}

/** Reuses the production workbench and compositor checks for a host-owned current runtime. */
export function registerRuntimeWorkbenchIpc(
  rendererFile: string,
  developerOrigin: string | undefined,
  current: () => DesktopAgentRuntime
): void {
  const trusted = rendererTrust(rendererFile, developerOrigin)
  registerWorkbenchPresentationIpc(rendererFile, developerOrigin, {
    presentationTarget: (input) => current().presentationTarget(input),
    recordPresentation: (receipt) => current().recordPresentation(receipt)
  })
  ipcMain.handle('agent-runtime:status', (event) => {
    trusted(event)
    return current().status()
  })
  ipcMain.handle('agent-runtime:synchronize', (event) => {
    trusted(event)
    return current().synchronize()
  })
  ipcMain.handle('agent-runtime:start', (event) => {
    trusted(event)
    return current().start()
  })
  ipcMain.handle('agent-runtime:pause', (event) => {
    trusted(event)
    return current().pause()
  })
  ipcMain.handle('agent-workbench:snapshot', (event) => {
    trusted(event)
    return current().workbench()
  })
  ipcMain.handle('agent-workbench:act', (event, input: unknown) => {
    trusted(event)
    return current().workbenchAction(input)
  })
  ipcMain.handle('agent-workbench:review-edited', (event, input: unknown) => {
    trusted(event)
    return current().workbenchReviewEdited(input)
  })
  ipcMain.handle('agent-workbench:confirm-send', (event, input: unknown) => {
    trusted(event)
    return current().workbenchConfirmSend(input)
  })
  ipcMain.handle('agent-workbench:evidence', (event, input: unknown) => {
    trusted(event)
    return current().workbenchEvidence(input)
  })
  ipcMain.handle('agent-workbench:reconcile', (event, input: unknown) => {
    trusted(event)
    return current().workbenchReconcile(input)
  })
  ipcMain.handle('agent-workbench:learn', (event, input: unknown) => {
    trusted(event)
    return current().workbenchLearn(input)
  })
  const runtime = new Proxy({} as DesktopAgentRuntime, {
    get(_target, name) {
      const owner = current()
      const value: unknown = owner[name as keyof DesktopAgentRuntime]
      return typeof value === 'function' ? value.bind(owner) : value
    }
  })
  registerRestorationIpc(rendererFile, developerOrigin, runtime)
}
