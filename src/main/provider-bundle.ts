import { app } from 'electron'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ProviderAdapter, ProviderEvent, ProviderInput } from '../core/session-types'
import { publishedProvider, verifyPublishedProvider } from './services/provider-package'

export const BUILTIN_DOUBAO_PROVIDER_ID = 'volcengine-ark'

/**
 * 内置 doubao（火山方舟）provider 的资源目录。
 * 打包后 resources/** 会经 asarUnpack，落到 app.asar.unpacked/resources/ 下。
 */
function getBuiltinProviderDir(id: string): string {
  const root = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : app.getAppPath()
  return path.join(root, 'resources', 'providers', id)
}

export type ProviderSchemaField =
  | {
      type: 'string' | 'password'
      title: string
      default?: string
    }
  | {
      type: 'select'
      title: string
      default?: string
      enum: string[]
    }
  | {
      type: 'boolean'
      title: string
      default?: boolean
    }

export interface ProviderConfigSchema {
  type: 'object'
  properties: Record<string, ProviderSchemaField>
  required?: string[]
}

export interface ProviderBundleManifest {
  apiVersion: 1
  id: string
  name: string
  version: string
  entry: string
  moduleType?: 'module' | 'commonjs'
  capabilities: ['chat']
  configSchema: ProviderConfigSchema
}

export interface InstalledProviderInfo {
  id: string
  name: string
  version: string
  entryFile: string
  installedAt: string
}

export interface ProviderInstallResult {
  installed: InstalledProviderInfo
  manifest: ProviderBundleManifest
}

interface ProviderBundleModule {
  manifest?: { id?: string; apiVersion?: number }
  createProvider?: (context: ProviderBundleContext) => {
    run(input: ProviderInput): AsyncIterable<ProviderEvent>
  }
  default?:
    | {
        createProvider?: (context: ProviderBundleContext) => {
          run(input: ProviderInput): AsyncIterable<ProviderEvent>
        }
      }
    | ((context: ProviderBundleContext) => {
        run(input: ProviderInput): AsyncIterable<ProviderEvent>
      })
}

export interface ProviderBundleContext {
  providerConfig: Record<string, unknown>
  host: {
    log(message: string): void
    platform: string
    appVersion: string
  }
}

export class BundleProviderAdapter implements ProviderAdapter {
  constructor(
    private readonly instance: { run(input: ProviderInput): AsyncIterable<ProviderEvent> },
    private readonly manifest: ProviderBundleManifest
  ) {}

  async *run(input: ProviderInput): AsyncIterable<ProviderEvent> {
    for await (const event of this.instance.run(input)) {
      if (this.isProviderEvent(event)) {
        yield event
      } else {
        yield {
          type: 'error',
          error: `Invalid provider event from ${this.manifest.id}`
        }
        return
      }
    }
  }

  private isProviderEvent(event: unknown): event is ProviderEvent {
    if (!event || typeof event !== 'object') return false
    const item = event as Record<string, unknown>
    switch (item.type) {
      case 'thinking':
      case 'reply_text':
        return typeof item.content === 'string'
      case 'skip':
        return true
      case 'error':
        return typeof item.error === 'string'
      default:
        return false
    }
  }
}

export async function installProviderFromUrl(_manifestUrl: string): Promise<ProviderInstallResult> {
  void _manifestUrl
  throw new Error('此版本仅支持随应用发布的聊天服务；请在模型设置中配置接口。')
}

async function verifiedInstalledProvider(installed: InstalledProviderInfo): Promise<{
  manifest: ProviderBundleManifest
  sourceBytes: Buffer
}> {
  try {
    if (!installed || installed.id !== BUILTIN_DOUBAO_PROVIDER_ID) throw new Error('unpublished')
    const expected = publishedProvider(installed.id)
    const root = getBuiltinProviderDir(installed.id)
    if (
      installed.version !== expected.version ||
      typeof installed.entryFile !== 'string' ||
      installed.entryFile !== path.join(root, expected.entry)
    )
      throw new Error('path_mismatch')
    const verified = await verifyPublishedProvider(root, installed.id)
    const manifest = validateManifest(JSON.parse(verified.manifestBytes.toString('utf8')))
    if (
      manifest.id !== expected.id ||
      manifest.version !== expected.version ||
      manifest.entry !== expected.entry ||
      manifest.moduleType !== expected.moduleType
    )
      throw new Error('manifest_mismatch')
    return { manifest, sourceBytes: verified.sourceBytes }
  } catch {
    throw new Error('provider_bundle_untrusted')
  }
}

export async function getInstalledProviderManifest(
  installed: InstalledProviderInfo | null | undefined
): Promise<ProviderBundleManifest | null> {
  if (!installed?.entryFile) return null

  try {
    return (await verifiedInstalledProvider(installed)).manifest
  } catch {
    return null
  }
}

/** 读取内置 doubao 的原始 manifest（保留 apiKey 字段，供调试 / 校验） */
export async function getBuiltinDoubaoManifestRaw(): Promise<ProviderBundleManifest | null> {
  const dir = getBuiltinProviderDir(BUILTIN_DOUBAO_PROVIDER_ID)
  try {
    const expected = publishedProvider(BUILTIN_DOUBAO_PROVIDER_ID)
    return (
      await verifiedInstalledProvider({
        id: expected.id,
        version: expected.version,
        name: '',
        installedAt: '0',
        entryFile: path.join(dir, expected.entry)
      })
    ).manifest
  } catch {
    return null
  }
}

/**
 * 拿到对外暴露的内置 doubao manifest：
 * - 移除 `apiKey` 字段（与视觉密钥共享，不需要用户重复填写）
 * - 同步从 required 列表里移除 apiKey
 */
export async function getBuiltinDoubaoManifestForUi(): Promise<ProviderBundleManifest | null> {
  const raw = await getBuiltinDoubaoManifestRaw()
  if (!raw) return null

  const properties: Record<string, ProviderSchemaField> = {}
  for (const [key, field] of Object.entries(raw.configSchema.properties)) {
    if (key === 'apiKey') continue
    properties[key] = field
  }
  const required = (raw.configSchema.required || []).filter((k) => k !== 'apiKey')

  return {
    ...raw,
    configSchema: {
      type: 'object',
      properties,
      required
    }
  }
}

/** 内置 doubao 的虚拟 installed 描述（用于 provider:getInstalled 的回退） */
export async function getBuiltinDoubaoInstalledInfo(): Promise<InstalledProviderInfo | null> {
  const raw = await getBuiltinDoubaoManifestRaw()
  if (!raw) return null
  const dir = getBuiltinProviderDir(BUILTIN_DOUBAO_PROVIDER_ID)
  return {
    id: raw.id,
    name: raw.name,
    version: raw.version,
    entryFile: path.join(dir, raw.entry),
    installedAt: '0'
  }
}

/** 直接加载内置 doubao provider；调用方负责传入合并好的 config（含 apiKey） */
export async function loadBuiltinDoubaoProvider(
  providerConfig: Record<string, unknown>
): Promise<{ provider: ProviderAdapter; manifest: ProviderBundleManifest }> {
  const installed = await getBuiltinDoubaoInstalledInfo()
  if (!installed) {
    throw new Error('内置 doubao provider 资源缺失')
  }
  return loadInstalledProvider(installed, providerConfig)
}

export function validateProviderConfig(
  manifest: ProviderBundleManifest,
  config: Record<string, unknown>
): { valid: boolean; error?: string } {
  const required = manifest.configSchema.required || []
  for (const key of required) {
    const value = config[key]
    if (value === undefined || value === null || value === '') {
      return { valid: false, error: `缺少必填项: ${key}` }
    }
  }

  for (const [key, field] of Object.entries(manifest.configSchema.properties || {})) {
    const value = config[key]
    if (value === undefined || value === null || value === '') continue

    switch (field.type) {
      case 'string':
      case 'password':
        if (typeof value !== 'string') {
          return { valid: false, error: `${key} 必须是字符串` }
        }
        break
      case 'boolean':
        if (typeof value !== 'boolean') {
          return { valid: false, error: `${key} 必须是布尔值` }
        }
        break
      case 'select':
        if (typeof value !== 'string' || !field.enum.includes(value)) {
          return { valid: false, error: `${key} 必须是有效选项` }
        }
        break
    }
  }

  return { valid: true }
}

export async function loadInstalledProvider(
  installed: InstalledProviderInfo,
  providerConfig: Record<string, unknown>
): Promise<{ provider: ProviderAdapter; manifest: ProviderBundleManifest }> {
  const { manifest, sourceBytes } = await verifiedInstalledProvider(installed)

  const validation = validateProviderConfig(manifest, providerConfig)
  if (!validation.valid) {
    throw new Error(validation.error || '聊天服务配置无效')
  }

  const loaded = await loadProviderBundleModule(sourceBytes)
  const createProvider = resolveCreateProvider(loaded)
  if (typeof createProvider !== 'function') {
    throw new Error(`服务包 ${manifest.id} 未导出 createProvider`)
  }

  const instance = createProvider({
    providerConfig,
    host: {
      log: (message: string) => console.log(`[ProviderBundle:${manifest.id}] ${message}`),
      platform: process.platform,
      appVersion: app.getVersion()
    }
  })

  if (!instance || typeof instance.run !== 'function') {
    throw new Error(`服务包 ${manifest.id} 的 createProvider 返回值无效`)
  }

  return {
    provider: new BundleProviderAdapter(instance, manifest),
    manifest
  }
}

async function loadProviderBundleModule(sourceBytes: Buffer): Promise<ProviderBundleModule> {
  // Execute the exact bytes just verified, without reopening a mutable file.
  // Published bundles must be self-contained ES modules.
  const sourceUrl = `data:text/javascript;base64,${sourceBytes.toString('base64')}#${randomUUID()}`
  try {
    return (await import(/* @vite-ignore */ sourceUrl)) as ProviderBundleModule
  } catch {
    throw new Error('provider_bundle_load_failed')
  }
}

function resolveCreateProvider(loaded: ProviderBundleModule):
  | ((context: ProviderBundleContext) => {
      run(input: ProviderInput): AsyncIterable<ProviderEvent>
    })
  | undefined {
  if (typeof loaded.createProvider === 'function') {
    return loaded.createProvider
  }

  if (
    loaded.default &&
    typeof loaded.default === 'object' &&
    typeof loaded.default.createProvider === 'function'
  ) {
    return loaded.default.createProvider
  }

  if (typeof loaded.default === 'function') {
    return loaded.default
  }

  return undefined
}

const fieldTitle = z.string().refine((value) => value.trim().length > 0)
const providerField = z.union([
  z.object({
    type: z.enum(['string', 'password']),
    title: fieldTitle,
    default: z.string().optional()
  }),
  z.object({
    type: z.literal('select'),
    title: fieldTitle,
    default: z.string().optional(),
    enum: z.array(z.string())
  }),
  z.object({ type: z.literal('boolean'), title: fieldTitle, default: z.boolean().optional() })
])
const providerManifestSchema = z.object({
  apiVersion: z.literal(1),
  id: fieldTitle,
  name: fieldTitle,
  version: fieldTitle,
  entry: fieldTitle,
  moduleType: z.enum(['module', 'commonjs']).optional(),
  capabilities: z.tuple([z.literal('chat')]),
  configSchema: z.object({
    type: z.literal('object'),
    properties: z.record(z.string(), providerField),
    required: z.array(z.string()).default([])
  })
})
function validateManifest(input: unknown): ProviderBundleManifest {
  const result = providerManifestSchema.safeParse(input)
  if (!result.success) throw new Error('聊天服务配置清单无效')
  return result.data
}
