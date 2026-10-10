# Deployment Guide: Render (Backend) & Vercel (Frontend)

This guide walks you through deploying the **CUBE Pod 13** multi-agent commerce automation platform to **Render** (Backend API & 5 Agents) and **Vercel** (Frontend UI).

---

## Architecture Overview

```
                                      ┌────────────────────────────────┐
                                      │        Vercel (Frontend)       │
                                      │   https://<your-app>.vercel.app│
                                      └──────────────┬─────────────────┘
                                                     │ API Calls / Rewrites
                                                     ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Render Web Service (Backend Orchestrator & Agents) - https://<your-backend>.onrender.com       │
│                                                                                                │
│  Port $PORT (0.0.0.0) ──▶ FastAPI Orchestrator (orchestration.api:app)                         │
│                                │                                                               │
│       ┌────────────────────────┼────────────────────────┬──────────────────────┐               │
│       ▼                        ▼                        ▼                      ▼               │
│  [1] Receiving Manager   [2] Prep Manager          [3] Pack Manager      [4] Returns Manager   │
│      Port 8101               Port 8102                 Port 8103             Port 8104         │
│                                                                                                │
│                                     [5] Recovery Hub (Port 8105)                               │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Part 1: Deploy Backend to Render

### Option A: Automatic Blueprint via `render.yaml` (Recommended)

1. Log into your [Render Dashboard](https://dashboard.render.com/).
2. Click **New +** → **Blueprint**.
3. Connect your GitHub repository: `https://github.com/HarshKumar5822/cube-round3-pod`.
4. Render will detect `render.yaml` automatically.
5. In the Environment Variables section, add your secret:
   - **`GROQ_API_KEY`**: Your Groq API key (`gsk_...`).
6. Click **Apply**.
7. Render will build and start all 5 agents and the orchestrator on a public URL:
   `https://<your-service-name>.onrender.com`.

### Option B: Manual Web Service Setup on Render

1. On the Render Dashboard, click **New +** → **Web Service**.
2. Connect `https://github.com/HarshKumar5822/cube-round3-pod`.
3. Configure the following fields:
   - **Name**: `cube-round3-pod-backend`
   - **Region**: Oregon or Ohio
   - **Branch**: `main`
   - **Runtime**: `Python 3`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `python scripts/serve_all.py`
4. Under **Advanced** → **Environment Variables**, add:
   - `PYTHON_VERSION`: `3.11.8`
   - `ORCH_MODE`: `http`
   - `GROQ_API_KEY`: `your_groq_api_key_here`
5. Click **Create Web Service**.
6. Once deployed, verify your backend:
   ```bash
   curl https://<your-backend-url>.onrender.com/health
   ```
   It should return `{"status":"ok", ...}` with all 5 agents healthy.

---

## Part 2: Deploy Frontend to Vercel

### Deploying the Frontend

1. Log into your [Vercel Dashboard](https://vercel.com/dashboard).
2. Click **Add New…** → **Project**.
3. Import your GitHub repository: `HarshKumar5822/cube-round3-pod`.
4. Project Configuration:
   - **Framework Preset**: `Other`
   - **Root Directory**: `./` (or `frontend`)
   - **Build Command**: Leave empty
   - **Output Directory**: `frontend` (if Root is `./`)
5. If you already have your Render backend URL, you can update `vercel.json`:
   Replace `https://cube-round3-pod-backend.onrender.com` in `vercel.json` with your real Render URL.
6. Click **Deploy**.
7. Vercel will deploy the site instantly at:
   `https://<your-project>.vercel.app`

---

## Part 3: Connecting Frontend to Backend

You have two easy ways to connect:

### 1. In-App Connector (Instant, No Redeploy Needed)
1. Open your deployed Vercel site in your browser.
2. In the left sidebar, look at the status box at the bottom.
3. Click the **"🔗 Backend URL"** or **"🔗 Set Backend URL"** button.
4. Paste your Render backend URL (e.g. `https://cube-round3-pod-backend.onrender.com`).
5. Click OK. The status indicator will turn **🟢 Groq connected** and show the active vision model!

### 2. Vercel Rewrites
Update `destination` in `vercel.json` to point to your Render service. Vercel proxies all `/api/*`, `/health`, and `/workflows/*` calls directly to Render with no CORS headers needed.

---

## Verification Checklist

| Check | URL | Expected Result |
|---|---|---|
| Backend Health | `https://<render-url>/health` | Status 200 `{"status":"ok"}` |
| Swagger Docs | `https://<render-url>/docs` | FastAPI Swagger documentation |
| Live Run UI | `https://<vercel-url>/#live` | All 5 steps (Receiving, Prep, Pack, Returns, Recovery) visible |
| Prep Console | `https://<vercel-url>/#console-prep` | FBA packaging & labelling checks active |
| Returns Console | `https://<vercel-url>/#console-returns` | Identity, completeness & condition evaluation active |
