import base64
import io
import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

import qrcode
from flask import Flask, jsonify, request
from flask_cors import CORS

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "database.db"
PUBLIC_DIR = BASE_DIR / "public"

app = Flask(__name__, static_folder=str(PUBLIC_DIR), static_url_path="")
CORS(app)


def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                name TEXT,
                category_hours INTEGER
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS attendance (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                login_time TEXT,
                logout_time TEXT,
                total_hours REAL,
                overtime REAL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS qr_sessions (
                id TEXT PRIMARY KEY,
                user_id INTEGER,
                purpose TEXT,
                expires_at INTEGER,
                used INTEGER DEFAULT 0
            )
            """
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO users (id, name, category_hours)
            VALUES (1, 'Employee1', 9)
            """
        )
        conn.commit()


def now_epoch_ms():
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def qr_data_url(payload: dict):
    qr_text = json.dumps(payload)
    image = qrcode.make(qr_text)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


@app.post("/generate-qr")
def generate_qr():
    data = request.get_json(silent=True) or {}
    user_id = data.get("user_id")
    purpose = data.get("purpose")

    if not isinstance(user_id, int) or purpose not in {"login", "logout"}:
        return jsonify({"message": "Invalid request payload"}), 400

    session_id = str(uuid.uuid4())
    expires_at = now_epoch_ms() + 60000

    with get_db_connection() as conn:
        conn.execute(
            """
            INSERT INTO qr_sessions (id, user_id, purpose, expires_at)
            VALUES (?, ?, ?, ?)
            """,
            (session_id, user_id, purpose, expires_at),
        )
        conn.commit()

    return jsonify({"qr": qr_data_url({"session_id": session_id}), "session_id": session_id})


@app.post("/scan")
def scan_qr():
    data = request.get_json(silent=True) or {}
    session_id = data.get("session_id")

    if not isinstance(session_id, str) or not session_id.strip():
        return jsonify({"message": "Invalid or expired QR"}), 400

    now_ms = now_epoch_ms()
    now = now_iso()

    with get_db_connection() as conn:
        session = conn.execute(
            "SELECT * FROM qr_sessions WHERE id = ?", (session_id,)
        ).fetchone()

        if not session or session["used"] or session["expires_at"] < now_ms:
            return jsonify({"message": "Invalid or expired QR"}), 400

        conn.execute("UPDATE qr_sessions SET used = 1 WHERE id = ?", (session_id,))

        if session["purpose"] == "login":
            conn.execute(
                """
                INSERT INTO attendance (user_id, login_time)
                VALUES (?, ?)
                """,
                (session["user_id"], now),
            )
            conn.commit()
            return jsonify({"message": "Login Recorded"})

        if session["purpose"] == "logout":
            record = conn.execute(
                """
                SELECT * FROM attendance
                WHERE user_id = ? AND logout_time IS NULL
                """,
                (session["user_id"],),
            ).fetchone()

            if not record:
                conn.commit()
                return jsonify({"message": "No login found"}), 400

            login = datetime.fromisoformat(record["login_time"])
            logout = datetime.fromisoformat(now)
            hours = (logout - login).total_seconds() / 3600

            user = conn.execute(
                "SELECT category_hours FROM users WHERE id = ?", (session["user_id"],)
            ).fetchone()
            category_hours = user["category_hours"] if user else 0
            overtime = max(0, hours - category_hours)

            conn.execute(
                """
                UPDATE attendance
                SET logout_time = ?, total_hours = ?, overtime = ?
                WHERE id = ?
                """,
                (now, hours, overtime, record["id"]),
            )
            conn.commit()
            return jsonify({"message": "Logout Recorded"})

        conn.commit()
        return jsonify({"message": "Invalid or expired QR"}), 400


init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)
