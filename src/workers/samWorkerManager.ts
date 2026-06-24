/**
 * SAM Worker Manager
 *
 * Drives the SlimSAM web worker (lazy model load, embed-once, per-click decode)
 * and routes the resulting mask through the OpenCV contour path so a SAM trace
 * produces the exact same ToolTracingResult shape as classical detection.
 *
 * Everything runs on-device — no server, no API key. The model is fetched from
 * the HF CDN on first use and cached by the browser thereafter.
 */

import type { ToolTracingResult, PaperCorners, ToolProposal } from './cvWorkerManager';
import { contourFromMask, proposeRegions, getImageData } from './cvWorkerManager';

// Scale a contour (in processing-resolution space) back to original image space.
function scaleResult(r: ToolTracingResult | null, scale: number): ToolTracingResult | null {
  if (!r) return null;
  if (scale === 1) return r;
  return {
    ...r,
    points: r.points.map((p) => ({ x: p.x * scale, y: p.y * scale })),
    area: r.area * scale * scale,
  };
}

// Even-odd point-in-quad test (paper validity gate).
function pointInQuad(px: number, py: number, c: PaperCorners): boolean {
  const poly = [c.topLeft, c.topRight, c.bottomRight, c.bottomLeft];
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

export interface SamLoadProgress {
  status: string;
  file?: string;
  progress: number; // 0..100
}

let worker: Worker | null = null;
let reqId = 0;
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; onProgress?: (p: SamLoadProgress) => void }>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./samWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const { id, type, payload } = e.data;
    const p = pending.get(id);
    if (!p) return;
    if (type === 'progress') {
      // Log model identity confirmation to main-thread console
      if (payload?.status === 'model_loaded') {
        const style = payload.isSam2
          ? 'color: #22c55e; font-weight: bold; font-size: 14px; background: #000; padding: 4px 8px; border-radius: 4px;'
          : 'color: #f59e0b; font-weight: bold; font-size: 14px; background: #000; padding: 4px 8px; border-radius: 4px;';
        console.log(`%c🤖 MODEL LOADED: ${payload.model} (${payload.device})`, style);
      }
      p.onProgress?.(payload);
      return;
    }
    pending.delete(id);
    if (type === 'error') p.reject(new Error(payload.message));
    else p.resolve(payload);
  };
  worker.onerror = (err) => {
    // Reject everything in flight so callers can fall back to classical.
    for (const [, p] of pending) p.reject(new Error(err.message || 'SAM worker failed'));
    pending.clear();
  };
  return worker;
}

function request<T>(type: string, payload: any, onProgress?: (p: SamLoadProgress) => void): Promise<T> {
  const w = ensureWorker();
  return new Promise<T>((resolve, reject) => {
    const id = `${type}-${++reqId}`;
    pending.set(id, { resolve, reject, onProgress });
    
    // Transfer raw image bytes if present to avoid cloning overhead
    const transfer: Transferable[] = [];
    if (payload && typeof payload === 'object' && payload.rgbaData) {
      if (payload.rgbaData instanceof Uint8ClampedArray || payload.rgbaData instanceof Uint8Array) {
        transfer.push(payload.rgbaData.buffer);
      }
    }
    
    w.postMessage({ id, type, payload }, transfer);
  });
}

/** Whether SAM has been used/loaded this session (for UI hints). */
let everLoaded = false;
export function samEverLoaded(): boolean { return everLoaded; }

/** Pre-load the model (optional — segmentation lazy-loads anyway). */
export async function samPreload(onProgress?: (p: SamLoadProgress) => void): Promise<void> {
  await request('load', {}, onProgress);
  everLoaded = true;
}

/**
 * Segment one tool from a click point using SlimSAM, then extract a precise
 * contour. The first call downloads the model (reports via onProgress) and
 * embeds the image; subsequent clicks on the same image are fast.
 */
export async function samSegmentPoint(
  imageUrl: string,
  clicks: { x: number; y: number; label: number }[],
  opts?: { paperCorners?: PaperCorners; onProgress?: (p: SamLoadProgress) => void },
): Promise<ToolTracingResult | null> {
  const imageData = await getImageData(imageUrl);
  const imgW = imageData.width, imgH = imageData.height;
  // The SAM request below TRANSFERS imageData.data.buffer to the worker, detaching
  // it — so snapshot the pixels NOW for the post-segmentation shadow-suppress pass.
  // (Without this, reusing the detached buffer throws DataCloneError and the
  // add-click silently fails to merge.)
  const rgbaSnapshot = imageData.data.slice();
  const seg = await request<{ mask: ArrayBuffer; width: number; height: number; score: number; scale: number } | null>(
    'segmentPoint',
    {
      url: imageUrl,
      clicks,
      paperCorners: opts?.paperCorners,
      rgbaData: imageData.data,
      width: imgW,
      height: imgH
    },
    opts?.onProgress,
  );
  everLoaded = true;
  if (!seg) return null; // worker rejected (paper-sized / noise) — no tool here

  // Pass the source image so the worker shadow-suppresses the SAM mask (drops the
  // cast-shadow spill SAM grabs on shadowed tools) before tracing the contour.
  // The shadow-suppress pass is an ENHANCEMENT, never a gate: if the image buffer
  // is unusable for any reason, trace the mask without it so the click still
  // merges (a missed shadow-trim beats a dropped click).
  let contour: ToolTracingResult | null = null;
  let traced = false;
  if (rgbaSnapshot.byteLength > 0) {
    try {
      contour = await contourFromMask(seg.mask, seg.width, seg.height, {
        rgba: rgbaSnapshot.buffer as ArrayBuffer,
        width: imgW,
        height: imgH,
      });
      traced = true;
    } catch (e) {
      console.warn('[SAM] shadow-suppress pass failed; tracing without it:', e);
    }
  }
  if (!traced) contour = await contourFromMask(seg.mask, seg.width, seg.height);
  const result = scaleResult(contour, seg.scale);
  if (!result) return null;

  // VALIDITY GATE (paper bounds): the tool must sit inside the A4 sheet. Reject
  // detections whose centroid falls outside the paper quad (SAM leaked onto the
  // dark background / off-sheet).
  if (opts?.paperCorners && result.points.length) {
    let cx = 0, cy = 0;
    for (const p of result.points) { cx += p.x; cy += p.y; }
    cx /= result.points.length; cy /= result.points.length;
    if (!pointInQuad(cx, cy, opts.paperCorners)) {
      console.log('[SAM] detection rejected — centroid outside paper');
      return null;
    }
  }
  return result;
}

/**
 * Autonomous detection: classical proposes prompts (located tools + sparse
 * grid over uncovered metal) → SlimSAM segments each → containment-NMS →
 * precise contours. Returns one ToolTracingResult per tool.
 */
export async function samAutoSegment(
  imageUrl: string,
  paperCorners?: PaperCorners,
  onProgress?: (p: SamLoadProgress) => void,
): Promise<ToolTracingResult[]> {
  // Stage 1 — classical prompt proposal (instant, free).
  const proposals = await proposeRegions(imageUrl, paperCorners);
  if (proposals.length === 0) return [];

  // Stage 2+3 — SAM batch decode + filter (in the worker).
  const imageData = await getImageData(imageUrl);
  const res = await request<{ masks: { mask: ArrayBuffer; width: number; height: number; score: number }[]; scale: number }>(
    'autoSegment',
    {
      url: imageUrl,
      proposals,
      paperCorners,
      rgbaData: imageData.data,
      width: imageData.width,
      height: imageData.height
    },
    onProgress,
  );
  everLoaded = true;

  // Stage 4 — each survivor mask → precise contour → original space.
  const out: ToolTracingResult[] = [];
  for (const m of res.masks) {
    const contour = await contourFromMask(m.mask, m.width, m.height);
    const scaled = scaleResult(contour, res.scale);
    if (!scaled || scaled.points.length < 3) continue;

    // VALIDITY GATE (paper bounds): the same gate samSegmentPoint uses, now on
    // the autonomous path too. Reject any mask whose centroid falls outside the
    // A4 sheet — this is the off-sheet "blue arc" leak onto the dark background.
    if (paperCorners) {
      let cx = 0, cy = 0;
      for (const p of scaled.points) { cx += p.x; cy += p.y; }
      cx /= scaled.points.length; cy /= scaled.points.length;
      if (!pointInQuad(cx, cy, paperCorners)) {
        console.log('[SAM] auto detection rejected — centroid outside paper');
        continue;
      }
    }

    out.push({ ...scaled, confidence: m.score });
  }
  return out;
}

/**
 * DEEP detection (AMG-style): SAM lays a dense grid of point prompts over the
 * paper, segments at each, and NMS-dedupes the survivors — no classical proposer.
 * Catches chrome-on-white that SOD/classical miss, at the cost of more compute
 * (opt-in "Deep Detect"). Reuses the SAME contour + paper-bounds post-processing
 * as the fast path.
 */
export async function samAutoSegmentDense(
  imageUrl: string,
  paperCorners?: PaperCorners,
  onProgress?: (p: SamLoadProgress) => void,
): Promise<ToolTracingResult[]> {
  if (!paperCorners) return [];
  const imageData = await getImageData(imageUrl);
  const res = await request<{ masks: { mask: ArrayBuffer; width: number; height: number; score: number }[]; scale: number }>(
    'autoSegmentDense',
    {
      url: imageUrl,
      paperCorners,
      rgbaData: imageData.data,
      width: imageData.width,
      height: imageData.height,
    },
    onProgress,
  );
  everLoaded = true;

  const out: ToolTracingResult[] = [];
  for (const m of res.masks) {
    const contour = await contourFromMask(m.mask, m.width, m.height);
    const scaled = scaleResult(contour, res.scale);
    if (!scaled || scaled.points.length < 3) continue;
    let cx = 0, cy = 0;
    for (const p of scaled.points) { cx += p.x; cy += p.y; }
    cx /= scaled.points.length; cy /= scaled.points.length;
    if (!pointInQuad(cx, cy, paperCorners)) continue;
    out.push({ ...scaled, confidence: m.score });
  }
  return out;
}

/** Drop the cached image embedding (e.g. when the image changes). */
export async function samClear(): Promise<void> {
  if (!worker) return;
  try { await request('clear', {}); } catch { /* ignore */ }
}
