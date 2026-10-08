import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const helperInfo = {
  adapterVersion: '0.2.0',
  commands: ['info', 'listWindows', 'probe'],
  backgroundReadVerified: false,
  nonInterferingSendVerified: false,
  identityVerified: false
}

export async function fixturePackage(adapterVersion: '0.2.0' | '0.3.0' | '0.4.0' = '0.2.0') {
  const root = await mkdtemp(join(tmpdir(), 'autoreply-native-'))
  for (const path of [
    'WindowsAdapter.exe',
    'WindowsAdapter.dll',
    'WindowsAdapter.deps.json',
    'coreclr.dll',
    'hostfxr.dll',
    'hostpolicy.dll',
    'System.Private.CoreLib.dll',
    'UIAutomationClient.dll',
    'UIAutomationTypes.dll'
  ])
    await writeFile(join(root, path), 'fixture')
  await writeFile(
    join(root, 'WindowsAdapter.runtimeconfig.json'),
    JSON.stringify({
      runtimeOptions: {
        tfm: 'net10.0',
        includedFrameworks: [
          { name: 'Microsoft.NETCore.App', version: '10.0.12' },
          { name: 'Microsoft.WindowsDesktop.App', version: '10.0.12' }
        ]
      }
    })
  )
  const pin = await sealPackage(root, adapterVersion)
  return { root, pin }
}
export async function sealPackage(
  root: string,
  adapterVersion: '0.2.0' | '0.3.0' | '0.4.0' = '0.2.0'
) {
  const files = []
  for (const path of (await readdir(root))
    .filter((path) => path !== 'native-manifest.json')
    .sort()) {
    const bytes = await readFile(join(root, path))
    files.push({
      path,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex')
    })
  }
  const bytes = JSON.stringify({
    formatVersion: 1,
    adapterVersion,
    protocolVersion: 1,
    runtime: 'win-x64',
    deployment: 'self-contained',
    entrypoint: 'WindowsAdapter.exe',
    files
  })
  await writeFile(join(root, 'native-manifest.json'), bytes)
  return createHash('sha256').update(bytes).digest('hex')
}
