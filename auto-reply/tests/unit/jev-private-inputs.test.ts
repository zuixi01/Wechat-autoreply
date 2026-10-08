import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  protectPrivateDirectory,
  verifyPrivatePaths
} from '../../src/core/persistence/private-backup-directory'
import { MAX_PRIVATE_JSON_BYTES } from '../../evals/memory/private-files'
import { readPrivateJevInput, readPrivateJevInputs } from '../../evals/jev/private-inputs'

const fixtureRoot = resolve('.local/testinputs')
let directory: string
beforeAll(async () => {
  await mkdir(fixtureRoot, { recursive: true })
  directory = await mkdtemp(join(fixtureRoot, 'jev-private-reader-'))
  await protectPrivateDirectory(directory)
})
afterAll(async () => {
  if (!directory) return
  const target = resolve(directory),
    part = relative(fixtureRoot, target)
  if (
    !part ||
    isAbsolute(part) ||
    part === '..' ||
    part.startsWith('..' + sep) ||
    !basename(target).startsWith('jev-private-reader-') ||
    (await realpath(target)) !== target
  )
    throw new Error('unsafe_test_cleanup')
  await rm(target, { recursive: true, force: true })
})

async function file(name: string, body: string | Uint8Array): Promise<string> {
  const path = join(directory, name)
  await writeFile(path, body, { mode: 0o600, flag: 'wx' })
  return path
}

async function reopenAfterFailure(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    const before = await readFile(path),
      handle = await open(path, 'r+')
    await handle.close()
    const moved = path + '.reopened'
    await rename(path, moved)
    await rename(moved, path)
    expect(await readFile(path)).toEqual(before)
  }
}

async function grantPublicRead(path: string): Promise<void> {
  if (process.platform !== 'win32') {
    await chmod(path, 0o644)
    return
  }
  // The path enters PowerShell as JSON on stdin, never executable command text.
  const program = `$ErrorActionPreference='Stop'
    $testInput=[Console]::In.ReadToEnd() | ConvertFrom-Json
    $testAcl=[IO.File]::GetAccessControl($testInput.path)
    $testSid=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')
    $testRule=[Security.AccessControl.FileSystemAccessRule]::new($testSid,[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow)
    $testAcl.AddAccessRule($testRule)
    [IO.File]::SetAccessControl($testInput.path,$testAcl)`
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe'
      ),
      ['-NoProfile', '-NonInteractive', '-Command', program],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] }
    )
    let errorText = ''
    child.stderr.on('data', (chunk) => {
      errorText += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`fixture_acl_failed:${errorText}`))
    )
    child.stdin.end(JSON.stringify({ path }))
  })
}

describe('actual private Jev input files (synthetic data, no models)', () => {
  it('round-trips single and ordered batch UTF-8 without overwriting input files', async () => {
    const values = [{ synthetic: '汉字🙂', order: 2 }, ['合成', 1], null],
      paths = await Promise.all(
        values.map((value, i) => file(`ordered-${i}.json`, JSON.stringify(value)))
      )
    await verifyPrivatePaths(directory, paths)
    const originals = await Promise.all(paths.map((path) => readFile(path)))
    expect(await readPrivateJevInput(paths[0])).toEqual(values[0])
    expect(await readPrivateJevInputs([paths[2], paths[0], paths[1]])).toEqual([
      values[2],
      values[0],
      values[1]
    ])
    expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(originals)
  })

  it('enforces exact UTF-8 byte boundaries rather than character counts', async () => {
    const body = JSON.stringify('汉🙂'),
      bytes = Buffer.byteLength(body),
      path = await file('byte-boundary.json', body)
    expect(bytes).toBeGreaterThan(body.length)
    expect(await readPrivateJevInput(path, bytes)).toBe('汉🙂')
    await expect(readPrivateJevInput(path, bytes - 1)).rejects.toThrow()
    expect(await readPrivateJevInputs([path], bytes)).toEqual(['汉🙂'])
    await expect(readPrivateJevInputs([path], bytes - 1)).rejects.toThrow()
    await reopenAfterFailure([path])
  })

  it.each([0, -1, 1.5, NaN, Infinity, MAX_PRIVATE_JSON_BYTES + 1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid byte budgets (%s)',
    async (maximum) => {
      const path = await file(`invalid-budget-${String(maximum)}.json`, '0')
      await expect(readPrivateJevInput(path, maximum)).rejects.toThrow(
        'invalid_private_input_budget'
      )
      await expect(readPrivateJevInputs([path], maximum)).rejects.toThrow(
        'invalid_private_input_budget'
      )
    }
  )

  it('accepts the minimum budget of one byte for a valid JSON value', async () => {
    const path = await file('one-byte.json', '0')
    expect(await readPrivateJevInput(path, 1)).toBe(0)
    expect(await readPrivateJevInputs([path], 1)).toEqual([0])
    expect(await readPrivateJevInput(path, MAX_PRIVATE_JSON_BYTES)).toBe(0)
    expect(await readPrivateJevInputs([path], MAX_PRIVATE_JSON_BYTES)).toEqual([0])
  })

  it('decodes valid multibyte UTF-8 split across a 64 KiB read boundary', async () => {
    const value = 'x'.repeat(65534) + '汉🙂',
      body = JSON.stringify(value),
      path = await file('read-chunk-boundary.json', body),
      bytes = Buffer.byteLength(body)
    // Opening quote plus ASCII prefix places the Chinese character at byte 65535.
    expect(bytes).toBeGreaterThan(64 * 1024)
    expect(await readPrivateJevInput(path, bytes)).toBe(value)
    expect(await readPrivateJevInputs([path], bytes)).toEqual([value])
  })

  it('preserves order across more than 64 input files', async () => {
    const values = Array.from({ length: 67 }, (_, order) => ({ synthetic: true, order })),
      paths = await Promise.all(
        values.map((value, i) =>
          file(`chunk-${String(i).padStart(3, '0')}.json`, JSON.stringify(value))
        )
      )
    const reordered = [...paths.slice(64).reverse(), ...paths.slice(0, 64).reverse()]
    expect(await readPrivateJevInputs(reordered)).toEqual([
      ...values.slice(64).reverse(),
      ...values.slice(0, 64).reverse()
    ])
    await grantPublicRead(paths[0])
    // In this order the unsafe file is in the second batch, after 64 valid files.
    await expect(readPrivateJevInputs(reordered)).rejects.toThrow()
    await reopenAfterFailure([paths[0], paths[64], paths[66]])
  }, 20000)

  it('rejects the whole batch if any file has public permissions, preserving source bytes', async () => {
    const good = await file('acl-good.json', 'synthetic-not-json-yet'),
      bad = await file('acl-public.json', '{"synthetic":"public-fixture"}')
    await grantPublicRead(bad)
    // Permission validation must precede parsing even the first malformed member.
    await expect(readPrivateJevInputs([good, bad])).rejects.toThrow(
      'private_backup_permissions_invalid'
    )
    await expect(readPrivateJevInput(bad)).rejects.toThrow()
    await reopenAfterFailure([good, bad])
  }, 20000)

  it('rejects nonfiles and missing files without returning the preceding valid value', async () => {
    const good = await file('nonfile-good.json', 'true'),
      folder = join(directory, 'nonfile-folder')
    await mkdir(folder)
    await expect(readPrivateJevInputs([good, folder])).rejects.toThrow()
    await expect(readPrivateJevInputs([good, join(directory, 'missing.json')])).rejects.toThrow()
    await reopenAfterFailure([good])
  })

  it('stops parsing on callback failure and releases all opened source files', async () => {
    const paths = await Promise.all(
        [0, 1, 2].map((order) => file(`callback-${order}.json`, JSON.stringify({ order })))
      ),
      seen: number[] = []
    await expect(
      readPrivateJevInputs(paths, 64, (value, index) => {
        seen.push(index)
        if (index === 1) throw new Error('synthetic_parser_rejected')
        return value
      })
    ).rejects.toThrow('synthetic_parser_rejected')
    expect(seen).toEqual([0, 1])
    await reopenAfterFailure(paths)
    expect(await readPrivateJevInputs(paths)).toEqual([{ order: 0 }, { order: 1 }, { order: 2 }])
  })

  it.each([
    ['truncated-json', Buffer.from('{"synthetic":')],
    ['invalid-utf8', Buffer.from([0x22, 0xc3, 0x28, 0x22])],
    ['truncated-utf8', Buffer.from([0x22, 0xe6, 0xb1])]
  ] as const)('rejects an entire batch containing %s', async (name, body) => {
    const good = await file(`${name}-good.json`, '1'),
      bad = await file(`${name}-bad.json`, body)
    await expect(readPrivateJevInput(bad)).rejects.toThrow()
    await expect(readPrivateJevInputs([good, bad])).rejects.toThrow()
    await reopenAfterFailure([good, bad])
  })

  it('rejects junction paths, even when their target is a private regular file', async () => {
    const good = await file('linked-target.json', '{"synthetic":"linked"}'),
      junction = join(directory, 'directory-link')
    await symlink(directory, junction, process.platform === 'win32' ? 'junction' : 'dir')
    const linked = join(junction, basename(good))
    await expect(readPrivateJevInput(linked)).rejects.toThrow()
    await expect(readPrivateJevInputs([good, linked])).rejects.toThrow()
    await reopenAfterFailure([good])
  })

  it('rejects files outside approved private roots before accepting a mixed batch', async () => {
    const good = await file('outside-good.json', 'false')
    // An existing public project file is read-only test input; this fixture creates no public artifact.
    const publicFile = resolve('package.json')
    await expect(readPrivateJevInput(publicFile)).rejects.toThrow()
    await expect(readPrivateJevInputs([good, publicFile])).rejects.toThrow()
    await reopenAfterFailure([good])
  })
})
