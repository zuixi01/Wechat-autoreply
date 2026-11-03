#requires -Version 7.0
# Windows CI test identity adapter. Only the two fixed synthetic suites may run.
# Only a duplicated primary token is changed; the caller token is opened without
# TOKEN_ADJUST_DEFAULT. No privilege is enabled and no filesystem/desktop ACL is set.
# Official references:
# https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_owner
# https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-settokeninformation
# https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-duplicatetokenex
# https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithtokenw
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('preflight', 'verify')][string] $Suite,
  [string] $NodeExe = (Get-Command node -CommandType Application -ErrorAction Stop).Source
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
$taskNode = (Resolve-Path -LiteralPath $NodeExe).ProviderPath
if (!(Test-Path -LiteralPath $taskNode -PathType Leaf) -or
    [IO.Path]::GetFileName($taskNode) -ne 'node.exe') {
  throw 'owner_launcher_node_path_invalid'
}
$taskChild = Join-Path $PSScriptRoot 'windows-test-child.mjs'
if (!(Test-Path -LiteralPath $taskChild -PathType Leaf)) {
  throw 'owner_launcher_child_missing'
}
$taskRunId = [guid]::NewGuid().ToString()
$taskProgram = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class AutoreplyWindowsTestLauncher
{
    const uint TOKEN_ASSIGN_PRIMARY = 0x0001;
    const uint TOKEN_DUPLICATE = 0x0002;
    const uint TOKEN_QUERY = 0x0008;
    const uint TOKEN_ADJUST_DEFAULT = 0x0080;
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const int TokenUser = 1;
    const int TokenOwner = 4;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars;
        public uint dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr source, uint access, IntPtr attributes, int level, int type, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr buffer, int size, out int needed);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int kind, IntPtr buffer, int size);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool EqualSid(IntPtr left, IntPtr right);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessWithTokenW(IntPtr token, uint logonFlags, string application,
        StringBuilder commandLine, uint flags, IntPtr environment, string directory,
        ref STARTUPINFO startup, out PROCESS_INFORMATION process);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetUserObjectInformationW(IntPtr handle, int kind, IntPtr buffer, uint size, out uint needed);

    static Exception Failure(string stage)
    {
        // Numeric Win32 status only; never include a token, SID or environment.
        return new InvalidOperationException(stage + "_win32_" + Marshal.GetLastWin32Error());
    }

    public static string[] EnvironmentNames()
    {
        return new string[] {
            "PATH", "SystemRoot", "SystemDrive", "windir", "COMSPEC", "PATHEXT",
            "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH",
            "TMP", "TEMP", "CI", "GITHUB_ACTIONS", "OS", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
            "DOTNET_ROOT", "DOTNET_ROOT_X64", "DOTNET_ROOT_X86", "DOTNET_ROOT(x86)",
            "RUNNER_TRACKING_ID"
        };
    }

    static IntPtr EnvironmentBlock()
    {
        // Forward only fixed non-secret runtime and cancellation-tracking fields.
        // No enumeration, logging, disk persistence or changes to the caller environment.
        string[] names = EnvironmentNames();
        Array.Sort(names, StringComparer.OrdinalIgnoreCase);
        StringBuilder block = new StringBuilder();
        foreach (string name in names)
        {
            string value = Environment.GetEnvironmentVariable(name);
            if (value == null) continue;
            if (value.IndexOf('\0') >= 0)
                throw new InvalidOperationException("test_environment_invalid");
            block.Append(name).Append('=').Append(value).Append('\0');
        }
        block.Append('\0');
        return Marshal.StringToHGlobalUni(block.ToString());
    }

    static IntPtr Information(IntPtr token, int kind)
    {
        int needed;
        GetTokenInformation(token, kind, IntPtr.Zero, 0, out needed);
        if (needed <= 0) throw Failure("token_information_size");
        IntPtr buffer = Marshal.AllocHGlobal(needed);
        if (!GetTokenInformation(token, kind, buffer, needed, out needed))
        {
            Marshal.FreeHGlobal(buffer);
            throw Failure("token_information");
        }
        return buffer;
    }

    static bool OwnerMatchesUser(IntPtr token)
    {
        IntPtr user = IntPtr.Zero, owner = IntPtr.Zero;
        try
        {
            user = Information(token, TokenUser);
            owner = Information(token, TokenOwner);
            return EqualSid(Marshal.ReadIntPtr(user), Marshal.ReadIntPtr(owner));
        }
        finally
        {
            if (owner != IntPtr.Zero) Marshal.FreeHGlobal(owner);
            if (user != IntPtr.Zero) Marshal.FreeHGlobal(user);
        }
    }

    static string ObjectName(IntPtr handle)
    {
        uint needed;
        if (handle == IntPtr.Zero) throw Failure("desktop_handle");
        GetUserObjectInformationW(handle, 2, IntPtr.Zero, 0, out needed);
        if (needed == 0) throw Failure("desktop_name_size");
        IntPtr buffer = Marshal.AllocHGlobal(checked((int)needed));
        try
        {
            if (!GetUserObjectInformationW(handle, 2, buffer, needed, out needed))
                throw Failure("desktop_name");
            return Marshal.PtrToStringUni(buffer);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    static string QuoteFile(string path)
    {
        if (path.IndexOf('"') >= 0 || path.IndexOf('\0') >= 0 || path.EndsWith("\\"))
            throw new InvalidOperationException("owner_launcher_path_invalid");
        return "\"" + path + "\"";
    }

    public static int Run(string node, string script, string directory, string suite, string id)
    {
        IntPtr source = IntPtr.Zero, isolated = IntPtr.Zero, childToken = IntPtr.Zero;
        IntPtr originalOwner = IntPtr.Zero, currentOwner = IntPtr.Zero;
        IntPtr user = IntPtr.Zero, ownerSetting = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool resumed = false;
        try
        {
            // The source handle cannot change its token defaults.
            if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, out source))
                throw Failure("open_source_token");
            originalOwner = Information(source, TokenOwner);
            if (!DuplicateTokenEx(source, TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY |
                    TOKEN_ADJUST_DEFAULT, IntPtr.Zero, 2, 1, out isolated))
                throw Failure("duplicate_primary_token");
            user = Information(isolated, TokenUser);
            ownerSetting = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(ownerSetting, Marshal.ReadIntPtr(user));
            if (!SetTokenInformation(isolated, TokenOwner, ownerSetting, IntPtr.Size))
                throw Failure("set_isolated_default_owner");
            if (!OwnerMatchesUser(isolated))
                throw new InvalidOperationException("isolated_owner_verification_failed");
            string command = QuoteFile(node) + " " + QuoteFile(script) + " " + suite + " " + id;
            if (command.Length >= 1024)
                throw new InvalidOperationException("owner_launcher_command_too_long");
            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = 1; // STARTF_USESHOWWINDOW
            startup.wShowWindow = 0;
            // Explicitly select the existing desktop; do not ask the API to add
            // permission to an automatically inherited desktop/window station.
            startup.lpDesktop = ObjectName(GetProcessWindowStation()) + "\\" +
                ObjectName(GetThreadDesktop(GetCurrentThreadId()));
            environment = EnvironmentBlock();
            if (!CreateProcessWithTokenW(isolated, 0, node, new StringBuilder(command),
                    CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                    environment, directory, ref startup, out process))
                throw Failure("create_isolated_test_process");
            if (!OpenProcessToken(process.hProcess, TOKEN_QUERY, out childToken))
                throw Failure("open_child_token");
            if (!OwnerMatchesUser(childToken))
                throw new InvalidOperationException("child_owner_verification_failed");
            currentOwner = Information(source, TokenOwner);
            if (!EqualSid(Marshal.ReadIntPtr(originalOwner), Marshal.ReadIntPtr(currentOwner)))
                throw new InvalidOperationException("caller_owner_changed");
            Console.WriteLine("{\"scope\":\"duplicated_primary_token\",\"ownerMatchesUser\":true," +
                "\"callerTokenUnchanged\":true,\"pid\":" + process.dwProcessId + "}");
            if (ResumeThread(process.hThread) == UInt32.MaxValue)
                throw Failure("resume_test_process");
            resumed = true;
            if (WaitForSingleObject(process.hProcess, UInt32.MaxValue) != 0)
                throw Failure("wait_test_process");
            uint code;
            if (!GetExitCodeProcess(process.hProcess, out code)) throw Failure("test_exit_code");
            return unchecked((int)code);
        }
        finally
        {
            // A failed preflight must not leave a suspended process behind.
            // Never terminate an unrelated process or alter any directory ACL.
            if (!resumed && process.hProcess != IntPtr.Zero)
            {
                if (!TerminateProcess(process.hProcess, 1))
                    Console.Error.WriteLine("suspended_child_cleanup_failed_win32_" + Marshal.GetLastWin32Error());
                else if (WaitForSingleObject(process.hProcess, 10000) != 0)
                    Console.Error.WriteLine("suspended_child_cleanup_unconfirmed");
            }
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (childToken != IntPtr.Zero) CloseHandle(childToken);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            if (ownerSetting != IntPtr.Zero) Marshal.FreeHGlobal(ownerSetting);
            if (user != IntPtr.Zero) Marshal.FreeHGlobal(user);
            if (currentOwner != IntPtr.Zero) Marshal.FreeHGlobal(currentOwner);
            if (originalOwner != IntPtr.Zero) Marshal.FreeHGlobal(originalOwner);
            if (isolated != IntPtr.Zero) CloseHandle(isolated);
            if (source != IntPtr.Zero) CloseHandle(source);
        }
    }
}
'@
try {
  if (-not ('AutoreplyWindowsTestLauncher' -as [type])) {
    Add-Type -TypeDefinition $taskProgram -Language CSharp
  }
  $taskIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try {
    $taskDirect = $taskIdentity.Owner.Equals($taskIdentity.User)
  } finally {
    $taskIdentity.Dispose()
  }
  if ($taskDirect) {
    Write-Output 'Windows test scope: current-user default owner.'
    $taskStart = [Diagnostics.ProcessStartInfo]::new()
    $taskStart.FileName = $taskNode
    $taskStart.WorkingDirectory = $taskRoot
    $taskStart.UseShellExecute = $false
    $taskStart.CreateNoWindow = $true
    $taskStart.RedirectStandardOutput = $true
    $taskStart.RedirectStandardError = $true
    $taskStart.ArgumentList.Add($taskChild)
    $taskStart.ArgumentList.Add($Suite)
    $taskStart.ArgumentList.Add($taskRunId)
    $taskStart.Environment.Clear()
    foreach ($taskName in [AutoreplyWindowsTestLauncher]::EnvironmentNames()) {
      $taskValue = [Environment]::GetEnvironmentVariable($taskName)
      if ($null -ne $taskValue) { $taskStart.Environment[$taskName] = $taskValue }
    }
    $taskProcess = [Diagnostics.Process]::new()
    try {
      $taskProcess.StartInfo = $taskStart
      [void]$taskProcess.Start()
      $taskStdout = $taskProcess.StandardOutput.ReadToEndAsync()
      $taskStderr = $taskProcess.StandardError.ReadToEndAsync()
      $taskProcess.WaitForExit()
      $taskExit = $taskProcess.ExitCode
      Write-Output ($taskStdout.GetAwaiter().GetResult())
      Write-Output ($taskStderr.GetAwaiter().GetResult())
    } finally {
      $taskProcess.Dispose()
    }
  } else {
    $taskExit = [AutoreplyWindowsTestLauncher]::Run($taskNode, $taskChild, $taskRoot, $Suite, $taskRunId)
  }
  $taskReport = Join-Path $taskRoot ('.local/reports/ci-tests/' + $taskRunId)
  $taskLog = Join-Path $taskReport 'output.log'
  if (Test-Path -LiteralPath $taskLog -PathType Leaf) {
    Get-Content -LiteralPath $taskLog
  } else {
    Write-Output 'Windows test child did not produce a test log.'
  }
  [pscustomobject]@{ runId = $taskRunId; suite = $Suite; exitCode = $taskExit } | ConvertTo-Json -Compress
  exit $taskExit
} catch {
  # Exception messages contain fixed stage names and optional numeric Win32 codes.
  # Avoid PowerShell's default detailed exception dump.
  [Console]::Error.WriteLine('owner_launcher_failed: ' + $_.Exception.GetBaseException().Message)
  exit 1
}
