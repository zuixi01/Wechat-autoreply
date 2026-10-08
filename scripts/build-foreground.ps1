$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskDotnet = Join-Path $taskRoot '.local/toolchain/dotnet/dotnet.exe'
if (-not (Test-Path -LiteralPath $taskDotnet)) { throw 'Missing the project .NET toolchain; see docs/development-environment.md.' }
& $taskDotnet publish (Join-Path $taskRoot 'native/ForegroundWindow/ForegroundWindow.csproj') -c Release -r win-x64 --self-contained true -o (Join-Path $taskRoot '.local/foreground-native/windows-x64')
if ($LASTEXITCODE -ne 0) { throw 'Foreground native build failed.' }
