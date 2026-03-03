# Attendance App

On-prem attendance system with:
- Flask backend + SQLite
- PIN authentication (Admin/Employee)
- Admin dashboard (attendance, users, categories, shifts, approvals, audit, XLSX export)
- Employee dashboard (summary, history, edit requests)
- QR login/logout tools with webcam scan support
- OTP alternative to QR scan (employee generates OTP, scanner submits employee code + OTP)

## Development Run

```powershell
.\run.ps1
```

Or manual:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

## Production (Linux + Gunicorn + Nginx)

Do not run `python app.py` in production. Use Gunicorn with the `wsgi.py` entrypoint.

1. Clone + install:

```bash
cd /opt
git clone https://github.com/SheetamCoondoo/Attendance-App.git attendance-app
cd attendance-app
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

2. Set production environment variables:

```bash
cp .env.example .env
```

Set at least:
- `APP_ENV=production`
- `SECRET_KEY=<long random value>`
- `TRUST_PROXY=1` (when running behind nginx)

Optional office-network allowlist:
- `REQUIRE_OFFICE_NETWORK=1`
- `ALLOW_ADMIN_FROM_ANYWHERE=1` to let admin dashboard/admin APIs work from any IP
- `ALLOWED_SUBNETS=192.168.1.0/24,203.0.113.10/32,198.51.100.20/32`
- `ALLOWED_SUBNET` is still supported for a single subnet/IP.

Then lock down the file:

```bash
chmod 600 .env
```

Generate a secret key example:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(64))"
```

3. Test Gunicorn locally on the server:

```bash
set -a
source .env
set +a
.venv/bin/gunicorn --workers 1 --threads 4 --bind 127.0.0.1:8000 wsgi:application
```

`workers=1` is intentional because SQLite is used.

4. Install systemd service:

```bash
sudo cp deploy/systemd/attendance.service /etc/systemd/system/attendance.service
sudo systemctl daemon-reload
sudo systemctl enable attendance
sudo systemctl start attendance
sudo systemctl status attendance
```

5. Configure nginx reverse proxy:

```bash
sudo cp deploy/nginx/attendance.conf /etc/nginx/sites-available/attendance
sudo ln -s /etc/nginx/sites-available/attendance /etc/nginx/sites-enabled/attendance
sudo nginx -t
sudo systemctl reload nginx
```

6. Deploy updates:

```bash
cd /opt/attendance-app
git pull origin main
source .venv/bin/activate
pip install -r requirements.txt
sudo systemctl restart attendance
```

## Production (Windows Server Quick Run)

For a quick production run on Windows, the app now auto-switches to `waitress` when `APP_ENV=production`.

```powershell
$env:APP_ENV = "production"
$env:SECRET_KEY = "<long-random-secret>"
$env:TRUST_PROXY = "1"  # set this only when behind reverse proxy
.\.venv\Scripts\python.exe app.py
```

Or one command:

```powershell
$env:SECRET_KEY = "<long-random-secret>"
.\run-prod.ps1
```

## URLs

- Login: `http://localhost:8000/login`
- Admin Dashboard: `http://localhost:8000/dashboard/admin`
- Employee Dashboard: `http://localhost:8000/dashboard/employee`
- Admin QR Tool: `http://localhost:8000/admin.html`
- Employee QR Tool: `http://localhost:8000/employee.html`
- Health: `http://localhost:8000/health`

## Default Credentials

- Admin: `ADMIN001 / 1234`
- Employee: `EMP001 / 1111`

## Main APIs

- Auth: `/auth/login`, `/auth/logout`, `/auth/me`
- QR: `/generate-qr`, `/scan`
- Midnight: `/admin/run-midnight-close`
- Admin Data: `/api/admin/attendance`, `/api/admin/summary`
- Employee Data: `/api/employee/my-attendance`, `/api/employee/my-summary`
- Management: `/api/admin/users`, `/api/admin/categories`, `/api/admin/shifts`
- Edit Workflow: `/api/employee/edit-requests`, `/api/admin/edit-requests`
- Audit + Export: `/api/admin/audit`, `/api/admin/export.xlsx`

## QR + OTP Scan Modes

- `POST /generate-qr`
  - Request (employee-authenticated): `{ "purpose": "login" | "logout" }`
  - Credential is always bound to the currently logged-in employee session.
  - Response includes:
    - `qr` (image data URI)
    - `session_id` / `session_token`
    - `otp_code` (6-digit OTP)
    - `expires_in_seconds`
    - `employee_code`, `employee_name`

- `POST /scan` supports exactly one mode per request:
  - QR mode (existing): `{ "session_id": "<token>" }` or `{ "session_token": "<token>" }`
  - OTP mode (new): `{ "employee_code": "EMP001", "otp_code": "123456" }`

- OTP rules:
  - Single-use
  - Expires with session TTL
  - Locked after 5 failed attempts
  - Generating a new QR/OTP invalidates prior active code for that employee

## Break Status Cutoff

- Employee break status (`/api/employee/today-break`) uses a `4:00 AM IST` day cutoff.
- Before `04:00`, break save/load maps to the previous date.
- At or after `04:00`, break save/load maps to the current date.
- This cutoff applies only to break-status save/load, not to attendance login/logout capture.
