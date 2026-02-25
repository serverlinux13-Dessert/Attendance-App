
import base64
import io
import json
import os
import sqlite3
import uuid
from datetime import date, datetime, time, timedelta, timezone
from functools import wraps
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import qrcode
from flask import Flask, jsonify, redirect, render_template, request, send_file, send_from_directory, session, url_for
from flask_cors import CORS
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "database.db"
PUBLIC_DIR = BASE_DIR / "public"

try:
    IST = ZoneInfo("Asia/Kolkata")
except ZoneInfoNotFoundError:
    IST = timezone(timedelta(hours=5, minutes=30))

QR_TTL_SECONDS = 60
DEFAULT_EMPLOYEE_PIN = "1111"
DEFAULT_ADMIN_PIN = "1234"
SECRET_KEY = os.getenv("SECRET_KEY", "dev-change-this-secret")
REQUIRE_OFFICE_NETWORK = os.getenv("REQUIRE_OFFICE_NETWORK", "0") == "1"
ALLOWED_SUBNET = os.getenv("ALLOWED_SUBNET", "").strip()

app = Flask(__name__)
app.config["SECRET_KEY"] = SECRET_KEY
CORS(app, supports_credentials=True)


def conn_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def has_col(conn, table, col):
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r["name"] == col for r in rows)


def ensure_col(conn, table, col, ddl):
    if not has_col(conn, table, col):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")


def table_exists(conn, table):
    r = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
    return r is not None


def now_ist():
    return datetime.now(IST)


def now_iso():
    return now_ist().isoformat()


def epoch_ms():
    return int(now_ist().timestamp() * 1000)


def parse_dt(v):
    d = datetime.fromisoformat(v)
    return d if d.tzinfo else d.replace(tzinfo=IST)


def get_client_ip():
    f = request.headers.get("X-Forwarded-For", "")
    return f.split(",")[0].strip() if f else (request.remote_addr or "")


def office_ok():
    if not REQUIRE_OFFICE_NETWORK:
        return True
    ip = get_client_ip()
    if ip.startswith("127.") or ip == "::1":
        return True
    if ALLOWED_SUBNET:
        import ipaddress

        try:
            return ipaddress.ip_address(ip) in ipaddress.ip_network(ALLOWED_SUBNET, strict=False)
        except Exception:
            return False
    return ip.startswith("10.") or ip.startswith("192.168.") or ip.startswith("172.")


def office_check():
    if office_ok():
        return None
    return jsonify({"message": "Access allowed only from office network"}), 403


def valid_pin(pin):
    return isinstance(pin, str) and pin.isdigit() and len(pin) == 4


def month_range():
    t = now_ist().date()
    return t.replace(day=1), t


def resolve_date_range(from_str, to_str):
    df, dt = month_range()
    if from_str:
        df = date.fromisoformat(from_str)
    if to_str:
        dt = date.fromisoformat(to_str)
    if df > dt:
        raise ValueError("from date cannot be after to date")
    return df, dt


def to_items(rows):
    return [dict(r) for r in rows]


def user_profile(conn, user_id):
    return conn.execute(
        """
        SELECT u.*, COALESCE(c.required_hours,9) required_hours,
               COALESCE(s.start_time,'09:00') shift_start, COALESCE(s.end_time,'18:00') shift_end,
               COALESCE(s.grace_minutes,15) grace_minutes,
               COALESCE(c.name,'General') category_name, COALESCE(s.name,'General Shift') shift_name
        FROM users u
        LEFT JOIN employee_categories c ON c.id=u.category_id
        LEFT JOIN shifts s ON s.id=u.shift_id
        WHERE u.id=? AND u.active=1
        """,
        (user_id,),
    ).fetchone()


def calc_metrics(login_iso, logout_iso, profile):
    login = parse_dt(login_iso).astimezone(IST)
    logout = parse_dt(logout_iso).astimezone(IST)
    total_hours = max(0, (logout - login).total_seconds() / 3600)
    required = float(profile["required_hours"] or 9)
    ot = max(0, total_hours - required)
    st = datetime.combine(login.date(), time.fromisoformat(profile["shift_start"]), tzinfo=IST)
    et = datetime.combine(login.date(), time.fromisoformat(profile["shift_end"]), tzinfo=IST)
    if et <= st:
        et += timedelta(days=1)
    late = int(login > st + timedelta(minutes=int(profile["grace_minutes"] or 0)))
    status = "PRESENT"
    return {
        "total_hours": round(total_hours, 4),
        "overtime": round(ot, 4),
        "late_mark": late,
        "status": status,
    }


def rebuild_schema_if_needed(conn):
    conn.execute("DROP INDEX IF EXISTS idx_edit_req_status_created")
    conn.execute("DROP TABLE IF EXISTS attendance_edit_requests")
    conn.execute("DROP TABLE IF EXISTS attendance_audit_log")

    if table_exists(conn, "employee_categories") and has_col(conn, "employee_categories", "half_day_hours"):
        conn.execute("ALTER TABLE employee_categories RENAME TO employee_categories_old")
        conn.execute(
            """
            CREATE TABLE employee_categories(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                required_hours REAL NOT NULL
            )
            """
        )
        conn.execute(
            """
            INSERT INTO employee_categories (id,name,required_hours)
            SELECT id,name,required_hours FROM employee_categories_old
            """
        )
        conn.execute("DROP TABLE employee_categories_old")

    if table_exists(conn, "shifts") and has_col(conn, "shifts", "half_day_threshold"):
        conn.execute("ALTER TABLE shifts RENAME TO shifts_old")
        conn.execute(
            """
            CREATE TABLE shifts(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                start_time TEXT NOT NULL,
                end_time TEXT NOT NULL,
                grace_minutes INTEGER NOT NULL DEFAULT 15
            )
            """
        )
        conn.execute(
            """
            INSERT INTO shifts (id,name,start_time,end_time,grace_minutes)
            SELECT id,name,start_time,end_time,COALESCE(grace_minutes,15) FROM shifts_old
            """
        )
        conn.execute("DROP TABLE shifts_old")

    if table_exists(conn, "attendance") and (has_col(conn, "attendance", "early_leaving") or has_col(conn, "attendance", "half_day")):
        conn.execute("ALTER TABLE attendance RENAME TO attendance_old")
        conn.execute(
            """
            CREATE TABLE attendance(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                attendance_date TEXT NOT NULL,
                login_time TEXT,
                logout_time TEXT,
                total_hours REAL,
                overtime REAL,
                late_mark INTEGER NOT NULL DEFAULT 0,
                break_taken INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'PRESENT',
                system_logout INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT,
                UNIQUE(user_id,attendance_date)
            )
            """
        )
        conn.execute(
            """
            INSERT INTO attendance (
                id,user_id,attendance_date,login_time,logout_time,total_hours,overtime,late_mark,break_taken,status,system_logout,created_at,updated_at
            )
            WITH normalized AS (
                SELECT *,
                       COALESCE(attendance_date,substr(login_time,1,10),substr(created_at,1,10),?) normalized_date
                FROM attendance_old
            ),
            ranked AS (
                SELECT *,
                       ROW_NUMBER() OVER (PARTITION BY user_id,normalized_date ORDER BY id DESC) rn
                FROM normalized
            )
            SELECT
                id,user_id,normalized_date,login_time,logout_time,total_hours,overtime,
                COALESCE(late_mark,0),
                COALESCE(break_taken,0),
                CASE WHEN status='ABSENT' THEN 'ABSENT' ELSE 'PRESENT' END,
                COALESCE(system_logout,0),
                COALESCE(created_at,login_time,?),
                COALESCE(updated_at,logout_time,login_time,?)
            FROM ranked
            WHERE rn=1
            """,
            (now_ist().date().isoformat(), now_iso(), now_iso()),
        )
        conn.execute("DROP TABLE attendance_old")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_attendance_user_date ON attendance(user_id,attendance_date)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_attendance_status_date ON attendance(status,attendance_date)")

    conn.execute("DROP INDEX IF EXISTS idx_edit_req_status_created")


def init_db():
    with conn_db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS employee_categories(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,required_hours REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS shifts(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,start_time TEXT NOT NULL,end_time TEXT NOT NULL,grace_minutes INTEGER NOT NULL DEFAULT 15);
            CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,name TEXT,role TEXT NOT NULL DEFAULT 'EMPLOYEE',employee_code TEXT,pin_hash TEXT,category_id INTEGER,shift_id INTEGER,category_hours INTEGER,active INTEGER NOT NULL DEFAULT 1,created_at TEXT);
            CREATE TABLE IF NOT EXISTS attendance(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,attendance_date TEXT NOT NULL,login_time TEXT,logout_time TEXT,total_hours REAL,overtime REAL,late_mark INTEGER NOT NULL DEFAULT 0,break_taken INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'PRESENT',system_logout INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT,UNIQUE(user_id,attendance_date));
            CREATE TABLE IF NOT EXISTS qr_sessions(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,purpose TEXT NOT NULL,expires_at INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS idx_attendance_user_date ON attendance(user_id,attendance_date);
            CREATE INDEX IF NOT EXISTS idx_attendance_status_date ON attendance(status,attendance_date);
            """
        )
        rebuild_schema_if_needed(conn)
        ensure_col(conn, "users", "role", "TEXT NOT NULL DEFAULT 'EMPLOYEE'")
        ensure_col(conn, "users", "employee_code", "TEXT")
        ensure_col(conn, "users", "pin_hash", "TEXT")
        ensure_col(conn, "users", "pin_plain", "TEXT")
        ensure_col(conn, "users", "category_id", "INTEGER")
        ensure_col(conn, "users", "shift_id", "INTEGER")
        ensure_col(conn, "users", "active", "INTEGER NOT NULL DEFAULT 1")
        ensure_col(conn, "users", "created_at", "TEXT")
        ensure_col(conn, "attendance", "attendance_date", "TEXT")
        ensure_col(conn, "attendance", "late_mark", "INTEGER NOT NULL DEFAULT 0")
        ensure_col(conn, "attendance", "break_taken", "INTEGER NOT NULL DEFAULT 0")
        ensure_col(conn, "attendance", "status", "TEXT NOT NULL DEFAULT 'PRESENT'")
        ensure_col(conn, "attendance", "system_logout", "INTEGER NOT NULL DEFAULT 0")
        ensure_col(conn, "attendance", "created_at", "TEXT")
        ensure_col(conn, "attendance", "updated_at", "TEXT")
        ensure_col(conn, "qr_sessions", "created_at", "TEXT")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_employee_code ON users(employee_code)")
        conn.execute("INSERT OR IGNORE INTO employee_categories (id,name,required_hours) VALUES (1,'General',9)")
        conn.execute("INSERT OR IGNORE INTO shifts (id,name,start_time,end_time,grace_minutes) VALUES (1,'General Shift','09:00','18:00',15)")
        conn.execute("INSERT OR IGNORE INTO users (id,name,role,employee_code,category_id,shift_id,category_hours,active,created_at) VALUES (1,'Employee1','EMPLOYEE','EMP001',1,1,9,1,?)", (now_iso(),))
        conn.execute("INSERT OR IGNORE INTO users (id,name,role,employee_code,category_id,shift_id,category_hours,active,created_at) VALUES (999,'Admin','ADMIN','ADMIN001',1,1,9,1,?)", (now_iso(),))
        users = conn.execute("SELECT id,role,pin_hash,employee_code FROM users").fetchall()
        for u in users:
            if not u["pin_hash"]:
                pin = DEFAULT_ADMIN_PIN if u["role"] == "ADMIN" else DEFAULT_EMPLOYEE_PIN
                conn.execute("UPDATE users SET pin_hash=?,pin_plain=? WHERE id=?", (generate_password_hash(pin), pin, u["id"]))
            if not u["employee_code"]:
                prefix = "ADMIN" if u["role"] == "ADMIN" else "EMP"
                conn.execute("UPDATE users SET employee_code=? WHERE id=?", (f"{prefix}{int(u['id']):03d}", u["id"]))
        conn.execute("UPDATE attendance SET attendance_date=COALESCE(attendance_date,substr(login_time,1,10),substr(created_at,1,10),?) WHERE attendance_date IS NULL", (now_ist().date().isoformat(),))
        conn.execute("UPDATE attendance SET created_at=COALESCE(created_at,login_time,?),updated_at=COALESCE(updated_at,logout_time,login_time,?) WHERE created_at IS NULL OR updated_at IS NULL", (now_iso(), now_iso()))
        conn.execute("UPDATE qr_sessions SET created_at=COALESCE(created_at,?) WHERE created_at IS NULL", (now_iso(),))


def auth_user():
    uid = session.get("user_id")
    if not uid:
        return None
    with conn_db() as conn:
        u = conn.execute("SELECT id,name,role,employee_code,active FROM users WHERE id=?", (uid,)).fetchone()
    if not u or int(u["active"] or 0) != 1:
        return None
    return u


def html_guard(role=None):
    def d(fn):
        @wraps(fn)
        def w(*a, **k):
            chk = office_check()
            if chk:
                return chk
            u = auth_user()
            if not u:
                return redirect(url_for("login_page"))
            if role and u["role"] != role:
                return redirect(url_for("dashboard"))
            return fn(*a, **k)

        return w

    return d


def api_guard(role=None):
    def d(fn):
        @wraps(fn)
        def w(*a, **k):
            chk = office_check()
            if chk:
                return chk
            u = auth_user()
            if not u:
                return jsonify({"message": "Authentication required"}), 401
            if role and u["role"] != role:
                return jsonify({"message": "Forbidden"}), 403
            request.current_user = u
            return fn(*a, **k)

        return w

    return d


@app.get("/")
def root():
    return redirect(url_for("login_page"))


@app.get("/health")
def health():
    return jsonify({"status": "ok", "time_ist": now_iso()})


@app.get("/admin.html")
def admin_tool_page():
    return redirect(url_for("scanner_page"))


@app.get("/scanner")
def scanner_page():
    chk = office_check()
    if chk:
        return chk
    return send_from_directory(PUBLIC_DIR, "scanner.html")


@app.get("/employee.html")
def employee_tool_page():
    return send_from_directory(PUBLIC_DIR, "employee.html")


@app.get("/scanner.js")
def scanner_js():
    return send_from_directory(PUBLIC_DIR, "scanner.js")


@app.get("/login")
def login_page():
    chk = office_check()
    if chk:
        return chk
    if auth_user():
        return redirect(url_for("dashboard"))
    return render_template("login.html")


@app.get("/dashboard")
@html_guard()
def dashboard():
    u = auth_user()
    return redirect(url_for("admin_dashboard" if u["role"] == "ADMIN" else "employee_dashboard"))


@app.get("/dashboard/admin")
@html_guard("ADMIN")
def admin_dashboard():
    return render_template("admin_dashboard.html")


@app.get("/dashboard/employee")
@html_guard("EMPLOYEE")
def employee_dashboard():
    return render_template("employee_dashboard.html")


@app.post("/auth/login")
def auth_login():
    chk = office_check()
    if chk:
        return chk
    data = request.get_json(silent=True) or request.form.to_dict() or {}
    pin = str(data.get("pin", "")).strip()
    if not valid_pin(pin):
        return jsonify({"message": "PIN must be 4 digits"}), 400

    key = str(data.get("employee_code", "")).strip()
    uid = data.get("user_id")
    with conn_db() as conn:
        user = None
        if key:
            user = conn.execute("SELECT * FROM users WHERE employee_code=? AND active=1", (key,)).fetchone()
        elif uid is not None:
            try:
                user = conn.execute("SELECT * FROM users WHERE id=? AND active=1", (int(uid),)).fetchone()
            except ValueError:
                return jsonify({"message": "Invalid user_id"}), 400
        else:
            return jsonify({"message": "employee_code or user_id required"}), 400

        if not user or not user["pin_hash"] or not check_password_hash(user["pin_hash"], pin):
            return jsonify({"message": "Invalid credentials"}), 401

    session["user_id"] = int(user["id"])
    session["role"] = user["role"]
    session["name"] = user["name"]
    session["login_at"] = now_iso()
    return jsonify({"message": "Login successful", "redirect": "/dashboard/admin" if user["role"] == "ADMIN" else "/dashboard/employee"})


@app.post("/auth/logout")
def auth_logout():
    session.clear()
    return jsonify({"message": "Logged out"})


@app.get("/auth/me")
@api_guard()
def auth_me():
    u = request.current_user
    return jsonify({"user": {"id": int(u["id"]), "name": u["name"], "role": u["role"], "employee_code": u["employee_code"]}})

@app.post("/generate-qr")
def generate_qr():
    chk = office_check()
    if chk:
        return chk
    data = request.get_json(silent=True) or {}
    user_id = data.get("user_id")
    purpose = str(data.get("purpose", "")).strip().lower()
    if not isinstance(user_id, int) or purpose not in {"login", "logout"}:
        return jsonify({"message": "Invalid request payload"}), 400

    token = str(uuid.uuid4())
    expires = epoch_ms() + QR_TTL_SECONDS * 1000
    with conn_db() as conn:
        if not user_profile(conn, user_id):
            return jsonify({"message": "User not found or inactive"}), 404
        conn.execute("INSERT INTO qr_sessions (id,user_id,purpose,expires_at,used,created_at) VALUES (?,?,?,?,0,?)", (token, user_id, purpose, expires, now_iso()))
    payload = {"user_id": user_id, "session_token": token}
    qr_text = json.dumps(payload)
    img = qrcode.make(qr_text)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    qr = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    return jsonify({"qr": qr, "session_id": token, "session_token": token, "expires_in_seconds": QR_TTL_SECONDS})


@app.post("/scan")
def scan_qr():
    chk = office_check()
    if chk:
        return chk
    data = request.get_json(silent=True) or {}
    token = (data.get("session_token") or data.get("session_id") or "").strip()
    if not token:
        return jsonify({"message": "Invalid or expired QR"}), 400

    nowms = epoch_ms()
    niso = now_iso()
    with conn_db() as conn:
        qr = conn.execute("SELECT * FROM qr_sessions WHERE id=?", (token,)).fetchone()
        if not qr or int(qr["used"]) == 1 or int(qr["expires_at"]) < nowms:
            return jsonify({"message": "Invalid or expired QR"}), 400

        uid = int(qr["user_id"])
        purpose = str(qr["purpose"]).lower()
        conn.execute("UPDATE qr_sessions SET used=1 WHERE id=?", (token,))

        if purpose == "login":
            d = now_ist().date().isoformat()
            open_row = conn.execute("SELECT id FROM attendance WHERE user_id=? AND login_time IS NOT NULL AND logout_time IS NULL ORDER BY id DESC LIMIT 1", (uid,)).fetchone()
            if open_row:
                return jsonify({"message": "User already logged in"}), 400

            today = conn.execute("SELECT id,login_time,logout_time FROM attendance WHERE user_id=? AND attendance_date=?", (uid, d)).fetchone()
            if today and today["login_time"] and today["logout_time"]:
                return jsonify({"message": "Attendance already captured for today"}), 400

            if today and not today["login_time"]:
                conn.execute("UPDATE attendance SET login_time=?,status='PRESENT',system_logout=0,updated_at=? WHERE id=?", (niso, niso, today["id"]))
            else:
                conn.execute("INSERT INTO attendance (user_id,attendance_date,login_time,status,created_at,updated_at) VALUES (?,?,?,'PRESENT',?,?)", (uid, d, niso, niso, niso))
            return jsonify({"message": "Login Recorded"})

        if purpose == "logout":
            rec = conn.execute("SELECT * FROM attendance WHERE user_id=? AND login_time IS NOT NULL AND logout_time IS NULL ORDER BY id DESC LIMIT 1", (uid,)).fetchone()
            if not rec:
                return jsonify({"message": "No login found"}), 400
            profile = user_profile(conn, uid)
            m = calc_metrics(rec["login_time"], niso, profile)
            conn.execute("UPDATE attendance SET logout_time=?,total_hours=?,overtime=?,late_mark=?,status=?,updated_at=? WHERE id=?", (niso, m["total_hours"], m["overtime"], m["late_mark"], m["status"], niso, rec["id"]))
            return jsonify({"message": "Logout Recorded", "metrics": m})

        return jsonify({"message": "Invalid or expired QR"}), 400


@app.post("/admin/run-midnight-close")
def midnight_close():
    chk = office_check()
    if chk:
        return chk
    data = request.get_json(silent=True) or {}
    d = data.get("date")
    try:
        target = date.fromisoformat(d) if d else now_ist().date() - timedelta(days=1)
    except ValueError:
        return jsonify({"message": "Invalid date format. Use YYYY-MM-DD"}), 400

    absent = 0
    auto_logout = 0
    with conn_db() as conn:
        users = conn.execute("SELECT id FROM users WHERE active=1").fetchall()
        for u in users:
            uid = int(u["id"])
            row = conn.execute("SELECT * FROM attendance WHERE user_id=? AND attendance_date=?", (uid, target.isoformat())).fetchone()
            if not row:
                conn.execute("INSERT INTO attendance (user_id,attendance_date,status,created_at,updated_at) VALUES (?,?,'ABSENT',?,?)", (uid, target.isoformat(), now_iso(), now_iso()))
                absent += 1
                continue
            if row["login_time"] and not row["logout_time"]:
                p = user_profile(conn, uid)
                st = datetime.combine(target, time.fromisoformat(p["shift_start"]), tzinfo=IST)
                et = datetime.combine(target, time.fromisoformat(p["shift_end"]), tzinfo=IST)
                if et <= st:
                    et += timedelta(days=1)
                auto_t = et.isoformat()
                m = calc_metrics(row["login_time"], auto_t, p)
                conn.execute("UPDATE attendance SET logout_time=?,total_hours=?,overtime=?,late_mark=?,status=?,system_logout=1,updated_at=? WHERE id=?", (auto_t, m["total_hours"], m["overtime"], m["late_mark"], m["status"], now_iso(), row["id"]))
                auto_logout += 1

    return jsonify({"message": "Midnight close completed", "attendance_date": target.isoformat(), "absent_marked": absent, "system_logout_done": auto_logout})

def parse_filters():
    try:
        dfrom, dto = resolve_date_range(request.args.get("from"), request.args.get("to"))
    except Exception as e:
        raise ValueError(str(e))
    status = request.args.get("status")
    if status:
        status = status.strip().upper()
        if status not in {"PRESENT", "ABSENT"}:
            raise ValueError("Invalid status")
    uid = int(request.args.get("user_id")) if request.args.get("user_id") else None
    sid = int(request.args.get("shift_id")) if request.args.get("shift_id") else None
    cid = int(request.args.get("category_id")) if request.args.get("category_id") else None
    return dfrom, dto, status, uid, sid, cid


def attendance_where(dfrom, dto, status=None, uid=None, sid=None, cid=None):
    cond = ["a.attendance_date BETWEEN ? AND ?"]
    params = [dfrom.isoformat(), dto.isoformat()]
    if status:
        cond.append("a.status=?")
        params.append(status)
    if uid is not None:
        cond.append("a.user_id=?")
        params.append(uid)
    if sid is not None:
        cond.append("u.shift_id=?")
        params.append(sid)
    if cid is not None:
        cond.append("u.category_id=?")
        params.append(cid)
    return " AND ".join(cond), params


@app.get("/api/admin/attendance")
@api_guard("ADMIN")
def admin_attendance():
    try:
        dfrom, dto, status, uid, sid, cid = parse_filters()
        page = max(1, int(request.args.get("page", 1)))
        page_size = max(1, min(200, int(request.args.get("page_size", 25))))
    except Exception as e:
        return jsonify({"message": str(e)}), 400
    offset = (page - 1) * page_size

    where, params = attendance_where(dfrom, dto, status, uid, sid, cid)
    with conn_db() as conn:
        total = conn.execute(f"SELECT COUNT(*) cnt FROM attendance a JOIN users u ON u.id=a.user_id WHERE {where}", tuple(params)).fetchone()["cnt"]
        rows = conn.execute(
            f"""
            SELECT a.*,u.name employee_name,u.employee_code,COALESCE(s.name,'General Shift') shift_name,COALESCE(c.name,'General') category_name
            FROM attendance a JOIN users u ON u.id=a.user_id
            LEFT JOIN shifts s ON s.id=u.shift_id LEFT JOIN employee_categories c ON c.id=u.category_id
            WHERE {where} ORDER BY a.attendance_date DESC,a.id DESC LIMIT ? OFFSET ?
            """,
            tuple(params + [page_size, offset]),
        ).fetchall()
    return jsonify({"items": to_items(rows), "page": page, "page_size": page_size, "total": total})


@app.get("/api/admin/summary")
@api_guard("ADMIN")
def admin_summary():
    try:
        dfrom, dto = resolve_date_range(request.args.get("from"), request.args.get("to"))
    except Exception as e:
        return jsonify({"message": str(e)}), 400
    with conn_db() as conn:
        row = conn.execute(
            """
            SELECT COUNT(*) total_days_worked,
            SUM(CASE WHEN status='ABSENT' THEN 1 ELSE 0 END) absent_count,
            SUM(CASE WHEN late_mark=1 THEN 1 ELSE 0 END) late_count,
            SUM(COALESCE(total_hours,0)) total_hours,
            SUM(COALESCE(overtime,0)) overtime_hours
            FROM attendance WHERE attendance_date BETWEEN ? AND ?
            """,
            (dfrom.isoformat(), dto.isoformat()),
        ).fetchone()
    return jsonify(dict(row))


@app.get("/api/admin/employee-summary")
@api_guard("ADMIN")
def admin_employee_summary():
    code = str(request.args.get("employee_code", "")).strip()
    if not code:
        return jsonify({"message": "employee_code is required"}), 400
    try:
        dfrom, dto = resolve_date_range(request.args.get("from"), request.args.get("to"))
    except Exception as e:
        return jsonify({"message": str(e)}), 400

    with conn_db() as conn:
        employee = conn.execute(
            """
            SELECT u.id,u.name,u.employee_code
            FROM users u
            WHERE u.employee_code=?
            """,
            (code,),
        ).fetchone()
        if not employee:
            return jsonify({"message": "Employee not found"}), 404

        summary = conn.execute(
            """
            SELECT
            SUM(CASE WHEN status='ABSENT' THEN 1 ELSE 0 END) absent_count,
            SUM(CASE WHEN login_time IS NOT NULL THEN 1 ELSE 0 END) total_days_worked,
            SUM(CASE WHEN late_mark=1 THEN 1 ELSE 0 END) late_count,
            SUM(COALESCE(total_hours,0)) total_hours,
            SUM(COALESCE(overtime,0)) overtime_hours
            FROM attendance WHERE user_id=? AND attendance_date BETWEEN ? AND ?
            """,
            (employee["id"], dfrom.isoformat(), dto.isoformat()),
        ).fetchone()
        rows = conn.execute(
            """
            SELECT id,attendance_date,login_time,logout_time,total_hours,overtime,late_mark,break_taken,status
            FROM attendance WHERE user_id=? AND attendance_date BETWEEN ? AND ?
            ORDER BY attendance_date DESC,id DESC
            """,
            (employee["id"], dfrom.isoformat(), dto.isoformat()),
        ).fetchall()

    return jsonify({"employee": dict(employee), "summary": dict(summary), "attendance": to_items(rows)})


@app.get("/api/admin/employee-summary.xlsx")
@api_guard("ADMIN")
def admin_employee_summary_xlsx():
    try:
        from openpyxl import Workbook
    except ImportError:
        return jsonify({"message": "openpyxl is required for export"}), 500

    code = str(request.args.get("employee_code", "")).strip()
    if not code:
        return jsonify({"message": "employee_code is required"}), 400
    try:
        dfrom, dto = resolve_date_range(request.args.get("from"), request.args.get("to"))
    except Exception as e:
        return jsonify({"message": str(e)}), 400

    with conn_db() as conn:
        employee = conn.execute(
            """
            SELECT u.id,u.name,u.employee_code
            FROM users u
            WHERE u.employee_code=?
            """,
            (code,),
        ).fetchone()
        if not employee:
            return jsonify({"message": "Employee not found"}), 404

        summary = conn.execute(
            """
            SELECT
            SUM(CASE WHEN status='ABSENT' THEN 1 ELSE 0 END) absent_count,
            SUM(CASE WHEN login_time IS NOT NULL THEN 1 ELSE 0 END) total_days_worked,
            SUM(CASE WHEN late_mark=1 THEN 1 ELSE 0 END) late_count,
            SUM(COALESCE(total_hours,0)) total_hours,
            SUM(COALESCE(overtime,0)) overtime_hours
            FROM attendance WHERE user_id=? AND attendance_date BETWEEN ? AND ?
            """,
            (employee["id"], dfrom.isoformat(), dto.isoformat()),
        ).fetchone()
        rows = conn.execute(
            """
            SELECT attendance_date,login_time,logout_time,total_hours,overtime,late_mark,break_taken,status
            FROM attendance WHERE user_id=? AND attendance_date BETWEEN ? AND ?
            ORDER BY attendance_date DESC,id DESC
            """,
            (employee["id"], dfrom.isoformat(), dto.isoformat()),
        ).fetchall()

    wb = Workbook()
    ws = wb.active
    ws.title = "Employee Summary"
    ws.append(["Employee Name", employee["name"]])
    ws.append(["Employee Code", employee["employee_code"]])
    ws.append([])
    ws.append(["From", dfrom.isoformat(), "To", dto.isoformat()])
    ws.append([])
    ws.append(["Absent", "Total Days Worked", "Late", "Total Hours", "Overtime"])
    ws.append([summary["absent_count"], summary["total_days_worked"], summary["late_count"], summary["total_hours"], summary["overtime_hours"]])
    ws.append([])
    ws.append(["Date", "Login", "Logout", "Hours", "OT", "Late", "Break", "Status"])
    for r in rows:
        ws.append([r["attendance_date"], r["login_time"], r["logout_time"], r["total_hours"], r["overtime"], r["late_mark"], r["break_taken"], r["status"]])

    out = io.BytesIO()
    wb.save(out)
    out.seek(0)
    return send_file(out, mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", as_attachment=True, download_name=f"employee_summary_{code}_{dfrom.isoformat()}_{dto.isoformat()}.xlsx")


@app.post("/api/admin/attendance/edit")
@api_guard("ADMIN")
def admin_attendance_edit():
    d = request.get_json(silent=True) or {}
    code = str(d.get("employee_code", "")).strip()
    att_date = str(d.get("attendance_date", "")).strip()
    if not code or not att_date:
        return jsonify({"message": "employee_code and attendance_date are required"}), 400
    try:
        date.fromisoformat(att_date)
    except ValueError:
        return jsonify({"message": "attendance_date must be YYYY-MM-DD"}), 400

    has_login = "login_time" in d
    has_logout = "logout_time" in d
    has_break = "break_taken" in d
    has_shift = "shift_id" in d
    if not any([has_login, has_logout, has_break, has_shift]):
        return jsonify({"message": "No fields to update"}), 400
    shift_id = None
    if has_shift:
        try:
            shift_id = int(d.get("shift_id"))
        except Exception:
            return jsonify({"message": "shift_id must be an integer"}), 400

    with conn_db() as conn:
        user = conn.execute("SELECT id,employee_code,shift_id FROM users WHERE employee_code=?", (code,)).fetchone()
        if not user:
            return jsonify({"message": "Employee not found"}), 404
        if has_shift:
            sh = conn.execute("SELECT id FROM shifts WHERE id=?", (shift_id,)).fetchone()
            if not sh:
                return jsonify({"message": "Shift not found"}), 404
        row = conn.execute("SELECT * FROM attendance WHERE user_id=? AND attendance_date=? ORDER BY id DESC LIMIT 1", (user["id"], att_date)).fetchone()
        if not row:
            return jsonify({"message": "Attendance not found for selected date"}), 404

        fields, params = [], []
        if has_login:
            login_time = d.get("login_time")
            if login_time:
                parse_dt(login_time)
            fields.append("login_time=?")
            params.append(login_time)
        if has_logout:
            logout_time = d.get("logout_time")
            if logout_time:
                parse_dt(logout_time)
            fields.append("logout_time=?")
            params.append(logout_time)
        if has_break:
            b = d.get("break_taken")
            if isinstance(b, bool):
                break_taken = int(b)
            elif isinstance(b, (int, float)) and int(b) in {0, 1}:
                break_taken = int(b)
            elif isinstance(b, str) and b.strip().lower() in {"0", "1", "true", "false", "yes", "no"}:
                break_taken = 1 if b.strip().lower() in {"1", "true", "yes"} else 0
            else:
                return jsonify({"message": "break_taken must be true/false"}), 400
            fields.append("break_taken=?")
            params.append(break_taken)

        fields.append("updated_at=?")
        params.append(now_iso())
        params.append(row["id"])
        conn.execute(f"UPDATE attendance SET {', '.join(fields)} WHERE id=?", tuple(params))

        if has_shift:
            conn.execute("UPDATE users SET shift_id=? WHERE id=?", (shift_id, user["id"]))

        latest = conn.execute("SELECT * FROM attendance WHERE id=?", (row["id"],)).fetchone()
        if latest["login_time"] and latest["logout_time"]:
            recalc_attendance(conn, int(row["id"]))
        else:
            conn.execute(
                "UPDATE attendance SET total_hours=NULL,overtime=NULL,late_mark=0,status='PRESENT',updated_at=? WHERE id=?",
                (now_iso(), row["id"]),
            )
        new = dict(conn.execute("SELECT * FROM attendance WHERE id=?", (row["id"],)).fetchone())
        conn.commit()
    return jsonify({"message": "Attendance updated", "item": new})


@app.get("/api/employee/my-attendance")
@api_guard("EMPLOYEE")
def my_attendance():
    u = request.current_user
    try:
        dfrom, dto = resolve_date_range(request.args.get("from"), request.args.get("to"))
        page = max(1, int(request.args.get("page", 1)))
        page_size = max(1, min(200, int(request.args.get("page_size", 25))))
    except Exception as e:
        return jsonify({"message": str(e)}), 400
    offset = (page - 1) * page_size
    with conn_db() as conn:
        total = conn.execute("SELECT COUNT(*) cnt FROM attendance WHERE user_id=? AND attendance_date BETWEEN ? AND ?", (u["id"], dfrom.isoformat(), dto.isoformat())).fetchone()["cnt"]
        rows = conn.execute("SELECT * FROM attendance WHERE user_id=? AND attendance_date BETWEEN ? AND ? ORDER BY attendance_date DESC,id DESC LIMIT ? OFFSET ?", (u["id"], dfrom.isoformat(), dto.isoformat(), page_size, offset)).fetchall()
    return jsonify({"items": to_items(rows), "page": page, "page_size": page_size, "total": total})


@app.get("/api/employee/my-summary")
@api_guard("EMPLOYEE")
def my_summary():
    u = request.current_user
    try:
        dfrom, dto = resolve_date_range(request.args.get("from"), request.args.get("to"))
    except Exception as e:
        return jsonify({"message": str(e)}), 400
    with conn_db() as conn:
        row = conn.execute(
            """
            SELECT COUNT(*) total_days,
            SUM(CASE WHEN status='PRESENT' THEN 1 ELSE 0 END) present_count,
            SUM(CASE WHEN status='ABSENT' THEN 1 ELSE 0 END) absent_count,
            SUM(CASE WHEN late_mark=1 THEN 1 ELSE 0 END) late_count,
            SUM(CASE WHEN break_taken=1 THEN 1 ELSE 0 END) break_taken_days,
            SUM(COALESCE(total_hours,0)) total_hours,
            SUM(COALESCE(overtime,0)) overtime_hours
            FROM attendance WHERE user_id=? AND attendance_date BETWEEN ? AND ?
            """,
            (u["id"], dfrom.isoformat(), dto.isoformat()),
        ).fetchone()
    return jsonify(dict(row))


@app.get("/api/employee/today-break")
@api_guard("EMPLOYEE")
def employee_today_break():
    u = request.current_user
    today = now_ist().date().isoformat()
    with conn_db() as conn:
        row = conn.execute("SELECT id,attendance_date,break_taken FROM attendance WHERE user_id=? AND attendance_date=? ORDER BY id DESC LIMIT 1", (u["id"], today)).fetchone()
    if not row:
        return jsonify({"attendance_date": today, "break_taken": None, "can_update": False})
    return jsonify({"attendance_date": row["attendance_date"], "break_taken": int(row["break_taken"] or 0), "can_update": True})


@app.post("/api/employee/today-break")
@api_guard("EMPLOYEE")
def employee_today_break_update():
    u = request.current_user
    d = request.get_json(silent=True) or {}
    raw = d.get("break_taken")
    if isinstance(raw, bool):
        break_taken = int(raw)
    elif isinstance(raw, (int, float)) and int(raw) in {0, 1}:
        break_taken = int(raw)
    elif isinstance(raw, str) and raw.strip().lower() in {"0", "1", "true", "false", "yes", "no"}:
        break_taken = 1 if raw.strip().lower() in {"1", "true", "yes"} else 0
    else:
        return jsonify({"message": "break_taken must be true/false"}), 400

    today = now_ist().date().isoformat()
    with conn_db() as conn:
        row = conn.execute("SELECT * FROM attendance WHERE user_id=? AND attendance_date=? ORDER BY id DESC LIMIT 1", (u["id"], today)).fetchone()
        if not row:
            return jsonify({"message": "No attendance record found for today"}), 400
        conn.execute("UPDATE attendance SET break_taken=?,updated_at=? WHERE id=?", (break_taken, now_iso(), row["id"]))
        conn.commit()
    return jsonify({"message": "Break status updated", "attendance_date": today, "break_taken": break_taken})


@app.get("/api/admin/users")
@api_guard("ADMIN")
def users_list():
    with conn_db() as conn:
        rows = conn.execute("SELECT u.id,u.name,u.role,u.employee_code,u.pin_plain,u.active,u.created_at,u.category_id,u.shift_id,COALESCE(c.name,'General') category_name,COALESCE(s.name,'General Shift') shift_name FROM users u LEFT JOIN employee_categories c ON c.id=u.category_id LEFT JOIN shifts s ON s.id=u.shift_id ORDER BY u.id").fetchall()
    items = [dict(r) for r in rows]
    for i in items:
        i["pin_set"] = True
    return jsonify({"items": items})


@app.post("/api/admin/users")
@api_guard("ADMIN")
def users_create():
    d = request.get_json(silent=True) or {}
    name = str(d.get("name", "")).strip()
    role = str(d.get("role", "EMPLOYEE")).strip().upper()
    code = str(d.get("employee_code", "")).strip()
    pin = str(d.get("pin", "")).strip()
    if not name or role not in {"ADMIN", "EMPLOYEE"} or not code or not valid_pin(pin):
        return jsonify({"message": "Invalid user payload"}), 400
    cid = int(d.get("category_id", 1))
    sid = int(d.get("shift_id", 1))
    active = int(d.get("active", 1))
    with conn_db() as conn:
        try:
            cur = conn.execute("INSERT INTO users (name,role,employee_code,pin_hash,pin_plain,category_id,shift_id,category_hours,active,created_at) VALUES (?,?,?,?,?,?,?,9,?,?)", (name, role, code, generate_password_hash(pin), pin, cid, sid, active, now_iso()))
            conn.commit()
        except sqlite3.IntegrityError as e:
            return jsonify({"message": str(e)}), 400
    return jsonify({"message": "User created", "id": int(cur.lastrowid)})


@app.put("/api/admin/users/<int:user_id>")
@api_guard("ADMIN")
def users_update(user_id):
    d = request.get_json(silent=True) or {}
    fields, params = [], []
    def put(name, val):
        fields.append(f"{name}=?"); params.append(val)
    if "name" in d: put("name", str(d.get("name", "")).strip())
    if "role" in d:
        role = str(d.get("role", "")).strip().upper()
        if role not in {"ADMIN", "EMPLOYEE"}: return jsonify({"message": "Invalid role"}), 400
        put("role", role)
    if "employee_code" in d: put("employee_code", str(d.get("employee_code", "")).strip())
    if "category_id" in d: put("category_id", int(d.get("category_id")))
    if "shift_id" in d: put("shift_id", int(d.get("shift_id")))
    if "active" in d: put("active", int(d.get("active")))
    if "pin" in d:
        pin = str(d.get("pin", "")).strip()
        if not valid_pin(pin): return jsonify({"message": "PIN must be 4 digits"}), 400
        put("pin_hash", generate_password_hash(pin))
        put("pin_plain", pin)
    if not fields: return jsonify({"message": "No fields to update"}), 400
    params.append(user_id)
    with conn_db() as conn:
        try:
            conn.execute(f"UPDATE users SET {', '.join(fields)} WHERE id=?", tuple(params))
            conn.commit()
        except sqlite3.IntegrityError as e:
            return jsonify({"message": str(e)}), 400
    return jsonify({"message": "User updated"})


@app.get("/api/admin/categories")
@api_guard("ADMIN")
def categories_list():
    with conn_db() as conn:
        rows = conn.execute("SELECT * FROM employee_categories ORDER BY id").fetchall()
    return jsonify({"items": to_items(rows)})


@app.post("/api/admin/categories")
@api_guard("ADMIN")
def categories_create():
    d = request.get_json(silent=True) or {}
    try:
        name = str(d.get("name", "")).strip(); req = float(d.get("required_hours"))
    except Exception:
        return jsonify({"message": "Invalid category payload"}), 400
    with conn_db() as conn:
        try:
            cur = conn.execute("INSERT INTO employee_categories (name,required_hours) VALUES (?,?)", (name, req)); conn.commit()
        except sqlite3.IntegrityError as e:
            return jsonify({"message": str(e)}), 400
    return jsonify({"message": "Category created", "id": int(cur.lastrowid)})


@app.put("/api/admin/categories/<int:category_id>")
@api_guard("ADMIN")
def categories_update(category_id):
    d = request.get_json(silent=True) or {}
    fields, params = [], []
    if "name" in d: fields.append("name=?"); params.append(str(d.get("name", "")).strip())
    if "required_hours" in d: fields.append("required_hours=?"); params.append(float(d.get("required_hours")))
    if not fields: return jsonify({"message": "No fields to update"}), 400
    params.append(category_id)
    with conn_db() as conn:
        try:
            conn.execute(f"UPDATE employee_categories SET {', '.join(fields)} WHERE id=?", tuple(params)); conn.commit()
        except sqlite3.IntegrityError as e:
            return jsonify({"message": str(e)}), 400
    return jsonify({"message": "Category updated"})


@app.get("/api/admin/shifts")
@api_guard("ADMIN")
def shifts_list():
    with conn_db() as conn:
        rows = conn.execute("SELECT * FROM shifts ORDER BY id").fetchall()
    return jsonify({"items": to_items(rows)})


@app.post("/api/admin/shifts")
@api_guard("ADMIN")
def shifts_create():
    d = request.get_json(silent=True) or {}
    try:
        name = str(d.get("name", "")).strip(); st = str(d.get("start_time", "")).strip(); et = str(d.get("end_time", "")).strip(); g = int(d.get("grace_minutes", 15)); time.fromisoformat(st); time.fromisoformat(et)
    except Exception:
        return jsonify({"message": "Invalid shift payload"}), 400
    with conn_db() as conn:
        try:
            cur = conn.execute("INSERT INTO shifts (name,start_time,end_time,grace_minutes) VALUES (?,?,?,?)", (name, st, et, g)); conn.commit()
        except sqlite3.IntegrityError as e:
            return jsonify({"message": str(e)}), 400
    return jsonify({"message": "Shift created", "id": int(cur.lastrowid)})


@app.put("/api/admin/shifts/<int:shift_id>")
@api_guard("ADMIN")
def shifts_update(shift_id):
    d = request.get_json(silent=True) or {}
    fields, params = [], []
    if "name" in d: fields.append("name=?"); params.append(str(d.get("name", "")).strip())
    if "start_time" in d: time.fromisoformat(str(d.get("start_time"))); fields.append("start_time=?"); params.append(str(d.get("start_time")))
    if "end_time" in d: time.fromisoformat(str(d.get("end_time"))); fields.append("end_time=?"); params.append(str(d.get("end_time")))
    if "grace_minutes" in d: fields.append("grace_minutes=?"); params.append(int(d.get("grace_minutes")))
    if not fields: return jsonify({"message": "No fields to update"}), 400
    params.append(shift_id)
    with conn_db() as conn:
        try:
            conn.execute(f"UPDATE shifts SET {', '.join(fields)} WHERE id=?", tuple(params)); conn.commit()
        except sqlite3.IntegrityError as e:
            return jsonify({"message": str(e)}), 400
    return jsonify({"message": "Shift updated"})

def recalc_attendance(conn, attendance_id):
    a = conn.execute("SELECT * FROM attendance WHERE id=?", (attendance_id,)).fetchone()
    if not a or not a["login_time"] or not a["logout_time"]:
        return
    p = user_profile(conn, int(a["user_id"]))
    if not p:
        return
    m = calc_metrics(a["login_time"], a["logout_time"], p)
    conn.execute("UPDATE attendance SET total_hours=?,overtime=?,late_mark=?,status=?,updated_at=? WHERE id=?", (m["total_hours"], m["overtime"], m["late_mark"], m["status"], now_iso(), attendance_id))


@app.get("/api/admin/export.xlsx")
@api_guard("ADMIN")
def export_xlsx():
    try:
        from openpyxl import Workbook
    except ImportError:
        return jsonify({"message": "openpyxl is required for export"}), 500

    try:
        dfrom, dto, status, uid, sid, cid = parse_filters()
    except Exception as e:
        return jsonify({"message": str(e)}), 400
    where, params = attendance_where(dfrom, dto, status, uid, sid, cid)

    with conn_db() as conn:
        rows = conn.execute(
            f"""
            SELECT u.name employee,a.attendance_date,a.login_time,a.logout_time,a.total_hours,a.overtime,
                   a.late_mark,a.break_taken,a.status,
                   COALESCE(s.name,'General Shift') shift_name,COALESCE(c.name,'General') category_name
            FROM attendance a JOIN users u ON u.id=a.user_id
            LEFT JOIN shifts s ON s.id=u.shift_id LEFT JOIN employee_categories c ON c.id=u.category_id
            WHERE {where} ORDER BY a.attendance_date DESC,a.id DESC
            """,
            tuple(params),
        ).fetchall()

    wb = Workbook()
    ws = wb.active
    ws.title = "Attendance"
    ws.append(["Employee", "Date", "Login", "Logout", "Hours", "OT", "Late", "Break Taken", "Status", "Shift", "Category"])
    for r in rows:
        ws.append([r["employee"], r["attendance_date"], r["login_time"], r["logout_time"], r["total_hours"], r["overtime"], r["late_mark"], r["break_taken"], r["status"], r["shift_name"], r["category_name"]])
    out = io.BytesIO(); wb.save(out); out.seek(0)
    return send_file(out, mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", as_attachment=True, download_name=f"attendance_{dfrom.isoformat()}_{dto.isoformat()}.xlsx")


@app.get("/api/employee/export.xlsx")
@api_guard("EMPLOYEE")
def export_my_attendance_xlsx():
    try:
        from openpyxl import Workbook
    except ImportError:
        return jsonify({"message": "openpyxl is required for export"}), 500

    u = request.current_user
    try:
        dfrom, dto = resolve_date_range(request.args.get("from"), request.args.get("to"))
    except Exception as e:
        return jsonify({"message": str(e)}), 400

    with conn_db() as conn:
        rows = conn.execute(
            """
            SELECT attendance_date,login_time,logout_time,total_hours,overtime,late_mark,break_taken,status
            FROM attendance WHERE user_id=? AND attendance_date BETWEEN ? AND ?
            ORDER BY attendance_date DESC,id DESC
            """,
            (u["id"], dfrom.isoformat(), dto.isoformat()),
        ).fetchall()

    wb = Workbook()
    ws = wb.active
    ws.title = "My Attendance"
    ws.append(["Date", "Login", "Logout", "Hours", "OT", "Late", "Break Taken", "Status"])
    for r in rows:
        ws.append([r["attendance_date"], r["login_time"], r["logout_time"], r["total_hours"], r["overtime"], r["late_mark"], r["break_taken"], r["status"]])
    out = io.BytesIO()
    wb.save(out)
    out.seek(0)
    return send_file(out, mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", as_attachment=True, download_name=f"my_attendance_{dfrom.isoformat()}_{dto.isoformat()}.xlsx")


init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)
