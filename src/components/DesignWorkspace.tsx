/**
 * DesignWorkspace
 * 
 * 3D workspace for the "3D Design" step where users can:
 * - View extruded tool holder design
 * - Adjust depth, wall thickness, and other parameters
 * - Rotate and zoom the 3D model
 */

import React, { useRef, useMemo, useEffect, useLayoutEffect } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import type { ThreeElements } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport } from '@react-three/drei';

// Fixed, capped device pixel ratio — exactly what RapidTool-Fixture uses
// (min(devicePixelRatio, 2)). A fixed DPR renders fewer pixels on hi-DPI screens
// (less lag) WITHOUT switching resolution during interaction, so there's no
// shimmer/jitter while zooming or panning.
const VIEWER_DPR = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2);
import * as THREE from 'three';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import { NavigationHelp } from '@rapidtool/cad-ui';
import { useAppStore, type LayoutShape, type DesignSettings } from '../stores';
import { useTheme } from '../hooks';
import { createGridfinityFeet, createGridfinityLip, unitsFor } from '../lib/gridfinityGeometry';
import { offsetPolygon } from '../lib/geometry';

// Extend JSX.IntrinsicElements for R3F
declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements extends ThreeElements { }
  }
}

// ============================================================================
// Types
// ============================================================================

// Re-export from store for internal use
export type { DesignSettings } from '../stores';

// ============================================================================
// Utility Functions
// ============================================================================

/** Rotate points around (cx,cy) by `deg`. The layout angle is screen-space
 *  (y-down); the 3D build flips Y, so we negate the angle to match. */
function rotatePts(pts: { x: number; y: number }[], cx: number, cy: number, deg: number) {
  if (!deg) return pts;
  const rad = (-deg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  return pts.map((p) => ({
    x: cx + (p.x - cx) * c - (p.y - cy) * s,
    y: cy + (p.x - cx) * s + (p.y - cy) * c,
  }));
}

function createSolidShape(
  shape: LayoutShape,
  layoutWidth: number,
  layoutHeight: number,
  toolOutlines: ReturnType<typeof useAppStore.getState>['toolOutlines'],
  pixelsPerMm: number | null,
  offsetMm = 0,
): THREE.Shape | null {
  const solid = new THREE.Shape();

  // Convert from layout coords (top-left origin) to centered coords
  const centerX = shape.x + shape.width / 2 - layoutWidth / 2;
  const centerY = -(shape.y + shape.height / 2 - layoutHeight / 2); // Flip Y

  if (shape.type === 'tool' && shape.toolOutlineId && pixelsPerMm) {
    const outline = toolOutlines.find(o => o.id === shape.toolOutlineId);
    if (!outline) return null;
    const displayPoints = outline.regularizedPoints ?? outline.smoothedPoints;
    if (displayPoints.length < 3) return null;

    const { boundingBox } = outline;
    const bboxWidth = boundingBox.maxX - boundingBox.minX;
    const bboxHeight = boundingBox.maxY - boundingBox.minY;

    const scaleX = shape.width / (bboxWidth / pixelsPerMm);
    const scaleY = shape.height / (bboxHeight / pixelsPerMm);

    const points = displayPoints.map((p) => ({
      x: centerX + ((p.x - boundingBox.minX) / pixelsPerMm) * scaleX - shape.width / 2,
      y: centerY - ((p.y - boundingBox.minY) / pixelsPerMm) * scaleY + shape.height / 2,
    }));

    if (points.length < 3) return null;

    // We want COUNTER-CLOCKWISE for solid shapes in Three.js
    let signedArea = 0;
    for (let i = 0; i < points.length; i++) {
      const j = (i + 1) % points.length;
      signedArea += points[i].x * points[j].y;
      signedArea -= points[j].x * points[i].y;
    }

    // signedArea > 0 means CCW
    const ordered = signedArea > 0 ? points : [...points].reverse();
    // Apply the layout rotation around the shape centre so the pocket matches.
    const rotated = rotatePts(ordered, centerX, centerY, shape.rotation);
    // OFFSET (Traces > Offset): grow the pocket uniformly for drop-in clearance.
    const orderedPoints = offsetMm ? offsetPolygon(rotated, offsetMm) : rotated;

    solid.moveTo(orderedPoints[0].x, orderedPoints[0].y);
    for (let i = 1; i < orderedPoints.length; i++) {
      solid.lineTo(orderedPoints[i].x, orderedPoints[i].y);
    }
    solid.closePath();
  } else {
    const halfW = shape.width / 2;
    const halfH = shape.height / 2;

    switch (shape.type) {
      case 'circle': {
        // Draw CCW 
        const segments = 32;
        for (let i = 0; i <= segments; i++) {
          const angle = (i / segments) * Math.PI * 2;
          const x = centerX + Math.cos(angle) * halfW;
          const y = centerY + Math.sin(angle) * halfH;
          if (i === 0) solid.moveTo(x, y);
          else solid.lineTo(x, y);
        }
        break;
      }
      case 'finger-notch': {
        // CCW
        const radius = Math.min(halfW, halfH);
        solid.moveTo(centerX - halfW + radius, centerY - halfH);
        solid.lineTo(centerX + halfW - radius, centerY - halfH);
        solid.absarc(centerX + halfW - radius, centerY, halfH, -Math.PI / 2, Math.PI / 2, false);
        solid.lineTo(centerX - halfW + radius, centerY + halfH);
        solid.absarc(centerX - halfW + radius, centerY, halfH, Math.PI / 2, -Math.PI / 2, false);
        solid.closePath();
        break;
      }
      case 'square':
      case 'rectangle':
      default:
        // CCW
        solid.moveTo(centerX - halfW, centerY - halfH);
        solid.lineTo(centerX + halfW, centerY - halfH);
        solid.lineTo(centerX + halfW, centerY + halfH);
        solid.lineTo(centerX - halfW, centerY + halfH);
        solid.closePath();
        break;
    }
  }

  return solid;
}

/**
 * Create solid base plate (bottom of the holder)
 */
function createSolidBasePlate(
  width: number,
  height: number,
  thickness: number,
  chamfer: number
): THREE.ExtrudeGeometry {
  const r = chamfer;

  // Create outer shape with rounded corners
  const baseShape = new THREE.Shape();
  baseShape.moveTo(-width / 2 + r, -height / 2);
  baseShape.lineTo(width / 2 - r, -height / 2);
  baseShape.quadraticCurveTo(width / 2, -height / 2, width / 2, -height / 2 + r);
  baseShape.lineTo(width / 2, height / 2 - r);
  baseShape.quadraticCurveTo(width / 2, height / 2, width / 2 - r, height / 2);
  baseShape.lineTo(-width / 2 + r, height / 2);
  baseShape.quadraticCurveTo(-width / 2, height / 2, -width / 2, height / 2 - r);
  baseShape.lineTo(-width / 2, -height / 2 + r);
  baseShape.quadraticCurveTo(-width / 2, -height / 2, -width / 2 + r, -height / 2);

  return new THREE.ExtrudeGeometry(baseShape, {
    depth: thickness,
    bevelEnabled: true,
    bevelThickness: Math.min(1, thickness / 3),
    bevelSize: Math.min(1, thickness / 3),
    bevelSegments: 2,
  });
}

/**
 * Create walls with inner pocket (the area inside walls where tools go)
 */
function createWallsWithPocket(
  width: number,
  height: number,
  wallThickness: number,
  pocketDepth: number,
  chamfer: number
): THREE.ExtrudeGeometry {
  const r = chamfer;
  const t = wallThickness;

  // Outer boundary with rounded corners
  const wallShape = new THREE.Shape();
  wallShape.moveTo(-width / 2 + r, -height / 2);
  wallShape.lineTo(width / 2 - r, -height / 2);
  wallShape.quadraticCurveTo(width / 2, -height / 2, width / 2, -height / 2 + r);
  wallShape.lineTo(width / 2, height / 2 - r);
  wallShape.quadraticCurveTo(width / 2, height / 2, width / 2 - r, height / 2);
  wallShape.lineTo(-width / 2 + r, height / 2);
  wallShape.quadraticCurveTo(-width / 2, height / 2, -width / 2, height / 2 - r);
  wallShape.lineTo(-width / 2, -height / 2 + r);
  wallShape.quadraticCurveTo(-width / 2, -height / 2, -width / 2 + r, -height / 2);

  // Inner pocket boundary (counter-clockwise for hole)
  const innerW = width / 2 - t;
  const innerH = height / 2 - t;
  const innerR = Math.max(r - t * 0.5, 0.5);

  const pocketHole = new THREE.Path();
  pocketHole.moveTo(-innerW + innerR, -innerH);
  pocketHole.lineTo(innerW - innerR, -innerH);
  pocketHole.quadraticCurveTo(innerW, -innerH, innerW, -innerH + innerR);
  pocketHole.lineTo(innerW, innerH - innerR);
  pocketHole.quadraticCurveTo(innerW, innerH, innerW - innerR, innerH);
  pocketHole.lineTo(-innerW + innerR, innerH);
  pocketHole.quadraticCurveTo(-innerW, innerH, -innerW, innerH - innerR);
  pocketHole.lineTo(-innerW, -innerH + innerR);
  pocketHole.quadraticCurveTo(-innerW, -innerH, -innerW + innerR, -innerH);

  wallShape.holes.push(pocketHole);

  return new THREE.ExtrudeGeometry(wallShape, {
    depth: pocketDepth,
    bevelEnabled: false,
  });
}

/**
 * Create the raised floor inside the pocket (with cutout holes for tools)
 */
function createPocketFloorWithCutouts(
  width: number,
  height: number,
  wallThickness: number,
  floorThickness: number,
  chamfer: number,
  shapes: LayoutShape[],
  toolOutlines: ReturnType<typeof useAppStore.getState>['toolOutlines'],
  pixelsPerMm: number | null,
  offsetMm = 0,
): THREE.BufferGeometry {
  const t = wallThickness;
  const r = Math.max(chamfer - t * 0.5, 0.5);

  // Inner pocket dimensions
  const innerW = width / 2 - t;
  const innerH = height / 2 - t;

  // Create solid inner floor shape
  const floorShape = new THREE.Shape();
  floorShape.moveTo(-innerW + r, -innerH);
  floorShape.lineTo(innerW - r, -innerH);
  floorShape.quadraticCurveTo(innerW, -innerH, innerW, -innerH + r);
  floorShape.lineTo(innerW, innerH - r);
  floorShape.quadraticCurveTo(innerW, innerH, innerW - r, innerH);
  floorShape.lineTo(-innerW + r, innerH);
  floorShape.quadraticCurveTo(-innerW, innerH, -innerW, innerH - r);
  floorShape.lineTo(-innerW, -innerH + r);
  floorShape.quadraticCurveTo(-innerW, -innerH, -innerW + r, -innerH);

  const floorGeometry = new THREE.ExtrudeGeometry(floorShape, {
    depth: floorThickness,
    bevelEnabled: false,
  });

  if (shapes.length === 0) {
    return floorGeometry;
  }

  // Use three-bvh-csg for accurate geometric boolean operations
  const evaluator = new Evaluator();
  evaluator.useGroups = false;

  let resultBrush = new Brush(floorGeometry);
  resultBrush.updateMatrixWorld();

  shapes.forEach((shape) => {
    let cutoutGeometry: THREE.BufferGeometry;

    if (shape.type === 'finger-notch') {
      const halfW = shape.width / 2;
      const halfH = shape.height / 2;
      const centerX = shape.x + shape.width / 2 - width / 2;
      const centerY = -(shape.y + shape.height / 2 - height / 2); // Flip Y

      const radius = Math.min(halfW, halfH);
      const length = Math.max(0, Math.max(shape.width, shape.height) - 2 * radius);

      // Create a capsule geometry
      cutoutGeometry = new THREE.CapsuleGeometry(radius, length, 16, 32);

      // By default CapsuleGeometry is aligned along the Y-axis.
      // If width > height, we rotate it to align along the X-axis.
      if (shape.width >= shape.height) {
        cutoutGeometry.rotateZ(Math.PI / 2);
      }

      // Apply layout rotation (negated to match Y-flip)
      if (shape.rotation) {
        cutoutGeometry.rotateZ((-shape.rotation * Math.PI) / 180);
      }

      // Position the capsule center axis at the top surface of the pocket floor
      cutoutGeometry.translate(centerX, centerY, floorThickness);
    } else {
      const cutoutShape = createSolidShape(shape, width, height, toolOutlines, pixelsPerMm, offsetMm);
      if (!cutoutShape) return;

      cutoutGeometry = new THREE.ExtrudeGeometry(cutoutShape, {
        depth: floorThickness + 2, // Slightly thicker to prevent Z-fighting artifacts
        bevelEnabled: false,
      });

      cutoutGeometry.translate(0, 0, -1); // Move down slightly
    }

    const cutoutBrush = new Brush(cutoutGeometry);
    cutoutBrush.updateMatrixWorld();

    resultBrush = evaluator.evaluate(resultBrush, cutoutBrush, SUBTRACTION);

    cutoutGeometry.dispose();
  });

  return resultBrush.geometry;
}

/**
 * Create Gridfinity-style base with magnet holes
 */
function createGridfinityBase(
  width: number,
  height: number,
  cellSize: number = 42
): THREE.BufferGeometry {
  const magnetRadius = 3.25; // 6.5mm diameter magnets
  const magnetDepth = 2.5;

  const cols = Math.floor(width / cellSize);
  const rows = Math.floor(height / cellSize);

  const positions: number[] = [];
  const indices: number[] = [];

  // Create magnet hole positions at corners of each cell
  for (let col = 0; col <= cols; col++) {
    for (let row = 0; row <= rows; row++) {
      const x = col * cellSize - width / 2;
      const y = row * cellSize - height / 2;

      // Only add if within bounds
      if (Math.abs(x) <= width / 2 - 5 && Math.abs(y) <= height / 2 - 5) {
        // Create cylinder geometry for magnet hole
        const segments = 16;
        const baseIndex = positions.length / 3;

        // Bottom center
        positions.push(x, y, -magnetDepth);

        // Bottom ring
        for (let i = 0; i < segments; i++) {
          const angle = (i / segments) * Math.PI * 2;
          positions.push(
            x + Math.cos(angle) * magnetRadius,
            y + Math.sin(angle) * magnetRadius,
            -magnetDepth
          );
        }

        // Top ring
        for (let i = 0; i < segments; i++) {
          const angle = (i / segments) * Math.PI * 2;
          positions.push(
            x + Math.cos(angle) * magnetRadius,
            y + Math.sin(angle) * magnetRadius,
            0
          );
        }

        // Bottom cap triangles
        for (let i = 0; i < segments; i++) {
          indices.push(
            baseIndex,
            baseIndex + 1 + i,
            baseIndex + 1 + ((i + 1) % segments)
          );
        }

        // Side triangles
        for (let i = 0; i < segments; i++) {
          const b1 = baseIndex + 1 + i;
          const b2 = baseIndex + 1 + ((i + 1) % segments);
          const t1 = baseIndex + 1 + segments + i;
          const t2 = baseIndex + 1 + segments + ((i + 1) % segments);
          indices.push(b1, t1, b2);
          indices.push(b2, t1, t2);
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return geometry;
}

// ============================================================================
// 3D Components
// ============================================================================

interface ToolHolderMeshProps {
  layoutState: ReturnType<typeof useAppStore.getState>['layoutState'];
  toolOutlines: ReturnType<typeof useAppStore.getState>['toolOutlines'];
  pixelsPerMm: number | null;
  settings: DesignSettings;
}

const ToolHolderMesh: React.FC<ToolHolderMeshProps> = ({
  layoutState,
  toolOutlines,
  pixelsPerMm,
  settings,
}) => {
  const { grid, shapes } = layoutState;
  const clearanceValue = useAppStore((s) => s.clearanceValue);
  const meshRef = useRef<THREE.Group>(null);

  // Calculate layout dimensions in mm
  const layoutWidth = grid.cols * grid.cellWidthMm;
  const layoutHeight = grid.rows * grid.cellHeightMm;

  // Create solid base plate (bottom of the holder - always solid, no holes)
  const basePlateGeometry = useMemo(() => {
    return createSolidBasePlate(
      layoutWidth,
      layoutHeight,
      settings.baseHeight,
      settings.chamferSize
    );
  }, [layoutWidth, layoutHeight, settings.baseHeight, settings.chamferSize]);

  // Create walls around the perimeter with inner pocket (on top of base plate)
  const wallsGeometry = useMemo(() => {
    return createWallsWithPocket(
      layoutWidth,
      layoutHeight,
      settings.wallThickness,
      settings.cutoutDepth,
      settings.chamferSize
    );
  }, [layoutWidth, layoutHeight, settings.wallThickness, settings.cutoutDepth, settings.chamferSize]);

  // Create raised floor inside pocket with tool cutout holes
  const pocketFloorGeometry = useMemo(() => {
    // This is the "raised floor" inside the walls that has the tool cutouts
    // It sits on top of the base plate, inside the walls
    const raisedFloorHeight = settings.cutoutDepth - settings.baseHeight;
    if (raisedFloorHeight <= 0) return null;

    return createPocketFloorWithCutouts(
      layoutWidth,
      layoutHeight,
      settings.wallThickness,
      raisedFloorHeight,
      settings.chamferSize,
      shapes,
      toolOutlines,
      pixelsPerMm,
      clearanceValue,
    );
  }, [layoutWidth, layoutHeight, settings.wallThickness, settings.cutoutDepth, settings.baseHeight, settings.chamferSize, shapes, toolOutlines, pixelsPerMm, clearanceValue]);

  // Gridfinity magnet-hole placeholder (legacy) - punches into bottom of base plate
  const gridfinityGeometry = useMemo(() => {
    if (!settings.gridfinityBase) return null;
    return createGridfinityBase(layoutWidth, layoutHeight, grid.cellWidthMm);
  }, [layoutWidth, layoutHeight, grid.cellWidthMm, settings.gridfinityBase]);

  // Real Gridfinity INTERLOCKING FEET — the stair-step profile that seats into a
  // baseplate. Tiled one per 42mm cell, hanging below the base plate (z<0).
  const feetGeometry = useMemo(() => {
    if (!settings.gridfinityBase) return null;
    return createGridfinityFeet(unitsFor(layoutWidth), unitsFor(layoutHeight));
  }, [layoutWidth, layoutHeight, settings.gridfinityBase]);

  // Stacking lip on the top rim (so a bin stacks on this one).
  const lipGeometry = useMemo(() => {
    if (!settings.gridfinityBase) return null;
    return createGridfinityLip(layoutWidth, layoutHeight, settings.wallThickness, settings.chamferSize);
  }, [layoutWidth, layoutHeight, settings.wallThickness, settings.chamferSize, settings.gridfinityBase]);

  // Dynamic materials based on materialPreset ('eva-foam' | 'charcoal' | 'sky-blue' | 'orange')
  const { holderMaterial, basePlateMaterial, gridfinityMaterial } = useMemo(() => {
    const preset = settings.materialPreset || 'eva-foam';
    let holderColor = 0x1e293b; // Default EVA top: dark slate
    let baseColor = 0xf97316;   // Default EVA bottom: brand orange
    let holderRoughness = 0.6;
    let holderMetalness = 0.05;
    let baseRoughness = 0.4;
    let baseMetalness = 0.1;

    if (preset === 'charcoal') {
      holderColor = 0x27272a;
      baseColor = 0x0f172a;
      holderRoughness = 0.5;
      baseRoughness = 0.6;
    } else if (preset === 'sky-blue') {
      holderColor = 0x0ea5e9;
      baseColor = 0x1e293b;
      holderRoughness = 0.4;
      baseRoughness = 0.5;
      baseMetalness = 0.2;
    } else if (preset === 'orange') {
      holderColor = 0xf97316;
      baseColor = 0x27272a;
      holderRoughness = 0.4;
      baseRoughness = 0.5;
      baseMetalness = 0.2;
    }

    return {
      holderMaterial: new THREE.MeshStandardMaterial({
        color: holderColor,
        roughness: holderRoughness,
        metalness: holderMetalness,
        side: THREE.FrontSide,
      }),
      basePlateMaterial: new THREE.MeshStandardMaterial({
        color: baseColor,
        roughness: baseRoughness,
        metalness: baseMetalness,
        side: THREE.FrontSide,
      }),
      gridfinityMaterial: new THREE.MeshStandardMaterial({
        color: preset === 'charcoal' ? 0x090d16 : 0x0f172a,
        roughness: 0.6,
        metalness: 0.1,
        side: THREE.DoubleSide,
      }),
    };
  }, [settings.materialPreset]);

  // Rest the whole assembly ON the bed: the Gridfinity feet hang below z=0, so
  // after rotation they'd dip under the grid. Lift the group by its lowest point
  // (world min-Y) so the feet sit on the grid plane instead of poking through it.
  useLayoutEffect(() => {
    const g = meshRef.current;
    if (!g) return;
    g.position.y = 0;
    g.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(g);
    if (Number.isFinite(box.min.y)) {
      g.position.y = -box.min.y;
      g.updateMatrixWorld(true);
    }
  }, [basePlateGeometry, wallsGeometry, pocketFloorGeometry, feetGeometry, lipGeometry]);

  return (
    <group ref={meshRef} rotation={[-Math.PI / 2, 0, 0]}>
      {/* Solid base plate (bottom - always solid) */}
      <mesh geometry={basePlateGeometry} material={basePlateMaterial} />

      {/* Walls with inner pocket - sits on top of base plate */}
      <mesh
        geometry={wallsGeometry}
        material={holderMaterial}
        position={[0, 0, settings.baseHeight]}
      />

      {/* Raised floor inside pocket with tool cutout holes */}
      {pocketFloorGeometry && (
        <mesh
          geometry={pocketFloorGeometry}
          material={holderMaterial}
          position={[0, 0, settings.baseHeight]}
        />
      )}

      {/* Gridfinity interlocking feet - stair-step profile, hangs below base plate */}
      {feetGeometry && (
        <mesh
          geometry={feetGeometry}
          material={gridfinityMaterial}
          position={[0, 0, 0]}
        />
      )}

      {/* Gridfinity stacking lip - chamfered rim on the top of the walls */}
      {lipGeometry && (
        <mesh
          geometry={lipGeometry}
          material={holderMaterial}
          position={[0, 0, settings.baseHeight + settings.cutoutDepth]}
        />
      )}
    </group>
  );
};

interface SceneProps {
  layoutState: ReturnType<typeof useAppStore.getState>['layoutState'];
  toolOutlines: ReturnType<typeof useAppStore.getState>['toolOutlines'];
  pixelsPerMm: number | null;
  settings: DesignSettings;
  onControlsReady: (controls: any) => void;
}

// Grid sizing — mirrors RapidTool-Fixture's calculateGridConfig (geometryUtils.ts).
function calculateGridConfig(maxExtent: number) {
  const rawSize = maxExtent * 2 * 1.2;
  const niceValues = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
  let gridSize = niceValues[0];
  for (const val of niceValues) { if (val >= rawSize) { gridSize = val; break; } gridSize = val; }
  const cellSizes = [1, 5, 10, 25, 50, 100, 250, 500];
  let cellSize = 10;
  for (const cs of cellSizes) { if (gridSize / cs <= 50) { cellSize = cs; break; } cellSize = cs; }
  const divisions = Math.floor(gridSize / cellSize);
  const majorDivisions = cellSize >= 100 ? 1 : (cellSize >= 25 ? 4 : 10);
  return { size: gridSize, divisions, majorDivisions, cellSize };
}

// Ground grid identical to Fixture's ScalableGrid: minor + major gridHelpers
// (dark-mode aware) plus red-X / green-Z axis lines through the origin.
const FixtureGrid: React.FC<{ maxExtent: number; isDark: boolean }> = ({ maxExtent, isDark }) => {
  const cfg = useMemo(() => calculateGridConfig(maxExtent), [maxExtent]);
  const xAxis = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-cfg.size / 2, 0.01, 0, cfg.size / 2, 0.01, 0]), 3));
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xff4444 }));
  }, [cfg.size]);
  const zAxis = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0.01, -cfg.size / 2, 0, 0.01, cfg.size / 2]), 3));
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x44ff44 }));
  }, [cfg.size]);
  return (
    <group position={[0, -0.01, 0]} frustumCulled={false}>
      <gridHelper args={[cfg.size, cfg.divisions, isDark ? '#3a3a4a' : '#d0d0d0', isDark ? '#2a2a3a' : '#e8e8e8']} />
      <gridHelper args={[cfg.size, Math.floor(cfg.divisions / cfg.majorDivisions), isDark ? '#4a4a5a' : '#a0a0a0', isDark ? '#4a4a5a' : '#a0a0a0']} position={[0, 0.001, 0]} />
      <primitive object={xAxis} />
      <primitive object={zAxis} />
    </group>
  );
};

// Lighting identical to Fixture's SceneLighting (renderers/SceneLighting.tsx).
const SceneLighting: React.FC = () => (
  <>
    <ambientLight intensity={0.5} />
    <directionalLight position={[10, 10, 5]} intensity={1.0} castShadow />
    <directionalLight position={[-10, -10, -5]} intensity={0.5} />
    <directionalLight position={[5, 15, -5]} intensity={0.6} />
    <hemisphereLight args={['#ffffff', '#444444', 0.6]} />
  </>
);

const Scene: React.FC<SceneProps & { isDarkMode: boolean }> = ({ layoutState, toolOutlines, pixelsPerMm, settings, onControlsReady, isDarkMode }) => {
  const { camera } = useThree();
  const regress = useThree((s) => s.performance.regress); // drop quality while interacting
  const controlsRef = useRef<any>(null);

  // Calculate layout dimensions for camera positioning
  const layoutWidth = layoutState.grid.cols * layoutState.grid.cellWidthMm;
  const layoutHeight = layoutState.grid.rows * layoutState.grid.cellHeightMm;
  const maxDim = Math.max(layoutWidth, layoutHeight);

  // Set initial camera position
  useEffect(() => {
    if (camera) {
      camera.position.set(maxDim * 0.8, maxDim * 0.8, maxDim * 0.8);
      camera.lookAt(0, 0, 0);
    }
  }, [camera, maxDim]);

  // Expose controls to parent when mounted
  const handleControlsRef = (controls: any) => {
    controlsRef.current = controls;
    if (controls) {
      onControlsReady(controls);
    }
  };

  // Snap the camera to a named orientation. Driven by the header view buttons and
  // the ViewCube — both dispatch 'viewer-orientation'; 'viewer-reset' re-centres.
  useEffect(() => {
    const dist = Math.max(maxDim, 1) * 1.6;
    const dirs: Record<string, [number, number, number]> = {
      front: [0, 0, 1], back: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0],
      top: [0, 1, 0], bottom: [0, -1, 0],
      iso: [1, 0.85, 1], isometric: [1, 0.85, 1],
    };
    const applyOrientation = (o: string) => {
      const d = dirs[o] ?? dirs.iso;
      const v = new THREE.Vector3(d[0], d[1], d[2]).normalize().multiplyScalar(dist);
      camera.position.set(v.x, v.y, v.z);
      camera.lookAt(0, 0, 0);
      const c = controlsRef.current;
      if (c) { c.target.set(0, 0, 0); c.update(); }
    };
    const onOrient = (e: Event) => applyOrientation((e as CustomEvent<string>).detail);
    const onReset = () => controlsRef.current?.reset?.();
    window.addEventListener('viewer-orientation', onOrient as EventListener);
    window.addEventListener('viewer-reset', onReset);
    return () => {
      window.removeEventListener('viewer-orientation', onOrient as EventListener);
      window.removeEventListener('viewer-reset', onReset);
    };
  }, [camera, maxDim]);

  return (
    <>
      {/* Background — matches Fixture's viewer (dark #1a1a2e / light #ffffff) */}
      <color attach="background" args={[isDarkMode ? '#1a1a2e' : '#ffffff']} />

      {/* Lighting (identical to Fixture's SceneLighting) */}
      <SceneLighting />

      {/* Tool Holder Mesh */}
      <ToolHolderMesh
        layoutState={layoutState}
        toolOutlines={toolOutlines}
        pixelsPerMm={pixelsPerMm}
        settings={settings}
      />

      {/* Ground grid (identical to Fixture's ScalableGrid) */}
      <FixtureGrid maxExtent={maxDim / 2} isDark={isDarkMode} />

      {/* Orbit Controls — onChange regresses quality so AdaptiveDpr lowers the
          resolution while orbiting/zooming, then restores it when the camera settles. */}
      <OrbitControls
        ref={handleControlsRef}
        makeDefault
        enableDamping
        dampingFactor={0.05}
        minDistance={20}
        maxDistance={500}
        maxPolarAngle={Math.PI / 2 + 0.1}
        onChange={() => regress()}
      />

      {/* Axis-triad gizmo — same config as RapidTool-Fixture (3DScene.tsx) */}
      <GizmoHelper alignment="top-right" margin={[80, 80]}>
        <GizmoViewport axisColors={['#ff4060', '#40ff60', '#4080ff']} labels={['X', 'Z', 'Y']} labelColor="white" />
      </GizmoHelper>
    </>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const DesignWorkspace: React.FC = () => {
  const {
    layoutState,
    toolOutlines,
    pixelsPerMm,
    designSettings,
  } = useAppStore();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controlsRef = useRef<any>(null);
  const { theme } = useTheme();
  const isDarkMode = theme === 'dark';

  const handleControlsReady = (controls: any) => {
    controlsRef.current = controls;
  };

  const { grid } = layoutState;

  return (
    <div className="relative h-full w-full bg-[hsl(var(--workspace-bg))]">
      {/* Three.js Canvas */}
      <Canvas
        ref={canvasRef}
        // Cap DPR (Fixture does min(dpr, 2)) — full device pixel ratio on hi-DPI
        // screens is the main cause of laggy orbit on a heavy CSG mesh.
        dpr={VIEWER_DPR}
        camera={{
          fov: 45,
          near: 0.1,
          far: 2000,
          position: [150, 150, 150],
        }}
        gl={{
          antialias: true,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1,
          powerPreference: 'high-performance',
          // Don't fail if the browser flags a perf caveat (WebGPU SOD/SAM may be
          // holding the high-perf GPU) — fall back rather than refuse a context.
          failIfMajorPerformanceCaveat: false,
        }}
        onCreated={({ gl }) => {
          // WebGPU (SOD/SAM) + WebGL (this view) can contend for the GPU and the
          // browser may drop this context. preventDefault on 'lost' lets the
          // browser RESTORE it (R3F then rebuilds resources) instead of going blank.
          const canvas = gl.domElement;
          canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); }, false);
          canvas.addEventListener('webglcontextrestored', () => { gl.setClearColor(0x000000, 0); }, false);
        }}
      >
        <Scene
          layoutState={layoutState}
          toolOutlines={toolOutlines}
          pixelsPerMm={pixelsPerMm}
          settings={designSettings}
          onControlsReady={handleControlsReady}
          isDarkMode={isDarkMode}
        />
      </Canvas>

      {/* Navigation help (shared cad-ui overlay, same as Fixture) */}
      <NavigationHelp storageKey="fixture-view-nav-tooltip-dismissed" />

    </div>
  );
};
