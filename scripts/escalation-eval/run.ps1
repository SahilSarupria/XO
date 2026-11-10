<#
.SYNOPSIS
  Runs the real-model escalation-policy evaluation on Windows.

.DESCRIPTION
  Prompts for your Gemini API key WITHOUT echoing it, sets it for this process only, runs the Node orchestrator
  (scripts\escalation-eval\run.mjs), and removes the key from the environment afterwards. The key is never written to disk.

  Prerequisites: Node.js >= 22.15 (https://nodejs.org), git, and this repository checked out on the branch that contains the
  evaluation harness. Run it from any directory:

      powershell -ExecutionPolicy Bypass -File .\scripts\escalation-eval\run.ps1

.PARAMETER BudgetTokens
  HARD token cap for the whole run (default 150000). The run refuses further model calls once it is spent.

.PARAMETER MinIntervalMs
  Minimum gap between provider calls, for free-tier rate limits (default 6000 = about 10 calls per minute).

.PARAMETER DryRun
  Check everything and print the plan, but make no network call and spend nothing.

.PARAMETER AcknowledgeDataLeavesThisMachine
  Skip the "type SEND" prompt. Only use this once you have read the data warning the script prints: the evaluated text
  (which appears to include real personal data) is sent to Google.
#>
[CmdletBinding()]
param(
  [int]$BudgetTokens = 150000,
  [int]$MinIntervalMs = 6000,
  [string]$CacheDir,
  [string]$ReportPath,
  [string]$Model,
  [string]$PriceInPer1k,
  [string]$PriceOutPer1k,
  [switch]$SkipInstall,
  [switch]$DryRun,
  [switch]$AcknowledgeDataLeavesThisMachine
)

$ErrorActionPreference = 'Stop'
$orchestrator = Join-Path $PSScriptRoot 'run.mjs'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'Node.js was not found on PATH. Install Node.js 22.15 or newer from https://nodejs.org and reopen the terminal.'
  exit 1
}

$keyWasPreset = [bool]$env:GEMINI_API_KEY
if (-not $keyWasPreset) {
  $secure = Read-Host -Prompt 'Paste your Gemini API key (input is hidden)' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $env:GEMINI_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

$nodeArgs = @($orchestrator, '--budget-tokens', "$BudgetTokens", '--min-interval-ms', "$MinIntervalMs")
if ($CacheDir)      { $nodeArgs += @('--cache-dir', $CacheDir) }
if ($ReportPath)    { $nodeArgs += @('--report', $ReportPath) }
if ($Model)         { $nodeArgs += @('--model', $Model) }
if ($PriceInPer1k)  { $nodeArgs += @('--price-in', $PriceInPer1k) }
if ($PriceOutPer1k) { $nodeArgs += @('--price-out', $PriceOutPer1k) }
if ($SkipInstall)   { $nodeArgs += '--skip-install' }
if ($DryRun)        { $nodeArgs += '--dry-run' }
if ($AcknowledgeDataLeavesThisMachine) { $nodeArgs += '--ack-data-leaves-machine' }

$code = 1
try {
  & node @nodeArgs
  $code = $LASTEXITCODE
}
finally {
  # Remove the key we set. A key that was already in your session is left as you had it.
  if (-not $keyWasPreset) { Remove-Item Env:GEMINI_API_KEY -ErrorAction SilentlyContinue }
}
exit $code
