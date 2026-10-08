import { WindowsPrivatePermissionWorker } from './windows-private-permissions'
import { chmod, lstat, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

// No caller data is interpolated into executable PowerShell. Paths arrive as JSON on stdin.
const securityProgram = `$ErrorActionPreference='Stop'
  [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
while ($null -ne ($taskLine = [Console]::In.ReadLine())) {
  $taskInput = $null
try {
  $taskInput = $taskLine | ConvertFrom-Json -ErrorAction Stop
  $taskSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $taskSystemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  if ($taskInput.protect) {
    $taskExisting = [IO.Directory]::GetAccessControl($taskInput.root)
    if ($taskExisting.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $taskSid.Value) { throw 'private_owner' }
    $taskSecurity = [Security.AccessControl.DirectorySecurity]::new()
    # Preserve the verified owner. Re-setting it requests WRITE_OWNER even when unchanged.
    # Current ownership permits DACL changes, but does not imply WRITE_OWNER access.
    $taskSecurity.SetAccessRuleProtection($true,$false)
    foreach ($taskIdentity in @($taskSid,$taskSystemSid)) {
      $taskRule = [Security.AccessControl.FileSystemAccessRule]::new($taskIdentity,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]3,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
      $taskSecurity.AddAccessRule($taskRule)
    }
    [IO.Directory]::SetAccessControl($taskInput.root,$taskSecurity)
  }
  $taskRootAcl = [IO.Directory]::GetAccessControl($taskInput.root)
  if (!$taskRootAcl.AreAccessRulesProtected -or $taskRootAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $taskSid.Value) { throw 'private_root' }
  foreach ($taskPath in @($taskInput.root)+@($taskInput.paths)) {
    $taskAcl = if (([IO.File]::GetAttributes($taskPath) -band [IO.FileAttributes]::Directory) -ne 0) { [IO.Directory]::GetAccessControl($taskPath) } else { [IO.File]::GetAccessControl($taskPath) }
    $taskOwnerSid = $taskAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($taskOwnerSid -ne $taskSid.Value -and $taskOwnerSid -ne $taskSystemSid.Value) { throw 'private_owner' }
    $taskUserAllowed = $false
    foreach ($taskRule in $taskAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
      if ($taskRule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
        if ($taskRule.IdentityReference.Value -ne $taskSid.Value -and $taskRule.IdentityReference.Value -ne $taskSystemSid.Value) { throw 'private_rule' }
        if ($taskRule.IdentityReference.Value -eq $taskSid.Value -and ($taskRule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $taskUserAllowed = $true }
      }
    }
    if (!$taskUserAllowed) { throw 'private_owner_access' }
  }
  [Console]::Out.WriteLine((@{ id=$taskInput.id; ok=$true } | ConvertTo-Json -Compress))
} catch {
  [Console]::Out.WriteLine((@{ id=$taskInput.id; ok=$false } | ConvertTo-Json -Compress))
}
}`

const windowsWorker = new WindowsPrivatePermissionWorker(
  join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  ),
  securityProgram
)

/** Terminal standalone-process cleanup only. Reusable hosts keep the worker. */
export function closePrivatePermissionWorker(): void {
  windowsWorker.close()
}

async function checkedRoot(root: string): Promise<string> {
  const path = resolve(root),
    info = await lstat(path),
    canonical = await realpath(path)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform === 'win32'
      ? path.toLowerCase() !== canonical.toLowerCase()
      : path !== canonical)
  )
    throw new Error('private_backup_permissions_invalid')
  return path
}
async function windowsPermissions(root: string, paths: string[], protect: boolean): Promise<void> {
  await windowsWorker.request(root, paths, protect)
}
export async function protectPrivateDirectory(root: string): Promise<void> {
  try {
    const path = await checkedRoot(root)
    if ((await readdir(path)).length !== 0) throw new Error('private_backup_permissions_invalid')
    if (process.platform === 'win32') await windowsPermissions(path, [], true)
    else await chmod(path, 0o700)
  } catch {
    throw new Error('private_backup_permissions_invalid')
  }
}
export async function verifyPrivatePaths(root: string, paths: string[]): Promise<void> {
  try {
    const path = await checkedRoot(root),
      safePaths: string[] = []
    for (const candidate of paths) {
      const absolute = resolve(candidate),
        relation = relative(path, absolute)
      if (
        !relation ||
        isAbsolute(relation) ||
        relation === '..' ||
        relation.startsWith('..' + sep) ||
        resolve(path, relation) !== absolute
      )
        throw new Error('private_backup_permissions_invalid')
      const info = await lstat(absolute),
        canonical = await realpath(absolute)
      if (
        info.isSymbolicLink() ||
        (process.platform === 'win32'
          ? canonical.toLowerCase() !== absolute.toLowerCase()
          : canonical !== absolute)
      )
        throw new Error('private_backup_permissions_invalid')
      safePaths.push(absolute)
    }
    if (process.platform === 'win32') await windowsPermissions(path, safePaths, false)
    else if ((await lstat(path)).mode & 0o077) throw new Error('private_backup_permissions_invalid')
  } catch {
    throw new Error('private_backup_permissions_invalid')
  }
}
