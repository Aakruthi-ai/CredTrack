"""SQLite database + JWT auth helpers for CredTrack."""
import hashlib
import hmac
import os
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import jwt

HERE = Path(__file__).parent
# On a host with a persistent disk, point DATA_DIR at it so accounts survive redeploys.
DATA_DIR = Path(os.environ.get("DATA_DIR", str(HERE)))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "app.db"
SECRET_FILE = DATA_DIR / ".jwt_secret"

# Production: set the JWT_SECRET environment variable. Locally, a random one is created once and saved.
JWT_SECRET = os.environ.get("JWT_SECRET", "").strip()
if not JWT_SECRET:
    if SECRET_FILE.exists():
        JWT_SECRET = SECRET_FILE.read_text().strip()
    else:
        JWT_SECRET = secrets.token_urlsafe(48)
        SECRET_FILE.write_text(JWT_SECRET)
        try:
            SECRET_FILE.chmod(0o600)
        except OSError:
            pass

JWT_ALG = "HS256"
JWT_EXPIRE_DAYS = 7
PBKDF2_ITER = 200_000


def init_db():
    with get_conn() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                full_name TEXT,
                work_phone TEXT,
                home_phone TEXT,
                email_address TEXT,
                monthly_budget REAL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS expenses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                amount REAL NOT NULL,
                category TEXT NOT NULL,
                description TEXT,
                expense_date TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
            CREATE INDEX IF NOT EXISTS idx_expenses_user_date ON expenses(user_id, expense_date);
            CREATE TABLE IF NOT EXISTS streaks (
                user_id INTEGER PRIMARY KEY,
                current_streak INTEGER DEFAULT 0,
                longest_streak INTEGER DEFAULT 0,
                last_activity TEXT,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
            CREATE TABLE IF NOT EXISTS applications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                risk REAL NOT NULL,
                decision TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
        """)
        # Older databases only had risk + decision. Add the newer columns without losing history.
        have = {r["name"] for r in conn.execute("PRAGMA table_info(applications)")}
        for col, ddl in [("score", "INTEGER"), ("rule_triggered", "INTEGER DEFAULT 0"),
                         ("round", "INTEGER DEFAULT 1"), ("annual_income", "REAL"),
                         ("loan_amount", "REAL"), ("instalment_amount", "REAL"), ("reason", "TEXT")]:
            if col not in have:
                conn.execute(f"ALTER TABLE applications ADD COLUMN {col} {ddl}")


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    key = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITER, dklen=32)
    return f"{salt.hex()}:{key.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, key_hex = stored.split(":")
        key = hashlib.pbkdf2_hmac("sha256", password.encode(),
                                  bytes.fromhex(salt_hex), PBKDF2_ITER, dklen=32)
        return hmac.compare_digest(key.hex(), key_hex)
    except Exception:
        return False


def create_token(user_id: int) -> str:
    return jwt.encode({"sub": str(user_id),
                       "exp": datetime.now(timezone.utc) + timedelta(days=JWT_EXPIRE_DAYS)},
                      JWT_SECRET, algorithm=JWT_ALG)


def decode_token(token: str) -> Optional[int]:
    try:
        return int(jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])["sub"])
    except Exception:
        return None


def touch_streak(user_id: int) -> dict:
    today = date.today().isoformat()
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM streaks WHERE user_id = ?", (user_id,)).fetchone()
        if not row:
            conn.execute("INSERT INTO streaks (user_id, current_streak, longest_streak, last_activity) "
                         "VALUES (?, 1, 1, ?)", (user_id, today))
            return {"current_streak": 1, "longest_streak": 1}
        if row["last_activity"] == today:
            return {"current_streak": row["current_streak"],
                    "longest_streak": row["longest_streak"]}
        new = row["current_streak"] + 1 if row["last_activity"] == yesterday else 1
        longest = max(row["longest_streak"], new)
        conn.execute("UPDATE streaks SET current_streak = ?, longest_streak = ?, last_activity = ? "
                     "WHERE user_id = ?", (new, longest, today, user_id))
        return {"current_streak": new, "longest_streak": longest}


def read_streak(user_id: int) -> dict:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM streaks WHERE user_id = ?", (user_id,)).fetchone()
    if not row:
        return {"current_streak": 0, "longest_streak": 0, "last_activity": None}
    current = row["current_streak"]
    if row["last_activity"] and (date.today() - date.fromisoformat(row["last_activity"])).days > 1:
        current = 0
    return {"current_streak": current, "longest_streak": row["longest_streak"],
            "last_activity": row["last_activity"]}