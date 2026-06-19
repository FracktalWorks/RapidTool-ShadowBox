/**
 * ExportWorkspace
 * 
 * Export preview workspace for the "Export" step where users can:
 * - Preview STL (3D) or SVG (2D) export
 * - See export summary and dimensions
 * - Download the final export
 */

import React, { useRef, useMemo, useEffect, useCallback, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import type { ThreeElements } from '@react-three/fiber';
import { OrbitControls, Grid, Environment } from '@react-three/drei';
import * as THREE from 'three';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import { STLExporter } from 'three-stdlib';
import { useAppStore, type LayoutShape, type DesignSettings } from '../stores';
import { createGridfinityFeet, createGridfinityLip, unitsFor } from '../lib/gridfinityGeometry';
import { offsetPolygon } from '../lib/geometry';
import { Download, FileCode, Box, RotateCcw, Layers, AlertCircle } from 'lucide-react';
import { downloadSVG } from '../lib/exportSVG';

// Extend JSX.IntrinsicElements for R3F
declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements extends ThreeElements { }
  }
}

// ============================================================================
// Utility Functions (shared with DesignWorkspace)
// ============================================================================

/** Rotate points around (cx,cy) by `deg` (negated to match the Y-flipped build). */
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
    // Apply layout rotation + Offset clearance so the export matches the preview.
    const rotated = rotatePts(ordered, centerX, centerY, shape.rotation);
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
 * Create solid base plate
 */
function createSolidBasePlate(
  width: number,
  height: number,
  thickness: number,
  chamfer: number
): THREE.ExtrudeGeometry {
  const r = chamfer;
  
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
 * Create walls with inner pocket
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

// ============================================================================
// 3D Export Mesh Generation
// ============================================================================

/**
 * Build a print-ready, watertight STL blob from an export mesh.
 *
 * The mesh is the union of several extruded parts (base, walls, pocket floor with
 * CSG cutouts, Gridfinity feet/lip). That raw boolean output can have coincident
 * faces / open seams that make slicers complain. We run it through Manifold3D
 * (cad-core) to guarantee a single closed, manifold solid before serialising —
 * the contract for a clean Gridfinity print. Falls back to the raw geometry only
 * if the repair can't run, so an export never fails outright.
 */
export async function buildManifoldStlBlob(mesh: THREE.Mesh): Promise<Blob> {
  let geometry: THREE.BufferGeometry = mesh.geometry;
  try {
    // Lazy-load Manifold3D only at export time. Importing it at module scope pulls
    // its WASM into the initial graph and makes Vite re-optimize deps mid-session,
    // which drops the dev server's worker connections. On-demand keeps startup clean.
    const { repairMeshWithManifold } = await import('@rapidtool/cad-core');
    const result = await repairMeshWithManifold(geometry);
    if (result.success && result.geometry) geometry = result.geometry;
    else console.warn('Manifold repair did not return geometry; exporting raw mesh.');
  } catch (err) {
    console.warn('Manifold repair unavailable; exporting raw mesh:', err);
  }

  const exporter = new STLExporter();
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry));
  const stlData = exporter.parse(scene, { binary: true });

  const arrayBuffer = new ArrayBuffer(stlData.byteLength);
  new Uint8Array(arrayBuffer).set(new Uint8Array(stlData.buffer, stlData.byteOffset, stlData.byteLength));
  if (geometry !== mesh.geometry) geometry.dispose();
  return new Blob([arrayBuffer], { type: 'application/sla' });
}

/**
 * Generate a combined mesh for STL export
 */
export function generateExportMesh(
  layoutState: ReturnType<typeof useAppStore.getState>['layoutState'],
  toolOutlines: ReturnType<typeof useAppStore.getState>['toolOutlines'],
  pixelsPerMm: number | null,
  settings: DesignSettings,
  offsetMm = 0,
): THREE.Mesh {
  const { grid, shapes } = layoutState;
  
  const layoutWidth = grid.cols * grid.cellWidthMm;
  const layoutHeight = grid.rows * grid.cellHeightMm;
  
  // Create all geometries
  const basePlateGeometry = createSolidBasePlate(
    layoutWidth,
    layoutHeight,
    settings.baseHeight,
    settings.chamferSize
  );
  
  const wallsGeometry = createWallsWithPocket(
    layoutWidth,
    layoutHeight,
    settings.wallThickness,
    settings.cutoutDepth,
    settings.chamferSize
  );
  
  const raisedFloorHeight = settings.cutoutDepth - settings.baseHeight;
  const pocketFloorGeometry = raisedFloorHeight > 0 
    ? createPocketFloorWithCutouts(
        layoutWidth,
        layoutHeight,
        settings.wallThickness,
        raisedFloorHeight,
        settings.chamferSize,
        shapes,
        toolOutlines,
        pixelsPerMm,
        offsetMm,
      )
    : null;

  // Create a group and merge all geometries
  const mergedGeometry = new THREE.BufferGeometry();
  const geometries: THREE.BufferGeometry[] = [];
  
  // Position base plate
  const baseMatrix = new THREE.Matrix4();
  baseMatrix.makeRotationX(-Math.PI / 2);
  basePlateGeometry.applyMatrix4(baseMatrix);
  geometries.push(basePlateGeometry);
  
  // Position walls on top of base plate
  const wallsMatrix = new THREE.Matrix4();
  wallsMatrix.makeRotationX(-Math.PI / 2);
  wallsMatrix.setPosition(0, settings.baseHeight, 0);
  wallsGeometry.applyMatrix4(wallsMatrix);
  geometries.push(wallsGeometry);
  
  // Position pocket floor
  if (pocketFloorGeometry) {
    const floorMatrix = new THREE.Matrix4();
    floorMatrix.makeRotationX(-Math.PI / 2);
    floorMatrix.setPosition(0, settings.baseHeight, 0);
    pocketFloorGeometry.applyMatrix4(floorMatrix);
    geometries.push(pocketFloorGeometry);
  }

  // Gridfinity interlocking feet — hang below the base plate so the printed bin
  // seats into a baseplate. Same -90° X rotation as the rest of the assembly.
  if (settings.gridfinityBase) {
    const feet = createGridfinityFeet(unitsFor(layoutWidth), unitsFor(layoutHeight));
    const feetMatrix = new THREE.Matrix4();
    feetMatrix.makeRotationX(-Math.PI / 2);
    feet.applyMatrix4(feetMatrix);
    geometries.push(feet);

    // Stacking lip on the top rim (z-offset = baseHeight + cutoutDepth).
    const lip = createGridfinityLip(layoutWidth, layoutHeight, settings.wallThickness, settings.chamferSize);
    const lipMatrix = new THREE.Matrix4();
    lipMatrix.makeRotationX(-Math.PI / 2);
    lipMatrix.setPosition(0, settings.baseHeight + settings.cutoutDepth, 0);
    lip.applyMatrix4(lipMatrix);
    geometries.push(lip);
  }
  
  // Merge geometries using BufferGeometryUtils approach
  const mergedGeo = mergeBufferGeometries(geometries);
  
  // Create mesh with basic material
  const material = new THREE.MeshStandardMaterial({
    color: 0x707070,
    roughness: 0.5,
    metalness: 0.1,
  });
  
  return new THREE.Mesh(mergedGeo, material);
}

/**
 * Simple buffer geometry merge (combines all geometries into one)
 */
function mergeBufferGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const mergedGeometry = new THREE.BufferGeometry();
  
  let totalVertices = 0;
  let totalIndices = 0;
  
  // Count total vertices and indices
  for (const geo of geometries) {
    const pos = geo.getAttribute('position');
    totalVertices += pos.count;
    
    const index = geo.getIndex();
    if (index) {
      totalIndices += index.count;
    } else {
      totalIndices += pos.count;
    }
  }
  
  // Create merged arrays
  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  const indices = new Uint32Array(totalIndices);
  
  let vertexOffset = 0;
  let indexOffset = 0;
  let vertexCount = 0;
  
  for (const geo of geometries) {
    const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
    const normalAttr = geo.getAttribute('normal') as THREE.BufferAttribute;
    
    // Copy positions
    for (let i = 0; i < posAttr.count; i++) {
      positions[(vertexOffset + i) * 3] = posAttr.getX(i);
      positions[(vertexOffset + i) * 3 + 1] = posAttr.getY(i);
      positions[(vertexOffset + i) * 3 + 2] = posAttr.getZ(i);
    }
    
    // Copy normals
    if (normalAttr) {
      for (let i = 0; i < normalAttr.count; i++) {
        normals[(vertexOffset + i) * 3] = normalAttr.getX(i);
        normals[(vertexOffset + i) * 3 + 1] = normalAttr.getY(i);
        normals[(vertexOffset + i) * 3 + 2] = normalAttr.getZ(i);
      }
    }
    
    // Copy indices (offset by vertex count)
    const geoIndex = geo.getIndex();
    if (geoIndex) {
      for (let i = 0; i < geoIndex.count; i++) {
        indices[indexOffset + i] = geoIndex.getX(i) + vertexCount;
      }
      indexOffset += geoIndex.count;
    } else {
      for (let i = 0; i < posAttr.count; i++) {
        indices[indexOffset + i] = vertexCount + i;
      }
      indexOffset += posAttr.count;
    }
    
    vertexOffset += posAttr.count;
    vertexCount += posAttr.count;
  }
  
  mergedGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  mergedGeometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  mergedGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
  
  return mergedGeometry;
}

// ============================================================================
// 3D Preview Component
// ============================================================================

interface ExportMeshPreviewProps {
  layoutState: ReturnType<typeof useAppStore.getState>['layoutState'];
  toolOutlines: ReturnType<typeof useAppStore.getState>['toolOutlines'];
  pixelsPerMm: number | null;
  settings: DesignSettings;
}

const ExportMeshPreview: React.FC<ExportMeshPreviewProps> = ({
  layoutState,
  toolOutlines,
  pixelsPerMm,
  settings,
}) => {
  const { grid, shapes } = layoutState;
  const meshRef = useRef<THREE.Group>(null);
  
  const layoutWidth = grid.cols * grid.cellWidthMm;
  const layoutHeight = grid.rows * grid.cellHeightMm;
  
  // Create geometries
  const basePlateGeometry = useMemo(() => {
    return createSolidBasePlate(
      layoutWidth,
      layoutHeight,
      settings.baseHeight,
      settings.chamferSize
    );
  }, [layoutWidth, layoutHeight, settings.baseHeight, settings.chamferSize]);
  
  const wallsGeometry = useMemo(() => {
    return createWallsWithPocket(
      layoutWidth,
      layoutHeight,
      settings.wallThickness,
      settings.cutoutDepth,
      settings.chamferSize
    );
  }, [layoutWidth, layoutHeight, settings.wallThickness, settings.cutoutDepth, settings.chamferSize]);
  
  const pocketFloorGeometry = useMemo(() => {
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
      pixelsPerMm
    );
  }, [layoutWidth, layoutHeight, settings.wallThickness, settings.cutoutDepth, settings.baseHeight, settings.chamferSize, shapes, toolOutlines, pixelsPerMm]);
  
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

  // Materials (Premium RapidTool Sky Blue)
  const holderMaterial = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      color: 0x0ea5e9, // Brand Sky Blue
      roughness: 0.4,
      metalness: 0.1,
      side: THREE.FrontSide,
    });
  }, []);

  const basePlateMaterial = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      color: 0x1e293b, // Dark slate
      roughness: 0.5,
      metalness: 0.2,
      side: THREE.FrontSide,
    });
  }, []);

  const gridfinityMaterial = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      color: 0x0f172a, // Deep slate
      roughness: 0.6,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });
  }, []);
  
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

interface Scene3DProps {
  layoutState: ReturnType<typeof useAppStore.getState>['layoutState'];
  toolOutlines: ReturnType<typeof useAppStore.getState>['toolOutlines'];
  pixelsPerMm: number | null;
  settings: DesignSettings;
  onControlsReady: (controls: any) => void;
}

const Scene3D: React.FC<Scene3DProps> = ({ layoutState, toolOutlines, pixelsPerMm, settings, onControlsReady }) => {
  const { camera } = useThree();
  const controlsRef = useRef<any>(null);
  
  // Calculate layout dimensions for camera positioning (same as DesignWorkspace)
  const layoutWidth = layoutState.grid.cols * layoutState.grid.cellWidthMm;
  const layoutHeight = layoutState.grid.rows * layoutState.grid.cellHeightMm;
  const maxDim = Math.max(layoutWidth, layoutHeight);
  
  // Set initial camera position (matching DesignWorkspace)
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
  
  return (
    <>
      {/* Lighting */}
      <ambientLight intensity={0.4} />
      <directionalLight position={[50, 100, 50]} intensity={1} castShadow />
      <directionalLight position={[-50, 50, -50]} intensity={0.3} />
      
      {/* Environment */}
      <Environment preset="studio" background={false} />
      
      {/* Grid */}
      <Grid
        args={[200, 200]}
        cellSize={10}
        cellThickness={0.5}
        cellColor="#4a5568"
        sectionSize={50}
        sectionThickness={1}
        sectionColor="#2d3748"
        fadeDistance={200}
        fadeStrength={1}
        followCamera={false}
        infiniteGrid
      />
      
      {/* Orbit Controls */}
      <OrbitControls
        ref={handleControlsRef}
        makeDefault
        enableDamping
        dampingFactor={0.05}
        minDistance={20}
        maxDistance={500}
        maxPolarAngle={Math.PI / 2 + 0.1}
      />
      
      {/* Export Mesh Preview */}
      <ExportMeshPreview
        layoutState={layoutState}
        toolOutlines={toolOutlines}
        pixelsPerMm={pixelsPerMm}
        settings={settings}
      />
    </>
  );
};

// ============================================================================
// SVG Preview Component
// ============================================================================

interface SVGPreviewProps {
  toolOutlines: ReturnType<typeof useAppStore.getState>['toolOutlines'];
  layoutState: ReturnType<typeof useAppStore.getState>['layoutState'];
  pixelsPerMm: number | null;
}

const SVGPreview: React.FC<SVGPreviewProps> = ({ toolOutlines, layoutState, pixelsPerMm }) => {
  const { grid, shapes } = layoutState;
  
  // Calculate dimensions
  const layoutWidthMm = grid.cols * grid.cellWidthMm;
  const layoutHeightMm = grid.rows * grid.cellHeightMm;
  
  // Scale for display (mm to pixels at reasonable size)
  const displayScale = 3;
  const displayWidth = layoutWidthMm * displayScale;
  const displayHeight = layoutHeightMm * displayScale;
  
  // Generate path for each shape
  const shapePaths = useMemo(() => {
    if (!pixelsPerMm) return [];
    
    return shapes.map(shape => {
      let path = '';
      
      if (shape.type === 'tool' && shape.toolOutlineId) {
        const outline = toolOutlines.find(o => o.id === shape.toolOutlineId);
        if (outline) {
          const displayPoints = outline.regularizedPoints ?? outline.smoothedPoints;
          if (displayPoints.length > 0) {
            const { boundingBox } = outline;
            const bboxWidth = boundingBox.maxX - boundingBox.minX;
            const bboxHeight = boundingBox.maxY - boundingBox.minY;
            
            const scaleX = (shape.width / (bboxWidth / pixelsPerMm)) * displayScale;
            const scaleY = (shape.height / (bboxHeight / pixelsPerMm)) * displayScale;
            
            path = displayPoints.map((p, i) => {
              const x = shape.x * displayScale + ((p.x - boundingBox.minX) / pixelsPerMm) * scaleX;
              const y = shape.y * displayScale + ((p.y - boundingBox.minY) / pixelsPerMm) * scaleY;
              return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
            }).join(' ') + ' Z';
            
            return { path, color: outline.color, name: shape.toolOutlineId };
          }
        }
      }
      
      // Rectangle fallback
      const x = shape.x * displayScale;
      const y = shape.y * displayScale;
      const w = shape.width * displayScale;
      const h = shape.height * displayScale;
      const r = Math.min(w, h, 6) * 0.2;
      
      path = `M ${x + r} ${y} 
              L ${x + w - r} ${y} 
              Q ${x + w} ${y} ${x + w} ${y + r}
              L ${x + w} ${y + h - r}
              Q ${x + w} ${y + h} ${x + w - r} ${y + h}
              L ${x + r} ${y + h}
              Q ${x} ${y + h} ${x} ${y + h - r}
              L ${x} ${y + r}
              Q ${x} ${y} ${x + r} ${y}
              Z`;
      
      return { path, color: '#888888', name: 'rectangle' };
    }).filter(p => p.path);
  }, [shapes, toolOutlines, pixelsPerMm, displayScale]);
  
  return (
    <div className="flex items-center justify-center h-full p-8">
      <div className="bg-white rounded-lg shadow-lg overflow-hidden">
        <svg
          width={displayWidth}
          height={displayHeight}
          viewBox={`0 0 ${displayWidth} ${displayHeight}`}
          className="block"
        >
          {/* Background grid */}
          <defs>
            <pattern id="grid" width={grid.cellWidthMm * displayScale} height={grid.cellHeightMm * displayScale} patternUnits="userSpaceOnUse">
              <path
                d={`M 0 0 L ${grid.cellWidthMm * displayScale} 0 L ${grid.cellWidthMm * displayScale} ${grid.cellHeightMm * displayScale} L 0 ${grid.cellHeightMm * displayScale} Z`}
                fill="none"
                stroke="#e5e7eb"
                strokeWidth="0.5"
              />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="white" />
          <rect width="100%" height="100%" fill="url(#grid)" />
          
          {/* Border */}
          <rect
            x="1"
            y="1"
            width={displayWidth - 2}
            height={displayHeight - 2}
            fill="none"
            stroke="#374151"
            strokeWidth="2"
            rx="6"
          />
          
          {/* Shape paths */}
          {shapePaths.map((shape, i) => (
            <path
              key={i}
              d={shape.path}
              fill={`${shape.color}20`}
              stroke={shape.color}
              strokeWidth="1.5"
            />
          ))}
        </svg>
        
        {/* Dimensions label */}
        <div className="bg-gray-100 px-4 py-2 text-center text-xs text-gray-600">
          {layoutWidthMm.toFixed(1)} × {layoutHeightMm.toFixed(1)} mm
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Main Export Workspace Component
// ============================================================================

export const ExportWorkspace: React.FC = () => {
  const {
    exportFormat,
    toolOutlines,
    layoutState,
    designSettings,
    pixelsPerMm,
    clearanceValue,
    setProcessing,
  } = useAppStore();
  
  const controlsRef = useRef<any>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // Reset view for 3D
  const handleResetView = useCallback(() => {
    if (controlsRef.current) {
      controlsRef.current.reset();
    }
  }, []);
  
  // Handle export
  const handleExport = useCallback(async () => {
    if (!pixelsPerMm) {
      setExportError('Calibrate the paper scale first so the export is to size.');
      setTimeout(() => setExportError(null), 6000);
      return;
    }

    setProcessing(true, `Exporting ${exportFormat.toUpperCase()}...`);
    
    try {
      if (exportFormat === 'svg') {
        // Export SVG using tool outlines
        const outlinesToExport = toolOutlines.map(outline => ({
          id: outline.id,
          name: outline.name,
          points: outline.regularizedPoints ?? outline.smoothedPoints,
          color: outline.color,
        }));
        
        downloadSVG(outlinesToExport, pixelsPerMm, 'tooltrace-export.svg');
      } else {
        // Export a watertight, manifold STL (repaired via Manifold3D).
        const mesh = generateExportMesh(layoutState, toolOutlines, pixelsPerMm, designSettings, clearanceValue);
        const blob = await buildManifoldStlBlob(mesh);

        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'tooltrace-export.stl';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        // Clean up
        mesh.geometry.dispose();
        if (mesh.material instanceof THREE.Material) {
          mesh.material.dispose();
        }
      }
    } catch (error) {
      // Keep the technical detail in the console; show the user a calm message.
      console.error('Export failed:', error);
      setExportError("Couldn't export your design. Please try again.");
      setTimeout(() => setExportError(null), 6000);
    } finally {
      setProcessing(false);
    }
  }, [exportFormat, toolOutlines, layoutState, designSettings, pixelsPerMm, clearanceValue, setProcessing]);
  
  // Calculate dimensions for display
  const layoutWidth = layoutState.grid.cols * layoutState.grid.cellWidthMm;
  const layoutHeight = layoutState.grid.rows * layoutState.grid.cellHeightMm;
  const totalHeight = designSettings.baseHeight + designSettings.cutoutDepth;
  
  return (
    <div className="h-full flex flex-col bg-[hsl(var(--workspace-bg))]">
      {/* Top Info Bar */}
      <div className="absolute top-4 left-4 z-10 flex items-center gap-3 bg-[hsl(var(--card))/95] backdrop-blur-sm border border-[hsl(var(--border))] rounded-lg px-3 py-2 shadow-sm">
        {exportFormat === 'stl' ? (
          <Box className="w-4 h-4 text-[hsl(var(--primary))]" />
        ) : (
          <FileCode className="w-4 h-4 text-[hsl(var(--primary))]" />
        )}
        <span className="text-xs font-medium">
          Export Preview ({exportFormat.toUpperCase()})
        </span>
        <div className="w-px h-4 bg-[hsl(var(--border))]" />
        <span className="text-xs text-[hsl(var(--muted-foreground))]">
          {layoutWidth.toFixed(1)} × {layoutHeight.toFixed(1)} × {totalHeight.toFixed(1)} mm
        </span>
      </div>
      
      {/* Main Preview Area */}
      <div className="flex-1">
        {exportFormat === 'stl' ? (
          <Canvas
            shadows
            camera={{
              fov: 45,
              near: 0.1,
              far: 2000,
              position: [150, 150, 150],
            }}
            gl={{
              antialias: true,
              preserveDrawingBuffer: true,
              toneMapping: THREE.ACESFilmicToneMapping,
              toneMappingExposure: 1,
            }}
          >
            <Scene3D
              layoutState={layoutState}
              toolOutlines={toolOutlines}
              pixelsPerMm={pixelsPerMm}
              settings={designSettings}
              onControlsReady={(c) => { controlsRef.current = c; }}
            />
          </Canvas>
        ) : (
          <SVGPreview
            toolOutlines={toolOutlines}
            layoutState={layoutState}
            pixelsPerMm={pixelsPerMm}
          />
        )}
      </div>
      
      {/* Graceful export error (no blocking alert) */}
      {exportError && (
        <div className="absolute bottom-4 right-4 z-20 flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-white bg-[hsl(var(--destructive))] shadow-lg">
          <AlertCircle className="w-3.5 h-3.5" />
          {exportError}
        </div>
      )}
      
      {/* Export Info */}
      <div className="absolute bottom-4 left-4 flex items-center gap-2 text-[10px] text-[hsl(var(--muted-foreground))] bg-[hsl(var(--card))/80] backdrop-blur-sm px-2.5 py-1.5 rounded-md">
        <Layers className="w-3 h-3" />
        <span>
          {toolOutlines.length} tool{toolOutlines.length !== 1 ? 's' : ''} •{' '}
          {layoutState.shapes.length} shape{layoutState.shapes.length !== 1 ? 's' : ''}
        </span>
      </div>
    </div>
  );
};
