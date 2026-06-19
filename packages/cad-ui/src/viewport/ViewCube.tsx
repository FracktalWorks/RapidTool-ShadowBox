import React, { useRef, useEffect, useState } from 'react';
import * as THREE from 'three';

interface ViewCubeProps {
  onViewChange: (orientation: string) => void;
  className?: string;
  size?: number;
}

const ViewCube: React.FC<ViewCubeProps> = ({ onViewChange, className = '', size = 120 }) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene>();
  const rendererRef = useRef<THREE.WebGLRenderer>();
  const cameraRef = useRef<THREE.Camera>();
  const cubeRef = useRef<THREE.Group>();
  const [hoveredFace, setHoveredFace] = useState<string | null>(null);
  const [hoveredArrow, setHoveredArrow] = useState<string | null>(null);
  const [activeFace, setActiveFace] = useState<string | null>(null);
  const faceOverlayMatsRef = useRef<Record<string, THREE.MeshBasicMaterial>>({});
  const faceOutlineMatsRef = useRef<Record<string, THREE.LineBasicMaterial>>({});
  const edgeMaterialRef = useRef<THREE.LineBasicMaterial | null>(null);
  const arrowMatsRef = useRef<Record<string, THREE.MeshBasicMaterial>>({});
  const overlayRef = useRef<THREE.Group | null>(null);
  const texturesRef = useRef<THREE.Texture[]>([]);

  useEffect(() => {
    // Clear textures array on each effect run
    texturesRef.current = [];
    
    if (!mountRef.current) return;

    // Scene setup
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1.5, 1.5, 1.5, -1.5, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    
    renderer.setSize(size, size);
    renderer.setClearColor(0x000000, 0);
    mountRef.current.appendChild(renderer.domElement);

    // Cube setup
    const cubeGroup = new THREE.Group();
    // Overlay group for UI (arcs + arrows) that stays in screen plane
    const overlayGroup = new THREE.Group();
    overlayGroup.renderOrder = 1000;
    overlayRef.current = overlayGroup;
    const geometry = new THREE.BoxGeometry(1, 1, 1);

    // Create visible cube faces with white material
    const faceMaterials = [
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.FrontSide }), // Right
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.FrontSide }), // Left
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.FrontSide }), // Top
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.FrontSide }), // Bottom
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.FrontSide }), // Front
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.FrontSide })  // Back
    ];

    const visibleCube = new THREE.Mesh(geometry, faceMaterials);
    visibleCube.scale.set(1.2, 1.2, 1.2); // Apply scaling to visible cube
    visibleCube.position.y = -0.1; // Apply positioning to visible cube
    cubeGroup.add(visibleCube);

    // Invisible interaction mesh with 6 materials to preserve face indices for raycasting
    const invisibleMats: THREE.Material[] = [0,1,2,3,4,5].map(() => new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      side: THREE.FrontSide,
    }));
    const interactionCube = new THREE.Mesh(geometry, invisibleMats);
    interactionCube.scale.set(1.2, 1.2, 1.2); // Match the visible cube scaling
    interactionCube.position.y = -0.1; // Match the visible cube positioning
    cubeGroup.add(interactionCube);

    // Clean edges using EdgesGeometry (outer cube)
    const edges = new THREE.EdgesGeometry(geometry, 1);
    const edgeLines = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ 
        color: 0x111111, 
        transparent: true, 
        opacity: 1,
        linewidth: 2.5  // outer
      })
    );
    edgeLines.scale.set(1.2, 1.2, 1.2); // Match cube scaling
    edgeLines.position.y = -0.1; // Match cube positioning
    edgeLines.renderOrder = 1;
    cubeGroup.add(edgeLines);
    edgeMaterialRef.current = edgeLines.material as THREE.LineBasicMaterial;

    // Inner cube for contrast (slightly smaller)
    const innerGeom = new THREE.BoxGeometry(1, 1, 1);
    const innerEdges = new THREE.EdgesGeometry(innerGeom, 1);
    const innerLines = new THREE.LineSegments(
      innerEdges,
      new THREE.LineBasicMaterial({ 
        color: 0x444444, 
        transparent: true, 
        opacity: 0.9,
        linewidth: 1.25  // inner
      })
    );
    innerLines.scale.set(0.85, 0.85, 0.85);
    innerLines.position.y = -0.1; // Match cube positioning
    innerLines.renderOrder = 0;
    cubeGroup.add(innerLines);

    // Slightly enlarge the entire cube group for better visibility - removed since we apply to individual cubes
    // cubeGroup.scale.set(1.2, 1.2, 1.2);
    // Nudge cube a bit downward to avoid top arrow clipping - removed since we apply to individual cubes
    // cubeGroup.position.y = -0.1;

    // Add labels (uppercase) using canvas sprites
    const labelTexts = ['RIGHT', 'LEFT', 'TOP', 'BOTTOM', 'FRONT', 'BACK'];
    const labelPositions = [
      new THREE.Vector3(0.7, 0, 0),    // Right - moved further out
      new THREE.Vector3(-0.7, 0, 0),   // Left - moved further out
      new THREE.Vector3(0, 0.7, 0),    // Top - moved further out
      new THREE.Vector3(0, -0.7, 0),   // Bottom - moved further out
      new THREE.Vector3(0, 0, 0.7),    // Front - moved further out
      new THREE.Vector3(0, 0, -0.7)    // Back - moved further out
    ];
    // All labels are rendered; depth testing hides back faces naturally
    
    labelTexts.forEach((t, index) => {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d')!;
      canvas.width = 128;
      canvas.height = 128;
      
      context.fillStyle = '#111111';
      context.strokeStyle = 'rgba(0,0,0,0.35)';
      context.lineWidth = 3;
      context.font = '600 40px system-ui';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      const text = String(t || '').toUpperCase();
      context.strokeText(text, 64, 64);
      context.fillText(text, 64, 64);
      
      const texture = new THREE.CanvasTexture(canvas);
      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      texturesRef.current.push(texture); // Track for disposal
      const spriteMaterial = new THREE.SpriteMaterial({ 
        map: texture, 
        transparent: true,
        depthTest: true,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(spriteMaterial);
      sprite.position.copy(labelPositions[index]);
      sprite.position.multiplyScalar(1.2); // Scale label positions to match cube scaling
      sprite.position.y -= 0.1; // Apply cube positioning to labels
      sprite.scale.set(0.42, 0.42, 1); // Larger for legibility
      sprite.renderOrder = 1000;
      sprite.frustumCulled = false;
      cubeGroup.add(sprite);
    });

    // Curved arc guides (fixed in screen plane, overlay)
    const makeArc = (radius: number, start: number, end: number, segments = 48) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= segments; i++) {
        const t = start + (end - start) * (i / segments);
        const x = Math.cos(t) * radius;
        const y = Math.sin(t) * radius;
        // Draw in screen plane (x,y,0) so curvature is visible when overlay is camera-aligned
        pts.push(new THREE.Vector3(x, y, 0));
      }
      const geom = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({ color: 0x9ca3af, transparent: true, opacity: 0.9, depthTest: false });
      const line = new THREE.Line(geom, mat);
      line.renderOrder = 1000;
      (line as any).frustumCulled = false;
      return line;
    };
    const arcLeft = makeArc(1.1, Math.PI * 0.60, Math.PI * 0.95);
    const arcRight = makeArc(1.1, Math.PI * 0.05, Math.PI * 0.40);
    arcLeft.position.y = 0.95;
    arcRight.position.y = 0.95;
    overlayGroup.add(arcLeft);
    overlayGroup.add(arcRight);

    // Corner/side arrows as cones (as per reference), in overlay screen plane
    const arrows: { mesh: THREE.Mesh; id: string; mat: THREE.MeshBasicMaterial }[] = [];
    const coneGeom = new THREE.ConeGeometry(0.14, 0.34, 24);
    const addArrow = (id: string, pos: THREE.Vector3, rot: THREE.Euler) => {
      const mat = new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
      const m = new THREE.Mesh(coneGeom, mat);
      m.position.copy(pos);
      // Keep arrows in overlay group (screen plane)
      m.rotation.copy(rot);
      m.renderOrder = 1500;
      (m as any).frustumCulled = false;
      overlayGroup.add(m);
      arrows.push({ mesh: m, id, mat });
      arrowMatsRef.current[id] = mat;
    };
    // Place arrows with a gap away from the cube on 4 sides
    const gap = 1.25; // further from cube, still within ortho frustum (±1.5)
    addArrow('right', new THREE.Vector3(gap, 0, 0), new THREE.Euler(0, 0, -Math.PI / 2));   // +X
    addArrow('left', new THREE.Vector3(-gap, 0, 0), new THREE.Euler(0, 0, Math.PI / 2));   // -X
    addArrow('top', new THREE.Vector3(0, gap, 0), new THREE.Euler(0, 0, 0));               // +Y
    addArrow('bottom', new THREE.Vector3(0, -gap, 0), new THREE.Euler(Math.PI, 0, 0));     // -Y
    // store mats per id in arrowMatsRef (already filled during addArrow)

    // Parent overlay to camera so it stays screen-aligned and always visible
    camera.add(overlayGroup);
    scene.add(camera);

    scene.add(cubeGroup);
    camera.position.set(3, 3, 3);
    camera.lookAt(0, 0, 0);

    sceneRef.current = scene;
    rendererRef.current = renderer;
    cameraRef.current = camera;
    cubeRef.current = cubeGroup;

    // Add subtle face highlight overlays (hover/active)
    const faces: Array<{ name: string; normal: THREE.Vector3; up: THREE.Vector3 }> = [
      { name: 'right', normal: new THREE.Vector3( 1, 0, 0), up: new THREE.Vector3(0, 1, 0) },
      { name: 'left',  normal: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 1, 0) },
      { name: 'top',   normal: new THREE.Vector3( 0, 1, 0), up: new THREE.Vector3(0, 0, 1) },
      { name: 'bottom',normal: new THREE.Vector3( 0,-1, 0), up: new THREE.Vector3(0, 0, 1) },
      { name: 'front', normal: new THREE.Vector3( 0, 0, 1), up: new THREE.Vector3(0, 1, 0) },
      { name: 'back',  normal: new THREE.Vector3( 0, 0,-1), up: new THREE.Vector3(0, 1, 0) },
    ];
    const overlaySize = 0.9; // slightly inset
    faces.forEach(f => {
      const mat = new THREE.MeshBasicMaterial({ color: 0xea580c, transparent: true, opacity: 0, depthTest: true, depthWrite: false });
      const plane = new THREE.PlaneGeometry(overlaySize, overlaySize);
      const overlay = new THREE.Mesh(plane, mat);

      // Orient overlay to face and position slightly above face
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), f.normal.clone());
      overlay.quaternion.copy(q);
      overlay.position.copy(f.normal.clone().multiplyScalar(0.51));
      overlay.scale.set(1.0, 1.0, 1.0);
      // match group transform and add to scene
      overlay.position.multiplyScalar(1.2);
      overlay.position.y -= 0.1;
      overlay.renderOrder = 2;
      cubeGroup.add(overlay);
      faceOverlayMatsRef.current[f.name] = mat;

      // Active outline rectangle over the same face
      const half = overlaySize / 2;
      const outlineGeom = new THREE.BufferGeometry();
      const outlinePositions = new Float32Array([
        -half, -half, 0,   half, -half, 0,
         half, -half, 0,   half,  half, 0,
         half,  half, 0,  -half,  half, 0,
        -half,  half, 0,  -half, -half, 0,
      ]);
      outlineGeom.setAttribute('position', new THREE.BufferAttribute(outlinePositions, 3));
      const outlineMat = new THREE.LineBasicMaterial({ color: 0xea580c, transparent: true, opacity: 0, depthTest: true, depthWrite: false });
      const outline = new THREE.LineSegments(outlineGeom, outlineMat);
      outline.quaternion.copy(overlay.quaternion);
      outline.position.copy(overlay.position);
      outline.position.multiplyScalar(1.0);
      outline.renderOrder = 3;
      cubeGroup.add(outline);
      faceOutlineMatsRef.current[f.name] = outlineMat;

      // Corner squares at face rectangle corners (visible faces only via depth test)
      const cornerSize = 0.09;
      const cornerGeom = new THREE.PlaneGeometry(cornerSize, cornerSize);
      const cornerMat = new THREE.MeshBasicMaterial({ color: 0x4b5563, transparent: true, opacity: 0.95, depthTest: true, depthWrite: false });
      const corners = new THREE.Group();
      corners.quaternion.copy(overlay.quaternion);
      corners.position.copy(overlay.position);
      // Use existing 'half' from above for corner placement
      const cpos = [
        new THREE.Vector3(-half, -half, 0),
        new THREE.Vector3( half, -half, 0),
        new THREE.Vector3( half,  half, 0),
        new THREE.Vector3(-half,  half, 0),
      ];
      cpos.forEach(p => {
        const sq = new THREE.Mesh(cornerGeom, cornerMat.clone());
        sq.position.copy(p);
        sq.renderOrder = 3;
        corners.add(sq);
      });
      corners.position.multiplyScalar(1.0);
      cubeGroup.add(corners);
    });

    // Raycaster for mouse interaction
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let isDragging = false;
    let previousMousePosition = { x: 0, y: 0 };

    const handleMouseMove = (event: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      if (isDragging) {
        const deltaMove = {
          x: event.clientX - previousMousePosition.x,
          y: event.clientY - previousMousePosition.y
        };
        cubeGroup.rotation.y += deltaMove.x * 0.01;
        cubeGroup.rotation.x += deltaMove.y * 0.01;
        // Publish cube quaternion directly so main viewer camera matches the cube orientation
        const q = new THREE.Quaternion();
        cubeGroup.getWorldQuaternion(q);
        const arr: [number, number, number, number] = [q.x, q.y, q.z, q.w];
        window.dispatchEvent(new CustomEvent('viewer-camera-set-quaternion', { detail: { q: arr } }));
        event.stopPropagation();
        event.preventDefault();
      } else {
        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects([interactionCube, ...arrows.map(a => a.mesh)]);

        if (intersects.length > 0) {
          const obj = intersects[0].object;
          if (obj === interactionCube) {
            const faceIndex = intersects[0].face?.materialIndex;
            const faceNames = ['right', 'left', 'top', 'bottom', 'front', 'back'];
            setHoveredFace(faceNames[faceIndex || 0]);
            setHoveredArrow(null);
          } else {
            const arrow = arrows.find(a => a.mesh === obj);
            if (arrow) {
              setHoveredArrow(arrow.id);
              setHoveredFace(null);
            } else {
              setHoveredArrow(null);
              setHoveredFace(null);
            }
          }
          renderer.domElement.style.cursor = 'pointer';
        } else {  
          setHoveredFace(null);
          setHoveredArrow(null);
          renderer.domElement.style.cursor = 'default';
        }
      }

      previousMousePosition = { x: event.clientX, y: event.clientY };
    };

    const handleMouseDown = (event: MouseEvent) => {
      isDragging = true;
      previousMousePosition = { x: event.clientX, y: event.clientY };
      event.stopPropagation();
      event.preventDefault();
    };

    const handleMouseUp = () => {
      isDragging = false;
    };

    const handleClick = (event: MouseEvent) => {
      if (isDragging) return; // Don't handle click if we were dragging
      
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects([interactionCube, ...arrows.map(a => a.mesh)]);

      if (intersects.length > 0) {
        const obj = intersects[0].object;
        if (obj === interactionCube) {
          const faceIndex = intersects[0].face?.materialIndex;
          const faceNames = ['right', 'left', 'top', 'bottom', 'front', 'back'];
          onViewChange(faceNames[faceIndex || 0]);
        } else {
          const arrow = arrows.find(a => a.mesh === obj);
          if (arrow) {
            onViewChange(arrow.id);
          }
        }
      }
    };

    renderer.domElement.addEventListener('mousemove', handleMouseMove);
    renderer.domElement.addEventListener('mousedown', handleMouseDown);
    renderer.domElement.addEventListener('mouseup', handleMouseUp);
    renderer.domElement.addEventListener('click', handleClick);

    // Double-click: advance to next face based on last hovered face, or trigger arrow orientation
    const handleDblClick = (event: MouseEvent) => {
      if (!renderer || !camera) return;
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects([interactionCube, ...arrows.map(a => a.mesh)]);

      const cycleOrder = ['front', 'right', 'back', 'left'];
      const faceNames = ['right', 'left', 'top', 'bottom', 'front', 'back'];

      if (intersects.length > 0) {
        const obj = intersects[0].object;
        if (obj === interactionCube) {
          const idx = intersects[0].face?.materialIndex ?? 0;
          const face = faceNames[idx];
          if (face === 'top' || face === 'bottom') {
            onViewChange(face === 'top' ? 'bottom' : 'top');
          } else {
            const i = cycleOrder.indexOf(face);
            const next = cycleOrder[(i + 1) % cycleOrder.length];
            onViewChange(next);
          }
        } else {
          const arrow = arrows.find(a => a.mesh === obj);
          if (arrow) onViewChange(arrow.id);
        }
      } else if (hoveredFace) {
        if (hoveredFace === 'top' || hoveredFace === 'bottom') {
          onViewChange(hoveredFace === 'top' ? 'bottom' : 'top');
        } else {
          const i = cycleOrder.indexOf(hoveredFace);
          const next = cycleOrder[(i + 1) % cycleOrder.length];
          onViewChange(next);
        }
      }
      event.preventDefault();
      event.stopPropagation();
    };
    renderer.domElement.addEventListener('dblclick', handleDblClick);

    // Animation loop
    const animate = () => {
      requestAnimationFrame(animate);
      // overlayGroup is parented to camera; no per-frame quaternion copy needed
      renderer.render(scene, camera);
    };
    animate();

    // Listen to camera changes from main viewer so cube follows camera
    const handleCameraChanged = (e: CustomEvent<{ q: [number, number, number, number] }>) => {
      if (!cubeGroup) return;
      const [x, y, z, w] = e.detail.q;
      // Apply camera quaternion directly so the cube shows what direction the camera is facing
      // The FRONT face should be visible when looking at the front of the model
      const q = new THREE.Quaternion(x, y, z, w);
      cubeGroup.setRotationFromQuaternion(q);
      // Determine active face from camera orientation (choose major axis of camera forward)
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(x, y, z, w));
      const comps = [
        { n: 'front', v:  forward.z },
        { n: 'back',  v: -forward.z },
        { n: 'right', v:  forward.x },
        { n: 'left',  v: -forward.x },
        { n: 'top',   v:  forward.y },
        { n: 'bottom',v: -forward.y },
      ];
      const max = comps.reduce((a, b) => (b.v > a.v ? b : a));
      // Add tolerance to avoid flicker near diagonals
      if (max.v > 0.35) setActiveFace(max.n);
    };

    window.addEventListener('viewer-camera-changed', handleCameraChanged as EventListener);

    return () => {
      renderer.domElement.removeEventListener('mousemove', handleMouseMove);
      renderer.domElement.removeEventListener('mousedown', handleMouseDown);
      renderer.domElement.removeEventListener('mouseup', handleMouseUp);
      renderer.domElement.removeEventListener('click', handleClick);
      renderer.domElement.removeEventListener('dblclick', handleDblClick);
      mountRef.current?.removeChild(renderer.domElement);
      
      // Dispose all textures to prevent WebGL immutable texture errors
      texturesRef.current.forEach(texture => texture.dispose());
      texturesRef.current = [];
      
      // Dispose all materials
      Object.values(faceOverlayMatsRef.current).forEach(mat => mat.dispose());
      Object.values(faceOutlineMatsRef.current).forEach(mat => mat.dispose());
      Object.values(arrowMatsRef.current).forEach(mat => mat.dispose());
      if (edgeMaterialRef.current) edgeMaterialRef.current.dispose();
      
      renderer.dispose();
      window.removeEventListener('viewer-camera-changed', handleCameraChanged as EventListener);
    };
  }, [onViewChange, size]);

  // Hover styling: slightly darken edges; tint the hovered arrow only
  useEffect(() => {
    if (edgeMaterialRef.current) {
      edgeMaterialRef.current.color.set(hoveredFace ? 0x000000 : 0x111111);
    }
    const mats = arrowMatsRef.current;
    Object.entries(mats).forEach(([id, mat]) => {
      const isHovered = hoveredArrow === id;
      mat.color.set(isHovered ? 0xea580c : 0x222222);
      mat.opacity = isHovered ? 1 : 0.95;
      mat.needsUpdate = true;
    });
  }, [hoveredFace, hoveredArrow]);

  // Update face overlay materials
  useEffect(() => {
    const mats = faceOverlayMatsRef.current;
    Object.keys(mats).forEach(key => {
      const mat = mats[key];
      if (!mat) return;
      if (activeFace === key) {
        mat.opacity = 0.6;
      } else if (hoveredFace === key) {
        mat.opacity = 0.35;
      } else {
        mat.opacity = 0;
      }
      mat.needsUpdate = true;
    });
  }, [hoveredFace, activeFace]);

  return (
    <div
      ref={mountRef}
      className={`view-cube ${className}`}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        background: 'transparent', // Transparent background
        borderRadius: '12px',
        overflow: 'hidden'
      }}
    />
  );
};

export default ViewCube;