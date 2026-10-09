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
const repliesIndex = args.indexOf('--replies')
const replies = repliesIndex >= 0 ? Number(args[repliesIndex + 1]) : 1
const previewIndex = args.indexOf('--pending-preview')
const pendingPreview = previewIndex >= 0 ? args[previewIndex + 1]?.trim() : undefined
if (
  previewIndex >= 0 &&
  (!pendingPreview ||
    pendingPreview.length > 4096 ||
    !args.includes('--reset-baseline') ||
    !args.includes('--current-chat'))
)
  throw new Error('pending_preview_requires_current_chat_reset')
if (!Number.isInteger(replies) || replies < 1 || replies > 10)
  throw new Error('test_replies_invalid')
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
    AUTOREPLY_WECHAT_TEST_REPLIES: String(replies),
    AUTOREPLY_WECHAT_TEST_PENDING_PREVIEW: pendingPreview ?? '',
    AUTOREPLY_WECHAT_TEST_RESET_BASELINE: args.includes('--reset-baseline') ? '1' : '0',
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
