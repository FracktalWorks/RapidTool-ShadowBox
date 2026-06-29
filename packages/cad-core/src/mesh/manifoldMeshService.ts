/**
 * Manifold Mesh Service
 * 
 * Provides robust mesh repair and decimation using Manifold3D library.
 * Manifold3D is a high-quality geometry library that guarantees manifold output
 * and provides robust mesh operations.
 * 
 * Key features:
 * - Proper mesh repair (makes meshes watertight/manifold)
 * - Topology-preserving mesh simplification
 * - Robust handling of non-manifold edges
 * - Fallback to vertex clustering for non-manifold meshes
 */

import * as THREE from 'three';
import Module from 'manifold-3d';
// Vite emits manifold.wasm as a HASHED asset (manifold-<hash>.wasm). Without a
// locateFile, Emscripten fetches it by its original name → 404 → the SPA returns
// index.html → WASM compile fails ("magic word … found 3c 21 64 6f" = "<!do"),
// and the watertight-STL repair silently falls back to a raw mesh. Resolving the
// real asset URL via Vite's ?url and handing it to locateFile fixes the load.
// @ts-ignore — Vite ?url asset import (resolved at bundle time)
import manifoldWasmUrl from 'manifold-3d/manifold.wasm?url';
import { decimateMesh as fallbackDecimateMesh, repairMesh as basicRepairMesh } from './meshAnalysis';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface ManifoldRepairResult {
  success: boolean;
  geometry: THREE.BufferGeometry | null;
  originalTriangles: number;
  finalTriangles: number;
  wasRepaired: boolean;
  actions: string[];
  error?: string;
}

export interface ManifoldDecimationResult {
  success: boolean;
  geometry: THREE.BufferGeometry | null;
  originalTriangles: number;
  finalTriangles: number;
  reductionPercent: number;
  error?: string;
}

export interface ManifoldProcessResult {
  success: boolean;
  geometry: THREE.BufferGeometry | null;
  originalTriangles: number;
  finalTriangles: number;
  wasRepaired: boolean;
  wasDecimated: boolean;
  reductionPercent: number;
  actions: string[];
  error?: string;
}

export interface ManifoldProgressCallback {
  (progress: {
    stage: 'initializing' | 'repairing' | 'decimating' | 'finalizing' | 'complete';
    progress: number;
    message: string;
  }): void;
}

// ============================================================================
// Manifold Module Management
// ============================================================================

let manifoldModule: any = null;
let moduleInitPromise: Promise<any> | null = null;

/**
 * Yield to the UI thread to allow React to re-render
 * This is crucial for showing progress updates during heavy processing
 */
async function yieldToUI(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Initialize the Manifold WASM module (singleton pattern)
 */
async function getManifoldModule(): Promise<any> {
  if (manifoldModule) {
    return manifoldModule;
  }
  
  if (moduleInitPromise) {
    return moduleInitPromise;
  }
  
  moduleInitPromise = Module({
    // Point Emscripten at the Vite-resolved wasm URL (see import note above).
    locateFile: (path: string) => (path.endsWith('.wasm') ? manifoldWasmUrl : path),
  }).then((wasm: any) => {
    // Call setup() to initialize the module
    wasm.setup();
    manifoldModule = wasm;
    return wasm;
  });
  
  return moduleInitPromise;
}

// ============================================================================
// Geometry Conversion Utilities
// ============================================================================

/**
 * Convert THREE.BufferGeometry to Manifold Mesh format
 * Based on the official three.ts example
 */
function threeGeometryToManifoldMesh(geometry: THREE.BufferGeometry, wasm: any): any {
  const { Mesh } = wasm;
  
  const positionAttr = geometry.getAttribute('position');
  const positions = positionAttr.array as Float32Array;
  
  // Manifold uses vertProperties for vertex data (interleaved)
  const vertProperties = new Float32Array(positions);
  
  // Generate triangle indices
  // For non-indexed geometry, each vertex is unique
  let triVerts: Uint32Array;
  if (geometry.index) {
    triVerts = new Uint32Array(geometry.index.array);
  } else {
    const vertexCount = positions.length / 3;
    triVerts = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
      triVerts[i] = i;
    }
  }
  
  // Create the Mesh using the correct API
  const mesh = new Mesh({
    numProp: 3, // x, y, z per vertex
    vertProperties,
    triVerts,
  });
  
  // Call merge() to combine vertices with nearly identical positions
  // This is necessary for Manifold to work properly
  mesh.merge();
  
  return mesh;
}

/**
 * Convert Manifold Mesh back to THREE.BufferGeometry
 * Based on the official three.ts example
 */
function manifoldMeshToThreeGeometry(mesh: any): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  
  // Get vertex positions from vertProperties
  const vertProperties = mesh.vertProperties;
  const triVerts = mesh.triVerts;
  const numProp = mesh.numProp;
  
  // Check if we have indexed geometry
  if (triVerts && triVerts.length > 0) {
    // Create non-indexed geometry for simplicity
    const numTris = triVerts.length / 3;
    const positions = new Float32Array(numTris * 9);
    
    for (let i = 0; i < numTris; i++) {
      const i0 = triVerts[i * 3];
      const i1 = triVerts[i * 3 + 1];
      const i2 = triVerts[i * 3 + 2];
      
      // Vertex 0
      positions[i * 9 + 0] = vertProperties[i0 * numProp];
      positions[i * 9 + 1] = vertProperties[i0 * numProp + 1];
      positions[i * 9 + 2] = vertProperties[i0 * numProp + 2];
      
      // Vertex 1
      positions[i * 9 + 3] = vertProperties[i1 * numProp];
      positions[i * 9 + 4] = vertProperties[i1 * numProp + 1];
      positions[i * 9 + 5] = vertProperties[i1 * numProp + 2];
      
      // Vertex 2
      positions[i * 9 + 6] = vertProperties[i2 * numProp];
      positions[i * 9 + 7] = vertProperties[i2 * numProp + 1];
      positions[i * 9 + 8] = vertProperties[i2 * numProp + 2];
    }
    
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  } else {
    // Direct vertex properties
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertProperties, 3));
  }
  
  geometry.computeVertexNormals();
  
  // Compute bounds tree if available
  if (typeof (geometry as any).computeBoundsTree === 'function') {
    (geometry as any).computeBoundsTree();
  }
  
  return geometry;
}

// ============================================================================
// Mesh Repair Utilities
// ============================================================================

/**
 * Weld vertices that are within a tolerance distance of each other
 * This helps fix non-manifold edges caused by floating point precision issues
 */
function weldVertices(geometry: THREE.BufferGeometry, tolerance: number = 1e-4): THREE.BufferGeometry {
  const positionAttr = geometry.getAttribute('position');
  const positions = positionAttr.array as Float32Array;
  const vertexCount = positions.length / 3;
  
  // Build a map of welded vertex indices
  const vertexMap = new Map<string, number>();
  const newIndices: number[] = [];
  const newPositions: number[] = [];
  
  const quantize = (v: number) => Math.round(v / tolerance) * tolerance;
  
  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    
    // Create a key based on quantized position
    const key = `${quantize(x)},${quantize(y)},${quantize(z)}`;
    
    if (vertexMap.has(key)) {
      newIndices.push(vertexMap.get(key)!);
    } else {
      const newIndex = newPositions.length / 3;
      vertexMap.set(key, newIndex);
      newPositions.push(x, y, z);
      newIndices.push(newIndex);
    }
  }
  
  // Create new indexed geometry
  const newGeometry = new THREE.BufferGeometry();
  newGeometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(newPositions), 3));
  newGeometry.setIndex(newIndices);
  
  return newGeometry;
}

/**
 * Remove degenerate triangles (zero area or invalid)
 */
function removeDegenerateTriangles(geometry: THREE.BufferGeometry, minArea: number = 1e-10): THREE.BufferGeometry {
  const positionAttr = geometry.getAttribute('position');
  const positions = positionAttr.array as Float32Array;
  
  let indices: number[];
  if (geometry.index) {
    indices = Array.from(geometry.index.array);
  } else {
    indices = [];
    for (let i = 0; i < positions.length / 3; i++) {
      indices.push(i);
    }
  }
  
  const validIndices: number[] = [];
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const cross = new THREE.Vector3();
  
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i];
    const i1 = indices[i + 1];
    const i2 = indices[i + 2];
    
    v0.set(positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]);
    v1.set(positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
    v2.set(positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]);
    
    // Check for duplicate vertices
    if (i0 === i1 || i1 === i2 || i0 === i2) {
      continue;
    }
    
    // Calculate triangle area using cross product
    edge1.subVectors(v1, v0);
    edge2.subVectors(v2, v0);
    cross.crossVectors(edge1, edge2);
    const area = cross.length() * 0.5;
    
    if (area > minArea) {
      validIndices.push(i0, i1, i2);
    }
  }
  
  const newGeometry = geometry.clone();
  newGeometry.setIndex(validIndices);
  
  return newGeometry;
}

/**
 * Convert geometry to non-indexed format for consistent processing
 */
function toNonIndexed(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!geometry.index) {
    return geometry.clone();
  }
  return geometry.toNonIndexed();
}

// ============================================================================
// Core Manifold Operations
// ============================================================================

/**
 * Repair a mesh using Manifold3D
 * 
 * Manifold3D will attempt to make the mesh manifold (watertight).
 * If the input mesh is already valid, it returns quickly.
 */
export async function repairMeshWithManifold(
  geometry: THREE.BufferGeometry,
  onProgress?: ManifoldProgressCallback
): Promise<ManifoldRepairResult> {
  const startTime = performance.now();
  const actions: string[] = [];
  
  try {
    onProgress?.({ stage: 'initializing', progress: 0, message: 'Loading Manifold3D...' });
    await yieldToUI();
    
    const wasm = await getManifoldModule();
    const { Manifold } = wasm;
    
    onProgress?.({ stage: 'repairing', progress: 10, message: 'Converting geometry...' });
    await yieldToUI();
    
    const positionAttr = geometry.getAttribute('position');
    const originalTriangles = positionAttr.count / 3;
    
    // Convert to Manifold Mesh format
    const mesh = threeGeometryToManifoldMesh(geometry, wasm);
    
    onProgress?.({ stage: 'repairing', progress: 30, message: 'Creating Manifold...' });
    await yieldToUI();
    
    // Try to create a Manifold from the mesh
    // This will attempt to repair non-manifold geometry
    let manifold: any;
    let wasRepaired = false;
    
    try {
      // Manifold constructor will merge vertices and try to create valid manifold
      manifold = new Manifold(mesh);
      
      const status = manifold.status();
      if (status !== 0) { // 0 = NoError
        wasRepaired = true;
        actions.push('Manifold attempted automatic repair');
      }
      
      // Check if manifold is empty (failed)
      if (manifold.isEmpty()) {
        throw new Error('Created manifold is empty - mesh may be too damaged to repair');
      }
      
    } catch (err) {
      mesh.delete?.();
      throw err;
    }
    
    onProgress?.({ stage: 'repairing', progress: 70, message: 'Extracting repaired mesh...' });
    await yieldToUI();
    
    // Get the repaired mesh
    const repairedMesh = manifold.getMesh();
    const finalTriangles = manifold.numTri();
    
    if (finalTriangles !== originalTriangles) {
      actions.push(`Triangle count: ${originalTriangles.toLocaleString()} → ${finalTriangles.toLocaleString()}`);
      wasRepaired = true;
    }
    
    onProgress?.({ stage: 'finalizing', progress: 85, message: 'Converting back to Three.js...' });
    await yieldToUI();
    
    // Convert back to THREE.BufferGeometry
    const repairedGeometry = manifoldMeshToThreeGeometry(repairedMesh);
    
    // Cleanup WASM objects
    repairedMesh.delete?.();
    manifold.delete();
    mesh.delete?.();
    
    onProgress?.({ stage: 'complete', progress: 100, message: 'Repair complete' });
    await yieldToUI();
    
    if (wasRepaired) {
      actions.push('Mesh successfully repaired with Manifold3D');
    } else {
      actions.push('Mesh was already valid');
    }
    
    return {
      success: true,
      geometry: repairedGeometry,
      originalTriangles,
      finalTriangles,
      wasRepaired,
      actions,
    };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown repair error';
    console.error('[ManifoldMeshService] ✗ Repair failed:', errorMessage);
    
    return {
      success: false,
      geometry: null,
      originalTriangles: 0,
      finalTriangles: 0,
      wasRepaired: false,
      actions,
      error: errorMessage,
    };
  }
}

/**
 * Decimate (simplify) a mesh using Manifold3D's Simplify method
 * 
 * This uses topology-preserving simplification that guarantees
 * the output remains manifold while reducing triangle count.
 */
export async function decimateMeshWithManifold(
  geometry: THREE.BufferGeometry,
  targetTriangles: number,
  onProgress?: ManifoldProgressCallback,
  force: boolean = false // Force decimation even if below target
): Promise<ManifoldDecimationResult> {
  const startTime = performance.now();
  
  try {
    onProgress?.({ stage: 'initializing', progress: 0, message: 'Loading Manifold3D...' });
    await yieldToUI();
    
    const wasm = await getManifoldModule();
    const { Manifold } = wasm;
    
    onProgress?.({ stage: 'decimating', progress: 10, message: 'Converting geometry...' });
    await yieldToUI();
    
    const positionAttr = geometry.getAttribute('position');
    const originalTriangles = positionAttr.count / 3;
    
    // Skip if already below target (unless force is true)
    if (originalTriangles <= targetTriangles && !force) {
      return {
        success: true,
        geometry: geometry.clone(),
        originalTriangles,
        finalTriangles: originalTriangles,
        reductionPercent: 0,
      };
    }
    
    // Convert to Manifold Mesh format
    const mesh = threeGeometryToManifoldMesh(geometry, wasm);
    
    onProgress?.({ stage: 'decimating', progress: 25, message: 'Creating Manifold...' });
    await yieldToUI();
    
    // Create Manifold from mesh
    const manifold = new Manifold(mesh);
    
    const status = manifold.status();
    if (status !== 0) { // 0 = NoError
      // Mesh has issues but we'll try to continue
    }
    
    if (manifold.isEmpty()) {
      mesh.delete?.();
      manifold.delete();
      throw new Error('Cannot decimate - mesh could not be converted to valid manifold');
    }
    
    onProgress?.({ stage: 'decimating', progress: 40, message: 'Computing simplification tolerance...' });
    await yieldToUI();
    
    // Calculate tolerance based on bounding box and target reduction
    const bbox = manifold.boundingBox();
    const bboxSize = new THREE.Vector3(
      bbox.max[0] - bbox.min[0],
      bbox.max[1] - bbox.min[1],
      bbox.max[2] - bbox.min[2]
    );
    const maxDim = Math.max(bboxSize.x, bboxSize.y, bboxSize.z);
    
    // Tolerance determines how much simplification happens
    // Higher tolerance = more simplification
    // We use an iterative approach to reach target
    let tolerance = maxDim * 0.001; // Start with small tolerance
    const maxTolerance = maxDim * 0.1; // Max 10% of bounding box
    let simplified = manifold;
    let currentTriangles = manifold.numTri();
    let iterations = 0;
    const maxIterations = 10;
    
    onProgress?.({ stage: 'decimating', progress: 50, message: 'Simplifying mesh...' });
    await yieldToUI();
    
    while (currentTriangles > targetTriangles && tolerance < maxTolerance && iterations < maxIterations) {
      // Simplify with current tolerance
      const newSimplified = simplified.simplify(tolerance);
      const newTriangles = newSimplified.numTri();
      
      // Clean up old manifold if not the original
      if (simplified !== manifold) {
        simplified.delete();
      }
      
      simplified = newSimplified;
      currentTriangles = newTriangles;
      
      // Increase tolerance for next iteration
      tolerance *= 2;
      iterations++;
      
      const progress = 50 + Math.min(40, (iterations / maxIterations) * 40);
      onProgress?.({ 
        stage: 'decimating', 
        progress, 
        message: `Simplifying... ${currentTriangles.toLocaleString()} triangles` 
      });
      
      // Yield to UI to show progress update
      await yieldToUI();
    }
    
    onProgress?.({ stage: 'finalizing', progress: 90, message: 'Converting back to Three.js...' });
    await yieldToUI();
    
    // Get final mesh
    const simplifiedMesh = simplified.getMesh();
    const finalTriangles = simplified.numTri();
    
    // Convert back to THREE.BufferGeometry
    const decimatedGeometry = manifoldMeshToThreeGeometry(simplifiedMesh);
    
    // Cleanup WASM objects
    simplifiedMesh.delete?.();
    if (simplified !== manifold) {
      simplified.delete();
    }
    manifold.delete();
    mesh.delete?.();
    
    const reductionPercent = ((originalTriangles - finalTriangles) / originalTriangles) * 100;
    
    onProgress?.({ stage: 'complete', progress: 100, message: 'Decimation complete' });
    
    return {
      success: true,
      geometry: decimatedGeometry,
      originalTriangles,
      finalTriangles,
      reductionPercent,
    };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown decimation error';
    console.error('[ManifoldMeshService] ✗ Decimation failed:', errorMessage);
    
    return {
      success: false,
      geometry: null,
      originalTriangles: 0,
      finalTriangles: 0,
      reductionPercent: 0,
      error: errorMessage,
    };
  }
}

/**
 * Combined repair and decimation operation
 * 
 * This is the most robust approach - first repair to ensure manifoldness,
 * then decimate to reduce triangle count while preserving topology.
 */
export async function repairAndDecimateMesh(
  geometry: THREE.BufferGeometry,
  targetTriangles: number,
  options: {
    repair?: boolean;
    decimate?: boolean;
    forceDecimate?: boolean; // Force decimation even if below target (for large files)
  } = { repair: true, decimate: true, forceDecimate: false },
  onProgress?: ManifoldProgressCallback
): Promise<ManifoldProcessResult> {
  const startTime = performance.now();
  const actions: string[] = [];
  
  const positionAttr = geometry.getAttribute('position');
  const originalTriangles = geometry.index
    ? geometry.index.count / 3
    : positionAttr.count / 3;
  
  let currentGeometry = geometry;
  let wasRepaired = false;
  let wasDecimated = false;
  let finalTriangles = originalTriangles;
  
  try {
    // Step 1: Repair if requested
    if (options.repair) {
      onProgress?.({ stage: 'repairing', progress: 5, message: 'Starting repair...' });
      await yieldToUI();
      
      const repairResult = await repairMeshWithManifold(
        currentGeometry,
        (p) => {
          const mappedProgress = 5 + (p.progress * 0.4); // 5-45%
          onProgress?.({ ...p, progress: mappedProgress });
        }
      );
      
      if (repairResult.success && repairResult.geometry) {
        currentGeometry = repairResult.geometry;
        wasRepaired = repairResult.wasRepaired;
        finalTriangles = repairResult.finalTriangles;
        actions.push(...repairResult.actions);
      } else if (!repairResult.success) {
        // Manifold3D cannot handle truly non-manifold meshes (e.g. open shells).
        // Fall back to basic repair: remove degenerate triangles + recompute normals.
        console.warn('[ManifoldMeshService] Manifold3D repair failed — falling back to basic repair');
        try {
          const basicResult = await basicRepairMesh(currentGeometry);
          if (basicResult.success && basicResult.geometry) {
            currentGeometry = basicResult.geometry;
            wasRepaired = true;
            finalTriangles = basicResult.triangleCount;
            actions.push(...basicResult.actions);
            actions.push('Note: mesh has open boundaries that could not be fully sealed');
          } else {
            actions.push(`Repair skipped: ${repairResult.error}`);
          }
        } catch {
          actions.push(`Repair skipped: ${repairResult.error}`);
        }
      }
    }
    
    // Step 2: Decimate if requested and (triangle count is above target OR forceDecimate is true)
    const shouldDecimate = options.decimate && (finalTriangles > targetTriangles || options.forceDecimate);
    if (shouldDecimate) {
      onProgress?.({ stage: 'decimating', progress: 50, message: 'Starting Fast Quadric decimation...' });
      await yieldToUI();
      
      // Use Fast Quadric Mesh Simplification (WASM) - high quality QEM decimation
      const fallbackResult = await fallbackDecimateMesh(
        currentGeometry,
        targetTriangles,
        (p) => {
          const mappedProgress = 50 + (p.progress * 0.4); // 50-90%
          onProgress?.({ stage: 'decimating', progress: mappedProgress, message: p.message || 'Decimating...' });
        }
      );
      
      let decimateResult: ManifoldDecimationResult;
      
      if (fallbackResult.success && fallbackResult.geometry) {
        decimateResult = {
          success: true,
          geometry: fallbackResult.geometry,
          originalTriangles: fallbackResult.originalTriangles,
          finalTriangles: fallbackResult.finalTriangles,
          reductionPercent: fallbackResult.reductionPercent,
        };
        actions.push(`Mesh decimation (MeshOptimizer + Fast Quadric): ${fallbackResult.originalTriangles.toLocaleString()} → ${fallbackResult.finalTriangles.toLocaleString()} triangles`);
      } else {
        decimateResult = {
          success: false,
          geometry: null,
          originalTriangles: finalTriangles,
          finalTriangles: finalTriangles,
          reductionPercent: 0,
          error: fallbackResult.error || 'Fast Quadric decimation failed',
        };
      }
      
      if (decimateResult.success && decimateResult.geometry) {
        // Dispose previous geometry if it was repaired
        if (wasRepaired && currentGeometry !== geometry) {
          currentGeometry.dispose();
        }
        currentGeometry = decimateResult.geometry;
        wasDecimated = decimateResult.reductionPercent > 0;
        finalTriangles = decimateResult.finalTriangles;
        actions.push(`Decimated: ${decimateResult.originalTriangles.toLocaleString()} → ${decimateResult.finalTriangles.toLocaleString()} triangles (${decimateResult.reductionPercent.toFixed(1)}% reduction)`);
      } else if (!decimateResult.success) {
        console.warn('[ManifoldMeshService] Both decimation methods failed');
        actions.push(`Decimation failed: ${decimateResult.error}`);
      }
    }
    
    onProgress?.({ stage: 'complete', progress: 100, message: 'Processing complete' });
    
    const reductionPercent = ((originalTriangles - finalTriangles) / originalTriangles) * 100;
    
    return {
      success: true,
      geometry: currentGeometry,
      originalTriangles,
      finalTriangles,
      wasRepaired,
      wasDecimated,
      reductionPercent,
      actions,
    };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[ManifoldMeshService] ✗ Processing failed:', errorMessage);
    
    return {
      success: false,
      geometry: null,
      originalTriangles,
      finalTriangles: 0,
      wasRepaired: false,
      wasDecimated: false,
      reductionPercent: 0,
      actions,
      error: errorMessage,
    };
  }
}

/**
 * Union Result Interface
 */
export interface ManifoldUnionResult {
  success: boolean;
  geometry: THREE.BufferGeometry | null;
  inputMeshCount: number;
  successfulMeshCount: number;
  failedMeshCount: number;
  totalInputTriangles: number;
  finalTriangles: number;
  error?: string;
}

/**
 * Union multiple geometries into a single manifold mesh using Manifold3D
 * 
 * This performs a proper boolean union operation that ensures the output
 * is a valid manifold (watertight) mesh suitable for 3D printing.
 * 
 * Unlike simple buffer merging, this actually computes the boolean union
 * removing internal faces at intersection points.
 * 
 * @param geometries - Array of THREE.BufferGeometry to union
 * @param onProgress - Optional progress callback
 * @returns Promise<ManifoldUnionResult> - The unified manifold geometry
 */
export async function unionGeometriesWithManifold(
  geometries: THREE.BufferGeometry[],
  onProgress?: ManifoldProgressCallback
): Promise<ManifoldUnionResult> {
  if (geometries.length === 0) {
    return {
      success: false,
      geometry: null,
      inputMeshCount: 0,
      totalInputTriangles: 0,
      finalTriangles: 0,
      error: 'No geometries provided for union',
    };
  }

  // If only one geometry, just repair and return it
  if (geometries.length === 1) {
    onProgress?.({ stage: 'initializing', progress: 10, message: 'Single geometry - running repair...' });
    await yieldToUI();
    
    const repairResult = await repairMeshWithManifold(geometries[0], onProgress);
    
    const positionAttr = geometries[0].getAttribute('position');
    const inputTriangles = positionAttr ? positionAttr.count / 3 : 0;
    
    return {
      success: repairResult.success,
      geometry: repairResult.geometry,
      inputMeshCount: 1,
      successfulMeshCount: repairResult.success ? 1 : 0,
      failedMeshCount: repairResult.success ? 0 : 1,
      totalInputTriangles: inputTriangles,
      finalTriangles: repairResult.finalTriangles,
      error: repairResult.error,
    };
  }

  try {
    onProgress?.({ stage: 'initializing', progress: 0, message: 'Loading Manifold3D...' });
    await yieldToUI();
    
    const wasm = await getManifoldModule();
    const { Manifold } = wasm;
    
    let totalInputTriangles = 0;
    let failedCount = 0;
    const manifolds: any[] = [];
    
    // Convert all geometries to Manifold objects
    for (let i = 0; i < geometries.length; i++) {
      const geom = geometries[i];
      const progress = 5 + ((i / geometries.length) * 40); // 5-45%
      
      onProgress?.({ 
        stage: 'repairing', 
        progress, 
        message: `Converting mesh ${i + 1}/${geometries.length}...` 
      });
      await yieldToUI();
      
      const positionAttr = geom.getAttribute('position');
      if (!positionAttr) {
        console.warn(`[ManifoldUnion] Geometry ${i} has no position attribute, skipping`);
        failedCount++;
        continue;
      }
      
      const triangles = positionAttr.count / 3;
      totalInputTriangles += triangles;
      
      try {
        // Convert to Manifold Mesh format
        const mesh = threeGeometryToManifoldMesh(geom, wasm);
        
        // Create Manifold from mesh
        const manifold = new Manifold(mesh);
        
        // Check if manifold is empty (failed conversion)
        if (!manifold.isEmpty()) {
          manifolds.push(manifold);
        } else {
          console.warn(`[ManifoldUnion] Mesh ${i} converted to empty manifold, skipping`);
          manifold.delete();
          failedCount++;
        }
        
        mesh.delete?.();
      } catch (err) {
        console.warn(`[ManifoldUnion] Failed to convert geometry ${i}:`, err);
        failedCount++;
      }
    }
    
    if (manifolds.length === 0) {
      return {
        success: false,
        geometry: null,
        inputMeshCount: geometries.length,
        successfulMeshCount: 0,
        failedMeshCount: failedCount,
        totalInputTriangles,
        finalTriangles: 0,
        error: 'No valid manifolds could be created from input geometries - CSG results may be non-manifold',
      };
    }
    
    onProgress?.({ stage: 'repairing', progress: 50, message: `Performing boolean union of ${manifolds.length} meshes...` });
    await yieldToUI();
    
    // Perform batch union using Manifold's batch operation
    // Union all manifolds together progressively
    let result = manifolds[0];
    
    for (let i = 1; i < manifolds.length; i++) {
      const progress = 50 + ((i / (manifolds.length - 1)) * 35); // 50-85%
      
      onProgress?.({ 
        stage: 'repairing', 
        progress, 
        message: `Unioning mesh ${i + 1}/${manifolds.length}...` 
      });
      await yieldToUI();
      
      try {
        const newResult = result.add(manifolds[i]);
        
        // Clean up the old result and the added manifold
        result.delete();
        manifolds[i].delete();
        
        result = newResult;
      } catch (err) {
        console.warn(`[ManifoldUnion] Failed to union mesh ${i}:`, err);
        // Clean up and continue with what we have
        manifolds[i].delete();
      }
    }
    
    onProgress?.({ stage: 'finalizing', progress: 90, message: 'Converting result to Three.js...' });
    await yieldToUI();
    
    // Get the result mesh
    const resultMesh = result.getMesh();
    const finalTriangles = result.numTri();
    
    // Convert back to THREE.BufferGeometry
    const unionedGeometry = manifoldMeshToThreeGeometry(resultMesh);
    
    // Cleanup
    resultMesh.delete?.();
    result.delete();
    
    onProgress?.({ stage: 'complete', progress: 100, message: 'Union complete' });
    await yieldToUI();
    
    console.log(`[ManifoldUnion] ✓ Unified ${manifolds.length} meshes: ${totalInputTriangles.toLocaleString()} → ${finalTriangles.toLocaleString()} triangles`);
    
    return {
      success: true,
      geometry: unionedGeometry,
      inputMeshCount: geometries.length,
      successfulMeshCount: manifolds.length,
      failedMeshCount: failedCount,
      totalInputTriangles,
      finalTriangles,
    };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown union error';
    console.error('[ManifoldUnion] ✗ Union failed:', errorMessage);
    
    return {
      success: false,
      geometry: null,
      inputMeshCount: geometries.length,
      successfulMeshCount: 0,
      failedMeshCount: geometries.length,
      totalInputTriangles: 0,
      finalTriangles: 0,
      error: errorMessage,
    };
  }
}

/**
 * Result interface for mesh repair for export
 */
export interface MeshRepairForExportResult {
  success: boolean;
  geometry: THREE.BufferGeometry | null;
  originalTriangles: number;
  finalTriangles: number;
  repairSteps: string[];
  isManifold: boolean;
  error?: string;
}

/**
 * Repair a mesh for export to ensure it's as manifold as possible
 * 
 * This function applies multiple repair strategies:
 * 1. Weld close vertices (fixes precision issues)
 * 2. Remove degenerate triangles
 * 3. Attempt Manifold3D conversion (which internally merges and repairs)
 * 4. If Manifold fails, return the pre-processed geometry
 * 
 * @param geometry - The geometry to repair
 * @param onProgress - Optional progress callback
 * @returns Promise<MeshRepairForExportResult>
 */
export async function repairMeshForExport(
  geometry: THREE.BufferGeometry,
  onProgress?: ManifoldProgressCallback
): Promise<MeshRepairForExportResult> {
  const repairSteps: string[] = [];
  
  const positionAttr = geometry.getAttribute('position');
  const originalTriangles = positionAttr ? positionAttr.count / 3 : 0;
  
  try {
    onProgress?.({ stage: 'initializing', progress: 0, message: 'Starting mesh repair...' });
    await yieldToUI();
    
    let currentGeometry = geometry;
    
    // Step 1: Convert to non-indexed for consistent processing
    onProgress?.({ stage: 'repairing', progress: 10, message: 'Normalizing geometry...' });
    await yieldToUI();
    
    currentGeometry = toNonIndexed(currentGeometry);
    repairSteps.push('Converted to non-indexed geometry');
    
    // Step 2: Weld vertices with increasing tolerance until we get a reasonable result
    onProgress?.({ stage: 'repairing', progress: 20, message: 'Welding vertices...' });
    await yieldToUI();
    
    const tolerances = [1e-6, 1e-5, 1e-4, 1e-3];
    let weldedGeometry = currentGeometry;
    
    for (const tolerance of tolerances) {
      const welded = weldVertices(currentGeometry, tolerance);
      const weldedVertCount = welded.getAttribute('position').count;
      const originalVertCount = currentGeometry.getAttribute('position').count;
      
      if (weldedVertCount < originalVertCount * 0.99) {
        // Significant vertex reduction, use this tolerance
        weldedGeometry = welded;
        repairSteps.push(`Welded vertices (tolerance: ${tolerance}, ${originalVertCount} → ${weldedVertCount} vertices)`);
        break;
      }
    }
    
    currentGeometry = weldedGeometry;
    
    // Step 3: Remove degenerate triangles
    onProgress?.({ stage: 'repairing', progress: 35, message: 'Removing degenerate triangles...' });
    await yieldToUI();
    
    const cleanedGeometry = removeDegenerateTriangles(currentGeometry);
    const cleanedTriCount = cleanedGeometry.index ? cleanedGeometry.index.count / 3 : cleanedGeometry.getAttribute('position').count / 3;
    const prevTriCount = currentGeometry.index ? currentGeometry.index.count / 3 : currentGeometry.getAttribute('position').count / 3;
    
    if (cleanedTriCount < prevTriCount) {
      repairSteps.push(`Removed ${prevTriCount - cleanedTriCount} degenerate triangles`);
    }
    currentGeometry = cleanedGeometry;
    
    // Step 4: Try to convert through Manifold3D for final repair
    onProgress?.({ stage: 'repairing', progress: 50, message: 'Attempting Manifold3D repair...' });
    await yieldToUI();
    
    const wasm = await getManifoldModule();
    const { Manifold } = wasm;
    
    // Convert to non-indexed for Manifold
    const nonIndexedGeometry = toNonIndexed(currentGeometry);
    
    try {
      const mesh = threeGeometryToManifoldMesh(nonIndexedGeometry, wasm);
      const manifold = new Manifold(mesh);
      
      if (!manifold.isEmpty()) {
        // Success! Get the repaired mesh
        const repairedMesh = manifold.getMesh();
        const finalGeometry = manifoldMeshToThreeGeometry(repairedMesh);
        const finalTriangles = manifold.numTri();
        
        repairSteps.push('Successfully converted to manifold geometry');
        
        // Cleanup
        repairedMesh.delete?.();
        manifold.delete();
        mesh.delete?.();
        
        onProgress?.({ stage: 'complete', progress: 100, message: 'Repair complete - mesh is manifold' });
        
        return {
          success: true,
          geometry: finalGeometry,
          originalTriangles,
          finalTriangles,
          repairSteps,
          isManifold: true,
        };
      } else {
        manifold.delete();
        mesh.delete?.();
        throw new Error('Manifold conversion resulted in empty mesh');
      }
    } catch (manifoldError) {
      // Manifold conversion failed - return the pre-processed geometry
      const errorMsg = manifoldError instanceof Error ? manifoldError.message : 'Unknown error';
      repairSteps.push(`Manifold3D conversion failed: ${errorMsg}`);
      repairSteps.push('Returning pre-processed geometry (may have manifold issues)');
      
      // Convert back to non-indexed for export
      const finalGeometry = toNonIndexed(currentGeometry);
      const finalPositions = finalGeometry.getAttribute('position');
      const finalTriangles = finalPositions ? finalPositions.count / 3 : 0;
      
      onProgress?.({ stage: 'complete', progress: 100, message: 'Repair complete - geometry processed but may have issues' });
      
      return {
        success: true, // We still return the processed geometry
        geometry: finalGeometry,
        originalTriangles,
        finalTriangles,
        repairSteps,
        isManifold: false, // Mark as not guaranteed manifold
      };
    }
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[MeshRepairForExport] ✗ Repair failed:', errorMessage);
    
    return {
      success: false,
      geometry: null,
      originalTriangles,
      finalTriangles: 0,
      repairSteps,
      isManifold: false,
      error: errorMessage,
    };
  }
}

/**
 * Pre-initialize the Manifold module
 * Call this early in the app lifecycle to avoid delays when first using the service
 */
export async function initManifold(): Promise<boolean> {
  try {
    await getManifoldModule();
    return true;
  } catch (error) {
    console.error('[ManifoldMeshService] Failed to initialize:', error);
    return false;
  }
}
