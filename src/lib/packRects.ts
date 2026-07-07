/**
 * packRects — skyline (bottom-left) rectangle bin-packing.
 *
 * Arranges axis-aligned boxes into a COMPACT block instead of a loose column or
 * shelf grid. A skyline lets a short tool sit in the gap beside a tall one (a
 * shelf packer leaves that space empty), so the tray packs like a real
 * shadow-board — dense and landscape — matching what competitors produce.
 *
 * Give it the items + a target bin width; it returns each item's top-left
 * position and the tight bounding size of the packed block.
 */

export interface PackItem<T> { w: number; h: number; ref: T }
export interface Placement<T> { x: number; y: number; item: PackItem<T> }
export interface PackResult<T> { placements: Placement<T>[]; width: number; height: number }

interface Seg { x: number; y: number; w: number }
const EPS = 1e-6;

/** Raise the skyline over [x, x+w] to `newY`, splitting/merging segments. */
function raiseSkyline(skyline: Seg[], x: number, w: number, newY: number): Seg[] {
  const endX = x + w;
  const out: Seg[] = [];
  for (const s of skyline) {
    const sEnd = s.x + s.w;
    if (sEnd <= x + EPS || s.x >= endX - EPS) { out.push(s); continue; } // untouched
    if (s.x < x) out.push({ x: s.x, y: s.y, w: x - s.x });               // left remainder
    if (sEnd > endX) out.push({ x: endX, y: s.y, w: sEnd - endX });      // right remainder
  }
  out.push({ x, y: newY, w });
  out.sort((a, b) => a.x - b.x);
  const merged: Seg[] = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.y - s.y) < EPS && Math.abs(last.x + last.w - s.x) < EPS) last.w += s.w;
    else merged.push({ ...s });
  }
  return merged;
}

export function packRects<T>(items: PackItem<T>[], binWidth: number, gap: number): PackResult<T> {
  // Tall items first — they anchor the packing; short items fill the pockets.
  const sorted = [...items].sort((a, b) => b.h - a.h || b.w - a.w);
  let skyline: Seg[] = [{ x: 0, y: 0, w: binWidth }];
  const placements: Placement<T>[] = [];
  let width = 0, height = 0;

  for (const item of sorted) {
    const iw = item.w + gap;
    const ih = item.h + gap;

    // Find the lowest position where `iw` fits within the bin width.
    let bestX = 0, bestY = Infinity;
    for (let i = 0; i < skyline.length; i++) {
      const startX = skyline[i].x;
      if (startX + iw > binWidth + EPS) continue;              // overflows the bin width
      let spanned = 0, y = 0, j = i;
      while (spanned < iw - EPS && j < skyline.length) { y = Math.max(y, skyline[j].y); spanned += skyline[j].w; j++; }
      if (spanned < iw - EPS) continue;                        // ran past the right edge
      if (y < bestY - EPS) { bestY = y; bestX = startX; }
    }
    if (!isFinite(bestY)) {                                    // wider than the bin — new full row
      bestX = 0;
      bestY = skyline.reduce((m, s) => Math.max(m, s.y), 0);
    }

    placements.push({ x: bestX, y: bestY, item });
    width = Math.max(width, bestX + item.w);
    height = Math.max(height, bestY + item.h);
    skyline = raiseSkyline(skyline, bestX, iw, bestY + ih);
  }

  return { placements, width, height };
}
