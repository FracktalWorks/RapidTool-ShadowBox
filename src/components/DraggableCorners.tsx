/**
 * DraggableCorners
 *
 * Interactive corner handles for adjusting paper detection.
 */

import React, { useState, useCallback, useRef, useEffect } from "react";

export interface Point {
  x: number;
  y: number;
}

export interface Corners {
  topLeft: Point;
  topRight: Point;
  bottomRight: Point;
  bottomLeft: Point;
}

interface DraggableCornersProps {
  corners: Corners;
  onChange: (corners: Corners) => void;
  zoom: number;
  imageWidth: number;
  imageHeight: number;
  disabled?: boolean;
}

type CornerKey = "topLeft" | "topRight" | "bottomRight" | "bottomLeft";

const CORNER_LABELS: Record<CornerKey, string> = {
  topLeft: "TL",
  topRight: "TR",
  bottomRight: "BR",
  bottomLeft: "BL",
};

export const DraggableCorners: React.FC<DraggableCornersProps> = ({
  corners,
  onChange,
  zoom,
  imageWidth,
  imageHeight,
  disabled = false,
}) => {
  const [dragging, setDragging] = useState<CornerKey | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);

  // Handle mouse down on corner
  const handleMouseDown = useCallback(
    (e: React.MouseEvent, cornerKey: CornerKey) => {
      if (disabled) return;

      e.preventDefault();
      e.stopPropagation();

      const svg = svgRef.current;
      if (!svg) return;

      // Get the actual rendered dimensions to calculate scale
      const rect = svg.getBoundingClientRect();
      const scaleX = imageWidth / rect.width;
      const scaleY = imageHeight / rect.height;

      const corner = corners[cornerKey];
      setDragging(cornerKey);
      setDragOffset({
        x: e.clientX - corner.x / scaleX,
        y: e.clientY - corner.y / scaleY,
      });
    },
    [corners, imageWidth, imageHeight, disabled],
  );

  // Handle mouse move (global)
  useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const svg = svgRef.current;
      if (!svg) return;

      // Get the actual rendered dimensions to calculate scale
      const rect = svg.getBoundingClientRect();
      const scaleX = imageWidth / rect.width;
      const scaleY = imageHeight / rect.height;

      // Calculate new position in image coordinates
      let newX = (e.clientX - dragOffset.x) * scaleX;
      let newY = (e.clientY - dragOffset.y) * scaleY;

      // Clamp to image bounds with margin
      const margin = 10;
      newX = Math.max(margin, Math.min(imageWidth - margin, newX));
      newY = Math.max(margin, Math.min(imageHeight - margin, newY));

      // Update corners
      onChange({
        ...corners,
        [dragging]: { x: newX, y: newY },
      });
    };

    const handleMouseUp = () => {
      setDragging(null);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging, dragOffset, zoom, imageWidth, imageHeight, corners, onChange]);

  // Create polygon points string
  const polygonPoints = `${corners.topLeft.x},${corners.topLeft.y} ${corners.topRight.x},${corners.topRight.y} ${corners.bottomRight.x},${corners.bottomRight.y} ${corners.bottomLeft.x},${corners.bottomLeft.y}`;

  // Corner handle radius (zoom-compensated)
  const handleRadius = Math.max(8 / zoom, 5);
  const strokeWidth = Math.max(2 / zoom, 1);
  const labelOffset = Math.max(16 / zoom, 10);

  const cornerKeys: CornerKey[] = [
    "topLeft",
    "topRight",
    "bottomRight",
    "bottomLeft",
  ];

  return (
    <svg
      ref={svgRef}
      className="absolute inset-0"
      width={imageWidth * zoom}
      height={imageHeight * zoom}
      viewBox={`0 0 ${imageWidth} ${imageHeight}`}
      style={{ overflow: "visible", pointerEvents: disabled ? "none" : "auto" }}
    >
      {/* Fill */}
      <polygon
        points={polygonPoints}
        style={{ fill: 'hsl(var(--primary) / 0.08)', stroke: 'none', pointerEvents: "none" }}
      />

      {/* Border */}
      <polygon
        points={polygonPoints}
        style={{
          fill: 'none',
          stroke: 'hsl(var(--primary))',
          strokeWidth: strokeWidth,
          strokeDasharray: `${Math.max(8 / zoom, 4)} ${Math.max(4 / zoom, 2)}`,
          pointerEvents: "none",
        }}
      />

      {/* Edge lines (solid for better visibility) */}
      {cornerKeys.map((key, i) => {
        const nextKey = cornerKeys[(i + 1) % 4];
        const p1 = corners[key];
        const p2 = corners[nextKey];

        return (
          <line
            key={`edge-${i}`}
            x1={p1.x}
            y1={p1.y}
            x2={p2.x}
            y2={p2.y}
            style={{ stroke: 'hsl(var(--primary))', strokeWidth, pointerEvents: "none" }}
          />
        );
      })}

      {/* Corner handles */}
      {cornerKeys.map((key) => {
        const corner = corners[key];
        const isDragging = dragging === key;

        return (
          <g key={key}>
            {/* Larger hit area */}
            <circle
              cx={corner.x}
              cy={corner.y}
              r={handleRadius * 2}
              fill="transparent"
              style={{ cursor: disabled ? "default" : "move" }}
              onMouseDown={(e) => handleMouseDown(e, key)}
            />

            {/* Visible handle */}
            <circle
              cx={corner.x}
              cy={corner.y}
              r={isDragging ? handleRadius * 1.3 : handleRadius}
              style={{
                fill: isDragging ? 'hsl(var(--primary) / 0.85)' : 'hsl(var(--primary))',
                stroke: 'white',
                strokeWidth: strokeWidth * 1.5,
                cursor: disabled ? "default" : "move",
                filter: isDragging ? 'drop-shadow(0 0 4px hsl(var(--primary) / 0.5))' : 'none',
              }}
              onMouseDown={(e) => handleMouseDown(e, key)}
            />

            {/* Label */}
            <text        
              x={corner.x + (key.includes("Left") ? -labelOffset : labelOffset)}
              y={corner.y + (key.includes("top") ? -labelOffset : labelOffset)}
              fontSize={Math.max(10 / zoom, 8)}
              fontFamily="monospace"
              fontWeight="600"
              textAnchor="middle"
              dominantBaseline="middle"
              style={{ fill: 'hsl(var(--primary))', pointerEvents: "none", userSelect: "none" }}
            >
              {CORNER_LABELS[key]}
            </text>
          </g>
        );
      })}
    </svg>
  );
};
  
