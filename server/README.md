# ToolTrace tracer — BiRefNet inference service

Stateless microservice: `POST /trace` (crop image → grayscale mask PNG), `GET /health`.
It captures chrome/reflective tools that in-browser IS-Net misses. Runs **separate**
from RapidTool-Backend (different resource profile: 200MB model, CPU-heavy, always-warm)
and needs **no database** — the suite's shared DB/auth stay in RapidTool-Backend.

## Run locally
```bash
node server/trace-server.cjs          # uses the local model at public/models/birefnet_lite.onnx
# enable it in the app:  .env.local →  VITE_TRACER_URL=http://localhost:8787
```

## Env vars
| Var | Purpose |
|---|---|
| `PORT` | listen port (Railway injects this; local default 8787) |
| `BIREFNET_MODEL` | model path (container default `/app/models/birefnet_lite.onnx`) |
| `BIREFNET_MODEL_URL` | if the model file is absent, download it from here at startup (Railway) |
| `TRACE_KEY` | if set, `/trace` requires header `X-Trace-Key` to match (leave unset locally) |
| `ORT_THREADS` | inference threads. Default = `os.cpus()` which on a shared host = the HOST's core count, not your allocation → set this to your real vCPU count or inference thrashes (e.g. `2` on HF free) |

## Deploy to Hugging Face Spaces (current live host)
The live tracer runs on a **free HF Space** (CPU basic = 2 vCPU / 16 GB). Files in
[`deploy/hf/`](../deploy/hf) (`Dockerfile` listens on **7860** per HF convention +
the Space `README.md`); upload them plus `server/trace-server.cjs` + `server/package.json`
to the Space repo root, then set Space **secrets/variables**:
- `BIREFNET_MODEL_URL` = the R2 model URL
- `TRACE_KEY` = a long random secret
- `ORT_THREADS` = **2**  ← important: the container *sees* the host's 16 CPUs but only
  gets 2 vCPU, so without this ORT spawns 16 threads that thrash → ~90s/trace. At 2 it's
  ~24s. (Bump to a paid CPU tier for ~5–8s; no code change.)

Point the app at it: Cloudflare Pages → env vars `VITE_TRACER_URL` = the Space URL,
`VITE_TRACER_KEY` = the same secret → redeploy `main`.

> Railway (below) was tried first but its free tier caps at **1 GB RAM** → the model
> load OOM-crash-loops. Use it only on a paid plan with ≥4 GB.

## Deploy to Railway (needs ≥4 GB RAM — free 1 GB OOMs)
1. **Host the model** (it's 224MB, gitignored). Upload `public/models/birefnet_lite.onnx`
   to a public/presigned URL — e.g. a Cloudflare R2 bucket — and copy that URL.
2. **Railway** → New Project → *Deploy from GitHub repo* → this repo.
   Set **Root Directory = `server`** so it builds `server/Dockerfile`.
3. **Variables** on the Railway service:
   - `BIREFNET_MODEL_URL` = the model URL from step 1
   - `TRACE_KEY` = a long random secret
   - (Railway sets `PORT` automatically.)
4. Deploy → wait for `BiRefNet ready` in logs → Railway gives a public URL.
   Keep **min 1 instance** so the ~18s model load isn't paid per cold request.
5. **Point the app at it** — in Cloudflare Pages → Settings → Environment variables:
   - `VITE_TRACER_URL` = the Railway URL
   - `VITE_TRACER_KEY` = the same secret as `TRACE_KEY`
   - Redeploy `main`. Production now uses BiRefNet (with automatic IS-Net fallback if the
     tracer is down).

## Notes
- Latency: ~3–5s per photo on a multi-core box (one inference per photo, not per tool).
- The client auto-falls back to in-browser IS-Net on any tracer error, so a down/slow
  backend never breaks tracing.
