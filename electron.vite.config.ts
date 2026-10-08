import { resolve } from 'path'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const releaseId = process.env.AUTOREPLY_RELEASE_BUILD_ID
if (releaseId && !/^[a-f0-9-]{36}$/.test(releaseId)) throw new Error('release_build_id_invalid')
const releaseRoot = releaseId ? resolve(__dirname, '.local/release-build', releaseId) : undefined
const outputRoot = releaseRoot ? resolve(releaseRoot, 'out') : resolve(__dirname, 'out')
const nativeManifest = releaseRoot
  ? resolve(releaseRoot, 'native/windows-x64/native-manifest.json')
  : resolve(__dirname, '.local/native/windows-x64/native-manifest.json')
const nativeManifestBytes = existsSync(nativeManifest) ? readFileSync(nativeManifest) : undefined
const nativePin = nativeManifestBytes
  ? createHash('sha256').update(nativeManifestBytes).digest('hex')
  : ''
const nativeVersion: '0.2.0' | '0.3.0' | '0.4.0' | null = nativeManifestBytes
  ? JSON.parse(nativeManifestBytes.toString('utf8')).adapterVersion
  : null
if (nativeManifestBytes && !['0.2.0', '0.3.0', '0.4.0'].includes(nativeVersion ?? ''))
  throw new Error('native_build_version_invalid')
const foregroundExecutable = releaseRoot
  ? resolve(releaseRoot, 'native/foreground/ForegroundWindow.exe')
  : resolve(__dirname, '.local/foreground-native/windows-x64/ForegroundWindow.exe')
const foregroundPin = existsSync(foregroundExecutable)
  ? createHash('sha256').update(readFileSync(foregroundExecutable)).digest('hex')
  : ''
const providerRoot = resolve(__dirname, 'resources/providers/volcengine-ark')
const providerManifestBytes = readFileSync(resolve(providerRoot, 'manifest.json'))
const providerManifest = JSON.parse(providerManifestBytes.toString('utf8'))
if (
  providerManifest.id !== 'volcengine-ark' ||
  providerManifest.entry !== 'provider.bundle.js' ||
  providerManifest.moduleType !== 'module'
)
  throw new Error('published_provider_build_invalid')
const providerTrust = {
  'volcengine-ark': {
    id: providerManifest.id,
    version: providerManifest.version,
    entry: providerManifest.entry,
    moduleType: providerManifest.moduleType,
    manifestSha256: createHash('sha256').update(providerManifestBytes).digest('hex'),
    entrySha256: createHash('sha256')
      .update(readFileSync(resolve(providerRoot, providerManifest.entry)))
      .digest('hex')
  }
}

export default defineConfig({
  main: {
    define: {
      __NATIVE_ADAPTER_MANIFEST_SHA256__: JSON.stringify(nativePin),
      __NATIVE_ADAPTER_VERSION__: JSON.stringify(nativeVersion),
      __FOREGROUND_WINDOW_SHA256__: JSON.stringify(foregroundPin),
      __BUNDLED_PROVIDER_TRUST__: JSON.stringify(providerTrust)
    },
    build: {
      outDir: resolve(outputRoot, 'main'),
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'knowledge-parser': resolve(__dirname, 'src/main/knowledge-parser.ts'),
          'native-adapter': resolve(__dirname, 'src/main/services/native-adapter.ts'),
          'ledger-recovery': resolve(__dirname, 'src/main/services/ledger-recovery.ts'),
          'legacy-migration': resolve(__dirname, 'src/main/services/legacy-migration.ts'),
          'provider-package': resolve(__dirname, 'src/main/services/provider-package.ts'),
          'provider-bundle': resolve(__dirname, 'src/main/provider-bundle.ts')
        }
      }
    }
  },
  preload: { build: { outDir: resolve(outputRoot, 'preload') } },
  renderer: {
    server: { host: '127.0.0.1' },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    build: {
      outDir: resolve(outputRoot, 'renderer'),
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          // Box-select wizard runs in a separate transparent BrowserWindow
          // and loads its own React tree; second entry keeps its bundle isolated.
          overlay: resolve(__dirname, 'src/renderer/overlay.html')
        }
      }
    }
  }
})
