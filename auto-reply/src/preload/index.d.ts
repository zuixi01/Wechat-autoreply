import { ElectronHandler } from './index'
import type { AgentDesktopApi } from '../shared/contracts/registration'
import type { RuntimeDesktopApi } from '../shared/contracts/runtime'
import type { RestorationDesktopApi } from '../shared/contracts/restoration'
import type { WorkbenchDesktopApi } from '../shared/contracts/workbench'
import type { KnowledgeDesktopApi } from '../shared/contracts/knowledge'
import type { LearningMemoryDesktopApi } from '../shared/contracts/learning-desktop'
import type { LearningSubmissionDesktopApi } from '../shared/contracts/learning-submission-desktop'
import type { ForegroundDesktopApi } from '../shared/contracts/foreground-wechat'
import type { AdminDesktopApi } from '../shared/contracts/admin-gateway'

declare global {
  interface Window {
    electron: ElectronHandler
    agentDesktop: AgentDesktopApi
    adminDesktop: AdminDesktopApi
    agentRuntime: RuntimeDesktopApi
    agentRestoration: RestorationDesktopApi
    agentWorkbench: WorkbenchDesktopApi
    knowledge: KnowledgeDesktopApi
    learningMemory: LearningMemoryDesktopApi
    learningSubmissions: LearningSubmissionDesktopApi
    foregroundWechat: ForegroundDesktopApi
    osInfo: { platform: NodeJS.Platform }
  }
}

export {}
