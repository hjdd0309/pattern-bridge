#Requires -Version 5.1
<#
.SYNOPSIS
    Create Pattern Bridge desktop shortcut (silent launch via VBScript)

.DESCRIPTION
    Creates "Pattern Bridge.lnk" on the Desktop.
    The shortcut runs launch-silent.vbs via wscript.exe so no cmd window appears.

.EXAMPLE
    PowerShell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Paths ──────────────────────────────────────────────────────────────────

$ProjectRoot  = Split-Path $PSScriptRoot -Parent
$VbsFile      = Join-Path $ProjectRoot  'scripts\launch-silent.vbs'
$ElectronExe  = Join-Path $ProjectRoot  'node_modules\electron\dist\electron.exe'
$WscriptExe   = "$env:SystemRoot\System32\wscript.exe"
$Desktop      = [Environment]::GetFolderPath('Desktop')
$ShortcutPath = Join-Path $Desktop 'Pattern Bridge.lnk'

# ── Header ─────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "Pattern Bridge Shortcut Creator" -ForegroundColor Cyan
Write-Host ("-" * 44) -ForegroundColor DarkGray

# ── Pre-checks ─────────────────────────────────────────────────────────────

if (-not (Test-Path $VbsFile)) {
    Write-Host "[ERROR] launch-silent.vbs not found." -ForegroundColor Red
    Write-Host "        Path: $VbsFile" -ForegroundColor DarkGray
    exit 1
}

if (-not (Test-Path $ElectronExe)) {
    Write-Host "[ERROR] Electron is not installed." -ForegroundColor Red
    Write-Host "        Run: npm install" -ForegroundColor Yellow
    exit 1
}

# ── Handle existing shortcut ───────────────────────────────────────────────

if (Test-Path $ShortcutPath) {
    Write-Host "[INFO] Shortcut already exists on Desktop." -ForegroundColor Yellow
    $answer = Read-Host "       Overwrite? (Y/n)"
    if ($answer -match '^[Nn]') {
        Write-Host "Cancelled." -ForegroundColor DarkGray
        exit 0
    }
    Remove-Item $ShortcutPath -Force
}

# ── Create shortcut ────────────────────────────────────────────────────────
#
#   TargetPath : wscript.exe  -- GUI script host, no console window
#   Arguments  : "scripts\launch-silent.vbs"
#   WindowStyle: 1 (normal)  -- wscript has no console; Electron opens normally
#   IconLocation: electron.exe -- shows proper app icon on the shortcut
#

$Shell = New-Object -ComObject WScript.Shell
$SC    = $Shell.CreateShortcut($ShortcutPath)

$SC.TargetPath       = $WscriptExe
$SC.Arguments        = "`"$VbsFile`""
$SC.WorkingDirectory = $ProjectRoot
$SC.Description      = 'Pattern Bridge - Behavioral Pattern Analyzer'
$SC.WindowStyle      = 1
$SC.IconLocation     = "$ElectronExe,0"

$SC.Save()

# ── Result ─────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  [OK] Shortcut created successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "  Location : $ShortcutPath"  -ForegroundColor White
Write-Host "  Launcher : $VbsFile"       -ForegroundColor DarkGray
Write-Host "  Target   : $ElectronExe"   -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Double-click 'Pattern Bridge' on the Desktop to launch the app." -ForegroundColor Cyan
Write-Host "  No cmd window will appear." -ForegroundColor DarkGray
Write-Host ""