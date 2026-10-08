import { createRequire } from 'node:module'
import { readFile, stat } from 'node:fs/promises'
import yaml from 'js-yaml'

const require = createRequire(import.meta.url)
const config = yaml.load(
  await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8')
)
const windows = require('app-builder-lib/out/toolsets/windows.js')
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Node JavaScript preflight.
async function requiredPath(path, directory = false) {
  const info = await stat(path)
  if (directory ? !info.isDirectory() : !info.isFile())
    throw new Error('windows_dev_build_installer_tool_invalid')
}
const tools = [
  [
    '7zip',
    async () =>
      await requiredPath(await require('app-builder-lib/out/toolsets/7zip.js').getPath7za())
  ],
  [
    'nsis',
    async () =>
      await requiredPath(
        (await windows.getMakeNsisPath(config.toolsets?.nsis, config.nsis?.customNsisBinary)).path
      )
  ],
  [
    'nsis-plugins',
    async () =>
      await requiredPath(
        await windows.getNsisPluginsPath(config.toolsets?.nsis, config.nsis?.customNsisResources),
        true
      )
  ]
]
const results = await Promise.allSettled(tools.map(([, prepare]) => prepare()))
let failed = false
for (const [index, result] of results.entries()) {
  console.log(JSON.stringify({ tool: tools[index][0], prepared: result.status === 'fulfilled' }))
  if (result.status === 'rejected') failed = true
}
if (failed) throw new Error('windows_dev_build_installer_tools_unavailable')
