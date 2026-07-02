/**
 * LayoutWorkspace
 * 
 * Canvas for the "Configure Layout" step where users can:
 * - View and arrange traced tool shapes
 * - Add simple shapes (finger notch, circle, square, rectangle)
 * - Resize shapes using edge handles
 * - Erase/clear shapes
 */

import React, { useRef, useState, useCallback, useMemo, useEffect } from 'react';
import { ZoomIn, ZoomOut, Maximize2, RotateCcw, Move } from 'lucide-react';
import { useAppStore, type LayoutShape } from '../stores';
import { offsetPolygon } from '../lib/geometry';

// ============================================================================
// Constants
// ============================================================================

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.15;
const CANVAS_PADDING = 60;
const HANDLE_SIZE = 8;
const SHAPE_MIN_SIZE_MM = 5;

// ============================================================================
// Types
// ============================================================================

interface ViewState {
  zoom: number;
  panX: number;
  panY: number;
}

type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

// ============================================================================
// Utility Functions
// ============================================================================

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Generate SVG path for a traced tool outline shape
function generateToolShapePath(
  shape: LayoutShape,
  toolOutlines: ReturnType<typeof useAppStore.getState>['toolOutlines'],
  pixelsPerMm: number,
  offsetMm = 0,
): string {
  const outline = toolOutlines.find((o) => o.id === shape.toolOutlineId);
  if (!outline) return '';

  const displayPoints = outline.regularizedPoints ?? outline.smoothedPoints;
  const { boundingBox } = outline;
  const bboxWidth = boundingBox.maxX - boundingBox.minX;
  const bboxHeight = boundingBox.maxY - boundingBox.minY;

  // Scale factor to fit the shape dimensions
  const scaleX = shape.width / (bboxWidth / pixelsPerMm);
  const scaleY = shape.height / (bboxHeight / pixelsPerMm);

  // Translate points to shape position (mm/layout space)
  let pathPoints = displayPoints.map((p) => ({
    x: shape.x + ((p.x - boundingBox.minX) / pixelsPerMm) * scaleX,
    y: shape.y + ((p.y - boundingBox.minY) / pixelsPerMm) * scaleY,
  }));

  // OFFSET (Traces > Offset): grow the pocket outline uniformly so the tool drops
  // in with clearance. True clipper offset (round joins), in mm.
  if (offsetMm) pathPoints = offsetPolygon(pathPoints, offsetMm);

  if (pathPoints.length < 2) return '';
  
  let d = `M ${pathPoints[0].x.toFixed(2)} ${pathPoints[0].y.toFixed(2)}`;
  for (let i = 1; i < pathPoints.length; i++) {
    d += ` L ${pathPoints[i].x.toFixed(2)} ${pathPoints[i].y.toFixed(2)}`;
  }
  return d + ' Z';
}

// Generate path for primitive shapes
function generatePrimitiveShapePath(shape: LayoutShape): string {
  const { x, y, width, height, type } = shape;
  
  switch (type) {
    case 'circle': {
      const cx = x + width / 2;
      const cy = y + height / 2;
      const rx = width / 2;
      const ry = height / 2;
      // Ellipse approximation using bezier curves
      const kappa = 0.5522847498;
      const ox = rx * kappa;
      const oy = ry * kappa;
      return `M ${cx - rx} ${cy}
        C ${cx - rx} ${cy - oy}, ${cx - ox} ${cy - ry}, ${cx} ${cy - ry}
        C ${cx + ox} ${cy - ry}, ${cx + rx} ${cy - oy}, ${cx + rx} ${cy}
        C ${cx + rx} ${cy + oy}, ${cx + ox} ${cy + ry}, ${cx} ${cy + ry}
        C ${cx - ox} ${cy + ry}, ${cx - rx} ${cy + oy}, ${cx - rx} ${cy} Z`;
    }
    case 'square':
    case 'rectangle':
      return `M ${x} ${y} H ${x + width} V ${y + height} H ${x} Z`;
    case 'finger-notch': {
      // Horizontal pill shape with semicircle notches on both sides (thumb & index finger grip)
      const radius = height / 2;
      const leftNotchX = x;
      const rightNotchX = x + width;
      return `M ${leftNotchX + radius} ${y}
        L ${rightNotchX - radius} ${y}
        A ${radius} ${radius} 0 0 1 ${rightNotchX - radius} ${y + height}
        L ${leftNotchX + radius} ${y + height}
        A ${radius} ${radius} 0 0 1 ${leftNotchX + radius} ${y} Z`;
    }
    default:
      return `M ${x} ${y} H ${x + width} V ${y + height} H ${x} Z`;
  }
}

// ============================================================================
// Sub-Components
// ============================================================================

interface LayoutGridOverlayProps {
  gridCols: number;
  gridRows: number;
  cellWidthMm: number;
  cellHeightMm: number;
}

const LayoutGridOverlay: React.FC<LayoutGridOverlayProps> = ({
  gridCols,
  gridRows,
  cellWidthMm,
  cellHeightMm,
}) => {
  const totalWidth = gridCols * cellWidthMm;
  const totalHeight = gridRows * cellHeightMm;
  
  return (
    <g className="layout-grid">
      {/* Main background — fixed LIGHT blueprint canvas (independent of app theme) */}
      <rect
        x={0}
        y={0}
        width={totalWidth}
        height={totalHeight}
        style={{ fill: '#e5e7eb', stroke: 'none' }}
      />

      {/* Dashed border */}
      <rect
        x={0}
        y={0}
        width={totalWidth}
        height={totalHeight}
        style={{ fill: 'none', stroke: '#94a3b8', strokeWidth: 1, strokeDasharray: '6 3' }}
      />

      {/* Grid cell lines */}
      {Array.from({ length: gridCols - 1 }).map((_, i) => (
        <line
          key={`v-${i}`}
          x1={(i + 1) * cellWidthMm}
          y1={0}
          x2={(i + 1) * cellWidthMm}
          y2={totalHeight}
          style={{ stroke: '#cbd5e1', strokeWidth: 0.5 }}
        />
      ))}
      {Array.from({ length: gridRows - 1 }).map((_, i) => (
        <line
          key={`h-${i}`}
          x1={0}
          y1={(i + 1) * cellHeightMm}
          x2={totalWidth}
          y2={(i + 1) * cellHeightMm}
          style={{ stroke: '#cbd5e1', strokeWidth: 0.5 }}
        />
      ))}

      {/* Edge resize handles */}
      <rect x={totalWidth / 2 - 6} y={-4} width={12} height={8} rx={2}
        style={{ fill: '#64748b' }} className="cursor-ns-resize" />
      <rect x={totalWidth / 2 - 6} y={totalHeight - 4} width={12} height={8} rx={2}
        style={{ fill: '#64748b' }} className="cursor-ns-resize" />
      <rect x={-4} y={totalHeight / 2 - 6} width={8} height={12} rx={2}
        style={{ fill: '#64748b' }} className="cursor-ew-resize" />
      <rect x={totalWidth - 4} y={totalHeight / 2 - 6} width={8} height={12} rx={2}
        style={{ fill: '#64748b' }} className="cursor-ew-resize" />
    </g>
  );
};

interface ShapeOverlayProps {
  shape: LayoutShape;
  isSelected: boolean;
  toolOutlines: ReturnType<typeof useAppStore.getState>['toolOutlines'];
  pixelsPerMm: number | null;
  zoom: number;
  onSelect: () => void;
  onDragStart: (e: React.MouseEvent) => void;
  isToolLocked?: boolean;
  offsetMm?: number;
}

const ShapeOverlay: React.FC<ShapeOverlayProps> = ({
  shape,
  isSelected,
  toolOutlines,
  pixelsPerMm,
  zoom,
  onSelect,
  onDragStart,
  isToolLocked = false,
  offsetMm = 0,
}) => {
  const pathData = useMemo(() => {
    if (shape.type === 'tool' && pixelsPerMm) {
      return generateToolShapePath(shape, toolOutlines, pixelsPerMm, offsetMm);
    }
    return generatePrimitiveShapePath(shape);
  }, [shape, toolOutlines, pixelsPerMm, offsetMm]);
  
  const cx = shape.x + shape.width / 2;
  const cy = shape.y + shape.height / 2;

  return (
    <g className="shape-overlay" transform={shape.rotation ? `rotate(${shape.rotation} ${cx} ${cy})` : undefined}>
      <path
        d={pathData}
        style={{
          fill: '#ffffff',
          stroke: isSelected ? '#f59e0b' : '#334155',
          strokeWidth: isSelected ? 2.5 / zoom : 1.5 / zoom,
          cursor: isToolLocked ? 'default' : 'move',
          pointerEvents: isToolLocked ? 'none' : 'auto',
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (!isToolLocked) onSelect();
        }}
        onMouseDown={(e) => {
          if (!isToolLocked) onDragStart(e);
        }}
      />
      
      {/* Selection handles */}
      {isSelected && (
        <g className="selection-handles">
          {/* Bounding box */}
          <rect
            x={shape.x}
            y={shape.y}
            width={shape.width}
            height={shape.height}
            style={{
              fill: 'none',
              stroke: 'hsl(var(--primary))',
              strokeWidth: 1 / zoom,
              strokeDasharray: `${4 / zoom} ${2 / zoom}`,
            }}
            pointerEvents="none"
          />
        </g>
      )}
    </g>
  );
};

interface ResizeHandlesProps {
  shape: LayoutShape;
  zoom: number;
  onResizeStart: (handle: ResizeHandle, e: React.MouseEvent) => void;
}

const ResizeHandles: React.FC<ResizeHandlesProps> = ({ shape, zoom, onResizeStart }) => {
  const { x, y, width, height } = shape;
  const handleSize = HANDLE_SIZE / zoom;
  const halfHandle = handleSize / 2;
  const rcx = x + width / 2, rcy = y + height / 2;

  const handles: { handle: ResizeHandle; cx: number; cy: number; cursor: string }[] = [
    { handle: 'n', cx: x + width / 2, cy: y, cursor: 'ns-resize' },
    { handle: 's', cx: x + width / 2, cy: y + height, cursor: 'ns-resize' },
    { handle: 'e', cx: x + width, cy: y + height / 2, cursor: 'ew-resize' },
    { handle: 'w', cx: x, cy: y + height / 2, cursor: 'ew-resize' },
    { handle: 'nw', cx: x, cy: y, cursor: 'nwse-resize' },
    { handle: 'ne', cx: x + width, cy: y, cursor: 'nesw-resize' },
    { handle: 'sw', cx: x, cy: y + height, cursor: 'nesw-resize' },
    { handle: 'se', cx: x + width, cy: y + height, cursor: 'nwse-resize' },
  ];

  return (
    <g className="resize-handles" transform={shape.rotation ? `rotate(${shape.rotation} ${rcx} ${rcy})` : undefined}>
      {handles.map(({ handle, cx, cy, cursor }) => (
        <rect
          key={handle}
          x={cx - halfHandle}
          y={cy - halfHandle}
          width={handleSize}
          height={handleSize}
          fill="white"
          stroke="hsl(198, 89%, 50%)"
          strokeWidth={1 / zoom}
          style={{ cursor }}
          onMouseDown={(e) => {
            e.stopPropagation();
            onResizeStart(handle, e);
          }}
        />
      ))}
    </g>
  );
};

interface RotationHandleProps {
  shape: LayoutShape;
  zoom: number;
  onRotateStart: (e: React.MouseEvent) => void;
}

/** A rotation knob on a thin line above the shape; drags to spin around centre. */
const RotationHandle: React.FC<RotationHandleProps> = ({ shape, zoom, onRotateStart }) => {
  const cx = shape.x + shape.width / 2;
  const cy = shape.y + shape.height / 2;
  const lineLen = 26 / zoom;
  const knobY = shape.y - lineLen;
  const ch = 6 / zoom; // crosshair half-length
  return (
    <g transform={shape.rotation ? `rotate(${shape.rotation} ${cx} ${cy})` : undefined}>
      {/* centre crosshair (pivot indicator) */}
      <line x1={cx - ch} y1={cy} x2={cx + ch} y2={cy} stroke="#94a3b8" strokeWidth={1 / zoom} />
      <line x1={cx} y1={cy - ch} x2={cx} y2={cy + ch} stroke="#94a3b8" strokeWidth={1 / zoom} />
      {/* knob on a line */}
      <line
        x1={cx} y1={shape.y} x2={cx} y2={knobY}
        stroke="hsl(198, 89%, 50%)" strokeWidth={1.5 / zoom}
      />
      <circle
        cx={cx} cy={knobY} r={5 / zoom}
        fill="white" stroke="hsl(198, 89%, 50%)" strokeWidth={1.5 / zoom}
        style={{ cursor: 'grab' }}
        onMouseDown={(e) => { e.stopPropagation(); onRotateStart(e); }}
      />
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
    <div className="absolute bottom-4 right-4 flex items-center gap-1 bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-lg p-1 shadow-sm">
      <button
        onClick={onZoomOut}
        className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-[hsl(var(--muted))] transition-colors"
        title="Zoom out (−)"
      >
        <ZoomOut className="w-4 h-4" />
      </button>
      <span className="w-14 text-center text-xs font-tech text-[hsl(var(--muted-foreground))]">
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
// Main Component
// ============================================================================

export const LayoutWorkspace: React.FC = () => {
  const {
    layoutState,
    toolOutlines,
    pixelsPerMm,
    selectLayoutShape,
    updateLayoutShape,
    removeLayoutShape,
    addLayoutShape,
    setLayoutTool,
    recenterLayoutShapes,
    clearanceValue,
  } = useAppStore();
  
  const { grid, shapes, selectedShapeId, layoutTool } = layoutState;
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  
  const [view, setView] = useState<ViewState>({ zoom: 1, panX: 0, panY: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [resizeHandle, setResizeHandle] = useState<ResizeHandle | null>(null);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0, shapeX: 0, shapeY: 0 });
  const [resizeStart, setResizeStart] = useState({ x: 0, y: 0, width: 0, height: 0, shapeX: 0, shapeY: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [lastMouse, setLastMouse] = useState({ x: 0, y: 0 });
  // Drawing state for click-and-drag shape creation
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState({ x: 0, y: 0 });
  const [drawingShapeId, setDrawingShapeId] = useState<string | null>(null);
  
  // Calculate layout dimensions
  const layoutWidthMm = grid.cols * grid.cellWidthMm;
  const layoutHeightMm = grid.rows * grid.cellHeightMm;
  
  // Track if we've done the initial recenter
  const hasInitializedRef = useRef(false);
  
  // Initial fit to view and recenter shapes
  useEffect(() => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const availableWidth = rect.width - CANVAS_PADDING * 2;
      const availableHeight = rect.height - CANVAS_PADDING * 2;
      const scaleX = availableWidth / layoutWidthMm;
      const scaleY = availableHeight / layoutHeightMm;
      const scale = Math.min(scaleX, scaleY, 3);
      setView({ zoom: scale, panX: 0, panY: 0 });
      
      // Recenter shapes on first mount to fix alignment
      if (!hasInitializedRef.current && shapes.length > 0) {
        hasInitializedRef.current = true;
        // Small delay to ensure layout is calculated
        requestAnimationFrame(() => {
          recenterLayoutShapes();
        });
      }
    }
  }, [layoutWidthMm, layoutHeightMm, shapes.length, recenterLayoutShapes]);
  
  // Zoom functions
  const zoomTo = useCallback((newZoom: number) => {
    setView((prev) => ({ ...prev, zoom: clamp(newZoom, MIN_ZOOM, MAX_ZOOM) }));
  }, []);
  
  const fitToView = useCallback(() => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const availableWidth = rect.width - CANVAS_PADDING * 2;
      const availableHeight = rect.height - CANVAS_PADDING * 2;
      const scaleX = availableWidth / layoutWidthMm;
      const scaleY = availableHeight / layoutHeightMm;
      const scale = Math.min(scaleX, scaleY, 3);
      setView({ zoom: scale, panX: 0, panY: 0 });
    }
  }, [layoutWidthMm, layoutHeightMm]);
  
  const resetView = useCallback(() => {
    setView({ zoom: 1, panX: 0, panY: 0 });
  }, []);
  
  // Convert screen coordinates to SVG coordinates
  const screenToSvg = useCallback((screenX: number, screenY: number) => {
    if (!containerRef.current) return { x: 0, y: 0 };
    const rect = containerRef.current.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    return {
      x: (screenX - rect.left - centerX - view.panX) / view.zoom + layoutWidthMm / 2,
      y: (screenY - rect.top - centerY - view.panY) / view.zoom + layoutHeightMm / 2,
    };
  }, [view, layoutWidthMm, layoutHeightMm]);
  
  // Handle shape drag start
  const handleDragStart = useCallback((shapeId: string, e: React.MouseEvent) => {
    const shape = shapes.find((s) => s.id === shapeId);
    if (!shape) return;
    
    // Erase mode - delete shape on click
    if (layoutTool === 'erase') {
      // Only allow erasing non-tool shapes (primitives)
      if (shape.type !== 'tool') {
        removeLayoutShape(shapeId);
      }
      return;
    }
    
    // Lock only tool shapes when any shape tool is active (not select)
    // Primitive shapes (circle, square, etc.) can still be moved
    if (layoutTool !== 'select' && shape.type === 'tool') {
      return; // Don't allow dragging tool shapes when in drawing mode
    }
    
    e.preventDefault();
    selectLayoutShape(shapeId);
    setIsDragging(true);
    setDragStart({
      x: e.clientX,
      y: e.clientY,
      shapeX: shape.x,
      shapeY: shape.y,
    });
  }, [shapes, selectLayoutShape, layoutTool, removeLayoutShape]);
  
  // Handle resize start
  const handleResizeStart = useCallback((shapeId: string, handle: ResizeHandle, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    const shape = shapes.find((s) => s.id === shapeId);
    if (!shape) return;
    
    selectLayoutShape(shapeId);
    setIsResizing(true);
    setResizeHandle(handle);
    setResizeStart({
      x: e.clientX,
      y: e.clientY,
      width: shape.width,
      height: shape.height,
      shapeX: shape.x,
      shapeY: shape.y,
    });
  }, [shapes, selectLayoutShape]);

  const handleRotateStart = useCallback((shapeId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    selectLayoutShape(shapeId);
    setIsRotating(true);
  }, [selectLayoutShape]);

  // Handle mouse move
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isPanning) {
      const dx = e.clientX - lastMouse.x;
      const dy = e.clientY - lastMouse.y;
      setView((prev) => ({ ...prev, panX: prev.panX + dx, panY: prev.panY + dy }));
      setLastMouse({ x: e.clientX, y: e.clientY });
      return;
    }
    
    // Handle drawing mode - update shape size as user drags
    if (isDrawing && drawingShapeId) {
      const currentPos = screenToSvg(e.clientX, e.clientY);
      const minX = Math.min(drawStart.x, currentPos.x);
      const minY = Math.min(drawStart.y, currentPos.y);
      const maxX = Math.max(drawStart.x, currentPos.x);
      const maxY = Math.max(drawStart.y, currentPos.y);
      const newWidth = Math.max(SHAPE_MIN_SIZE_MM, maxX - minX);
      const newHeight = Math.max(SHAPE_MIN_SIZE_MM, maxY - minY);
      updateLayoutShape(drawingShapeId, {
        x: Math.max(0, minX),
        y: Math.max(0, minY),
        width: Math.min(newWidth, layoutWidthMm - minX),
        height: Math.min(newHeight, layoutHeightMm - minY),
      });
      return;
    }
    
    if (isDragging && selectedShapeId) {
      const dx = (e.clientX - dragStart.x) / view.zoom;
      const dy = (e.clientY - dragStart.y) / view.zoom;
      const newX = clamp(dragStart.shapeX + dx, 0, layoutWidthMm - shapes.find((s) => s.id === selectedShapeId)!.width);
      const newY = clamp(dragStart.shapeY + dy, 0, layoutHeightMm - shapes.find((s) => s.id === selectedShapeId)!.height);
      updateLayoutShape(selectedShapeId, { x: newX, y: newY });
    }

    if (isRotating && selectedShapeId) {
      const shape = shapes.find((s) => s.id === selectedShapeId);
      if (shape) {
        const cx = shape.x + shape.width / 2;
        const cy = shape.y + shape.height / 2;
        const p = screenToSvg(e.clientX, e.clientY);
        let deg = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI + 90; // knob straight up = 0°
        deg = ((deg % 360) + 360) % 360;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15; // Shift snaps to 15°
        updateLayoutShape(selectedShapeId, { rotation: deg });
      }
      return;
    }

    if (isResizing && selectedShapeId && resizeHandle) {
      const shape = shapes.find((s) => s.id === selectedShapeId);
      if (!shape) return;
      
      const dx = (e.clientX - resizeStart.x) / view.zoom;
      const dy = (e.clientY - resizeStart.y) / view.zoom;
      
      let newX = resizeStart.shapeX;
      let newY = resizeStart.shapeY;
      let newWidth = resizeStart.width;
      let newHeight = resizeStart.height;
      
      // Resize based on handle
      if (resizeHandle.includes('w')) {
        const maxDx = resizeStart.width - SHAPE_MIN_SIZE_MM;
        const actualDx = Math.min(dx, maxDx);
        newX = resizeStart.shapeX + actualDx;
        newWidth = resizeStart.width - actualDx;
      }
      if (resizeHandle.includes('e')) {
        newWidth = Math.max(SHAPE_MIN_SIZE_MM, resizeStart.width + dx);
      }
      if (resizeHandle.includes('n')) {
        const maxDy = resizeStart.height - SHAPE_MIN_SIZE_MM;
        const actualDy = Math.min(dy, maxDy);
        newY = resizeStart.shapeY + actualDy;
        newHeight = resizeStart.height - actualDy;
      }
      if (resizeHandle.includes('s')) {
        newHeight = Math.max(SHAPE_MIN_SIZE_MM, resizeStart.height + dy);
      }
      
      // Clamp to layout bounds
      newX = Math.max(0, newX);
      newY = Math.max(0, newY);
      newWidth = Math.min(newWidth, layoutWidthMm - newX);
      newHeight = Math.min(newHeight, layoutHeightMm - newY);
      
      updateLayoutShape(selectedShapeId, { x: newX, y: newY, width: newWidth, height: newHeight });
    }
  }, [isDragging, isResizing, isRotating, isPanning, isDrawing, drawingShapeId, drawStart, selectedShapeId, dragStart, resizeStart, resizeHandle, view.zoom, shapes, layoutWidthMm, layoutHeightMm, updateLayoutShape, lastMouse, screenToSvg]);
  
  // Handle mouse up
  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    setIsResizing(false);
    setIsRotating(false);
    setResizeHandle(null);
    setIsPanning(false);
    // End drawing mode. After placing a shape, drop back to Select so the shape is
    // immediately manipulable (its resize/rotate handles render only in select mode)
    // and a stray next click doesn't spawn another shape.
    if (isDrawing) {
      setIsDrawing(false);
      setDrawingShapeId(null);
      setLayoutTool('select');
    }
  }, [isDrawing, setLayoutTool]);
  
  // Handle canvas mouse down (start drawing or deselect)
  const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    // Check if clicking on grid background
    const target = e.target as SVGElement;
    const isGridClick = target.tagName === 'rect' && target.closest('.layout-grid');
    
    if (isGridClick || e.target === e.currentTarget) {
      if (layoutTool !== 'select' && layoutTool !== 'erase') {
        // Start drawing a new shape
        e.preventDefault();
        const pos = screenToSvg(e.clientX, e.clientY);
        const shapeId = `shape-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const newShape: LayoutShape = {
          id: shapeId,
          type: layoutTool,
          x: Math.max(0, pos.x),
          y: Math.max(0, pos.y),
          width: SHAPE_MIN_SIZE_MM,
          height: layoutTool === 'finger-notch' ? SHAPE_MIN_SIZE_MM / 2 : SHAPE_MIN_SIZE_MM,
          rotation: 0,
          color: layoutTool === 'finger-notch' ? '#22c55e' : '#3b82f6',
        };
        addLayoutShape(newShape);
        setIsDrawing(true);
        setDrawStart(pos);
        setDrawingShapeId(shapeId);
        selectLayoutShape(shapeId);
      } else if (layoutTool === 'select') {
        selectLayoutShape(null);
      }
    }
  }, [layoutTool, screenToSvg, addLayoutShape, selectLayoutShape]);
  
  // Handle right mouse or Ctrl+drag for panning
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 2 || (e.button === 0 && e.ctrlKey)) {
      e.preventDefault();
      setIsPanning(true);
      setLastMouse({ x: e.clientX, y: e.clientY });
    }
  }, []);

  // Prevent context menu when right-clicking for panning
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);
  
  // Mouse wheel zoom
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
      setView((prev) => ({
        ...prev,
        zoom: clamp(prev.zoom * delta, MIN_ZOOM, MAX_ZOOM),
      }));
    };
    
    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, []);
  
  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      
      switch (e.key) {
        case 'Delete':
        case 'Backspace':
          if (selectedShapeId) {
            const selectedShape = shapes.find(s => s.id === selectedShapeId);
            // Only allow deletion of non-traced tools (manually added shapes)
            if (selectedShape && selectedShape.type !== 'tool' && !selectedShape.toolOutlineId) {
              removeLayoutShape(selectedShapeId);
            }
          }
          break;
        case 'Escape':
          selectLayoutShape(null);
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          fitToView();
          break;
        case '+':
        case '=':
          e.preventDefault();
          zoomTo(view.zoom * ZOOM_STEP);
          break;
        case '-':
          e.preventDefault();
          zoomTo(view.zoom / ZOOM_STEP);
          break;
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedShapeId, shapes, removeLayoutShape, selectLayoutShape, fitToView, zoomTo, view.zoom]);
  
  // Cursor style
  const cursorStyle = useMemo(() => {
    if (isPanning) return 'grabbing';
    if (isDrawing) return 'crosshair';
    if (isDragging) return 'move';
    if (layoutTool === 'erase') return 'crosshair';
    if (layoutTool !== 'select') return 'crosshair';
    return 'default';
  }, [isPanning, isDrawing, isDragging, layoutTool]);
  
  const selectedShape = shapes.find((s) => s.id === selectedShapeId);
  
  return (
    <div
      ref={containerRef}
      className="relative h-full bg-[#fafbfc] overflow-hidden select-none"
      style={{ cursor: cursorStyle }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onContextMenu={handleContextMenu}
      tabIndex={0}
    >
      {/* Checkerboard background (hidden — clean light canvas like the reference) */}
      <div
        className="absolute inset-0 opacity-0"
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
      
      {/* SVG Canvas */}
      <div 
        className="absolute inset-0 flex items-center justify-center"
        style={{ transform: `translate(${view.panX}px, ${view.panY}px)` }}
      >
        <svg
          ref={svgRef}
          width={layoutWidthMm * view.zoom}
          height={layoutHeightMm * view.zoom}
          viewBox={`0 0 ${layoutWidthMm} ${layoutHeightMm}`}
          className="drop-shadow-lg"
          onMouseDown={handleCanvasMouseDown}
        >
          {/* Grid background */}
          <LayoutGridOverlay
            gridCols={grid.cols}
            gridRows={grid.rows}
            cellWidthMm={grid.cellWidthMm}
            cellHeightMm={grid.cellHeightMm}
          />
          
          {/* Shapes */}
          {shapes.map((shape) => (
            <ShapeOverlay
              key={shape.id}
              shape={shape}
              isSelected={shape.id === selectedShapeId}
              toolOutlines={toolOutlines}
              pixelsPerMm={pixelsPerMm}
              zoom={view.zoom}
              onSelect={() => {
                if (layoutTool === 'erase' && shape.type !== 'tool') {
                  removeLayoutShape(shape.id);
                } else if (layoutTool === 'select') {
                  selectLayoutShape(shape.id);
                }
              }}
              onDragStart={(e) => handleDragStart(shape.id, e)}
              isToolLocked={layoutTool !== 'select' && shape.type === 'tool'}
              offsetMm={clearanceValue}
            />
          ))}
          
          {/* Resize + rotation handles for selected shape */}
          {selectedShape && layoutTool === 'select' && (
            <>
              <ResizeHandles
                shape={selectedShape}
                zoom={view.zoom}
                onResizeStart={(handle, e) => handleResizeStart(selectedShape.id, handle, e)}
              />
              <RotationHandle
                shape={selectedShape}
                zoom={view.zoom}
                onRotateStart={(e) => handleRotateStart(selectedShape.id, e)}
              />
            </>
          )}
        </svg>
      </div>
      
      {/* Grid Size Label */}
      <div className="absolute bottom-16 left-1/2 transform -translate-x-1/2 bg-[hsl(var(--card))/90] backdrop-blur-sm px-3 py-1.5 rounded-md text-xs text-[hsl(var(--muted-foreground))] font-tech shadow-sm">
        {grid.cols}×{grid.rows} Grid
      </div>
      
      {/* Layout Info */}
      <div className="absolute top-4 left-4 flex items-center gap-3 bg-[hsl(var(--card))/90] backdrop-blur-sm border border-[hsl(var(--border))] rounded-lg px-3 py-1.5 shadow-sm">
        <span className="text-xs font-tech text-[hsl(var(--muted-foreground))]">
          {layoutWidthMm} × {layoutHeightMm} mm
        </span>
        <div className="w-px h-3 bg-[hsl(var(--border))]" />
        <span className="text-xs text-[hsl(var(--muted-foreground))]">
          {shapes.length} shape{shapes.length !== 1 ? 's' : ''}
        </span>
      </div>
      
      {/* Recenter Button - Top Right (when no active tool indicator) */}
      {layoutTool === 'select' && (
        <button
          onClick={recenterLayoutShapes}
          disabled={shapes.length === 0}
          className="
            absolute top-4 right-4 flex items-center gap-1.5 px-2.5 py-1.5
            bg-[hsl(var(--card))/90] backdrop-blur-sm border border-[hsl(var(--border))]
            rounded-lg shadow-sm hover:bg-[hsl(var(--muted))] transition-colors
            disabled:opacity-50 disabled:cursor-not-allowed
          "
          title="Center shapes in grid"
        >
          <Move className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]" />
          <span className="text-xs">Recenter</span>
        </button>
      )}
      
      {/* Active Tool Indicator */}
      {layoutTool !== 'select' && (
        <div className={`absolute top-4 right-4 flex items-center gap-2 px-3 py-1.5 rounded-lg shadow-sm backdrop-blur-sm border ${
          layoutTool === 'erase' 
            ? 'bg-[hsl(var(--destructive)/0.1)] border-[hsl(var(--destructive)/0.3)] text-[hsl(var(--destructive))]'
            : 'bg-[hsl(var(--primary)/0.1)] border-[hsl(var(--primary)/0.3)] text-[hsl(var(--primary))]'
        }`}>
          <span className="text-xs font-medium capitalize">
            {layoutTool === 'finger-notch' ? 'Finger Notch' : layoutTool} Mode
          </span>
          <span className="text-[10px] opacity-70">Click canvas to add</span>
        </div>
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
        <span>Scroll to zoom • Ctrl+drag or right-click to pan • Delete to remove</span>
      </div>
    </div>
  );
};
