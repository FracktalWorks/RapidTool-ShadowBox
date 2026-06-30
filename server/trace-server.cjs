/**
 * ToolTrace BiRefNet tracer backend (stateless image → mask).
 *   POST /trace   body = crop image bytes (PNG/JPEG) → returns grayscale mask PNG
 *   GET  /health  → { ok, model, threads }
 *
 * BiRefNet captures chrome/reflective tools (the hammer shaft, caliper jaws) that
 * IS-Net drops, but fp32/1024² OOMs the browser — so it runs here. Session is
 * loaded once and warmed; threading + graph-opt minimise per-request latency.
 *
 * Run:  node server/trace-server.cjs       (local: uses root node_modules + local model)
 * Env:  PORT (8787) · BIREFNET_MODEL (path) · BIREFNET_MODEL_URL (fetch if missing) ·
 *       ORT_THREADS · TRACE_KEY (if set, /trace requires header X-Trace-Key to match)
 */
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const https = require('https');
const httpc = require('http');
const ort = require('onnxruntime-node');
const sharp = require('sharp');

const PORT = Number(process.env.PORT) || 8787;
const MODEL = process.env.BIREFNET_MODEL || 'public/models/birefnet_lite.onnx';
const MODEL_URL = process.env.BIREFNET_MODEL_URL || ''; // download here if MODEL absent (Railway etc.)
const TRACE_KEY = process.env.TRACE_KEY || '';          // shared secret; empty = open (local dev)
const THREADS = Number(process.env.ORT_THREADS) || Math.max(1, os.cpus().length);
const SIZE = 1024;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

let session = null;

// The 224MB model isn't in git. Locally it's a file on disk; on a host (Railway)
// set BIREFNET_MODEL_URL (e.g. a Cloudflare R2 / S3 object) and it's fetched once
// at startup. Follows redirects (object stores 302 to a signed URL).
function downloadModel(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    const file = fs.createWriteStream(tmp);
    const get = (u, depth) => {
      if (depth > 5) { reject(new Error('too many redirects')); return; }
      (u.startsWith('https') ? https : httpc).get(u, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) { res.resume(); get(res.headers.location, depth + 1); return; }
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`model download HTTP ${res.statusCode}`)); return; }
        res.pipe(file);
        file.on('finish', () => file.close(() => { fs.renameSync(tmp, dest); resolve(); }));
      }).on('error', reject);
    };
    get(url, 0);
  });
}

async function init() {
  const t0 = Date.now();
  if (!fs.existsSync(MODEL)) {
    if (!MODEL_URL) throw new Error(`Model not found at ${MODEL} and BIREFNET_MODEL_URL is not set`);
    console.log(`model missing at ${MODEL} — downloading from ${MODEL_URL} …`);
    await downloadModel(MODEL_URL, MODEL);
    console.log(`model downloaded (${(fs.statSync(MODEL).size / 1e6).toFixed(0)}MB)`);
  }
  // Sequential + single inter-op thread, all intra-op threads on the one operator:
  // fastest config in benchmarking (parallel/inter-op only added overhead here).
  // Latency scales with physical cores — ~8s on a 4-core dev box, ~3-4s on a server.
  session = await ort.InferenceSession.create(MODEL, {
    intraOpNumThreads: THREADS,
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
  });
  // Warm-up: first run JITs/allocates, so real requests don't pay that cost.
  const warm = {}; warm[session.inputNames[0]] = new ort.Tensor('float32', new Float32Array(3 * SIZE * SIZE), [1, 3, SIZE, SIZE]);
  const tw = Date.now(); await session.run(warm);
  console.log(`BiRefNet ready: load ${((tw - t0) / 1000).toFixed(1)}s · warmup ${((Date.now() - tw) / 1000).toFixed(1)}s · threads=${THREADS}`);
}

async function trace(imgBuf) {
  const meta = await sharp(imgBuf).metadata();
  const W = meta.width, H = meta.height;
  const { data } = await sharp(imgBuf).resize(SIZE, SIZE, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const plane = SIZE * SIZE;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    input[i] = (data[i * 3] / 255 - MEAN[0]) / STD[0];
    input[plane + i] = (data[i * 3 + 1] / 255 - MEAN[1]) / STD[1];
    input[2 * plane + i] = (data[i * 3 + 2] / 255 - MEAN[2]) / STD[2];
  }
  const feeds = {}; feeds[session.inputNames[0]] = new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]);
  const out = await session.run(feeds);
  const sal = out[session.outputNames[0]].data;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < plane; i++) { const v = sal[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  const range = mx - mn || 1;
  const gray = Buffer.allocUnsafe(plane);
  for (let i = 0; i < plane; i++) { const v = ((sal[i] - mn) / range) * 255; gray[i] = v < 0 ? 0 : v > 255 ? 255 : v; }
  // resize the 1024² mask back to the crop's size; client thresholds + traces it
  return sharp(gray, { raw: { width: SIZE, height: SIZE, channels: 1 } }).resize(W, H, { fit: 'fill' }).png().toBuffer();
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Trace-Key');
  // The app is cross-origin isolated (COOP/COEP require-corp for WASM threads);
  // this lets its fetch() consume our cross-origin response.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: !!session, model: 'BiRefNet Lite', threads: THREADS }));
    return;
  }
  // Shared-secret gate (only when TRACE_KEY is configured, so local dev stays open).
  if (TRACE_KEY && req.headers['x-trace-key'] !== TRACE_KEY) { res.writeHead(401); res.end('unauthorized'); return; }
  if (req.method === 'POST' && req.url === '/trace') {
    if (!session) { res.writeHead(503); res.end('model not ready'); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const t0 = Date.now();
      try {
        const maskPng = await trace(Buffer.concat(chunks));
        res.writeHead(200, { 'Content-Type': 'image/png', 'X-Trace-Ms': String(Date.now() - t0) });
        res.end(maskPng);
        console.log(`/trace ${Date.now() - t0}ms (${Buffer.concat(chunks).length}b in)`);
      } catch (e) { console.error('/trace error', e); res.writeHead(500); res.end(String(e.message || e)); }
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

// Bind the port FIRST (cheap), then load the model — so a port clash fails in
// milliseconds with a clear message instead of after the ~18s model warm-up.
// /health reports ok:false and /trace returns 503 until the session is ready.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — a tracer is probably already running.\n` +
      `Stop the other instance first, or start this one on another port:  PORT=8788 node server/trace-server.cjs`);
    process.exit(1);
  }
  throw e;
});
server.listen(PORT, () => {
  console.log(`ToolTrace tracer listening on http://localhost:${PORT} — loading model…`);
  init().catch((e) => { console.error('init failed', e); process.exit(1); });
});
