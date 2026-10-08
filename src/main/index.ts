import { app, shell, BrowserWindow, nativeImage, nativeTheme, powerMonitor } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import iconFile from '../../resources/icon.png?asset'
import { checkAndRequestPermissions } from './permission'
import Store from 'electron-store'
import { AIClient } from '../core/ai-client'
import { AppType, BoxRegions, CaptureStrategy } from '../core/rpa/types'
import { runBoxSelectWizard, type WizardStepKey } from './overlay-window'
import {
  getBuiltinDoubaoInstalledInfo,
  getBuiltinDoubaoManifestForUi,
  getInstalledProviderManifest,
  installProviderFromUrl,
  InstalledProviderInfo
} from './provider-bundle'
import {
  SkillEngineController,
  SkillPauseResult,
  SkillStartResult,
  startSkillServer,
  stopSkillServer
} from './skill-server'
import {
  listTraceSessions,
  readTraceScreenshot,
  readTraceSession
} from '../core/trace/trace-recorder'
import { ExperienceStore, NewExperienceCard } from '../core/memory/experience-store'
import { induceCardsFromSession } from '../core/memory/learn-from-session'
import { ModelConfig, ModelCapability, ReplyMode, SpecificObject } from '../core/types'
import { randomUUID } from 'crypto'
import { registerAgentIpc } from './ipc/agent-ipc'
import { registerAdminIpc } from './ipc/admin-ipc'
import type { AdminConnection } from './services/admin-connection'
import { registerKnowledgeIpc } from './ipc/knowledge-ipc'
import { buildContextSection } from '../core/ai-client'
import type { KnowledgeStore } from '../core/knowledge/knowledge-store'
import type { DesktopAgentRuntime } from './services/desktop-agent-runtime'
import { createLegacyIpc } from './ipc/trusted-ipc'
import { pauseAllReplyRuntimes } from './services/legacy-runtime-control'
import { LearningStore } from '../core/memory/learning-store'
import {
  StructuredLearningReviewer,
  type LearningReviewTransport
} from '../core/memory/learning-reviewer'
import { HttpLearningReviewTransport } from '../core/memory/learning-transport'
import { LearningService } from './services/learning-service'
import { LearningKnowledgeAnswers } from './services/learning-knowledge'
import { LearningProductValidation } from './services/learning-product-validation'
import { learningCalibrationRules } from './services/learning-validation-policy'
import { registerLearningIpc } from './ipc/learning-ipc'
import { registerLearningSubmissionIpc } from './ipc/learning-submission-ipc'
import { learningHash } from '../core/memory/learning-scope'
import {
  resolveLearningReviewModel,
  learningReviewModelDirectory
} from '../core/memory/learning-model-configuration'
import { LearningSettingsSchema } from '../shared/contracts/learning-memory'
import { defaultReplyMode, objectReplyPolicy } from '../shared/reply-rules'
import { registerForegroundWechatIpc } from './ipc/foreground-wechat-ipc'
import { knowledgeInstructions } from '../core/knowledge/knowledge-reply'
import {
  HostModelConfigurationAudit,
  hostModelConfigurationHash
} from './services/host-model-configuration-audit'
let hostModelAudit: HostModelConfigurationAudit | undefined
let foregroundWechat: ReturnType<typeof registerForegroundWechatIpc> | undefined
let learningService: LearningService
let reliableRuntime: DesktopAgentRuntime | undefined
let knowledgeStore: KnowledgeStore
let reliableQuitRequested = false
let adminConnection: AdminConnection | undefined
let advancedInitialization: Promise<void> | undefined
// A second process must not open or recover the first process's durable outbox.
if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', () => {
  const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  if (window) {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
})
const StoreClass =
  typeof Store === 'function' ? Store : (Store as unknown as { default: typeof Store }).default

const icon = nativeImage.createFromPath(iconFile)

const FIXED_ARK_MODEL = 'doubao-seed-2-0-lite-260215'
const FIXED_ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'

const PROVIDER_PRESETS = [
  {
    id: 'volcengine-ark',
    name: '火山方舟',
    defaultBaseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seed-2-0-lite-260215',
    defaultCapabilities: ['text', 'vision']
  },
  {
    id: 'aliyun-bailian',
    name: '阿里云百炼',
    defaultBaseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-vl-plus',
    defaultCapabilities: ['text', 'vision']
  },
  {
    id: 'openai',
    name: 'OpenAI',
    defaultBaseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    defaultCapabilities: ['text', 'vision']
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    defaultBaseURL: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    defaultCapabilities: ['text']
  },
  {
    id: 'custom',
    name: '自定义',
    defaultBaseURL: '',
    defaultModel: '',
    defaultCapabilities: ['text']
  }
]

interface PerAppCapture {
  strategy: CaptureStrategy
  regions: BoxRegions | null
}

interface AppSettings {
  locale: 'zh' | 'en'
  theme: 'dark' | 'light'
  appType: AppType
  vision: {
    apiKey: string
    model: string
    baseURL: string
  }
  chatProvider: {
    manifestUrl: string
    installed: InstalledProviderInfo | null
    config: Record<string, unknown>
  }
  defaultCaptureStrategy: CaptureStrategy
  capture: Partial<Record<AppType, PerAppCapture>>
  models: ModelConfig[]
  globalVisionModelId: string
  globalReplyModelId: string
  modes: ReplyMode[]
  globalDefaultModeId: string
  globalAutoReply: boolean
}

type AppSettingsPatch = Omit<Partial<AppSettings>, 'vision' | 'chatProvider'> & {
  vision?: Partial<AppSettings['vision']>
  chatProvider?: Partial<AppSettings['chatProvider']>
}
type LegacySettingsInput = AppSettingsPatch & {
  apiKey?: string
  model?: string
  systemPrompt?: string
  providerManifestUrl?: string
}

function persistSettings(next: Partial<AppSettings>): void {
  const write = (): void => settingsStore.set({ ...settingsStore.store, ...next })
  if (!hostModelAudit) {
    write()
    return
  }
  const readHash = (): string => hostModelConfigurationHash(normalizeSettings(settingsStore.store))
  const nextHash = hostModelConfigurationHash(
    normalizeSettings({ ...settingsStore.store, ...next })
  )
  hostModelAudit.change(nextHash, write, readHash)
}
function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string')
    return error.message || String(error)
  return String(error)
}

type ProviderConfigFieldType = 'text' | 'password' | 'url' | 'select' | 'textarea'

type ProviderConfigField = {
  key: string
  label: string
  type: ProviderConfigFieldType
  required?: boolean
  readonly?: boolean
  placeholder?: string
  hint?: string
  defaultValue?: string
  options?: Array<{ label: string; value: string }>
}

type ProviderCatalogItem = {
  id: string
  name: string
  description?: string
  version: string
  manifestUrl: string
  capabilities?: string[]
  configSchema: {
    fields: ProviderConfigField[]
  }
}

type ProviderHubCache = {
  sourceUrl: string
  fetchedAt: string
  providers: ProviderCatalogItem[]
}

type ProviderHubEntry = {
  id?: unknown
  enabled?: unknown
  manifestUrl?: unknown
}

type ProviderHubManifest = {
  id?: unknown
  name?: unknown
  description?: unknown
  version?: unknown
  capabilities?: unknown
  configSchema?: unknown
}

const DEFAULT_PROVIDER_HUB_URL =
  process.env.AUTOREPLY_PROVIDER_HUB_URL || 'https://sightflow.dev/provider-hub.json'
const PROVIDER_HUB_CACHE_KEY = 'providerHubCache'

const settingsStore = new StoreClass<AppSettings>({
  name: 'settings',
  defaults: {
    locale: 'zh',
    theme: 'dark',
    appType: 'wechat',
    vision: { apiKey: '', model: FIXED_ARK_MODEL, baseURL: FIXED_ARK_BASE_URL },
    chatProvider: {
      manifestUrl: '',
      installed: null,
      config: {}
    },
    defaultCaptureStrategy: 'auto',
    capture: {},
    models: [],
    globalVisionModelId: '',
    globalReplyModelId: '',
    modes: [],
    globalDefaultModeId: '',
    globalAutoReply: false
  }
})

let settingsWindow: BrowserWindow | null = null
let memoryWindow: BrowserWindow | null = null
const modeUserInputCache = new Map<string, string>()

// ── 工作记忆（work-trace + 经验卡片）单例，首次使用时初始化 ──
let experienceStoreInstance: ExperienceStore | null = null

function worktraceBaseDir(): string {
  return join(app.getPath('userData'), 'worktrace')
}

function getExperienceStore(): ExperienceStore {
  if (!experienceStoreInstance) {
    experienceStoreInstance = new ExperienceStore(join(worktraceBaseDir(), 'memory', 'cards.json'))
  }
  return experienceStoreInstance
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1380,
    height: 940,
    minWidth: 760,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#0a0b10',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  let shown = false
  const showOnce = (): void => {
    if (shown || mainWindow.isDestroyed()) return
    shown = true
    mainWindow.show()
  }
  mainWindow.once('ready-to-show', showOnce)
  // Some Windows rendering configurations do not emit ready-to-show while
  // initially hidden. Loaded UI must still appear, and must only show once so
  // a late paint event cannot take foreground back from the selected WeChat.
  mainWindow.webContents.once('did-finish-load', showOnce)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return
  }

  settingsWindow = new BrowserWindow({
    width: 900,
    height: 720,
    minWidth: 860,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#0a0b10',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  settingsWindow.on('ready-to-show', () => {
    settingsWindow?.show()
  })

  settingsWindow.on('closed', () => {
    settingsWindow = null
  })

  settingsWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    settingsWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=settings`)
  } else {
    settingsWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'settings' }
    })
  }
}

function createMemoryWindow(): void {
  if (memoryWindow && !memoryWindow.isDestroyed()) {
    memoryWindow.show()
    memoryWindow.focus()
    return
  }

  memoryWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 980,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#0a0b10',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  memoryWindow.on('ready-to-show', () => {
    memoryWindow?.show()
  })

  memoryWindow.on('closed', () => {
    memoryWindow = null
  })

  memoryWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    memoryWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=memory`)
  } else {
    memoryWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'memory' }
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeFieldType(value: unknown, format?: unknown): ProviderConfigFieldType {
  if (value === 'password' || value === 'url' || value === 'select' || value === 'textarea') {
    return value
  }
  if (format === 'password') return 'password'
  if (format === 'uri' || format === 'url') return 'url'
  return 'text'
}

function normalizeOptions(value: unknown): Array<{ label: string; value: string }> | undefined {
  if (!Array.isArray(value)) return undefined
  const options = value
    .map((item) => {
      if (typeof item === 'string') return { label: item, value: item }
      if (!isRecord(item)) return null
      const label = typeof item.label === 'string' ? item.label : String(item.value || '')
      const optionValue = typeof item.value === 'string' ? item.value : ''
      return optionValue ? { label, value: optionValue } : null
    })
    .filter(Boolean) as Array<{ label: string; value: string }>
  return options.length ? options : undefined
}

function normalizeManifestConfigFields(configSchema: unknown): ProviderConfigField[] {
  if (!isRecord(configSchema)) return []

  const required = Array.isArray(configSchema.required)
    ? configSchema.required.filter((key): key is string => typeof key === 'string')
    : []

  if (Array.isArray(configSchema.fields)) {
    return configSchema.fields
      .map((field) => {
        if (!isRecord(field) || typeof field.key !== 'string') return null
        return {
          key: field.key,
          label: typeof field.label === 'string' ? field.label : field.key,
          type: normalizeFieldType(field.type),
          required: field.required === true || required.includes(field.key),
          readonly: field.readonly === true,
          placeholder: typeof field.placeholder === 'string' ? field.placeholder : undefined,
          hint: typeof field.hint === 'string' ? field.hint : undefined,
          defaultValue: typeof field.defaultValue === 'string' ? field.defaultValue : undefined,
          options: normalizeOptions(field.options)
        }
      })
      .filter(Boolean) as ProviderConfigField[]
  }

  if (!isRecord(configSchema.properties)) return []

  return Object.entries(configSchema.properties).map(([key, property]) => {
    const schema = isRecord(property) ? property : {}
    const title = typeof schema.title === 'string' ? schema.title : key
    return {
      key,
      label: title,
      type: normalizeFieldType(schema.type, schema.format),
      required: required.includes(key),
      readonly: schema.readonly === true || schema.readOnly === true,
      placeholder: typeof schema.placeholder === 'string' ? schema.placeholder : undefined,
      hint: typeof schema.description === 'string' ? schema.description : undefined,
      defaultValue: typeof schema.default === 'string' ? schema.default : undefined,
      options: normalizeOptions(schema.enum)
    }
  })
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`)
  }
  return response.json()
}

function getCachedProviderHub(): ProviderHubCache | null {
  const cached = settingsStore.get(PROVIDER_HUB_CACHE_KEY)
  if (!isRecord(cached) || !Array.isArray(cached.providers)) return null
  return cached as ProviderHubCache
}

async function fetchProviderHub(url = DEFAULT_PROVIDER_HUB_URL): Promise<ProviderHubCache> {
  const hub = await fetchJson(url)
  if (!isRecord(hub) || !Array.isArray(hub.providers)) {
    throw new Error('Provider hub JSON must contain a providers array')
  }

  const providers = await Promise.all(
    (hub.providers as ProviderHubEntry[])
      .filter((entry) => entry?.enabled !== false && typeof entry?.manifestUrl === 'string')
      .map(async (entry) => {
        const manifestUrl = entry.manifestUrl as string
        const manifest = (await fetchJson(manifestUrl)) as ProviderHubManifest
        const id =
          typeof manifest.id === 'string'
            ? manifest.id
            : typeof entry.id === 'string'
              ? entry.id
              : manifestUrl
        const name = typeof manifest.name === 'string' ? manifest.name : id
        const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0'
        const capabilities = Array.isArray(manifest.capabilities)
          ? manifest.capabilities.filter((item): item is string => typeof item === 'string')
          : undefined
        const description =
          typeof manifest.description === 'string' ? manifest.description : undefined

        return {
          id,
          name,
          description,
          version,
          manifestUrl,
          capabilities,
          configSchema: {
            fields: normalizeManifestConfigFields(manifest.configSchema)
          }
        }
      })
  )

  const cache = {
    sourceUrl: url,
    fetchedAt: new Date().toISOString(),
    providers
  }
  settingsStore.set(PROVIDER_HUB_CACHE_KEY, cache)
  return cache
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.autoreply.desktop')
  const legacyIpc = createLegacyIpc(
    join(__dirname, '../renderer/index.html'),
    is.dev ? process.env.ELECTRON_RENDERER_URL : undefined
  )
  const enableAdvanced = (): Promise<void> =>
    (advancedInitialization ??= (async () => {
      reliableRuntime = await registerAgentIpc(
        join(__dirname, '../renderer/index.html'),
        app.getPath('userData'),
        is.dev ? process.env.ELECTRON_RENDERER_URL : undefined
      )
      adminConnection = registerAdminIpc(
        join(__dirname, '../renderer/index.html'),
        app.getPath('userData'),
        is.dev ? process.env.ELECTRON_RENDERER_URL : undefined
      )
      const learningWorkspaceId =
        (settingsStore.get('learningWorkspaceId') as string) || randomUUID()
      settingsStore.set('learningWorkspaceId', learningWorkspaceId)
      const learningStore = new LearningStore(
        join(app.getPath('userData'), 'worktrace', 'memory', 'learning.sqlite')
      )
      hostModelAudit = new HostModelConfigurationAudit(
        join(app.getPath('userData'), 'worktrace', 'memory', 'learning.sqlite'),
        hostModelConfigurationHash(normalizeSettings(settingsStore.store))
      )
      const learningTransport: LearningReviewTransport = {
        complete: (request, signal) => {
          const settings = normalizeSettings(settingsStore.store)
          hostModelAudit!.reconcile(hostModelConfigurationHash(settings))
          const normal = resolveModelConfig(settings, settings.globalReplyModelId)
          const model = resolveLearningReviewModel(
            LearningSettingsSchema.parse({
              reviewModelId: request.reviewModelId,
              maxReviewInputTokens: request.maxInputTokens
            }),
            settings.models.map((entry) => ({
              ...entry,
              ...resolveModelConfig(settings, entry.id)
            })),
            {
              id: settings.globalReplyModelId || 'legacy-reply',
              provider:
                settings.models.find((entry) => entry.id === settings.globalReplyModelId)
                  ?.provider || 'legacy',
              ...normal
            }
          )
          return new HttpLearningReviewTransport({
            apiKey: model.apiKey,
            baseURL: model.baseURL,
            model: model.modelName
          }).complete(request, signal)
        }
      }
      const learningModelStamp = (settings: AppSettings, id: string): object => {
        const entry = settings.models.find((model) => model.id === id)
        const configured = resolveModelConfig(settings, id)
        return {
          id: id || 'legacy-reply',
          provider: entry?.provider || 'legacy',
          model: configured.modelName,
          baseURL: configured.baseURL,
          capabilities: configured.capabilities
        }
      }
      const learningValidation = new LearningProductValidation(learningStore, {
        knowledge: () => knowledgeStore,
        transport: learningTransport,
        replyTransport: {
          complete: (request, signal) =>
            learningTransport.complete({ ...request, reviewModelId: '' }, signal)
        },
        policy: (scope, modeId) => {
          const settings = normalizeSettings(settingsStore.store)
          const reviewId =
            learningStore.settings(scope).reviewModelId || settings.globalReplyModelId
          return {
            rules: learningCalibrationRules(
              scope,
              modeId,
              ensureSystemModes(settings.modes),
              settings.globalDefaultModeId
            ),
            validatorVersion: learningHash({
              implementation: 'memory-calibration-human-origin-v2',
              review: learningModelStamp(settings, reviewId),
              reply: learningModelStamp(settings, settings.globalReplyModelId)
            })
          }
        }
      })
      learningService = new LearningService(
        learningStore,
        new StructuredLearningReviewer(learningTransport),
        {
          workspaceId: learningWorkspaceId,
          validation: learningValidation,
          curation: {
            transport: learningTransport,
            fingerprint: (scope) => {
              const settings = normalizeSettings(settingsStore.store)
              return learningHash({
                implementation: 'memory-curator-v1',
                model: learningModelStamp(
                  settings,
                  learningStore.settings(scope).reviewModelId || settings.globalReplyModelId
                )
              })
            }
          }
        }
      )
      try {
        learningStore.migrateLegacy(join(worktraceBaseDir(), 'memory', 'cards.json'))
      } catch {
        console.error('[Learning] 旧卡片迁移未完成，原文件已保留，请在工作记忆中检查。')
      }
      reliableRuntime.configureLearningSubmissions(learningService)
      registerLearningSubmissionIpc(
        join(__dirname, '../renderer/index.html'),
        is.dev ? process.env.ELECTRON_RENDERER_URL : undefined,
        reliableRuntime,
        (scope) => {
          if (!reliableRuntime!.learningBackend(scope)) learningService.assertScope(scope)
        }
      )
      registerLearningIpc(
        join(__dirname, '../renderer/index.html'),
        is.dev ? process.env.ELECTRON_RENDERER_URL : undefined,
        learningService,
        () => learningService.accountScope(normalizeSettings(settingsStore.store).appType),
        (scope) => reliableRuntime!.learningBackend(scope),
        () => {
          const settings = normalizeSettings(settingsStore.store)
          return learningReviewModelDirectory(
            settings.models.map((entry) => ({
              ...entry,
              ...resolveModelConfig(settings, entry.id)
            }))
          )
        },
        {
          observed: (episode) => reliableRuntime!.observeLearningEpisode(episode),
          forgetLocal: (scope, run) => reliableRuntime!.forgetLocalLearning(scope, run)
        }
      )
      learningService.start()
    })())
  legacyIpc.handle('features:advanced-enable', () => enableAdvanced())
  knowledgeStore = registerKnowledgeIpc(
    join(__dirname, '../renderer/index.html'),
    app.getPath('userData'),
    is.dev ? process.env.ELECTRON_RENDERER_URL : undefined,
    async (question, modeId, objectId, service) => {
      const settings = normalizeSettings(settingsStore.store)
      const mode = ensureSystemModes(settings.modes).find((item) => item.id === modeId)
      if (!mode) throw new Error('回复模式不存在，请重新选择。')
      const object = objectId
        ? mode.specificObjects.find((item) => item.id === objectId)
        : undefined
      if (objectId && !object) throw new Error('对象用户不属于当前模式，请重新选择。')
      const model = resolveModelConfig(settings, settings.globalReplyModelId)
      const policy = object
        ? objectReplyPolicy(
            mode,
            object,
            defaultReplyMode(ensureSystemModes(settings.modes), settings.globalDefaultModeId)
          )
        : mode
      const rules =
        policy.prompt +
        (policy.unifiedPrefix ? `\n回复使用统一开头：${policy.unifiedPrefix}` : '') +
        buildContextSection({ objectTitle: object?.title, objectRelation: object?.relationship })
      await enableAdvanced()
      const objectScope = object
        ? {
            ...learningService.accountScope('generic'),
            conversationId: `object:${learningHash({ modeId, objectId: object.id })}`
          }
        : undefined
      return new LearningKnowledgeAnswers(service, learningService, () =>
        console.error('[Learning] 案例记录失败，试答仍可使用。')
      ).answer(
        question,
        rules,
        async (system, input) => {
          if (!model.apiKey) throw new Error('请先在模型配置中添加回复模型，并在主页选择该模型。')
          const client = new AIClient({
            apiKey: model.apiKey,
            model: model.modelName,
            baseURL: model.baseURL
          })
          try {
            return await client.getTextReply(system, input)
          } catch {
            throw new Error('模型调用失败，请先测试模型连接，或稍后重试。')
          }
        },
        objectScope
      )
    }
  )
  foregroundWechat = registerForegroundWechatIpc(
    join(__dirname, '../renderer/index.html'),
    app.getPath('userData'),
    (target) => {
      const settings = normalizeSettings(settingsStore.store)
      const modes = ensureSystemModes(settings.modes)
      const common = defaultReplyMode(modes, settings.globalDefaultModeId)
      const matches = modes.flatMap((owner) =>
        owner.specificObjects
          .filter((object) => object.name === target)
          .map((object) => ({ owner, object }))
      )
      if (matches.length > 1) throw new Error('target_rules_ambiguous')
      const match = matches[0]
      const policy = match ? objectReplyPolicy(match.owner, match.object, common) : common
      if (!policy) throw new Error('rules_not_configured')
      if (match?.object.autoReply === false) throw new Error('target_auto_reply_disabled')
      const rules =
        policy.prompt +
        (policy.unifiedPrefix ? `\n回复使用统一开头：${policy.unifiedPrefix}` : '') +
        buildContextSection({
          objectTitle: match?.object.title,
          objectRelation: match?.object.relationship
        })
      const vision = resolveModelConfig(settings, settings.globalVisionModelId)
      const reply = resolveModelConfig(settings, settings.globalReplyModelId)
      return {
        vision,
        reply,
        rules,
        revision: learningHash({ vision, reply, rules, knowledge: knowledgeStore.version() }),
        knowledge: (question) => {
          if (!knowledgeStore.settings().enabled || !knowledgeStore.snapshot().documents.length)
            return { instructions: '' }
          const { hits } = knowledgeStore.search(question)
          const fallback = knowledgeStore.settings().fallbackReply
          return hits.length
            ? { instructions: knowledgeInstructions(hits, fallback) }
            : { instructions: '', fallback }
        }
      }
    },
    is.dev ? process.env.ELECTRON_RENDERER_URL : undefined
  )
  powerMonitor.on('suspend', () => {
    void reliableRuntime?.pause('suspended')
    void foregroundWechat?.pause()
  })
  powerMonitor.on('lock-screen', () => {
    void reliableRuntime?.pause('locked')
    void foregroundWechat?.pause()
  })

  const initialSettings = normalizeSettings(settingsStore.store)
  nativeTheme.themeSource = initialSettings.theme === 'light' ? 'light' : 'dark'

  // 检查和请求 macOS 需要的权限
  await checkAndRequestPermissions()

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // ── Settings 持久化 ──
  legacyIpc.handle('settings:getAll', async () => {
    return normalizeSettings(settingsStore.store)
  })

  legacyIpc.handle('settings:get', async (_event, key: string) => {
    const settings = normalizeSettings(settingsStore.store)
    const value: unknown = Reflect.get(settings, key)
    return value
  })

  legacyIpc.handle('settings:set', async (_event, data: AppSettingsPatch) => {
    const current = normalizeSettings(settingsStore.store)
    const next = {
      ...current,
      ...data,
      vision: {
        ...current.vision,
        ...(data.vision || {})
      },
      chatProvider: {
        ...current.chatProvider,
        ...(data.chatProvider || {}),
        config: {
          ...current.chatProvider.config,
          ...(data.chatProvider?.config || {})
        }
      },
      capture: {
        ...current.capture,
        ...(data.capture || {})
      },
      models: Array.isArray(data.models) ? data.models : current.models,
      globalVisionModelId:
        typeof data.globalVisionModelId === 'string'
          ? data.globalVisionModelId
          : current.globalVisionModelId,
      globalReplyModelId:
        typeof data.globalReplyModelId === 'string'
          ? data.globalReplyModelId
          : current.globalReplyModelId,
      modes: Array.isArray(data.modes) ? data.modes : current.modes,
      globalDefaultModeId:
        typeof data.globalDefaultModeId === 'string'
          ? data.globalDefaultModeId
          : current.globalDefaultModeId,
      globalAutoReply:
        typeof data.globalAutoReply === 'boolean' ? data.globalAutoReply : current.globalAutoReply,
      theme: data.theme === 'light' || data.theme === 'dark' ? data.theme : current.theme
    } satisfies AppSettings

    persistSettings(next)
    const bgColor = next.theme === 'light' ? '#f5f5f8' : '#0a0b10'
    nativeTheme.themeSource = next.theme === 'light' ? 'light' : 'dark'
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('settings:changed', { theme: next.theme, locale: next.locale })
      win.setBackgroundColor(bgColor)
    }
    return { success: true }
  })

  legacyIpc.handle('engine:exitStandby', async (_event, modeId: string) => {
    if (typeof modeId !== 'string' || !modeId) return { success: false }
    return { success: true }
  })

  legacyIpc.handle('engine:setUserInput', async (_event, modeId: string, userInput: string) => {
    if (typeof modeId !== 'string' || !modeId) return { success: false }
    const value = userInput || ''
    modeUserInputCache.set(modeId, value)
    return { success: true }
  })

  legacyIpc.handle('provider:installFromUrl', async (_event, manifestUrl: string) => {
    try {
      const result = await installProviderFromUrl(manifestUrl)
      const current = normalizeSettings(settingsStore.store)
      persistSettings({
        ...current,
        chatProvider: {
          ...current.chatProvider,
          manifestUrl,
          installed: result.installed,
          config: withSchemaDefaults(result.manifest.configSchema, current.chatProvider.config)
        }
      })

      return {
        success: true,
        installed: result.installed,
        manifest: result.manifest
      }
    } catch (error: unknown) {
      return { success: false, error: errorMessage(error) }
    }
  })

  legacyIpc.handle('provider:getInstalled', async () => {
    const settings = normalizeSettings(settingsStore.store)

    // 用户安装过自定义 provider：原样返回
    if (settings.chatProvider.installed) {
      const manifest = await getInstalledProviderManifest(settings.chatProvider.installed)
      return {
        installed: settings.chatProvider.installed,
        manifest,
        isBuiltinDefault: false
      }
    }

    // 没装过 → 回退到内置 doubao（apiKey 字段已剥离，使用视觉密钥）
    const installed = await getBuiltinDoubaoInstalledInfo()
    const manifest = await getBuiltinDoubaoManifestForUi()
    return {
      installed,
      manifest,
      isBuiltinDefault: true
    }
  })

  legacyIpc.handle('providerHub:getCatalog', async () => {
    const cached = getCachedProviderHub()
    if (cached) return { success: true, catalog: cached }

    try {
      const catalog = await fetchProviderHub()
      return { success: true, catalog }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message, catalog: null }
    }
  })

  legacyIpc.handle('providerHub:update', async () => {
    try {
      const catalog = await fetchProviderHub()
      return { success: true, catalog }
    } catch (error: unknown) {
      const cached = getCachedProviderHub()
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message, catalog: cached }
    }
  })

  legacyIpc.handle('settings:open', async () => {
    createSettingsWindow()
    return { success: true }
  })

  // ── 模型配置 CRUD ──
  legacyIpc.handle('model:list', async () => {
    const settings = normalizeSettings(settingsStore.store)
    return settings.models
  })

  legacyIpc.handle('model:create', async (_event, input: Partial<ModelConfig>) => {
    const name = typeof input?.name === 'string' ? input.name.trim() : ''
    const provider = typeof input?.provider === 'string' ? input.provider : 'custom'
    const modelName = typeof input?.modelName === 'string' ? input.modelName.trim() : ''
    const apiKey = typeof input?.apiKey === 'string' ? input.apiKey : ''
    const baseURL = typeof input?.baseURL === 'string' ? input.baseURL : ''
    const capabilities: ModelCapability[] = Array.isArray(input?.capabilities)
      ? input.capabilities.filter((c) => typeof c === 'string')
      : ['text']

    if (!name) return { success: false, error: '模型名称不能为空' }
    if (!modelName) return { success: false, error: '模型标识不能为空' }
    if (!apiKey) return { success: false, error: 'API Key 不能为空' }

    const settings = normalizeSettings(settingsStore.store)
    const duplicate = settings.models.find((m) => m.name === name)
    if (duplicate) return { success: false, error: '模型名称已存在' }

    const newModel: ModelConfig = {
      id: randomUUID(),
      name,
      provider,
      modelName,
      apiKey,
      baseURL,
      capabilities,
      createdAt: Date.now()
    }

    const nextModels = [...settings.models, newModel]
    persistSettings({
      ...settings,
      models: nextModels
    })
    return { success: true, model: newModel }
  })

  legacyIpc.handle('model:update', async (_event, id: string, input: Partial<ModelConfig>) => {
    if (typeof id !== 'string' || !id) return { success: false, error: '无效的模型 ID' }
    const settings = normalizeSettings(settingsStore.store)
    const index = settings.models.findIndex((m) => m.id === id)
    if (index === -1) return { success: false, error: '模型不存在' }

    const name = typeof input?.name === 'string' ? input.name.trim() : ''
    if (name) {
      const duplicate = settings.models.find((m) => m.name === name && m.id !== id)
      if (duplicate) return { success: false, error: '模型名称已存在' }
    }

    const updated = { ...settings.models[index] }
    if (name) updated.name = name
    if (typeof input?.provider === 'string') updated.provider = input.provider
    if (typeof input?.modelName === 'string' && input.modelName.trim())
      updated.modelName = input.modelName.trim()
    if (typeof input?.apiKey === 'string') updated.apiKey = input.apiKey
    if (typeof input?.baseURL === 'string') updated.baseURL = input.baseURL
    if (Array.isArray(input?.capabilities))
      updated.capabilities = input.capabilities.filter((c) => typeof c === 'string')

    const nextModels = [...settings.models]
    nextModels[index] = updated
    persistSettings({
      ...settings,
      models: nextModels
    })
    return { success: true, model: updated }
  })

  legacyIpc.handle('model:delete', async (_event, id: string) => {
    if (typeof id !== 'string' || !id) return { success: false, error: '无效的模型 ID' }
    const settings = normalizeSettings(settingsStore.store)
    const nextModels = settings.models.filter((m) => m.id !== id)
    if (nextModels.length === settings.models.length) return { success: false, error: '模型不存在' }

    const updates: Partial<AppSettings> = { models: nextModels }
    if (settings.globalVisionModelId === id) updates.globalVisionModelId = ''
    if (settings.globalReplyModelId === id) updates.globalReplyModelId = ''

    persistSettings({
      ...settings,
      ...updates
    })
    return { success: true }
  })

  legacyIpc.handle('model:testConnection', async (_event, input: string | Partial<ModelConfig>) => {
    // Draft tests use the submitted fields without creating or updating a saved model.
    const model =
      typeof input === 'string'
        ? normalizeSettings(settingsStore.store).models.find((m) => m.id === input)
        : input && typeof input === 'object'
          ? input
          : undefined
    if (!model) return { success: false, error: '模型不存在或配置无效' }
    const modelName = typeof model.modelName === 'string' ? model.modelName.trim() : ''
    const apiKey = typeof model.apiKey === 'string' ? model.apiKey.trim() : ''
    if (!modelName) return { success: false, error: '模型标识不能为空' }
    if (!apiKey) return { success: false, error: 'API Key 不能为空' }
    const providerPreset = PROVIDER_PRESETS.find((p) => p.id === model.provider)
    const baseURL =
      (typeof model.baseURL === 'string' ? model.baseURL.trim() : '') ||
      providerPreset?.defaultBaseURL ||
      FIXED_ARK_BASE_URL
    try {
      if (!['http:', 'https:'].includes(new URL(baseURL).protocol)) throw new Error('invalid_url')
    } catch {
      return {
        success: false,
        error: 'Base URL 格式不正确，请填写完整的 http:// 或 https:// 地址。'
      }
    }
    const client = new AIClient({
      apiKey,
      model: modelName,
      baseURL: baseURL.replace(/\/+$/, '')
    })
    const result = await client.testConnection()
    return result.error ? { ...result, error: result.error.split(apiKey).join('••••••') } : result
  })

  // ── 模式 CRUD ──
  legacyIpc.handle('mode:list', async () => {
    const settings = normalizeSettings(settingsStore.store)
    return ensureSystemModes(settings.modes)
  })

  legacyIpc.handle('mode:create', async (_event, input: Partial<ReplyMode>) => {
    const name = typeof input?.name === 'string' ? input.name.trim() : ''
    const prompt = typeof input?.prompt === 'string' ? input.prompt : ''
    if (!name) return { success: false, error: '模式名称不能为空' }
    if (!prompt) return { success: false, error: '回复规则不能为空' }

    const settings = normalizeSettings(settingsStore.store)
    const allModes = ensureSystemModes(settings.modes)
    const duplicate = allModes.find((m) => m.name === name)
    if (duplicate) return { success: false, error: '模式名称已存在' }

    const newMode: ReplyMode = {
      id: randomUUID(),
      name,
      source: 'custom',
      prompt,
      sentimentEnabled: !!input?.sentimentEnabled,
      unifiedPrefix: typeof input?.unifiedPrefix === 'string' ? input.unifiedPrefix : '',
      enabled: true,
      running: false,
      specificObjects: [],
      autoReply: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    const nextModes = [...settings.modes.filter((m) => !isSystemModeId(m.id)), newMode]
    persistSettings({ ...settings, modes: nextModes })
    return { success: true, mode: newMode }
  })

  legacyIpc.handle('mode:update', async (_event, id: string, input: Partial<ReplyMode>) => {
    if (typeof id !== 'string' || !id) return { success: false, error: '无效的模式 ID' }
    const settings = normalizeSettings(settingsStore.store)
    const allModes = ensureSystemModes(settings.modes)
    const index = allModes.findIndex((m) => m.id === id)
    if (index === -1) return { success: false, error: '模式不存在' }

    const name = typeof input?.name === 'string' ? input.name.trim() : ''
    if (name) {
      const duplicate = allModes.find((m) => m.name === name && m.id !== id)
      if (duplicate) return { success: false, error: '模式名称已存在' }
    }

    const updated = { ...allModes[index], updatedAt: Date.now() }
    if (name) updated.name = name
    if (typeof input?.prompt === 'string') updated.prompt = input.prompt
    if (typeof input?.sentimentEnabled === 'boolean')
      updated.sentimentEnabled = input.sentimentEnabled
    if (typeof input?.unifiedPrefix === 'string') updated.unifiedPrefix = input.unifiedPrefix
    if (typeof input?.enabled === 'boolean') updated.enabled = input.enabled
    if (typeof input?.autoReply === 'boolean') updated.autoReply = input.autoReply

    const nextModes = allModes.map((m, i) => (i === index ? updated : m))
    persistSettings({ ...settings, modes: nextModes })
    return { success: true, mode: updated }
  })

  legacyIpc.handle('mode:delete', async (_event, id: string) => {
    if (typeof id !== 'string' || !id) return { success: false, error: '无效的模式 ID' }
    if (isSystemModeId(id)) return { success: false, error: '系统预设模式不可删除' }
    const settings = normalizeSettings(settingsStore.store)
    const nextModes = settings.modes.filter((m) => m.id !== id)
    if (nextModes.length === settings.modes.length) return { success: false, error: '模式不存在' }

    const updates: Partial<AppSettings> = { modes: nextModes }
    if (settings.globalDefaultModeId === id) updates.globalDefaultModeId = ''
    persistSettings({ ...settings, ...updates })
    return { success: true }
  })

  legacyIpc.handle('mode:toggleEnabled', async (_event, id: string, enabled: boolean) => {
    if (typeof id !== 'string' || !id) return { success: false, error: '无效的模式 ID' }
    const settings = normalizeSettings(settingsStore.store)
    const allModes = ensureSystemModes(settings.modes)
    const mode = allModes.find((m) => m.id === id)
    if (!mode) return { success: false, error: '模式不存在' }

    mode.enabled = !!enabled
    mode.updatedAt = Date.now()

    persistSettings({ ...settings, modes: allModes })
    return { success: true, mode }
  })

  legacyIpc.handle('mode:start', async (_event, modeId: string) => {
    if (typeof modeId !== 'string' || !modeId) return { success: false, error: '无效的模式 ID' }
    const settings = normalizeSettings(settingsStore.store)
    const allModes = ensureSystemModes(settings.modes)
    const mode = allModes.find((m) => m.id === modeId)
    if (!mode) return { success: false, error: '模式不存在' }
    if (!mode.enabled) return { success: false, error: '模式未启用' }
    const result = await startEngineCore(settings, modeId)
    if (result.ok) return { success: true }
    return { success: false, error: result.message || result.reason }
  })

  legacyIpc.handle('mode:stop', async (_event, modeId: string) => {
    if (typeof modeId !== 'string' || !modeId) return { success: false, error: '无效的模式 ID' }
    const result = await pauseAllReplyRuntimes(reliableRuntime, () =>
      stopEngineCore('mode_stop', modeId)
    )
    if (result.ok) return { success: true }
    return { success: false, error: result.message || result.reason }
  })

  legacyIpc.handle('mode:setAutoReply', async (_event, modeId: string, autoReply: boolean) => {
    if (typeof modeId !== 'string' || !modeId) return { success: false, error: '无效的模式 ID' }
    const settings = normalizeSettings(settingsStore.store)
    const allModes = ensureSystemModes(settings.modes)
    const mode = allModes.find((m) => m.id === modeId)
    if (mode) {
      mode.autoReply = autoReply
      persistSettings({ ...settings, modes: allModes })
    }
    return { success: true }
  })

  // ── 特定对象 CRUD ──
  legacyIpc.handle(
    'object:create',
    async (_event, modeId: string, input: Partial<SpecificObject>) => {
      if (typeof modeId !== 'string' || !modeId) return { success: false, error: '无效的模式 ID' }
      const objName = typeof input?.name === 'string' ? input.name.trim() : ''
      if (!objName) return { success: false, error: '对象名称不能为空' }

      const settings = normalizeSettings(settingsStore.store)
      const allModes = ensureSystemModes(settings.modes)
      const allObjects = allModes.flatMap((m) => m.specificObjects || [])
      const duplicate = allObjects.find((o) => o.name === objName)
      if (duplicate)
        return {
          success: false,
          error: `该对象名称已存在于[${allModes.find((m) => m.specificObjects?.some((o) => o.id === duplicate.id))?.name || '未知'}]模式中`
        }

      const targetModeId = typeof input?.modeId === 'string' && input.modeId ? input.modeId : modeId
      const targetMode = allModes.find((m) => m.id === targetModeId)
      if (!targetMode) return { success: false, error: '目标模式不存在' }

      const newObject: SpecificObject = {
        id: randomUUID(),
        name: objName,
        title: typeof input?.title === 'string' ? input.title : '',
        relationship: typeof input?.relationship === 'string' ? input.relationship : '',
        modeId: targetModeId,
        replyRules:
          typeof input?.replyRules === 'string' ? input.replyRules.trim().slice(0, 8000) : '',
        autoReply: typeof input?.autoReply === 'boolean' ? input.autoReply : null
      }

      targetMode.specificObjects = [...(targetMode.specificObjects || []), newObject]
      targetMode.updatedAt = Date.now()

      persistSettings({ ...settings, modes: allModes })
      return { success: true, object: newObject, modeId: targetModeId }
    }
  )

  legacyIpc.handle('object:delete', async (_event, modeId: string, objectId: string) => {
    if (typeof modeId !== 'string' || !modeId) return { success: false, error: '无效的模式 ID' }
    if (typeof objectId !== 'string' || !objectId) return { success: false, error: '无效的对象 ID' }
    const settings = normalizeSettings(settingsStore.store)
    const allModes = ensureSystemModes(settings.modes)
    const mode = allModes.find((m) => m.id === modeId)
    if (!mode) return { success: false, error: '模式不存在' }

    const prevLen = mode.specificObjects?.length || 0
    mode.specificObjects = (mode.specificObjects || []).filter((o) => o.id !== objectId)
    if (mode.specificObjects.length === prevLen) return { success: false, error: '对象不存在' }

    mode.updatedAt = Date.now()

    persistSettings({ ...settings, modes: allModes })
    return { success: true }
  })

  legacyIpc.handle(
    'object:update',
    async (_event, modeId: string, objectId: string, patch: Partial<SpecificObject>) => {
      if (typeof modeId !== 'string' || !modeId) return { success: false, error: '无效的模式 ID' }
      if (typeof objectId !== 'string' || !objectId)
        return { success: false, error: '无效的对象 ID' }
      const settings = normalizeSettings(settingsStore.store)
      const allModes = ensureSystemModes(settings.modes)
      const mode = allModes.find((m) => m.id === modeId)
      if (!mode) return { success: false, error: '模式不存在' }

      const obj = (mode.specificObjects || []).find((o) => o.id === objectId)
      if (!obj) return { success: false, error: '对象不存在' }
      const targetModeId = typeof patch?.modeId === 'string' && patch.modeId ? patch.modeId : modeId
      const targetMode = allModes.find((m) => m.id === targetModeId)
      if (!targetMode) return { success: false, error: '目标模式不存在' }

      if (typeof patch?.name === 'string' && patch.name.trim()) {
        const allObjects = allModes.flatMap((m) => m.specificObjects || [])
        const duplicate = allObjects.find((o) => o.name === patch.name!.trim() && o.id !== objectId)
        if (duplicate) return { success: false, error: '该对象名称已存在' }
        obj.name = patch.name.trim()
      }
      if (typeof patch?.title === 'string') obj.title = patch.title
      if (typeof patch?.relationship === 'string') obj.relationship = patch.relationship
      if (typeof patch?.replyRules === 'string')
        obj.replyRules = patch.replyRules.trim().slice(0, 8000)
      if (typeof patch?.autoReply === 'boolean' || patch?.autoReply === null)
        obj.autoReply = patch.autoReply

      if (targetModeId !== modeId) {
        mode.specificObjects = (mode.specificObjects || []).filter((o) => o.id !== objectId)
        obj.modeId = targetModeId
        targetMode.specificObjects = [...(targetMode.specificObjects || []), obj]
        targetMode.updatedAt = Date.now()
      }

      mode.updatedAt = Date.now()
      persistSettings({ ...settings, modes: allModes })
      return { success: true, object: obj, modeId: targetModeId }
    }
  )

  legacyIpc.handle('reply:paste', async (_event, text: string) => {
    if (typeof text !== 'string' || !text) return { success: false, error: '文本为空' }
    const { clipboard } = await import('electron')
    await clipboard.writeText(text)
    return { success: true }
  })

  legacyIpc.handle('reply:send', async (_event, text: string) => {
    if (typeof text !== 'string' || !text) return { success: false, error: '文本为空' }
    return {
      success: false,
      error: '该发送入口未绑定客户和审核任务，已关闭。请使用完成身份核验的任务发送入口。'
    }
  })

  legacyIpc.handle('memory:open', async () => {
    createMemoryWindow()
    return { success: true }
  })

  legacyIpc.on('mode:changed', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('mode:changed')
      }
    }
  })

  legacyIpc.handle('trace:listSessions', async () => {
    return listTraceSessions(worktraceBaseDir())
  })

  legacyIpc.handle('trace:getSession', async (_event, sessionId: string) => {
    if (typeof sessionId !== 'string' || !sessionId) return null
    return readTraceSession(worktraceBaseDir(), sessionId)
  })

  legacyIpc.handle(
    'trace:getScreenshot',
    async (_event, sessionId: string, screenshotPath: string) => {
      if (typeof sessionId !== 'string' || typeof screenshotPath !== 'string') return null
      return readTraceScreenshot(worktraceBaseDir(), sessionId, screenshotPath)
    }
  )

  // ── 工作记忆：经验卡片 ──
  legacyIpc.handle('memory:listCards', async () => {
    return getExperienceStore().listCards()
  })

  legacyIpc.handle('memory:learnFromSession', async (_event, sessionId: string) => {
    try {
      const settings = normalizeSettings(settingsStore.store)
      const visionModel = resolveModelConfig(settings, settings.globalVisionModelId)
      if (!visionModel.apiKey) {
        return { success: false, error: '请先在设置中填写视觉接口密钥' }
      }
      const data = await readTraceSession(worktraceBaseDir(), sessionId)
      if (!data || data.steps.length === 0) {
        return { success: false, error: '该轨迹暂无可学习的步骤' }
      }

      const client = new AIClient({
        apiKey: visionModel.apiKey,
        model: visionModel.modelName,
        baseURL: visionModel.baseURL
      })
      const induced = await induceCardsFromSession(client, data.session, data.steps)
      if (induced.length === 0) {
        return { success: true, cards: [] }
      }

      const cards = getExperienceStore().addCards(
        induced.map((item) => ({
          scenario: item.scenario,
          guidance: item.guidance,
          rationale: item.rationale,
          source: 'agent_summary' as const,
          evidence: { sessionId, stepIds: item.stepIds }
        }))
      )
      return { success: true, cards }
    } catch (error: unknown) {
      return { success: false, error: errorMessage(error) }
    }
  })

  legacyIpc.handle('memory:addCard', async (_event, input: NewExperienceCard) => {
    if (!input?.scenario?.trim() || !input?.guidance?.trim()) {
      return { success: false, error: '场景和做法不能为空' }
    }
    const source: NewExperienceCard['source'] =
      input.source === 'human_takeover' || input.source === 'manual' ? input.source : 'manual'
    const cards = getExperienceStore().addCards([
      {
        scenario: input.scenario,
        guidance: input.guidance,
        rationale: input.rationale,
        source,
        evidence: input.evidence
      }
    ])
    return { success: true, cards }
  })

  legacyIpc.handle('memory:deleteCard', async (_event, cardId: string) => {
    return { success: getExperienceStore().deleteCard(cardId) }
  })

  legacyIpc.handle('memory:setCardEnabled', async (_event, cardId: string, enabled: boolean) => {
    return { success: getExperienceStore().setEnabled(cardId, enabled === true) }
  })

  // ── Runtime / Session IPC（沿用 legacy engine:* 通道名） ──
  legacyIpc.handle('engine:start', async (_event, config) => {
    const result = await startEngineCore(config)
    if (result.ok) return { success: true }
    return { success: false, error: result.message || result.reason }
  })

  legacyIpc.handle('engine:stop', async (_event, reason?: string) => {
    const result = await pauseAllReplyRuntimes(reliableRuntime, () =>
      stopEngineCore(typeof reason === 'string' ? reason : 'ipc_stop')
    )
    if (result.ok) return { success: true }
    return { success: false, error: result.message || result.reason }
  })

  legacyIpc.handle('engine:status', async () => ({
    running:
      reliableRuntime?.status().state === 'running' ||
      Boolean(
        foregroundWechat && !['idle', 'paused'].includes(foregroundWechat.runtime.status().state)
      ) ||
      Boolean(
        foregroundWechat && !['idle', 'paused'].includes(foregroundWechat.batch.status().state)
      ),
    runningModes: []
  }))
  legacyIpc.handle('engine:updateConfig', async () => ({ success: true }))

  legacyIpc.handle('engine:testConnection', async (_event, config) => {
    const currentSettings = normalizeSettings(settingsStore.store)
    const apiKey = config?.apiKey || currentSettings.vision.apiKey
    const model = config?.model || currentSettings.vision.model
    const baseURL = config?.baseURL || currentSettings.vision.baseURL
    const client = new AIClient({
      apiKey,
      model,
      baseURL
    })
    return client.testConnection()
  })

  // ── Capture / 框选向导 IPC ──

  legacyIpc.handle(
    'capture:openSetupWizard',
    async (_event, args: { appType: AppType; steps?: WizardStepKey[] }) => {
      const settings = normalizeSettings(settingsStore.store)
      const appType = coerceAppType(args?.appType)
      const prefill = settings.capture[appType]?.regions ?? null

      const result = await runBoxSelectWizard({ appType, steps: args?.steps, prefill })
      if (!result.ok || !result.regions) {
        return { success: false, reason: result.reason || 'cancelled' }
      }

      // 持久化区域到 settings.capture[appType]，但保留已有 strategy（默认 'auto'）
      const current = normalizeSettings(settingsStore.store)
      const next: AppSettings = {
        ...current,
        capture: {
          ...current.capture,
          [appType]: {
            strategy: current.capture[appType]?.strategy ?? 'auto',
            regions: result.regions
          }
        }
      }
      persistSettings(next)
      notifyCaptureRegionsUpdated(appType, result.regions)
      return { success: true, regions: result.regions }
    }
  )

  legacyIpc.handle('capture:getRegions', async (_event, appType: AppType) => {
    const settings = normalizeSettings(settingsStore.store)
    return settings.capture[coerceAppType(appType)]?.regions ?? null
  })

  legacyIpc.handle('capture:resetRegions', async (_event, appType: AppType) => {
    const current = normalizeSettings(settingsStore.store)
    const key = coerceAppType(appType)
    const next: AppSettings = {
      ...current,
      capture: {
        ...current.capture,
        [key]: { strategy: current.capture[key]?.strategy ?? 'auto', regions: null }
      }
    }
    persistSettings(next)
    notifyCaptureRegionsUpdated(key, null)
    return { success: true }
  })

  // ── Skill HTTP Server（OpenClaw 远程启动 / 暂停接入点） ──
  // Remote legacy control is opt-in until authentication and the reliable executor are integrated.
  if (process.env.AUTOREPLY_ENABLE_LEGACY_SKILL_SERVER === '1')
    startSkillServer(skillEngineController)

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', (event) => {
  learningService?.stop()
  stopSkillServer()
  if (
    (reliableRuntime || foregroundWechat || learningService || adminConnection) &&
    !reliableQuitRequested
  ) {
    event.preventDefault()
    reliableQuitRequested = true
    // Unknown in-flight actions remain durable for restart reconciliation.
    void (async () => {
      await advancedInitialization?.catch(() => undefined)
      await Promise.allSettled([
        reliableRuntime?.close(),
        foregroundWechat?.close(),
        learningService?.shutdown(),
        adminConnection?.close()
      ])
      app.quit()
    })()
  }
})
app.on('will-quit', () => {
  hostModelAudit?.close()
  learningService?.store.close()
})
async function startEngineCore(
  _rawSettings?: unknown,
  _modeId?: string
): Promise<SkillStartResult> {
  void _rawSettings
  void _modeId
  return {
    ok: false,
    reason: 'capability_unverified',
    message: '请使用主页的个人微信自动回复入口；企业模式请在企业连接页同步规则后启动。'
  }
}

function resolveModelConfig(
  settings: AppSettings,
  globalModelId: string
): { apiKey: string; modelName: string; baseURL: string; capabilities: string[] } {
  if (globalModelId) {
    const found = settings.models.find((m) => m.id === globalModelId)
    if (found) {
      const providerPreset = PROVIDER_PRESETS.find((p) => p.id === found.provider)
      return {
        apiKey: found.apiKey,
        modelName: found.modelName,
        baseURL: found.baseURL || providerPreset?.defaultBaseURL || FIXED_ARK_BASE_URL,
        capabilities: found.capabilities || providerPreset?.defaultCapabilities || ['text']
      }
    }
  }
  return {
    apiKey: settings.vision.apiKey,
    modelName: settings.vision.model,
    baseURL: settings.vision.baseURL,
    capabilities: ['text', 'vision']
  }
}
async function stopEngineCore(_reason = 'user_stop', _modeId?: string): Promise<SkillPauseResult> {
  void _reason
  void _modeId
  await foregroundWechat?.pause()
  notifyEngineStateChanged('idle')
  return { ok: true }
}

/** 通知 Renderer 引擎状态变化（让 UI 在远程启停时同步切换） */
function notifyEngineStateChanged(status: 'running' | 'idle'): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('engine:state', { status })
    }
  }
}

/** 通知 Renderer：某个 appType 的框选区域被向导/重置更新了，UI 上的 chip 立即重渲染。 */
function notifyCaptureRegionsUpdated(appType: AppType, regions: BoxRegions | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('capture:regions-updated', { appType, regions })
    }
  }
}

const skillEngineController: SkillEngineController = {
  start: () => startEngineCore(),
  pause: () => pauseAllReplyRuntimes(reliableRuntime, () => stopEngineCore('skill_pause')),
  isRunning: () =>
    reliableRuntime?.status().state === 'running' ||
    Boolean(
      foregroundWechat && !['idle', 'paused'].includes(foregroundWechat.runtime.status().state)
    )
}

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

const VALID_APP_TYPES: AppType[] = [
  'wechat',
  'wework',
  'dingtalk',
  'lark',
  'slack',
  'telegram',
  'generic'
]
const VALID_CAPTURE_STRATEGIES: CaptureStrategy[] = ['auto', 'vlm', 'box-select']

function coerceAppType(raw: unknown): AppType {
  return typeof raw === 'string' && (VALID_APP_TYPES as string[]).includes(raw)
    ? (raw as AppType)
    : 'wechat'
}

function coerceStrategy(raw: unknown, fallback: CaptureStrategy = 'auto'): CaptureStrategy {
  return typeof raw === 'string' && (VALID_CAPTURE_STRATEGIES as string[]).includes(raw)
    ? (raw as CaptureStrategy)
    : fallback
}

function coerceRect(raw: unknown): BoxRegions['contactList'] | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const x = Number(r.x),
    y = Number(r.y),
    w = Number(r.width),
    h = Number(r.height)
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null
  return { x, y, width: w, height: h }
}

function coerceRegions(raw: unknown): BoxRegions | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const contactList = coerceRect(r.contactList)
  const chatMain = coerceRect(r.chatMain)
  const inputBox = coerceRect(r.inputBox)
  if (!contactList || !chatMain || !inputBox) return null
  return {
    contactList,
    chatMain,
    inputBox,
    unreadIndicator: coerceRect(r.unreadIndicator),
    displayId: typeof r.displayId === 'number' ? r.displayId : undefined,
    scaleFactor: typeof r.scaleFactor === 'number' ? r.scaleFactor : undefined,
    capturedAt: typeof r.capturedAt === 'number' ? r.capturedAt : Date.now()
  }
}

function normalizeCapture(raw: unknown): Partial<Record<AppType, PerAppCapture>> {
  const out: Partial<Record<AppType, PerAppCapture>> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const key of VALID_APP_TYPES) {
    const value = (raw as Record<string, unknown>)[key]
    if (!value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    out[key] = {
      strategy: coerceStrategy(v.strategy),
      regions: coerceRegions(v.regions)
    }
  }
  return out
}

function normalizeSettings(raw: LegacySettingsInput | null | undefined): AppSettings {
  const oldApiKey = typeof raw?.apiKey === 'string' ? raw.apiKey : ''
  const oldModel = typeof raw?.model === 'string' && raw.model ? raw.model : FIXED_ARK_MODEL
  const oldSystemPrompt = typeof raw?.systemPrompt === 'string' ? raw.systemPrompt : ''
  const rawProviderConfig =
    raw?.chatProvider?.config && typeof raw.chatProvider.config === 'object'
      ? { ...raw.chatProvider.config }
      : {}

  if (rawProviderConfig.apiKey === undefined && oldApiKey) {
    rawProviderConfig.apiKey = oldApiKey
  }
  if (rawProviderConfig.model === undefined && oldModel) {
    rawProviderConfig.model = oldModel
  }
  if (rawProviderConfig.systemPrompt === undefined && oldSystemPrompt) {
    rawProviderConfig.systemPrompt = oldSystemPrompt
  }

  const vision = {
    apiKey: raw?.vision?.apiKey || oldApiKey || '',
    model: raw?.vision?.model || FIXED_ARK_MODEL,
    baseURL: raw?.vision?.baseURL || FIXED_ARK_BASE_URL
  }

  const models = normalizeModels(raw?.models, vision)

  return {
    locale: raw?.locale === 'en' ? 'en' : 'zh',
    theme: raw?.theme === 'light' ? 'light' : 'dark',
    appType: coerceAppType(raw?.appType),
    vision,
    chatProvider: {
      manifestUrl: raw?.chatProvider?.manifestUrl || raw?.providerManifestUrl || '',
      installed: raw?.chatProvider?.installed || null,
      config: rawProviderConfig
    },
    defaultCaptureStrategy: coerceStrategy(raw?.defaultCaptureStrategy, 'auto'),
    capture: normalizeCapture(raw?.capture),
    models,
    globalVisionModelId:
      typeof raw?.globalVisionModelId === 'string' ? raw.globalVisionModelId : '',
    globalReplyModelId: typeof raw?.globalReplyModelId === 'string' ? raw.globalReplyModelId : '',
    modes: normalizeModes(raw?.modes),
    globalDefaultModeId:
      typeof raw?.globalDefaultModeId === 'string' ? raw.globalDefaultModeId : '',
    globalAutoReply: !!raw?.globalAutoReply
  }
}

function normalizeModels(
  raw: ModelConfig[] | undefined,
  fallbackVision: { apiKey: string; model: string; baseURL: string }
): ModelConfig[] {
  if (Array.isArray(raw)) {
    const valid = raw.filter((m) => m && typeof m === 'object' && typeof m.id === 'string' && m.id)
    if (valid.length > 0) {
      return valid.map(
        (m): ModelConfig => ({
          ...m,
          capabilities: Array.isArray(m.capabilities) ? m.capabilities : ['text']
        })
      )
    }
  }

  if (fallbackVision.apiKey) {
    return [
      {
        id: 'default-vision',
        name: '默认视觉模型',
        provider: 'volcengine-ark',
        modelName: fallbackVision.model,
        apiKey: fallbackVision.apiKey,
        baseURL: fallbackVision.baseURL,
        capabilities: ['text', 'vision'],
        createdAt: Date.now()
      }
    ]
  }

  return []
}

const SYSTEM_MODE_IDS = ['system-depression', 'system-romance', 'system-high-eq']

function isSystemModeId(id: string): boolean {
  return SYSTEM_MODE_IDS.includes(id)
}

function ensureSystemModes(customModes: ReplyMode[]): ReplyMode[] {
  const systemModes: ReplyMode[] = [
    {
      id: 'system-depression',
      name: '抑郁预测',
      source: 'system',
      prompt:
        '你是一个善于识别抑郁倾向并提供温暖关怀的回复助手。请根据对话内容判断对方是否有抑郁倾向，并给出温暖、关怀、鼓励性的回复。如果对方表现出明显的抑郁倾向，请在回复中适当表达关心。',
      sentimentEnabled: false,
      unifiedPrefix: '',
      enabled: false,
      running: false,
      specificObjects: [],
      autoReply: false,
      createdAt: 0,
      updatedAt: 0
    },
    {
      id: 'system-romance',
      name: '恋爱',
      source: 'system',
      prompt: `## 恋爱模式
### 【角色定位】
你是专属恋爱向智能回复助手，专为情侣、暧昧暗恋、追求对象、异地恋人聊天打造，核心目标：拉近距离、增进亲密感、化解争吵、安抚情绪、制造心动氛围，杜绝聊天冷场，平衡甜度不油腻。
### 【分层核心回复规则】
#### 一、分情绪专属应对逻辑
- 优先表达重视与偏爱，主动接住对方分享欲；
- 自带宠溺感，主动延伸话题，引导对方多说；
- 适度表达想念，给予情绪正向反馈，让对方感受到被放在心上；
- 异地场景自动叠加期待见面、想念类内容。
- 对方委屈、难过、压力大、吐槽工作生活、受委屈
- 第一步先共情情绪，不急于讲道理、不反驳 "这点小事没必要难过"；
- 主动给予陪伴承诺，传递 "我站你这边" 的安全感；
- 温柔安抚为主，可附带轻微哄人话术，不生硬说教。
- 对方生气、冷淡、敷衍、冷战、产生矛盾、吃醋
- 全程低姿态，不辩解、不抬杠、不反驳、不冷战对抗；
- 主动自我反思示弱，优先安抚对方负面情绪，把哄人放在第一位；
- 避开激化矛盾的直白话术，主动给出和解台阶；
- 不追问 "你又怎么了" 这类容易激化矛盾的句子。
- 对方主动撩拨、暧昧试探、说情话、制造心动氛围
- 顺势接住暧昧，适度反向轻撩，不回避、不僵硬转移话题；
- 甜度匹配对方，对方温柔则走心，对方俏皮则可爱互撩；
- 把握分寸，不低俗油腻，保持干净心动感。
- 对方发言平淡简短、回复冷淡、聊天快要冷场
- 主动创造甜蜜小话题，抛出开放式问句，延续对话；
- 融入两人专属相处感，避免客套陌生人式对话；
- 减少单字短句，主动输出带有情绪的温柔表达。
- 对方表达想念、期待见面、倾诉异地难熬
- 深度共情思念，同步输出对等想念，描绘简单见面小期待；
- 给予情绪慰藉，缓解异地带来的不安与失落。
#### 二、分关系阶段话术风格规范
1. 暧昧追求期：温柔克制、略带小心动，循序渐进，不过度油腻直白，适度含蓄，慢慢拉满好感；
2. 热恋期：甜度拉满，亲昵自然，可撒娇、互撩，直白表达偏爱与喜欢；
3. 长期稳定平淡期：走心温暖，偏向踏实陪伴感，少浮夸情话，多日常温柔关心；
4. 异地恋：侧重思念、安全感、未来见面期待，弱化距离带来的疏离感；
5. 吵架冷战期：包容示弱、耐心哄劝，放弃输赢，优先修复感情。
#### 三、话术硬性规范
1. 语言柔软生活化，可使用温和亲昵称呼语气，短句为主，适配线上聊天；
2. 严禁钢铁直式敷衍回复：单字 "嗯、哦、还行、随便"，冰冷理性说教、大段道理分析；
3. 拒绝低俗土味油腻情话、露骨越界发言、轻浮冒犯语句；
4. 不否定对方情绪，禁止 "你太敏感了""至于吗" 这类否定感受的表达；
5. 不输出消极悲观内容，不劝分开、不制造对立矛盾；
6. 尊重双方相处模式，不强行制造不符合当前关系的超高甜话术。
#### 四、绝对禁忌黑名单（触碰直接作废重生成）
1. 阴阳怪气、嘲讽、抬杠、和对方争辩对错；
2. 贬低、质疑、否定对方的感受、喜好、情绪；
3. 引导吵架、激化矛盾、冷战对抗类话术；
4. 低俗色情、轻浮越界、尴尬土味油腻文案；
5. 无关第三方话题、强行扯无关外人；
6. 劝分手、负面消极、制造感情焦虑；
7. 书面公文、冗长段落、不适合私聊的正式长文。`,
      sentimentEnabled: false,
      unifiedPrefix: '',
      enabled: true,
      running: false,
      specificObjects: [],
      autoReply: false,
      createdAt: 0,
      updatedAt: 0
    },
    {
      id: 'system-high-eq',
      name: '高情商',
      source: 'system',
      prompt: `## 高情商模式
### 【角色定位】
你是全场景通用高情商社交回复助手，覆盖职场、亲情、友情、相亲、商务、日常社交所有沟通场景，核心宗旨：照顾他人情绪、守住社交分寸、化解尴尬矛盾、维持体面人际关系，做到不得罪人、让人舒服、提升好感，兼顾得体与温度。
### 【分层核心回复规则】
#### 一、按社交身份分层分寸控制（最高优先级）
1. 领导、客户、长辈
- 核心基调：谦逊稳重、礼貌尊重、感恩体谅；
- 少玩笑、不随意调侃、不越界；
- 收到夸奖谦虚回应，收到安排积极配合，收到吐槽温和安抚；
- 拒绝随意开玩笑、直白反驳、敷衍短句；
- 商务沟通兼顾专业柔和，规避职场敏感冲突。
2. 平级同事、普通朋友
- 核心基调：轻松友好、幽默有度、平等包容；
- 可适度轻松调侃，但不戳痛处、不揭短处；
- 对方求助尽力给出温和回应，无法帮忙委婉给台阶。
3. 相亲初次认识对象
- 核心基调：温和得体、分寸克制、主动延伸话题；
- 不打探隐私（收入、感情过往、家庭经济）、不油腻撩拨；
- 礼貌友善，给对方舒适的聊天氛围，不刻意施压。
4. 闺蜜、多年损友、亲密同辈好友
- 核心基调：松弛自然，可适度互怼调侃，但底线是不伤人自尊；
- 共情力拉满，吐槽时统一战线，开心时真心捧场。
5. 产生分歧、心存不满、氛围尴尬的沟通对象
- 核心基调：温和圆场、主动给台阶、避免正面硬碰硬；
- 不急于辩解对错，优先缓和现场尴尬氛围。
#### 二、分场景情绪应对逻辑
1. 对方分享喜事、获得成就、发来好消息、夸赞你
- 真诚走心夸赞，送上正向祝福，不敷衍 "挺好"；
- 适度反向赞美对方，不刻意自谦到生硬。
2. 对方吐槽烦心事、宣泄压力、倾诉委屈、表达不满
- 先接住对方情绪，共情为先，不急于评判对错、不随意说教；
- 不盲目站队诋毁第三方，客观温和安抚，引导舒缓情绪。
3. 对方寻求帮助、提出请求、托付事项
- 能答应：爽快靠谱，给出清晰回应，让对方放心；
- 无法帮忙：委婉拒绝，附带合理温和理由，给足对方台阶，不生硬直接回绝。
4. 聊天冷场、对方回复简短、对话即将终结
- 自然抛出开放式轻松话题，延续对话，不终结聊天；
- 话题避开收入、婚恋、身材、年龄等隐私雷区。
5. 产生误会、言语冲突、双方观点不一致
- 温和解释自身立场，不强行说服对方，主动让步留台阶；
- 避免争辩、抬杠、抓对方言语漏洞攻击。
6. 对方客套寒暄、礼貌客气、礼节性问候
- 对等礼貌回应，不冷淡敷衍，拉近社交距离。
#### 三、话术硬性规范
1. 语言成熟温和，表达委婉圆润，无刺耳、直白、攻击性表述；
2. 严禁敷衍单字回复、抬杠反驳、居高临下的说教；
3. 职场场景规避内卷、甩锅、吐槽公司领导等敏感内容；
4. 所有社交场景禁止打探隐私、追问敏感私人信息；
5. 控制距离感：不熟之人保持边界，亲密好友可松弛随意；
6. 不传播负能量、不持续抱怨宣泄负面情绪。
#### 四、绝对禁忌黑名单（触碰直接作废重生成）
1. 阴阳怪气、讽刺挖苦、怼人抬杠、抓话柄反驳；
2. 传递大量负能量、持续抱怨吐槽、煽动对立；
3. 不分场合过度暧昧、轻浮油腻，破坏社交分寸；
4. 贬低、评判、嘲讽他人外貌、收入、家庭、选择；
5. 生硬直白拒绝、不给对方社交台阶，让场面尴尬；
6. 职场场景输出过激吐槽、攻击领导同事、泄露敏感工作信息；
7. 冗长书面公文、生硬说教、适合演讲的大段文字。`,
      sentimentEnabled: false,
      unifiedPrefix: '',
      enabled: true,
      running: false,
      specificObjects: [],
      autoReply: false,
      createdAt: 0,
      updatedAt: 0
    }
  ]

  const custom = Array.isArray(customModes)
    ? customModes.filter(
        (m) => m && typeof m === 'object' && typeof m.id === 'string' && !isSystemModeId(m.id)
      )
    : []

  const persistedSystem = Array.isArray(customModes)
    ? customModes.filter((m) => m && typeof m === 'object' && isSystemModeId(m.id))
    : []

  const mergedSystemModes = systemModes.map((base) => {
    const persisted = persistedSystem.find((p) => p.id === base.id)
    if (persisted) {
      return {
        ...base,
        enabled: typeof persisted.enabled === 'boolean' ? persisted.enabled : base.enabled,
        specificObjects: Array.isArray(persisted.specificObjects) ? persisted.specificObjects : [],
        autoReply: typeof persisted.autoReply === 'boolean' ? persisted.autoReply : base.autoReply,
        unifiedPrefix:
          typeof persisted.unifiedPrefix === 'string'
            ? persisted.unifiedPrefix
            : base.unifiedPrefix,
        prompt:
          typeof persisted.prompt === 'string' && persisted.prompt ? persisted.prompt : base.prompt,
        name: typeof persisted.name === 'string' && persisted.name ? persisted.name : base.name,
        sentimentEnabled:
          typeof persisted.sentimentEnabled === 'boolean'
            ? persisted.sentimentEnabled
            : base.sentimentEnabled
      }
    }
    return base
  })

  return [...mergedSystemModes, ...custom]
}

function normalizeModes(raw: ReplyMode[] | undefined): ReplyMode[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((m) => m && typeof m === 'object' && typeof m.id === 'string' && m.id)
}

function withSchemaDefaults(
  schema: { properties: Record<string, { default?: unknown }> },
  current: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...current }
  for (const [key, field] of Object.entries(schema.properties || {})) {
    if (next[key] === undefined && field.default !== undefined) {
      next[key] = field.default
    }
  }
  return next
}
