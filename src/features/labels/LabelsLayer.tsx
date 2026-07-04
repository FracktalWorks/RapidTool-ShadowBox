/**
 * LabelsLayer
 *
 * Renders every store label resting on the tray's ACTUAL top surface at its X/Y —
 * a downward raycast against the tray mesh finds the solid directly beneath (pocket
 * floor when over a pocket, rim when over the frame), so labels never float. Matches
 * how Fixture places labels. Mounted inside DesignWorkspace's tool-holder group (it
 * shares the tray's local space + the group's -90° view rotation); `trayRef` points
 * at a sibling group holding ONLY the tray meshes (so we never self-hit a label).
 */
import React, { Suspense, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useAppStore } from '../../stores';
import LabelMesh from './LabelMesh';
import { trayTopZ } from './placement';
import { getPositionAxis, getRotationZ, type LabelConfig } from './types';

interface LabelsLayerProps {
  trayRef: React.RefObject<THREE.Group | null>;
}

export const LabelsLayer: React.FC<LabelsLayerProps> = ({ trayRef }) => {
  const labels = useAppStore((s) => s.labels);
  const selectedLabelId = useAppStore((s) => s.selectedLabelId);
  const selectLabel = useAppStore((s) => s.selectLabel);
  const settings = useAppStore((s) => s.designSettings);

  const topZ = trayTopZ(settings.baseHeight, settings.cutoutDepth);

  // Local-space surface Z per label, found by raycasting; falls back to topZ.
  const [surfaceZ, setSurfaceZ] = useState<Record<string, number>>({});
  const sigRef = useRef<Record<string, string>>({}); // only re-raycast when x/y/height change

  const rc = useMemo(() => new THREE.Raycaster(), []);
  const _o = useMemo(() => new THREE.Vector3(), []);
  const _d = useMemo(() => new THREE.Vector3(), []);
  const _q = useMemo(() => new THREE.Quaternion(), []);
  const _inv = useMemo(() => new THREE.Matrix4(), []);
  const _p = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    const tray = trayRef.current;
    if (!tray || labels.length === 0) return;
    tray.updateWorldMatrix(true, true);
    tray.getWorldQuaternion(_q);
    _inv.copy(tray.matrixWorld).invert();

    let changed = false;
    const next = { ...surfaceZ };
    for (const label of labels) {
      const x = getPositionAxis(label.position, 'x');
      const y = getPositionAxis(label.position, 'y');
      const sig = `${x.toFixed(2)},${y.toFixed(2)},${topZ.toFixed(2)}`;
      if (sigRef.current[label.id] === sig && surfaceZ[label.id] !== undefined) continue;

      // Cast from high above the tray top (local +Z) straight down (local -Z).
      _o.set(x, y, topZ + 100).applyMatrix4(tray.matrixWorld);
      _d.set(0, 0, -1).applyQuaternion(_q).normalize();
      rc.set(_o, _d);
      const hits = rc.intersectObjects(tray.children, true);
      if (hits.length === 0) continue; // tray geometry not ready yet — retry next frame

      _p.copy(hits[0].point).applyMatrix4(_inv);
      const z = _p.z;
      if (Math.abs((surfaceZ[label.id] ?? -1e6) - z) > 0.02) { next[label.id] = z; changed = true; }
      sigRef.current[label.id] = sig; // only cache once we've actually snapped to a surface
    }
    if (changed) setSurfaceZ(next);
  });

  if (labels.length === 0) return null;

  return (
    // Text3D suspends while its font loads — our own boundary (Canvas has none).
    <Suspense fallback={null}>
      {labels.map((label) => {
        const z = surfaceZ[label.id] ?? topZ;
        const placed: LabelConfig = {
          ...label,
          position: new THREE.Vector3(getPositionAxis(label.position, 'x'), getPositionAxis(label.position, 'y'), z),
          rotation: new THREE.Euler(0, 0, getRotationZ(label.rotation)),
        };
        return (
          <LabelMesh key={label.id} label={placed} selected={label.id === selectedLabelId} onSelect={selectLabel} />
        );
      })}
    </Suspense>
  );
};

export default LabelsLayer;
