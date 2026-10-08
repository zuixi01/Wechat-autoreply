import { ipcMain } from 'electron'
import { rendererTrust } from './trusted-ipc'
import { AdminConnection } from '../services/admin-connection'
import { join } from 'node:path'
import { FileAdminPauseJournal } from '../services/admin-pause-journal'

export function registerAdminIpc(
  rendererFile: string,
  userData: string,
  developerOrigin?: string
): AdminConnection {
  const connection = new AdminConnection(
    fetch,
    Boolean(developerOrigin),
    new FileAdminPauseJournal(join(userData, 'admin-operations'))
  )
  const trusted = rendererTrust(rendererFile, developerOrigin)
  ipcMain.handle('admin:status', (event) => {
    trusted(event)
    return connection.status()
  })
  ipcMain.handle('admin:connect', (event, input: unknown) => {
    trusted(event)
    return connection.connect(input)
  })
  ipcMain.handle('admin:disconnect', (event) => {
    trusted(event)
    return connection.disconnect()
  })
  ipcMain.handle('admin:runtime', (event, input: unknown) => {
    trusted(event)
    return connection.runtime(input)
  })
  ipcMain.handle('admin:pause-all', (event, input: unknown) => {
    trusted(event)
    return connection.pauseAll(input)
  })
  ipcMain.handle('admin:pause-summary', (event, input: unknown) => {
    trusted(event)
    return connection.pauseSummary(input)
  })
  ipcMain.handle('admin:pause-accounts', (event, input: unknown) => {
    trusted(event)
    return connection.pauseAccounts(input)
  })
  return connection
}
