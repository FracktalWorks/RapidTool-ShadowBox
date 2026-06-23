/**
 * Offline A4-detection test harness (CommonJS — OpenCV.js only inits in a CJS context).
 *
 * Runs the SAME paper-corner pipeline as src/workers/cvWorker.ts (white mask →
 * extreme-point quad → RANSAC edge-line fit → gradient edge snap) on every image in
 * test-photos/, draws the detected quad + corners, writes test-photos/output/.
 * Lets us SEE results on real photos and tune the KNOBS instead of guessing.
 * Run: `node scripts/test-detect.cjs`. Port good KNOB values back into cvWorker.ts.
 */
const fs = require('fs');
const { join, basename, extname } = require('path');
const sharp = require('sharp');

const ROOT = join(__dirname, '..');
const IN = join(ROOT, 'test-photos');
const OUT = join(IN, 'output');

const KNOBS = {
  blur: 15, closeK: 25, openK: 31,
  whiteValMin: 155, whiteSatMax: 70,
  gradThresh: 18, gradSearchPct: 0.02, ransacTol: 2.5,
};

// Load OpenCV.js at TOP LEVEL (it only inits reliably from the main module's top-level
// require — not from inside an async/microtask). Copy to a sibling .cjs first so Node
// loads it as CommonJS despite this package being type:module.
const _cvCjs = join(__dirname, '_cv_runtime.cjs');
fs.copyFileSync(join(ROOT, 'public', 'opencv.js'), _cvCjs);
let _resolveCv;
const cvReady = new Promise((res) => { _resolveCv = res; });
globalThis.Module = { onRuntimeInitialized() { try { fs.rmSync(_cvCjs); } catch {} _resolveCv(globalThis.cv || globalThis.Module); } };
require(_cvCjs);

// ── Pure geometry helpers (ported verbatim from cvWorker.ts) ──────────────────
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const orderCorners = (pts) => { const s = [...pts].sort((a, b) => a.y - b.y); const top = s.slice(0, 2).sort((a, b) => a.x - b.x); const bot = s.slice(2, 4).sort((a, b) => a.x - b.x); return [top[0], top[1], bot[1], bot[0]]; };
const lineThrough = (p, q) => { const dx = q.x - p.x, dy = q.y - p.y; const a = -dy, b = dx, n = Math.hypot(a, b) || 1; return { a: a / n, b: b / n, c: -((a / n) * p.x + (b / n) * p.y) }; };
const fitLineTLS = (pts) => { let mx = 0, my = 0; for (const p of pts) { mx += p.x; my += p.y; } mx /= pts.length; my /= pts.length; let sxx = 0, syy = 0, sxy = 0; for (const p of pts) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; } const t = 0.5 * Math.atan2(2 * sxy, sxx - syy); const a = -Math.sin(t), b = Math.cos(t); return { a, b, c: -(a * mx + b * my) }; };
const fitLineRobust = (pts) => { if (pts.length < 4) return fitLineTLS(pts); let best = fitLineTLS(pts), bestIn = -1; for (let i = 0; i < 50; i++) { const a = pts[(Math.random() * pts.length) | 0], b = pts[(Math.random() * pts.length) | 0]; if (a === b) continue; const L = lineThrough(a, b); let inl = 0; for (const p of pts) if (Math.abs(L.a * p.x + L.b * p.y + L.c) < KNOBS.ransacTol) inl++; if (inl > bestIn) { bestIn = inl; best = L; } } const inl = pts.filter((p) => Math.abs(best.a * p.x + best.b * p.y + best.c) < KNOBS.ransacTol); return inl.length >= 4 ? fitLineTLS(inl) : best; };
const intersect = (l1, l2) => { const det = l1.a * l2.b - l2.a * l1.b; if (Math.abs(det) < 1e-9) return null; return { x: (l1.b * l2.c - l2.b * l1.c) / det, y: (l2.a * l1.c - l1.a * l2.c) / det }; };
const ptSeg = (p, a, b) => { const vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy || 1; const t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2; const tc = Math.max(0, Math.min(1, t)); return { d: Math.hypot(p.x - (a.x + tc * vx), p.y - (a.y + tc * vy)), t }; };

function extremeQuadCorners(cv, contour) {
  const hull = new cv.Mat(); cv.convexHull(contour, hull, false, true);
  const n = hull.rows; if (n < 4) { hull.delete(); return null; }
  let tl = null, tr = null, br = null, bl = null, mnS = Infinity, mxS = -Infinity, mnD = Infinity, mxD = -Infinity;
  for (let i = 0; i < n; i++) { const x = hull.data32S[i * 2], y = hull.data32S[i * 2 + 1], s = x + y, d = x - y; if (s < mnS) { mnS = s; tl = { x, y }; } if (s > mxS) { mxS = s; br = { x, y }; } if (d > mxD) { mxD = d; tr = { x, y }; } if (d < mnD) { mnD = d; bl = { x, y }; } }
  hull.delete(); return tl && tr && br && bl ? [tl, tr, br, bl] : null;
}
function refineByEdgeLines(contour, ordered) {
  try {
    const n = contour.rows; if (n < 16) return ordered; const d = contour.data32S;
    const segs = [[ordered[0], ordered[1]], [ordered[1], ordered[2]], [ordered[2], ordered[3]], [ordered[3], ordered[0]]];
    const buckets = [[], [], [], []];
    for (let i = 0; i < n; i++) { const p = { x: d[i * 2], y: d[i * 2 + 1] }; let bi = 0, bd = Infinity, bt = 0; for (let s = 0; s < 4; s++) { const r = ptSeg(p, segs[s][0], segs[s][1]); if (r.d < bd) { bd = r.d; bi = s; bt = r.t; } } if (bt > 0.12 && bt < 0.88) buckets[bi].push(p); }
    const lines = buckets.map((pts, s) => (pts.length >= 6 ? fitLineRobust(pts) : lineThrough(segs[s][0], segs[s][1])));
    const maxLen = Math.max(...segs.map(([a, b]) => dist(a, b)));
    return ordered.map((c, k) => { const p = intersect(lines[(k + 3) % 4], lines[k]); return p && Math.hypot(p.x - c.x, p.y - c.y) < 0.1 * maxLen ? p : c; });
  } catch { return ordered; }
}
function refineByGradient(gray, corners) {
  try {
    const cols = gray.cols, rows = gray.rows, g = gray.data;
    const at = (x, y) => { const xi = x < 0 ? 0 : x >= cols ? cols - 1 : x | 0; const yi = y < 0 ? 0 : y >= rows ? rows - 1 : y | 0; return g[yi * cols + xi]; };
    const search = Math.max(6, Math.round(Math.hypot(cols, rows) * KNOBS.gradSearchPct)); const N = 48; const lines = [];
    for (let k = 0; k < 4; k++) {
      const a = corners[k], b = corners[(k + 1) % 4]; const ex = b.x - a.x, ey = b.y - a.y, el = Math.hypot(ex, ey) || 1; const nx = -ey / el, ny = ex / el; const pts = [];
      for (let s = 1; s < N; s++) { const f = s / N; if (f < 0.12 || f > 0.88) continue; const px = a.x + ex * f, py = a.y + ey * f; let bT = 0, bG = -1; for (let t = -search; t <= search; t++) { const x = px + nx * t, y = py + ny * t; const grad = Math.abs(at(x + nx, y + ny) - at(x - nx, y - ny)); if (grad > bG) { bG = grad; bT = t; } } if (bG > KNOBS.gradThresh) pts.push({ x: px + nx * bT, y: py + ny * bT }); }
      lines.push(pts.length >= 8 ? fitLineRobust(pts) : lineThrough(a, b));
    }
    const maxLen = Math.max(...corners.map((c, k) => dist(c, corners[(k + 1) % 4])));
    return corners.map((c, k) => { const p = intersect(lines[(k + 3) % 4], lines[k]); return p && Math.hypot(p.x - c.x, p.y - c.y) < 0.06 * maxLen ? p : c; });
  } catch { return corners; }
}

function detectCorners(cv, src, gray, totalArea) {
  const rgb = new cv.Mat(); cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  const hsv = new cv.Mat(); cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  const blurred = new cv.Mat(); cv.GaussianBlur(hsv, blurred, new cv.Size(KNOBS.blur, KNOBS.blur), 0);
  const mask = new cv.Mat();
  const lo = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), new cv.Scalar(0, 0, KNOBS.whiteValMin, 0));
  const hi = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), new cv.Scalar(180, KNOBS.whiteSatMax, 255, 0));
  cv.inRange(blurred, lo, hi, mask);
  const ck = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(KNOBS.closeK, KNOBS.closeK));
  const ok = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(KNOBS.openK, KNOBS.openK));
  cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, ck); cv.morphologyEx(mask, mask, cv.MORPH_OPEN, ok);
  const contours = new cv.MatVector(), hier = new cv.Mat();
  cv.findContours(mask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
  let best = null, bestArea = 0;
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i), area = cv.contourArea(c);
    if (area >= totalArea * 0.05 && area <= totalArea * 0.995 && area > bestArea) { const cm = extremeQuadCorners(cv, c); if (cm) { bestArea = area; best = refineByEdgeLines(c, orderCorners(cm)); } }
    c.delete();
  }
  [rgb, hsv, blurred, mask, lo, hi, ck, ok, contours, hier].forEach((m) => m.delete());
  return best ? refineByGradient(gray, best) : null;
}

(async () => {
  const cv = await cvReady;
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const files = fs.readdirSync(IN).filter((f) => /\.(jpe?g|png)$/i.test(f));
  console.log(`KNOBS ${JSON.stringify(KNOBS)}\n`);
  for (const f of files) {
    try {
      const { data, info } = await sharp(join(IN, f)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const { width, height } = info;
      const src = new cv.Mat(height, width, cv.CV_8UC4); src.data.set(new Uint8Array(data));
      const gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      const corners = detectCorners(cv, src, gray, width * height);
      if (!corners) { console.log(`${f.padEnd(16)} NO PAPER`); src.delete(); gray.delete(); continue; }
      const c4 = corners;
      for (let i = 0; i < 4; i++) cv.line(src, new cv.Point(c4[i].x, c4[i].y), new cv.Point(c4[(i + 1) % 4].x, c4[(i + 1) % 4].y), new cv.Scalar(0, 200, 255, 255), Math.max(2, Math.round(width / 400)));
      for (const p of c4) cv.circle(src, new cv.Point(p.x, p.y), Math.max(4, Math.round(width / 120)), new cv.Scalar(255, 0, 0, 255), -1);
      const w2 = (dist(c4[0], c4[1]) + dist(c4[3], c4[2])) / 2, h2 = (dist(c4[0], c4[3]) + dist(c4[1], c4[2])) / 2;
      console.log(`${f.padEnd(16)} ${width}x${height} ppm=${(Math.max(w2, h2) / 297).toFixed(2)} TL(${c4[0].x | 0},${c4[0].y | 0}) TR(${c4[1].x | 0},${c4[1].y | 0}) BR(${c4[2].x | 0},${c4[2].y | 0}) BL(${c4[3].x | 0},${c4[3].y | 0})`);
      await sharp(Buffer.from(src.data), { raw: { width, height, channels: 4 } }).jpeg({ quality: 80 }).toFile(join(OUT, `${basename(f, extname(f))}_det.jpg`));
      src.delete(); gray.delete();
    } catch (e) { console.log(`${f.padEnd(16)} ERROR: ${(e && e.message ? e.message : String(e)).slice(0, 140)}`); }
  }
  console.log(`\nDone -> ${OUT}`);
  process.exit(0);
})();
