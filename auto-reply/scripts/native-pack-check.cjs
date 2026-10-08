/* Packaging-only hook; never executes or enumerates a chat client. */
/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder loads its Windows hooks through CommonJS. */
const { readFile } = require('node:fs/promises')
const { join } = require('node:path')
const { extractFile, listPackage } = require('@electron/asar')
const { assertPackageInventory } = require('./package-inventory-policy.cjs')
const { Arch } = require('builder-util')
require('tsx/cjs')
const { verifyNativePackage } = require('../src/core/adapters/native-package.ts')
const { verifyProviderContents } = require('../src/main/services/provider-package.ts')

module.exports = async function checkNative(context, afterPack) {
  if (context.electronPlatformName !== 'win32') return
  if (context.arch !== Arch.x64) throw new Error('native_adapter_platform_unsupported')
  if (afterPack) assertPackageInventory(listPackage(join(context.appOutDir, 'resources/app.asar')))
  const releaseId = process.env.AUTOREPLY_RELEASE_BUILD_ID
  if (releaseId && !/^[a-f0-9-]{36}$/.test(releaseId)) throw new Error('release_build_id_invalid')
  const releaseRoot = releaseId
    ? join(context.packager.projectDir, '.local', 'release-build', releaseId)
    : context.packager.projectDir
  const source = afterPack
    ? extractFile(
        join(context.appOutDir, 'resources', 'app.asar'),
        join('out', 'main', 'native-adapter.js')
      ).toString('utf8')
    : await readFile(join(releaseRoot, 'out/main/native-adapter.js'), 'utf8')
  const pin = source.match(/manifestSha256:\s*["']([a-f0-9]{64})["']/)?.[1]
  if (!pin) throw new Error('native_adapter_build_pin_missing')
  await verifyNativePackage(
    afterPack
      ? join(context.appOutDir, 'resources', 'native', 'windows-x64')
      : releaseId
        ? join(releaseRoot, 'native', 'windows-x64')
        : join(context.packager.projectDir, '.local', 'native', 'windows-x64'),
    pin
  )
  const providerSource = afterPack
    ? extractFile(
        join(context.appOutDir, 'resources/app.asar'),
        join('out/main/provider-package.js')
      ).toString('utf8')
    : await readFile(join(releaseRoot, 'out/main/provider-package.js'), 'utf8')
  const manifestSha256 = providerSource.match(/manifestSha256:\s*["']([a-f0-9]{64})["']/)?.[1]
  const entrySha256 = providerSource.match(/entrySha256:\s*["']([a-f0-9]{64})["']/)?.[1]
  if (!manifestSha256 || !entrySha256) throw new Error('provider_bundle_build_pin_missing')
  await verifyProviderContents(
    afterPack
      ? join(context.appOutDir, 'resources/app.asar.unpacked/resources/providers/volcengine-ark')
      : join(context.packager.projectDir, 'resources/providers/volcengine-ark'),
    {
      id: 'volcengine-ark',
      version: 'compiled',
      entry: 'provider.bundle.js',
      moduleType: 'module',
      manifestSha256,
      entrySha256
    }
  )
}
