# BiRefNet Lite tracer (experimental — chrome/reflective tools)

IS-Net (default) goes blind to shiny metal (the hammer shaft, caliper jaws).
**BiRefNet Lite** "handles reflections and shiny surfaces well" — it's the model
Tracefinity uses for exactly this. This branch (`feat/birefnet-tracer`) lets you
swap it in via `VITE_TRACER=birefnet`.

## 1. Get the model (same one Tracefinity uses — via rembg)

```bash
pip install rembg onnxruntime
python -c "from rembg import new_session; new_session('birefnet-lite')"
# rembg downloads it to the cache:  ~/.u2net/birefnet-lite.onnx
```

Then copy it here as a single file (local dev has no 25 MB cap, so no chunking needed):

```bash
cp ~/.u2net/birefnet-lite.onnx  public/models/birefnet_lite.onnx
# Windows:  copy %USERPROFILE%\.u2net\birefnet-lite.onnx  public\models\birefnet_lite.onnx
```

(If `~/.u2net` isn't it, check `~/.cache/rembg` or print `rembg`'s model path.)

## 2. Enable it

In `.env.development` add:

```
VITE_TRACER=birefnet
# optional overrides:
# VITE_BIREFNET_URL=/models/birefnet_lite.onnx
# VITE_BIREFNET_PARTS=1        # >1 if you chunk it for Cloudflare Pages (25MB cap)
```

## 3. Restart + test

```bash
npm run dev   # restart so the worker picks up the new env + model
```

Hard-reload, load the **hammer** and **caliper** photos. Console should print:

```
🧠 SOD MODEL LOADED: BiRefNet Lite (...)
```

**Watch for:** does the chrome shaft / jaws now appear in the mask (`traceMask: raw
SOD mask=…`)? And note **load time + memory** — BiRefNet is heavier than IS-Net
(more RAM); if a desktop browser handles it we keep client-side, if it OOMs we
move the tracer to a backend (Tracefinity's reason for having one).

## Switch back to IS-Net
Remove `VITE_TRACER` (or set `=isnet`) and restart. Nothing else changes — the
whole pipeline downstream is identical.
