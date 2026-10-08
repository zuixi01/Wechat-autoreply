import { dirname, join } from 'node:path'
import { WindowsBridge } from '../../core/adapters/windows-bridge'

declare const __NATIVE_ADAPTER_MANIFEST_SHA256__: string
declare const __NATIVE_ADAPTER_VERSION__: '0.2.0' | '0.3.0' | '0.4.0' | null
export const nativeAdapterBuildInfo = {
  manifestSha256: __NATIVE_ADAPTER_MANIFEST_SHA256__,
  adapterVersion: __NATIVE_ADAPTER_VERSION__,
  protocolVersion: 1,
  runtime: 'win-x64'
}

/** Private main-process factory: neither an executable path nor capability claims come from IPC. */
export async function createPackagedWindowsBridge(): Promise<WindowsBridge> {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('native_adapter_platform_unsupported')
  const resources = process.resourcesPath ?? join(dirname(process.execPath), 'resources')
  return WindowsBridge.fromPackage(
    join(resources, 'native', 'windows-x64'),
    nativeAdapterBuildInfo.manifestSha256
  )
}
