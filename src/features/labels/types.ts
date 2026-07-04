/**
 * Label Types and Constants  (ported from RapidTool-Fixture)
 *
 * Configuration for 3D embossed text labels placed on the tray. Kept close to the
 * Fixture original so the data model + export logic port cleanly.
 */

import * as THREE from 'three';

/** Available font families for labels */
export type LabelFont = 'helvetiker' | 'roboto' | 'arial';

interface FontOption {
  value: LabelFont;
  label: string;
  file: string;
}

/** Available fonts (typeface.json files live in /public/fonts) */
export const LABEL_FONTS: readonly FontOption[] = [
  { value: 'helvetiker', label: 'Helvetica Bold', file: '/fonts/helvetiker_bold.typeface.json' },
  { value: 'roboto', label: 'Roboto Bold', file: '/fonts/roboto_bold.typeface.json' },
  { value: 'arial', label: 'Arial Bold', file: '/fonts/arial_bold.typeface.json' },
] as const;

const DEFAULT_FONT = LABEL_FONTS[0];

/** Font file path for a family (falls back to default). */
export const getFontFile = (font: LabelFont): string =>
  LABEL_FONTS.find((f) => f.value === font)?.file ?? DEFAULT_FONT.file;

/** Size constraints (mm) */
export const MIN_FONT_SIZE = 5;
export const MAX_FONT_SIZE = 50;
export const MIN_DEPTH = 0.6;
export const MAX_DEPTH = 5;
export const DEFAULT_DEPTH = 1;
export const DEFAULT_FONT_SIZE = 8;

export type LabelPosition = THREE.Vector3 | { x: number; y: number; z: number };
export type LabelRotation = THREE.Euler | { x: number; y: number; z: number };

/** Configuration for a single 3D text label. */
export interface LabelConfig {
  id: string;
  text: string;
  /** Font size in mm */
  fontSize: number;
  /** Emboss (raise) height in mm */
  depth: number;
  font: LabelFont;
  /** Position on the tray — x/y are mm from tray centre (z is derived to the top surface). */
  position: LabelPosition;
  /** Rotation — z is the in-plane spin on the top surface (radians). */
  rotation: LabelRotation;
  computedWidth?: number;
  computedHeight?: number;
}

/** Defaults for a new label (id/position filled in by the caller). */
export const DEFAULT_LABEL_CONFIG: Omit<LabelConfig, 'id' | 'position'> = {
  text: 'V1.0',
  fontSize: DEFAULT_FONT_SIZE,
  depth: DEFAULT_DEPTH,
  font: 'helvetiker',
  rotation: new THREE.Euler(0, 0, 0),
};

/** LabelPosition → THREE.Vector3 (identity if already a Vector3). */
export const toVector3 = (pos: LabelPosition): THREE.Vector3 =>
  pos instanceof THREE.Vector3 ? pos : new THREE.Vector3(pos.x, pos.y, pos.z);

/** LabelRotation → THREE.Euler (identity if already an Euler). */
export const toEuler = (rot: LabelRotation): THREE.Euler =>
  rot instanceof THREE.Euler ? rot : new THREE.Euler(rot.x, rot.y, rot.z);

/** Numeric axis value from a LabelPosition. */
export const getPositionAxis = (pos: LabelPosition, axis: 'x' | 'y' | 'z'): number =>
  pos instanceof THREE.Vector3 ? pos[axis] : (pos[axis] ?? 0);

/** Z-rotation (radians) from a LabelRotation. */
export const getRotationZ = (rot: LabelRotation): number =>
  rot instanceof THREE.Euler ? rot.z : (rot.z ?? 0);
