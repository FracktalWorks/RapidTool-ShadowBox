/**
 * Labels feature — embossed 3D text labels on the tray (ported from RapidTool-Fixture).
 */
export * from './types';
export { labelLocalTransform, trayTopZ } from './placement';
export { default as LabelMesh } from './LabelMesh';
export { default as LabelsLayer } from './LabelsLayer';
export { buildLabelGeometry } from './buildLabelGeometry';
