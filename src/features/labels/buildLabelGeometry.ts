/**
 * buildLabelGeometry  (ported from RapidTool-Fixture csgUtils)
 *
 * Turns a LabelConfig into embossed text geometry in the tray's LOCAL space, ready
 * to merge into the export mesh. Uses the same placement as LabelsLayer so the STL
 * matches the preview; the text is sunk EMBED_DEPTH into the surface so the union is
 * watertight, while the VISIBLE raise above the surface stays exactly `label.depth`.
 */
import * as THREE from 'three';
import type { LabelConfig } from './types';
import { getFontFile, getPositionAxis, getRotationZ } from './types';

/** How far to bury the text base into the tray top for a solid (overlapping) union. */
const EMBED_DEPTH = 0.4;

export async function buildLabelGeometry(
  label: LabelConfig,
  topZ: number,
): Promise<THREE.BufferGeometry | null> {
  try {
    const { FontLoader } = await import('three/addons/loaders/FontLoader.js');
    const { TextGeometry } = await import('three/addons/geometries/TextGeometry.js');

    const loader = new FontLoader();
    const fontFile = getFontFile(label.font ?? 'helvetiker');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const font = await new Promise<any>((resolve, reject) =>
      loader.load(fontFile, resolve, undefined, reject));

    const geo = new TextGeometry(label.text || 'Label', {
      font,
      size: Math.max(0.1, label.fontSize),
      // NOTE: three r150+ TextGeometry uses `depth` (not `height`) for the extrusion,
      // and DEFAULTS it to 50 when omitted — passing `height` here silently gave 50mm
      // tall spikes. The visible raise above the surface stays = label.depth.
      depth: Math.max(0.1, label.depth) + EMBED_DEPTH,
      curveSegments: 4,
      bevelEnabled: false,
    });

    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    if (!bb || bb.max.x - bb.min.x < 0.001) { geo.dispose?.(); return null; }

    // Centre in XY (match LabelMesh); base at z=0 (extrudes +Z).
    geo.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, 0);

    // Rotate about Z, then move onto the tray top (sunk by EMBED_DEPTH), in local space.
    const x = getPositionAxis(label.position, 'x');
    const y = getPositionAxis(label.position, 'y');
    const m = new THREE.Matrix4()
      .makeRotationZ(getRotationZ(label.rotation))
      .premultiply(new THREE.Matrix4().makeTranslation(x, y, topZ - EMBED_DEPTH));
    geo.applyMatrix4(m);
    geo.computeVertexNormals();
    return geo;
  } catch (err) {
    console.error('[buildLabelGeometry] failed for', label.text, err);
    return null;
  }
}
