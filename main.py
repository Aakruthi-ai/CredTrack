"""Credit risk API: /predict, /reassess, /stress-test, /recourse, /notice  (+ /options, /health).

Decision flow:  risk below 10% -> approved | 10% to 15% -> borderline: the applicant confirms or changes
their details and /reassess re-runs the model for a FINAL approved/rejected decision | above 15% -> rejected.
Two hard policy rules reject outright: instalment over 60% of income, loan over 15 times income.

Run:   uvicorn main:app --reload        (docs page: http://localhost:8000/docs)
Needs: model.json and meta.json next to this file (made by train_final.py).
"""
import json
import math
import os
from datetime import date
from pathlib import Path
from typing import Literal, Optional

import numpy as np
import pandas as pd
import xgboost as xgb
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

from db import init_db, get_conn
from user_routes import router as user_router, current_user

HERE = Path(__file__).parent
META = json.loads((HERE / "meta.json").read_text())
FEATURES = META["features"]
CAPS = META["caps"]
APPROVE_BELOW = META["thresholds"]["approve_below"]
REJECT_ABOVE = META["thresholds"]["reject_above"]
model = xgb.XGBClassifier()
model.load_model(str(HERE / "model.json"))
booster = model.get_booster()
# Early stopping saved 100 extra trees after the best one. Predictions use only the best trees,
# so the explanations (SHAP) must use exactly the same trees or they will not add up to the risk.
try:
    BEST_ITER = int(model.best_iteration) + 1
except Exception:
    BEST_ITER = 0          # 0 = use every tree (model saved without early stopping)

IncomeType = Literal[tuple(META["income_types"])]
RULE_LIMIT = META["rules"]["max_instalment_share_of_income"]
LTI_LIMIT = META["rules"]["max_loan_to_income"]
RULE_SCORE_CAP = META["rules"]["score_cap_when_rule_triggers"]

# Applicants with NO repayment history are scored with a REFERENCE HISTORY (see calibrate_new_to_credit.py):
# a small, calibrated history chosen so that, on average, the model predicts what really happens to new
# borrowers. Without it the model sends them down a separate branch that scores them better than people
# with a spotless record. If meta.json has no profile, the old behaviour is used.
HISTORY_KEYS = ("n_installments", "late_payment_share", "underpaid_share", "avg_days_late",
                "max_days_late", "avg_payment_ratio", "recent_late_share")
NTC = {k: float(v) for k, v in META.get("new_to_credit_profile", {}).items() if k in HISTORY_KEYS}
NTC_NOTE = ("You have no repayment history yet, so you were scored like a typical new borrower: "
            "no reward and no penalty for having no history.")

# ---------------------------------------------------------------- plain-language names and reasons
LABEL = {
    "late_payment_share": "Share of past instalments paid late",
    "avg_days_late": "Average days late on past instalments",
    "max_days_late": "Longest delay on a past instalment",
    "underpaid_share": "Share of past instalments paid only in part",
    "avg_payment_ratio": "Share of each instalment actually paid",
    "recent_late_share": "Late payments in the last 12 months",
    "n_installments": "Length of payment history",
    "no_history_flag": "No payment history yet (scored as a typical new borrower)",
    "debt_to_income": "Loan repayment compared with income",
    "credit_to_income": "Loan amount compared with income",
    "income": "Income",
    "credit_amount": "Loan amount",
    "annuity": "Size of the repayment instalment",
    "annuity_missing": "Size of the repayment instalment",
    "years_employed": "Time in current job",
    "not_employed_flag": "Employment status",
    "NAME_INCOME_TYPE": "Type of income",
    "years_since_phone_change": "How long the same phone number has been kept",
    "CNT_CHILDREN": "Number of children",
    "CNT_FAM_MEMBERS": "Family size",
    "FLAG_MOBIL": "Contact details provided", "FLAG_WORK_PHONE": "Contact details provided",
    "FLAG_PHONE": "Contact details provided", "FLAG_EMAIL": "Contact details provided",
}
REASON_TEXT = {
    "Share of past instalments paid late": "A large share of your past instalments were paid after the due date.",
    "Average days late on past instalments": "Your past instalments were paid several days late on average.",
    "Longest delay on a past instalment": "At least one past instalment was paid very late.",
    "Share of past instalments paid only in part": "Some past instalments were only partly paid.",
    "Share of each instalment actually paid": "On average, less than the full instalment amount was paid.",
    "Late payments in the last 12 months": "Some instalments were paid late during the last 12 months.",
    "Length of payment history": "Your payment history is short.",
    "No payment history yet (scored as a typical new borrower)": "You have no payment history yet, so there is little evidence of how you repay.",
    "Loan repayment compared with income": "The repayment instalment takes a large part of your income.",
    "Loan amount compared with income": "The loan amount is large compared with your income.",
    "Income": "Your income is low for this application.",
    "Loan amount": "The loan amount requested is high.",
    "Size of the repayment instalment": "The repayment instalment is high.",
    "Time in current job": "You have been in your current job for a short time.",
    "Employment status": "You are not currently in regular employment.",
    "Type of income": "The type of income you reported.",
    "How long the same phone number has been kept": "Your phone number has changed recently.",
    "Number of children": "The number of children you reported.",
    "Family size": "The family size you reported.",
    "Contact details provided": "The contact details you provided.",
}

HISTORY_FEATURES = {"n_installments", "late_payment_share", "underpaid_share", "avg_days_late",
                    "max_days_late", "avg_payment_ratio", "recent_late_share", "no_history_flag"}

# ---------------------------------------------------------------- stress-test scenarios (ASSUMPTIONS)
SCENARIOS = {
    "normal": dict(label="Normal times", income=1.00, instalment=1.00, late_add=0.00,
                   text="No change."),
    "inflation": dict(label="Prices rise a bit", income=0.95, instalment=1.00, late_add=0.02,
                      text="Real income falls 5% and 2 points more instalments are paid late."),
    "recession": dict(label="Recession", income=0.85, instalment=1.00, late_add=0.05,
                      text="Income falls 15% and 5 points more instalments are paid late."),
    "rate_hike": dict(label="Interest rates rise", income=1.00, instalment=1.15, late_add=0.00,
                      text="Repayment instalments rise 15%."),
    "recovery": dict(label="Economy recovering", income=1.05, instalment=1.00, late_add=0.00,
                     text="Income rises 5%."),
}

# ---------------------------------------------------------------- request models
class History(BaseModel):
    n_installments: int = Field(ge=1, le=2000, description="How many past instalments")
    late_payment_share: float = Field(ge=0, le=1, description="0.2 = 20% paid late")
    underpaid_share: float = Field(default=0, ge=0, le=1)
    avg_days_late: float = Field(default=0, ge=0, le=3650)
    max_days_late: float = Field(default=0, ge=0, le=3650)
    avg_payment_ratio: float = Field(default=1, ge=0, le=2)
    recent_late_share: Optional[float] = Field(default=None, ge=0, le=1)


class Applicant(BaseModel):
    annual_income: float = Field(gt=0, le=1e12, description="Same currency and units as the training data")
    loan_amount: float = Field(gt=0, le=1e12)
    instalment_amount: float = Field(gt=0, le=1e12, description="Size of each repayment instalment")
    employed: bool = True
    years_employed: float = Field(default=0, ge=0, le=60)
    family_members: int = Field(default=2, ge=1, le=20)
    children: int = Field(default=0, ge=0, le=20)
    income_type: IncomeType = "Working"
    years_since_phone_change: float = Field(default=2.0, ge=0, le=60)
    has_work_phone: bool = False
    has_home_phone: bool = False
    has_email: bool = False
    history: Optional[History] = Field(default=None, description="Leave out if the applicant is new to credit")
    # NEW: actual contact values — if provided, they light up the corresponding flag automatically
    work_phone:    Optional[str] = None
    home_phone:    Optional[str] = None
    email_address: Optional[str] = None

    @model_validator(mode="after")
    def _sanity(self):
        if self.instalment_amount > self.loan_amount:
            raise ValueError("The monthly instalment cannot be larger than the whole loan amount.")
        return self


# ---------------------------------------------------------------- core helpers
def to_row(a: Applicant) -> dict:
    income = min(a.annual_income, CAPS["income"])
    credit = min(a.loan_amount, CAPS["credit_amount"])
    annuity = min(a.instalment_amount, CAPS["annuity"])
    h = a.history
    row = {
        "CNT_CHILDREN": min(a.children, CAPS["CNT_CHILDREN"]), "income": income, "credit_amount": credit,
        "annuity": annuity, "NAME_INCOME_TYPE": META["income_types"].index(a.income_type),
        "FLAG_MOBIL": 1,
        # NEW: flag is on if the boolean is True OR a real contact value was provided
        "FLAG_WORK_PHONE": int(a.has_work_phone or bool(a.work_phone)),
        "FLAG_PHONE":      int(a.has_home_phone or bool(a.home_phone)),
        "FLAG_EMAIL":      int(a.has_email      or bool(a.email_address)),
        "CNT_FAM_MEMBERS": min(a.family_members, CAPS["CNT_FAM_MEMBERS"]),
        "years_since_phone_change": a.years_since_phone_change,
        "not_employed_flag": int(not a.employed), "years_employed": a.years_employed if a.employed else 0.0,
        "annuity_missing": 0,
        # With no history, fill in the calibrated reference history (or NaN if none is configured)
        "n_installments": h.n_installments if h else NTC.get("n_installments", 0),
        "late_payment_share": h.late_payment_share if h else NTC.get("late_payment_share", np.nan),
        "underpaid_share": h.underpaid_share if h else NTC.get("underpaid_share", np.nan),
        "avg_days_late": min(h.avg_days_late, 365) if h else NTC.get("avg_days_late", np.nan),
        "max_days_late": min(h.max_days_late, 365) if h else NTC.get("max_days_late", np.nan),
        "avg_payment_ratio": h.avg_payment_ratio if h else NTC.get("avg_payment_ratio", np.nan),
        "recent_late_share": (h.recent_late_share if (h and h.recent_late_share is not None)
                              else (np.nan if h else NTC.get("recent_late_share", np.nan))),
        "no_history_flag": 0 if (h or NTC) else 1,     # the model is told "history present" when a reference is used
        "new_to_credit": 0 if h else 1,                # what the app itself uses to explain and to skip history what-ifs
        # Real (uncapped) amounts. Every what-if changes THESE; refresh() then caps them for the model
        # and uses the real ones for the hard lending rules.
        "raw_income": a.annual_income, "raw_credit": a.loan_amount, "raw_annuity": a.instalment_amount,
    }
    return refresh(row)


def refresh(row: dict) -> dict:
    """Re-derive everything that depends on the real amounts: the capped values the model sees, the
    ratios, and the ratios the hard rules use (those use the real, uncapped amounts)."""
    row["income"] = min(row["raw_income"], CAPS["income"])
    row["credit_amount"] = min(row["raw_credit"], CAPS["credit_amount"])
    row["annuity"] = min(row["raw_annuity"], CAPS["annuity"])
    row["credit_to_income"] = row["credit_amount"] / row["income"]
    row["debt_to_income"] = row["annuity"] / row["income"]
    row["rule_dti"] = row["raw_annuity"] / row["raw_income"]
    row["rule_lti"] = row["raw_credit"] / row["raw_income"]
    return row


def frame(rows):
    return pd.DataFrame(rows)[FEATURES].astype(float)


def risk(rows):
    return model.predict_proba(frame(rows))[:, 1]


def score_from_risk(p: float) -> int:
    """Standard credit-score scale: 700 points at a 10% default chance, +50 points each time the
    odds of repaying double. Limited to the range 300 to 900."""
    p = min(max(float(p), 1e-6), 1 - 1e-6)
    s = 700 + 50 * math.log2(((1 - p) / p) / 9)
    return int(round(min(900, max(300, s))))


def decide(p: float) -> str:
    return "approved" if p < APPROVE_BELOW else ("borderline" if p <= REJECT_ABOVE else "rejected")


DECISION_TEXT = {
    "approved": "Approved: the estimated chance of repayment trouble is low.",
    "borderline": "Borderline: the estimated chance of repayment trouble is in the middle range (10% to 15%). "
                  "Please confirm your details for a final decision.",
    "rejected": "Rejected: the estimated chance of repayment trouble is too high.",
}


INSTALMENT_RULE_REASON = (f"The repayment instalment is more than {int(RULE_LIMIT * 100)}% of income, "
                          "which is above our lending limit.")
LOAN_RULE_REASON = (f"The loan amount is more than {LTI_LIMIT} times annual income, "
                    "which is above our lending limit.")


def rule_reasons(row: dict) -> list:
    out = []
    if row["rule_dti"] > RULE_LIMIT:
        out.append(INSTALMENT_RULE_REASON)
    if row["rule_lti"] > LTI_LIMIT:
        out.append(LOAN_RULE_REASON)
    return out


def rule_triggered(row: dict) -> bool:
    return bool(rule_reasons(row))


def final_snapshot(p: float, row: dict) -> dict:
    """Second round: no 'borderline' is left. Below 10% = approved, everything else = rejected."""
    snap = snapshot(p, row)
    if snap["decision"] == "borderline":
        snap["decision"] = "rejected"
    return snap


def snapshot(p: float, row: dict) -> dict:
    """Model risk plus the hard affordability rule. If the rule triggers, the decision is 'rejected'
    whatever the model says, and the score is capped so it never looks like an approval."""
    hit = rule_triggered(row)
    score = score_from_risk(p)
    return {"risk": round(float(p), 4), "risk_percent": round(float(p) * 100, 1),
            "score": min(score, RULE_SCORE_CAP) if hit else score,
            "decision": "rejected" if hit else decide(p), "rule_triggered": hit,
            "rule_reasons": rule_reasons(row)}


def explain(row: dict):
    """Per-factor effect on this person's risk (SHAP values from XGBoost), grouped by plain label.
    Positive = pushed risk UP, negative = pushed risk DOWN."""
    contrib = booster.predict(xgb.DMatrix(frame([row])), pred_contribs=True, iteration_range=(0, BEST_ITER))[0][:-1]
    new_to_credit = bool(row.get("new_to_credit", row["no_history_flag"] == 1))
    grouped = {}
    for f, v in zip(FEATURES, contrib):
        if new_to_credit and f in HISTORY_FEATURES:
            label = LABEL["no_history_flag"]          # one honest reason instead of several confusing ones
        elif (not new_to_credit) and f in HISTORY_FEATURES and np.isnan(row[f]):
            continue                                   # e.g. no instalments in the last 12 months: nothing to report
        else:
            label = LABEL[f]
        grouped[label] = grouped.get(label, 0.0) + float(v)
    up = sorted([(k, v) for k, v in grouped.items() if v > 0], key=lambda kv: -kv[1])
    down = sorted([(k, v) for k, v in grouped.items() if v < 0], key=lambda kv: kv[1])
    return up, down


# ---------------------------------------------------------------- what-if actions (recourse)
def with_on_time(row, k):
    n = row["n_installments"]
    if row.get("new_to_credit") or n <= 0:
        return None
    r = dict(row)
    r["late_payment_share"] = row["late_payment_share"] * n / (n + k)
    r["underpaid_share"] = row["underpaid_share"] * n / (n + k)
    r["avg_days_late"] = row["avg_days_late"] * n / (n + k)
    r["avg_payment_ratio"] = (row["avg_payment_ratio"] * n + k) / (n + k)
    if not np.isnan(row["recent_late_share"]):
        r["recent_late_share"] = row["recent_late_share"] * max(0.0, 1 - k / 12)
    r["n_installments"] = n + k
    return refresh(r)


def smaller_loan(row, f):
    r = dict(row)
    r["raw_credit"] *= f
    r["raw_annuity"] *= f
    return refresh(r)


def smaller_instalment(row, f):
    r = dict(row)
    r["raw_annuity"] *= f
    return refresh(r)


def tweak(row, **delta):
    r = dict(row)
    for k, v in delta.items():
        r[k] = r[k] + v
    return refresh(r)


def fix_rules(row):
    """Shrink the request just enough to sit inside both policy limits."""
    r = dict(row)
    f = min(1.0, 0.98 * LTI_LIMIT / row["rule_lti"])
    r["raw_credit"] *= f
    r["raw_annuity"] *= f
    r = refresh(r)
    if r["rule_dti"] > 0.98 * RULE_LIMIT:
        r["raw_annuity"] *= 0.98 * RULE_LIMIT / r["rule_dti"]
        r = refresh(r)
    return r


def actions_for(row):
    """(text, changed row, kind, apply). 'offer' = change the request now; 'habit' = takes time.
    'apply' tells the web app how to change the request: factors for the loan and instalment."""
    acts = [
        ("Pay the next 6 instalments on time", with_on_time(row, 6), "habit", None),
        ("Pay the next 12 instalments on time", with_on_time(row, 12), "habit", None),
    ]
    for pct in (10, 20, 30, 40, 50):
        f = 1 - pct / 100
        acts.append((f"Ask for a loan {pct}% smaller", smaller_loan(row, f), "offer",
                     {"loan_factor": f, "instalment_factor": f}))
    for pct in (20, 40):
        f = 1 - pct / 100
        acts.append((f"Choose a longer repayment period so each instalment is {pct}% smaller",
                     smaller_instalment(row, f), "offer", {"loan_factor": 1.0, "instalment_factor": f}))
    acts.append(("Keep the same phone number for another year", tweak(row, years_since_phone_change=1.0), "habit", None))
    if row["not_employed_flag"] == 0:
        acts.append(("Stay in your current job for another year", tweak(row, years_employed=1.0), "habit", None))
    if rule_triggered(row):
        fixed = fix_rules(row)
        acts.append((f"Change the request to within our limits (loan up to {LTI_LIMIT} times income, "
                     f"instalment up to {int(RULE_LIMIT * 100)}% of income)", fixed, "offer",
                     {"loan_factor": fixed["raw_credit"] / row["raw_credit"],
                      "instalment_factor": fixed["raw_annuity"] / row["raw_annuity"]}))
    return [a for a in acts if a[1] is not None]


RANK = {"rejected": 0, "borderline": 1, "approved": 2}


def recourse_for(row, p_now):
    base = snapshot(p_now, row)
    acts = actions_for(row)
    probs = risk([r for _, r, _, _ in acts])
    out = []
    for i, ((name, r, kind, apply), p) in enumerate(zip(acts, probs)):
        snap, change = snapshot(p, r), (float(p) - p_now) * 100
        if change <= -0.1 or RANK[snap["decision"]] > RANK[base["decision"]]:
            out.append({"action": name, "kind": kind, "order": i, "apply": apply,
                        **{f"new_{k}": v for k, v in snap.items()},
                        "risk_change_points": round(change, 1), "reaches_approval": snap["decision"] == "approved"})
    out.sort(key=lambda d: (-RANK[d["new_decision"]], d["risk_change_points"]))
    return out


# ---------------------------------------------------------------- app
app = FastAPI(title="Explainable Credit Risk API")
# The web app is served by this same server, so it needs no CORS. To call the API from another site,
# set CORS_ORIGINS to a comma-separated list of origins.
_origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=_origins, allow_methods=["*"], allow_headers=["*"])


@app.get("/healthz", include_in_schema=False)
def healthz():
    return {"status": "ok"}

# NEW: init DB + mount auth / expenses / streak / application-history routes
init_db()
app.include_router(user_router)


def save_application(user, p, snap, a, up, rnd=1):
    """Keep a row in the logged-in user's credit-check history (score, reason and request size included)."""
    if not user:
        return
    reason = snap["rule_reasons"][0] if snap["rule_triggered"] else (up[0][0] if up else "")
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO applications (user_id, risk, decision, score, rule_triggered, round, annual_income, "
            "loan_amount, instalment_amount, reason) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (user["id"], p, snap["decision"], snap["score"], int(snap["rule_triggered"]), rnd,
             a.annual_income, a.loan_amount, a.instalment_amount, reason))


@app.get("/health")
def health():
    return {"status": "ok", "test_auc": META["test_auc"], "trained_on": META["trained_on"]}


@app.get("/options")
def options():
    return {"income_types": META["income_types"], "thresholds": META["thresholds"],
            "rules": META["rules"],
            "scenarios": [{"key": k, "label": v["label"], "assumption": v["text"]} for k, v in SCENARIOS.items()]}


@app.post("/predict")
def predict(a: Applicant, user: Optional[dict] = Depends(current_user)):
    row = to_row(a)
    p = float(risk([row])[0])
    up, down = explain(row)
    snap = snapshot(p, row)
    resp = {**snap, "decision_text": rule_reasons(row)[0] if snap["rule_triggered"] else DECISION_TEXT[snap["decision"]],
            "top_risk_factors": [{"factor": k, "effect": round(v, 3)} for k, v in up[:3]],
            "top_protective_factors": [{"factor": k, "effect": round(v, 3)} for k, v in down[:3]],
            "thresholds": META["thresholds"], "new_to_credit": bool(row["new_to_credit"]),
            "history_note": NTC_NOTE if row["new_to_credit"] and NTC else None,
            "note": "Effects are in log-odds; positive pushed risk up, negative pushed it down."}

    save_application(user, p, snap, a, up, 1)

    if snap["decision"] == "borderline":
        offers = sorted([s for s in recourse_for(row, p) if s["kind"] == "offer" and s["reaches_approval"]],
                        key=lambda s: s["order"])[:3]
        resp["next_step"] = {
            "type": "confirm_details",
            "message": "Your application is borderline. Please confirm or correct your details, or choose a "
                       "smaller request. We will re-run the assessment and give a final decision.",
            "offers": offers}
    return resp


@app.post("/reassess")
def reassess(a: Applicant, first_round_risk_percent: Optional[float] = None,
             user: Optional[dict] = Depends(current_user)):
    """Second and final round for borderline applications. Send the UPDATED applicant (confirmed or
    corrected details, or a smaller request). The same details always give the same answer, so the
    re-run only changes the outcome if the details changed."""
    row = to_row(a)
    p = float(risk([row])[0])
    snap = final_snapshot(p, row)
    up, down = explain(row)
    save_application(user, p, snap, a, up, 2)
    if snap["decision"] == "approved":
        text = ("Final decision: approved. After re-checking your details, the estimated chance "
                "of repayment trouble is below 10%.")
    elif snap["rule_triggered"]:
        text = "Final decision: rejected. " + rule_reasons(row)[0]
    else:
        text = (f"Final decision: rejected. After re-checking your details, the estimated chance of "
                f"repayment trouble is {snap['risk_percent']}%, which is still above 10%.")
    resp = {"round": 2, "final": True, **snap, "decision_text": text, "new_to_credit": bool(row["new_to_credit"]),
            "history_note": NTC_NOTE if row["new_to_credit"] and NTC else None,
            "top_risk_factors": [{"factor": k, "effect": round(v, 3)} for k, v in up[:3]],
            "top_protective_factors": [{"factor": k, "effect": round(v, 3)} for k, v in down[:3]],
            "warning": "In a real lender the updated details would be verified against documents."}
    if first_round_risk_percent is not None:
        resp["risk_change_points"] = round(snap["risk_percent"] - first_round_risk_percent, 1)
    return resp


@app.post("/stress-test")
def stress_test(a: Applicant):
    base_row = to_row(a)
    rows, keys = [], list(SCENARIOS)
    for k in keys:
        s, r = SCENARIOS[k], dict(base_row)
        r["raw_income"] = base_row["raw_income"] * s["income"]
        r["raw_annuity"] = base_row["raw_annuity"] * s["instalment"]
        if not base_row["new_to_credit"]:
            for c in ["late_payment_share", "recent_late_share"]:
                if not np.isnan(r[c]):
                    r[c] = float(min(1.0, max(0.0, r[c] + s["late_add"])))
        rows.append(refresh(r))
    probs = risk(rows)
    base = snapshot(probs[keys.index("normal")], rows[keys.index("normal")])
    out = []
    for k, r, p in zip(keys, rows, probs):
        snap = snapshot(p, r)
        out.append({"key": k, "label": SCENARIOS[k]["label"], "assumption": SCENARIOS[k]["text"], **snap,
                    "score_change": snap["score"] - base["score"],
                    "risk_change_points": round(snap["risk_percent"] - base["risk_percent"], 1),
                    "income_after": round(r["raw_income"]),
                    "instalment_after": round(r["raw_annuity"]),
                    "instalment_share_of_income_percent": round(100 * r["rule_dti"], 1),
                    "summary": f"{SCENARIOS[k]['label']}: score {snap['score']} "
                               f"({snap['score'] - base['score']:+d}), {snap['decision']}."})
    return {"baseline": base,
            "scenarios": out,
            "warning": "The size of each shock is an assumption, not an estimate from economic data."}


@app.post("/recourse")
def recourse(a: Applicant):
    row = to_row(a)
    p = float(risk([row])[0])
    suggestions = recourse_for(row, p)
    return {"current": snapshot(p, row), "suggestions": suggestions[:5],
            "note": "These are what-if estimates from the model, not guarantees. Only things the applicant "
                    "can realistically change are tested (never family details or other fixed facts)."}


@app.post("/notice")
def notice(a: Applicant, final: bool = False):
    row = to_row(a)
    p = float(risk([row])[0])
    snap = final_snapshot(p, row) if final else snapshot(p, row)
    if snap["decision"] != "rejected":
        msg = ("Your application is borderline, so no decision letter has been issued yet. Confirm your details "
               "on the Result tab to get the final decision." if snap["decision"] == "borderline"
               else "A notice is only issued when an application is rejected.")
        return {"issued": False, "decision": snap["decision"], "risk_percent": snap["risk_percent"],
                "score": snap["score"], "message": msg}
    up, _ = explain(row)
    reasons = rule_reasons(row) + [REASON_TEXT[k] for k, _ in up[:4] if k in REASON_TEXT]
    reasons = reasons[:4]
    tips = recourse_for(row, p)[:3]
    lines = [
        f"Date: {date.today():%d %B %Y}",
        "To: The Applicant",
        "Subject: Decision on your loan application",
        "",
        "Dear Applicant,",
        "",
        "Thank you for applying for a loan. After assessing your application, we are unable to offer you "
        "the loan on the terms requested.",
        *(["Your application was assessed a second time using your updated details."] if final else []),
        "",
        f"Your estimated chance of repayment trouble is {snap['risk_percent']}% and your credit score is "
        f"{snap['score']} (on a scale of 300 to 900). We approve applications below "
        f"{int(APPROVE_BELOW * 100)}%.",
        "",
        "Main reasons for this decision:",
        *[f"  {i}. {t}" for i, t in enumerate(reasons, 1)],
        "",
    ]
    if tips:
        lines += ["What may improve your chances next time:",
                  *[f"  - {t['action']} (estimated risk about {t['new_risk_percent']}%)." for t in tips], ""]
    lines += ["This decision was made with the help of an automated scoring model. It did not use gender "
              "or any bureau credit score.",
              "For questions about this decision, please contact: [lender contact details].",
              "",
              "Sincerely,",
              "[Lender name]"]
    return {"issued": True, "decision": "rejected", "letter": "\n".join(lines), "reasons": reasons,
            "suggestions": tips}


# ---------------------------------------------------------------- serve the built web app (folder "app")
APP_DIR = HERE / "app"
if APP_DIR.exists():
    app.mount("/", StaticFiles(directory=str(APP_DIR), html=True), name="web")


if __name__ == "__main__":
    import threading
    import webbrowser

    import uvicorn
    host = os.environ.get("HOST", "0.0.0.0" if "PORT" in os.environ else "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    if host in ("127.0.0.1", "localhost"):          # local run: open the browser for you
        threading.Timer(1.5, lambda: webbrowser.open(f"http://localhost:{port}")).start()
    uvicorn.run(app, host=host, port=port)
