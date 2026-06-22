/**
 * OpenCV Web Worker - Enhanced Edge Detection Strategy
 * 
 * Implements strategic improvements for 90%+ accuracy:
 * - CLAHE contrast enhancement (when needed)
 * - Bilateral filtering (edge-preserving)
 * - Auto-tuned Canny (median-based)
 * - Smart paper-aware thresholding
 * - Morphological repair
 * - Quality-based contour selection (solidity, rectangularity)
 * - Tighter contour approximation for tool precision
 * 
 * Core Assumptions:
 * - A4 sheet is the standard paper size
 * - Paper is white
 * - Tools are NOT white
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// Load OpenCV.js from public directory
(self as any).importScripts('/opencv.js');

// Types
interface Point2D { x: number; y: number }
interface PaperCorners { topLeft: Point2D; topRight: Point2D; bottomRight: Point2D; bottomLeft: Point2D }

// Result of any tracing operation. `confidence` (0..1) reflects how tool-like
// the detected contour is (solidity, fill, aspect) — used for UI warnings.
interface TraceResult { points: Point2D[]; area: number; confidence?: number }

// A refinement stroke: a polyline of image-space points the user painted.
interface Stroke { points: Point2D[] }

type WorkerMessageType =
  | 'init' | 'detectPaper' | 'traceTool' | 'traceRegion' | 'traceAllTools'
  | 'grabCutInit' | 'grabCutRefine' | 'grabCutClear' | 'contourFromMask' | 'proposeRegions' | 'traceMask';

interface WorkerMessage { id: string; type: WorkerMessageType; payload: any }
interface WorkerResponse { id: string; type: 'success' | 'error'; payload: any }

// Constants
const A4_WIDTH_MM = 210;
const A4_HEIGHT_MM = 297;
const A4_ASPECT = A4_HEIGHT_MM / A4_WIDTH_MM; // ~1.414

// State
let cv: any = null;
let initPromise: Promise<void> | null = null;

// Persistent GrabCut session — kept between the initial box trace and the
// interactive refinement strokes so the user can iteratively correct a tool.
interface GrabCutSession {
  rgb: any;   // downscaled 3-channel image
  mask: any;  // grabCut label mask (0=BGD,1=FGD,2=PR_BGD,3=PR_FGD)
  bgd: any;   // background GMM model (reused across iterations)
  fgd: any;   // foreground GMM model
  scale: number; // originalCoord * scale = downscaled coord
}
let gcSession: GrabCutSession | null = null;

// ============================================================================
// OpenCV Initialization
// ============================================================================

function initOpenCV(): Promise<void> {
  if (cv) return Promise.resolve();
  if (initPromise) return initPromise;

  initPromise = new Promise((resolve, reject) => {
    const cvLib = (self as any).cv;

    if (!cvLib) {
      reject(new Error('OpenCV.js failed to load'));
      return;
    }

    if (typeof cvLib.Mat === 'function') {
      cv = cvLib;
      console.log('OpenCV ready');
      resolve();
      return;
    }

    cvLib.onRuntimeInitialized = () => {
      cv = cvLib;
      console.log('OpenCV initialized');
      resolve();
    };

    setTimeout(() => {
      if (!cv) reject(new Error('OpenCV init timeout'));
    }, 10000);
  });

  return initPromise;
}

// ============================================================================
// Utility Helpers
// ============================================================================

const deleteMats = (...mats: any[]) => mats.forEach(m => m?.delete?.());
const dist = (a: Point2D, b: Point2D) => Math.hypot(b.x - a.x, b.y - a.y);
const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(max, val));

const orderCorners = (pts: Point2D[]): Point2D[] => {
  const sorted = [...pts].sort((a, b) => a.y - b.y);
  const top = sorted.slice(0, 2).sort((a, b) => a.x - b.x);
  const bot = sorted.slice(2, 4).sort((a, b) => a.x - b.x);
  return [top[0], top[1], bot[1], bot[0]]; // TL, TR, BR, BL
};

// Robust 4-corner finder for a (possibly perspective) sheet: the extreme points of
// the convex hull — TL=min(x+y), BR=max(x+y), TR=max(x−y), BL=min(x−y). This is the
// standard document-scanner technique. Unlike cv.minAreaRect (which fits a RECTANGLE
// and so mis-places corners on a tilted/trapezoidal sheet) it returns the true quad,
// and unlike approxPolyDP it doesn't depend on a fragile epsilon. Returns TL,TR,BR,BL.
const extremeQuadCorners = (contour: any): Point2D[] | null => {
  const hull = new cv.Mat();
  cv.convexHull(contour, hull, false, true); // returnPoints = true → CV_32SC2
  const n = hull.rows;
  if (n < 4) { hull.delete(); return null; }
  let tl: Point2D | null = null, tr: Point2D | null = null, br: Point2D | null = null, bl: Point2D | null = null;
  let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = hull.data32S[i * 2], y = hull.data32S[i * 2 + 1];
    const sum = x + y, diff = x - y;
    if (sum < minSum) { minSum = sum; tl = { x, y }; }
    if (sum > maxSum) { maxSum = sum; br = { x, y }; }
    if (diff > maxDiff) { maxDiff = diff; tr = { x, y }; }
    if (diff < minDiff) { minDiff = diff; bl = { x, y }; }
  }
  hull.delete();
  return tl && tr && br && bl ? [tl, tr, br, bl] : null;
};

// Quadrilateral area (shoelace) for ordered TL,TR,BR,BL corners.
const quadArea = (q: Point2D[]): number => {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const j = (i + 1) % q.length;
    a += q[i].x * q[j].y - q[j].x * q[i].y;
  }
  return Math.abs(a) / 2;
};

// ── Edge-line corner refinement ──────────────────────────────────────────────
// Line as ax + by + c = 0 (a,b unit normal).
type Line = { a: number; b: number; c: number };
const lineThrough = (p: Point2D, q: Point2D): Line => {
  const dx = q.x - p.x, dy = q.y - p.y;
  const a = -dy, b = dx, n = Math.hypot(a, b) || 1;
  return { a: a / n, b: b / n, c: -((a / n) * p.x + (b / n) * p.y) };
};
// Total-least-squares line fit (PCA on the point covariance).
const fitLineTLS = (pts: Point2D[]): Line => {
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= pts.length; my /= pts.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy); // major-axis direction
  const a = -Math.sin(theta), b = Math.cos(theta);     // normal = perpendicular
  return { a, b, c: -(a * mx + b * my) };
};
const intersectLines = (l1: Line, l2: Line): Point2D | null => {
  const det = l1.a * l2.b - l2.a * l1.b;
  if (Math.abs(det) < 1e-9) return null; // parallel
  return { x: (l1.b * l2.c - l2.b * l1.c) / det, y: (l2.a * l1.c - l1.a * l2.c) / det };
};
// Distance from p to segment a→b + the (unclamped) parameter t along it.
const ptSeg = (p: Point2D, a: Point2D, b: Point2D): { d: number; t: number } => {
  const vx = b.x - a.x, vy = b.y - a.y, len2 = vx * vx + vy * vy || 1;
  const t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  const tc = Math.max(0, Math.min(1, t));
  return { d: Math.hypot(p.x - (a.x + tc * vx), p.y - (a.y + tc * vy)), t };
};

// Snap the 4 corners exactly onto the sheet edges: assign each contour point to the
// nearest of the 4 edges (corner regions excluded), fit a line per edge, and intersect
// adjacent lines. This recovers true sharp corners on the paper boundary even when the
// mask corners are rounded/shrunk inward by morphology — the cause of the trace sitting
// INSIDE the A4. Guarded: falls back to the input corner on any degeneracy/large drift.
const refineByEdgeLines = (contour: any, ordered: Point2D[]): Point2D[] => {
  try {
    const n = contour.rows;
    if (n < 16) return ordered;
    const d = contour.data32S;
    const segs: [Point2D, Point2D][] = [
      [ordered[0], ordered[1]], [ordered[1], ordered[2]],
      [ordered[2], ordered[3]], [ordered[3], ordered[0]],
    ];
    const segLen = segs.map(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y));
    const buckets: Point2D[][] = [[], [], [], []];
    for (let i = 0; i < n; i++) {
      const p = { x: d[i * 2], y: d[i * 2 + 1] };
      let bi = 0, bd = Infinity, bt = 0;
      for (let s = 0; s < 4; s++) { const r = ptSeg(p, segs[s][0], segs[s][1]); if (r.d < bd) { bd = r.d; bi = s; bt = r.t; } }
      if (bt > 0.12 && bt < 0.88) buckets[bi].push(p); // drop rounded corner regions
    }
    const lines = buckets.map((pts, s) => (pts.length >= 6 ? fitLineTLS(pts) : lineThrough(segs[s][0], segs[s][1])));
    const maxLen = Math.max(...segLen);
    return ordered.map((c, k) => {
      const p = intersectLines(lines[(k + 3) % 4], lines[k]);
      return p && Math.hypot(p.x - c.x, p.y - c.y) < 0.1 * maxLen ? p : c;
    });
  } catch {
    return ordered;
  }
};

// Compute median of grayscale image for auto-tuned Canny
function computeMedian(gray: any): number {
  const hist = new cv.Mat();
  const mask = new cv.Mat();
  const histSize = [256];
  const ranges = [0, 256];

  const srcVec = new cv.MatVector();
  srcVec.push_back(gray);
  cv.calcHist(srcVec, [0] as any, mask, hist, histSize as any, ranges as any, false);
  srcVec.delete();

  const totalPixels = gray.rows * gray.cols;
  let sum = 0;
  let median = 128;

  for (let i = 0; i < 256; i++) {
    sum += hist.data32F[i];
    if (sum >= totalPixels / 2) {
      median = i;
      break;
    }
  }

  deleteMats(hist, mask);
  return median;
}

// Calculate contour solidity (area / convex hull area)
function calculateSolidity(contour: any): number {
  const area = cv.contourArea(contour);
  const hull = new cv.Mat();
  cv.convexHull(contour, hull);
  const hullArea = cv.contourArea(hull);
  hull.delete();
  return hullArea > 0 ? area / hullArea : 0;
}

// Calculate rectangularity (how close to a rectangle)
function calculateRectangularity(contour: any): number {
  const area = cv.contourArea(contour);
  const rect = cv.minAreaRect(contour);
  const rectArea = rect.size.width * rect.size.height;
  return rectArea > 0 ? area / rectArea : 0;
}

// ============================================================================
// Accuracy Helpers — shared by every tracing entry point
// These build a single high-fidelity tool mask and score it, so click-trace,
// box-trace and auto-detect-all share identical, well-tuned behaviour.
// ============================================================================

// Filled binary mask of the paper quad interior (caller must delete()).
function paperInteriorMask(corners: PaperCorners, rows: number, cols: number): any {
  const m = cv.Mat.zeros(rows, cols, cv.CV_8U);
  const ptsVec = new cv.MatVector();
  const ptsMat = new cv.Mat(4, 1, cv.CV_32SC2);
  const c = [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft];
  for (let i = 0; i < 4; i++) {
    ptsMat.data32S[i * 2] = Math.round(c[i].x);
    ptsMat.data32S[i * 2 + 1] = Math.round(c[i].y);
  }
  ptsVec.push_back(ptsMat);
  cv.fillPoly(m, ptsVec, new cv.Scalar(255));
  deleteMats(ptsVec, ptsMat);

  // Erode by a small margin to strip away transition noise at the paper boundary
  const margin = Math.max(10, Math.round(cols * 0.008));
  const kErode = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(margin, margin));
  cv.erode(m, m, kErode);
  kErode.delete();

  return m;
}

// Thin border ring of the image — used to sample the paper colour when the
// paper quad is unknown (e.g. a box-selected ROI, where the margins are paper).
function borderMask(rows: number, cols: number): any {
  const m = cv.Mat.zeros(rows, cols, cv.CV_8U);
  const t = Math.max(4, Math.round(Math.min(rows, cols) * 0.06));
  cv.rectangle(m, new cv.Point(0, 0), new cv.Point(cols - 1, rows - 1), new cv.Scalar(255), t);
  return m;
}

// Per-channel median over an optional mask (robust paper-colour estimate that
// ignores the minority of tool pixels). Uses a histogram, so it's cheap.
function medianMasked(chan: any, mask: any): number {
  const hist = new cv.Mat();
  const srcVec = new cv.MatVector();
  srcVec.push_back(chan);
  cv.calcHist(srcVec, [0] as any, mask, hist, [256] as any, [0, 256] as any, false);

  let total = 0;
  for (let i = 0; i < 256; i++) total += hist.data32F[i];
  let sum = 0;
  let med = 128;
  for (let i = 0; i < 256; i++) {
    sum += hist.data32F[i];
    if (sum >= total / 2) { med = i; break; }
  }

  deleteMats(hist, srcVec);
  return med;
}

// Detection thresholds in CIE-Lab. Channel DIFFERENCES are identical in
// OpenCV's 8-bit Lab and textbook Lab because the a/b +128 offset cancels in a
// subtraction, so these transfer directly from harness calibration.
const T_CHROMA = 9;   // a,b distance for a "coloured" tool (paper noise ~2-3)
const DARK_K = 0.55;  // "dark" tool if L < DARK_K · paperL (shadows stay above)
const T_VAR = 70;     // local grayscale variance threshold for chrome/textured tools
                      // paper flat regions ≈ 5-20, screw threads ≈ 100-800

// Build a binary tool mask that is PAPER-COLOUR-AGNOSTIC and ROBUST.
//
// A pixel is foreground if it differs from the SAMPLED paper colour by an
// ABSOLUTE margin in one of THREE independent, physical ways:
//   • chroma distance √((a-pA)²+(b-pB)²) > T_CHROMA → coloured tools (shadow-proof)
//   • lightness L < DARK_K · paperL                  → black/dark tools
//   • local grayscale variance > T_VAR               → chrome/textured tools (screw threads,
//                                                       knurled surfaces, etc.)
//
// The variance cue is critical for polished chrome tools (e.g. extruder screws,
// screwdriver shafts) that are bright and achromatic — invisible to the first two cues.
// Shadow suppression: smooth regions (variance < T_VAR) are excluded from the
// darkness cue to prevent paper fold shadows from being mis-detected.
function buildToolMask(src: any, paperCorners?: PaperCorners): any {
  const rows = src.rows;
  const cols = src.cols;

  // Lab colour space.
  const rgb = new cv.Mat();
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  const lab = new cv.Mat();
  cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
  const ch = new cv.MatVector();
  cv.split(lab, ch);
  const L = ch.get(0);
  const A = ch.get(1);
  const B = ch.get(2);

  // Paper anchor colour = per-channel median over the paper interior (or, if
  // unknown, the image border ring around a box-selected tool).
  const interior = paperCorners ? paperInteriorMask(paperCorners, rows, cols) : null;
  const sampleMask = interior ?? borderMask(rows, cols);
  const pL = medianMasked(L, sampleMask);
  const pA = medianMasked(A, sampleMask);
  const pB = medianMasked(B, sampleMask);

  // Chroma distance² = (a-pA)² + (b-pB)²  → coloured tools.
  const Af = new cv.Mat();
  const Bf = new cv.Mat();
  A.convertTo(Af, cv.CV_32F);
  B.convertTo(Bf, cv.CV_32F);
  const pAm = new cv.Mat(rows, cols, cv.CV_32F, new cv.Scalar(pA));
  const pBm = new cv.Mat(rows, cols, cv.CV_32F, new cv.Scalar(pB));
  const dA = new cv.Mat();
  const dB = new cv.Mat();
  cv.absdiff(Af, pAm, dA);
  cv.absdiff(Bf, pBm, dB);
  cv.multiply(dA, dA, dA);
  cv.multiply(dB, dB, dB);
  const chroma2 = new cv.Mat();
  cv.add(dA, dB, chroma2);
  const maskChroma = new cv.Mat();
  cv.threshold(chroma2, maskChroma, T_CHROMA * T_CHROMA, 255, cv.THRESH_BINARY);
  maskChroma.convertTo(maskChroma, cv.CV_8U);

  // Darkness: L < DARK_K · paperL  → black / dark tools.
  // Shadow-suppressed: also require local variance > 10 to reject smooth paper shadows.
  const maskDarkRaw = new cv.Mat();
  cv.threshold(L, maskDarkRaw, DARK_K * pL, 255, cv.THRESH_BINARY_INV);

  // ── CUE 3: Local Variance (chrome / textured tools) ──────────────────────
  // Polished chrome tools (extruder screws, screwdriver shafts) are bright and
  // achromatic — invisible to cues 1 & 2. But they show sharp local pixel
  // variance from surface texture, reflections, and thread geometry.
  //
  // localVar = E[I²] - (E[I])² via 15×15 box blur on float grayscale.
  const grayF = new cv.Mat();
  L.convertTo(grayF, cv.CV_32F);
  const varKSize = Math.max(5, Math.round(Math.min(rows, cols) * 0.012)); // ~1.2% of min dim
  const kVar = varKSize % 2 === 0 ? varKSize + 1 : varKSize;

  const meanI = new cv.Mat();
  const meanI2 = new cv.Mat();
  const grayF2 = new cv.Mat();
  cv.multiply(grayF, grayF, grayF2);
  cv.blur(grayF, meanI, new cv.Size(kVar, kVar));
  cv.blur(grayF2, meanI2, new cv.Size(kVar, kVar));

  // var = E[I²] - E[I]²  (always ≥ 0 in theory, but clamp for float precision)
  const varMat = new cv.Mat();
  const meanI2sq = new cv.Mat();
  cv.multiply(meanI, meanI, meanI2sq);
  cv.absdiff(meanI2, meanI2sq, varMat);

  const maskVar8 = new cv.Mat();
  cv.threshold(varMat, maskVar8, T_VAR, 255, cv.THRESH_BINARY);
  maskVar8.convertTo(maskVar8, cv.CV_8U);

  // Shadow-suppress the darkness mask: a dark region is only a tool if it ALSO
  // has meaningful local variance (i.e. it's not a smooth paper shadow).
  const maskDark = new cv.Mat();
  cv.bitwise_and(maskDarkRaw, maskVar8, maskDark);

  // The box-blur variance cue blooms ~half the variance window BEYOND the true
  // tool edge — inflating chrome tools outward (the spanner-ring overshoot) and
  // bridging tools that sit close together (two blooms touch -> one blob). Erode
  // the chrome cue back to the true silhouette so outlines hug the edge (~0.2mm)
  // and nearby tools stay SEPARATE. The dark-gate above keeps the full variance
  // so dark tool edges aren't clipped.
  const varErode = Math.max(3, Math.round(kVar / 2));
  const evSz = varErode % 2 ? varErode : varErode + 1;
  const kVarErode = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(evSz, evSz));
  const maskVarTight = new cv.Mat();
  cv.erode(maskVar8, maskVarTight, kVarErode);
  kVarErode.delete();

  // Union of all three cues.
  const mask = new cv.Mat();
  cv.bitwise_or(maskChroma, maskDark, mask);
  cv.bitwise_or(mask, maskVarTight, mask);

  // Restrict to the paper interior when known.
  if (interior) cv.bitwise_and(mask, interior, mask);

  // Minimal cleanup: open removes speckle, close fills small pin-holes. Small
  // 3×3 only — keeps tools tight and SEPARATE (no merging).
  const kClean = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
  cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kClean);
  cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kClean);

  deleteMats(rgb, lab, L, A, B, Af, Bf, pAm, pBm, dA, dB, chroma2,
             maskChroma, maskDarkRaw, maskDark, grayF, grayF2, meanI, meanI2,
             meanI2sq, varMat, maskVar8, maskVarTight, kClean);
  ch.delete();
  if (sampleMask !== interior) sampleMask.delete();
  if (interior) interior.delete();
  return mask;
}

// Geometric confidence (0..1): how "tool-like" a contour is. Combines solidity
// (area / convex-hull), extent (fill of its min-area rect) and a gentle penalty
// for extreme slivers. Cheap, robust, and a good proxy for trace quality.
function contourConfidence(contour: any): number {
  const area = cv.contourArea(contour);
  if (area <= 0) return 0;

  const solidity = calculateSolidity(contour);
  const rect = cv.minAreaRect(contour);
  const rw = rect.size.width;
  const rh = rect.size.height;
  const rectArea = rw * rh;
  const extent = rectArea > 0 ? Math.min(area / rectArea, 1) : 0;
  const aspect = Math.max(rw, rh) / Math.max(Math.min(rw, rh), 1);
  // Long thin tools are valid; only punish extreme streak-like noise (aspect>20).
  const aspectScore = Math.max(0, 1 - Math.max(0, aspect - 20) / 20);

  return Math.max(0, Math.min(1, 0.55 * solidity + 0.35 * extent + 0.10 * aspectScore));
}

// ============================================================================
// Image Preprocessing
// ============================================================================

// Apply CLAHE for contrast enhancement
function applyCLAHE(gray: any, clipLimit = 2.0, tileSize = 8): any {
  const clahe = new cv.CLAHE(clipLimit, new cv.Size(tileSize, tileSize));
  const enhanced = new cv.Mat();
  clahe.apply(gray, enhanced);
  clahe.delete();
  return enhanced;
}

// Check if image needs contrast enhancement
function needsContrastEnhancement(gray: any): boolean {
  const mean = new cv.Mat();
  const stddev = new cv.Mat();
  cv.meanStdDev(gray, mean, stddev);
  const std = stddev.data64F[0];
  deleteMats(mean, stddev);
  return std < 50; // Low std dev = poor contrast
}

// Auto-tuned Canny edge detection using median-based thresholds
function autoTunedCanny(blurred: any, sigma = 0.33): any {
  const median = computeMedian(blurred);
  const lower = clamp(Math.round((1 - sigma) * median), 10, 100);
  const upper = clamp(Math.round((1 + sigma) * median), 50, 200);

  console.log(`Auto Canny: median=${median}, thresholds=[${lower}, ${upper}]`);

  const edges = new cv.Mat();
  cv.Canny(blurred, edges, lower, upper);
  return edges;
}

// ============================================================================
// Paper Detection (Enhanced)
// ============================================================================

function detectPaper(imageData: ImageData) {
  console.log('Detecting paper...', imageData.width, 'x', imageData.height);
  const src = cv.matFromImageData(imageData);
  const totalArea = src.rows * src.cols;

  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  // Strategy 1: White paper detection (primary - paper is always white)
  let best = detectWhitePaper(src, totalArea);

  // Strategy 2: Edge-based detection (fallback)
  if (!best || best.confidence < 0.6) {
    const edgeResult = detectPaperByEdges(gray, totalArea);
    if (edgeResult && (!best || edgeResult.confidence > best.confidence)) {
      best = edgeResult;
    }
  }

  if (!best || best.confidence < 0.2) {
    deleteMats(src, gray);
    return { detected: false, confidence: 0, corners: null, pixelsPerMm: null, message: 'No paper detected' };
  }

  const [tl, tr, br, bl] = orderCorners(best.points);
  deleteMats(src, gray);
  const corners: PaperCorners = { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl };

  const avgW = (dist(tl, tr) + dist(bl, br)) / 2;
  const avgH = (dist(tl, bl) + dist(tr, br)) / 2;
  const landscape = avgW > avgH;
  const pixelsPerMm = landscape
    ? (avgW / A4_HEIGHT_MM + avgH / A4_WIDTH_MM) / 2
    : (avgW / A4_WIDTH_MM + avgH / A4_HEIGHT_MM) / 2;

  console.log('Paper detected:', Math.round(best.confidence * 100) + '%');
  return {
    detected: true,
    confidence: best.confidence,
    corners,
    pixelsPerMm,
    message: ``,
  };
}

// Skew-correct the photo to a flat, true-to-A4 image via a perspective homography
// from the 4 detected/dragged paper corners. Returns a rectified RGBA image whose
// border IS the A4 sheet — so every downstream step (SOD/SAM/GrabCut/classical/
// shadow) runs unchanged on an undistorted, to-scale sheet. Areas outside the quad
// fill white (paper-coloured) so they read as background.
function rectifyToA4(imageData: ImageData, corners: PaperCorners): { rgba: ArrayBuffer; width: number; height: number } {
  const A4_SHORT = 210, A4_LONG = 297;
  const { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl } = corners;

  // Paper pixel size (average opposite edges) → choose a target that preserves A4
  // aspect, oriented from the detected quad, long side ≈ detected px (capped 2000).
  const paperW = (dist(tl, tr) + dist(bl, br)) / 2;
  const paperH = (dist(tl, bl) + dist(tr, br)) / 2;
  const landscape = paperW > paperH;
  const longPx = clamp(Math.round(Math.max(paperW, paperH)), 200, 2000);
  const shortPx = Math.round(longPx * (A4_SHORT / A4_LONG));
  const dstW = landscape ? longPx : shortPx;
  const dstH = landscape ? shortPx : longPx;

  const src = cv.matFromImageData(imageData); // CV_8UC4 (RGBA)
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, dstW, 0, dstW, dstH, 0, dstH]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const dst = new cv.Mat();
  cv.warpPerspective(src, dst, M, new cv.Size(dstW, dstH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));

  const rgba = new Uint8ClampedArray(dst.data).buffer; // copy RGBA bytes out of the Mat
  const width = dst.cols, height = dst.rows;
  deleteMats(src, srcTri, dstTri, M, dst);
  console.log(`rectifyToA4: ${imageData.width}x${imageData.height} -> ${width}x${height} (${landscape ? 'landscape' : 'portrait'})`);
  return { rgba, width, height };
}

// Detect white paper using HSV color segmentation (widened thresholds)
function detectWhitePaper(src: any, totalArea: number): { points: Point2D[]; confidence: number } | null {
  const rgb = new cv.Mat();
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  const hsv = new cv.Mat();
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);

  // HEAVY SMOOTHING to remove floor noise/reflections before color mask
  // This is key to preventing the TR corner from pulling toward floor highlights
  const blurred = new cv.Mat();
  cv.GaussianBlur(hsv, blurred, new cv.Size(15, 15), 0);

  // White paper: any hue, low saturation, high value
  const mask = new cv.Mat();
  // Value relaxed to 135 to handle shadows; saturation strictly < 70
  const lowWhite = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), new cv.Scalar(0, 0, 155, 0));
  const highWhite = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), new cv.Scalar(180, 70, 255, 0));
  cv.inRange(blurred, lowWhite, highWhite, mask);

  // Morphological cleanup - VERY aggressive opening (31x31) to kill reflections
  const closeKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(25, 25));
  const openKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(31, 31));
  cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, closeKernel);
  cv.morphologyEx(mask, mask, cv.MORPH_OPEN, openKernel);

  // Zero only a hairline (2px) border so a mask that touches the image edge doesn't
  // wrap the frame — but NOT a full 1%, which clipped the sheet inward (~11px on a
  // 1156px photo) whenever the paper reached the image edge, pulling the trace inside
  // the A4. The edge-line corner fit recovers the true boundary either way.
  const borderW = 2;
  const borderH = 2;

  // Clear the 4 border strips
  cv.rectangle(mask, new cv.Point(0, 0), new cv.Point(mask.cols, borderH), new cv.Scalar(0), -1); // Top
  cv.rectangle(mask, new cv.Point(0, mask.rows - borderH), new cv.Point(mask.cols, mask.rows), new cv.Scalar(0), -1); // Bottom
  cv.rectangle(mask, new cv.Point(0, 0), new cv.Point(borderW, mask.rows), new cv.Scalar(0), -1); // Left
  cv.rectangle(mask, new cv.Point(mask.cols - borderW, 0), new cv.Point(mask.cols, mask.rows), new cv.Scalar(0), -1); // Right

  const result = findBestQuadrilateral(mask, totalArea);

  deleteMats(rgb, hsv, blurred, mask, lowWhite, highWhite, closeKernel, openKernel);
  return result;
}

// Edge-based paper detection with auto-tuned Canny
function detectPaperByEdges(gray: any, totalArea: number): { points: Point2D[]; confidence: number } | null {
  // Apply CLAHE if needed
  let processed = gray;
  const needsCLAHE = needsContrastEnhancement(gray);

  if (needsCLAHE) {
    processed = applyCLAHE(gray, 2.0, 8);
    console.log('Applied CLAHE for paper detection');
  }

  // Bilateral filter - preserves edges better than Gaussian
  const blurred = new cv.Mat();
  cv.bilateralFilter(processed, blurred, 9, 75, 75);

  // Auto-tuned Canny
  const edges = autoTunedCanny(blurred);

  // Morphological repair
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  cv.dilate(edges, edges, kernel);
  cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);

  // Additional dilation to connect nearby edges  
  const dilateKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  cv.dilate(edges, edges, dilateKernel);

  const result = findBestQuadrilateral(edges, totalArea);

  if (needsCLAHE) processed.delete();
  deleteMats(blurred, edges, kernel);

  return result;
}

// Find best quadrilateral with quality scoring and multi-epsilon approach
function findBestQuadrilateral(binary: any, totalArea: number): { points: Point2D[]; confidence: number } | null {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  // CHAIN_APPROX_NONE: keep every boundary pixel so edge-line fitting has dense samples.
  cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);

  let best: { points: Point2D[]; confidence: number } | null = null;

  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    const contourArea = cv.contourArea(contour);

    // Area filter: paper must be at least 5% and can be almost the full image (up to 99.5%)
    if (contourArea < totalArea * 0.05 || contourArea > totalArea * 0.995) {
      contour.delete();
      continue;
    }

    // Robust corners via convex-hull extreme points (handles perspective trapezoids;
    // no fragile epsilon, no rectangle-forcing minAreaRect, no TR-clamp band-aid),
    // then snap them exactly onto the sheet edges by fitting + intersecting edge lines
    // (so the quad sits ON the A4 boundary, not inside it).
    const corners = extremeQuadCorners(contour);
    if (!corners) { contour.delete(); continue; }
    const ordered = refineByEdgeLines(contour, orderCorners(corners));

    const w = (dist(ordered[0], ordered[1]) + dist(ordered[3], ordered[2])) / 2;
    const h = (dist(ordered[0], ordered[3]) + dist(ordered[1], ordered[2])) / 2;
    if (w < 10 || h < 10) { contour.delete(); continue; }
    const aspect = Math.max(w, h) / Math.min(w, h);

    const solidity = calculateSolidity(contour);
    const rectangularity = calculateRectangularity(contour);

    // How well the 4 corners explain the contour: a clean sheet's contour fills its
    // own corner-quad (~1); a wiggly/wrong blob fills much less, so it scores low.
    const qa = quadArea(ordered);
    const fillScore = qa > 0 ? Math.min(contourArea / qa, 1) : 0;

    // Confidence — perspective-tolerant (aspect weighted modestly so a tilted but
    // correctly-cornered sheet isn't penalised for foreshortening).
    const aspectScore = Math.max(0, 1 - Math.abs(aspect - A4_ASPECT) / 0.6) * 0.20;
    const areaScore = Math.min(contourArea / totalArea / 0.3, 1) * 0.20;
    const solidityScore = solidity * 0.20;
    const rectScore = rectangularity * 0.15;
    const fillS = fillScore * 0.25;
    const confidence = aspectScore + areaScore + solidityScore + rectScore + fillS;

    if (confidence > 0.4 && (!best || confidence > best.confidence)) {
      best = { points: ordered, confidence };
    }

    contour.delete();
  }

  deleteMats(contours, hierarchy);
  return best;
}

// ============================================================================
// Tool Tracing (Paper-is-White Silhouette Strategy)
// ============================================================================

function traceTool(
  imageData: ImageData,
  clickX: number,
  clickY: number,
  paperCorners?: PaperCorners
): TraceResult | null {
  console.log('traceTool called at:', clickX, clickY, paperCorners ? '(paper-masked)' : '');
  const src = cv.matFromImageData(imageData);
  const x = Math.max(0, Math.min(src.cols - 1, Math.round(clickX)));
  const y = Math.max(0, Math.min(src.rows - 1, Math.round(clickY)));

  // Primary: fused silhouette restricted to the paper area.
  let result = traceByFusedMask(src, x, y, paperCorners);

  // Fallback: retry without the paper boundary, in case slightly-off corners
  // clipped a tool that sits near the paper edge.
  if (!result && paperCorners) {
    console.log('traceTool: paper-masked trace empty, retrying without boundary');
    result = traceByFusedMask(src, x, y, undefined);
  }

  src.delete();
  console.log('traceTool result:', result ? `${result.points.length} pts, conf=${result.confidence?.toFixed(2)}` : 'null');
  return result;
}

// Click-trace core: build the fused tool mask, then pick the contour at the
// click point (smallest containing, else nearest within a resolution-scaled
// radius). Returns the refined contour with a confidence score.
function traceByFusedMask(
  src: any,
  x: number,
  y: number,
  paperCorners?: PaperCorners
): TraceResult | null {
  const mask = buildToolMask(src, paperCorners);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  // CHAIN_APPROX_NONE keeps every boundary pixel — maximum fidelity; the tight
  // RDP in extractContourPoints then simplifies without losing tool detail.
  cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);

  const minArea = Math.max(800, (src.rows * src.cols) * 0.0005);
  const searchRadius = Math.max(50, Math.round(Math.max(src.rows, src.cols) / 25));

  let bestContour: any = null;
  let bestArea = Infinity;

  // Prefer the smallest contour that actually contains the click point.
  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    const area = cv.contourArea(contour);
    if (area < minArea) continue;
    const d = cv.pointPolygonTest(contour, new cv.Point(x, y), true);
    if (d >= 0 && area < bestArea) {
      bestContour = contour;
      bestArea = area;
    }
  }

  // Otherwise, the nearest contour within the search radius.
  if (!bestContour) {
    let minDist = searchRadius;
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);
      if (area < minArea) continue;
      const d = Math.abs(cv.pointPolygonTest(contour, new cv.Point(x, y), true));
      if (d < minDist) {
        minDist = d;
        bestContour = contour;
        bestArea = area;
      }
    }
  }

  let result: TraceResult | null = null;
  if (bestContour) {
    const confidence = contourConfidence(bestContour);
    result = extractContourPoints(bestContour, 0, 0, bestArea, confidence);
    console.log(`Fused trace: area=${Math.round(bestArea)}, conf=${confidence.toFixed(2)}`);
  }

  deleteMats(mask, contours, hierarchy);
  return result;
}

// Trace rectangular region
function traceRegion(imageData: ImageData, rect: { x: number; y: number; width: number; height: number }) {
  console.log('traceRegion called:', rect);
  const src = cv.matFromImageData(imageData);

  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const w = Math.min(src.cols - x, Math.round(rect.width));
  const h = Math.min(src.rows - y, Math.round(rect.height));

  if (w < 10 || h < 10) {
    src.delete();
    return null;
  }

  const roi = src.roi(new cv.Rect(x, y, w, h));
  const result = findMainObjectInRegion(roi, x, y);

  roi.delete();
  src.delete();

  console.log('traceRegion result:', result ? `${result.points.length} points` : 'null');
  return result;
}

// Find the main object inside a user-drawn box. Uses the same fused mask as
// click/auto-detect, then picks the largest valid contour in the crop (the box
// already isolates the tool, so "largest" is the right selection).
function findMainObjectInRegion(roi: any, offsetX: number, offsetY: number): TraceResult | null {
  const mask = buildToolMask(roi); // no paper boundary — ROI is already bounded

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);

  let largestContour: any = null;
  let largestArea = 0;

  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    const area = cv.contourArea(contour);
    if (area < 200) continue;
    if (calculateSolidity(contour) < 0.3) continue;
    if (area > largestArea) {
      largestArea = area;
      largestContour = contour;
    }
  }

  let result: TraceResult | null = null;
  if (largestContour && largestArea > 200) {
    const confidence = contourConfidence(largestContour);
    result = extractContourPoints(largestContour, offsetX, offsetY, largestArea, confidence);
  }

  deleteMats(mask, contours, hierarchy);
  return result;
}

// Extract contour points with a very tight RDP epsilon. Input contours are
// found with CHAIN_APPROX_NONE (every boundary pixel) so this is the only
// simplification — it preserves fine tool geometry while removing collinear
// noise. The frontend geometry library applies final smoothing.
function extractContourPoints(
  contour: any,
  offsetX: number,
  offsetY: number,
  area: number,
  confidence?: number
): TraceResult {
  const peri = cv.arcLength(contour, true);

  // Slightly looser epsilon to smooth out pixelation noise and straighten edges (floor of 1.0px)
  const epsilon = Math.max(1.0, 0.0012 * peri);

  const approx = new cv.Mat();
  cv.approxPolyDP(contour, approx, epsilon, true);

  const points: Point2D[] = [];
  for (let j = 0; j < approx.rows; j++) {
    points.push({
      x: approx.data32S[j * 2] + offsetX,
      y: approx.data32S[j * 2 + 1] + offsetY
    });
  }

  approx.delete();
  return { points, area, confidence };
}

// ============================================================================
// Auto-detect ALL tools on paper
// ============================================================================

// Shared core: a solid binary mask (CV_8U, 0/255) → one gated TraceResult per
// connected tool. Used by BOTH the classical path (buildToolMask) and the SOD
// path (trained-model mask). Mutates `mask` (hole-fill). Caller frees `mask`.
function tracePreparedMask(mask: any, rows: number, cols: number): TraceResult[] {
  const totalArea = rows * cols;

  // Fill internal holes / shadow loops before tracing outer contours.
  const tempContours = new cv.MatVector();
  const tempHierarchy = new cv.Mat();
  cv.findContours(mask, tempContours, tempHierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  for (let i = 0; i < tempContours.size(); i++) {
    const c = tempContours.get(i);
    if (cv.contourArea(c) < totalArea * 0.25) {
      cv.drawContours(mask, tempContours, i, new cv.Scalar(255), -1);
    }
  }
  deleteMats(tempContours, tempHierarchy);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);

  // Floor raised to reject shadow/pencil-mark blobs. Measured: false positives
  // top out ~7.5k px while the smallest real tool is ~30k, so 10k cleanly cuts the
  // noise without dropping genuine tools. Scales up for large images.
  const minArea = Math.max(10000, totalArea * 0.003);
  const results: TraceResult[] = [];

  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    const area = cv.contourArea(contour);
    if (area < minArea || area > totalArea * 0.6) { contour.delete(); continue; }

    const solidity = calculateSolidity(contour);
    if (solidity < 0.15) { contour.delete(); continue; }

    // Reject thin linear artifacts (paper folds / scratches / shadow wisps):
    // aspect 19–45 measured, vs real tools ~2–3. Gate on min-area-rect aspect.
    const mar = cv.minAreaRect(contour);
    const minorDim = Math.min(mar.size.width, mar.size.height);
    const aspect = Math.max(mar.size.width, mar.size.height) / Math.max(1, minorDim);
    const minThick = Math.max(8, Math.round(Math.min(rows, cols) * 0.006));
    if (aspect > 14 || minorDim < minThick) { contour.delete(); continue; }

    const confidence = contourConfidence(contour);
    results.push(extractContourPoints(contour, 0, 0, area, confidence));
    console.log(`Found tool: area=${Math.round(area)}, conf=${confidence.toFixed(2)}, minorDim=${minorDim.toFixed(0)}, aspect=${aspect.toFixed(1)}`);
    contour.delete();
  }

  deleteMats(contours, hierarchy);
  return results;
}

function traceAllTools(imageData: ImageData, paperCorners?: PaperCorners): TraceResult[] {
  console.log('traceAllTools: finding all tools on paper...', paperCorners ? 'with boundary masking' : '');
  const src = cv.matFromImageData(imageData);
  const mask = buildToolMask(src, paperCorners);
  const results = tracePreparedMask(mask, src.rows, src.cols);
  deleteMats(mask);
  src.delete();
  console.log(`traceAllTools: found ${results.length} tools`);
  return results;
}

// Boundary refinement: snap a soft/serrated model mask to the image's real edges
// via GrabCut seeded from the mask itself — eroded core = definite FG, outside the
// dilated band = definite BG, the band in between = let graph-cut decide against
// the colour gradient. This is the precision lever for SOD-alone tracing (and it
// sharpens SAM/union edges + the export). Returns a NEW full-res binary mask;
// falls back to a clone of the input on ANY failure so it can never break detection.
const REFINE_MAX_DIM = 1024;
function refineMaskToEdges(mask: any, imageData: ImageData): any {
  let full: any = null, imgS: any = null, maskS: any = null, rgb: any = null;
  let eroded: any = null, dilated: any = null, ker: any = null, gc: any = null;
  let bgd: any = null, fgd: any = null, ones: any = null, fg: any = null;
  try {
    full = cv.matFromImageData(imageData);
    const scale = Math.min(1, REFINE_MAX_DIM / Math.max(full.cols, full.rows));
    const dw = Math.max(1, Math.round(full.cols * scale)), dh = Math.max(1, Math.round(full.rows * scale));

    imgS = new cv.Mat();
    if (scale < 1) cv.resize(full, imgS, new cv.Size(dw, dh), 0, 0, cv.INTER_AREA);
    else full.copyTo(imgS);
    maskS = new cv.Mat();
    if (scale < 1) cv.resize(mask, maskS, new cv.Size(dw, dh), 0, 0, cv.INTER_NEAREST);
    else mask.copyTo(maskS);

    rgb = new cv.Mat();
    cv.cvtColor(imgS, rgb, cv.COLOR_RGBA2RGB);

    // Uncertain band ~1% of the image; erode→definite FG core, dilate→search room.
    const band = Math.max(3, Math.round(0.012 * Math.min(dw, dh)));
    ker = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(band, band));
    eroded = new cv.Mat(); cv.erode(maskS, eroded, ker);
    dilated = new cv.Mat(); cv.dilate(maskS, dilated, ker);

    // Need a definite FG core AND background outside, or GrabCut has no models.
    if (cv.countNonZero(eroded) < 50 || cv.countNonZero(dilated) > 0.95 * dw * dh) {
      throw new Error('mask not suitable for refine (FG core/BG too small)');
    }

    const GC_BGD = 0, GC_FGD = 1, GC_PR_FGD = 3;
    gc = new cv.Mat(dh, dw, cv.CV_8UC1, new cv.Scalar(GC_BGD)); // outside = definite BG
    gc.setTo(new cv.Scalar(GC_PR_FGD), dilated);                // band = probable FG
    gc.setTo(new cv.Scalar(GC_FGD), eroded);                    // core = definite FG

    bgd = new cv.Mat(); fgd = new cv.Mat();
    cv.grabCut(rgb, gc, new cv.Rect(0, 0, 1, 1), bgd, fgd, 2, cv.GC_INIT_WITH_MASK);

    // FG = GC_FGD(1) | GC_PR_FGD(3) = the odd values = (gc & 1).
    ones = new cv.Mat(dh, dw, cv.CV_8UC1, new cv.Scalar(1));
    fg = new cv.Mat(); cv.bitwise_and(gc, ones, fg);
    cv.threshold(fg, fg, 0, 255, cv.THRESH_BINARY);

    const out = new cv.Mat();
    if (scale < 1) cv.resize(fg, out, new cv.Size(mask.cols, mask.rows), 0, 0, cv.INTER_NEAREST);
    else fg.copyTo(out);
    return out;
  } catch (e) {
    console.warn('Boundary refine skipped, using raw mask:', e instanceof Error ? e.message : e);
    return mask.clone();
  } finally {
    deleteMats(full, imgS, maskS, rgb, eroded, dilated, ker, gc, bgd, fgd, ones, fg);
  }
}

// SOD path: a prebuilt foreground mask from the trained model → per-tool results
// through the exact same gates as the classical path. When the source image is
// provided, GrabCut-refine the mask boundary to the real tool edges first.
function traceMask(maskData: Uint8Array, width: number, height: number, imageData?: ImageData): TraceResult[] {
  const raw = new cv.Mat(height, width, cv.CV_8UC1);
  raw.data.set(maskData);
  const mask = imageData ? refineMaskToEdges(raw, imageData) : raw.clone();
  const results = tracePreparedMask(mask, height, width);
  deleteMats(raw, mask);
  console.log(`traceMask: found ${results.length} tools${imageData ? ' (edge-refined)' : ''}`);
  return results;
}

// ============================================================================
// GrabCut — interactive graph-cut segmentation (box seed + refine strokes)
//
// Box-only GrabCut nails coloured/dark/textured tools but cannot pull in bright
// chrome that matches the paper (proven on real images). Refinement strokes fix
// that: the user paints "this is tool" / "this is background" and GrabCut
// re-solves with those hard constraints — the path to a precise metal outline.
// ============================================================================

const GRABCUT_MAX_DIM = 1400; // downscale cap for responsiveness (~1-3s)

function clearGrabCutSession(): void {
  if (gcSession) {
    deleteMats(gcSession.rgb, gcSession.mask, gcSession.bgd, gcSession.fgd);
    gcSession = null;
  }
}

// Turn the GrabCut label mask into a clean tool contour in ORIGINAL image space.
function extractGrabCutContour(mask: any, scale: number): TraceResult | null {
  // Foreground = labels 1 (FGD) or 3 (PR_FGD) → odd values. `mask & 1` isolates them.
  const one = new cv.Mat(mask.rows, mask.cols, cv.CV_8U, new cv.Scalar(1));
  const fg = new cv.Mat();
  cv.bitwise_and(mask, one, fg);
  cv.threshold(fg, fg, 0, 255, cv.THRESH_BINARY);

  const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
  cv.morphologyEx(fg, fg, cv.MORPH_OPEN, k);
  cv.morphologyEx(fg, fg, cv.MORPH_CLOSE, k);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(fg, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);

  let best: any = null;
  let bestArea = 0;
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const a = cv.contourArea(c);
    if (a > bestArea) { bestArea = a; best = c; }
  }

  let result: TraceResult | null = null;
  if (best && bestArea > 50) {
    const confidence = contourConfidence(best);
    result = extractContourPoints(best, 0, 0, bestArea, confidence);
    // Map points + area from downscaled space back to original image space.
    if (scale !== 1) {
      result.points = result.points.map((p) => ({ x: p.x / scale, y: p.y / scale }));
      result.area = bestArea / (scale * scale);
    }
  }

  deleteMats(one, fg, k, contours, hierarchy);
  return result;
}

// Start a GrabCut session from a user-drawn box (everything outside = definite
// background; inside = probable foreground). Returns the first contour.
function grabCutInit(imageData: ImageData, rect: { x: number; y: number; width: number; height: number }): TraceResult | null {
  clearGrabCutSession();

  const full = cv.matFromImageData(imageData);
  const scale = Math.min(1, GRABCUT_MAX_DIM / Math.max(full.cols, full.rows));

  let srcS = full;
  if (scale < 1) {
    srcS = new cv.Mat();
    cv.resize(full, srcS, new cv.Size(Math.round(full.cols * scale), Math.round(full.rows * scale)), 0, 0, cv.INTER_AREA);
  }
  const rgb = new cv.Mat();
  cv.cvtColor(srcS, rgb, cv.COLOR_RGBA2RGB);
  if (srcS !== full) srcS.delete();
  full.delete();

  // Scale + clamp the rect into the downscaled image.
  const rx = clamp(Math.round(rect.x * scale), 0, rgb.cols - 2);
  const ry = clamp(Math.round(rect.y * scale), 0, rgb.rows - 2);
  const rw = clamp(Math.round(rect.width * scale), 1, rgb.cols - rx);
  const rh = clamp(Math.round(rect.height * scale), 1, rgb.rows - ry);

  const mask = new cv.Mat();
  const bgd = new cv.Mat();
  const fgd = new cv.Mat();
  const cvRect = new cv.Rect(rx, ry, rw, rh);
  cv.grabCut(rgb, mask, cvRect, bgd, fgd, 5, cv.GC_INIT_WITH_RECT);

  gcSession = { rgb, mask, bgd, fgd, scale };
  return extractGrabCutContour(mask, scale);
}

// Paint refinement strokes onto the session mask, then re-solve. fgStrokes mark
// "definitely tool", bgStrokes mark "definitely background".
function grabCutRefine(fgStrokes: Stroke[], bgStrokes: Stroke[], brushRadius: number): TraceResult | null {
  if (!gcSession) return null;
  const { rgb, mask, bgd, fgd, scale } = gcSession;

  const FGD = cv.GC_FGD !== undefined ? cv.GC_FGD : 1;
  const BGD = cv.GC_BGD !== undefined ? cv.GC_BGD : 0;
  const thickness = Math.max(1, Math.round(brushRadius * scale)) * 2;

  const paint = (strokes: Stroke[], value: number) => {
    for (const stroke of strokes) {
      const pts = stroke.points;
      if (pts.length === 1) {
        const p = new cv.Point(Math.round(pts[0].x * scale), Math.round(pts[0].y * scale));
        cv.circle(mask, p, Math.max(1, thickness / 2), new cv.Scalar(value), -1);
        continue;
      }
      for (let i = 1; i < pts.length; i++) {
        const a = new cv.Point(Math.round(pts[i - 1].x * scale), Math.round(pts[i - 1].y * scale));
        const b = new cv.Point(Math.round(pts[i].x * scale), Math.round(pts[i].y * scale));
        cv.line(mask, a, b, new cv.Scalar(value), thickness);
      }
    }
  };
  paint(fgStrokes || [], FGD);
  paint(bgStrokes || [], BGD);

  const dummy = new cv.Rect(0, 0, 1, 1);
  cv.grabCut(rgb, mask, dummy, bgd, fgd, 3, cv.GC_INIT_WITH_MASK);

  return extractGrabCutContour(mask, scale);
}

// ============================================================================
// ============================================================================
// Multi-Point Tool Proposal Generation
//
// Instead of returning flat point arrays (which caused 38 blind decoder passes
// and Union-Find merge chaos), we now return structured ToolProposal objects:
//   • One proposal per candidate tool region (classical blob OR edge cluster)
//   • Each proposal carries 5-7 positive points along the tool's principal axis
//   • Plus 4 negative points just outside the bounding box
//   • SAM decodes each proposal in a SINGLE pass — no merging needed
// ============================================================================

interface ToolProposal {
  positivePoints: Point2D[];  // 5-7 points sampled along the principal axis, inside the contour
  negativePoints: Point2D[];  // 4 points just outside the bounding box (background cues)
  bbox: { x: number; y: number; w: number; h: number };
  sourceArea: number;         // classical contour area for filtering/sorting
}

function pointInPaperQuad(px: number, py: number, c: PaperCorners): boolean {
  const poly = [c.topLeft, c.topRight, c.bottomRight, c.bottomLeft];
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function pointCoveredByProposal(
  x: number,
  y: number,
  proposals: ToolProposal[],
  pad: number,
  maxCoverArea = Infinity
): boolean {
  for (const p of proposals) {
    if (p.bbox.w * p.bbox.h > maxCoverArea) continue;
    if (
      x >= p.bbox.x - pad &&
      x <= p.bbox.x + p.bbox.w + pad &&
      y >= p.bbox.y - pad &&
      y <= p.bbox.y + p.bbox.h + pad
    ) {
      return true;
    }
  }
  return false;
}

function buildSparsePromptProposal(x: number, y: number, rows: number, cols: number, radius: number): ToolProposal {
  const r = Math.max(18, radius);
  const x0 = clamp(x - r, 0, cols - 1);
  const y0 = clamp(y - r, 0, rows - 1);
  const x1 = clamp(x + r, 0, cols - 1);
  const y1 = clamp(y + r, 0, rows - 1);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;

  return {
    positivePoints: [
      { x: cx, y: cy },
      { x: clamp(cx - r * 0.35, 0, cols - 1), y: cy },
      { x: clamp(cx + r * 0.35, 0, cols - 1), y: cy },
    ],
    // Sparse probes may land on one section of a long/chrome tool. Avoid local
    // negatives that could mark another part of the same tool as background;
    // samWorker.decodeAt will add image/paper-corner negatives automatically.
    negativePoints: [],
    bbox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    sourceArea: (x1 - x0) * (y1 - y0),
  };
}

/**
 * Convert a contour into a structured ToolProposal with multi-point prompts.
 *
 * Uses moment-based PCA to find the principal axis of inertia, then samples
 * positive points along that axis. Points are validated against a filled mask
 * to ensure they actually fall inside the tool silhouette.
 */
function buildProposalFromContour(
  contour: any,
  area: number,
  imgRows: number,
  imgCols: number,
  filledMask: any
): ToolProposal | null {
  const rect = cv.boundingRect(contour);
  const bbox = { x: rect.x, y: rect.y, w: rect.width, h: rect.height };

  // Oriented bounding box via minAreaRect to find true geometric center & axis
  const rotatedRect = cv.minAreaRect(contour);
  const cx = rotatedRect.center.x;
  const cy = rotatedRect.center.y;

  // Verify dimensions
  if (rotatedRect.size.width <= 0 || rotatedRect.size.height <= 0) return null;

  // Check if a point is inside the contour polygon (100% robust against internal holes/reflections)
  function isInside(x: number, y: number): boolean {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || px >= imgCols || py < 0 || py >= imgRows) return false;
    return cv.pointPolygonTest(contour, new cv.Point(px, py), false) >= 0;
  }

  // Determine oriented longitudinal axis
  let angle = rotatedRect.angle * Math.PI / 180;
  let halfLen = 0;
  if (rotatedRect.size.width > rotatedRect.size.height) {
    halfLen = rotatedRect.size.width * 0.42;
  } else {
    halfLen = rotatedRect.size.height * 0.42;
    angle += Math.PI / 2;
  }

  // Sample 7 positive points along the oriented axis
  const positivePoints: Point2D[] = [];
  const numSamples = 7;
  for (let s = 0; s < numSamples; s++) {
    const t = -0.85 + (1.7 * s / (numSamples - 1)); // -0.85 to +0.85 along axis
    const px = cx + t * halfLen * Math.cos(angle);
    const py = cy + t * halfLen * Math.sin(angle);
    if (isInside(px, py)) {
      positivePoints.push({ x: px, y: py });
    }
  }

  // Always include geometric center if it's inside and not already captured
  const hasCentroid = positivePoints.some(
    p => Math.abs(p.x - cx) < 3 && Math.abs(p.y - cy) < 3
  );
  if (!hasCentroid && isInside(cx, cy)) {
    positivePoints.unshift({ x: cx, y: cy });
  }

  // If still empty, fallback to geometric center
  if (positivePoints.length === 0) {
    positivePoints.push({ x: cx, y: cy });
  }

  // Sample along minor axis (perpendicular) for wider tools
  const minorLen = Math.min(rotatedRect.size.width, rotatedRect.size.height);
  if (positivePoints.length < 5 && minorLen > 25) {
    const minorAngle = angle + Math.PI / 2;
    const minorHalfLen = minorLen * 0.3;
    for (const t of [-0.5, 0.5]) {
      const px = cx + t * minorHalfLen * Math.cos(minorAngle);
      const py = cy + t * minorHalfLen * Math.sin(minorAngle);
      if (isInside(px, py)) {
        positivePoints.push({ x: px, y: py });
      }
    }
  }

  // Negative points: midpoints of each bbox side, pushed outward by margin
  const margin = Math.max(30, Math.min(rect.width, rect.height) * 0.25);
  const negativePoints: Point2D[] = [
    // Bottom center
    { x: cx, y: Math.min(imgRows - 1, rect.y + rect.height + margin) },
    // Left center
    { x: Math.max(0, rect.x - margin), y: cy },
    // Right center
    { x: Math.min(imgCols - 1, rect.x + rect.width + margin), y: cy },
    // Top center
    { x: cx, y: Math.max(0, rect.y - margin) },
  ];

  return { positivePoints, negativePoints, bbox, sourceArea: area };
}

function proposeRegions(imageData: ImageData, paperCorners?: PaperCorners): ToolProposal[] {
  const full = cv.matFromImageData(imageData);
  const origW = full.cols;
  const origH = full.rows;

  const MAX_PROP_DIM = 1200;
  const scale = Math.min(1, MAX_PROP_DIM / Math.max(origW, origH));

  let src = full;
  let scaledCorners = paperCorners;

  if (scale < 1) {
    src = new cv.Mat();
    cv.resize(full, src, new cv.Size(Math.round(origW * scale), Math.round(origH * scale)), 0, 0, cv.INTER_AREA);
    if (paperCorners) {
      scaledCorners = {
        topLeft: { x: paperCorners.topLeft.x * scale, y: paperCorners.topLeft.y * scale },
        topRight: { x: paperCorners.topRight.x * scale, y: paperCorners.topRight.y * scale },
        bottomRight: { x: paperCorners.bottomRight.x * scale, y: paperCorners.bottomRight.y * scale },
        bottomLeft: { x: paperCorners.bottomLeft.x * scale, y: paperCorners.bottomLeft.y * scale },
      };
    }
    console.log(`proposeRegions: Downscaled processing image from ${origW}x${origH} to ${src.cols}x${src.rows} (scale=${scale.toFixed(4)})`);
  }

  const rows = src.rows, cols = src.cols;
  const totalArea = rows * cols;
  // Raised from 0.0003: paper pencil marks / JPEG noise passed as tools (the
  // false "Tool 2" on blank paper). A real hand-tool is >=0.1% of the sheet.
  const minArea = Math.max(2000, totalArea * 0.001);

  // 1. Classical tool detection mask
  const classicalMask = buildToolMask(src, scaledCorners);

  // Fill holes in classical mask to make it solid (ignore paper-sized noise contours)
  const tempContours = new cv.MatVector();
  const tempHierarchy = new cv.Mat();
  cv.findContours(classicalMask, tempContours, tempHierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  for (let i = 0; i < tempContours.size(); i++) {
    const c = tempContours.get(i);
    if (cv.contourArea(c) < totalArea * 0.25) {
      cv.drawContours(classicalMask, tempContours, i, new cv.Scalar(255), -1);
    }
  }
  deleteMats(tempContours, tempHierarchy);

  // 2. Edge-detected chrome mask
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const blurred = new cv.Mat();
  cv.bilateralFilter(gray, blurred, 9, 75, 75);
  const edges = autoTunedCanny(blurred);

  // Restrict edges to paper interior if corners are known
  const interior = scaledCorners ? paperInteriorMask(scaledCorners, rows, cols) : null;
  if (interior) {
    cv.bitwise_and(edges, interior, edges);
  }

  // 3. Connect chrome edge fragments
  const kDilSizeVal = Math.max(5, Math.round(13 * scale)) % 2 === 0 ? Math.max(5, Math.round(13 * scale)) + 1 : Math.max(5, Math.round(13 * scale));
  const dilateKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kDilSizeVal, kDilSizeVal));
  cv.dilate(edges, edges, dilateKernel);
  
  const kCloseSizeVal = Math.max(5, Math.round(25 * scale)) % 2 === 0 ? Math.max(5, Math.round(25 * scale)) + 1 : Math.max(5, Math.round(25 * scale));
  const closeKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kCloseSizeVal, kCloseSizeVal));
  cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, closeKernel);

  // 4. Morphologically merge classical and edge detections
  const combined = new cv.Mat();
  cv.bitwise_or(classicalMask, edges, combined);

  // Reduce morphological close size to prevent merging parallel adjacent tools
  const closeSize = Math.max(11, Math.min(25, Math.round(cols * 0.007)));
  const kCloseSize = closeSize % 2 === 0 ? closeSize + 1 : closeSize;
  const morphClose = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kCloseSize, kCloseSize));
  cv.morphologyEx(combined, combined, cv.MORPH_CLOSE, morphClose);

  // Small open only to remove salt-noise specks — keep thin tool connections intact
  const openSize = Math.max(3, Math.min(5, Math.round(cols * 0.002)));
  const kOpenSize = openSize % 2 === 0 ? openSize + 1 : openSize;
  const morphOpen = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kOpenSize, kOpenSize));
  cv.morphologyEx(combined, combined, cv.MORPH_OPEN, morphOpen);

  // Connect collinear contours that are close to each other
  const collinearContours = new cv.MatVector();
  const collinearHierarchy = new cv.Mat();
  cv.findContours(combined, collinearContours, collinearHierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const validCands: { cx: number; cy: number; rect: any }[] = [];
  const candAreaThresh = Math.max(50, Math.round(300 * scale * scale));
  for (let i = 0; i < collinearContours.size(); i++) {
    const c = collinearContours.get(i);
    const area = cv.contourArea(c);
    if (area > candAreaThresh) {
      const rect = cv.boundingRect(c);
      validCands.push({
        cx: Math.round(rect.x + rect.width / 2),
        cy: Math.round(rect.y + rect.height / 2),
        rect
      });
    }
    c.delete();
  }

  for (let i = 0; i < validCands.length; i++) {
    for (let j = i + 1; j < validCands.length; j++) {
      const c1 = validCands[i];
      const c2 = validCands[j];
      const r1 = c1.rect;
      const r2 = c2.rect;

      const yOverlap = Math.max(r1.y, r2.y) < Math.min(r1.y + r1.height, r2.y + r2.height);
      let hGap = Infinity;
      if (r1.x + r1.width < r2.x) {
        hGap = r2.x - (r1.x + r1.width);
      } else if (r2.x + r2.width < r1.x) {
        hGap = r1.x - (r2.x + r2.width);
      } else {
        hGap = 0;
      }

      const xOverlap = Math.max(r1.x, r2.x) < Math.min(r1.x + r1.width, r2.x + r2.width);
      let vGap = Infinity;
      if (r1.y + r1.height < r2.y) {
        vGap = r2.y - (r1.y + r1.height);
      } else if (r2.y + r2.height < r1.y) {
        vGap = r1.y - (r2.y + r2.height);
      } else {
        vGap = 0;
      }

      let shouldConnect = false;
      let thick = 20;

      const heightRatio = Math.max(r1.height, r2.height) / Math.min(r1.height, r2.height);
      const widthRatio = Math.max(r1.width, r2.width) / Math.min(r1.width, r2.width);

      if (yOverlap && hGap < cols * 0.08 && heightRatio < 2.5) {
        const cyOffset = Math.abs(c1.cy - c2.cy);
        const maxOffset = Math.min(r1.height, r2.height) * 0.5;
        const bothVertElongated = r1.height > r1.width * 1.3 && r2.height > r2.width * 1.3;
        if (cyOffset < maxOffset && !bothVertElongated) {
          shouldConnect = true;
          thick = Math.min(r1.height, r2.height, 50);
        }
      } else if (xOverlap && vGap < rows * 0.08 && widthRatio < 2.5) {
        const cxOffset = Math.abs(c1.cx - c2.cx);
        const maxOffset = Math.min(r1.width, r2.width) * 0.5;
        const bothHorizElongated = r1.width > r1.height * 1.3 && r2.width > r2.height * 1.3;
        if (cxOffset < maxOffset && !bothHorizElongated) {
          shouldConnect = true;
          thick = Math.min(r1.width, r2.width, 50);
        }
      }

      if (shouldConnect) {
        const p1 = new cv.Point(c1.cx, c1.cy);
        const p2 = new cv.Point(c2.cx, c2.cy);
        cv.line(combined, p1, p2, new cv.Scalar(255), Math.max(10, Math.round(thick * 0.8)));
      }
    }
  }
  deleteMats(collinearContours, collinearHierarchy);

  // 5. Find contours of unified tool regions
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(combined, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const proposals: ToolProposal[] = [];

  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const area = cv.contourArea(c);
    
    if (area < minArea || area > totalArea * 0.6) {
      c.delete();
      continue;
    }
    
    if (calculateSolidity(c) < 0.12) {
      c.delete();
      continue;
    }

    const rect = cv.boundingRect(c);
    const isSplitCandidate = area > minArea * 1.5;
    let addedAny = false;

    if (isSplitCandidate) {
      try {
        const tempMask = cv.Mat.zeros(rows, cols, cv.CV_8U);
        const cVec = new cv.MatVector();
        cVec.push_back(c);
        cv.drawContours(tempMask, cVec, 0, new cv.Scalar(255), -1);
        cVec.delete();

        const splitKernelSizes = [11, 19, 27, 35, 43, 51].map(k => {
          const s = Math.round(k * scale);
          const ks = s % 2 === 0 ? s + 1 : s;
          return Math.max(5, ks);
        });
        const uniqueKernelSizes = Array.from(new Set(splitKernelSizes));

        for (const kSize of uniqueKernelSizes) {
          const tempEroded = new cv.Mat();
          const erodeKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kSize, kSize));
          cv.erode(tempMask, tempEroded, erodeKernel);
          erodeKernel.delete();

          const subContours = new cv.MatVector();
          const subHier = new cv.Mat();
          cv.findContours(tempEroded, subContours, subHier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

          let validSubCount = 0;
          const tempCands: { contour: any; area: number }[] = [];
          for (let j = 0; j < subContours.size(); j++) {
            const subC = subContours.get(j);
            const subArea = cv.contourArea(subC);
            if (subArea > Math.max(200 * scale * scale, minArea * 0.2)) {
              validSubCount++;
              tempCands.push({ contour: subC, area: subArea });
            } else {
              subC.delete();
            }
          }

          if (validSubCount >= 2) {
            console.log(`proposeRegions: split mega-blob [x=${rect.x}, y=${rect.y}, w=${rect.width}, h=${rect.height}] into ${validSubCount} parts using kSize=${kSize}`);
            for (const cand of tempCands) {
              const proposal = buildProposalFromContour(cand.contour, cand.area, rows, cols, combined);
              if (proposal) {
                const minBboxDim = Math.min(proposal.bbox.w, proposal.bbox.h);
                const maxBboxDim = Math.max(proposal.bbox.w, proposal.bbox.h);
                const minDimThresh = Math.max(8, Math.round(20 * scale));
                const maxDimThresh = Math.max(20, Math.round(50 * scale));
                if (minBboxDim >= minDimThresh && maxBboxDim >= maxDimThresh) {
                  proposals.push(proposal);
                  addedAny = true;
                }
              }
              cand.contour.delete();
            }
            deleteMats(subContours, subHier, tempEroded);
            break;
          } else {
            for (const cand of tempCands) {
              cand.contour.delete();
            }
            deleteMats(subContours, subHier, tempEroded);
          }
        }
        tempMask.delete();
      } catch (splitErr: any) {
        console.log(`[WORKER ERROR] Split candidate failed for contour ${i}: ${splitErr.message}`);
      }
    }

    if (!addedAny) {
      const proposal = buildProposalFromContour(c, area, rows, cols, combined);
      if (proposal) {
        const minBboxDim = Math.min(proposal.bbox.w, proposal.bbox.h);
        const maxBboxDim = Math.max(proposal.bbox.w, proposal.bbox.h);
        const minDimThresh = Math.max(8, Math.round(20 * scale));
        const maxDimThresh = Math.max(20, Math.round(50 * scale));
        if (minBboxDim < minDimThresh || maxBboxDim < maxDimThresh) {
          c.delete();
          continue;
        }
        proposals.push(proposal);
      }
    }
    c.delete();
  }

  // 6. Sparse SAM prompts over uncovered high-texture paper regions.
  //
  // Classical CV is a good locator for coloured/dark tools, but it can miss
  // chrome-on-white regions whose edges are visible while the filled body reads
  // like paper. Add a small number of prompt-only proposals where the paper has
  // local edge/texture energy and no existing proposal covers the area. These
  // are intentionally not merged into the classical mask: SAM gets to decide
  // whether each prompt is a real tool, and its area/paper/NMS gates reject
  // blank-paper probes.
  if (scaledCorners) {
    const maxSparsePrompts = 18;
    const gridStep = Math.max(42, Math.round(Math.min(rows, cols) / 7));
    const win = Math.max(9, Math.round(gridStep * 0.28));
    const proposalPad = Math.max(18, Math.round(gridStep * 0.45));
    const maxCoveredProposalArea = totalArea * 0.08;
    const candidates: { x: number; y: number; score: number }[] = [];

    for (let y = gridStep; y < rows - gridStep; y += gridStep) {
      for (let x = gridStep; x < cols - gridStep; x += gridStep) {
        if (!pointInPaperQuad(x, y, scaledCorners)) continue;
        if (pointCoveredByProposal(x, y, proposals, proposalPad, maxCoveredProposalArea)) continue;

        let edgeCount = 0;
        let sum = 0;
        let sumSq = 0;
        let count = 0;
        for (let yy = Math.max(0, y - win); yy <= Math.min(rows - 1, y + win); yy += 2) {
          for (let xx = Math.max(0, x - win); xx <= Math.min(cols - 1, x + win); xx += 2) {
            if (interior && interior.data[yy * cols + xx] === 0) continue;
            const g = gray.data[yy * cols + xx];
            sum += g;
            sumSq += g * g;
            count++;
            if (edges.data[yy * cols + xx] > 0) edgeCount++;
          }
        }
        if (count === 0) continue;

        const mean = sum / count;
        const variance = Math.max(0, sumSq / count - mean * mean);
        const edgeDensity = edgeCount / count;

        // Paper is usually flat: low variance and low edge density. Chrome,
        // threads, knurling, labels, and tool boundaries all lift one or both.
        if (edgeDensity < 0.08 && variance < 45) continue;
        candidates.push({ x, y, score: edgeDensity * 100 + variance * 0.04 });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const sparsePrompts: ToolProposal[] = [];
    for (const c of candidates) {
      if (sparsePrompts.length >= maxSparsePrompts) break;
      if (pointCoveredByProposal(c.x, c.y, sparsePrompts, proposalPad)) continue;
      sparsePrompts.push(buildSparsePromptProposal(c.x, c.y, rows, cols, proposalPad));
    }

    if (sparsePrompts.length > 0) {
      console.log(`proposeRegions: added ${sparsePrompts.length} sparse SAM prompts`);
      proposals.push(...sparsePrompts);
    }
  }

  // Cleanup
  deleteMats(classicalMask, gray, blurred, edges, dilateKernel, closeKernel, combined, morphClose, morphOpen, contours, hierarchy);
  if (interior) interior.delete();
  if (src !== full) src.delete();
  full.delete();

  // Keep proposals granular. Older code merged horizontally aligned groups into
  // one giant row proposal, which made SAM return a whole strip instead of one
  // mask per tool. Duplicate/sub-part prompts are cheaper and safer: SAM's
  // containment-aware NMS below removes overlaps after masks exist.
  let finalProposals = proposals;

  // BUG B FIX: proposeRegions runs on a <=1200px downscaled image, but every
  // consumer (samWorker.autoSegment) expects ORIGINAL-resolution coordinates and
  // multiplies by its own procScale. Without this, prompts get squished toward
  // the top-left and land on paper. Scale points/bbox back to original space.
  if (scale < 1) {
    const inv = 1 / scale;
    finalProposals = finalProposals.map(p => ({
      positivePoints: p.positivePoints.map(pt => ({ x: pt.x * inv, y: pt.y * inv })),
      negativePoints: p.negativePoints.map(pt => ({ x: pt.x * inv, y: pt.y * inv })),
      bbox: { x: p.bbox.x * inv, y: p.bbox.y * inv, w: p.bbox.w * inv, h: p.bbox.h * inv },
      sourceArea: p.sourceArea * inv * inv,
    }));
  }

  console.log(`proposeRegions: found ${finalProposals.length} unified proposals`);
  for (let i = 0; i < finalProposals.length; i++) {
    const p = finalProposals[i];
    console.log(`  Proposal ${i}: bbox=[x=${p.bbox.x}, y=${p.bbox.y}, w=${p.bbox.w}, h=${p.bbox.h}], positives=${p.positivePoints.length}, negatives=${p.negativePoints.length}`);
  }
  return finalProposals;
}

// ============================================================================
// Contour generation from mask
// ============================================================================

function contourFromMask(mask: Uint8Array, width: number, height: number): TraceResult | null {
  const m = new cv.Mat(height, width, cv.CV_8UC1);
  m.data.set(mask);

  // Compute the bounding box of the mask content to adapt the close kernel
  // proportionally to THIS tool's size, not the whole image.
  // • For a 50px-tall screw thread: 3% = 1.5 → min 5px → heals small gaps
  // • For a 400px-tall motor: 3% = 12px → bridges reflective gaps inside
  // • For a 200px-tall plier jaw: gap is ~80px, 3% = 6px → jaw preserved
  let maskMinX = width, maskMinY = height, maskMaxX = 0, maskMaxY = 0;
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      if (mask[py * width + px]) {
        if (px < maskMinX) maskMinX = px;
        if (px > maskMaxX) maskMaxX = px;
        if (py < maskMinY) maskMinY = py;
        if (py > maskMaxY) maskMaxY = py;
      }
    }
  }
  const maskH = Math.max(1, maskMaxY - maskMinY);
  const maskW = Math.max(1, maskMaxX - maskMinX);
  const maskMinDim = Math.min(maskH, maskW);
  // SAM masks are already clean and precise. Keep morphology MINIMAL — a large
  // close rounds off sharp corners (knife tip, L-square corner, caliper jaws),
  // destroying the very precision SAM produced. Only seal hairline gaps.
  const closeSize = Math.max(3, Math.min(7, Math.round(maskMinDim * 0.012)));
  const kCloseSize = closeSize % 2 === 0 ? closeSize + 1 : closeSize;
  const openSize = Math.max(3, Math.min(5, Math.round(maskMinDim * 0.003)));
  const kOpenSize = openSize % 2 === 0 ? openSize + 1 : openSize;

  const kClose = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kCloseSize, kCloseSize));
  const kOpen = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kOpenSize, kOpenSize));
  cv.morphologyEx(m, m, cv.MORPH_CLOSE, kClose);
  cv.morphologyEx(m, m, cv.MORPH_OPEN, kOpen);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(m, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);

  let best: any = null;
  let bestArea = 0;
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const a = cv.contourArea(c);
    if (a > bestArea) {
      if (best) best.delete();
      bestArea = a;
      best = c;
    } else {
      c.delete();
    }
  }

  // Reject the mask if it is too large (more than 70% of the total image area)
  // as it is likely a background bleed
  const maxArea = width * height * 0.70;
  if (bestArea > maxArea) {
    console.log(`contourFromMask: Rejecting contour with area ${Math.round(bestArea)} (exceeds 70% image area of ${Math.round(maxArea)})`);
    if (best) best.delete();
    deleteMats(m, kClose, kOpen, contours, hierarchy);
    return null;
  }

  let result: TraceResult | null = null;
  if (best && bestArea > 50) {
    // Create a solid version of the largest contour to fill all internal holes/loops
    const mClean = cv.Mat.zeros(height, width, cv.CV_8U);
    const tempVec = new cv.MatVector();
    tempVec.push_back(best);
    cv.drawContours(mClean, tempVec, 0, new cv.Scalar(255), -1);

    // Extract the clean outer contour of the solid shape
    const cleanContours = new cv.MatVector();
    const cleanHierarchy = new cv.Mat();
    cv.findContours(mClean, cleanContours, cleanHierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);

    if (cleanContours.size() > 0) {
      let cleanBest = cleanContours.get(0);
      let cleanBestArea = cv.contourArea(cleanBest);
      for (let i = 1; i < cleanContours.size(); i++) {
        const c = cleanContours.get(i);
        const a = cv.contourArea(c);
        if (a > cleanBestArea) {
          cleanBest.delete();
          cleanBestArea = a;
          cleanBest = c;
        } else {
          c.delete();
        }
      }
      const confidence = contourConfidence(cleanBest);
      result = extractContourPoints(cleanBest, 0, 0, cleanBestArea, confidence);
      cleanBest.delete();
    }

    deleteMats(mClean, tempVec, cleanContours, cleanHierarchy);
    best.delete();
  }

  deleteMats(m, kClose, kOpen, contours, hierarchy);
  return result;
}

// ============================================================================
// Message Handler
// ============================================================================

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const { id, type, payload } = e.data;

  try {
    await initOpenCV();

    let result: any;
    switch (type) {
      case 'init':
        result = { ready: true };
        break;
      case 'detectPaper':
        result = detectPaper(payload.imageData);
        break;
      case 'rectifyToA4':
        result = rectifyToA4(payload.imageData, payload.paperCorners);
        break;
      case 'traceTool':
        result = traceTool(payload.imageData, payload.x, payload.y, payload.paperCorners);
        break;
      case 'traceRegion':
        result = traceRegion(payload.imageData, payload.rect);
        break;
      case 'traceAllTools':
        result = traceAllTools(payload.imageData, payload.paperCorners);
        break;
      case 'grabCutInit':
        result = grabCutInit(payload.imageData, payload.rect);
        break;
      case 'grabCutRefine':
        result = grabCutRefine(payload.fgStrokes, payload.bgStrokes, payload.brushRadius);
        break;
      case 'grabCutClear':
        clearGrabCutSession();
        result = { cleared: true };
        break;
      case 'contourFromMask':
        result = contourFromMask(new Uint8Array(payload.mask), payload.width, payload.height);
        break;
      case 'proposeRegions':
        result = proposeRegions(payload.imageData, payload.paperCorners);
        break;
      case 'traceMask': {
        const refineImg = payload.rgba
          ? new ImageData(new Uint8ClampedArray(payload.rgba), payload.width, payload.height)
          : undefined;
        result = traceMask(new Uint8Array(payload.mask), payload.width, payload.height, refineImg);
        break;
      }
      default:
        throw new Error(`Unknown message type: ${type}`);
    }

    // Transfer large rectified-image buffers instead of cloning them.
    const transfer = result && result.rgba instanceof ArrayBuffer ? [result.rgba] : [];
    self.postMessage({ id, type: 'success', payload: result } as WorkerResponse, transfer);
  } catch (err) {
    self.postMessage({
      id,
      type: 'error',
      payload: { message: err instanceof Error ? err.message : 'Unknown error' },
    } as WorkerResponse);
  }
};

