$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskDotnet = Join-Path $taskRoot '.local\toolchain\dotnet\dotnet.exe'
if (!(Test-Path -LiteralPath $taskDotnet)) { throw '请先按照 docs/development-environment.md 安装 .NET 10 SDK。' }
& $taskDotnet build (Join-Path $taskRoot 'native\WindowsAdapter\WindowsAdapter.csproj') --configuration Release --nologo
exit $LASTEXITCODE
