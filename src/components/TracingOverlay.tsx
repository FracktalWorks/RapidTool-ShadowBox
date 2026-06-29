/**
 * TracingOverlay
 * 
 * SVG overlay component for displaying and interacting with tool outlines.
 * Renders traced contours, handles selection, and shows clearance offsets.
 */

import React, { useCallback, useMemo, useState, useEffect } from 'react';
import {
  contourToSVGPath,
  offsetPolygon,
  simplifyPath,
  type ToolOutline,
  type Point2D,
} from '../lib/geometry';

// Decimate a dense contour to editable anchors for a control-polygon + Chaikin
// curve. Two requirements that pull against each other: keep sharp features
// (corners) AND keep every drag LOCAL. A control point governs the arc between
// its neighbors, so a long bare span makes dragging swing the whole segment.
// Solution: RDP for corners, THEN an even-spacing pass that caps the arc any one
// anchor governs (subdivide long spans). Handles end up evenly distributed and
// every drag stays local, instead of clustering at corners with long bare edges.
function buildEditAnchors(points: Point2D[]): Point2D[] {
  if (points.length < 8) return [...points];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, perim = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    const q = points[(i + 1) % points.length];
    perim += Math.hypot(q.x - p.x, q.y - p.y);
  }
  const diag = Math.hypot(maxX - minX, maxY - minY);

  // 1) Corner-aware base via RDP (sparse on smooth runs, keeps sharp features).
  let eps = diag * 0.015;
  let base = simplifyPath(points, eps);
  for (let i = 0; i < 6 && base.length > 40; i++) { eps *= 1.4; base = simplifyPath(points, eps); }

  // 2) Even-spacing: cap the arc length one anchor governs so every drag is local.
  const maxGap = Math.max(1, perim / 26);
  const anchors: Point2D[] = [];
  for (let i = 0; i < base.length; i++) {
    const a = base[i], b = base[(i + 1) % base.length];
    anchors.push(a);
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen > maxGap) {
      const n = Math.floor(segLen / maxGap);
      for (let k = 1; k <= n; k++) {
        const t = k / (n + 1);
        anchors.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
  }
  return anchors;
}

// Nearest base-point index to an anchor (anchors may be interpolated points that
// don't sit exactly on a base vertex).
function nearestIdx(base: Point2D[], p: Point2D): number {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < base.length; i++) {
    const d = (base[i].x - p.x) ** 2 + (base[i].y - p.y) ** 2;
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

// LOCAL deformation: move the dense contour points within `radiusPx` (arc-length)
// of `centerIdx` by `delta`, with a cosine falloff (full at the centre → 0 at the
// edge). Everything beyond the radius is left EXACTLY in place, so dragging an
// anchor reshapes only its neighbourhood — the rest of the outline and all its
// fine detail stay put (vs the old "rebuild the whole curve from sparse anchors").
function deformContour(base: Point2D[], centerIdx: number, delta: Point2D, radiusPx: number): Point2D[] {
  const N = base.length;
  const cum = new Array<number>(N);
  cum[0] = 0;
  for (let i = 1; i < N; i++) cum[i] = cum[i - 1] + Math.hypot(base[i].x - base[i - 1].x, base[i].y - base[i - 1].y);
  const total = cum[N - 1] + Math.hypot(base[0].x - base[N - 1].x, base[0].y - base[N - 1].y);
  const c = cum[centerIdx];
  return base.map((p, j) => {
    let d = Math.abs(cum[j] - c);
    d = Math.min(d, total - d); // shorter way around the closed loop
    if (d >= radiusPx) return p;
    const w = 0.5 * (1 + Math.cos((Math.PI * d) / radiusPx));
    return { x: p.x + delta.x * w, y: p.y + delta.y * w };
  });
}

// A per-outline edit entry: the dense editable contour (base) + sparse draggable
// anchors, each mapped to its base index, plus the drag influence radius.
type EditEntry = { base: Point2D[]; anchors: Point2D[]; anchorIdx: number[]; radius: number };
function makeEditEntry(displayPoints: Point2D[]): EditEntry {
  const base = displayPoints.map((p) => ({ x: p.x, y: p.y }));
  const anchors = buildEditAnchors(base);
  const anchorIdx = anchors.map((a) => nearestIdx(base, a));
  let perim = 0;
  for (let i = 0; i < base.length; i++) { const q = base[(i + 1) % base.length]; perim += Math.hypot(q.x - base[i].x, q.y - base[i].y); }
  const radius = Math.max(1, (perim / Math.max(1, anchors.length)) * 1.3);
  return { base, anchors, anchorIdx, radius };
}

// ============================================================================
// Types
// ============================================================================

interface SelectionRect {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

interface TracingOverlayProps {
  outlines: ToolOutline[];
  selectedId: string | null;
  clearancePixels: number;
  zoom: number;
  imageWidth: number;
  imageHeight: number;
  currentTool: 'select' | 'trace' | 'box' | 'edit' | 'erase' | 'pan' | 'refine';
  isTracing: boolean;
  onSelect: (id: string | null) => void;
  onDelete: (id: string) => void;
  onImageClick: (point: Point2D, label: number) => void;
  onBoxSelect?: (rect: { x: number; y: number; width: number; height: number }) => void;
  onUpdateOutline?: (id: string, points: Point2D[]) => void;
}

// ============================================================================
// Component
// ============================================================================

export const TracingOverlay: React.FC<TracingOverlayProps> = ({
  outlines,
  selectedId,
  clearancePixels,
  zoom,
  imageWidth,
  imageHeight,
  currentTool,
  isTracing,
  onSelect,
  onDelete,
  onImageClick,
  onBoxSelect,
  onUpdateOutline,
}) => {
  // State for box selection
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);

  // State for point editing — a SPARSE control polygon (anchors) for the
  // selected outline. Dragging an anchor reshapes a smooth region of the curve.
  const [dragPoint, setDragPoint] = useState<{ id: string; index: number } | null>(null);
  // Per-outline edit entries (dense base + draggable anchors). In edit mode EVERY
  // outline is editable, so this is keyed by id rather than a single selection.
  const [editState, setEditState] = useState<Record<string, EditEntry>>({});

  // In edit mode, make EVERY outline editable: build (or keep) an entry per outline.
  // Existing entries are preserved across re-renders so an in-progress edit is never
  // reset; entries for outlines that go away simply drop out.
  useEffect(() => {
    if (currentTool !== 'edit') { setEditState({}); return; }
    setEditState((prev) => {
      const next: Record<string, EditEntry> = {};
      for (const o of outlines) next[o.id] = prev[o.id] ?? makeEditEntry(o.regularizedPoints ?? o.smoothedPoints);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTool, outlines.length]);

  // Get image coordinates from mouse event
  const getImageCoords = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const scaleX = imageWidth / rect.width;
    const scaleY = imageHeight / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }, [imageWidth, imageHeight]);

  // Handle mouse down for box selection or click tracing
  const handleMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (isTracing) return;

    if (currentTool === 'box') {
      const { x, y } = getImageCoords(e);
      setSelectionRect({ startX: x, startY: y, endX: x, endY: y });
      setIsDrawing(true);
    }
  }, [currentTool, isTracing, getImageCoords]);

  // Handle point mouse down
  const handlePointMouseDown = useCallback((e: React.MouseEvent, id: string, index: number) => {
    if (currentTool !== 'edit') return;
    e.stopPropagation();
    setDragPoint({ id, index });
  }, [currentTool]);

  // Handle mouse move for box selection or dragging
  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (dragPoint && currentTool === 'edit' && onUpdateOutline) {
      const entry = editState[dragPoint.id];
      if (!entry) return;
      const { x, y } = getImageCoords(e);
      const k = dragPoint.index;
      // Move the dense contour LOCALLY around the dragged anchor (cosine falloff);
      // far points keep their exact position so the rest of the outline is untouched.
      const delta = { x: x - entry.anchors[k].x, y: y - entry.anchors[k].y };
      const newBase = deformContour(entry.base, entry.anchorIdx[k], delta, entry.radius);
      const newAnchors = entry.anchors.map((a, m) => (m === k ? { x, y } : newBase[entry.anchorIdx[m]]));
      setEditState((s) => ({ ...s, [dragPoint.id]: { ...entry, base: newBase, anchors: newAnchors } }));
      onUpdateOutline(dragPoint.id, newBase);
      return;
    }

    if (!isDrawing || currentTool !== 'box' || !selectionRect) return;
    const { x, y } = getImageCoords(e);
    setSelectionRect(prev => prev ? { ...prev, endX: x, endY: y } : null);
  }, [isDrawing, currentTool, selectionRect, getImageCoords, dragPoint, onUpdateOutline, editState]);

  // Handle mouse up for box selection or dragging
  const handleMouseUp = useCallback((_e: React.MouseEvent<SVGSVGElement>) => {
    if (dragPoint) {
      setDragPoint(null);
      return;
    }

    if (currentTool === 'box' && isDrawing && selectionRect && onBoxSelect) {
      const x = Math.min(selectionRect.startX, selectionRect.endX);
      const y = Math.min(selectionRect.startY, selectionRect.endY);
      const width = Math.abs(selectionRect.endX - selectionRect.startX);
      const height = Math.abs(selectionRect.endY - selectionRect.startY);
      
      // Only trigger if selection is large enough
      if (width > 20 && height > 20) {
        onBoxSelect({ x, y, width, height });
      }
    }
    setIsDrawing(false);
    setSelectionRect(null);
  }, [currentTool, isDrawing, selectionRect, onBoxSelect, dragPoint]);

  // Handle click on SVG background (for click-to-trace/refine)
  const handleBackgroundClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if ((currentTool !== 'trace' && currentTool !== 'refine') || isTracing) return;
    
    const { x, y } = getImageCoords(e);
    const label = (e.shiftKey || e.ctrlKey || e.metaKey) ? 0 : 1;
    console.log('Click at image coords:', x, y, 'label:', label);
    onImageClick({ x, y }, label);
  }, [currentTool, isTracing, getImageCoords, onImageClick]);

  // Handle click on outline
  const handleOutlineClick = useCallback((e: React.MouseEvent, outlineId: string) => {
    e.stopPropagation();
    
    if (currentTool === 'select' || currentTool === 'edit') {
      // In edit mode every outline is already editable; clicking just highlights
      // it (shows its bounding box) without toggling its anchors off.
      onSelect(currentTool === 'select' && selectedId === outlineId ? null : outlineId);
    } else if (currentTool === 'erase') {
      onDelete(outlineId);
    }
  }, [currentTool, selectedId, onSelect, onDelete]);

  // Cursor based on tool
  const cursor = useMemo(() => {
    if (isTracing) return 'wait';
    switch (currentTool) {
      case 'trace': return 'crosshair';
      case 'box': return 'crosshair';
      case 'select': return 'pointer';
      case 'erase': return 'not-allowed';
      case 'pan': return 'grab';
      case 'refine': return 'crosshair';
      default: return 'default';
    }
  }, [currentTool, isTracing]);

  // Stroke width adjusted for zoom
  const strokeWidth = Math.max(1, 2 / zoom);
  const handleRadius = Math.max(4, 8 / zoom);

  // Selection rectangle dimensions
  const selectionBox = selectionRect ? {
    x: Math.min(selectionRect.startX, selectionRect.endX),
    y: Math.min(selectionRect.startY, selectionRect.endY),
    width: Math.abs(selectionRect.endX - selectionRect.startX),
    height: Math.abs(selectionRect.endY - selectionRect.startY),
  } : null;

  return (
    <svg
      className="absolute inset-0 pointer-events-auto"
      width={imageWidth * zoom}
      height={imageHeight * zoom}
      viewBox={`0 0 ${imageWidth} ${imageHeight}`}
      style={{ cursor }}
      onClick={handleBackgroundClick}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onContextMenu={(e) => { if (currentTool === 'refine') e.preventDefault(); }}
    >

      {/* Selection rectangle for box tool */}
      {selectionBox && selectionBox.width > 0 && selectionBox.height > 0 && (
        <rect
          x={selectionBox.x}
          y={selectionBox.y}
          width={selectionBox.width}
          height={selectionBox.height}
          style={{
            fill: 'hsl(var(--primary) / 0.08)',
            stroke: 'hsl(var(--primary))',
            strokeWidth,
            strokeDasharray: `${8 / zoom} ${4 / zoom}`,
            pointerEvents: 'none',
          }}
        />
      )}
      
      {/* Render each outline */}
      {outlines.map((outline) => {
        const isSelected = outline.id === selectedId;
        // Prefer regularized (CAD-quality) points when available
        const displayPoints = outline.regularizedPoints ?? outline.smoothedPoints;
        const path = contourToSVGPath(displayPoints, true);
        
        // Calculate offset path for clearance (using round joins for smooth result)
        const offsetPath = clearancePixels > 0
          ? contourToSVGPath(offsetPolygon(displayPoints, clearancePixels), true)
          : null;

        return (
          <g key={outline.id}>
            {/* Clearance offset (dashed) */}
            {offsetPath && (
              <path
                d={offsetPath}
                fill="none"
                stroke={outline.color}
                strokeWidth={strokeWidth}
                strokeDasharray={`${4 / zoom} ${4 / zoom}`}
                opacity={0.5}
              />
            )}
            
            {/* Main outline — filled like the competitor's solid green overlays */}
            <path
              d={path}
              fill={isSelected ? `${outline.color}99` : `${outline.color}66`}
              stroke={outline.color}
              strokeWidth={isSelected ? strokeWidth * 2.5 : strokeWidth * 1.5}
              strokeLinejoin="round"
              onClick={(e) => handleOutlineClick(e, outline.id)}
              style={{ 
                cursor: currentTool === 'select' ? 'pointer' : 
                        currentTool === 'erase' ? 'not-allowed' : 'default',
              }}
              className="transition-all"
            />
            
            {/* Selection handles */}
            {isSelected && (
              <>
                {/* Bounding box */}
                <rect
                  x={outline.boundingBox.minX}
                  y={outline.boundingBox.minY}
                  width={outline.boundingBox.maxX - outline.boundingBox.minX}
                  height={outline.boundingBox.maxY - outline.boundingBox.minY}
                  fill="none"
                  stroke={outline.color}
                  strokeWidth={strokeWidth}
                  strokeDasharray={`${2 / zoom} ${2 / zoom}`}
                  opacity={0.5}
                />
                
                {/* Corner handles */}
                {[
                  { x: outline.boundingBox.minX, y: outline.boundingBox.minY },
                  { x: outline.boundingBox.maxX, y: outline.boundingBox.minY },
                  { x: outline.boundingBox.maxX, y: outline.boundingBox.maxY },
                  { x: outline.boundingBox.minX, y: outline.boundingBox.maxY },
                ].map((corner, i) => (
                  <circle
                    key={i}
                    cx={corner.x}
                    cy={corner.y}
                    r={handleRadius}
                    fill="white"
                    stroke={outline.color}
                    strokeWidth={strokeWidth}
                  />
                ))}

                {/* Refinement prompt click dots */}
                {(currentTool === 'trace' || currentTool === 'refine') && outline.samClicks && outline.samClicks.map((click, i) => (
                  <circle
                    key={`click-${i}`}
                    cx={click.x}
                    cy={click.y}
                    r={Math.max(4, 6 / zoom)}
                    fill={click.label === 1 ? 'hsl(142 76% 47%)' : 'hsl(0 84% 60%)'}
                    stroke="white"
                    strokeWidth={Math.max(1, 1.5 / zoom)}
                    style={{ pointerEvents: 'none' }}
                  />
                ))}

                {/* Label — shown for all tools, more prominent when selected */}
                <text
                  x={outline.boundingBox.minX}
                  y={outline.boundingBox.minY - 8 / zoom}
                  fill={outline.color}
                  fontSize={12 / zoom}
                  fontWeight="bold"
                >
                  {outline.name}
                </text>
              </>
            )}

            {/* Unselected label — always shown so tools are identifiable */}
            {!isSelected && (
              <text
                x={outline.boundingBox.minX + 4 / zoom}
                y={outline.boundingBox.minY + 14 / zoom}
                fill={outline.color}
                fontSize={10 / zoom}
                fontWeight="600"
                opacity={0.85}
                style={{ pointerEvents: 'none' }}
              >
                {outline.name}
              </text>
            )}

            {/* Edit anchors — shown for EVERY outline in edit mode (not just the
                selected one) so any tool's points can be dragged without first
                re-selecting it. Dragging one reshapes only its local region. */}
            {currentTool === 'edit' && editState[outline.id] && (
              <>
                <polygon
                  points={editState[outline.id].anchors.map(p => `${p.x},${p.y}`).join(' ')}
                  fill="none"
                  stroke={outline.color}
                  strokeWidth={strokeWidth}
                  strokeDasharray={`${3 / zoom} ${3 / zoom}`}
                  opacity={0.4}
                  style={{ pointerEvents: 'none' }}
                />
                {editState[outline.id].anchors.map((point, i) => {
                  const active = dragPoint?.id === outline.id && dragPoint?.index === i;
                  return (
                    <circle
                      key={`anchor-${i}`}
                      cx={point.x}
                      cy={point.y}
                      r={active ? Math.max(5, 9 / zoom) : Math.max(4, 7 / zoom)}
                      fill={active ? outline.color : 'white'}
                      stroke={outline.color}
                      strokeWidth={strokeWidth * 1.5}
                      style={{ cursor: 'grab' }}
                      onMouseDown={(e) => handlePointMouseDown(e, outline.id, i)}
                    />
                  );
                })}
              </>
            )}
          </g>
        );
      })}
      
      {/* Tracing indicator */}
      {isTracing && (
        <g>
          <rect
            x={0}
            y={0}
            width={imageWidth}
            height={imageHeight}
            fill="rgba(0,0,0,0.1)"
          />
          <text
            x={imageWidth / 2}
            y={imageHeight / 2}
            fill="white"
            fontSize={16 / zoom}
            textAnchor="middle"
            dominantBaseline="middle"
          >
            Tracing...
          </text>
        </g>
      )}
    </svg>
  );
};

export default TracingOverlay;
