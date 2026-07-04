/**
 * LabelMesh  (ported from RapidTool-Fixture, trimmed)
 *
 * Renders a single embossed 3D text label with Text3D (drei). Computes bounds and
 * self-centres so the label's origin is its centre (the panel positions the centre).
 * Dropped Fixture-only navigation/context-menu events; kept select-on-click.
 */
import React, { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import * as THREE from 'three';
import { Text3D } from '@react-three/drei';
import { ThreeEvent, useFrame } from '@react-three/fiber';
import { LabelConfig, getFontFile, toVector3, toEuler } from './types';

const SELECTION_COLOR = 0x93c5fd;
const DEFAULT_COLOR = 0x9ca3af;
const PREVIEW_COLOR = 0x3b82f6;
const MIN_VALID_DIMENSION = 0.01;
const OFFSET_CHANGE_THRESHOLD = 0.01;
const _tempOffset = new THREE.Vector3();

interface LabelMeshProps {
  label: LabelConfig;
  preview?: boolean;
  selected?: boolean;
  onSelect?: (id: string) => void;
  onBoundsComputed?: (id: string, width: number, height: number) => void;
}

const makeMaterial = (preview: boolean, selected: boolean): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({
    color: preview ? PREVIEW_COLOR : selected ? SELECTION_COLOR : DEFAULT_COLOR,
    transparent: preview,
    opacity: preview ? 0.7 : 1,
    metalness: 0.1,
    roughness: 0.6,
    side: THREE.DoubleSide,
    emissive: selected ? SELECTION_COLOR : 0x000000,
    emissiveIntensity: selected ? 0.15 : 0,
  });

const LabelMesh: React.FC<LabelMeshProps> = ({ label, preview = false, selected = false, onSelect, onBoundsComputed }) => {
  const textRef = useRef<THREE.Mesh>(null);
  const boundsDoneRef = useRef(false);
  const [textOffset, setTextOffset] = useState(() => new THREE.Vector3(0, 0, 0));

  // Sanitise numeric params (bad values crash TextGeometry allocation).
  const safeFontSize = useMemo(() => {
    const s = label.fontSize;
    return Number.isFinite(s) && s > 0 && s <= 1000 ? s : 8;
  }, [label.fontSize]);
  const safeDepth = useMemo(() => {
    const d = label.depth;
    return Number.isFinite(d) && d > 0 && d <= 100 ? d : 1;
  }, [label.depth]);
  const safeText = useMemo(() => (label.text?.length ? label.text.substring(0, 100) : 'Label'), [label.text]);

  const materialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const material = useMemo(() => {
    materialRef.current?.dispose();
    const m = makeMaterial(preview, selected);
    materialRef.current = m;
    return m;
  }, [preview, selected]);
  useEffect(() => () => { materialRef.current?.dispose(); materialRef.current = null; }, []);

  const position = useMemo(() => toVector3(label.position), [label.position]);
  const rotation = useMemo(() => toEuler(label.rotation), [label.rotation]);
  const fontFile = useMemo(() => getFontFile(label.font ?? 'helvetiker'), [label.font]);

  // Reset centering when the text metrics change.
  useEffect(() => {
    boundsDoneRef.current = false;
    setTextOffset(new THREE.Vector3(0, 0, 0));
  }, [label.text, label.fontSize, label.font]);

  const handleClick = useCallback((e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onSelect?.(label.id);
  }, [label.id, onSelect]);

  // Centre the text on its bounding box each frame until stable.
  useFrame(() => {
    const mesh = textRef.current;
    if (!mesh?.geometry) return;
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox;
    if (!box) return;
    const width = box.max.x - box.min.x;
    const height = box.max.y - box.min.y;
    if (width < MIN_VALID_DIMENSION || height < MIN_VALID_DIMENSION) return;

    const cx = (box.min.x + box.max.x) / 2;
    const cy = (box.min.y + box.max.y) / 2;
    _tempOffset.set(-cx, -cy, 0);
    if (Math.abs(textOffset.x - _tempOffset.x) > OFFSET_CHANGE_THRESHOLD ||
        Math.abs(textOffset.y - _tempOffset.y) > OFFSET_CHANGE_THRESHOLD) {
      setTextOffset(new THREE.Vector3(-cx, -cy, 0));
    }
    if (!boundsDoneRef.current && onBoundsComputed) {
      boundsDoneRef.current = true;
      onBoundsComputed(label.id, width, height);
    }
  });

  return (
    <group position={position} rotation={rotation} onClick={handleClick}>
      <group position={textOffset}>
        <Text3D ref={textRef} font={fontFile} size={safeFontSize} height={safeDepth} curveSegments={4} bevelEnabled={false}>
          {safeText}
          <primitive object={material} attach="material" />
        </Text3D>
      </group>
    </group>
  );
};

export default React.memo(LabelMesh);
