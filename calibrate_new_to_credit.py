"""Fix: score new-to-credit applicants with a calibrated 'reference history'.

THE PROBLEM
  The trained model sends applicants with no repayment history down a separate branch. In the data
  that branch was learned as "safer than average", so an applicant with NO history could score better
  than one with a SPOTLESS history (which is the wrong way round: in Home Credit, spotless borrowers
  default less than new-to-credit ones).

THE FIX (no retraining needed)
  For a new-to-credit applicant the app fills the history fields with a REFERENCE HISTORY and tells
  the model "history is present". The reference history is a scaled-down version of the average
  borrower history, and the scale s is chosen so that the model's AVERAGE predicted risk for
  new-to-credit applicants equals their REAL default rate in the training data.
    s = 0  -> perfect history (too generous)       s = 1 -> average history (too harsh)
  Result: no reward and no penalty for having no history, and a spotless history always scores at
  least as well as none (the model's monotone rules guarantee the rest).

USAGE (re-run whenever you retrain or change the cleaned file):
  python calibrate_new_to_credit.py --data home_credit_clean.csv --model model.json --meta meta.json
It writes "new_to_credit_profile" into meta.json.  main.py reads it at start-up.
"""
import argparse
import json
import sys

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import roc_auc_score

HISTORY = ["late_payment_share", "underpaid_share", "avg_days_late", "max_days_late", "avg_payment_ratio",
           "recent_late_share"]


def make_profile(base, s):
    """Reference history at scale s (0 = perfect, 1 = average borrower)."""
    p = {"n_installments": base["n_installments"]}
    for c in ["late_payment_share", "underpaid_share", "avg_days_late", "max_days_late", "recent_late_share"]:
        p[c] = s * base[c]
    p["avg_payment_ratio"] = 1.0 - s * (1.0 - base["avg_payment_ratio"])
    return p


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--model", default="model.json")
    ap.add_argument("--meta", default="meta.json")
    a, _ = ap.parse_known_args(argv)
    meta = json.load(open(a.meta))
    F = meta["features"]
    model = xgb.XGBClassifier()
    model.load_model(a.model)

    d = pd.read_csv(a.data)
    d["credit_to_income"] = d["credit_amount"] / d["income"]      # same formulas the app uses
    d["debt_to_income"] = d["annuity"] / d["income"]
    nh = (d["no_history_flag"] == 1).values
    has = d[~nh]
    base = {"n_installments": float(has["n_installments"].median())}
    for c in HISTORY:
        base[c] = float(has[c].mean())
    target = float(d.loc[nh, "default"].mean())
    y = d["default"].values

    sample = d[nh].sample(min(60000, int(nh.sum())), random_state=1)

    def mean_risk(s, frame):
        X = frame.copy()
        for c, v in make_profile(base, s).items():
            X[c] = v
        X["no_history_flag"] = 0
        return float(model.predict_proba(X[F].astype(float))[:, 1].mean())

    lo, hi = 0.0, 1.0
    if mean_risk(0.0, sample) >= target:
        s = 0.0
    elif mean_risk(1.0, sample) <= target:
        s = 1.0
    else:
        for _ in range(30):
            mid = (lo + hi) / 2
            if mean_risk(mid, sample) < target:
                lo = mid
            else:
                hi = mid
        s = (lo + hi) / 2
    prof = {k: round(v, 4) for k, v in make_profile(base, s).items()}

    # ---- checks on the full file
    X_new = d[nh].copy()
    X_old = X_new.copy()
    for c in HISTORY:
        X_old[c] = np.nan
    X_old["n_installments"] = 0
    for c, v in prof.items():
        X_new[c] = v
    X_new["no_history_flag"] = 0
    p_old = model.predict_proba(X_old[F].astype(float))[:, 1]
    p_new = model.predict_proba(X_new[F].astype(float))[:, 1]
    X_best = X_new.copy()
    for c, v in make_profile(base, 0.0).items():
        X_best[c] = v
    p_best = model.predict_proba(X_best[F].astype(float))[:, 1]
    yy = y[nh]
    print(f"new-to-credit applicants: {int(nh.sum()):,}   real default rate {target:.1%}")
    print(f"chosen scale s = {s:.3f}   reference history = {prof}")
    print(f"BEFORE: average predicted risk {p_old.mean():.1%}   AUC inside group {roc_auc_score(yy, p_old):.4f}")
    print(f"AFTER : average predicted risk {p_new.mean():.1%}   AUC inside group {roc_auc_score(yy, p_new):.4f}")
    print(f"perfect-history risk for the same people: {p_best.mean():.1%}")
    print(f"perfect history scores at least as well as no history for {np.mean(p_best <= p_new + 1e-9):.1%} of them "
          f"(before the fix: {np.mean(p_best <= p_old):.1%})")

    meta["new_to_credit_profile"] = {**prof, "scale": round(s, 4), "target_default_rate": round(target, 4),
                                     "note": "Reference history used for applicants with no repayment history. "
                                             "Re-run calibrate_new_to_credit.py after retraining."}
    json.dump(meta, open(a.meta, "w"), indent=2)
    print(f"saved new_to_credit_profile to {a.meta}")


if __name__ == "__main__":
    main(sys.argv[1:])
