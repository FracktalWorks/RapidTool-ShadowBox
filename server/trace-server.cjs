/**
 * ToolTrace BiRefNet tracer backend (stateless image → mask).
 *   POST /trace   body = crop image bytes (PNG/JPEG) → returns grayscale mask PNG
 *   GET  /health  → { ok, model, threads }
 *
 * BiRefNet captures chrome/reflective tools (the hammer shaft, caliper jaws) that
 * IS-Net drops, but fp32/1024² OOMs the browser — so it runs here. Session is
 * loaded once and warmed; threading + graph-opt minimise per-request latency.
 *
 * Run:  node server/trace-server.cjs       (uses root node_modules: onnxruntime-node, sharp)
 * Env:  PORT (8787) · BIREFNET_MODEL (public/models/birefnet_lite.onnx) · ORT_THREADS
 */
const http = require('http');
const os = require('os');
const ort = require('onnxruntime-node');
const sharp = require('sharp');

const PORT = Number(process.env.PORT) || 8787;
const MODEL = process.env.BIREFNET_MODEL || 'public/models/birefnet_lite.onnx';
const THREADS = Number(process.env.ORT_THREADS) || Math.max(1, os.cpus().length);
const SIZE = 1024;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

let session = null;

async function init() {
  const t0 = Date.now();
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // The app is cross-origin isolated (COOP/COEP require-corp for WASM threads);
  // this lets its fetch() consume our cross-origin response.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: !!session, model: 'BiRefNet Lite', threads: THREADS }));
    return;
  }
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
