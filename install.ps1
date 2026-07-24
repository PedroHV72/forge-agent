# Forge Agent — Installer for Claude Code (Windows PowerShell)
# Usage: .\install.ps1 [-Update] [-DryRun]

param(
    [switch]$Update,
    [switch]$DryRun,
    [switch]$NoModelProbe
)

$ErrorActionPreference = "Stop"

# ── Config ───────────────────────────────────────────────────────────────────
$RepoDir    = $PSScriptRoot
$ClaudeDir  = "$env:USERPROFILE\.claude"
$AgentsDir  = "$ClaudeDir\agents"
$CommandsDir = "$ClaudeDir\commands"
$BackupDir  = "$ClaudeDir\forge-agent-backup-$(Get-Date -Format 'yyyyMMddHHmmss')"
$DispatchTemplatesDir = Join-Path (Join-Path $ClaudeDir 'templates') 'dispatch'
$DispatchTemplatesSrc = Join-Path (Join-Path (Join-Path $RepoDir 'shared') 'templates') 'dispatch'

function Info($msg)    { Write-Host "  $msg" }
function Success($msg) { Write-Host "✓ $msg" -ForegroundColor Green }
function Warn($msg)    { Write-Host "⚠ $msg" -ForegroundColor Yellow }
function Dry($msg)     { Write-Host "  [dry-run] $msg" -ForegroundColor Cyan }

function CopyFile($src, $dst) {
    if ($DryRun) {
        Dry "cp $src → $dst"
    } else {
        $dir = Split-Path $dst -Parent
        if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Copy-Item $src $dst -Force
    }
}

# ── Header ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Forge Agent Installer" -ForegroundColor Cyan
Write-Host "═══════════════════════"
Write-Host ""

# ── Detect Claude Code ────────────────────────────────────────────────────────
if (!(Test-Path $ClaudeDir)) {
    Write-Host "✗ Claude Code não encontrado em: $ClaudeDir" -ForegroundColor Red
    Write-Host "  Instale o Claude Code primeiro: https://claude.ai/code"
    exit 1
}
Success "Claude Code encontrado em $ClaudeDir"

if (!(Test-Path -LiteralPath $DispatchTemplatesSrc -PathType Container) -or
    !(Get-ChildItem -LiteralPath $DispatchTemplatesSrc -Filter '*.md' -File -ErrorAction SilentlyContinue)) {
    throw "Dispatch templates not found at: $DispatchTemplatesSrc"
}

# ── Check existing installation ───────────────────────────────────────────────
$hasExisting = (Get-ChildItem "$AgentsDir\forge*.md" -ErrorAction SilentlyContinue) -or
               (Get-ChildItem "$CommandsDir\forge*.md" -ErrorAction SilentlyContinue) -or
               (Test-Path (Join-Path $ClaudeDir 'forge-agent-prefs.jsonc')) -or
               (Get-ChildItem -Path $DispatchTemplatesDir -Filter '*.md' -File -ErrorAction SilentlyContinue)

if ($hasExisting -and -not $Update) {
    Write-Host ""
    Warn "Forge Agent já está instalado."
    Write-Host "  Execute com -Update para atualizar (backup automático):"
    Write-Host "  .\install.ps1 -Update"
    exit 0
}

if ($hasExisting -and $Update) {
    if (-not $DryRun) {
        New-Item -ItemType Directory "$BackupDir\agents" -Force | Out-Null
        New-Item -ItemType Directory "$BackupDir\commands" -Force | Out-Null
        $DispatchTemplatesBackupDir = Join-Path (Join-Path $BackupDir 'templates') 'dispatch'
        New-Item -ItemType Directory $DispatchTemplatesBackupDir -Force | Out-Null
        Get-ChildItem "$AgentsDir\forge*.md"   -ErrorAction SilentlyContinue | Copy-Item -Destination "$BackupDir\agents\"
        Get-ChildItem "$CommandsDir\forge*.md" -ErrorAction SilentlyContinue | Copy-Item -Destination "$BackupDir\commands\"
        $prefsJsoncFile = Join-Path $ClaudeDir 'forge-agent-prefs.jsonc'
        Get-ChildItem -Path $DispatchTemplatesDir -Filter '*.md' -File -ErrorAction SilentlyContinue |
            Copy-Item -Destination $DispatchTemplatesBackupDir
        if (Test-Path $prefsJsoncFile) { Copy-Item $prefsJsoncFile $BackupDir }
        if (Test-Path "$ClaudeDir\forge-statusline.js")  { Copy-Item "$ClaudeDir\forge-statusline.js"  $BackupDir }
        if (Test-Path "$ClaudeDir\forge-hook.js")        { Copy-Item "$ClaudeDir\forge-hook.js"        $BackupDir }
        if (Test-Path "$ClaudeDir\forge-settings.js")   { Copy-Item "$ClaudeDir\forge-settings.js"   $BackupDir }
    }
    Success "Backup salvo em $BackupDir"
}

# ── Clean up legacy gsd-* files ──────────────────────────────────────────────
Write-Host ""
Info "Limpando arquivos legados gsd-*..."
$cleaned = 0
foreach ($f in Get-ChildItem "$AgentsDir\gsd-*.md" -ErrorAction SilentlyContinue) {
    if ($DryRun) {
        Dry "rm $($f.FullName)"
    } else {
        Remove-Item $f.FullName -Force
    }
    Info "  removed agents\$($f.Name)"
    $cleaned++
}
foreach ($f in Get-ChildItem "$CommandsDir\gsd-*.md" -ErrorAction SilentlyContinue) {
    if ($DryRun) {
        Dry "rm $($f.FullName)"
    } else {
        Remove-Item $f.FullName -Force
    }
    Info "  removed commands\$($f.Name)"
    $cleaned++
}
foreach ($d in @("$ClaudeDir\skills", "$env:USERPROFILE\.agents\skills")) {
    foreach ($skillDir in Get-ChildItem "$d\gsd-*" -Directory -ErrorAction SilentlyContinue) {
        if ($DryRun) {
            Dry "rm -rf $($skillDir.FullName)"
        } else {
            Remove-Item $skillDir.FullName -Recurse -Force
        }
        Info "  removed skills\$($skillDir.Name)"
        $cleaned++
    }
}
if ($cleaned -eq 0) {
    Info "  (nenhum arquivo legado encontrado)"
}

# ── Install agents ────────────────────────────────────────────────────────────
Write-Host ""
Info "Instalando agentes..."
foreach ($f in Get-ChildItem "$RepoDir\agents\forge*.md") {
    CopyFile $f.FullName "$AgentsDir\$($f.Name)"
    Info "  agents\$($f.Name)"
}

Write-Host ""
Info "Instalando templates de dispatch..."
Get-ChildItem -LiteralPath $DispatchTemplatesSrc -Filter '*.md' -File | ForEach-Object {
    CopyFile $_.FullName (Join-Path $DispatchTemplatesDir $_.Name)
    Info "  templates/dispatch/$($_.Name)"
}

# ── Opus model availability probe ─────────────────────────────────────────────
# Agents default to claude-opus-5. If the user's account doesn't have access
# (tier/region), downgrade the installed agent frontmatters to claude-opus-4-8[1m]
# (the previous baseline). Runs a minimal API probe (~1 token). Skip with -NoModelProbe.
function Downgrade-OpusTo48 {
    foreach ($agent in @("forge-planner.md", "forge-discusser.md", "forge-researcher.md")) {
        $file = Join-Path $AgentsDir $agent
        if (!(Test-Path $file)) { continue }
        if ($DryRun) {
            Dry "downgrade model in agents\${agent}: claude-opus-5 → claude-opus-4-8[1m]"
        } else {
            $content = Get-Content $file -Raw
            $content = $content -replace '(?m)^model: "claude-opus-5"$', 'model: "claude-opus-4-8[1m]"'
            Set-Content $file $content -NoNewline
        }
    }
}

$script:OpusTarget = "claude-opus-5"  # default; flipped to claude-opus-4-8[1m] on downgrade
$script:SyncPrefs  = $true            # false when probe inconclusive

$ClaudeForProbe = Get-Command claude -ErrorAction SilentlyContinue

if ($DryRun) {
    # skip probe in dry-run
} elseif ($NoModelProbe) {
    Info ""
    Info "  (-NoModelProbe: mantendo claude-opus-5 como padrão)"
} elseif (-not $ClaudeForProbe) {
    Info ""
    Info "  Claude CLI não encontrado — probe de modelo pulado (mantendo claude-opus-5)"
    $script:SyncPrefs = $false  # can't verify — leave prefs untouched
} else {
    Write-Host ""
    Info "Verificando disponibilidade de claude-opus-5..."
    $probeOut = ""
    $probeExit = 1
    try {
        $probeOut = & claude -p "ok" --model 'claude-opus-5' --max-turns 1 2>&1 | Out-String
        $probeExit = $LASTEXITCODE
    } catch {
        $probeOut = $_.Exception.Message
        $probeExit = 1
    }
    if ($probeExit -eq 0) {
        Success "  claude-opus-5 disponível — usando como modelo Opus padrão"
    } elseif ($probeOut -imatch "model.*not.*(found|available|supported|allowed)|invalid.*model|404|not_found|does not have access|issue with.*model|may not exist|may not have access") {
        Warn "  claude-opus-5 indisponível nesta conta — fallback para claude-opus-4-8[1m]"
        Downgrade-OpusTo48
        Info "  Agents atualizados: forge-planner, forge-discusser, forge-researcher"
        $script:OpusTarget = "claude-opus-4-8[1m]"
    } else {
        Info "  Probe inconclusivo (erro não relacionado a modelo) — mantendo claude-opus-5"
        Info "  Se houver problemas em runtime, rode: .\install.ps1 -Update (com conectividade)"
        $script:SyncPrefs = $false  # can't verify — leave prefs untouched
    }
}

# ── Fable 5 model availability probe ──────────────────────────────────────────
# The max tier defaults to claude-fable-5 (plan-milestone, risk:high plan-slice,
# blocker escalation). If the account doesn't have access, tier_models.max in prefs
# is redirected to the resolved Opus target. Skip with -NoModelProbe.
$script:FableDowngrade = $false

if ($DryRun -or $NoModelProbe) {
    # skip — keep claude-fable-5 as the max tier default
} elseif (-not $ClaudeForProbe) {
    # CLI missing — already reported above; keep default
} else {
    Info "Verificando disponibilidade de claude-fable-5 (tier max)..."
    $fableOut = ""
    $fableExit = 1
    try {
        $fableOut = & claude -p "ok" --model 'claude-fable-5' --max-turns 1 2>&1 | Out-String
        $fableExit = $LASTEXITCODE
    } catch {
        $fableOut = $_.Exception.Message
        $fableExit = 1
    }
    if ($fableExit -eq 0) {
        Success "  claude-fable-5 disponível — tier max usará Fable 5"
    } elseif ($fableOut -imatch "model.*not.*(found|available|supported|allowed)|invalid.*model|404|not_found|does not have access|issue with.*model|may not exist|may not have access") {
        Warn "  claude-fable-5 indisponível nesta conta — tier max será redirecionado para Opus"
        $script:FableDowngrade = $true
    } else {
        Info "  Probe inconclusivo — mantendo claude-fable-5 no tier max"
        Info "  Se plan-milestone falhar em runtime, edite tier_models.max via /forge-prefs"
    }
}

# ── Install commands ──────────────────────────────────────────────────────────
Write-Host ""
Info "Instalando comandos..."
# Remove commands that no longer exist in the repo (migrated to skills)
foreach ($f in Get-ChildItem "$CommandsDir\forge*.md" -ErrorAction SilentlyContinue) {
    if (!(Test-Path "$RepoDir\commands\$($f.Name)")) {
        if ($DryRun) {
            Dry "rm $($f.FullName) (migrated to skill)"
        } else {
            Remove-Item $f.FullName -Force
        }
        Info "  removed commands\$($f.Name) (migrated to skill)"
    }
}
foreach ($f in Get-ChildItem "$RepoDir\commands\forge*.md") {
    CopyFile $f.FullName "$CommandsDir\$($f.Name)"
    Info "  commands\$($f.Name)"
}

# ── Install skills ────────────────────────────────────────────────────────────
Write-Host ""
Info "Instalando skills..."
$SkillsDirAgents = "$env:USERPROFILE\.agents\skills"
$SkillsDirClaude = "$ClaudeDir\skills"
foreach ($skillDir in Get-ChildItem "$RepoDir\skills" -Directory) {
    $skillName = $skillDir.Name
    foreach ($target in @($SkillsDirAgents, $SkillsDirClaude)) {
        $dst = "$target\$skillName"
        if ($DryRun) {
            Dry "install skill $skillName → $target\"
        } else {
            New-Item -ItemType Directory -Path $dst -Force | Out-Null
            Copy-Item "$($skillDir.FullName)\*" $dst -Recurse -Force
        }
    }
    Info "  $skillName"
}

# ── Install preferences ───────────────────────────────────────────────────────
Write-Host ""
Info "Instalando preferências..."
$prefsFile = Join-Path $ClaudeDir 'forge-agent-prefs.md'
$PrefsJsonc = Join-Path $ClaudeDir 'forge-agent-prefs.jsonc'

# Existing JSONC is user-owned and must never be replaced.
if (Test-Path $PrefsJsonc) {
    Info "  forge-agent-prefs.jsonc já existe — não sobrescrito"
} elseif (Test-Path $prefsFile) {
    $migrateScript = Join-Path $RepoDir 'scripts/forge-prefs-migrate.js'
    if ($DryRun) {
        Dry "node $migrateScript --global-only"
    } elseif (Get-Command node -ErrorAction SilentlyContinue) {
        & node $migrateScript --global-only
        if ($LASTEXITCODE -eq 0) {
            Success "  forge-agent-prefs.md migrado para JSONC"
        } else {
            Warn "  Migração automática recusada (código $LASTEXITCODE)."
            Warn "  Execute manualmente: node $migrateScript --global-only"
        }
    } else {
        Info "  Node não encontrado — migração global pulada"
    }
} elseif (Get-Command node -ErrorAction SilentlyContinue) {
    $prefsScript = Join-Path $RepoDir 'scripts/forge-prefs.js'
    if ($DryRun) {
        Dry "node $prefsScript --scaffold --out $PrefsJsonc --schema-ref forge-prefs.schema.json"
    } else {
        & node $prefsScript --scaffold --out $PrefsJsonc --schema-ref forge-prefs.schema.json
        Info "  forge-agent-prefs.jsonc (catálogo global default)"
    }
} else {
    Info "  Node não encontrado — scaffold JSONC pulado"
}

# ── Store repo path for /forge-update ──────────────────────────────────────────
if (Test-Path $PrefsJsonc) {
    if (Get-Command node -ErrorAction SilentlyContinue) {
        $migrateScript = Join-Path $RepoDir 'scripts/forge-prefs-migrate.js'
        if ($DryRun) {
            Dry "node $migrateScript --set repo_path=$RepoDir --layer global"
        } else {
            & node $migrateScript --set "repo_path=$RepoDir" --layer global
        }
        Info "  repo_path gravado no catálogo global: $RepoDir"
    } else {
        Info "  Node não encontrado — repo_path no JSONC não atualizado"
    }
}

# ── Sync prefs opus model with agent frontmatter ──────────────────────────────
# The orchestrator reads the model ID from forge-agent-prefs.md to display the model
# in TaskCreate descriptions. When agents are upgraded (or downgraded) by the probe,
# the prefs file must be rewritten to match — otherwise the UI shows one model while
# Agent() dispatches another (the frontmatter wins at dispatch time).
if ($script:SyncPrefs -and (Test-Path $PrefsJsonc)) {
    if (Get-Command node -ErrorAction SilentlyContinue) {
        $migrateScript = Join-Path $RepoDir 'scripts/forge-prefs-migrate.js'
        if ($DryRun) {
            Dry "node $migrateScript --set tier_models.heavy=$($script:OpusTarget) --layer global"
        } else {
            & node $migrateScript --set "tier_models.heavy=$($script:OpusTarget)" --layer global
        }
        Info "  prefs tier_models.heavy sincronizado: $($script:OpusTarget)"
    } else {
        Info "  Node não encontrado — tier_models.heavy no JSONC não sincronizado"
    }
}

# ── Downgrade fable max tier in prefs (probe-driven) ──────────────────────────
# Runs AFTER the opus sync so the target is the final resolved Opus ID. Replaces
# claude-fable-5 in tier_models.max; if the user's preserved prefs predate the max
# tier, the line is inserted after heavy: so the runtime fallback (claude-fable-5)
# never fires on an account without access.
if ($script:FableDowngrade -and (Test-Path $PrefsJsonc)) {
    if (Get-Command node -ErrorAction SilentlyContinue) {
        $migrateScript = Join-Path $RepoDir 'scripts/forge-prefs-migrate.js'
        if ($DryRun) {
            Dry "node $migrateScript --set tier_models.max=$($script:OpusTarget) --layer global"
        } else {
            & node $migrateScript --set "tier_models.max=$($script:OpusTarget)" --layer global
        }
        Info "  tier_models.max redirecionado no catálogo global: $($script:OpusTarget)"
    } else {
        Info "  Node não encontrado — tier_models.max no JSONC não atualizado"
    }
}

# ── Install shared references ─────────────────────────────────────────────────
Write-Host ""
Info "Instalando referências compartilhadas..."
$SharedSrc = Join-Path $RepoDir 'shared'
Get-ChildItem -Path $SharedSrc -Filter '*.md' -File | ForEach-Object {
    CopyFile $_.FullName (Join-Path $ClaudeDir $_.Name)
    Info ("  " + $_.Name)
}

# Review dialetico schemas (fonte unica, resolvidos de scripts/../schemas/ em runtime).
$SchemasSrc = Join-Path (Join-Path $RepoDir 'shared') 'schemas'
if (Test-Path $SchemasSrc) {
    $SchemasDst = Join-Path $ClaudeDir 'schemas'
    Get-ChildItem $SchemasSrc -Filter *.json | ForEach-Object {
        CopyFile $_.FullName (Join-Path $SchemasDst $_.Name)
        Info ("  schemas/" + $_.Name)
    }
}

# ── Install runtime scripts (scripts/forge-*.js invoked by skills/dispatch) ────
Write-Host ""
Info "Instalando scripts runtime..."
$ScriptsDir = Join-Path $ClaudeDir "scripts"
if (-not (Test-Path $ScriptsDir)) {
    New-Item -ItemType Directory -Path $ScriptsDir -Force | Out-Null
}
Get-ChildItem -Path "$RepoDir\scripts" -Filter "forge-*.js" -File | ForEach-Object {
    $name = $_.Name
    # Exclude *.test.js and files copied separately under $ClaudeDir root (statusline, hook).
    if ($name -like "*.test.js") { return }
    if ($name -eq "forge-statusline.js" -or $name -eq "forge-hook.js") { return }
    CopyFile $_.FullName (Join-Path $ScriptsDir $name)
    Info "  scripts/$name"
}

# Config engine schema (M008): loadSchema() resolves it at scripts/../forge-prefs.schema.json,
# i.e. $ClaudeDir\forge-prefs.schema.json. Without it the installed engine is schema-blind
# (no array coercion, no validation, viewer degrades) — ship it alongside the scripts.
# Join-Path everywhere so no literal backslash sequence (e.g. \f) is emitted.
$SchemaName = "forge-prefs.schema.json"
$SchemaSrc = Join-Path $RepoDir $SchemaName
if (Test-Path $SchemaSrc) {
    CopyFile $SchemaSrc (Join-Path $ClaudeDir $SchemaName)
    Info "  $SchemaName"
}

# ── Install CLI wrapper + shell integration (Windows) ─────────────────────────
# forge-accounts.cmd on PATH + an auto-attach claude() function in $PROFILE, so a
# plain `claude` enters the active account (and `claude --account <name>` a chosen
# one). Join-Path everywhere — never embed a literal "\f" segment in this file.
Write-Host ""
Info "Instalando CLI forge-accounts + shell integration..."
$BinDir = Join-Path $env:USERPROFILE ".local\bin"
if (-not (Test-Path $BinDir)) { New-Item -ItemType Directory -Path $BinDir -Force | Out-Null }
$CmdSrc = Join-Path (Join-Path $RepoDir "bin") "forge-accounts.cmd"
$CmdDst = Join-Path $BinDir "forge-accounts.cmd"
if (Test-Path $CmdSrc) {
    CopyFile $CmdSrc $CmdDst
    Info ("  bin -> " + $CmdDst)
}
$StatusCmdSrc = Join-Path (Join-Path $RepoDir "bin") "forge-status.cmd"
$StatusCmdDst = Join-Path $BinDir "forge-status.cmd"
if (Test-Path $StatusCmdSrc) {
    CopyFile $StatusCmdSrc $StatusCmdDst
    Info ("  bin -> " + $StatusCmdDst)
}
# Ensure $BinDir on the persisted User PATH so the wrapper resolves in new shells.
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not (($UserPath -split ';') | Where-Object { $_ -eq $BinDir })) {
    if (-not $DryRun) {
        [Environment]::SetEnvironmentVariable("Path", "$UserPath;$BinDir", "User")
        $env:Path = "$env:Path;$BinDir"
    }
    Info ("  PATH += " + $BinDir + " (reabra o terminal)")
}
# Wire the auto-attach claude() function into $PROFILE (idempotent via marker).
$Marker = "forge-accounts shell-init"
$ProfileHas = (Test-Path $PROFILE) -and (Select-String -Path $PROFILE -SimpleMatch $Marker -Quiet)
if ($ProfileHas) {
    Info ("  shell-init ja presente em " + $PROFILE)
} elseif ($DryRun) {
    Dry ("append forge-accounts shell-init -> " + $PROFILE)
} else {
    $ProfileDir = Split-Path -Parent $PROFILE
    if ($ProfileDir -and -not (Test-Path $ProfileDir)) { New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null }
    $Block = @(
        "",
        "# Forge Agent - auto-attach the active Claude account to claude (forge-accounts shell-init)",
        "if (Get-Command forge-accounts -ErrorAction SilentlyContinue) {",
        "  Invoke-Expression (& forge-accounts shell-init-pwsh | Out-String)",
        "}"
    ) -join "`r`n"
    Add-Content -Path $PROFILE -Value $Block
    Info ("  shell-init -> " + $PROFILE + " (reabra o terminal)")
}

# ── Install statusline + hooks ────────────────────────────────────────────────
Write-Host ""
Info "Instalando statusline & hooks..."
CopyFile "$RepoDir\scripts\forge-statusline.js" "$ClaudeDir\forge-statusline.js"
Info "  forge-statusline.js"
CopyFile "$RepoDir\scripts\forge-hook.js" "$ClaudeDir\forge-hook.js"
Info "  forge-hook.js"
CopyFile "$RepoDir\scripts\merge-settings.js" "$ClaudeDir\forge-settings.js"
Info "  forge-settings.js"
Info ""
Info "  Status line não ativada por padrão."
Info "  Para ativar: /forge-config statusline on"

# Re-register hooks when statusline is already active — picks up new hook events
# added in later versions (SubagentStart/Stop, PreCompact/PostCompact, ...) without
# requiring the user to toggle the statusline off and on again.
$SettingsFile  = Join-Path $ClaudeDir "settings.json"
$SettingsScript = Join-Path $ClaudeDir "forge-settings.js"
if (-not $DryRun -and (Test-Path $SettingsFile)) {
    $StatusActive = $false
    try {
        $Existing = Get-Content $SettingsFile -Raw | ConvertFrom-Json
        if ($Existing.statusLine -and $Existing.statusLine.command -and ($Existing.statusLine.command -like "*forge-statusline.js*")) {
            $StatusActive = $true
        }
    } catch {}

    if ($StatusActive) {
        Write-Host ""
        Info "Statusline ativa detectada — re-registrando hooks em settings.json..."
        $null = & node $SettingsScript $SettingsFile 2>&1
        if ($LASTEXITCODE -eq 0) {
            Success "  hooks sincronizados (inclui SubagentStart/Stop, PreCompact/PostCompact)"
        } else {
            Info "  falha ao re-registrar — rode manualmente: node ~/.claude/forge-settings.js ~/.claude/settings.json"
        }
    }
}

# ── Tier 1 MCPs: fetch + context7 (via `claude mcp add -s user`) ─────────────
# Claude Code CLI lê MCPs de ~/.claude.json (user-scope registry), NÃO de
# ~/.claude/settings.json. Usar o CLI oficial é a única forma de registrar.
$SkipFile    = Join-Path $ClaudeDir "forge-mcps-skipped.txt"
$ClaudeCmd   = Get-Command claude -ErrorAction SilentlyContinue

if (-not $DryRun -and $ClaudeCmd) {
    Write-Host ""
    Write-Host "────────────────────"
    Write-Host "  MCPs globais (Tier 1 — zero-config)"
    Write-Host "────────────────────"
    Write-Host ""

    $installedList = ""
    try { $installedList = & claude mcp list 2>$null | Out-String } catch {}

    function Add-Tier1Mcp($name, $configJson) {
        if ((Test-Path $SkipFile) -and ((Get-Content $SkipFile -ErrorAction SilentlyContinue) -contains $name)) {
            Info "  $name — pulado (marcado como skip pelo usuário)"
            return
        }
        if ($installedList -match "(?m)^$name[:\s]") {
            Info "  $name — já configurado"
            return
        }
        # add-json aceita a config inteira em JSON. PowerShell 5.1 strippa aspas
        # duplas ao passar args para exe externo — escapar `"` como `\"` preserva
        # o JSON literal que o CLI do Claude precisa receber.
        $escaped = $configJson -replace '"', '\"'
        & claude mcp add-json $name $escaped -s user 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Success "  $name — adicionado"
        } else {
            Info "  $name — falha ao adicionar (rode manualmente: claude mcp add-json $name '$configJson' -s user)"
        }
    }

    Add-Tier1Mcp "fetch"    '{"command":"npx","args":["-y","mcp-fetch-server"]}'
    Add-Tier1Mcp "context7" '{"command":"npx","args":["-y","@upstash/context7-mcp@latest"]}'
    Write-Host ""
    Info "Pesquisa web (Anthropic WebSearch nativo) já funciona sem MCP ou chave."
    Info "Para search determinístico (Brave, 2000q/mês grátis): /forge-mcps add brave-search"
} elseif (-not $DryRun) {
    Info ""
    Info "Claude CLI não encontrado no PATH — MCPs Tier 1 não foram instalados."
    Info "Após instalar o Claude Code, rode: /forge-mcps"
}

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "═══════════════════════"
if ($DryRun) {
    Write-Host "Dry run completo. Nenhum arquivo alterado." -ForegroundColor Cyan
} else {
    Success "Forge Agent instalado com sucesso!"
    Write-Host ""
    Write-Host "  Próximos passos:"
    Write-Host "  1. Navegue até um projeto:  cd C:\seu\projeto"
    Write-Host "  2. Abra o Claude Code:      claude"
    Write-Host "  3. Inicialize o projeto:    /forge-init"
    Write-Host "  4. Crie um milestone:       /forge-new-milestone <descrição>"
    Write-Host "  5. Execute:                 /forge-auto"
    Write-Host ""
    Write-Host "  Ajuda a qualquer momento:   /forge-help"
}
Write-Host ""
