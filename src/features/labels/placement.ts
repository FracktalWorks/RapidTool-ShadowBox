/**
 * Shared label placement — the ONE mapping used by both the 3D preview
 * (LabelsLayer, inside DesignWorkspace's tool-holder group) and the STL export
 * (buildLabelGeometry). Keeping a single source guarantees "what you see is what
 * prints".
 *
 * The tool-holder geometry is built in local space: footprint in XY (centred at
 * origin), extruded up along +Z. So a label lying on the TOP surface sits at
 * local z = baseHeight + cutoutDepth, with its face in the XY plane; Text3D /
 * TextGeometry extrude +Z, raising it off the surface (embossed).
 */
import * as THREE from 'three';
import { LabelConfig, getPositionAxis, getRotationZ } from './types';

/** Tray top-surface height (mm) in the mesh's local +Z (up). */
export const trayTopZ = (baseHeight: number, cutoutDepth: number): number =>
  baseHeight + cutoutDepth;

/**
 * Local-space transform for a label flat on the tray top. x/y are mm from the
 * tray centre; z is pinned to the current top surface; rotation.z is the in-plane
 * spin. Text extrudes +Z → raised/embossed.
 */
export function labelLocalTransform(
  label: LabelConfig,
  topZ: number,
): { position: THREE.Vector3; rotation: THREE.Euler } {
  return {
    position: new THREE.Vector3(
      getPositionAxis(label.position, 'x'),
      getPositionAxis(label.position, 'y'),
      topZ,
    ),
    rotation: new THREE.Euler(0, 0, getRotationZ(label.rotation)),
  };
}
