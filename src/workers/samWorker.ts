/**
 * SAM Worker — in-browser Segment Anything (SlimSAM) via transformers.js.
 *
 * Runs 100% on the user's device (no server, no API, no key). The heavy image
 * encoder runs ONCE per image; each click then decodes a precise mask in ~ms.
 * The model is lazy-loaded on first use and cached by the browser thereafter.
 *
 * Pipeline role: VISION (which pixels are the tool). The returned mask is handed
 * to the existing OpenCV contour + geometry pipeline for the precise CAD edge.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  env,
  Sam2Model,
  SamModel,
  AutoProcessor,
  RawImage,
} from '@huggingface/transformers';

// Verbose logs only in dev — production console stays clean. warn/error still show.
const _rawLog = console.log.bind(console);
const log = (...args: unknown[]): void => { if (import.meta.env.DEV) _rawLog(...args); };

// Fetch weights from the HF Hub (no local model files bundled).
env.allowLocalModels = false;
// Single-threaded WASM avoids cross-origin-isolation (COOP/COEP) requirements.
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.numThreads = 1;
}

const MODEL_ID = 'onnx-community/sam2.1-hiera-tiny-ONNX';

interface WorkerMessage { id: string; type: 'load' | 'embed' | 'segmentPoint' | 'autoSegment' | 'autoSegmentDense' | 'clear'; payload: any }
interface WorkerResponse { id: string; type: 'success' | 'error' | 'progress'; payload: any }

// Process at a capped resolution for speed + smaller masks; contours are scaled
// back to the original image space by `scaleToOriginal`.
const MAX_DIM = 1600;

let model: any = null;
let processor: any = null;
let loadPromise: Promise<void> | null = null;
let isSam2 = true;

// Per-image session — embeddings are reused across all prompts on the image.
let session: {
  url: string;
  image: any;            // downscaled RawImage actually fed to SAM
  procScale: number;     // original → processing  (mult input points by this)
  scaleToOriginal: number; // processing → original (mult output contour by this)
  embeddings: any;
  originalSizes: any;
  reshapedInputSizes: any;
} | null = null;

function post(msg: WorkerResponse, transfer?: Transferable[]) {
  (self as any).postMessage(msg, transfer || []);
}

async function ensureLoaded(id: string): Promise<void> {
  if (model && processor) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const device = (self as any).navigator?.gpu ? 'webgpu' : 'wasm';
    const progress_callback = (p: any) => {
      // Forward download/init progress for the first-load UI.
      if (p && (p.status === 'progress' || p.status === 'done' || p.status === 'ready')) {
        post({ id, type: 'progress', payload: { status: p.status, file: p.file, progress: p.progress ?? 0 } });
      }
    };
    
    try {
      // Try to load SAM 2.1 Hiera Tiny
      log(`%c[SAM] Attempting to load SAM 2.1 Tiny (${device})...`, 'color: #3b82f6; font-weight: bold;');
      model = await Sam2Model.from_pretrained(MODEL_ID, { device, progress_callback } as any);
      processor = await AutoProcessor.from_pretrained(MODEL_ID);
      isSam2 = true;
      log('%c===================================================', 'color: #22c55e; font-weight: bold;');
      log(`%c[SAM] LOUD LOG: SUCCESSFULLY LOADED SAM 2.1 Tiny (${device})`, 'color: #22c55e; font-weight: bold; font-size: 14px;');
      log('%c===================================================', 'color: #22c55e; font-weight: bold;');
      // Notify main thread definitively which model loaded
      post({ id, type: 'progress', payload: { status: 'model_loaded', model: `SAM 2.1 Hiera Tiny`, device, isSam2: true } });
    } catch (sam2Err) {
      console.warn('%c[SAM] LOUD LOG: Failed to load SAM 2.1! Falling back to SlimSAM...', 'color: #f59e0b; font-weight: bold; font-size: 12px;', sam2Err);
      console.warn('[SAM] SAM2 load error details:', String(sam2Err));
      const SLIMSAM_MODEL_ID = 'Xenova/slimsam-77-uniform';
      try {
        model = await SamModel.from_pretrained(SLIMSAM_MODEL_ID, { dtype: 'q8', device, progress_callback } as any);
      } catch {
        model = await SamModel.from_pretrained(SLIMSAM_MODEL_ID, { progress_callback } as any);
      }
      processor = await AutoProcessor.from_pretrained(SLIMSAM_MODEL_ID);
      isSam2 = false;
      log('%c===================================================', 'color: #3b82f6; font-weight: bold;');
      log(`%c[SAM] LOUD LOG: SUCCESSFULLY LOADED SLIMSAM FALLBACK (${device})`, 'color: #3b82f6; font-weight: bold; font-size: 12px;');
      log('%c===================================================', 'color: #3b82f6; font-weight: bold;');
      // Notify main thread definitively which model loaded
      post({ id, type: 'progress', payload: { status: 'model_loaded', model: `SlimSAM (FALLBACK)`, device, isSam2: false } });
    }
  })();

  return loadPromise;
}

// Compute the image embedding once (the expensive encoder pass).
async function embed(
  id: string,
  url: string,
  rgbaData?: Uint8Array | Uint8ClampedArray,
  width?: number,
  height?: number
): Promise<void> {
  await ensureLoaded(id);
  if (session && session.url === url) return; // already embedded this image

  let image: any;
  if (rgbaData && width && height) {
    const rgbData = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      rgbData[i * 3] = rgbaData[i * 4];
      rgbData[i * 3 + 1] = rgbaData[i * 4 + 1];
      rgbData[i * 3 + 2] = rgbaData[i * 4 + 2];
    }
    image = new RawImage(rgbData, width, height, 3);
    log(`[SAM] Embedded image from raw pixels: ${width}x${height}`);
  } else {
    image = await RawImage.read(url);
    log(`[SAM] Embedded image from URL: ${url}`);
  }

  const origW = image.width, origH = image.height;
  const procScale = Math.min(1, MAX_DIM / Math.max(origW, origH));
  if (procScale < 1) {
    image = await image.resize(Math.round(origW * procScale), Math.round(origH * procScale));
  }
  const scaleToOriginal = origW / image.width;

  const inputs = await processor(image);
  let embeddings: any;
  if (isSam2) {
    embeddings = await model.get_image_embeddings(inputs);
  } else {
    const { image_embeddings, image_positional_embeddings } = await model.get_image_embeddings(inputs);
    embeddings = { image_embeddings, image_positional_embeddings };
  }

  session = {
    url,
    image,
    procScale,
    scaleToOriginal,
    embeddings,
    originalSizes: inputs.original_sizes,
    reshapedInputSizes: inputs.reshaped_input_sizes,
  };
}

// Decode the best mask for point prompts (in PROCESSING coords). Returns
// the raw mask buffer + its IoU score, or null. Shared by interactive + auto.
async function decodeAt(
  points: [number, number][],
  labels: number[],
  paperCorners?: any
): Promise<{ data: Uint8Array; width: number; height: number; score: number } | null> {
  if (!session) return null;

  let promptInputs: any;
  let outputs: any;
  let masks: any;

  if (isSam2) {
    const finalPoints = [...points];
    const finalLabels = [...labels];

    // Only add default negative points if the user has not placed any negative clicks
    const hasNegative = labels.includes(0);
    if (!hasNegative) {
      // Always add 4 image corners as background points
      const W = session.image.width;
      const H = session.image.height;
      const margin = 2;
      finalPoints.push(
        [margin, margin],
        [W - 1 - margin, margin],
        [W - 1 - margin, H - 1 - margin],
        [margin, H - 1 - margin]
      );
      finalLabels.push(0, 0, 0, 0);

      // Also add paper corners if available
      if (paperCorners) {
        const corners = [paperCorners.topLeft, paperCorners.topRight, paperCorners.bottomRight, paperCorners.bottomLeft];
        for (const c of corners) {
          finalPoints.push([c.x * session.procScale, c.y * session.procScale]);
          finalLabels.push(0);
        }
      }
    }

    promptInputs = await processor(session.image, {
      input_points: [finalPoints],
      input_labels: [finalLabels]
    });

    const inputs = {
      ...session.embeddings,
      ...promptInputs
    };
    delete inputs.pixel_values;

    outputs = await model(inputs);
    masks = await processor.post_process_masks(
      outputs.pred_masks,
      session.originalSizes,
      session.reshapedInputSizes
    );
  } else {
    // SlimSAM path with multi-point support
    promptInputs = await processor(session.image, {
      input_points: [points],
      input_labels: [labels]
    });
    outputs = await model({
      image_embeddings: session.embeddings.image_embeddings,
      image_positional_embeddings: session.embeddings.image_positional_embeddings,
      input_points: promptInputs.input_points,
      input_labels: promptInputs.input_labels,
    });
    masks = await processor.post_process_masks(outputs.pred_masks, session.originalSizes, session.reshapedInputSizes);
  }

  const mt = masks[0];
  const nMasks = mt.dims[1], H = mt.dims[2], W = mt.dims[3];
  const scores = outputs.iou_scores.data as Float32Array;
  const md = mt.data as Uint8Array;
  
  // Select the mask that has the largest area among candidates with high scores.
  // This avoids picking a "part-only" mask (which often has a slightly higher IoU prediction)
  // in favor of the "whole-object" mask.
  // Compute areas for all candidate masks
  const maskAreas = new Int32Array(nMasks);
  for (let maskIdx = 0; maskIdx < nMasks; maskIdx++) {
    let area = 0;
    const off = maskIdx * H * W;
    for (let p = 0; p < H * W; p++) {
      if (md[off + p]) area++;
    }
    maskAreas[maskIdx] = area;
  }

  // CONTAINMENT FILTER: a mask is only a valid answer if it actually covers the
  // user's POSITIVE clicks. SAM returns 3 nested masks (whole / part / speck);
  // the speck usually has the top IoU score, so the area/score heuristic alone
  // keeps picking a tiny blob — and as the user adds more clicks along a thin
  // structure (a caliper jaw) the selected speck *shrinks* instead of growing,
  // because each speck only needs to satisfy SAM, not contain every click.
  // Restrict the candidate set to masks that contain all positive clicks; the
  // tolerance is tight so a speck centred on one click can't claim clicks 40px
  // away. Single-click refine is unaffected (all 3 nested masks contain it).
  const posPts: [number, number][] = [];
  for (let i = 0; i < points.length && i < labels.length; i++) {
    if (labels[i] === 1) posPts.push(points[i]);
  }
  const tol = Math.max(3, Math.round(Math.min(H, W) * 0.004));
  const maskCoversAllPositives = (maskIdx: number): boolean => {
    if (posPts.length === 0) return true;
    const off = maskIdx * H * W;
    for (const [px, py] of posPts) {
      const cx = Math.round(px), cy = Math.round(py);
      let found = false;
      for (let dy = -tol; dy <= tol && !found; dy++) {
        const yy = cy + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -tol; dx <= tol; dx++) {
          const xx = cx + dx;
          if (xx < 0 || xx >= W) continue;
          if (md[off + yy * W + xx]) { found = true; break; }
        }
      }
      if (!found) return false;
    }
    return true;
  };
  // BACKGROUND-MASK PRE-FILTER: SAM's "whole" mask on a low-contrast tool (a
  // grey caliper on light wood) is the sheet/background — 70%+ of the frame.
  // It must never be a candidate, otherwise once clicks spread across the tool
  // the only mask containing them all is that background blob, and containment
  // would force it (then the area gate rejects everything → nothing gets added).
  // Restrict to tool-sized masks first; only if every mask is background-sized
  // do we keep them (segmentPoint's area gate is the final backstop).
  const frameArea = H * W;
  const toolSized: number[] = [];
  for (let i = 0; i < nMasks; i++) if (maskAreas[i] <= frameArea * 0.30) toolSized.push(i);
  const base = toolSized.length > 0 ? toolSized : Array.from({ length: nMasks }, (_, i) => i);

  const candidates: number[] = [];
  for (const i of base) if (maskCoversAllPositives(i)) candidates.push(i);
  // If no tool-sized mask covers every click (clicks straddle a gap), fall back
  // to all tool-sized masks and let scoring pick the best — the union of
  // successive clicks still accumulates the region.
  const pool = candidates.length > 0 ? candidates : base;

  // Find the index of the highest scoring mask (within the valid pool)
  let highestScoreIdx = pool[0];
  let maxScore = scores[pool[0]];
  for (const i of pool) {
    if (scores[i] > maxScore) {
      maxScore = scores[i];
      highestScoreIdx = i;
    }
  }

  // Restructured Whole-Object Heuristic:
  // If there is any mask that is significantly larger (>= 1.25x the area of the highest-scoring mask)
  // and has a score >= 0.55 (representing the whole object which often gets lower predicted IoU),
  // we select that larger mask.
  let best = highestScoreIdx;
  let bestArea = maskAreas[highestScoreIdx];

  for (const i of pool) {
    if (maskAreas[i] > bestArea * 1.25 && scores[i] >= 0.55) {
      best = i;
      bestArea = maskAreas[i];
    }
  }

  // Fallback to original selection logic if no significantly larger mask with score >= 0.55 is found.
  // When multiple clicks already pin a large containing mask, accept it even at a
  // lower score (a missed thin jaw reads as a low-IoU "whole" mask) — that's the
  // whole point of the containment filter.
  if (best === highestScoreIdx) {
    const multiClick = posPts.length >= 2 && candidates.length > 0;
    const thresholdScore = multiClick ? 0 : Math.max(0.65, maxScore * 0.85);
    let maxArea = -1;
    for (const i of pool) {
      if (scores[i] >= thresholdScore) {
        if (maskAreas[i] > maxArea) {
          maxArea = maskAreas[i];
          best = i;
        }
      }
    }
  }

  // Detailed debug logging
  log(`[SAM] decodeAt mask selection info:`);
  for (let i = 0; i < nMasks; i++) {
    log(`  Mask ${i}: score=${scores[i].toFixed(4)}, area=${maskAreas[i]}${i === highestScoreIdx ? ' (highest score)' : ''}${i === best ? ' (SELECTED)' : ''}`);
  }

  const off = best * H * W;
  const out = new Uint8Array(H * W);
  for (let i = 0; i < H * W; i++) out[i] = md[off + i] ? 255 : 0;

  return { data: out, width: W, height: H, score: scores[best] };
}

// Interactive: decode a mask for clicks (ORIGINAL image coords).
async function segmentPoint(
  id: string,
  url: string,
  clicks: { x: number; y: number; label: number }[],
  paperCorners?: any,
  rgbaData?: Uint8Array | Uint8ClampedArray,
  width?: number,
  height?: number
): Promise<{ mask: ArrayBuffer; width: number; height: number; score: number; scale: number } | null> {
  await embed(id, url, rgbaData, width, height);
  if (!session) return null;

  const pts = clicks.map(c => [c.x * session!.procScale, c.y * session!.procScale] as [number, number]);
  const labels = clicks.map(c => c.label);

  const r = await decodeAt(pts, labels, paperCorners);
  if (!r) return null;

  // VALIDITY GATE (confidence): when a click lands on an ambiguous spot — a
  // reflective screw thread, a chrome edge — SAM has no idea and returns garbage
  // masks scored ~0.0003. Without a floor those get unioned in as a huge spurious
  // blob. A genuine low-IoU "whole tool" mask (e.g. a thin caliper jaw recovered
  // by multi-click) still scores ~0.1+, so a low floor separates noise from signal.
  // Better to add nothing (user retries / uses Box Select) than corrupt the trace.
  if (r.score < 0.05) {
    log(`[SAM] click rejected — score ${r.score.toFixed(4)} too low (ambiguous prompt)`);
    return null;
  }

  // VALIDITY GATE (area): clicking blank paper makes SAM segment the whole
  // sheet/background. A real tool is a bounded fraction of the frame. Reject
  // paper-sized (>30%) and noise (<0.05%) masks so an empty-paper click yields
  // nothing instead of a giant outline. (30% matches autoSegment's proven
  // paper-vs-tool ceiling — the old 20% here wrongly dropped legit whole-tool
  // masks recovered by multi-click refine, e.g. a caliper jaw.)
  let area = 0;
  for (let i = 0; i < r.data.length; i++) if (r.data[i]) area++;
  const procArea = r.width * r.height;
  if (area < procArea * 0.0005 || area > procArea * 0.30) {
    log(`[SAM] click rejected — mask ${(100 * area / procArea).toFixed(1)}% of frame (not tool-sized)`);
    return null;
  }

  return { mask: r.data.buffer as ArrayBuffer, width: r.width, height: r.height, score: r.score, scale: session.scaleToOriginal };
}

interface ToolProposal {
  positivePoints: { x: number; y: number }[];
  negativePoints: { x: number; y: number }[];
  bbox: { x: number; y: number; w: number; h: number };
  sourceArea: number;
}

// Autonomous: decode every proposal using multi-point positive/negative prompts,
// filter to tool-like masks, and return survivor masks at processing resolution.
async function autoSegment(
  id: string,
  url: string,
  proposals: ToolProposal[],
  paperCorners?: any,
  rgbaData?: Uint8Array | Uint8ClampedArray,
  width?: number,
  height?: number
): Promise<{ masks: { mask: ArrayBuffer; width: number; height: number; score: number }[]; scale: number }> {
  await embed(id, url, rgbaData, width, height);
  if (!session) return { masks: [], scale: 1 };

  const W0 = session.image.width, H0 = session.image.height;
  const origArea = (W0 * session.scaleToOriginal) * (H0 * session.scaleToOriginal);
  const minArea = origArea * 0.0005;
  // A4 hand-tools: no single tool exceeds ~30% of the frame. A mask at 50%+ is
  // the paper sheet itself (proven: a prompt that lands on blank paper makes
  // SAM2 return a ~55% mask). Gate at 30% so paper-filling masks are rejected.
  const maxArea = origArea * 0.30;

  const results: { mask: ArrayBuffer; width: number; height: number; score: number }[] = [];

  for (let i = 0; i < proposals.length; i++) {
    post({ id, type: 'progress', payload: { status: 'segment', progress: Math.round((i / proposals.length) * 100) } });
    
    const prop = proposals[i];
    const pts: [number, number][] = [];
    const labels: number[] = [];

    for (const p of prop.positivePoints) {
      pts.push([p.x * session.procScale, p.y * session.procScale]);
      labels.push(1);
    }
    for (const p of prop.negativePoints) {
      pts.push([p.x * session.procScale, p.y * session.procScale]);
      labels.push(0);
    }

    if (pts.length === 0) continue;

    log(`[SAM] decoding proposal ${i}: positives=${JSON.stringify(prop.positivePoints)}, negatives=${JSON.stringify(prop.negativePoints)}`);

    // Decode this proposal in a single pass with all positive + negative points
    const r = await decodeAt(pts, labels, paperCorners);
    if (!r) {
      log(`[SAM] proposal ${i} skipped: no decode result`);
      continue;
    }
    if (r.score < 0.50) {
      log(`[SAM] proposal ${i} skipped: score ${r.score.toFixed(4)} < 0.50`);
      continue;
    }

    // Validate size to avoid background bleed
    let maskArea = 0;
    for (let p = 0; p < r.data.length; p++) {
      if (r.data[p]) maskArea++;
    }
    const actualArea = maskArea * session.scaleToOriginal * session.scaleToOriginal;
    if (actualArea < minArea || actualArea > maxArea) {
      log(`[SAM] proposal ${i} rejected — area ${Math.round(actualArea)}px² outside [${Math.round(minArea)}, ${Math.round(maxArea)}]`);
      continue;
    }

    results.push({
      mask: r.data.buffer as ArrayBuffer,
      width: r.width,
      height: r.height,
      score: r.score
    });
  }

  // Sort masks by score descending
  results.sort((a, b) => b.score - a.score);

  // Helper to compute IoU and Containment ratio between two masks
  function computeOverlap(
    maskA: Uint8Array,
    maskB: Uint8Array
  ): { iou: number; containmentA: number; containmentB: number } {
    let intersection = 0;
    let areaA = 0;
    let areaB = 0;
    const len = maskA.length;
    for (let i = 0; i < len; i++) {
      const a = maskA[i] > 0;
      const b = maskB[i] > 0;
      if (a) areaA++;
      if (b) areaB++;
      if (a && b) intersection++;
    }
    const union = areaA + areaB - intersection;
    return {
      iou: union > 0 ? intersection / union : 0,
      containmentA: areaA > 0 ? intersection / areaA : 0,
      containmentB: areaB > 0 ? intersection / areaB : 0,
    };
  }

  // Non-Maximum Suppression (NMS)
  const finalResults: typeof results = [];
  const IOU_THRESHOLD = 0.5;
  const CONTAINMENT_THRESHOLD = 0.75;

  for (const res of results) {
    const maskData = new Uint8Array(res.mask);
    let keep = true;

    for (const kept of finalResults) {
      const keptMaskData = new Uint8Array(kept.mask);
      const { iou, containmentA, containmentB } = computeOverlap(keptMaskData, maskData);

      // If overlapping or containment is too high, suppress the lower-scoring mask
      if (iou > IOU_THRESHOLD || containmentB > CONTAINMENT_THRESHOLD || containmentA > CONTAINMENT_THRESHOLD) {
        keep = false;
        log(`[SAM] NMS suppressed proposal: score=${res.score.toFixed(3)} due to overlap with score=${kept.score.toFixed(3)} (iou=${iou.toFixed(3)}, contA=${containmentA.toFixed(3)}, contB=${containmentB.toFixed(3)})`);
        break;
      }
    }

    if (keep) {
      finalResults.push(res);
    }
  }

  log(`[SAM] NMS complete: kept ${finalResults.length} / ${results.length} proposals`);
  return { masks: finalResults, scale: session.scaleToOriginal };
}

// Mask overlap (IoU + containment) — shared by both NMS passes.
function maskOverlap(a: Uint8Array, b: Uint8Array): { iou: number; contA: number; contB: number } {
  let inter = 0, areaA = 0, areaB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] > 0, bv = b[i] > 0;
    if (av) areaA++;
    if (bv) areaB++;
    if (av && bv) inter++;
  }
  const uni = areaA + areaB - inter;
  return { iou: uni > 0 ? inter / uni : 0, contA: areaA > 0 ? inter / areaA : 0, contB: areaB > 0 ? inter / areaB : 0 };
}

// AMG-style DENSE automatic mask generation. Instead of relying on the classical
// proposer (which goes blind to chrome-on-white), lay a dense grid of single-point
// prompts over the paper, let SAM segment at each point, and keep the stable,
// tool-sized, high-confidence masks (NMS-deduped). SAM's learned priors find the
// metal-on-white edge that colour/variance heuristics and IS-Net SOD miss — this
// is the "layer" the competitor appears to have. Heavier than the sparse path, so
// it is an opt-in "Deep Detect". Two tricks keep it tractable in-browser:
//   • structure gate — skip grid points on blank paper (low local gradient),
//   • covered-skip   — once a tool is segmented, skip grid points inside it.
async function autoSegmentDense(
  id: string,
  url: string,
  paperCorners: any,
  rgbaData?: Uint8Array | Uint8ClampedArray,
  width?: number,
  height?: number,
  opts?: { gridDivisions?: number; scoreFloor?: number; maxDecodes?: number; gradFloor?: number },
): Promise<{ masks: { mask: ArrayBuffer; width: number; height: number; score: number }[]; scale: number }> {
  await embed(id, url, rgbaData, width, height);
  if (!session || !rgbaData || !width || !height || !paperCorners) return { masks: [], scale: session?.scaleToOriginal ?? 1 };

  const procW = session.image.width, procH = session.image.height;
  const s2o = session.scaleToOriginal;
  const origArea = (procW * s2o) * (procH * s2o);
  const minArea = origArea * 0.0008;     // ignore specks
  const maxArea = origArea * 0.30;       // ignore the sheet itself
  const scoreFloor = opts?.scoreFloor ?? 0.62;
  const gradFloor = opts?.gradFloor ?? 12;
  const maxDecodes = opts?.maxDecodes ?? 160;
  const divisions = opts?.gridDivisions ?? 22;

  // Original-res grayscale + a cheap gradient probe for the structure gate.
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    gray[i] = (rgbaData[i * 4] * 0.299 + rgbaData[i * 4 + 1] * 0.587 + rgbaData[i * 4 + 2] * 0.114) | 0;
  }
  const gradAt = (x: number, y: number) => {
    if (x < 1 || y < 1 || x >= width! - 1 || y >= height! - 1) return 0;
    return Math.abs(gray[y * width! + x + 1] - gray[y * width! + x - 1]) +
           Math.abs(gray[(y + 1) * width! + x] - gray[(y - 1) * width! + x]);
  };

  // Paper quad (original coords): bbox + point-in-polygon test.
  const C = [paperCorners.topLeft, paperCorners.topRight, paperCorners.bottomRight, paperCorners.bottomLeft];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of C) { minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); maxX = Math.max(maxX, c.x); maxY = Math.max(maxY, c.y); }
  const inQuad = (x: number, y: number) => {
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const xi = C[i].x, yi = C[i].y, xj = C[j].x, yj = C[j].y;
      if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  };

  const step = Math.max(20, Math.round(Math.min(maxX - minX, maxY - minY) / divisions));
  const win = Math.max(4, Math.round(step * 0.4));
  const covered = new Uint8Array(procW * procH);
  const raw: { data: Uint8Array; score: number; area: number }[] = [];
  let decodes = 0;

  const rows = Math.ceil((maxY - minY) / step);
  let rowIdx = 0;
  for (let oy = minY + step / 2; oy < maxY && decodes < maxDecodes; oy += step, rowIdx++) {
    post({ id, type: 'progress', payload: { status: 'segment', progress: Math.round((rowIdx / Math.max(1, rows)) * 100) } });
    for (let ox = minX + step / 2; ox < maxX && decodes < maxDecodes; ox += step) {
      if (!inQuad(ox, oy)) continue;
      const px = Math.round(ox * session.procScale), py = Math.round(oy * session.procScale);
      if (px < 0 || py < 0 || px >= procW || py >= procH) continue;
      if (covered[py * procW + px]) continue;                 // already inside a found tool

      // Structure gate: skip blank paper (low local gradient energy).
      let g = 0, cnt = 0;
      const cy = oy | 0, cx = ox | 0;
      for (let yy = Math.max(0, cy - win); yy <= Math.min(height - 1, cy + win); yy += 3)
        for (let xx = Math.max(0, cx - win); xx <= Math.min(width - 1, cx + win); xx += 3) { g += gradAt(xx, yy); cnt++; }
      if (cnt === 0 || g / cnt < gradFloor) continue;

      decodes++;
      const r = await decodeAt([[px, py]], [1], paperCorners);
      if (!r || r.score < scoreFloor) continue;
      let area = 0;
      for (let i = 0; i < r.data.length; i++) if (r.data[i]) area++;
      const aOrig = area * s2o * s2o;
      if (aOrig < minArea || aOrig > maxArea) continue;

      raw.push({ data: r.data, score: r.score, area });
      for (let i = 0; i < r.data.length; i++) if (r.data[i]) covered[i] = 1; // skip this tool's interior next
    }
  }

  // NMS — keep highest score, suppress overlapping/contained duplicates.
  raw.sort((a, b) => b.score - a.score);
  const kept: typeof raw = [];
  for (const cand of raw) {
    let drop = false;
    for (const k of kept) {
      const { iou, contA, contB } = maskOverlap(k.data, cand.data);
      if (iou > 0.5 || contA > 0.75 || contB > 0.75) { drop = true; break; }
    }
    if (!drop) kept.push(cand);
  }

  log(`[SAM] dense AMG: ${decodes} decodes -> ${raw.length} masks -> ${kept.length} after NMS`);
  return {
    masks: kept.map((k) => ({ mask: k.data.buffer as ArrayBuffer, width: procW, height: procH, score: k.score })),
    scale: s2o,
  };
}

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const { id, type, payload } = e.data;
  try {
    let result: any;
    switch (type) {
      case 'load':
        await ensureLoaded(id);
        result = { ready: true };
        break;
      case 'embed':
        await embed(id, payload.url, payload.rgbaData, payload.width, payload.height);
        result = { embedded: true };
        break;
      case 'segmentPoint': {
        const clicks = payload.clicks || [{ x: payload.x, y: payload.y, label: 1 }];
        const r = await segmentPoint(id, payload.url, clicks, payload.paperCorners, payload.rgbaData, payload.width, payload.height);
        if (r) { post({ id, type: 'success', payload: r }, [r.mask]); return; }
        result = null;
        break;
      }
      case 'autoSegment': {
        const r = await autoSegment(id, payload.url, payload.proposals, payload.paperCorners, payload.rgbaData, payload.width, payload.height);
        post({ id, type: 'success', payload: r }, r.masks.map((m) => m.mask));
        return;
      }
      case 'autoSegmentDense': {
        const r = await autoSegmentDense(id, payload.url, payload.paperCorners, payload.rgbaData, payload.width, payload.height, payload.opts);
        post({ id, type: 'success', payload: r }, r.masks.map((m) => m.mask));
        return;
      }
      case 'clear':
        session = null;
        result = { cleared: true };
        break;
      default:
        throw new Error(`Unknown SAM message type: ${type}`);
    }
    post({ id, type: 'success', payload: result });
  } catch (err) {
    post({ id, type: 'error', payload: { message: err instanceof Error ? err.message : 'SAM error' } });
  }
};

export {};
