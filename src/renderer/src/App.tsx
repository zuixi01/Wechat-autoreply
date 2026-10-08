import { translations, I18nContext, useI18n, type Locale } from './localization'
import { useState, useCallback, useRef, useEffect, useMemo, Fragment } from 'react'
import logoUrl from './assets/logo.png'
import logoBlackUrl from './assets/logo_black.png'
import MemoryWindow from './MemoryWindow'
import EnterpriseConnection from './features/agent/EnterpriseConnection'
import AutomationConsole from './features/workspace/AutomationConsole'
import ModelConnectionTest from './features/models/ModelConnectionTest'
import KnowledgePanel from './features/knowledge/KnowledgePanel'
import { showToast, subscribeToast, type ToastNotification } from './toast'
import { defaultReplyMode, objectReplyPolicy } from '../../shared/reply-rules'
import './index.css'
import './workspace.css'
import './features/workspace/automation.css'

type SettingsSection = 'base' | 'model' | 'agent' | 'enterprise'
type WorkspaceSection = SettingsSection | 'memory' | 'objects' | 'knowledge'
type AppType = 'wechat' | 'wework' | 'dingtalk' | 'lark' | 'slack' | 'telegram' | 'generic'

type CaptureStrategy = 'auto' | 'vlm' | 'box-select'

interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

interface BoxRegions {
  contactList: ScreenRect
  chatMain: ScreenRect
  inputBox: ScreenRect
  unreadIndicator: ScreenRect | null
  displayId?: number
  scaleFactor?: number
  capturedAt: number
}

interface InstalledProviderInfo {
  id: string
  name: string
  version: string
  entryFile: string
  installedAt: string
}

type ProviderConfigFieldType = 'text' | 'password' | 'url' | 'select' | 'textarea'

interface ProviderConfigField {
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

interface ProviderCatalogItem {
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

interface ProviderHubCache {
  sourceUrl: string
  fetchedAt: string
  providers: ProviderCatalogItem[]
}

interface ProviderHubResult {
  success: boolean
  error?: string
  catalog?: ProviderHubCache | null
}

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
    config: Record<string, string>
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

interface SpecificObject {
  id: string
  name: string
  title: string
  relationship: string
  modeId: string
  autoReply: boolean | null
  replyRules?: string
}

interface ReplyMode {
  id: string
  name: string
  source: 'system' | 'custom'
  prompt: string
  sentimentEnabled: boolean
  unifiedPrefix: string
  enabled: boolean
  running: boolean
  specificObjects: SpecificObject[]
  autoReply: boolean
  createdAt: number
  updatedAt: number
}

type ModelCapability = 'text' | 'vision' | 'audio'

interface ModelConfig {
  id: string
  name: string
  provider: string
  modelName: string
  apiKey: string
  baseURL: string
  capabilities: ModelCapability[]
  createdAt: number
}

const PROVIDER_PRESETS = [
  {
    id: 'volcengine-ark',
    name: '火山方舟 (Volcengine Ark)',
    defaultBaseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seed-2-0-lite-260215',
    defaultCapabilities: ['text', 'vision'] as ModelCapability[]
  },
  {
    id: 'aliyun-bailian',
    name: '阿里云百炼 (DashScope)',
    defaultBaseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-vl-plus',
    defaultCapabilities: ['text', 'vision'] as ModelCapability[]
  },
  {
    id: 'openai',
    name: 'OpenAI',
    defaultBaseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    defaultCapabilities: ['text', 'vision'] as ModelCapability[]
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    defaultBaseURL: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    defaultCapabilities: ['text'] as ModelCapability[]
  },
  {
    id: 'custom',
    name: '自定义',
    defaultBaseURL: '',
    defaultModel: '',
    defaultCapabilities: ['text'] as ModelCapability[]
  }
]

const BUILTIN_PROVIDER_CATALOG: ProviderCatalogItem[] = [
  {
    id: 'doubao',
    name: '豆包 Seed',
    description: '本地内置聊天 Provider，使用基础配置中的火山方舟密钥。',
    version: '1.0.0',
    manifestUrl: 'builtin://doubao',
    capabilities: ['chat'],
    configSchema: {
      fields: [
        {
          key: 'apiKey',
          label: 'API Key',
          type: 'password',
          required: true,
          placeholder: '输入火山方舟 API Key'
        },
        {
          key: 'model',
          label: '模型',
          type: 'text',
          required: true,
          readonly: true,
          defaultValue: 'doubao-seed-2-0-lite-260428'
        },
        {
          key: 'baseURL',
          label: 'Base URL',
          type: 'url',
          placeholder: 'https://ark.cn-beijing.volces.com/api/v3'
        },
        {
          key: 'systemPrompt',
          label: '系统提示词',
          type: 'textarea',
          placeholder: '你是一个微信自动回复助手。根据截图中的聊天内容，生成合适的回复...'
        }
      ]
    }
  }
]

const GearIcon = (): React.JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
)

// 工作记忆 — 时钟+轨迹点图标
const MemoryIcon = (): React.JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
    <path d="M12 7v5l3 3" />
  </svg>
)

const RefreshIcon = (): React.JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 12a9 9 0 0 1-15.1 6.6" />
    <path d="M3 12A9 9 0 0 1 18.1 5.4" />
    <path d="M18 2v4h-4" />
    <path d="M6 22v-4h4" />
  </svg>
)

async function readModeConfiguration(): Promise<
  [ReplyMode[] | undefined, AppSettings | undefined]
> {
  return Promise.all([
    window.electron?.invoke('mode:list') as Promise<ReplyMode[] | undefined>,
    window.electron?.invoke('settings:getAll') as Promise<AppSettings | undefined>
  ])
}

function App(): React.JSX.Element {
  const windowKind = new URLSearchParams(window.location.search).get('window')
  const [modes, setModes] = useState<ReplyMode[]>([])
  const [activeModeId, setActiveModeId] = useState<string>('')
  const [homeSection, setHomeSection] = useState<WorkspaceSection | null>(null)
  const [visitedSections, setVisitedSections] = useState<Set<WorkspaceSection>>(new Set())
  const [locale, setLocaleState] = useState<Locale>('zh')
  const [theme, setThemeState] = useState<'dark' | 'light'>('dark')
  useModalKeyboard()
  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
  }, [locale])

  const t = useCallback(
    (key: string): string => {
      return translations[locale]?.[key] ?? translations.zh[key] ?? key
    },
    [locale]
  )

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l)
    void window.electron?.invoke('settings:set', { locale: l })
  }, [])

  const setTheme = useCallback((th: 'dark' | 'light') => {
    setThemeState(th)
    document.documentElement.setAttribute('data-theme', th)
    void window.electron?.invoke('settings:set', { theme: th })
  }, [])

  useEffect(() => {
    const load = async (): Promise<void> => {
      const settings = (await window.electron?.invoke('settings:getAll')) as AppSettings | undefined
      if (settings) {
        setLocaleState(settings.locale || 'zh')
        setThemeState(settings.theme || 'dark')
        document.documentElement.setAttribute('data-theme', settings.theme || 'dark')
      }
    }
    void load()
  }, [])

  useEffect(() => {
    const cleanup = window.electron?.on(
      'settings:changed',
      (data: { theme?: string; locale?: string }) => {
        if (data.theme === 'light' || data.theme === 'dark') {
          setThemeState(data.theme)
          document.documentElement.setAttribute('data-theme', data.theme)
        }
        if (data.locale === 'zh' || data.locale === 'en') {
          setLocaleState(data.locale)
        }
      }
    )
    return cleanup ?? (() => {})
  }, [])

  const i18nValue = useMemo(() => ({ t, locale, setLocale }), [t, locale, setLocale])

  const applyModeConfiguration = useCallback(
    async (list: ReplyMode[] | undefined, settings: AppSettings | undefined): Promise<void> => {
      const common = defaultReplyMode(list || [], settings?.globalDefaultModeId || '')
      setModes(list || [])
      setActiveModeId(common?.id || '')
      if (common && settings && settings.globalDefaultModeId !== common.id) {
        const result = await window.electron?.invoke('settings:set', {
          globalDefaultModeId: common.id
        })
        if (!result?.success) showToast('通用规则配置未能保存，请重试。', 'error')
      }
    },
    []
  )

  const loadModes = useCallback(async (): Promise<void> => {
    const [list, settings] = await readModeConfiguration()
    await applyModeConfiguration(list, settings)
  }, [applyModeConfiguration])

  useEffect(() => {
    let current = true
    void readModeConfiguration().then(([list, settings]) => {
      if (current) void applyModeConfiguration(list, settings)
    })
    return () => {
      current = false
    }
  }, [applyModeConfiguration])

  useEffect(() => {
    const cleanup = window.electron?.on('mode:changed', () => {
      void loadModes()
    })
    const settingsCleanup = window.electron?.on('settings:changed', () => {
      void loadModes()
    })
    return () => {
      cleanup?.()
      settingsCleanup?.()
    }
  }, [loadModes])

  if (windowKind === 'settings') {
    return (
      <I18nContext.Provider value={i18nValue}>
        <div className="app settings-window">
          <SettingsWindow theme={theme} setTheme={setTheme} />
          <Toast />
        </div>
      </I18nContext.Provider>
    )
  }

  if (windowKind === 'memory') {
    return (
      <I18nContext.Provider value={i18nValue}>
        <div className="app settings-window">
          <MemoryWindow />
          <Toast />
        </div>
      </I18nContext.Provider>
    )
  }

  const activeMode = modes.find((m) => m.id === activeModeId)

  const selectSection = (section: WorkspaceSection | null): void => {
    setHomeSection(section)
    if (section) setVisitedSections((previous) => new Set(previous).add(section))
    if (!section) {
      void loadModes()
      window.dispatchEvent(new Event('autoreply:home-refresh'))
    }
  }
  const openSection = (section: WorkspaceSection): void => selectSection(section)
  const activeTool = HOME_TOOLS.find((tool) => tool.section === homeSection)
  const pageTitle = activeTool?.label || '工作台'
  const pageDescription = activeTool?.description || 'AI 自动回复与发送，集中查看运行状态和配置。'

  return (
    <I18nContext.Provider value={i18nValue}>
      <div className="app workspace-app">
        <aside className="workspace-sidebar" aria-label="主导航">
          <a
            className="workspace-brand"
            href="#"
            onClick={(event) => {
              event.preventDefault()
              selectSection(null)
            }}
            aria-label="AutoReply 首页"
          >
            <span className="brand-monogram">A</span>
            <span>
              AutoReply <span className="brand-description">智能回复助手</span>
            </span>
          </a>
          <div
            className="workspace-navigation"
            role="tablist"
            aria-label="功能与配置"
            aria-orientation="vertical"
            onKeyDown={(event) => {
              const tabs = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')
              )
              const index = tabs.indexOf(event.target as HTMLButtonElement)
              if (index < 0 || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length
              tabs[next].focus()
              tabs[next].click()
            }}
          >
            <span className="workspace-nav-label" role="presentation">
              工作空间
            </span>
            <button
              className={`workspace-nav-item ${homeSection === null ? 'active' : ''}`}
              role="tab"
              id="workspace-tab-home"
              aria-controls="workspace-panel-home"
              aria-selected={homeSection === null}
              tabIndex={homeSection === null ? 0 : -1}
              onClick={() => selectSection(null)}
            >
              <HomeToolIcon section="home" />
              <span>工作台</span>
            </button>
            {HOME_TOOLS.map((tool, index) => (
              <Fragment key={tool.section}>
                {index === 4 && (
                  <span className="workspace-nav-label" role="presentation">
                    扩展与设置
                  </span>
                )}
                <button
                  className={`workspace-nav-item ${homeSection === tool.section ? 'active' : ''}`}
                  role="tab"
                  id={`workspace-tab-${tool.section}`}
                  aria-controls={`workspace-panel-${tool.section}`}
                  aria-selected={homeSection === tool.section}
                  tabIndex={homeSection === tool.section ? 0 : -1}
                  onClick={() => openSection(tool.section)}
                >
                  <HomeToolIcon section={tool.section} />
                  <span>{tool.label}</span>
                </button>
              </Fragment>
            ))}
          </div>
          <div className="workspace-sidebar-footer">
            <span className="status-dot idle" />
            <span>微信自动回复</span>
          </div>
        </aside>

        <div className="workspace-content">
          <header className="workspace-topbar">
            <div className="workspace-page-title">
              <h1>{pageTitle}</h1>
              <p>{pageDescription}</p>
            </div>
            <div className="workspace-topbar-actions">
              <button
                className="btn btn-text"
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                aria-label={theme === 'dark' ? '切换浅色主题' : '切换深色主题'}
              >
                {theme === 'dark' ? '浅色外观' : '深色外观'}
              </button>
            </div>
          </header>
          <main className="workspace-scroll">
            <div
              className="workspace-page"
              role="tabpanel"
              id="workspace-panel-home"
              aria-labelledby="workspace-tab-home"
              hidden={homeSection !== null}
            >
              {activeMode ? (
                <ModeSubInterface
                  key={activeMode.id}
                  mode={activeMode}
                  onModesChanged={loadModes}
                  active={homeSection === null}
                  modes={modes}
                  onOpenSection={openSection}
                />
              ) : (
                <div className="workspace-grid automation-empty-home">
                  {window.agentRuntime ? (
                    <AutomationConsole
                      active={homeSection === null}
                      onOpenConnection={() => openSection('enterprise')}
                    />
                  ) : (
                    <section className="workspace-panel workspace-welcome">
                      <h2>设置回复规则，开始使用</h2>
                      <p>选择模型并填写回复要求，AI 会结合知识资料生成回复。</p>
                    </section>
                  )}
                  <HomeConfiguration onOpenSection={openSection} />
                </div>
              )}
            </div>
            {HOME_TOOLS.map((tool) => (
              <div
                className={`workspace-page workspace-feature-page ${tool.section === 'memory' ? 'workspace-memory-page' : ''}`}
                key={tool.section}
                role="tabpanel"
                id={`workspace-panel-${tool.section}`}
                aria-labelledby={`workspace-tab-${tool.section}`}
                hidden={homeSection !== tool.section}
              >
                {visitedSections.has(tool.section) && (
                  <HomeSectionContent
                    section={tool.section}
                    modes={modes}
                    activeModeId={activeModeId}
                    onModesChanged={loadModes}
                    active={homeSection === tool.section}
                    theme={theme}
                    setTheme={setTheme}
                  />
                )}
              </div>
            ))}
          </main>
        </div>
        <Toast />
      </div>
    </I18nContext.Provider>
  )
}
function ModeSubInterface({
  mode,
  onModesChanged,
  active,
  modes,
  onOpenSection
}: {
  mode: ReplyMode
  onModesChanged: () => void
  active: boolean
  modes: ReplyMode[]
  onOpenSection: (section: WorkspaceSection) => void
}): React.JSX.Element {
  return (
    <div className="home-mode automation-home">
      <header className="home-mode-header">
        <div className="home-mode-title home-rules-title">
          <span className="home-rules-status-dot" />
          <strong>统一回复规则</strong>
          <span>知识库提供依据，规则决定如何回复</span>
        </div>
        <button className="btn btn-text home-users-link" onClick={() => onOpenSection('objects')}>
          <HomeToolIcon section="objects" />
          对象用户 {modes.reduce((count, item) => count + item.specificObjects.length, 0)} ↗
        </button>
      </header>
      <div className="workspace-grid automation-grid">
        <div className="workspace-primary">
          <AutomationConsole active={active} onOpenConnection={() => onOpenSection('enterprise')} />
        </div>
        <aside className="workspace-configuration" aria-label="主页配置">
          <HomeModeRules mode={mode} onSaved={onModesChanged} />
          <HomeConfiguration onOpenSection={onOpenSection} />
        </aside>
      </div>
    </div>
  )
}

function ObjectUsersPanel({
  modes,
  activeModeId,
  onModesChanged
}: {
  modes: ReplyMode[]
  activeModeId: string
  onModesChanged: () => void
}): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [ruleFilter, setRuleFilter] = useState('')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<{ object: SpecificObject; mode: ReplyMode } | null>(null)
  const [deleting, setDeleting] = useState<{ object: SpecificObject; mode: ReplyMode } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const rows = modes.flatMap((mode) =>
    (mode.specificObjects || []).map((object) => ({ mode, object }))
  )
  const query = search.trim().toLocaleLowerCase()
  const filtered = rows.filter(
    ({ mode, object }) =>
      (!ruleFilter ||
        (hasDedicatedRules(mode, object, activeModeId) ? 'dedicated' : 'common') === ruleFilter) &&
      (!query ||
        [object.name, object.title, object.relationship].some((value) =>
          value.toLocaleLowerCase().includes(query)
        ))
  )
  const addModeId =
    (modes.some((mode) => mode.id === activeModeId) ? activeModeId : '') || modes[0]?.id || ''
  const remove = async (): Promise<void> => {
    if (!deleting || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await window.electron?.invoke(
        'object:delete',
        deleting.mode.id,
        deleting.object.id
      )
      if (!result?.success) {
        setError(result?.error || '删除失败，请重试。')
        return
      }
      setDeleting(null)
      onModesChanged()
      showToast('对象用户已删除', 'success')
    } catch {
      setError('删除失败，请重试。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <section
        className="object-users-panel workspace-panel"
        aria-labelledby="object-users-heading"
      >
        <header className="object-users-heading">
          <div>
            <h2 id="object-users-heading">
              用户列表 <span>{rows.length}</span>
            </h2>
            <p>管理用户资料和专属回复要求，未设置的用户沿用通用规则。</p>
          </div>
          <button className="btn btn-primary" disabled={!addModeId} onClick={() => setAdding(true)}>
            ＋ 新增用户
          </button>
        </header>
        <div className="object-users-toolbar">
          <input
            className="form-input"
            type="search"
            aria-label="搜索对象用户"
            placeholder="搜索用户名称、称呼或关系"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select
            className="form-input"
            aria-label="筛选回复规则"
            value={ruleFilter}
            onChange={(event) => setRuleFilter(event.target.value)}
          >
            <option value="">全部用户</option>
            <option value="common">沿用通用规则</option>
            <option value="dedicated">有专属要求</option>
          </select>
          <span className="object-users-total">显示 {filtered.length} 位用户</span>
        </div>
        <div className="object-users-table-scroll">
          <table className="object-users-table">
            <thead>
              <tr>
                <th scope="col">对象用户</th>
                <th scope="col">专属称呼</th>
                <th scope="col">关系 / 备注</th>
                <th scope="col">回复规则</th>
                <th scope="col">自动回复</th>
                <th scope="col" className="object-users-actions">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(({ mode, object }) => (
                <tr key={object.id} className="object-users-row" data-object-id={object.id}>
                  <td>
                    <span className="object-user-name">
                      <span className="contact-initial">{object.name.slice(0, 1)}</span>
                      <strong>{object.name}</strong>
                    </span>
                  </td>
                  <td>{object.title || <span className="object-users-muted">未设置</span>}</td>
                  <td>
                    {object.relationship || <span className="object-users-muted">未设置</span>}
                  </td>
                  <td>
                    <span className="object-mode-tag">
                      {hasDedicatedRules(mode, object, activeModeId) ? '专属要求' : '通用规则'}
                    </span>
                    {!mode.enabled && (
                      <small className="object-disabled-mode">原有规则已暂停</small>
                    )}
                  </td>
                  <td>
                    <span
                      className={`object-policy ${
                        (object.autoReply ??
                        objectReplyPolicy(
                          mode,
                          object,
                          modes.find((item) => item.id === activeModeId)
                        ).autoReply)
                          ? 'enabled'
                          : ''
                      }`}
                    >
                      {object.autoReply === null ? '沿用设置' : object.autoReply ? '开启' : '关闭'}
                    </span>
                    {object.autoReply === null && (
                      <small className="object-disabled-mode">
                        当前
                        {objectReplyPolicy(
                          mode,
                          object,
                          modes.find((item) => item.id === activeModeId)
                        ).autoReply
                          ? '开启'
                          : '关闭'}
                      </small>
                    )}
                  </td>
                  <td>
                    <div className="object-users-actions">
                      <button
                        className="btn btn-text"
                        aria-label={`编辑用户 ${object.name}`}
                        onClick={() => setEditing({ mode, object })}
                      >
                        编辑
                      </button>
                      <button
                        className="btn btn-text danger"
                        aria-label={`删除用户 ${object.name}`}
                        onClick={() => {
                          setError('')
                          setDeleting({ mode, object })
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div className="object-users-empty">
            <HomeToolIcon section="objects" />
            <h3>{rows.length ? '没有找到匹配的用户' : '还没有对象用户'}</h3>
            <p>
              {rows.length
                ? '试试其他名称，或清除筛选条件。'
                : modes.length
                  ? '新增用户后，可设置专属称呼、关系和回复要求。'
                  : '请返回工作台完成回复规则配置。'}
            </p>
            {rows.length > 0 && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  setSearch('')
                  setRuleFilter('')
                }}
              >
                清除筛选
              </button>
            )}
          </div>
        )}
        <footer className="object-users-note">
          用户名称需与聊天客户端中的名称一致；自动回复关闭的用户将保留当前设置。
        </footer>
      </section>
      {adding && (
        <AddObjectModal
          key={addModeId}
          modeId={addModeId}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false)
            onModesChanged()
          }}
        />
      )}
      {editing && (
        <EditObjectModal
          modeId={editing.mode.id}
          initialRules={
            editing.object.replyRules ??
            (editing.mode.id !== activeModeId ? editing.mode.prompt : '')
          }
          recoveryModeId={!editing.mode.enabled ? activeModeId : undefined}
          object={editing.object}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            onModesChanged()
          }}
        />
      )}
      {deleting && (
        <div className="modal-overlay modal-overlay-full">
          <div className="modal-content object-delete-dialog">
            <h2>删除对象用户</h2>
            <p>确定删除“{deleting.object.name}”的专属回复配置？</p>
            <p className="form-hint">这不会删除聊天客户端中的联系人或聊天记录。</p>
            {error && (
              <p className="object-delete-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => setDeleting(null)}
              >
                取消
              </button>
              <button
                className="btn btn-secondary danger"
                disabled={busy}
                onClick={() => void remove()}
              >
                {busy ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function hasDedicatedRules(mode: ReplyMode, object: SpecificObject, commonId: string): boolean {
  return object.replyRules !== undefined ? Boolean(object.replyRules.trim()) : mode.id !== commonId
}

function ObjectReplyRequirements({
  value,
  onChange
}: {
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <div className="form-group object-requirements-field">
      <label className="form-label" htmlFor="object-reply-requirements">
        专属回复要求 <span>可选</span>
      </label>
      <textarea
        id="object-reply-requirements"
        className="form-input"
        rows={4}
        maxLength={8000}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="例如：语气轻松一些，询问订单号后再解答。"
      />
      <p className="form-hint">留空沿用主页通用规则；填写后结合通用规则和知识库回复此用户。</p>
    </div>
  )
}

function EditObjectModal({
  modeId,
  initialRules,
  recoveryModeId,
  object,
  onClose,
  onSaved
}: {
  modeId: string
  initialRules: string
  recoveryModeId?: string
  object: SpecificObject
  onClose: () => void
  onSaved: (obj: SpecificObject) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [replyRules, setReplyRules] = useState(initialRules)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState(object.name)
  const [title, setTitle] = useState(object.title || '')
  const [relationship, setRelationship] = useState(object.relationship || '')
  const [autoReply, setAutoReply] = useState<boolean | null>(object.autoReply)

  const handleSave = useCallback(async () => {
    if (saving) return
    if (!name.trim()) {
      showToast(t('object.name.required'), 'error')
      return
    }
    setSaving(true)
    try {
      const result = await window.electron?.invoke('object:update', modeId, object.id, {
        ...(recoveryModeId && autoReply === true ? { modeId: recoveryModeId } : {}),
        replyRules: replyRules.trim(),
        name: name.trim(),
        title: title.trim(),
        relationship: relationship.trim(),
        autoReply
      })
      if (result?.success) {
        showToast(t('object.updated') || '对象已更新', 'success')
        onSaved(result.object)
      } else {
        showToast(result?.error || t('object.update.fail') || '更新失败', 'error')
      }
    } catch {
      showToast('保存失败，填写内容已保留，请重试。', 'error')
    } finally {
      setSaving(false)
    }
  }, [
    name,
    title,
    relationship,
    autoReply,
    replyRules,
    saving,
    modeId,
    recoveryModeId,
    object.id,
    onSaved,
    t
  ])

  return (
    <div
      className="modal-overlay modal-overlay-full"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal-content" onMouseDown={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0, marginBottom: 16 }}>
          {t('object.editTitle') || '编辑特定对象'}
        </h2>
        <div className="form-group">
          <label className="form-label" htmlFor="object-edit-name">
            {t('object.name')} <span className="required-mark">*</span>
          </label>
          <input
            className="form-input"
            id="object-edit-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('object.name.placeholder')}
          />
          <div className="form-hint">{t('object.name.hint')}</div>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="object-edit-title">
            {t('object.title.label')}
          </label>
          <input
            className="form-input"
            id="object-edit-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('object.title.placeholder')}
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="object-edit-relationship">
            {t('object.relationship')}
          </label>
          <input
            className="form-input"
            id="object-edit-relationship"
            value={relationship}
            onChange={(e) => setRelationship(e.target.value)}
            placeholder={t('object.relationship.placeholder')}
          />
        </div>
        <ObjectReplyRequirements value={replyRules} onChange={setReplyRules} />
        {recoveryModeId && (
          <p className="form-hint">
            原有规则已暂停。选择开启自动回复并保存后，此用户将使用通用规则和专属要求。
          </p>
        )}
        <div className="form-group">
          <label className="form-label" htmlFor="object-edit-auto">
            {t('object.autoReply')}
          </label>
          <select
            className="form-input"
            id="object-edit-auto"
            value={autoReply === null ? '' : autoReply ? 'true' : 'false'}
            onChange={(e) => {
              if (e.target.value === '') setAutoReply(null)
              else setAutoReply(e.target.value === 'true')
            }}
          >
            <option value="">{t('object.autoReply.follow')}</option>
            <option value="true">{t('object.autoReply.on')}</option>
            <option value="false">{t('object.autoReply.off')}</option>
          </select>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn btn-secondary" disabled={saving} onClick={onClose}>
            {t('btn.cancel')}
          </button>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>
            {saving ? '保存中…' : t('btn.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

function AddObjectModal({
  modeId,
  onClose,
  onSaved
}: {
  modeId: string
  onClose: () => void
  onSaved: (obj: SpecificObject) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [relationship, setRelationship] = useState('')
  const [replyRules, setReplyRules] = useState('')
  const [saving, setSaving] = useState(false)
  const [autoReply, setAutoReply] = useState<boolean | null>(null)

  const handleSave = useCallback(async () => {
    if (saving) return
    if (!name.trim()) {
      showToast(t('object.name.required'), 'error')
      return
    }
    setSaving(true)
    try {
      const result = await window.electron?.invoke('object:create', modeId, {
        name: name.trim(),
        title: title.trim(),
        relationship: relationship.trim(),
        replyRules: replyRules.trim(),
        autoReply
      })
      if (result?.success) {
        showToast(t('object.added'), 'success')
        onSaved(result.object)
      } else {
        showToast(result?.error || t('object.add.fail'), 'error')
      }
    } catch {
      showToast('保存失败，填写内容已保留，请重试。', 'error')
    } finally {
      setSaving(false)
    }
  }, [name, title, relationship, replyRules, saving, autoReply, modeId, onSaved, t])

  return (
    <div
      className="modal-overlay modal-overlay-full"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal-content" onMouseDown={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0, marginBottom: 16 }}>{t('object.addTitle')}</h2>
        <div className="form-group">
          <label className="form-label" htmlFor="object-add-name">
            {t('object.name')} <span className="required-mark">*</span>
          </label>
          <input
            className="form-input"
            id="object-add-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('object.name.placeholder')}
          />
          <div className="form-hint">{t('object.name.hint')}</div>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="object-add-title">
            {t('object.title.label')}
          </label>
          <input
            className="form-input"
            id="object-add-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('object.title.placeholder')}
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="object-add-relationship">
            {t('object.relationship')}
          </label>
          <input
            className="form-input"
            id="object-add-relationship"
            value={relationship}
            onChange={(e) => setRelationship(e.target.value)}
            placeholder={t('object.relationship.placeholder')}
          />
        </div>
        <ObjectReplyRequirements value={replyRules} onChange={setReplyRules} />
        <div className="form-group">
          <label className="form-label" htmlFor="object-add-auto">
            {t('object.autoReply')}
          </label>
          <select
            className="form-input"
            id="object-add-auto"
            value={autoReply === null ? '' : autoReply ? 'true' : 'false'}
            onChange={(e) => {
              if (e.target.value === '') setAutoReply(null)
              else setAutoReply(e.target.value === 'true')
            }}
          >
            <option value="">{t('object.autoReply.follow')}</option>
            <option value="true">{t('object.autoReply.on')}</option>
            <option value="false">{t('object.autoReply.off')}</option>
          </select>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn btn-secondary" disabled={saving} onClick={onClose}>
            {t('btn.cancel')}
          </button>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>
            {saving ? '保存中…' : t('btn.add')}
          </button>
        </div>
      </div>
    </div>
  )
}

function SettingsWindow({
  theme,
  setTheme
}: {
  theme: 'dark' | 'light'
  setTheme: (th: 'dark' | 'light') => void
}): React.JSX.Element {
  const { t, locale, setLocale } = useI18n()
  const [section, setSection] = useState<SettingsSection>(() =>
    new URLSearchParams(window.location.search).get('section') === 'enterprise'
      ? 'enterprise'
      : 'base'
  )

  return (
    <div className="settings-shell">
      <aside className="settings-sidebar">
        <div className="settings-sidebar-brand">
          <img
            src={theme === 'light' ? logoBlackUrl : logoUrl}
            alt="AutoReply"
            className="app-logo"
          />
          <span>{t('settings.title')}</span>
        </div>
        <button
          className={`settings-nav-item ${section === 'enterprise' ? 'active' : ''}`}
          onClick={() => setSection('enterprise')}
        >
          {locale === 'zh' ? '企业连接' : 'Enterprise'}
        </button>
        <button
          className={`settings-nav-item ${section === 'base' ? 'active' : ''}`}
          onClick={() => setSection('base')}
        >
          {t('settings.base')}
        </button>
        <button
          className={`settings-nav-item ${section === 'model' ? 'active' : ''}`}
          onClick={() => setSection('model')}
        >
          {t('settings.model')}
        </button>
        <button
          className={`settings-nav-item ${section === 'agent' ? 'active' : ''}`}
          onClick={() => setSection('agent')}
        >
          {t('settings.agent')}
        </button>
      </aside>

      <main className="settings-main">
        {section === 'enterprise' ? (
          <EnterpriseConnection />
        ) : section === 'base' ? (
          <SettingsPanel theme={theme} setTheme={setTheme} locale={locale} setLocale={setLocale} />
        ) : section === 'model' ? (
          <ModelConfigPanel />
        ) : (
          <AgentPanel />
        )}
      </main>
    </div>
  )
}

function connectionErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error)
    return String(error.message)
  return String(error)
}

function SettingsPanel({
  theme,
  setTheme,
  locale,
  setLocale,
  active = true
}: {
  theme: 'dark' | 'light'
  setTheme: (th: 'dark' | 'light') => void
  locale: Locale
  setLocale: (l: Locale) => void
  active?: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  const [models, setModels] = useState<ModelConfig[]>([])
  const [globalVisionModelId, setGlobalVisionModelId] = useState('')
  const [globalReplyModelId, setGlobalReplyModelId] = useState('')

  useEffect(() => {
    const load = async (): Promise<void> => {
      const settings = (await window.electron?.invoke('settings:getAll')) as AppSettings | undefined
      if (settings) {
        setModels(settings.models || [])
        setGlobalVisionModelId(settings.globalVisionModelId || '')
        setGlobalReplyModelId(settings.globalReplyModelId || '')
      }
    }

    if (active) void load()
  }, [active])

  const handleTestConnection = useCallback(
    async (modelId: string) => {
      if (!modelId) return
      try {
        const result = await window.electron?.invoke('model:testConnection', modelId)
        if (result?.success) {
          showToast(t('toast.connectionOk'), 'success')
        } else {
          showToast(`${t('toast.connectionFail')}: ${result?.error || ''}`, 'error')
        }
      } catch (error: unknown) {
        showToast(`${t('toast.connectionFail')}: ${connectionErrorMessage(error)}`, 'error')
      }
    },
    [t]
  )

  return (
    <div className="settings-page">
      <div className="settings-page-header">
        <div>
          <h1>{t('settings.base')}</h1>
          <p>{t('settings.base.desc')}</p>
        </div>
      </div>

      <div className="card base-settings-card">
        <div className="card-title">{t('settings.basic')}</div>
        <div className="settings-inline-row">
          <span className="settings-inline-label">{t('settings.appearance')}</span>
          <select
            className="form-input settings-inline-select"
            value={theme}
            onChange={(e) => setTheme(e.target.value as 'dark' | 'light')}
          >
            <option value="dark">{t('settings.appearance.dark')}</option>
            <option value="light">{t('settings.appearance.light')}</option>
          </select>
        </div>
        <div className="settings-inline-row">
          <span className="settings-inline-label">{t('settings.language')}</span>
          <select
            className="form-input settings-inline-select"
            value={locale}
            onChange={(e) => setLocale(e.target.value as Locale)}
          >
            <option value="zh">{t('settings.language.zh')}</option>
            <option value="en">{t('settings.language.en')}</option>
          </select>
        </div>
      </div>

      <div className="card base-settings-card">
        <div className="card-title">{t('settings.globalModel')}</div>
        <div className="form-hint" style={{ marginBottom: 12 }}>
          {t('settings.globalModel.hint')}
        </div>

        <div className="form-group">
          <label className="form-label">{t('settings.visionModel')}</label>
          <select
            className="form-input"
            value={globalVisionModelId}
            onChange={async (e) => {
              const id = e.target.value
              setGlobalVisionModelId(id)
              await window.electron?.invoke('settings:set', { globalVisionModelId: id })
            }}
          >
            <option value="">{t('settings.selectVisionModel')}</option>
            {models
              .filter((m) => (m.capabilities || []).includes('vision'))
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.modelName})
                </option>
              ))}
          </select>
          <div className="form-hint">{t('settings.visionModel.hint')}</div>
        </div>

        <div className="form-group">
          <label className="form-label">{t('settings.replyModel')}</label>
          <select
            className="form-input"
            value={globalReplyModelId}
            onChange={async (e) => {
              const id = e.target.value
              setGlobalReplyModelId(id)
              await window.electron?.invoke('settings:set', { globalReplyModelId: id })
            }}
          >
            <option value="">{t('settings.selectReplyModel')}</option>
            {models
              .filter((m) => (m.capabilities || []).includes('text'))
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.modelName})
                </option>
              ))}
          </select>
          <div className="form-hint">{t('settings.replyModel.hint')}</div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn btn-secondary"
            onClick={() => handleTestConnection(globalVisionModelId)}
            disabled={!globalVisionModelId}
          >
            {t('settings.testConnection')}
          </button>
        </div>
      </div>
    </div>
  )
}

function ModelConfigPanel({ active = true }: { active?: boolean }): React.JSX.Element {
  const [models, setModels] = useState<ModelConfig[]>([])
  const [showAddModal, setShowAddModal] = useState(false)
  const [editingModel, setEditingModel] = useState<ModelConfig | null>(null)
  const [filterProvider, setFilterProvider] = useState('')
  const [testingId, setTestingId] = useState<string | null>(null)

  const loadModels = useCallback(async () => {
    const list = (await window.electron?.invoke('model:list')) as ModelConfig[]
    setModels(list || [])
  }, [])

  useEffect(() => {
    if (active) void loadModels()
  }, [loadModels, active])

  const handleDelete = useCallback(async (id: string) => {
    const result = await window.electron?.invoke('model:delete', id)
    if (result?.success) {
      setModels((prev) => prev.filter((m) => m.id !== id))
      showToast('模型已删除', 'success')
    } else {
      showToast(result?.error || '删除失败', 'error')
    }
  }, [])

  const handleTest = useCallback(async (id: string) => {
    setTestingId(id)
    try {
      const result = await window.electron?.invoke('model:testConnection', id)
      if (result?.success) {
        showToast('连接测试成功', 'success')
      } else {
        showToast(`连接测试失败: ${result?.error || ''}`, 'error')
      }
    } catch (error: unknown) {
      showToast(`连接测试失败: ${connectionErrorMessage(error)}`, 'error')
    } finally {
      setTestingId(null)
    }
  }, [])

  const filteredModels = filterProvider
    ? models.filter((m) => m.provider === filterProvider)
    : models

  return (
    <div className="settings-page">
      <div className="settings-page-header">
        <div>
          <h1>模型配置</h1>
          <p>管理不同供应商的 AI 模型，配置 API Key 和连接参数。</p>
        </div>
      </div>

      <div className="card">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16
          }}
        >
          <select
            className="form-input"
            value={filterProvider}
            onChange={(e) => setFilterProvider(e.target.value)}
            style={{ maxWidth: 200 }}
          >
            <option value="">全部供应商</option>
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            className="btn btn-primary"
            onClick={() => {
              setEditingModel(null)
              setShowAddModal(true)
            }}
          >
            + 添加模型
          </button>
        </div>

        {filteredModels.length === 0 ? (
          <div className="message-log-empty">
            {models.length === 0 ? '暂无模型配置，点击"添加模型"开始' : '当前筛选条件下无模型'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {filteredModels.map((model) => {
              const preset = PROVIDER_PRESETS.find((p) => p.id === model.provider)
              return (
                <div
                  key={model.id}
                  className="provider-card"
                  style={{ cursor: 'pointer', height: 'auto' }}
                  onClick={() => {
                    setEditingModel(model)
                    setShowAddModal(true)
                  }}
                >
                  <div className="provider-card-top">
                    <span className="provider-name">
                      {model.name}
                      {(model.capabilities || []).map((cap) => {
                        const capMeta: Record<string, { label: string; color: string }> = {
                          text: { label: '文本', color: '#3b82f6' },
                          vision: { label: '视觉', color: '#10b981' },
                          audio: { label: '语音', color: '#f59e0b' }
                        }
                        const meta = capMeta[cap]
                        if (!meta) return null
                        return (
                          <span
                            key={cap}
                            style={{
                              display: 'inline-block',
                              marginLeft: 6,
                              padding: '1px 6px',
                              borderRadius: 8,
                              fontSize: 10,
                              background: meta.color + '22',
                              color: meta.color,
                              border: `1px solid ${meta.color}44`,
                              verticalAlign: 'middle'
                            }}
                          >
                            {meta.label}
                          </span>
                        )
                      })}
                    </span>
                    <span className="provider-version" style={{ color: '#94a3b8' }}>
                      {preset?.name || model.provider}
                    </span>
                  </div>
                  <div className="provider-desc">
                    {model.modelName} · {model.baseURL || '默认端点'}
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      gap: 8,
                      marginTop: 8,
                      justifyContent: 'space-between'
                    }}
                  >
                    <button
                      className="btn btn-sm btn-test-connection"
                      style={{ fontSize: 12, padding: '4px 10px' }}
                      disabled={testingId === model.id}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleTest(model.id)
                      }}
                    >
                      {testingId === model.id ? '测试中...' : '测试连接'}
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      style={{ fontSize: 12, padding: '4px 10px', color: '#ef4444' }}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDelete(model.id)
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {showAddModal && (
        <ModelEditModal
          model={editingModel}
          onClose={() => {
            setShowAddModal(false)
            setEditingModel(null)
          }}
          onSaved={() => {
            loadModels()
            setShowAddModal(false)
            setEditingModel(null)
          }}
        />
      )}
    </div>
  )
}

function ModelEditModal({
  model,
  onClose,
  onSaved
}: {
  model: ModelConfig | null
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const isEdit = model !== null
  const initialPreset = PROVIDER_PRESETS.find(
    (preset) => preset.id === (model?.provider || 'volcengine-ark')
  )
  const [name, setName] = useState(model?.name || '')
  const [provider, setProvider] = useState(model?.provider || 'volcengine-ark')
  const [modelName, setModelName] = useState(
    model?.modelName || (isEdit ? '' : initialPreset?.defaultModel || '')
  )
  const [apiKey, setApiKey] = useState(model?.apiKey || '')
  const [baseURL, setBaseURL] = useState(
    model?.baseURL || (isEdit ? '' : initialPreset?.defaultBaseURL || '')
  )
  const [capabilities, setCapabilities] = useState<ModelCapability[]>(
    model?.capabilities ||
      (isEdit ? ['text'] : [...(initialPreset?.defaultCapabilities || ['text'])])
  )

  const handleSave = useCallback(async () => {
    if (!modelName.trim()) {
      showToast('模型标识不能为空', 'error')
      return
    }
    if (!apiKey.trim()) {
      showToast('API Key 不能为空', 'error')
      return
    }

    const displayName = name.trim() || modelName.trim()
    const input = {
      name: displayName,
      provider,
      modelName: modelName.trim(),
      apiKey: apiKey.trim(),
      baseURL: baseURL.trim().replace(/\/+$/, ''),
      capabilities
    }
    const result = isEdit
      ? await window.electron?.invoke('model:update', model!.id, input)
      : await window.electron?.invoke('model:create', input)

    if (result?.success) {
      showToast(isEdit ? '模型已更新' : '模型已添加', 'success')
      onSaved()
    } else {
      showToast(result?.error || '操作失败', 'error')
    }
  }, [name, provider, modelName, apiKey, baseURL, capabilities, isEdit, model, onSaved])

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="modal-content modal-content-with-footer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-edit-heading"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="model-edit-heading" style={{ marginTop: 0, marginBottom: 16, flexShrink: 0 }}>
          {isEdit ? '编辑模型' : '添加模型'}
        </h2>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label" htmlFor="model-edit-provider">
              供应商 <span className="required-mark">*</span>
            </label>
            <select
              id="model-edit-provider"
              className="form-input"
              value={provider}
              onChange={(e) => {
                const p = e.target.value
                setProvider(p)
                if (!isEdit) {
                  const preset = PROVIDER_PRESETS.find((pr) => pr.id === p)
                  if (preset) {
                    setBaseURL(preset.defaultBaseURL)
                    setModelName(preset.defaultModel)
                    setCapabilities([...preset.defaultCapabilities])
                  }
                }
              }}
              disabled={isEdit}
            >
              {PROVIDER_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="model-edit-name">
              模型名称
            </label>
            <input
              id="model-edit-name"
              className="form-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：我的豆包模型（可选）"
            />
            <div className="form-hint">用于在界面中识别此模型配置，留空则使用模型标识</div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="model-edit-model">
              模型标识 <span className="required-mark">*</span>
            </label>
            <input
              id="model-edit-model"
              className="form-input"
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              placeholder="例如：doubao-seed-2-0-lite-260215"
            />
            <div className="form-hint">API 调用时使用的模型 ID</div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="model-edit-key">
              API Key <span className="required-mark">*</span>
            </label>
            <input
              id="model-edit-key"
              className="form-input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="输入 API Key"
              autoComplete="off"
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="model-edit-url">
              Base URL
            </label>
            <input
              id="model-edit-url"
              className="form-input"
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              placeholder="https://ark.cn-beijing.volces.com/api/v3"
            />
            <div className="form-hint">API 端点地址，选择供应商后会自动填充</div>
          </div>

          <div className="form-group">
            <label className="form-label">模型能力</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {[
                { key: 'text' as ModelCapability, label: '文本', color: '#3b82f6' },
                { key: 'vision' as ModelCapability, label: '视觉', color: '#10b981' },
                { key: 'audio' as ModelCapability, label: '语音', color: '#f59e0b' }
              ].map((cap) => {
                const active = capabilities.includes(cap.key)
                return (
                  <button
                    key={cap.key}
                    type="button"
                    onClick={() => {
                      setCapabilities((prev) =>
                        prev.includes(cap.key)
                          ? prev.filter((c) => c !== cap.key)
                          : [...prev, cap.key]
                      )
                    }}
                    style={{
                      padding: '4px 12px',
                      borderRadius: 12,
                      fontSize: 12,
                      border: `1.5px solid ${active ? cap.color : '#475569'}`,
                      background: active ? cap.color : 'transparent',
                      color: active ? '#fff' : '#94a3b8',
                      cursor: 'pointer',
                      transition: 'all 0.15s'
                    }}
                  >
                    {cap.label}
                  </button>
                )
              })}
            </div>
            <div className="form-hint">点击选择该模型支持的能力，至少选择&quot;文本&quot;</div>
          </div>
        </div>
        <ModelConnectionTest configuration={{ provider, modelName, apiKey, baseURL }}>
          <button className="btn btn-secondary" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={handleSave}>
            {isEdit ? '保存' : '添加'}
          </button>
        </ModelConnectionTest>
      </div>
    </div>
  )
}

function AgentPanel(): React.JSX.Element {
  const [catalog, setCatalog] = useState<ProviderCatalogItem[]>(BUILTIN_PROVIDER_CATALOG)
  const [selectedId, setSelectedId] = useState(BUILTIN_PROVIDER_CATALOG[0]?.id || '')
  const [activeId, setActiveId] = useState('doubao')
  const [providerDrafts, setProviderDrafts] = useState<Record<string, Record<string, string>>>({})
  const [currentSettings, setCurrentSettings] = useState<AppSettings | null>(null)
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [updatingCatalog, setUpdatingCatalog] = useState(false)
  const selectedProvider = catalog.find((provider) => provider.id === selectedId) || catalog[0]

  const loadSettingsAndCatalog = useCallback(async (forceUpdate: boolean) => {
    setLoadingCatalog(!forceUpdate)
    setUpdatingCatalog(forceUpdate)
    try {
      const [settings, result] = await Promise.all([
        window.electron?.invoke('settings:getAll') as Promise<AppSettings | undefined>,
        window.electron?.invoke(
          forceUpdate ? 'providerHub:update' : 'providerHub:getCatalog'
        ) as Promise<ProviderHubResult>
      ])

      const nextCatalog = mergeProviderCatalog(result?.catalog?.providers || [])
      const nextActiveId = settings?.chatProvider?.installed?.id || 'doubao'
      setCatalog(nextCatalog)
      setCurrentSettings(settings || null)
      setActiveId(nextActiveId)
      setSelectedId(
        (current) =>
          current || nextActiveId || BUILTIN_PROVIDER_CATALOG[0]?.id || nextCatalog[0]?.id || ''
      )
      setProviderDrafts((prev) => ({
        ...prev,
        doubao: {
          ...getProviderDefaults(BUILTIN_PROVIDER_CATALOG[0]),
          ...(prev.doubao || {}),
          ...(!settings?.chatProvider?.installed ? settings?.chatProvider?.config || {} : {}),
          apiKey: prev.doubao?.apiKey || settings?.vision?.apiKey || ''
        },
        [nextActiveId]: {
          ...getProviderDefaults(nextCatalog.find((provider) => provider.id === nextActiveId)),
          ...(prev[nextActiveId] || {}),
          ...(settings?.chatProvider?.config || {})
        }
      }))

      if (result && !result.success) {
        showToast(`智能体列表加载失败: ${result.error || ''}`, 'error')
      } else if (forceUpdate) {
        showToast('智能体列表已更新', 'success')
      }
    } finally {
      setLoadingCatalog(false)
      setUpdatingCatalog(false)
    }
  }, [])

  useEffect(() => {
    void loadSettingsAndCatalog(false)
  }, [loadSettingsAndCatalog])

  const selectedValues = useMemo(
    () => getProviderValues(providerDrafts, selectedProvider, currentSettings),
    [currentSettings, providerDrafts, selectedProvider]
  )

  const setProviderValue = useCallback(
    (fieldKey: string, value: string) => {
      if (!selectedProvider) return
      setProviderDrafts((prev) => ({
        ...prev,
        [selectedProvider.id]: {
          ...getProviderValues(prev, selectedProvider, currentSettings),
          [fieldKey]: value
        }
      }))
    },
    [currentSettings, selectedProvider]
  )

  const persistProvider = useCallback(
    async (provider: ProviderCatalogItem, values: Record<string, string>) => {
      const missing = getMissingRequiredFields(provider, values)
      if (missing.length > 0) {
        showToast(`缺少必填项: ${missing.join('、')}`, 'error')
        return false
      }

      if (provider.id === 'doubao') {
        const { apiKey, ...providerConfig } = values
        await window.electron?.invoke('settings:set', {
          vision: { apiKey },
          chatProvider: {
            manifestUrl: '',
            installed: null,
            config: providerConfig
          }
        })
        const settings = (await window.electron?.invoke('settings:getAll')) as AppSettings
        await window.electron?.invoke('engine:updateConfig', settings)
        setCurrentSettings(settings)
        setActiveId('doubao')
        return true
      }

      const installResult = await window.electron?.invoke(
        'provider:installFromUrl',
        provider.manifestUrl
      )
      if (!installResult?.success) {
        showToast(installResult?.error || '智能体安装失败', 'error')
        return false
      }

      await window.electron?.invoke('settings:set', {
        chatProvider: {
          manifestUrl: provider.manifestUrl,
          installed: installResult.installed,
          config: values
        }
      })
      const settings = (await window.electron?.invoke('settings:getAll')) as AppSettings
      await window.electron?.invoke('engine:updateConfig', settings)
      setCurrentSettings(settings)
      setActiveId(provider.id)
      return true
    },
    []
  )

  const handleSaveConfig = useCallback(async () => {
    if (!selectedProvider) return
    const ok = await persistProvider(selectedProvider, selectedValues)
    if (ok) showToast('智能体配置已保存', 'success')
  }, [persistProvider, selectedProvider, selectedValues])

  const handleActivate = useCallback(async () => {
    if (!selectedProvider) return
    const ok = await persistProvider(selectedProvider, selectedValues)
    if (ok) showToast('已切换当前智能体', 'success')
  }, [persistProvider, selectedProvider, selectedValues])

  return (
    <div className="settings-page">
      <div className="settings-page-header">
        <div>
          <div className="settings-title-row">
            <h1>智能体</h1>
            <button
              className="icon-action refresh-action"
              onClick={() => loadSettingsAndCatalog(true)}
              disabled={updatingCatalog}
              title={updatingCatalog ? '更新中...' : '更新列表'}
              aria-label={updatingCatalog ? '更新中' : '更新智能体列表'}
            >
              <span className={updatingCatalog ? 'refresh-icon spinning' : 'refresh-icon'}>
                <RefreshIcon />
              </span>
            </button>
            {updatingCatalog ? <span className="inline-status">更新中...</span> : null}
          </div>
          <p>选择负责聊天分析和内容生成的智能体，并维护各自配置。</p>
        </div>
      </div>

      {loadingCatalog ? (
        <div className="provider-hub-meta">
          <span className="spinner" />
          正在加载远端智能体列表
        </div>
      ) : null}

      <div className="provider-layout">
        <div className="provider-list">
          {!loadingCatalog && catalog.length === 0 ? (
            <div className="provider-empty">暂无可用智能体，请点击更新列表。</div>
          ) : null}
          {catalog.map((provider) => {
            const description = provider.description || provider.name
            const active = activeId === provider.id

            return (
              <button
                key={provider.id}
                className={`provider-card ${selectedId === provider.id ? 'selected' : ''}`}
                onClick={() => setSelectedId(provider.id)}
              >
                <div className="provider-card-top">
                  <span className="provider-name">{provider.name}</span>
                  {active ? (
                    <span className="provider-status" title="当前启用" aria-label="当前启用">
                      <span className="provider-status-dot" />
                      启用中
                    </span>
                  ) : null}
                </div>
                <div className="provider-desc" title={description}>
                  {description}
                </div>
                <div className="provider-version">v{provider.version}</div>
              </button>
            )
          })}
        </div>

        <div className="card provider-config-card">
          {selectedProvider ? (
            <>
              <div className="provider-config-header">
                <div>
                  <div className="card-title">智能体配置</div>
                  <h2>{selectedProvider.name}</h2>
                </div>
                <span className="provider-version">v{selectedProvider.version}</span>
              </div>

              {selectedProvider.configSchema.fields.map((field) => (
                <ProviderFieldInput
                  key={field.key}
                  field={field}
                  value={selectedValues[field.key] || ''}
                  onChange={(value) => setProviderValue(field.key, value)}
                />
              ))}

              <div className="provider-actions">
                <button className="btn btn-secondary" onClick={handleSaveConfig}>
                  保存配置
                </button>
                <button className="btn btn-primary" onClick={handleActivate}>
                  启用此智能体
                </button>
              </div>
            </>
          ) : (
            <div className="provider-empty">没有选中的智能体。</div>
          )}
        </div>
      </div>
    </div>
  )
}

function ProviderFieldInput({
  field,
  value,
  onChange
}: {
  field: ProviderConfigField
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <div className="form-group">
      <label className="form-label">
        {field.label}
        {field.required ? <span className="required-mark"> *</span> : null}
      </label>
      {field.type === 'textarea' ? (
        <textarea
          className="form-input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          rows={4}
          readOnly={field.readonly}
        />
      ) : field.type === 'select' ? (
        <select
          className="form-input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={field.readonly}
        >
          {(field.options || []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="form-input"
          type={field.type === 'password' ? 'password' : field.type === 'url' ? 'url' : 'text'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          autoComplete="off"
          readOnly={field.readonly}
        />
      )}
      {field.hint ? <div className="form-hint">{field.hint}</div> : null}
    </div>
  )
}

function mergeProviderCatalog(remoteProviders: ProviderCatalogItem[]): ProviderCatalogItem[] {
  const remoteOnly = remoteProviders.filter(
    (provider) => !BUILTIN_PROVIDER_CATALOG.some((builtin) => builtin.id === provider.id)
  )
  return [...BUILTIN_PROVIDER_CATALOG, ...remoteOnly]
}

function getProviderDefaults(provider: ProviderCatalogItem | undefined): Record<string, string> {
  if (!provider) return {}
  return provider.configSchema.fields.reduce<Record<string, string>>((acc, field) => {
    acc[field.key] = field.defaultValue || ''
    return acc
  }, {})
}

function getProviderValues(
  drafts: Record<string, Record<string, string>>,
  provider: ProviderCatalogItem | undefined,
  settings: AppSettings | null
): Record<string, string> {
  if (!provider) return {}
  const defaults = getProviderDefaults(provider)
  if (provider.id === 'doubao') {
    return {
      ...defaults,
      ...(settings?.chatProvider.installed ? {} : settings?.chatProvider.config || {}),
      apiKey: drafts.doubao?.apiKey || settings?.vision.apiKey || '',
      ...(drafts.doubao || {})
    }
  }
  return {
    ...defaults,
    ...(settings?.chatProvider.installed?.id === provider.id ? settings.chatProvider.config : {}),
    ...(drafts[provider.id] || {})
  }
}

function getMissingRequiredFields(
  provider: ProviderCatalogItem,
  values: Record<string, string>
): string[] {
  return provider.configSchema.fields
    .filter((field) => field.required && !values[field.key]?.trim())
    .map((field) => field.label)
}

const HOME_TOOLS: { section: WorkspaceSection; label: string; description: string }[] = [
  { section: 'objects', label: '对象用户', description: '统一管理用户资料与专属回复要求' },
  { section: 'knowledge', label: '知识管理', description: '上传资料、检索知识与规则试答' },
  { section: 'model', label: '模型配置', description: '密钥与连接' },
  { section: 'memory', label: '工作记忆', description: '轨迹与经验' },
  { section: 'enterprise', label: '企业连接', description: '登记与客户回复' },
  { section: 'agent', label: '智能体', description: '供应商与配置' },
  { section: 'base', label: '基础设置', description: '外观与语言' }
]

function HomeToolIcon({ section }: { section: WorkspaceSection | 'home' }): React.JSX.Element {
  const paths: Partial<Record<WorkspaceSection | 'home', React.ReactNode>> = {
    home: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    objects: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5" />
      </>
    ),
    knowledge: (
      <>
        <path d="M4 3h7a3 3 0 0 1 3 3v15a4 4 0 0 0-4-2H4zM14 6a3 3 0 0 1 3-3h3v16h-3a4 4 0 0 0-3 2M7 7h3M7 11h3" />
      </>
    ),
    model: (
      <>
        <rect x="6" y="6" width="12" height="12" rx="3" />
        <path d="M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3" />
        <path d="M10 10h4v4h-4z" />
      </>
    ),
    agent: (
      <>
        <rect x="4" y="7" width="16" height="13" rx="4" />
        <path d="M12 3v4M8 12v2m8-2v2m-6 3h4" />
      </>
    )
  }
  if (section !== 'memory' && paths[section])
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {paths[section]}
      </svg>
    )
  if (section === 'memory') return <MemoryIcon />
  if (section === 'enterprise') return <RefreshIcon />
  return <GearIcon />
}

// Keep keyboard focus and Escape behavior consistent across configuration dialogs.
function useModalKeyboard(): void {
  useEffect(() => {
    const previousFocus = new Map<Element, HTMLElement | null>()
    const observe = (): void => {
      const overlays = Array.from(document.querySelectorAll<HTMLElement>('.modal-overlay'))
      for (const [overlay, before] of previousFocus) {
        if (!overlay.isConnected) {
          previousFocus.delete(overlay)
          if (before?.isConnected) before.focus()
        }
      }
      for (const overlay of overlays) {
        if (previousFocus.has(overlay)) continue
        previousFocus.set(overlay, document.activeElement as HTMLElement | null)
        const dialog = overlay.querySelector<HTMLElement>('.modal-content')
        if (dialog) {
          dialog.setAttribute('role', 'dialog')
          dialog.setAttribute('aria-modal', 'true')
          dialog.setAttribute('aria-label', dialog.querySelector('h2')?.textContent || '配置')
          dialog
            .querySelector<HTMLElement>(
              'input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)'
            )
            ?.focus()
        }
      }
    }
    const keyboard = (event: KeyboardEvent): void => {
      const overlays = Array.from(document.querySelectorAll<HTMLElement>('.modal-overlay'))
      const overlay = overlays.at(-1)
      if (!overlay) return
      if (event.key === 'Escape') {
        const close = Array.from(overlay.querySelectorAll<HTMLButtonElement>('button')).find(
          (button) =>
            button.dataset.dialogClose === 'true' ||
            /^(取消|关闭|Cancel)$/.test(button.textContent?.trim() || '')
        )
        if (close && !close.disabled) {
          event.preventDefault()
          close.click()
        }
      }
      if (event.key === 'Tab') {
        const focusable = Array.from(
          overlay.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'
          )
        ).filter((element) => element.getClientRects().length > 0)
        const first = focusable[0],
          last = focusable.at(-1)
        if (!first || !last) return
        if (
          !overlay.contains(document.activeElement) ||
          (event.shiftKey && document.activeElement === first)
        ) {
          event.preventDefault()
          ;(event.shiftKey ? last : first).focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    const observer = new MutationObserver(observe)
    observer.observe(document.body, { childList: true, subtree: true })
    document.addEventListener('keydown', keyboard)
    observe()
    return () => {
      observer.disconnect()
      document.removeEventListener('keydown', keyboard)
    }
  }, [])
}

function HomeSectionContent({
  section,
  modes,
  activeModeId,
  onModesChanged,
  active,
  theme,
  setTheme
}: {
  section: WorkspaceSection
  modes: ReplyMode[]
  activeModeId: string
  onModesChanged: () => void
  active: boolean
  theme: 'dark' | 'light'
  setTheme: (theme: 'dark' | 'light') => void
}): React.JSX.Element {
  const { locale, setLocale } = useI18n()
  return (
    <div className="workspace-feature-content">
      {section === 'objects' ? (
        <ObjectUsersPanel
          modes={modes}
          activeModeId={activeModeId}
          onModesChanged={onModesChanged}
        />
      ) : section === 'knowledge' ? (
        <KnowledgePanel active={active} modes={modes} activeModeId={activeModeId} />
      ) : section === 'memory' ? (
        <MemoryWindow />
      ) : section === 'enterprise' ? (
        <EnterpriseConnection />
      ) : section === 'base' ? (
        <SettingsPanel
          active={active}
          theme={theme}
          setTheme={setTheme}
          locale={locale}
          setLocale={setLocale}
        />
      ) : section === 'model' ? (
        <ModelConfigPanel active={active} />
      ) : (
        <AgentPanel />
      )}
    </div>
  )
}

function HomeConfiguration({
  onOpenSection
}: {
  onOpenSection: (section: WorkspaceSection) => void
}): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings>()
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [failed, setFailed] = useState(false)
  const [editingModel, setEditingModel] = useState<ModelConfig | null | undefined>(undefined)
  const load = useCallback(async (): Promise<void> => {
    try {
      const value = (await window.electron?.invoke('settings:getAll')) as AppSettings | undefined
      if (value) setSettings(value)
    } catch {
      setFailed(true)
      setFeedback('配置读取失败，请重试。')
    }
  }, [])
  useEffect(() => {
    void load()
    const cleanup = window.electron?.on('settings:changed', () => {
      void load()
    })
    const refresh = (): void => {
      void load()
    }
    window.addEventListener('autoreply:home-refresh', refresh)
    return () => {
      cleanup?.()
      window.removeEventListener('autoreply:home-refresh', refresh)
    }
  }, [load])
  const save = async (patch: Partial<AppSettings>): Promise<void> => {
    if (busy || !settings) return
    setBusy(true)
    setFeedback('')
    setFailed(false)
    try {
      const result = await window.electron?.invoke('settings:set', patch)
      if (!result?.success) throw new Error('save_failed')
      await load()
      setFeedback('已保存')
    } catch {
      setFailed(true)
      setFeedback('未能保存，请重试。')
    } finally {
      setBusy(false)
    }
  }
  const test = async (id: string): Promise<void> => {
    if (!id || busy) return
    setBusy(true)
    setFeedback('正在测试连接…')
    setFailed(false)
    try {
      const result = await window.electron?.invoke('model:testConnection', id)
      setFailed(!result?.success)
      setFeedback(
        result?.success ? '连接测试成功' : `连接失败：${result?.error || '请检查模型配置'}`
      )
    } catch {
      setFailed(true)
      setFeedback('连接测试失败，请重试。')
    } finally {
      setBusy(false)
    }
  }
  const disabled = busy || !settings
  const visionId = settings?.globalVisionModelId || ''
  const replyId = settings?.globalReplyModelId || ''
  return (
    <section className="workspace-panel home-config-panel" aria-labelledby="home-config-heading">
      <div className="panel-heading">
        <div>
          <h3 id="home-config-heading">常用配置</h3>
          <span className="panel-description">直接修改，自动保存</span>
        </div>
        <button className="btn btn-text" onClick={() => onOpenSection('model')}>
          管理模型
        </button>
      </div>
      <div className="home-config-pair">
        <div>
          <label className="form-label">个人回复对象</label>
          <p>Windows 个人微信 · 企业规则在企业连接页配置</p>
        </div>
      </div>

      {(['vision', 'reply'] as const).map((purpose) => {
        const id = purpose === 'vision' ? visionId : replyId
        return (
          <div className="home-config-field" key={purpose}>
            <div className="panel-label-row">
              <label className="form-label" htmlFor={`home-model-${purpose}`}>
                {purpose === 'vision' ? '视觉模型' : '回复模型'}
              </label>
              <button
                className="btn btn-text"
                disabled={busy}
                onClick={() =>
                  setEditingModel(settings?.models.find((model) => model.id === id) || null)
                }
              >
                {id ? '编辑' : '添加'}
              </button>
            </div>
            <div className="home-model-select">
              <select
                id={`home-model-${purpose}`}
                className="form-input"
                value={id}
                disabled={disabled}
                onChange={(event) =>
                  void save(
                    purpose === 'vision'
                      ? { globalVisionModelId: event.target.value }
                      : { globalReplyModelId: event.target.value }
                  )
                }
              >
                <option value="">
                  {purpose === 'vision' ? '请选择视觉模型' : '请选择回复模型'}
                </option>
                {(settings?.models || [])
                  .filter((model) =>
                    (model.capabilities || []).includes(purpose === 'vision' ? 'vision' : 'text')
                  )
                  .map((model) => (
                    <option value={model.id} key={model.id}>
                      {model.name}
                    </option>
                  ))}
              </select>
              <button
                className="btn btn-secondary btn-sm"
                disabled={!id || disabled}
                onClick={() => void test(id)}
              >
                测试
              </button>
            </div>
          </div>
        )
      })}
      <div className="home-global-auto">
        <div>
          <label htmlFor="home-global-auto">全局自动回复</label>
          <small>未匹配特定对象时使用</small>
        </div>
        <label className="toggle-switch">
          <input
            id="home-global-auto"
            type="checkbox"
            checked={settings?.globalAutoReply || false}
            disabled={disabled}
            onChange={(event) => void save({ globalAutoReply: event.target.checked })}
          />
          <span className="toggle-slider" />
        </label>
      </div>
      <div
        className={`home-config-feedback ${failed ? 'error' : ''}`}
        role="status"
        aria-live="polite"
      >
        {feedback || (busy ? '保存中…' : !settings ? '正在读取配置…' : '配置将在后续处理时使用')}
        {failed && (
          <button
            className="btn btn-text"
            onClick={() => {
              setFeedback('')
              setFailed(false)
              void load()
            }}
          >
            重新读取
          </button>
        )}
      </div>
      {editingModel !== undefined && (
        <ModelEditModal
          model={editingModel}
          onClose={() => setEditingModel(undefined)}
          onSaved={() => {
            setEditingModel(undefined)
            void load()
          }}
        />
      )}
    </section>
  )
}

function HomeModeRules({
  mode,
  onSaved
}: {
  mode: ReplyMode
  onSaved: () => void
}): React.JSX.Element {
  const [prompt, setPrompt] = useState(mode.prompt)
  const [prefix, setPrefix] = useState(mode.unifiedPrefix)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const original = useRef(mode)
  useEffect(() => {
    const previous = original.current
    if (mode.prompt === previous.prompt && mode.unifiedPrefix === previous.unifiedPrefix) return
    if (prompt === previous.prompt && prefix === previous.unifiedPrefix) {
      setPrompt(mode.prompt)
      setPrefix(mode.unifiedPrefix)
    }
    original.current = mode
  }, [mode, prompt, prefix])
  const dirty = prompt !== mode.prompt || prefix !== mode.unifiedPrefix
  const save = async (): Promise<void> => {
    if (busy) return
    if (!prompt.trim()) {
      setFeedback('请填写回复规则。')
      return
    }
    setBusy(true)
    setFeedback('')
    try {
      const result = await window.electron?.invoke('mode:update', mode.id, {
        prompt: prompt.trim(),
        unifiedPrefix: prefix,
        sentimentEnabled: false,
        ...(!mode.enabled ? { enabled: true } : {})
      })
      if (!result?.success) throw new Error('save_failed')
      setPrompt(prompt.trim())
      onSaved()
      setFeedback('规则已保存')
    } catch {
      setFeedback('未能保存，填写的内容已保留，请重试。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="workspace-panel home-rules-panel" aria-labelledby="home-rules-heading">
      <div className="panel-heading">
        <div>
          <h3 id="home-rules-heading">回复规则</h3>
          <span className="panel-description">通用规则 · 对象用户可设置专属要求</span>
        </div>
        <span className="home-save-note">
          {dirty ? '有未保存修改' : mode.enabled ? '已保存' : '规则已暂停'}
        </span>
      </div>
      <label className="form-label" htmlFor="home-mode-prompt">
        告诉 AI 如何回复
      </label>
      <textarea
        className="form-input"
        id="home-mode-prompt"
        value={prompt}
        onChange={(event) => {
          setPrompt(event.target.value)
          setFeedback('')
        }}
        rows={5}
        maxLength={32000}
        placeholder="例如：语气专业友好，回答简洁；根据知识库回复，不确定时先核实。"
      />
      {window.agentRuntime && (
        <p className="form-hint">知识试答使用此处规则；企业自动回复使用后台已发布并同步的规则。</p>
      )}
      <div className="home-prefix">
        <label className="form-label" htmlFor="home-mode-prefix">
          统一开头 <span>可选</span>
        </label>
        <input
          className="form-input"
          id="home-mode-prefix"
          value={prefix}
          onChange={(event) => {
            setPrefix(event.target.value)
            setFeedback('')
          }}
          placeholder="例如：[自动回复]"
        />
      </div>
      <div className="home-rule-bottom">
        <button
          className="btn btn-primary btn-sm"
          disabled={busy || (!dirty && mode.enabled)}
          onClick={() => void save()}
        >
          {busy ? '保存中…' : mode.enabled ? '保存规则' : '保存并启用规则'}
        </button>
      </div>
      <p className="home-rule-feedback" role="status">
        {feedback || (dirty ? '修改后点击“保存规则”生效' : '')}
      </p>
    </section>
  )
}

function Toast(): React.JSX.Element {
  const [visible, setVisible] = useState(false)
  const [message, setMessage] = useState('')
  const [type, setType] = useState<'success' | 'error'>('success')
  const timerRef = useRef<number | undefined>(undefined)

  const present = useCallback(({ message, type, duration }: ToastNotification): void => {
    setMessage(message)
    setType(type)
    setVisible(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setVisible(false), duration ?? 2500)
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeToast(present)
    return () => {
      unsubscribe()
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [present])

  return <div className={`toast ${type} ${visible ? 'show' : ''}`}>{message}</div>
}

export default App
