param([Parameter(ValueFromRemainingArguments = $true)][string[]] $NpmArgs)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNodeVersion = (Get-Content -LiteralPath (Join-Path $taskRoot '.node-version') -Raw).Trim()
$taskNodeDir = Join-Path $taskRoot ('.local\toolchain\node-v' + $taskNodeVersion + '-win-x64')
if (-not (Test-Path -LiteralPath (Join-Path $taskNodeDir 'npm.cmd'))) {
  throw 'Install the Node version listed in .node-version, or place the official portable build in .local/toolchain.'
}
$env:PATH = $taskNodeDir + ';' + $env:PATH
Set-Location -LiteralPath $taskRoot
& (Join-Path $taskNodeDir 'npm.cmd') @NpmArgs
exit $LASTEXITCODE
