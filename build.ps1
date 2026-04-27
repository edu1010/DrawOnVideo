param(
  [switch]$Exe,
  [switch]$NoInstall,
  [switch]$Clean
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][scriptblock]$Action
  )

  Write-Host ""
  Write-Host "==> $Title" -ForegroundColor Cyan
  & $Action
}

if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  throw "npm.cmd was not found. Install Node.js and try again."
}

if ($Clean) {
  Invoke-Step "Cleaning dist/ and release/" {
    if (Test-Path -LiteralPath "dist") {
      Remove-Item -LiteralPath "dist" -Recurse -Force
    }
    if (Test-Path -LiteralPath "release") {
      Remove-Item -LiteralPath "release" -Recurse -Force
    }
  }
}

if (-not $NoInstall) {
  Invoke-Step "Installing dependencies" {
    & npm.cmd install --legacy-peer-deps
  }
}

Invoke-Step "Building frontend (Vite)" {
  & npm.cmd run build
}

if ($Exe) {
  if (-not (Test-Path -LiteralPath "electron-builder.yml")) {
    throw "electron-builder.yml was not found in the project root."
  }

  Invoke-Step "Building .exe with electron-builder" {
    & npx.cmd --yes electron-builder@latest --win nsis --x64 --publish never --config electron-builder.yml
  }

  Write-Host ""
  Write-Host "Process completed. Check the release/ folder." -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "Build completed. Output is in dist/." -ForegroundColor Green
}
