# Deploying

**Backend → Render** · **Frontend → Vercel**

The two halves reference each other, so the order matters. Deploy the backend
first, take its URL to Vercel, then come back and tell Render which origin to
trust.

---

## Before you start

Freeze the LLM narration into the repo, so the deployed app shows model-written
prose without calling any API at boot:

```bash
npm run narrate            # if you haven't already (~25 min on Groq's free tier)
npm run narrate:export     # writes backend/src/data/narration.json
git add backend/src/data/narration.json && git commit -m "chore: freeze narration" && git push
```

**Why this matters.** Render's disk is ephemeral — the SQLite file is destroyed
on every deploy and restart. That is fine for the *data*, because `SEED` and
`SEED_NOW` make the 80-case book regenerate identically every boot. It is not
fine for the narration, which cost 80 API calls and 25 minutes to produce. So it
is committed as JSON and replayed on top of the fresh database in milliseconds.

Skip this and the deployment still works — it just shows template prose.

---

## Step 1 — Backend on Render

1. [dashboard.render.com](https://dashboard.render.com) → **New** → **Web Service**
2. Connect the GitHub repo.
3. Settings:

| Field | Value |
|---|---|
| Root Directory | *(leave blank — repo root)* |
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm run demo && npm run start:backend` |
| Health Check Path | `/health` |
| Instance Type | Free |

4. **Environment variables** (Environment tab):

| Key | Value | Why |
|---|---|---|
| `NODE_VERSION` | `20` | better-sqlite3 needs a supported Node |
| `SEED` | `20260829` | pins the dataset |
| `SEED_NOW` | `2026-08-29T18:00:00+05:30` | pins the dates — **must match** what `narration.json` was built with |
| `LLM_PROVIDER` | `groq` | |
| `ALLOWED_ORIGINS` | *(leave empty for now)* | filled in at Step 3 |

**Do not set `PORT`.** Render injects it and the server reads it.

**`GROQ_API_KEY` is optional here.** With `narration.json` committed, the batch
never calls Groq — the dashboard and every case timeline show model-written prose
with zero API calls at boot.

Set it only if you want to demo **`/simulate`** with live model output. That page
narrates a case the batch has never seen, so it has no frozen prose to fall back
on and calls the provider at request time. Without a key it still runs end to
end and says so on screen, falling back to the deterministic template narrator
exactly as the batch does.

5. Deploy. When it goes live, copy the URL:
   `https://revenue-recovery-api.onrender.com`

6. Verify: open `https://<your-api>.onrender.com/health` — you should see
   `{"ok":true,...,"seededFailures":80,...}`.

> The repo also has a `render.yaml` blueprint with all of the above baked in.
> **New → Blueprint** and point it at the repo to skip the manual form.

---

## Step 2 — Frontend on Vercel

1. [vercel.com/new](https://vercel.com/new) → import the same repo.
2. Settings:

| Field | Value |
|---|---|
| Framework Preset | Next.js |
| **Root Directory** | **`frontend`** |
| Build Command | *(default)* |
| Install Command | *(default)* |

**Root Directory is the one people get wrong.** Leave it at the repo root and
Vercel will not find the Next.js app.

3. **Environment variable:**

| Key | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://revenue-recovery-api.onrender.com` |

No trailing slash. Use *your* Render URL from Step 1.

4. Deploy, then copy the Vercel URL: `https://your-app.vercel.app`

> **`NEXT_PUBLIC_*` variables are baked in at build time**, not read at runtime.
> Changing this value later has no effect until you **redeploy**. If the live
> site tries to reach `localhost:4000`, this is why.

---

## Step 3 — Connect them back

Return to Render → Environment → set:

| Key | Value |
|---|---|
| `ALLOWED_ORIGINS` | `https://your-app.vercel.app` |

Save. Render restarts automatically. Preview deployments on `*.vercel.app` are
allowed too once the production domain is trusted, so PR previews keep working.

Multiple origins are comma-separated:
`https://your-app.vercel.app,https://custom-domain.com`

---

## Which variable lives where

| Variable | Render (backend) | Vercel (frontend) | Local `.env` |
|---|:--:|:--:|:--:|
| `SEED` | ✅ | — | ✅ |
| `SEED_NOW` | ✅ | — | ✅ |
| `LLM_PROVIDER` | ✅ | — | ✅ |
| `GROQ_API_KEY` | optional | — | ✅ |
| `ALLOWED_ORIGINS` | ✅ | — | — |
| `PORT` | auto | — | ✅ |
| `NEXT_PUBLIC_API_URL` | — | ✅ | ✅ |

`.env` is gitignored and never deployed. Both platforms read from their own
dashboards.

---

## Verifying it worked

```bash
curl https://<your-api>.onrender.com/health
curl https://<your-api>.onrender.com/api/comparison
```

Then open the Vercel URL. You should see 80 failures, ₹81,91,320 at risk, a
46.3% recovery rate, and the baseline comparison. Click any row through to a
case timeline.

Check `/simulate` too: run one case with the hard-stop flag set to **Opted out**
and confirm it halts at stage 3. That path needs no API key, so it is the fastest
proof the stream survived the proxy.

## When something is wrong

| Symptom | Cause |
|---|---|
| Frontend shows "Backend not reachable" | `NEXT_PUBLIC_API_URL` wrong or set after the build — fix it, then **redeploy** |
| Browser console: CORS error | `ALLOWED_ORIGINS` on Render does not exactly match the Vercel origin (scheme, no trailing slash) |
| First load takes ~50s | Render free tier sleeps after 15 minutes idle. **Hit the API URL a few minutes before demoing.** |
| Timeline shows template prose, no model badge | `narration.json` missing, or `SEED_NOW` on Render differs from the one it was exported with — the apply step refuses to attach prose to a dataset it was not built for |
| Build fails on `better-sqlite3` | `NODE_VERSION` unset or too old |
| `/simulate` shows every stage at once, after one long pause | A proxy buffered the event stream. The backend already sends `X-Accel-Buffering: no` and `Cache-Control: no-transform`; anything in front of it must not re-buffer `text/event-stream` |
| `/simulate` stage 4 says "template fallback" | No `GROQ_API_KEY` on the backend, or the provider rate-limited the call. The run is still real — only the prose is |

## The free-tier caveat worth planning around

Render free services sleep after 15 minutes of inactivity and take 30–60 seconds
to wake. During a live demo that is a long silence. Open the API URL a few
minutes beforehand, or keep a tab open on the dashboard.
