---
title: CredTrack
emoji: 📈
colorFrom: green
colorTo: gray
sdk: docker
app_port: 8000
pinned: false
---

# CredTrack

Explainable loan-default risk for thin-file applicants, with an expense tracker, streaks, a credit check
with plain-language reasons, a stress test, recourse suggestions and a decision notice.
FastAPI backend + vanilla JS frontend (including a 3D particle dashboard).

## Run locally
```
pip install -r requirements.txt
python main.py            # opens http://localhost:8000
```

## Deploy

The app is one process: FastAPI serves the API and the web app from the same port. It needs
`model.json` and `meta.json` next to `main.py`, and a place to keep its SQLite file.

| Setting (env var) | What it does | Default |
|---|---|---|
| `JWT_SECRET` | Signs login tokens. **Set this in production** (any long random string). | random, saved to `.jwt_secret` |
| `DATA_DIR` | Folder for `app.db` (accounts, expenses, checks). Point it at a persistent disk. | project folder |
| `PORT` / `HOST` | Where to listen. Most hosts set `PORT` for you. | `8000` / `127.0.0.1` |
| `CORS_ORIGINS` | Only needed if another website calls the API. | localhost dev ports |

### Option 1: Render, free, no Docker (easiest)
1. Push this folder to a GitHub repo.
2. On render.com sign in with GitHub, choose **New > Blueprint**, pick the repo and apply. `render.yaml` uses the free plan and a normal Python build.
3. Open the URL Render gives you and sign up in the app.

Free instances sleep when idle (the first visit takes about 30 seconds) and the database resets on restart,
so accounts and expenses are not kept. For permanent data, use a paid disk (set `DATA_DIR` to its mount path) or any VPS.

### Option 2: any Docker host (Railway, Fly.io, a VPS)
```
docker build -t credtrack .
docker run -d -p 80:8000 -e JWT_SECRET="$(openssl rand -hex 32)" -v credtrack-data:/data credtrack
```

### Option 3: a plain Python server
```
pip install -r requirements.txt
export JWT_SECRET="$(openssl rand -hex 32)" DATA_DIR=/var/lib/credtrack HOST=0.0.0.0 PORT=8000
python main.py
```
Put it behind HTTPS (Render, Fly, Railway and Caddy/nginx all do this for you).

Health check: `GET /healthz` returns `{"status":"ok"}`.

## Notes
- Tailwind is loaded from its CDN and Chart.js from jsDelivr; the 3D library is bundled in `app/vendor`.
  Visitors need internet for those two. Fonts come from Google Fonts.
- Re-run `calibrate_new_to_credit.py` on your own cleaned data if you retrain the model.
- Scores are estimates, not financial advice.
