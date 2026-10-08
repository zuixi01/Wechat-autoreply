import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  protectPrivateDirectory,
  verifyPrivatePaths
} from '../../src/core/persistence/private-backup-directory'
const roots: string[] = []
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})
describe('private backup directory permissions', () => {
  it.runIf(process.platform === 'win32')(
    'protects a current-owner Modify directory without requesting ownership changes',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'autoreply-private-modify-'))
      roots.push(root)
      const program = `try {
      $ErrorActionPreference='Stop'
      [Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
      $taskInput=[Console]::In.ReadToEnd() | ConvertFrom-Json
      $taskSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
      $taskAcl=[Security.AccessControl.DirectorySecurity]::new()
      $taskAcl.SetAccessRuleProtection($true,$false)
      $taskAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($taskSid,[Security.AccessControl.FileSystemRights]::Modify,[Security.AccessControl.InheritanceFlags]3,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
      $taskAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($taskSid,[Security.AccessControl.FileSystemRights]::TakeOwnership,[Security.AccessControl.AccessControlType]::Deny))
      $taskAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]3,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
      [IO.Directory]::SetAccessControl($taskInput.path,$taskAcl)
      if ([IO.Directory]::GetAccessControl($taskInput.path).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $taskSid.Value) { throw 'owner_mismatch' }
      $taskOld=[Security.AccessControl.DirectorySecurity]::new()
      $taskOld.SetOwner($taskSid)
      $taskOld.SetAccessRuleProtection($true,$false)
      $taskOld.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($taskSid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
      $taskRejected=$false
      try { [IO.Directory]::SetAccessControl($taskInput.path,$taskOld) } catch { $taskRejected=$true }
      if (!$taskRejected) { throw 'old_reset_not_rejected' }
      exit 0
    } catch { exit 1 }`
      await new Promise<void>((done, reject) => {
        const child = execFile(
          join(
            process.env.SystemRoot ?? 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe'
          ),
          [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(program, 'utf16le').toString('base64')
          ],
          { windowsHide: true, timeout: 3000 },
          (error) => (error ? reject(error) : done())
        )
        child.stdin?.end(JSON.stringify({ path: root }))
      })
      await protectPrivateDirectory(root)
      writeFileSync(join(root, 'fixture.json'), '{}')
      await expect(verifyPrivatePaths(root, [join(root, 'fixture.json')])).resolves.toBeUndefined()
    }
  )
  it('sets owner-only permissions before storing bytes and verifies inherited child access', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreply-private-'))
    roots.push(root)
    const backup = join(root, 'backup')
    mkdirSync(backup)
    await protectPrivateDirectory(backup)
    writeFileSync(join(backup, 'fixture.json'), '{}')
    await expect(
      verifyPrivatePaths(backup, [join(backup, 'fixture.json')])
    ).resolves.toBeUndefined()
  })
  it('rejects an unprotected inherited directory without changing it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreply-public-'))
    roots.push(root)
    const child = join(root, 'inherited')
    mkdirSync(child, { mode: 0o755 })
    writeFileSync(join(child, 'fixture.json'), '{}')
    await expect(verifyPrivatePaths(child, [join(child, 'fixture.json')])).rejects.toThrow(
      'private_backup_permissions_invalid'
    )
    expect(() => writeFileSync(join(child, 'after.json'), '{}')).not.toThrow()
  })
  it('treats Unicode, apostrophes and shell-looking directory names only as literal paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreply-literal-'))
    roots.push(root)
    const child = join(root, "中文 ' $() ` literal")
    mkdirSync(child)
    await protectPrivateDirectory(child)
    writeFileSync(join(child, 'fixture.json'), '{}')
    await expect(verifyPrivatePaths(child, [join(child, 'fixture.json')])).resolves.toBeUndefined()
  })
  it('rejects an explicitly broadened ACL on a file inside the protected archive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreply-private-tamper-'))
    roots.push(root)
    await protectPrivateDirectory(root)
    const file = join(root, 'fixture.json')
    writeFileSync(file, '{}')
    await verifyPrivatePaths(root, [file])
    if (process.platform === 'win32') {
      const program = `[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $taskInput=[Console]::In.ReadToEnd() | ConvertFrom-Json; $taskAcl=[IO.File]::GetAccessControl($taskInput.path); $taskOther=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'); $taskRule=[Security.AccessControl.FileSystemAccessRule]::new($taskOther,[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow); $taskAcl.AddAccessRule($taskRule); [IO.File]::SetAccessControl($taskInput.path,$taskAcl)`
      await new Promise<void>((done, reject) => {
        const child = execFile(
          join(
            process.env.SystemRoot ?? 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe'
          ),
          [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(program, 'utf16le').toString('base64')
          ],
          { windowsHide: true, timeout: 3000 },
          (error) => (error ? reject(error) : done())
        )
        child.stdin?.end(JSON.stringify({ path: file }))
      })
    } else {
      chmodSync(root, 0o755)
    }
    await expect(verifyPrivatePaths(root, [file])).rejects.toThrow(
      'private_backup_permissions_invalid'
    )
  })
})
