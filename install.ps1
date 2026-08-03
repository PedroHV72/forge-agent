<#[
Forge Agent installer wrapper for native Windows PowerShell.

Examples:
  .\install.ps1 -Runtime claude -DryRun
  .\install.ps1 -Runtime codex -Update
  .\install.ps1 -Runtime both -NoModelProbe
]
#>
param(
  [ValidateSet('claude', 'codex', 'both')]
  [string]$Runtime = 'claude',
  [switch]$Update,
  [switch]$DryRun,
  [switch]$NoModelProbe,
  [switch]$WithApp,
  [string]$ForgeHome,
  [string]$ClaudeHome,
  [string]$CodexHome
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$nodeArgs = @('--repo', $repo, '--runtime', $Runtime)
if ($Update) { $nodeArgs += '--update' }
if ($DryRun) { $nodeArgs += '--dry-run' }
if ($NoModelProbe) { $nodeArgs += '--no-model-probe' }
if ($WithApp) { $nodeArgs += '--with-app' }
if ($ForgeHome) {
  $forgeHomeArg = $ForgeHome
  if (Test-Path -LiteralPath $ForgeHome) { $forgeHomeArg = (Resolve-Path -LiteralPath $ForgeHome).Path }
  $nodeArgs += @('--forge-home', $forgeHomeArg)
}
if ($ClaudeHome) { $nodeArgs += @('--claude-home', $ClaudeHome) }
if ($CodexHome) { $nodeArgs += @('--codex-home', $CodexHome) }

& node (Join-Path $repo 'scripts/forge-installer.js') @nodeArgs
exit $LASTEXITCODE
