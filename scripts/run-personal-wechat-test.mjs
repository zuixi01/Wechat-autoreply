import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2),
  targetIndex = args.indexOf('--target')
const target = targetIndex >= 0 ? args[targetIndex + 1]?.trim() : undefined
const timeoutIndex = args.indexOf('--timeout')
const waitMs = timeoutIndex >= 0 ? Number(args[timeoutIndex + 1]) : 180000
if (!Number.isInteger(waitMs) || waitMs < 30000 || waitMs > 600000)
  throw new Error('test_timeout_invalid')
if (
  !target ||
  target.length > 128 ||
  Array.from(target).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
)
  throw new Error('Use --target with the exact, authorized WeChat contact name.')
const id = randomUUID(),
  env = {
    ...process.env,
    AUTOREPLY_WECHAT_TEST_TARGET: target,
    AUTOREPLY_WECHAT_TEST_ID: id,
    AUTOREPLY_WECHAT_TEST_TIMEOUT: String(waitMs),
    AUTOREPLY_WECHAT_TEST_CURRENT_CHAT: args.includes('--current-chat') ? '1' : '0'
  }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [join(root, 'scripts', 'personal-wechat-test.cjs')], {
  cwd: root,
  env,
  // This is an interactive real-desktop test. SW_HIDE startup information can
  // suppress Electron's first show and prevent foreground transfer to WeChat.
  windowsHide: false,
  stdio: 'inherit'
})
const timeout = setTimeout(() => child.kill(), waitMs + 120000)
const code = await new Promise((done, reject) => {
  child.once('error', reject)
  child.once('exit', done)
})
clearTimeout(timeout)
const result = JSON.parse(
  await readFile(join(root, '.local', 'reports', 'personal-wechat', id, 'result.json'), 'utf8')
)
console.log(JSON.stringify(result))
if (code !== 0 || !result.passed) process.exitCode = 1
