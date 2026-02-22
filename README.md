# Attendance App

On-prem attendance system with:
- Flask backend + SQLite
- PIN authentication (Admin/Employee)
- Admin dashboard (attendance, users, categories, shifts, approvals, audit, XLSX export)
- Employee dashboard (summary, history, edit requests)
- QR login/logout tools with webcam scan support

## Run

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
