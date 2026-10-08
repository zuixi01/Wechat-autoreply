import { z } from 'zod'
import { Id } from './identity'

export const DeviceScopeSchema = z.strictObject({
  tenant_id: Id,
  employee_id: Id,
  account_id: Id,
  agent_id: Id,
  platform: z.enum(['wechat', 'wework'])
})
export type DeviceScope = z.infer<typeof DeviceScopeSchema>
export const RegistrationInputSchema = z.strictObject({
  serverUrl: z.string().min(1).max(2048),
  enrollmentCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
})
export type RegistrationInput = z.infer<typeof RegistrationInputSchema>
export interface DeviceStatus {
  state: 'unregistered' | 'registered' | 'connected' | 'unavailable'
  serverUrl?: string
  scope?: DeviceScope
}
export type RegistrationResult =
  | { success: true; status: DeviceStatus }
  | {
      success: false
      code:
        | 'invalid_input'
        | 'insecure_server'
        | 'registration_failed'
        | 'storage_unavailable'
        | 'already_registering'
        | 'runtime_busy'
    }
export interface AgentDesktopApi {
  status(): Promise<DeviceStatus>
  refresh(): Promise<DeviceStatus>
  register(input: RegistrationInput): Promise<RegistrationResult>
}
