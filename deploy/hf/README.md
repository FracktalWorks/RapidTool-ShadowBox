---
title: ToolTrace Tracer
emoji: 🔧
colorFrom: blue
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# ToolTrace BiRefNet tracer

Stateless inference service for RapidTool-ToolTrace: `POST /trace` (paper-crop image
→ grayscale mask PNG), `GET /health`. Captures chrome/reflective tools that in-browser
IS-Net misses.

## Space secrets (Settings → Variables and secrets)
- `BIREFNET_MODEL_URL` — URL of `birefnet_lite.onnx` (downloaded once at startup)
- `TRACE_KEY` — shared secret; `/trace` requires header `X-Trace-Key` to match

The client (Cloudflare Pages) sets `VITE_TRACER_URL` = this Space's URL and
`VITE_TRACER_KEY` = the same `TRACE_KEY`.
