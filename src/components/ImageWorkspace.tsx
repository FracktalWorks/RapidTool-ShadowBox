/**
 * ImageWorkspace
 * 
 * Main canvas area for displaying the uploaded image
 * with overlay support for paper detection and tool tracing.
 * 
 * Features:
 * - Canvas-based rendering for better performance
 * - Zoom around cursor position
 * - Smooth panning with constraints
 * - Keyboard shortcuts
 * - Precise overlay alignment
 */

import React, { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { ZoomIn, ZoomOut, Maximize2, RotateCcw, Move } from 'lucide-react';
import { useAppStore } from '../stores';
import type { Point2D, ToolOutline } from '../stores';
import { DraggableCorners } from './DraggableCorners';
import { TracingOverlay } from './TracingOverlay';
import { calculatePixelsPerMm, createToolOutline, contourToSVGPath, pointInPolygon, unionPolygons } from '../lib/geometry';
import { traceTool, grabCutInit, grabCutRefine, samSegmentPoint, type SamLoadProgress } from '../workers';

// ============================================================================
// Constants
// ============================================================================

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 10;
const ZOOM_STEP = 1.15;
const FIT_PADDING = 48;

// ============================================================================
// Types
// ============================================================================

interface ViewState {
  zoom: number;
  panX: number;
  panY: number;
}

interface ImageWorkspaceProps {
  className?: string;
  onImageClick?: (point: Point2D) => void;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Clamp a value between min and max
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Calculate the scale to fit image in container
 */
function calculateFitScale(
  imageWidth: number,
  imageHeight: number,
  containerWidth: number,
  containerHeight: number,
  padding: number = FIT_PADDING
): number {
  const availableWidth = containerWidth - padding * 2;
  const availableHeight = containerHeight - padding * 2;

  const scaleX = availableWidth / imageWidth;
  const scaleY = availableHeight / imageHeight;

  return Math.min(scaleX, scaleY, 1);
}

/**
 * Calculate bounding box from points
 */
function calculateBoundingBox(points: Point2D[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Color palette for tool outlines
 */
const TOOL_COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b',
  '#8b5cf6', '#ec4899', '#06b6d4', '#f97316',
];
let colorIndex = 0;

function getNextToolColor(): string {
  const color = TOOL_COLORS[colorIndex % TOOL_COLORS.length];
  colorIndex++;
  return color;
}

// ============================================================================
// Custom Hooks
// ============================================================================

/**
 * Hook for managing view state (zoom/pan)
 */
function useViewState(imageSize: { width: number; height: number } | null) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewState>({ zoom: 1, panX: 0, panY: 0 });

  // Fit to view when image changes
  useEffect(() => {
    if (imageSize && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const scale = calculateFitScale(
        imageSize.width,
        imageSize.height,
        rect.width,
        rect.height
      );
      setView({ zoom: scale, panX: 0, panY: 0 });
    }
  }, [imageSize]);

  const zoomTo = useCallback((newZoom: number, centerX?: number, centerY?: number) => {
    setView((prev) => {
      const clampedZoom = clamp(newZoom, MIN_ZOOM, MAX_ZOOM);

      if (centerX !== undefined && centerY !== undefined) {
        // Zoom towards the specified point
        const zoomRatio = clampedZoom / prev.zoom;
        const newPanX = centerX - (centerX - prev.panX) * zoomRatio;
        const newPanY = centerY - (centerY - prev.panY) * zoomRatio;
        return { zoom: clampedZoom, panX: newPanX, panY: newPanY };
      }

      return { ...prev, zoom: clampedZoom };
    });
  }, []);

  const panBy = useCallback((dx: number, dy: number) => {
    setView((prev) => ({
      ...prev,
      panX: prev.panX + dx,
      panY: prev.panY + dy,
    }));
  }, []);

  const fitToView = useCallback(() => {
    if (imageSize && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const scale = calculateFitScale(
        imageSize.width,
        imageSize.height,
        rect.width,
        rect.height
      );
      setView({ zoom: scale, panX: 0, panY: 0 });
    }
  }, [imageSize]);

  const resetView = useCallback(() => {
    setView({ zoom: 1, panX: 0, panY: 0 });
  }, []);

  return {
    containerRef,
    view,
    zoomTo,
    panBy,
    fitToView,
    resetView,
    setView,
  };
}

// ============================================================================
// Sub-Components
// ============================================================================

interface PaperOverlayProps {
  corners: {
    topLeft: Point2D;
    topRight: Point2D;
    bottomRight: Point2D;
    bottomLeft: Point2D;
  };
  zoom: number;
}

const PaperOverlay: React.FC<PaperOverlayProps> = ({ corners, zoom }) => {
  const points = `${corners.topLeft.x},${corners.topLeft.y} ${corners.topRight.x},${corners.topRight.y} ${corners.bottomRight.x},${corners.bottomRight.y} ${corners.bottomLeft.x},${corners.bottomLeft.y}`;

  return (
    <g className="paper-overlay">
      {/* Fill */}
      <polygon
        points={points}
        style={{ fill: 'hsl(var(--primary) / 0.07)', stroke: 'none' }}
      />
      {/* Border */}
      <polygon
        points={points}
        style={{
          fill: 'none',
          stroke: 'hsl(var(--primary))',
          strokeWidth: Math.max(2 / zoom, 1),
          strokeDasharray: `${Math.max(8 / zoom, 4)} ${Math.max(4 / zoom, 2)}`,
        }}
      />
      {/* Corner handles */}
      {[corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft].map((corner, i) => (
        <circle
          key={i}
          cx={corner.x}
          cy={corner.y}
          r={Math.max(6 / zoom, 4)}
          style={{
            fill: 'hsl(var(--primary))',
            stroke: 'white',
            strokeWidth: Math.max(2 / zoom, 1),
          }}
          className="cursor-move"
        />
      ))}
    </g>
  );
};

interface ToolOutlinesOverlayProps {
  outlines: ToolOutline[];
  selectedId: string | null;
  zoom: number;
}

const ToolOutlinesOverlay: React.FC<ToolOutlinesOverlayProps> = ({
  outlines,
  selectedId,
  zoom
}) => {
  return (
    <g className="tool-outlines">
      {outlines.map((outline) => {
        const isSelected = outline.id === selectedId;
        const displayPoints = outline.regularizedPoints ?? outline.smoothedPoints;
        const pointsStr = displayPoints.map((p) => `${p.x},${p.y}`).join(' ');

        return (
          <g key={outline.id}>
            {/* Fill */}
            <path
              d={contourToSVGPath(displayPoints)}
              fill={isSelected ? `${outline.color}30` : `${outline.color}15`}
              stroke="none"
              className="transition-all duration-300"
            />
            {/* Border */}
            <path
              d={contourToSVGPath(displayPoints)}
              fill="none"
              stroke={outline.color}
              strokeWidth={Math.max((isSelected ? 3 : 2) / zoom, 1)}
              className="transition-all duration-300"
            />
          </g>
        );
      })}
    </g>
  );
};

interface ZoomControlsProps {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onReset: () => void;
}

const ZoomControls: React.FC<ZoomControlsProps> = ({
  zoom,
  onZoomIn,
  onZoomOut,
  onFit,
  onReset,
}) => {
  return (
    <div className="absolute bottom-4 right-4 flex items-center gap-1 bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-xl p-1.5" style={{ boxShadow: 'var(--shadow-md)' }}>
      <button
        onClick={onZoomOut}
        className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-[hsl(var(--muted))] transition-colors"
        title="Zoom out (−)"
      >
        <ZoomOut className="w-4 h-4" />
      </button>
      <span className="w-14 text-center text-[12px] font-tech font-medium text-[hsl(var(--muted-foreground))]">
        {Math.round(zoom * 100)}%
      </span>
      <button
        onClick={onZoomIn}
        className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-[hsl(var(--muted))] transition-colors"
        title="Zoom in (+)"
      >
        <ZoomIn className="w-4 h-4" />
      </button>
      <div className="w-px h-4 bg-[hsl(var(--border))]" />
      <button
        onClick={onFit}
        className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-[hsl(var(--muted))] transition-colors"
        title="Fit to view (F)"
      >
        <Maximize2 className="w-4 h-4" />
      </button>
      <button
        onClick={onReset}
        className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-[hsl(var(--muted))] transition-colors"
        title="Reset view (R)"
      >
        <RotateCcw className="w-4 h-4" />
      </button>
    </div>
  );
};

// ============================================================================
// Simple Empty State (for steps 2-5)
// ============================================================================

const EmptyState: React.FC = () => (
  <div className="flex flex-col items-center justify-center h-full text-[hsl(var(--muted-foreground))]">
    <div className="w-16 h-16 rounded-xl bg-[hsl(var(--muted))] flex items-center justify-center mb-4">
      <svg className="w-8 h-8 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
        />
      </svg>
    </div>
    <p className="text-[14px] font-medium mb-1">No image loaded</p>
    <p className="text-[12px] opacity-60">Upload an image to get started</p>
  </div>
);

// ============================================================================
// Upload Dropzone (for step 1 - Paper Detection)
// ============================================================================

interface UploadDropzoneProps {
  onFileSelect: (file: File) => void;
}

const UploadDropzone: React.FC<UploadDropzoneProps> = ({ onFileSelect }) => {
  const [isDragging, setIsDragging] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handleDrop = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      onFileSelect(file);
    }
  }, [onFileSelect]);

  const handleDragOver = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleFileSelect = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onFileSelect(file);
    }
  }, [onFileSelect]);

  return (
    <div className="flex flex-col items-center justify-center h-full p-8">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileSelect}
        className="hidden"
      />

      {/* Minimal dropzone with dashed border */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => fileInputRef.current?.click()}
        className={`
          w-full max-w-md cursor-pointer
          border-2 border-dashed rounded-xl p-8
          flex flex-col items-center justify-center gap-4
          transition-colors duration-200
          ${isDragging
            ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.02)]'
            : 'border-[hsl(var(--border))] hover:border-[hsl(var(--muted-foreground)/0.4)] hover:bg-[hsl(var(--muted)/0.3)]'
          }
        `}
      >
        {/* Icon */}
        <div className={`
          w-14 h-14 rounded-xl flex items-center justify-center
          transition-colors duration-200
          ${isDragging
            ? 'bg-[hsl(var(--primary)/0.1)]'
            : 'bg-[hsl(var(--muted))]'
          }
        `}>
          <svg
            className={`
              w-7 h-7 transition-colors duration-200
              ${isDragging
                ? 'text-[hsl(var(--primary))]'
                : 'text-[hsl(var(--muted-foreground))]'
              }
            `}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
            />
          </svg>
        </div>

        {/* Text */}
        <div className="text-center">
          <p className={`
            text-[15px] font-semibold mb-1 transition-colors duration-200
            ${isDragging ? 'text-[hsl(var(--primary))]' : 'text-[hsl(var(--foreground))]'}
          `}>
            {isDragging ? 'Drop image here' : 'Drop image here or click to browse'}
          </p>
          <p className="text-[13px] text-[hsl(var(--muted-foreground))]">
            JPG, PNG, WebP • Max 50MB
          </p>
        </div>

        {/* Browse button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            fileInputRef.current?.click();
          }}
          className="
            px-5 py-2.5 rounded-xl text-[13px] font-semibold
            text-white transition-all duration-200
          "
          style={{ background: 'var(--gradient-primary)', boxShadow: 'var(--shadow-btn)' }}
        >
          Browse Files
        </button>
      </div>

      {/* Subtle tips */}
      <p className="mt-6 text-[13px] text-[hsl(var(--muted-foreground))] text-center max-w-sm">
        Tip: Place your tools on white A4 paper and take a photo from directly above for best results.
      </p>
    </div>
  );
};

// ============================================================================
// Image Info Bar
// ============================================================================

interface ImageInfoBarProps {
  imageSize: { width: number; height: number };
  fileName?: string;
}

const ImageInfoBar: React.FC<ImageInfoBarProps> = ({ imageSize, fileName }) => (
  <div className="absolute top-4 left-4 flex items-center gap-3 bg-[hsl(var(--card))/90] backdrop-blur-sm border border-[hsl(var(--border))] rounded-lg px-3 py-1.5 shadow-sm">
    <span className="text-xs font-tech text-[hsl(var(--muted-foreground))]">
      {imageSize.width} × {imageSize.height}
    </span>
    {fileName && (
      <>
        <div className="w-px h-3 bg-[hsl(var(--border))]" />
        <span className="text-xs text-[hsl(var(--muted-foreground))] truncate max-w-[200px]">
          {fileName}
        </span>
      </>
    )}
  </div>
);

// ============================================================================
// Main Component
// ============================================================================

export const ImageWorkspace: React.FC<ImageWorkspaceProps> = ({
  className,
  onImageClick,
}) => {
  const {
    imageUrl,
    imageSize,
    imageFile,
    setImage,
    paperCorners,
    setPaperCorners,
    setPixelsPerMm,
    pixelsPerMm,
    toolOutlines,
    selectedOutlineId,
    selectOutline,
    addToolOutline,
    removeToolOutline,
    currentStep,
    activeTool,
    clearanceValue,
    updateToolOutlineSmoothed,
    updateToolOutlineRefined,
    refineBrush,
  } = useAppStore();

  // First-time SlimSAM model download progress (null when not loading).
  const [samProgress, setSamProgress] = useState<SamLoadProgress | null>(null);

  const {
    containerRef,
    view,
    zoomTo,
    panBy,
    fitToView,
    resetView
  } = useViewState(imageSize);

  const [isPanning, setIsPanning] = useState(false);
  const [lastMouse, setLastMouse] = useState({ x: 0, y: 0 });
  const [isImageLoaded, setIsImageLoaded] = useState(false);
  const [isTracing, setIsTracing] = useState(false);

  // Handle corner updates from draggable corners
  const handleCornersChange = useCallback((newCorners: {
    topLeft: Point2D;
    topRight: Point2D;
    bottomRight: Point2D;
    bottomLeft: Point2D;
  }) => {
    setPaperCorners(newCorners);
    // Recalculate pixels per mm based on new corners
    const ppm = calculatePixelsPerMm(newCorners);
    setPixelsPerMm(ppm);
  }, [setPaperCorners, setPixelsPerMm]);

  // Handle tracing click
  const handleTracingClick = useCallback(async (point: Point2D, label: number = 1) => {
    if (!imageUrl || isTracing) return;

    setIsTracing(true);

    // Polygon area (shoelace) — used to tell whether a click actually grew the trace.
    const polyArea = (p: Point2D[]) => {
      let a = 0;
      for (let i = 0; i < p.length; i++) { const j = (i + 1) % p.length; a += p[i].x * p[j].y - p[j].x * p[i].y; }
      return Math.abs(a) / 2;
    };

    // ADD the region under a positive click and UNION it into `existing`.
    // Why not just re-run SAM with every click? Multi-point SAM keeps returning the
    // dominant object (the tool body), so a click on a thin / attached / low-contrast
    // part (depth rod, chrome jaw) never grows the trace — the dots feel "dead".
    // Instead: (1) segment LOCALLY with only this click; (2) if that didn't grow the
    // outline, grab the local region by EDGES with a small GrabCut box around the
    // click — that's what reliably captures thin / low-saliency parts. Never shrinks.
    const addRegionAtClick = async (existing: Point2D[]): Promise<Point2D[]> => {
      let merged = existing;
      try {
        const r = await samSegmentPoint(imageUrl, [{ x: point.x, y: point.y, label: 1 }], { paperCorners: paperCorners || undefined, onProgress: setSamProgress });
        if (r?.points && r.points.length >= 3) merged = unionPolygons(existing, r.points);
      } catch (e) { console.warn('SAM add-click failed:', e); }
      finally { setSamProgress(null); }

      if (polyArea(merged) <= polyArea(existing) * 1.005) {
        try {
          const BOX = 120; // px box centred on the click for the local edge-grab
          const box = { x: Math.round(point.x - BOX / 2), y: Math.round(point.y - BOX / 2), width: BOX, height: BOX };
          const gc = await grabCutInit(imageUrl, box);
          if (gc?.points && gc.points.length >= 3) merged = unionPolygons(existing, gc.points);
        } catch (e) { console.warn('Local edge-grab fallback failed:', e); }
      }
      return merged;
    };

    // REMOVE (negative click): re-segment with the full click set so the negative
    // point carves the region out; keep the tool if SAM returns nothing.
    const removeWithClicks = async (existing: Point2D[], clicks: { x: number; y: number; label: number }[]): Promise<Point2D[]> => {
      let result = null;
      try { result = await samSegmentPoint(imageUrl, clicks, { paperCorners: paperCorners || undefined, onProgress: setSamProgress }); }
      catch (samErr) { console.warn('SAM remove failed:', samErr); }
      finally { setSamProgress(null); }
      return result?.points && result.points.length >= 3 ? result.points : existing;
    };

    try {
      if (activeTool === 'refine') {
        // Refinement of an existing tool
        if (selectedOutlineId) {
          const outline = toolOutlines.find(o => o.id === selectedOutlineId);
          if (outline) {
            const currentClicks = outline.samClicks ? [...outline.samClicks] : [];
            currentClicks.push({ x: point.x, y: point.y, label });
            const existing = outline.smoothedPoints && outline.smoothedPoints.length >= 3 ? outline.smoothedPoints : outline.points;
            const merged = label === 1 ? await addRegionAtClick(existing) : await removeWithClicks(existing, currentClicks);
            updateToolOutlineRefined(selectedOutlineId, merged, currentClicks);
          }
        }
      } else {
        // Did the click land INSIDE an existing tool? If so, refine THAT tool
        // (same id, same colour) with SAM instead of spawning a duplicate
        // "Tool 2" overlapping it. Only an empty-paper click makes a new tool.
        let hit = toolOutlines.find(o =>
          pointInPolygon(point, o.smoothedPoints && o.smoothedPoints.length >= 3 ? o.smoothedPoints : o.points)
        );

        // Not inside any tool: attach to the NEAREST tool when the click is close
        // (an SOD-missed caliper jaw sits just off the body). No pre-selection
        // needed — distance is 0 inside the bbox, else the gap to its edge. A far
        // click on blank paper exceeds the reach and makes a NEW tool instead.
        if (!hit) {
          let best: (typeof toolOutlines)[number] | null = null;
          let bestD = Infinity;
          for (const o of toolOutlines) {
            const b = o.boundingBox;
            if (!b) continue;
            const dx = Math.max(b.minX - point.x, 0, point.x - b.maxX);
            const dy = Math.max(b.minY - point.y, 0, point.y - b.maxY);
            const d = Math.hypot(dx, dy);
            if (d < bestD) { bestD = d; best = o; }
          }
          if (best && best.boundingBox) {
            const b = best.boundingBox;
            const reach = Math.max(150, 0.25 * Math.hypot(b.maxX - b.minX, b.maxY - b.minY));
            if (bestD <= reach) hit = best;
          }
        }

        if (hit) {
          selectOutline(hit.id);
          const currentClicks = hit.samClicks ? [...hit.samClicks] : [];
          currentClicks.push({ x: point.x, y: point.y, label });
          const existing = hit.smoothedPoints && hit.smoothedPoints.length >= 3 ? hit.smoothedPoints : hit.points;
          const merged = label === 1 ? await addRegionAtClick(existing) : await removeWithClicks(existing, currentClicks);
          updateToolOutlineRefined(hit.id, merged, currentClicks);
        } else {
          // New tool creation (click on empty paper).
          const initialClicks = [{ x: point.x, y: point.y, label: 1 }];
          let result = null;
          let samRan = false;
          try {
            result = await samSegmentPoint(imageUrl, initialClicks, { paperCorners: paperCorners || undefined, onProgress: setSamProgress });
            samRan = true; // SAM completed (a null result = it ran and found no valid tool)
          } catch (samErr) {
            console.warn('SAM unavailable, falling back to classical trace:', samErr);
          } finally {
            setSamProgress(null);
          }
          // Fall back to classical ONLY when SAM was unavailable. If SAM ran and
          // returned null, the click was on blank paper — create nothing.
          if (!result && !samRan) {
            result = await traceTool(imageUrl, point.x, point.y, paperCorners || undefined);
          }
          if (result) {
            const outline = createToolOutline(result.points, pixelsPerMm || undefined, result.confidence, initialClicks);
            addToolOutline(outline);
          }
        }
      }
    } catch (error) {
      console.error('Tracing error:', error);
    } finally {
      setIsTracing(false);
    }
  }, [imageUrl, isTracing, pixelsPerMm, toolOutlines, selectedOutlineId, addToolOutline, updateToolOutlineRefined, selectOutline, paperCorners, activeTool]);

  // Handle box selection — GrabCut graph-cut segmentation.
  const handleBoxSelect = useCallback(async (rect: { x: number; y: number; width: number; height: number }) => {
    if (!imageUrl || isTracing) return;

    setIsTracing(true);
    try {
      const result = await grabCutInit(imageUrl, rect);
      if (result) {
        // If the box sits on/near an existing tool, UNION into it (e.g. adding a
        // chrome caliper jaw — Box Select is the reliable grab for thin/metallic
        // parts). Otherwise create a new tool.
        const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
        let best: (typeof toolOutlines)[number] | null = null;
        let bestD = Infinity;
        for (const o of toolOutlines) {
          const b = o.boundingBox;
          if (!b) continue;
          const dx = Math.max(b.minX - cx, 0, cx - b.maxX);
          const dy = Math.max(b.minY - cy, 0, cy - b.maxY);
          const d = Math.hypot(dx, dy);
          if (d < bestD) { bestD = d; best = o; }
        }
        let merged = false;
        if (best && best.boundingBox) {
          const b = best.boundingBox;
          const reach = Math.max(150, 0.25 * Math.hypot(b.maxX - b.minX, b.maxY - b.minY));
          if (bestD <= reach) {
            const existing = best.smoothedPoints && best.smoothedPoints.length >= 3 ? best.smoothedPoints : best.points;
            updateToolOutlineRefined(best.id, unionPolygons(existing, result.points), best.samClicks);
            selectOutline(best.id);
            merged = true;
          }
        }
        if (!merged) {
          const outline = createToolOutline(result.points, pixelsPerMm || undefined, result.confidence);
          addToolOutline(outline);
        }
      }
    } catch (error) {
      console.error('GrabCut error:', error);
    } finally {
      setIsTracing(false);
    }
  }, [imageUrl, isTracing, pixelsPerMm, toolOutlines, addToolOutline, updateToolOutlineRefined, selectOutline]);

  // Reset loaded state when image changes
  useEffect(() => {
    setIsImageLoaded(false);
  }, [imageUrl]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      switch (e.key) {
        case '+':
        case '=':
          e.preventDefault();
          zoomTo(view.zoom * ZOOM_STEP);
          break;
        case '-':
        case '_':
          e.preventDefault();
          zoomTo(view.zoom / ZOOM_STEP);
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          fitToView();
          break;
        case 'r':
        case 'R':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            resetView();
          }
          break;
        case '0':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            fitToView();
          }
          break;
        case '1':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            zoomTo(1);
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [view.zoom, zoomTo, fitToView, resetView]);

  // Mouse wheel zoom - use native event listener with passive: false
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();

      const rect = container.getBoundingClientRect();

      // Calculate cursor position relative to container center
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const mouseX = e.clientX - rect.left - centerX;
      const mouseY = e.clientY - rect.top - centerY;

      const delta = e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
      const newZoom = clamp(view.zoom * delta, MIN_ZOOM, MAX_ZOOM);

      // Zoom towards cursor
      const zoomRatio = newZoom / view.zoom;
      const newPanX = mouseX - (mouseX - view.panX) * zoomRatio;
      const newPanY = mouseY - (mouseY - view.panY) * zoomRatio;

      zoomTo(newZoom);
      panBy(newPanX - view.panX, newPanY - view.panY);
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [view, zoomTo, panBy]);

  // Mouse down for panning
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Right mouse button or Ctrl+Left click for panning
    if (e.button === 2 || (e.button === 0 && e.ctrlKey)) {
      e.preventDefault();
      setIsPanning(true);
      setLastMouse({ x: e.clientX, y: e.clientY });
    } else if (e.button === 0 && !e.ctrlKey && onImageClick && imageSize) {
      // Left click - calculate image coordinates
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const centerX = rect.width / 2;
      const centerY = rect.height / 2;

      // Position relative to container center, accounting for pan and zoom
      const relX = e.clientX - rect.left - centerX - view.panX;
      const relY = e.clientY - rect.top - centerY - view.panY;

      // Convert to image coordinates
      const imgX = (relX / view.zoom) + imageSize.width / 2;
      const imgY = (relY / view.zoom) + imageSize.height / 2;

      // Check if click is within image bounds
      if (imgX >= 0 && imgX <= imageSize.width && imgY >= 0 && imgY <= imageSize.height) {
        onImageClick({ x: imgX, y: imgY });
      }
    }
  }, [onImageClick, imageSize, view, containerRef]);

  // Mouse move for panning
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isPanning) {
      const dx = e.clientX - lastMouse.x;
      const dy = e.clientY - lastMouse.y;
      panBy(dx, dy);
      setLastMouse({ x: e.clientX, y: e.clientY });
    }
  }, [isPanning, lastMouse, panBy]);

  // Mouse up to stop panning
  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  // Prevent context menu when right-clicking for panning
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  // Cursor style based on state
  const cursorStyle = useMemo(() => {
    if (isPanning) return 'grabbing';
    if (currentStep === 'tools') return 'crosshair';
    return 'default';
  }, [isPanning, currentStep]);

  // Empty state - show dropzone only on paper step, simple empty state otherwise
  if (!imageUrl) {
    return (
      <div className={`h-full bg-[hsl(var(--workspace-bg))] ${className}`}>
        {currentStep === 'paper' ? (
          <UploadDropzone onFileSelect={setImage} />
        ) : (
          <EmptyState />
        )}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`relative h-full bg-[hsl(var(--workspace-bg))] overflow-hidden select-none ${className}`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onContextMenu={handleContextMenu}
      style={{ cursor: cursorStyle }}
      tabIndex={0}
    >
      {/* Checkerboard background pattern */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `
            linear-gradient(45deg, #808080 25%, transparent 25%),
            linear-gradient(-45deg, #808080 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, #808080 75%),
            linear-gradient(-45deg, transparent 75%, #808080 75%)
          `,
          backgroundSize: '20px 20px',
          backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px',
        }}
      />

      {/* Canvas Container - centers content */}
      <div
        className="absolute inset-0 flex items-center justify-center"
        style={{
          transform: `translate(${view.panX}px, ${view.panY}px)`,
        }}
      >
        {/* Image Container - CSS scaled (raster) */}
        <div
          className="relative"
          style={{
            transform: `scale(${view.zoom})`,
            transformOrigin: 'center center',
            willChange: 'transform',
          }}
        >
          {/* Image */}
          <img
            src={imageUrl}
            alt="Uploaded image"
            className="max-w-none block"
            style={{
              imageRendering: view.zoom > 2 ? 'pixelated' : 'auto',
            }}
            draggable={false}
            onLoad={() => setIsImageLoaded(true)}
          />
        </div>

        {/* SVG Overlay Layer - Outside CSS scale for crisp vector rendering */}
        {isImageLoaded && imageSize && (
          <div
            className="absolute pointer-events-none"
            style={{
              width: imageSize.width * view.zoom,
              height: imageSize.height * view.zoom,
            }}
          >
            {/* Paper Detection Overlay - Draggable when in paper step */}
            {paperCorners && currentStep === 'paper' && (
              <div className="pointer-events-auto" style={{ width: '100%', height: '100%' }}>
                <DraggableCorners
                  corners={paperCorners}
                  onChange={handleCornersChange}
                  zoom={view.zoom}
                  imageWidth={imageSize.width}
                  imageHeight={imageSize.height}
                />
              </div>
            )}

            {/* Paper Overlay - Static when not in paper step */}
            {paperCorners && currentStep !== 'paper' && (
              <svg
                className="absolute inset-0 pointer-events-none"
                width={imageSize.width * view.zoom}
                height={imageSize.height * view.zoom}
                viewBox={`0 0 ${imageSize.width} ${imageSize.height}`}
                style={{ overflow: 'visible' }}
              >
                <PaperOverlay corners={paperCorners} zoom={view.zoom} />
              </svg>
            )}

            {/* Tool Tracing Overlay - Active when in tools step */}
            {currentStep === 'tools' && (
              <div className="pointer-events-auto" style={{ width: '100%', height: '100%' }}>
                <TracingOverlay
                  outlines={toolOutlines}
                  selectedId={selectedOutlineId}
                  clearancePixels={clearanceValue * (pixelsPerMm || 0)}
                  zoom={view.zoom}
                  imageWidth={imageSize.width}
                  imageHeight={imageSize.height}
                  currentTool={activeTool}
                  isTracing={isTracing}
                  onSelect={selectOutline}
                  onDelete={removeToolOutline}
                  onImageClick={handleTracingClick}
                  onBoxSelect={handleBoxSelect}
                  onUpdateOutline={updateToolOutlineSmoothed}
                />
              </div>
            )}

            {/* Tool Outlines Overlay - Static when not in tools step */}
            {currentStep !== 'tools' && toolOutlines.length > 0 && (
              <svg
                className="absolute inset-0 pointer-events-none"
                width={imageSize.width * view.zoom}
                height={imageSize.height * view.zoom}
                viewBox={`0 0 ${imageSize.width} ${imageSize.height}`}
                style={{ overflow: 'visible' }}
              >
                <ToolOutlinesOverlay
                  outlines={toolOutlines}
                  selectedId={selectedOutlineId}
                  zoom={view.zoom}
                />
              </svg>
            )}
          </div>
        )}
      </div>

      {/* SlimSAM first-load progress (one-time model download) */}
      {samProgress && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2.5 px-4 py-2 rounded-xl tech-glass shadow-lg">
          <div className="w-3.5 h-3.5 rounded-full border-2 border-[hsl(var(--primary))] border-t-transparent animate-spin" />
          <span className="text-[12px] font-medium text-[hsl(var(--foreground))]">
            Getting ready
            {samProgress.progress ? ` — ${Math.round(samProgress.progress)}%` : '…'}
            <span className="text-[hsl(var(--muted-foreground))]"> (one time only)</span>
          </span>
        </div>
      )}

      {/* Image Info Bar */}
      {imageSize && (
        <ImageInfoBar
          imageSize={imageSize}
          fileName={imageFile?.name}
        />
      )}

      {/* Zoom Controls */}
      <ZoomControls
        zoom={view.zoom}
        onZoomIn={() => zoomTo(view.zoom * ZOOM_STEP)}
        onZoomOut={() => zoomTo(view.zoom / ZOOM_STEP)}
        onFit={fitToView}
        onReset={resetView}
      />

      {/* Navigation Hint */}
      <div className="absolute bottom-4 left-4 flex items-center gap-2 text-[10px] text-[hsl(var(--muted-foreground))] bg-[hsl(var(--card))/80] backdrop-blur-sm px-2.5 py-1.5 rounded-md">
        <Move className="w-3 h-3" />
        <span>Scroll to zoom • Ctrl+drag or right-click to pan • F to fit</span>
      </div>
    </div>
  );
};