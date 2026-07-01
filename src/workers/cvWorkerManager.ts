/**
 * CV Worker Manager
 *
 * Manages communication with the OpenCV web worker (cvWorker.ts).
 * All paper detection and tool tracing runs locally in the worker — no
 * external API. The worker keeps the main thread responsive during the
 * heavy OpenCV operations.
 */

import type { Point2D, PaperCorners } from '../lib/geometry';
import { useProgress } from '../stores/progressStore';

// Types
export type { Point2D, PaperCorners };

export interface PaperDetectionResult {
  detected: boolean;
  confidence: number;
  corners: PaperCorners | null;
  pixelsPerMm: number | null;
  message: string;
}

export interface ToolTracingResult {
  points: Point2D[];
  area: number;
  /** 0..1 geometric confidence — how tool-like the detected contour is. */
  confidence?: number;
}

/** A refinement stroke: a polyline of image-space points. */
export interface Stroke {
  points: Point2D[];
}

// ============================================================================
// Worker lifecycle
// ============================================================================

let worker: Worker | null = null;
let ready = false;
let reqId = 0;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

async function init(): Promise<void> {
  if (ready) return;

  return new Promise((resolve, reject) => {
    worker = new Worker(new URL('./cvWorker.ts', import.meta.url));

    worker.onmessage = (e) => {
      const { id, type, payload } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (type === 'error') p.reject(new Error(payload.message));
      else p.resolve(payload);
    };

    worker.onerror = () => reject(new Error('Worker failed'));

    const id = `init-${Date.now()}`;
    pending.set(id, { resolve: () => { ready = true; resolve(); }, reject });
    worker.postMessage({ id, type: 'init', payload: {} });

    setTimeout(() => { if (!ready) reject(new Error('Worker timeout')); }, 15000);
  });
}

async function request<T>(type: string, payload: unknown, transfer: Transferable[] = []): Promise<T> {
  await init();
  return new Promise((resolve, reject) => {
    const id = `${type}-${++reqId}`;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker!.postMessage({ id, type, payload }, transfer);
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('Timeout')); }
    }, 60000);
  });
}

// Decode an image URL into ImageData for the worker.
export async function getImageData(url: string): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = url;
  });
}

const A4_WIDTH_MM = 210;

// ============================================================================
// Public API
// ============================================================================

/**
 * Detect the A4 paper sheet and compute the pixels-per-mm scale.
 * Runs entirely in the OpenCV worker. If detection is weak, returns default
 * corner placement so the user can simply drag the handles into position.
 */
export async function detectPaper(imageUrl: string): Promise<PaperDetectionResult> {
  const imageData = await getImageData(imageUrl);
  useProgress.getState().start('Detecting paper…', 2500);
  try {
    return await detectPaperInner(imageData);
  } finally {
    useProgress.getState().done();
  }
}

async function detectPaperInner(imageData: ImageData): Promise<PaperDetectionResult> {
  try {
    const result = await request<PaperDetectionResult>('detectPaper', { imageData });
    if (result.detected && result.corners) {
      console.log('Paper detected via OpenCV worker:', result.confidence.toFixed(2));
      return result;
    }
  } catch (error) {
    console.warn('OpenCV paper detection failed:', error);
  }

  // Fallback: default A4 placement at 10%/90% — user drags corners to fit.
  const w = imageData.width;
  const h = imageData.height;
  return {
    detected: true,
    confidence: 0.1,
    corners: {
      topLeft: { x: w * 0.1, y: h * 0.1 },
      topRight: { x: w * 0.9, y: h * 0.1 },
      bottomRight: { x: w * 0.9, y: h * 0.9 },
      bottomLeft: { x: w * 0.1, y: h * 0.9 },
    },
    pixelsPerMm: Math.min(w, h) / A4_WIDTH_MM, // rough guess
    message: 'Auto-detection was uncertain — drag the corners to match the paper.',
  };
}

/**
 * Trace a single tool from a click point. Restricting to the paper area
 * (when corners are known) removes background false-positives.
 */
export async function traceTool(
  imageUrl: string,
  x: number,
  y: number,
  paperCorners?: PaperCorners
): Promise<ToolTracingResult | null> {
  const imageData = await getImageData(imageUrl);
  return request('traceTool', { imageData, x, y, paperCorners });
}

/** Trace the main object inside a user-drawn rectangle. */
export async function traceRegion(
  imageUrl: string,
  rect: { x: number; y: number; width: number; height: number }
): Promise<ToolTracingResult | null> {
  const imageData = await getImageData(imageUrl);
  return request('traceRegion', { imageData, rect });
}

/** Auto-detect every tool on the paper in one pass. */
export async function traceAllTools(
  imageUrl: string,
  paperCorners?: PaperCorners
): Promise<ToolTracingResult[]> {
  const imageData = await getImageData(imageUrl);
  return request<ToolTracingResult[]>('traceAllTools', { imageData, paperCorners });
}

/**
 * Start an interactive GrabCut session from a user-drawn box. Returns the first
 * segmentation. Colored/dark/textured tools come out clean; bright chrome may
 * need refinement strokes (see grabCutRefine).
 */
export async function grabCutInit(
  imageUrl: string,
  rect: { x: number; y: number; width: number; height: number }
): Promise<ToolTracingResult | null> {
  const imageData = await getImageData(imageUrl);
  return request('grabCutInit', { imageData, rect });
}

/**
 * Refine the current GrabCut session with foreground/background strokes.
 * No image is sent — the worker keeps the session — so this is fast.
 */
export async function grabCutRefine(
  fgStrokes: Stroke[],
  bgStrokes: Stroke[],
  brushRadius: number
): Promise<ToolTracingResult | null> {
  return request('grabCutRefine', { fgStrokes, bgStrokes, brushRadius });
}

/** Release the GrabCut session (free worker memory) when done with a tool. */
export async function grabCutClear(): Promise<void> {
  await request('grabCutClear', {});
}

/**
 * Extract a clean tool contour from an external binary mask (e.g. a SAM
 * segmentation). Routes through the same OpenCV contour + RDP path as classical
 * detection so AI masks become identical ToolOutlines.
 */
export async function contourFromMask(
  mask: ArrayBuffer,
  width: number,
  height: number,
  image?: { rgba: ArrayBuffer; width: number; height: number },
): Promise<ToolTracingResult | null> {
  // When the source image is supplied, the worker shadow-suppresses the mask
  // (drops SAM's cast-shadow spill) before tracing. rgba is copied, not
  // transferred — the caller (a single click) may reuse its ImageData buffer.
  return request('contourFromMask', {
    mask, width, height,
    rgba: image?.rgba, imgWidth: image?.width, imgHeight: image?.height,
  });
}

/**
 * Convert a trained-model (SOD) foreground mask into per-tool contours through
 * the SAME OpenCV gates as classical detection (hole-fill, area/solidity/aspect,
 * RDP). One ToolTracingResult per connected tool — points in the mask's own
 * coordinate space (the caller maps them back to full-image coords).
 *
 * When `rgba` (the SAME crop the mask was computed on, width×height) is supplied,
 * the worker GrabCut-refines the mask boundary to the image's real edges before
 * tracing — sharper outlines for SOD-alone + exports. Both buffers are transferred.
 */
export async function traceMask(
  mask: ArrayBuffer,
  width: number,
  height: number,
  rgba?: ArrayBuffer,
  highQuality = false,
): Promise<ToolTracingResult[]> {
  const transfer = rgba ? [mask, rgba] : [mask];
  return request<ToolTracingResult[]>('traceMask', { mask, width, height, rgba, highQuality }, transfer);
}

/**
 * Skew-correct a photo to a flat, true-to-A4 image using the 4 paper corners
 * (OpenCV perspective homography). Returns the rectified RGBA image; the caller
 * makes it the working image so all tracing runs on an undistorted, to-scale sheet.
 */
export async function rectifyToA4(
  imageData: ImageData,
  paperCorners: PaperCorners,
): Promise<{ rgba: ArrayBuffer; width: number; height: number }> {
  return request<{ rgba: ArrayBuffer; width: number; height: number }>('rectifyToA4', { imageData, paperCorners });
}

export interface ToolProposal {
  positivePoints: Point2D[];
  negativePoints: Point2D[];
  bbox: { x: number; y: number; w: number; h: number };
  sourceArea: number;
}

/**
 * Stage 1 of autonomous detection: propose SAM prompt points — classical blob
 * centroids (located tools) + a variance-gated sparse grid (uncovered metal).
 */
export async function proposeRegions(
  imageUrl: string,
  paperCorners?: PaperCorners,
): Promise<ToolProposal[]> {
  const imageData = await getImageData(imageUrl);
  return request<ToolProposal[]>('proposeRegions', { imageData, paperCorners });
}
