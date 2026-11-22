"""Auth, expense tracking, streaks, and application history routes."""
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from db import (
    get_conn, hash_password, verify_password, create_token, decode_token,
    touch_streak, read_streak,
)

router = APIRouter()


# ---------------- auth dependency ----------------
def current_user(authorization: Optional[str] = Header(None)) -> Optional[dict]:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    uid = decode_token(authorization[7:])
    if uid is None:
        return None
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
    return dict(row) if row else None


def require_user(user: Optional[dict] = Depends(current_user)) -> dict:
    if not user:
        raise HTTPException(401, "Authentication required")
    return user


def public_user(u: dict) -> dict:
    return {
        "id": u["id"], "email": u["email"], "full_name": u["full_name"],
        "work_phone": u["work_phone"], "home_phone": u["home_phone"],
        "email_address": u["email_address"], "monthly_budget": u["monthly_budget"],
        "created_at": u["created_at"],
    }


# ---------------- models ----------------
class SignupBody(BaseModel):
    email: str
    password: str = Field(min_length=6)
    full_name: str = ""


class LoginBody(BaseModel):
    email: str
    password: str


class ExpenseBody(BaseModel):
    amount: float = Field(gt=0, le=10_000_000)
    category: str = Field(min_length=1, max_length=60)
    description: str = Field(default="", max_length=200)
    expense_date: Optional[str] = None


class ProfileUpdate(BaseModel):
    full_name: Optional[str] = None
    work_phone: Optional[str] = None
    home_phone: Optional[str] = None
    email_address: Optional[str] = None
    monthly_budget: Optional[float] = None


# ---------------- auth ----------------
@router.post("/auth/signup")
def signup(body: SignupBody):
    email = body.email.strip().lower()
    if "@" not in email or "." not in email.split("@")[-1]:
        raise HTTPException(400, "Please enter a valid email address")
    with get_conn() as conn:
        if conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
            raise HTTPException(409, "An account with this email already exists")
        cur = conn.execute(
            "INSERT INTO users (email, password_hash, full_name) VALUES (?, ?, ?)",
            (email, hash_password(body.password), body.full_name.strip()))
        uid = cur.lastrowid
        row = conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
    return {"token": create_token(uid), "user": public_user(dict(row))}


@router.post("/auth/login")
def login(body: LoginBody):
    email = body.email.strip().lower()
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if not row or not verify_password(body.password, row["password_hash"]):
        raise HTTPException(401, "Incorrect email or password")
    return {"token": create_token(row["id"]), "user": public_user(dict(row))}


@router.get("/auth/me")
def me(user: dict = Depends(require_user)):
    return public_user(user)


@router.put("/profile")
def update_profile(body: ProfileUpdate, user: dict = Depends(require_user)):
    fields = {}
    if body.full_name     is not None: fields["full_name"]     = body.full_name.strip()
    if body.work_phone    is not None: fields["work_phone"]    = body.work_phone.strip() or None
    if body.home_phone    is not None: fields["home_phone"]    = body.home_phone.strip() or None
    if body.email_address is not None: fields["email_address"] = body.email_address.strip() or None
    if body.monthly_budget is not None: fields["monthly_budget"] = body.monthly_budget
    if not fields:
        return public_user(user)
    clause = ", ".join(f"{k} = ?" for k in fields)
    with get_conn() as conn:
        conn.execute(f"UPDATE users SET {clause} WHERE id = ?", (*fields.values(), user["id"]))
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
    return public_user(dict(row))


# ---------------- expenses ----------------
@router.get("/expenses")
def list_expenses(user: dict = Depends(require_user)):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, amount, category, description, expense_date, created_at FROM expenses "
            "WHERE user_id = ? ORDER BY expense_date DESC, id DESC",
            (user["id"],)).fetchall()
    return [dict(r) for r in rows]


@router.post("/expenses")
def add_expense(body: ExpenseBody, user: dict = Depends(require_user)):
    d = body.expense_date or date.today().isoformat()
    try:
        parsed = date.fromisoformat(d[:10])
    except ValueError:
        raise HTTPException(400, "Please enter a valid date")
    if parsed > date.today() + timedelta(days=1):
        raise HTTPException(400, "The expense date cannot be in the future")
    d = parsed.isoformat()
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO expenses (user_id, amount, category, description, expense_date) "
            "VALUES (?, ?, ?, ?, ?)",
            (user["id"], body.amount, body.category.strip(), body.description.strip(), d))
        row = conn.execute("SELECT * FROM expenses WHERE id = ?", (cur.lastrowid,)).fetchone()
    streak = touch_streak(user["id"])
    return {"expense": dict(row), "streak": streak}


@router.delete("/expenses/{expense_id}")
def delete_expense(expense_id: int, user: dict = Depends(require_user)):
    with get_conn() as conn:
        conn.execute("DELETE FROM expenses WHERE id = ? AND user_id = ?", (expense_id, user["id"]))
    return {"ok": True}


# ---------------- streak ----------------
@router.get("/streak")
def streak(user: dict = Depends(require_user)):
    return read_streak(user["id"])


# ---------------- application history ----------------
@router.get("/applications")
def applications(user: dict = Depends(require_user)):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, risk, decision, score, rule_triggered, round, annual_income, loan_amount, "
            "instalment_amount, reason, created_at FROM applications "
            "WHERE user_id = ? ORDER BY id DESC LIMIT 20",
            (user["id"],)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        # SQLite stores UTC without a marker; add 'Z' so the browser shows the user's local time.
        if d.get("created_at"):
            d["created_at"] = d["created_at"].replace(" ", "T") + "Z"
        out.append(d)
    return out