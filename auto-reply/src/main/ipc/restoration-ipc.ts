import { ipcMain } from 'electron'
import { z } from 'zod'
import { rendererTrust } from './trusted-ipc'
import type { DesktopAgentRuntime } from '../services/desktop-agent-runtime'
import { RestorationInventorySubmitResultSchema } from '../../shared/contracts/restore-inventory'
import {
  RestorationStatusSchema,
  RestorationSubmitResultSchema
} from '../../shared/contracts/restoration'
import { RestorationApplyResultSchema } from '../../shared/contracts/restoration'

export function registerRestorationIpc(
  rendererFile: string,
  developerOrigin: string | undefined,
  runtime: Pick<
    DesktopAgentRuntime,
    'restorationStatus' | 'submitRestorePause' | 'submitRestoreInventory' | 'applyRestoreDecision'
  >
): void {
  const trusted = rendererTrust(rendererFile, developerOrigin)
  const inputSchema = z.strictObject({})
  ipcMain.handle('agent-restoration:apply-decision', (event, input: unknown) => {
    trusted(event)
    const request = inputSchema.parse(input)
    return runtime
      .applyRestoreDecision(request)
      .then((result) => RestorationApplyResultSchema.parse(result))
  })
  ipcMain.handle('agent-restoration:status', (event, input: unknown) => {
    trusted(event)
    inputSchema.parse(input)
    return RestorationStatusSchema.parse(runtime.restorationStatus())
  })
  ipcMain.handle('agent-restoration:submit-pause', (event, input: unknown) => {
    trusted(event)
    const request = inputSchema.parse(input)
    return runtime
      .submitRestorePause(request)
      .then((result) => RestorationSubmitResultSchema.parse(result))
  })
  ipcMain.handle('agent-restoration:submit-inventory', (event, input: unknown) => {
    trusted(event)
    const request = inputSchema.parse(input)
    return runtime
      .submitRestoreInventory(request)
      .then((result) => RestorationInventorySubmitResultSchema.parse(result))
  })
}
