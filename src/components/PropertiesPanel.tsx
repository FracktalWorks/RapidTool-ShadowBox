/**
 * PropertiesPanel
 *
 * Right-side "Properties" panel — mirrors RapidTool-Fixture's PartPropertiesAccordion
 * slot. Shows editable properties for the current selection:
 *   - a selected layout shape  → position / size / rotation (live-editable)
 *   - a selected tool outline   → name + dimension summary
 *   - the 3D design step        → key design-settings summary
 *   - nothing selected          → clean empty state
 *
 * Scoped to the existing selection state (layoutState.selectedShapeId,
 * selectedOutlineId); no new selection machinery.
 */

import React from 'react';
import { MousePointer2, Box, Ruler, RotateCw } from 'lucide-react';
import { useAppStore } from '../stores';

// ── Small labelled number field ────────────────────────────────────────────
const NumField: React.FC<{
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  suffix?: string;
}> = ({ label, value, onChange, step = 1, suffix }) => (
  <label className="flex flex-col gap-1">
    <span className="text-[10px] font-tech uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
      {label}
    </span>
    <div className="flex items-center gap-1">
      <input
        type="number"
        value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0}
        step={step}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-full bg-[hsl(var(--muted)/0.4)] border border-[hsl(var(--border)/0.6)] rounded-md px-2 py-1 text-xs font-tech text-[hsl(var(--foreground))] focus:outline-none focus:ring-1 focus:ring-[hsl(var(--primary))]"
      />
      {suffix && <span className="text-[10px] text-[hsl(var(--muted-foreground))]">{suffix}</span>}
    </div>
  </label>
);

const SectionTitle: React.FC<{ icon: React.ReactNode; children: React.ReactNode }> = ({ icon, children }) => (
  <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[hsl(var(--foreground))]">
    <span className="text-[hsl(var(--primary))]">{icon}</span>
    {children}
  </div>
);

export const PropertiesPanel: React.FC = () => {
  const {
    currentStep,
    layoutState,
    updateLayoutShape,
    toolOutlines,
    selectedOutlineId,
    designSettings,
    pixelsPerMm,
  } = useAppStore();

  const selectedShape = layoutState.shapes.find((s) => s.id === layoutState.selectedShapeId) || null;
  const selectedOutline = toolOutlines.find((o) => o.id === selectedOutlineId) || null;

  // 1) A layout shape is selected → full transform editor
  if (selectedShape) {
    const s = selectedShape;
    return (
      <div className="flex flex-col gap-4 text-[hsl(var(--foreground))]">
        <SectionTitle icon={<Box className="w-3.5 h-3.5" />}>
          {s.type === 'tool' ? 'Tool Cutout' : s.type.charAt(0).toUpperCase() + s.type.slice(1)}
        </SectionTitle>

        <div className="flex flex-col gap-2">
          <SectionTitle icon={<MousePointer2 className="w-3 h-3" />}>Position</SectionTitle>
          <div className="grid grid-cols-2 gap-2">
            <NumField label="X" value={s.x} suffix="mm" onChange={(v) => updateLayoutShape(s.id, { x: v })} />
            <NumField label="Y" value={s.y} suffix="mm" onChange={(v) => updateLayoutShape(s.id, { y: v })} />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <SectionTitle icon={<Ruler className="w-3 h-3" />}>Size</SectionTitle>
          <div className="grid grid-cols-2 gap-2">
            <NumField label="Width" value={s.width} suffix="mm" onChange={(v) => updateLayoutShape(s.id, { width: Math.max(1, v) })} />
            <NumField label="Height" value={s.height} suffix="mm" onChange={(v) => updateLayoutShape(s.id, { height: Math.max(1, v) })} />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <SectionTitle icon={<RotateCw className="w-3 h-3" />}>Rotation</SectionTitle>
          <NumField label="Angle" value={s.rotation} step={5} suffix="°" onChange={(v) => updateLayoutShape(s.id, { rotation: v })} />
        </div>
      </div>
    );
  }

  // 2) A tool outline is selected → dimension summary
  if (selectedOutline) {
    const { boundingBox } = selectedOutline;
    const w = boundingBox.maxX - boundingBox.minX;
    const h = boundingBox.maxY - boundingBox.minY;
    const ppm = pixelsPerMm;
    return (
      <div className="flex flex-col gap-3 text-[hsl(var(--foreground))]">
        <SectionTitle icon={<Box className="w-3.5 h-3.5" />}>Traced Tool</SectionTitle>
        <dl className="flex flex-col gap-1.5 text-xs">
          <Row k="Points" v={`${(selectedOutline.regularizedPoints ?? selectedOutline.smoothedPoints).length}`} />
          <Row k="Width" v={ppm ? `${(w / ppm).toFixed(1)} mm` : `${Math.round(w)} px`} />
          <Row k="Height" v={ppm ? `${(h / ppm).toFixed(1)} mm` : `${Math.round(h)} px`} />
        </dl>
      </div>
    );
  }

  // 3) Design step → settings summary
  if (currentStep === 'design') {
    return (
      <div className="flex flex-col gap-3 text-[hsl(var(--foreground))]">
        <SectionTitle icon={<Box className="w-3.5 h-3.5" />}>Design Summary</SectionTitle>
        <dl className="flex flex-col gap-1.5 text-xs">
          <Row k="Base height" v={`${designSettings.baseHeight} mm`} />
          <Row k="Cutout depth" v={`${designSettings.cutoutDepth} mm`} />
          <Row k="Chamfer" v={`${designSettings.chamferSize} mm`} />
          <Row k="Gridfinity base" v={designSettings.gridfinityBase ? 'On' : 'Off'} />
          <Row k="Cutouts" v={`${layoutState.shapes.length}`} />
        </dl>
      </div>
    );
  }

  // 4) Empty state
  return (
    <div className="h-full flex flex-col items-center justify-center text-center gap-2 px-4 text-[hsl(var(--muted-foreground))]">
      <MousePointer2 className="w-6 h-6 opacity-40" />
      <p className="text-xs font-tech">Select an item to edit its properties</p>
    </div>
  );
};

const Row: React.FC<{ k: string; v: string }> = ({ k, v }) => (
  <div className="flex items-center justify-between">
    <dt className="text-[hsl(var(--muted-foreground))]">{k}</dt>
    <dd className="font-tech text-[hsl(var(--foreground))]">{v}</dd>
  </div>
);

export default PropertiesPanel;
