$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
  Write-Host "Python is not installed or not in PATH." -ForegroundColor Red
  Write-Host "Install Python 3.10+ and retry."
  exit 1
}

if (-not (Test-Path ".venv\Scripts\python.exe")) {
  Write-Host "Creating virtual environment..."
  python -m venv .venv
}

Write-Host "Installing dependencies..."
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

if (-not $env:TURSO_DATABASE_URL) {
  Write-Host "TURSO_DATABASE_URL is required." -ForegroundColor Red
  Write-Host "Set it first, for example:"
  Write-Host '$env:TURSO_DATABASE_URL = "libsql://your-database-name-your-org.turso.io"'
  exit 1
}

if (-not $env:TURSO_AUTH_TOKEN) {
  Write-Host "TURSO_AUTH_TOKEN is required." -ForegroundColor Red
  Write-Host "Set it first, for example:"
  Write-Host '$env:TURSO_AUTH_TOKEN = "<your-turso-auth-token>"'
  exit 1
}

Write-Host "Starting server at http://localhost:8000"
.\.venv\Scripts\python.exe app.py
