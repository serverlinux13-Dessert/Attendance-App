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

Write-Host "Starting server at http://localhost:8000"
.\.venv\Scripts\python.exe app.py
