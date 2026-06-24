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
  chaikinSmoothing,
  type ToolOutline,
  type Point2D,
} from '../lib/geometry';

// Decimate a dense contour to a small set of editable anchors (corner-aware via
// RDP). Editing hundreds of Chaikin points is impossible; ~16-40 anchors that
// drive a smooth curve is how vector editors work.
function buildEditAnchors(points: Point2D[]): Point2D[] {
  if (points.length <= 20) return [...points];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY);
  // Adapt epsilon until the anchor count lands in a hand-editable range (~10-24).
  // Too many handles (the old 40 cap) is unwieldy and was a user complaint.
  let eps = diag * 0.02;
  let anchors = simplifyPath(points, eps);
  for (let i = 0; i < 6 && anchors.length > 24; i++) { eps *= 1.4; anchors = simplifyPath(points, eps); }
  for (let i = 0; i < 6 && anchors.length < 10; i++) { eps *= 0.6; anchors = simplifyPath(points, eps); }
  return anchors;
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
  const [editAnchors, setEditAnchors] = useState<{ id: string; points: Point2D[] } | null>(null);

  // (Re)build anchors when entering edit mode or switching selected outline.
  useEffect(() => {
    if (currentTool !== 'edit' || !selectedId) {
      if (editAnchors) setEditAnchors(null);
      return;
    }
    if (editAnchors && editAnchors.id === selectedId) return; // already editing this one
    const outline = outlines.find(o => o.id === selectedId);
    if (outline) {
      const displayPoints = outline.regularizedPoints ?? outline.smoothedPoints;
      setEditAnchors({ id: selectedId, points: buildEditAnchors(displayPoints) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTool, selectedId]);

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
    if (dragPoint && currentTool === 'edit' && onUpdateOutline && editAnchors) {
      const { x, y } = getImageCoords(e);
      const newAnchors = [...editAnchors.points];
      newAnchors[dragPoint.index] = { x, y };
      setEditAnchors({ id: editAnchors.id, points: newAnchors });
      // Reshape a smooth region of the curve through the moved anchor.
      const smoothed = chaikinSmoothing(newAnchors, 3, true);
      onUpdateOutline(editAnchors.id, smoothed);
      return;
    }

    if (!isDrawing || currentTool !== 'box' || !selectionRect) return;
    const { x, y } = getImageCoords(e);
    setSelectionRect(prev => prev ? { ...prev, endX: x, endY: y } : null);
  }, [isDrawing, currentTool, selectionRect, getImageCoords, dragPoint, onUpdateOutline, outlines, editAnchors]);

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
    
    if (currentTool === 'select') {
      onSelect(selectedId === outlineId ? null : outlineId);
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
                
                {/* Sparse control-polygon editing: ~16-40 draggable anchors that
                    drive a smooth curve. Dragging one reshapes a region. */}
                {currentTool === 'edit' && editAnchors && editAnchors.id === outline.id && (
                  <>
                    {/* faint control polygon connecting the anchors */}
                    <polygon
                      points={editAnchors.points.map(p => `${p.x},${p.y}`).join(' ')}
                      fill="none"
                      stroke={outline.color}
                      strokeWidth={strokeWidth}
                      strokeDasharray={`${3 / zoom} ${3 / zoom}`}
                      opacity={0.4}
                      style={{ pointerEvents: 'none' }}
                    />
                    {editAnchors.points.map((point, i) => (
                      <circle
                        key={`anchor-${i}`}
                        cx={point.x}
                        cy={point.y}
                        r={dragPoint?.index === i ? Math.max(5, 9 / zoom) : Math.max(4, 7 / zoom)}
                        fill={dragPoint?.index === i ? outline.color : 'white'}
                        stroke={outline.color}
                        strokeWidth={strokeWidth * 1.5}
                        style={{ cursor: 'grab' }}
                        onMouseDown={(e) => handlePointMouseDown(e, outline.id, i)}
                      />
                    ))}
                  </>
                )}
                
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
