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
const { PNG } = require('pngjs');

const ROOT = join(__dirname, '..');
const IN = join(ROOT, 'test-photos');
const OUT = join(IN, 'output');

const KNOBS = {
  blur: 15, closeK: 25, openK: 31,
  whiteValMin: 155, whiteSatMax: 70,
  gradThresh: 18, gradSearchPct: 0.05, ransacTol: 2.5,
  shadowRpct: 0.02, // suppressShadowNoise support radius (fraction of min dim)
  dumpMask: false,
};

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
  const maskOut = KNOBS.dumpMask ? mask.clone() : null;
  [rgb, hsv, blurred, mask, lo, hi, ck, ok, contours, hier].forEach((m) => m.delete());
  return { edge: best, grad: best ? refineByGradient(gray, best) : null, mask: maskOut };
}

const MODE = process.argv[2] || 'paper'; // 'paper' (corners) | 'shadow' (SOD shadow-trim) | 'tools' (classical cues)

// Tool+shadow mask proxy: darker-than-paper pixels INSIDE the paper quad capture the
// tool AND its cast shadow — exactly the over-grown region SOD produces — so we can
// test suppressShadowNoise without running the ONNX model.
function toolShadowMask(cv, gray, quad) {
  const raw = new cv.Mat(); cv.threshold(gray, raw, 205, 255, cv.THRESH_BINARY_INV);
  const quadMask = cv.Mat.zeros(gray.rows, gray.cols, cv.CV_8UC1);
  const pts = cv.matFromArray(4, 1, cv.CV_32SC2, quad.flatMap((p) => [Math.round(p.x), Math.round(p.y)]));
  const mv = new cv.MatVector(); mv.push_back(pts);
  cv.fillPoly(quadMask, mv, new cv.Scalar(255));
  const e = Math.max(3, Math.round(0.04 * Math.min(gray.rows, gray.cols)));
  const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(e, e));
  cv.erode(quadMask, quadMask, k);
  const tool = new cv.Mat(); cv.bitwise_and(raw, quadMask, tool);
  [raw, quadMask, pts, mv, k].forEach((m) => m.delete());
  return tool;
}

// Exact port of cvWorker.suppressShadowNoise (the fix under test): keep mask pixels
// near sharp edges, hole-fill → tool interior refills, blurry shadow halo dropped.
function suppressShadowNoise(cv, mask, full) {
  const T = [];
  try {
    const gray = new cv.Mat(); cv.cvtColor(full, gray, cv.COLOR_RGBA2GRAY); T.push(gray);
    const gx = new cv.Mat(), gy = new cv.Mat(); T.push(gx, gy);
    cv.Sobel(gray, gx, cv.CV_16S, 1, 0, 3); cv.Sobel(gray, gy, cv.CV_16S, 0, 1, 3);
    cv.convertScaleAbs(gx, gx); cv.convertScaleAbs(gy, gy);
    const mag = new cv.Mat(); cv.addWeighted(gx, 0.5, gy, 0.5, 0, mag); T.push(mag);
    const sharp = new cv.Mat(); cv.threshold(mag, sharp, KNOBS.gradThresh, 255, cv.THRESH_BINARY); T.push(sharp);
    const R = Math.max(5, Math.round(KNOBS.shadowRpct * Math.min(gray.rows, gray.cols)));
    const ker = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(R, R)); T.push(ker);
    const supported = new cv.Mat(); cv.dilate(sharp, supported, ker); T.push(supported);
    const keep = new cv.Mat(); cv.bitwise_and(mask, supported, keep); T.push(keep);
    const ff = keep.clone(); T.push(ff);
    const ffMask = new cv.Mat(keep.rows + 2, keep.cols + 2, cv.CV_8UC1, new cv.Scalar(0)); T.push(ffMask);
    cv.floodFill(ff, ffMask, new cv.Point(0, 0), new cv.Scalar(255));
    const inv = new cv.Mat(); cv.bitwise_not(ff, inv); T.push(inv);
    const filled = new cv.Mat(); cv.bitwise_or(keep, inv, filled); T.push(filled);
    const out = cv.countNonZero(filled) < 0.3 * Math.max(1, cv.countNonZero(mask)) ? mask.clone() : filled.clone();
    T.forEach((m) => m.delete());
    return out;
  } catch (e) { T.forEach((m) => { try { m.delete(); } catch {} }); console.log('suppress err', e.message); return mask.clone(); }
}

// ── Classical tool detector (port of cvWorker.buildToolMask) ──────────────────
// Three cues, kept SEPARATE so we can see which one catches a given tool:
//   chroma (coloured), dark (black/dark), variance (chrome/textured).
const T_CHROMA = 9, DARK_K = 0.55, T_VAR = 70;
function paperInteriorMask(cv, quad, rows, cols) {
  const m = cv.Mat.zeros(rows, cols, cv.CV_8U);
  const pts = cv.matFromArray(4, 1, cv.CV_32SC2, quad.flatMap((p) => [Math.round(p.x), Math.round(p.y)]));
  const mv = new cv.MatVector(); mv.push_back(pts);
  cv.fillPoly(m, mv, new cv.Scalar(255));
  const margin = Math.max(10, Math.round(cols * 0.008));
  const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(margin, margin));
  cv.erode(m, m, k);
  [pts, mv, k].forEach((x) => x.delete());
  return m;
}
function medianMasked(cv, chan, mask) {
  const hist = new cv.Mat(); const sv = new cv.MatVector(); sv.push_back(chan);
  cv.calcHist(sv, [0], mask, hist, [256], [0, 256], false);
  let total = 0; for (let i = 0; i < 256; i++) total += hist.data32F[i];
  let sum = 0, med = 128;
  for (let i = 0; i < 256; i++) { sum += hist.data32F[i]; if (sum >= total / 2) { med = i; break; } }
  hist.delete(); sv.delete();
  return med;
}
function buildToolMaskCues(cv, src, quad) {
  const rows = src.rows, cols = src.cols, T = [];
  const rgb = new cv.Mat(); cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB); T.push(rgb);
  const lab = new cv.Mat(); cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab); T.push(lab);
  const ch = new cv.MatVector(); cv.split(lab, ch);
  const L = ch.get(0), A = ch.get(1), B = ch.get(2);
  const interior = paperInteriorMask(cv, quad, rows, cols);
  const pL = medianMasked(cv, L, interior), pA = medianMasked(cv, A, interior), pB = medianMasked(cv, B, interior);
  const Af = new cv.Mat(), Bf = new cv.Mat(); A.convertTo(Af, cv.CV_32F); B.convertTo(Bf, cv.CV_32F); T.push(Af, Bf);
  const pAm = new cv.Mat(rows, cols, cv.CV_32F, new cv.Scalar(pA)); const pBm = new cv.Mat(rows, cols, cv.CV_32F, new cv.Scalar(pB)); T.push(pAm, pBm);
  const dA = new cv.Mat(), dB = new cv.Mat(); cv.absdiff(Af, pAm, dA); cv.absdiff(Bf, pBm, dB); cv.multiply(dA, dA, dA); cv.multiply(dB, dB, dB); T.push(dA, dB);
  const chroma2 = new cv.Mat(); cv.add(dA, dB, chroma2); T.push(chroma2);
  const chroma = new cv.Mat(); cv.threshold(chroma2, chroma, T_CHROMA * T_CHROMA, 255, cv.THRESH_BINARY); chroma.convertTo(chroma, cv.CV_8U);
  const darkRaw = new cv.Mat(); cv.threshold(L, darkRaw, DARK_K * pL, 255, cv.THRESH_BINARY_INV); T.push(darkRaw);
  const grayF = new cv.Mat(); L.convertTo(grayF, cv.CV_32F); T.push(grayF);
  const vk0 = Math.max(5, Math.round(Math.min(rows, cols) * 0.012)); const kVar = vk0 % 2 ? vk0 : vk0 + 1;
  const meanI = new cv.Mat(), meanI2 = new cv.Mat(), grayF2 = new cv.Mat(); cv.multiply(grayF, grayF, grayF2); cv.blur(grayF, meanI, new cv.Size(kVar, kVar)); cv.blur(grayF2, meanI2, new cv.Size(kVar, kVar)); T.push(meanI, meanI2, grayF2);
  const varMat = new cv.Mat(), meanI2sq = new cv.Mat(); cv.multiply(meanI, meanI, meanI2sq); cv.absdiff(meanI2, meanI2sq, varMat); T.push(varMat, meanI2sq);
  const var8 = new cv.Mat(); cv.threshold(varMat, var8, T_VAR, 255, cv.THRESH_BINARY); var8.convertTo(var8, cv.CV_8U); T.push(var8);
  const dark = new cv.Mat(); cv.bitwise_and(darkRaw, var8, dark);
  const ve0 = Math.max(3, Math.round(kVar / 2)); const evSz = ve0 % 2 ? ve0 : ve0 + 1;
  const kVE = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(evSz, evSz));
  const varTight = new cv.Mat(); cv.erode(var8, varTight, kVE); kVE.delete();
  const union = new cv.Mat(); cv.bitwise_or(chroma, dark, union); cv.bitwise_or(union, varTight, union);
  for (const m of [chroma, dark, varTight, union]) cv.bitwise_and(m, interior, m);
  const kClean = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3)); cv.morphologyEx(union, union, cv.MORPH_OPEN, kClean); cv.morphologyEx(union, union, cv.MORPH_CLOSE, kClean); kClean.delete();
  L.delete(); A.delete(); B.delete(); ch.delete(); interior.delete();
  T.forEach((m) => m.delete());
  return { chroma, dark, varTight, union };
}

function drawContours(cv, dst, binary, col, lw) {
  const cs = new cv.MatVector(), h = new cv.Mat();
  cv.findContours(binary, cs, h, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  for (let i = 0; i < cs.size(); i++) cv.drawContours(dst, cs, i, col, lw);
  cs.delete(); h.delete();
}

// OpenCV.js BLOCKS the event loop after its init callback fires, so any `await` after
// init never resumes. Work around it: decode every input image FIRST (async sharp),
// then load OpenCV and do all CV work + output SYNCHRONOUSLY inside onRuntimeInitialized
// (write PNGs with pngjs's sync encoder), and process.exit from there.
(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const files = fs.readdirSync(IN).filter((f) => /\.(jpe?g|png)$/i.test(f));
  const imgs = [];
  for (const f of files) {
    const { data, info } = await sharp(join(IN, f)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    imgs.push({ f, data: new Uint8Array(data), width: info.width, height: info.height });
  }

  const cjs = join(__dirname, '_cv_runtime.cjs');
  fs.copyFileSync(join(ROOT, 'public', 'opencv.js'), cjs);
  globalThis.Module = { onRuntimeInitialized() {
    const cv = globalThis.cv || globalThis.Module;
    try { fs.rmSync(cjs); } catch {}
    console.log(`KNOBS ${JSON.stringify(KNOBS)}\n`);
    for (const im of imgs) {
      try {
        const { f, data, width, height } = im;
        const src = new cv.Mat(height, width, cv.CV_8UC4); src.data.set(data);
        const gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        const res = detectCorners(cv, src, gray, width * height);
        if (res.mask) { // dump the binary white-paper mask for diagnosis
          const mp = new PNG({ width, height }); const mc = new cv.Mat(); cv.cvtColor(res.mask, mc, cv.COLOR_GRAY2RGBA); mp.data = Buffer.from(mc.data);
          fs.writeFileSync(join(OUT, `${basename(f, extname(f))}_mask.png`), PNG.sync.write(mp)); mc.delete(); res.mask.delete();
        }
        if (!res.edge) { console.log(`${f.padEnd(16)} NO PAPER`); src.delete(); gray.delete(); continue; }

        if (MODE === 'shadow') {
          // Build the tool+shadow proxy mask, run the fix, draw raw (RED) vs cleaned (GREEN).
          const rawMask = toolShadowMask(cv, gray, res.grad);
          const cleaned = suppressShadowNoise(cv, rawMask, src);
          const lw2 = Math.max(2, Math.round(width / 350));
          drawContours(cv, src, rawMask, new cv.Scalar(255, 40, 40, 255), lw2);   // RED  = with shadow (raw SOD-like)
          drawContours(cv, src, cleaned, new cv.Scalar(40, 230, 40, 255), lw2);   // GREEN = after shadow-suppress
          const aR = cv.countNonZero(rawMask), aC = cv.countNonZero(cleaned);
          console.log(`${f.padEnd(16)} raw=${aR} cleaned=${aC} kept=${(100 * aC / Math.max(1, aR)).toFixed(0)}%`);
          const png = new PNG({ width, height }); png.data = Buffer.from(src.data);
          fs.writeFileSync(join(OUT, `${basename(f, extname(f))}_shadow.png`), PNG.sync.write(png));
          rawMask.delete(); cleaned.delete(); src.delete(); gray.delete(); continue;
        }

        if (MODE === 'tools') {
          // Render the 3 classical cues separately to see which catches each tool.
          const cues = buildToolMaskCues(cv, src, res.grad);
          const lw2 = Math.max(2, Math.round(width / 350));
          drawContours(cv, src, cues.chroma, new cv.Scalar(60, 120, 255, 255), lw2);  // BLUE  = coloured cue
          drawContours(cv, src, cues.dark, new cv.Scalar(60, 230, 60, 255), lw2);      // GREEN = dark cue
          drawContours(cv, src, cues.varTight, new cv.Scalar(255, 40, 40, 255), lw2);  // RED   = chrome/variance cue
          console.log(`${f.padEnd(16)} chroma=${cv.countNonZero(cues.chroma)} dark=${cv.countNonZero(cues.dark)} chrome=${cv.countNonZero(cues.varTight)} union=${cv.countNonZero(cues.union)}`);
          const png = new PNG({ width, height }); png.data = Buffer.from(src.data);
          fs.writeFileSync(join(OUT, `${basename(f, extname(f))}_tools.png`), PNG.sync.write(png));
          cues.chroma.delete(); cues.dark.delete(); cues.varTight.delete(); cues.union.delete();
          src.delete(); gray.delete(); continue;
        }

        const lw = Math.max(2, Math.round(width / 400)), cr = Math.max(4, Math.round(width / 120));
        const drawQuad = (q, col) => { for (let i = 0; i < 4; i++) cv.line(src, new cv.Point(q[i].x, q[i].y), new cv.Point(q[(i + 1) % 4].x, q[(i + 1) % 4].y), col, lw); for (const p of q) cv.circle(src, new cv.Point(p.x, p.y), cr, col, -1); };
        drawQuad(res.edge, new cv.Scalar(0, 220, 0, 255));   // GREEN = mask/edge-line stage
        drawQuad(res.grad, new cv.Scalar(0, 200, 255, 255)); // CYAN  = gradient-refined (final)
        const c4 = res.grad, e = res.edge;
        const w2 = (dist(c4[0], c4[1]) + dist(c4[3], c4[2])) / 2, h2 = (dist(c4[0], c4[3]) + dist(c4[1], c4[2])) / 2;
        const fmt = (q) => `TL(${q[0].x|0},${q[0].y|0}) TR(${q[1].x|0},${q[1].y|0}) BR(${q[2].x|0},${q[2].y|0}) BL(${q[3].x|0},${q[3].y|0})`;
        console.log(`${f.padEnd(16)} ${width}x${height} ppm=${(Math.max(w2, h2) / 297).toFixed(2)}\n   edge ${fmt(e)}\n   grad ${fmt(c4)}`);
        const png = new PNG({ width, height }); png.data = Buffer.from(src.data);
        fs.writeFileSync(join(OUT, `${basename(f, extname(f))}_det.png`), PNG.sync.write(png));
        src.delete(); gray.delete();
      } catch (e) { console.log(`${im.f.padEnd(16)} ERROR: ${(e && e.message ? e.message : String(e)).slice(0, 140)}`); }
    }
    console.log(`\nDone -> ${OUT}`);
    process.exit(0);
  } };
  require(cjs);
})();
