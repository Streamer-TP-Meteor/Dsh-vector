#Requires -Version 5.1
<#
.SYNOPSIS
    Installer for the dsh-vector-memory plugin (Windows).

.DESCRIPTION
    Creates a private virtual environment next to the plugin, installs the
    Python engine's dependencies (CPU only), optionally pre-downloads the
    embedding model, writes engine/config.json, and runs a self-check.

    It does not: run as administrator, modify PATH, install anything
    system-wide, or touch other applications. Everything it creates lives under
    this plugin folder and the data directory you choose.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -DataDir D:\vector-memory-data -ModelsDir D:\vector-memory-models

.EXAMPLE
    # Minimal: no model download now (the engine will fetch it on first use).
    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -SkipModels
#>
[CmdletBinding()]
param(
    [string]$Python = '',
    [string]$DataDir = '',
    [string]$ModelsDir = '',
    [string]$Mirror = 'https://hf-mirror.com',
    [string[]]$Sources = @(),
    [switch]$SkipModels,
    [switch]$SkipInstall,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$PluginDir = Split-Path -Parent $PSScriptRoot
$EngineDir = Join-Path $PluginDir 'engine'
$ConfigPath = Join-Path $EngineDir 'config.json'
$VenvDir = Join-Path $PluginDir '.venv'
$VenvPy = Join-Path $VenvDir 'Scripts\python.exe'
$ReqFile = Join-Path $PSScriptRoot 'requirements.txt'
$Downloader = Join-Path $PSScriptRoot 'download_models.py'

function Step($message) { Write-Host ''; Write-Host "==> $message" -ForegroundColor Cyan }
function Ok($message) { Write-Host "    $message" -ForegroundColor Green }
function Warn($message) { Write-Host "    $message" -ForegroundColor Yellow }
function Fail($message) { Write-Host ''; Write-Host "!! $message" -ForegroundColor Red; exit 1 }

function Resolve-Python {
    if ($Python) {
        if (-not (Test-Path $Python)) { Fail "python not found: $Python" }
        return @{ exe = $Python; prefix = @() }
    }
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) { return @{ exe = $py.Source; prefix = @('-3') } }
    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python) { return @{ exe = $python.Source; prefix = @() } }
    Fail 'Python 3.10+ not found. Install it (https://www.python.org/downloads/) or pass -Python <path>.'
}

Step 'Checking Python'
$found = Resolve-Python
$versionText = (& $found.exe @($found.prefix + @('-c', 'import sys; print(sys.version_info[0], sys.version_info[1])'))) -join ' '
if ($LASTEXITCODE -ne 0) { Fail 'the detected Python could not be started' }
$parts = ($versionText.Trim() -split '\s+')
$major = $parts[0]
$minor = $parts[1]
if ([int]$major -lt 3 -or ([int]$major -eq 3 -and [int]$minor -lt 10)) {
    Fail "Python $major.$minor is too old; the engine needs 3.10 or newer."
}
Ok "python $major.$minor  ($($found.exe))"

if (-not $SkipInstall) {
    Step 'Creating a private virtual environment'
    if ((Test-Path $VenvPy) -and -not $Force) {
        Ok "reusing $VenvDir"
    } else {
        & $found.exe @($found.prefix + @('-m', 'venv', $VenvDir))
        if ($LASTEXITCODE -ne 0) { Fail 'could not create the virtual environment (is the venv module available?)' }
        Ok "created $VenvDir"
    }

    Step 'Installing dependencies (CPU only, this can take a few minutes)'
    & $VenvPy -m pip install --upgrade pip --quiet
    $torchOk = $false
    try {
        & $VenvPy -c 'import torch' 2>$null
        if ($LASTEXITCODE -eq 0) { $torchOk = $true }
    } catch { $torchOk = $false }
    if (-not $torchOk) {
        Ok 'installing torch (CPU build)'
        & $VenvPy -m pip install --index-url https://download.pytorch.org/whl/cpu torch
        if ($LASTEXITCODE -ne 0) { Fail 'torch installation failed. Check the network, or install it manually and re-run with -SkipInstall.' }
    } else {
        Ok 'torch already present'
    }
    & $VenvPy -m pip install -r $ReqFile
    if ($LASTEXITCODE -ne 0) { Fail 'dependency installation failed' }
    $versions = (& $VenvPy -c 'import numpy, torch, transformers, sentence_transformers as st; print(numpy.__version__, torch.__version__, transformers.__version__, st.__version__)') -join ' '
    Ok "numpy / torch / transformers / sentence-transformers = $versions"
} else {
    if (-not (Test-Path $VenvPy)) { Warn "no virtual environment at $VenvDir (fine if your own Python already has the dependencies)" }
}

# Which interpreter will the engine use? The private venv when we have one,
# otherwise whatever Python we found (only acceptable when the user passed
# -SkipInstall because their own environment already has the packages).
$resolvedPython = $VenvPy
if (-not (Test-Path $VenvPy)) {
    $resolvedPython = (& $found.exe @($found.prefix + @('-c', 'import sys; print(sys.executable)'))).Trim()
    Warn "no venv; the engine will use $resolvedPython"
}

$resolvedDataDir = if ($DataDir) { $DataDir } else { Join-Path $env:LOCALAPPDATA 'dsh-vector-memory' }
New-Item -ItemType Directory -Force -Path $resolvedDataDir | Out-Null
Ok "data directory: $resolvedDataDir"

$embedRef = 'Qwen/Qwen3-Embedding-0.6B'
$rerankRef = 'Qwen/Qwen3-Reranker-0.6B'

if (-not $SkipModels) {
    $resolvedModelsDir = if ($ModelsDir) { $ModelsDir } else { Join-Path $resolvedDataDir 'models' }
    New-Item -ItemType Directory -Force -Path $resolvedModelsDir | Out-Null
    Step "Downloading models to $resolvedModelsDir (about 1.2 GB, mirror: $Mirror)"
    & $resolvedPython $Downloader --dest $resolvedModelsDir --mirror $Mirror
    if ($LASTEXITCODE -ne 0) {
        Warn 'model download failed; the engine will retry on first use (or re-run setup with -SkipModels and set paths later)'
    } else {
        $embedRef = Join-Path $resolvedModelsDir 'embed'
        $rerankRef = Join-Path $resolvedModelsDir 'rerank'
    }
}

Step 'Writing engine/config.json'
$defaults = [ordered]@{
    python     = $resolvedPython
    data_dir   = $resolvedDataDir
    models     = [ordered]@{ embed = $embedRef; rerank = $rerankRef }
    service    = [ordered]@{
        host = '127.0.0.1'; port = 8479; threads = 8; start_timeout_sec = 90
        prewarm = $true; restart_on_crash = $true; exit_with_dsh = $true
        rerank_idle_unload_min = 5; embed_idle_unload_min = 0; allow_remote = $false
    }
    sources    = @()
    project_index = [ordered]@{
        auto_register = $true; auto_index = $true; recall_scoped = $true
        extensions = @('.md', '.mdx', '.txt', '.rst'); max_files = 200; max_file_kb = 512
    }
    recall     = [ordered]@{
        enabled = $true; k = 3; min_cos = 0.3; max_chars = 1000
        timeout_ms = 1500; rerank = $false; min_query_chars = 6
    }
}

$config = $null
if ((Test-Path $ConfigPath) -and -not $Force) {
    try { $config = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $config = $null }
}
if (-not $config) { $config = [pscustomobject]$defaults }

# Always refresh the machine-specific paths; keep everything else the user set.
$config | Add-Member -NotePropertyName python -NotePropertyValue $resolvedPython -Force
$config | Add-Member -NotePropertyName data_dir -NotePropertyValue $resolvedDataDir -Force
if (-not $config.models) { $config | Add-Member -NotePropertyName models -NotePropertyValue ([pscustomobject]$defaults.models) -Force }
$config.models | Add-Member -NotePropertyName embed -NotePropertyValue $embedRef -Force
$config.models | Add-Member -NotePropertyName rerank -NotePropertyValue $rerankRef -Force

if ($Sources.Count -gt 0) {
    $list = @()
    $index = 0
    foreach ($source in $Sources) {
        if (-not (Test-Path $source)) { Warn "skipping missing folder: $source"; continue }
        $index++
        $full = (Resolve-Path $source).Path
        $list += [pscustomobject]@{
            name  = "notes-$index"
            root  = $full
            globs = @('**/*.md')
            extensions = @('.md', '.mdx', '.txt', '.rst')
            max_files = 200
            max_file_kb = 512
        }
    }
    if ($list.Count -gt 0) {
        $config | Add-Member -NotePropertyName sources -NotePropertyValue $list -Force
        Ok "registered $($list.Count) notes folder(s)"
    }
}

$json = $config | ConvertTo-Json -Depth 12
[IO.File]::WriteAllText($ConfigPath, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
Ok $ConfigPath

Step 'Self-check'
& $resolvedPython (Join-Path $EngineDir 'vsearch.py') --config $ConfigPath status
if ($LASTEXITCODE -ne 0) { Warn 'status check failed; run the same command manually to see the error' }

if ($Sources.Count -gt 0) {
    & $resolvedPython (Join-Path $EngineDir 'vsearch.py') --config $ConfigPath index
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host 'Next:'
Write-Host '  1. Install the plugin into DSH (see INSTALL.md)'
Write-Host '  2. Restart DSH once so the plugin loads'
Write-Host '  3. Settings -> vector memory: add your notes folders, then press "index"'
Write-Host "  Config:   $ConfigPath"
Write-Host "  Data:     $resolvedDataDir"
