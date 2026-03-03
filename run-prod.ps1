$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
  Write-Host "Python is not installed or not in PATH." -ForegroundColor Red
  exit 1
}

if (-not (Test-Path ".venv\Scripts\python.exe")) {
  Write-Host "Creating virtual environment..."
  python -m venv .venv
}

Write-Host "Installing dependencies..."
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

if (-not $env:APP_ENV) {
  $env:APP_ENV = "production"
}

if (-not $env:SECRET_KEY) {
  Write-Host "SECRET_KEY is required for production." -ForegroundColor Red
  Write-Host "Set it first, for example:"
  Write-Host "$env:SECRET_KEY = '<long-random-secret>'"
  exit 1
}

if (-not $env:PORT) {
  $env:PORT = "8000"
}

Write-Host "Starting production server (waitress) on port $env:PORT ..."
.\.venv\Scripts\python.exe app.py
