/**
 * SOD Worker Manager
 *
 * Drives the IS-Net salient-object-detection worker and routes its foreground
 * mask through the OpenCV contour gates (cvWorker.traceMask) so a trained-model
 * detection produces the exact same ToolTracingResult shape as classical.
 *
 * Pipeline: detectPaper (already done) → crop to paper interior → SOD mask →
 * per-tool contours → map crop coords back to full-image coords.
 *
 * The SOD mask comes from one of two backends, transparently:
 *   • In-browser IS-Net (default) — runs on-device, no server, 44 MB cached once.
 *   • A backend tracer (VITE_TRACER_URL) running BiRefNet — captures chrome/
 *     reflective tools IS-Net is blind to (hammer shaft, caliper jaws). fp32/1024²
 *     OOMs the browser, so it lives server-side. If the backend is unreachable we
 *     fall back to in-browser IS-Net automatically — the app never hard-fails.
 * Both return the identical {mask 0/255, width, height} shape, so everything
 * downstream (traceMask contour gates) is unchanged.
 */
import type { PaperCorners, ToolTracingResult } from './cvWorkerManager';
import { getImageData, traceMask } from './cvWorkerManager';

export interface SodProgress { status: string; device?: string }

let worker: Worker | null = null;
let reqId = 0;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (p: SodProgress) => void }>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./sodWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const { id, type, payload } = e.data;
    const p = pending.get(id);
    if (!p) return;
    if (type === 'progress') { p.onProgress?.(payload); return; }
    pending.delete(id);
    if (type === 'error') p.reject(new Error(payload.message));
    else p.resolve(payload);
  };
  worker.onerror = (err) => {
    for (const [, p] of pending) p.reject(new Error(err.message || 'SOD worker failed'));
    pending.clear();
  };
  return worker;
}

function request<T>(type: string, payload: unknown, transfer: Transferable[] = [], onProgress?: (p: SodProgress) => void): Promise<T> {
  const w = ensureWorker();
  return new Promise<T>((resolve, reject) => {
    const id = `${type}-${++reqId}`;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
    w.postMessage({ id, type, payload }, transfer);
  });
}

// Optional backend tracer (BiRefNet on CPU) — see the header. Empty = in-browser only.
const TRACER_URL = ((import.meta.env.VITE_TRACER_URL as string | undefined) || '').replace(/\/+$/, '');

type Seg = { mask: ArrayBuffer; width: number; height: number; device: string };

/**
 * POST the RGBA crop to the backend tracer as PNG; it returns a grayscale mask
 * PNG at the crop's size, which we threshold to the same 0/255 binary the
 * in-browser worker emits. Throws on any failure so the caller can fall back.
 */
async function backendSegment(crop: Uint8ClampedArray, cw: number, ch: number): Promise<Seg> {
  const enc = document.createElement('canvas');
  enc.width = cw; enc.height = ch;
  enc.getContext('2d')!.putImageData(new ImageData(crop, cw, ch), 0, 0);
  const blob: Blob = await new Promise((res, rej) =>
    enc.toBlob((b) => (b ? res(b) : rej(new Error('crop encode failed'))), 'image/png'));

  const resp = await fetch(`${TRACER_URL}/trace`, { method: 'POST', body: blob, headers: { 'Content-Type': 'image/png' } });
  if (!resp.ok) throw new Error(`tracer HTTP ${resp.status}`);
  console.log(`%c🧠 BACKEND TRACER: BiRefNet Lite (${resp.headers.get('x-trace-ms') || '?'}ms @ ${TRACER_URL})`, 'color:#22c55e;font-weight:bold');
  const bmp = await createImageBitmap(await resp.blob());

  const dec = document.createElement('canvas');
  dec.width = bmp.width; dec.height = bmp.height;
  const dctx = dec.getContext('2d')!;
  dctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  const px = dctx.getImageData(0, 0, dec.width, dec.height).data;
  const mask = new Uint8Array(dec.width * dec.height);
  for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4] > 127 ? 255 : 0;
  return { mask: mask.buffer, width: dec.width, height: dec.height, device: 'backend:birefnet' };
}

/**
 * Get a SOD mask for the crop: backend tracer first (if configured), else the
 * in-browser IS-Net worker. A backend error falls through to the worker — the
 * crop buffer is only transferred on the worker path, so it stays intact for the
 * fallback. Returns the canonical {mask 0/255, width, height} shape either way.
 */
async function segmentCrop(crop: Uint8ClampedArray, cw: number, ch: number, onProgress?: (p: SodProgress) => void): Promise<Seg> {
  if (TRACER_URL) {
    try {
      onProgress?.({ status: 'backend_trace', device: 'backend' });
      return await backendSegment(crop, cw, ch);
    } catch (e) {
      console.warn('[SOD] backend tracer unavailable, falling back to in-browser IS-Net:', e instanceof Error ? e.message : e);
    }
  }
  return request<Seg>('segment', { rgbaData: crop, width: cw, height: ch }, [crop.buffer], onProgress);
}

/**
 * Crop the full RGBA image to the paper's axis-aligned bounding box, inset
 * slightly to drop the paper edge / any table sliver. SOD on the full frame
 * would segment the *sheet* (the most salient object); cropping makes the tools
 * salient. Returns the crop pixels + its offset in full-image coordinates.
 */
function cropToPaper(img: ImageData, corners?: PaperCorners) {
  const W = img.width, H = img.height;
  let x0 = 0, y0 = 0, x1 = W, y1 = H;
  if (corners) {
    const xs = [corners.topLeft.x, corners.topRight.x, corners.bottomRight.x, corners.bottomLeft.x];
    const ys = [corners.topLeft.y, corners.topRight.y, corners.bottomRight.y, corners.bottomLeft.y];
    const inset = 0.015 * Math.min(W, H);
    x0 = Math.max(0, Math.min(...xs) + inset);
    y0 = Math.max(0, Math.min(...ys) + inset);
    x1 = Math.min(W, Math.max(...xs) - inset);
    y1 = Math.min(H, Math.max(...ys) - inset);
  }
  const ox = Math.round(x0), oy = Math.round(y0);
  const cw = Math.max(1, Math.round(x1) - ox), ch = Math.max(1, Math.round(y1) - oy);
  const crop = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const si = ((oy + y) * W + (ox + x)) * 4;
      const di = (y * cw + x) * 4;
      crop[di] = img.data[si]; crop[di + 1] = img.data[si + 1]; crop[di + 2] = img.data[si + 2]; crop[di + 3] = img.data[si + 3];
    }
  }
  return { crop, cw, ch, ox, oy };
}

/** Pre-load the model (optional — detection lazy-loads anyway). With a backend
 * tracer configured, the backend warms itself and IS-Net is only a fallback, so
 * we skip the 44 MB in-browser load here (it lazy-loads if the backend fails). */
export async function sodPreload(onProgress?: (p: SodProgress) => void): Promise<void> {
  if (TRACER_URL) { onProgress?.({ status: 'backend_tracer', device: 'backend' }); return; }
  await request('load', {}, [], onProgress);
}

// ── DEBUG: dump the real SOD mask + crop, so the shadow/jaggy finalizer can be
// developed against ACTUAL masks in the offline harness instead of guessing.
// Enable in the browser console: window.__DUMP_SOD = true; then run detect.
function downloadPng(name: string, rgba: Uint8ClampedArray, w: number, h: number): void {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  } catch (e) { console.warn('[DUMP] failed', e); }
}
function maskToRgba(mask: Uint8Array, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { const v = mask[i]; out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255; }
  return out;
}

/**
 * Autonomous detection via the trained SOD model. detectPaper must have run so
 * we can crop to the sheet. Returns one ToolTracingResult per tool in
 * full-image coordinates.
 */
export async function sodDetect(
  imageUrl: string,
  paperCorners?: PaperCorners,
  onProgress?: (p: SodProgress) => void,
): Promise<ToolTracingResult[]> {
  const img = await getImageData(imageUrl);
  const { crop, cw, ch, ox, oy } = cropToPaper(img, paperCorners);

  const seg = await segmentCrop(crop, cw, ch, onProgress);

  // Mask → per-tool contours (same gates as classical), in crop coordinates.
  // The first crop was transferred to the SOD worker (detached), so re-crop the
  // intact full image to hand traceMask the SAME pixels the mask was computed on
  // — it GrabCut-refines the mask boundary to the real tool edges before tracing.
  const refine = cropToPaper(img, paperCorners);

  // DEBUG dump (before traceMask transfers these buffers): real crop + SOD mask.
  if (typeof window !== 'undefined' && (window as { __DUMP_SOD?: boolean }).__DUMP_SOD) {
    const ts = Date.now();
    downloadPng(`sod_${ts}_crop.png`, new Uint8ClampedArray(refine.crop), refine.cw, refine.ch);
    const mU8 = new Uint8Array(seg.mask);
    if (mU8.length === seg.width * seg.height) {
      downloadPng(`sod_${ts}_mask.png`, maskToRgba(mU8, seg.width, seg.height), seg.width, seg.height);
    }
    console.log(`[DUMP] SOD crop ${refine.cw}x${refine.ch} + mask ${seg.width}x${seg.height} → check downloads`);
  }

  // Backend BiRefNet masks are high-quality → trace directly (skip GrabCut refine
  // + snake, which loosen a clean mask). In-browser IS-Net masks need that refine.
  const highQuality = seg.device.startsWith('backend');
  const results = await traceMask(seg.mask, seg.width, seg.height, refine.crop.buffer, highQuality);

  // Map crop coords → full-image coords.
  return results.map((r) => ({
    ...r,
    points: r.points.map((p) => ({ x: p.x + ox, y: p.y + oy })),
  }));
}
