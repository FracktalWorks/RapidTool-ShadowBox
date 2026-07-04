/**
 * LabelsStepPanel — left-panel UI for the Labels workflow step.
 *
 * Panel-driven (no 3D gizmo): a live 3D preview + text/font/size/emboss controls +
 * X/Y position and rotation fields. "Add Label" drops a label at tray centre; the
 * list below lets you select / edit / delete. All wired to the app store; the label
 * renders on the tray via LabelsLayer (DesignWorkspace) and prints via the export.
 */
import React, { useState, useEffect, useCallback, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { Center, Text3D, OrbitControls } from '@react-three/drei';
import { Type, Plus, Trash2, SkipForward, ChevronRight } from 'lucide-react';
import { useAppStore } from '../stores';
import {
  type LabelConfig,
  type LabelFont,
  LABEL_FONTS,
  getFontFile,
  getPositionAxis,
  getRotationZ,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_DEPTH,
  MAX_DEPTH,
  DEFAULT_DEPTH,
  DEFAULT_FONT_SIZE,
} from '../features/labels';

const radToDeg = (r: number) => (r * 180) / Math.PI;
const degToRad = (d: number) => (d * Math.PI) / 180;
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

const LabelPreview: React.FC<{ text: string; fontSize: number; depth: number; font: LabelFont }> = ({ text, fontSize, depth, font }) => (
  <Center scale={30 / Math.max(fontSize, 10)}>
    <Text3D font={getFontFile(font)} size={fontSize} height={depth} curveSegments={4} bevelEnabled={false}>
      {text || 'Label'}
      <meshStandardMaterial color="#3b82f6" metalness={0.2} roughness={0.6} />
    </Text3D>
  </Center>
);

const Slider: React.FC<{ label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt?: (v: number) => string }> = ({ label, value, min, max, step, onChange, fmt }) => (
  <div className="space-y-1.5">
    <div className="flex items-center justify-between">
      <label className="text-[11px] font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide">{label}</label>
      <span className="text-[12px] font-semibold font-tech">{fmt ? fmt(value) : value}mm</span>
    </div>
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className="w-full h-1.5 bg-[hsl(var(--muted))] rounded-full appearance-none cursor-pointer accent-[hsl(var(--primary))]" />
  </div>
);

export const LabelsStepPanel: React.FC = () => {
  const labels = useAppStore((s) => s.labels);
  const selectedLabelId = useAppStore((s) => s.selectedLabelId);
  const addLabel = useAppStore((s) => s.addLabel);
  const updateLabel = useAppStore((s) => s.updateLabel);
  const removeLabel = useAppStore((s) => s.removeLabel);
  const selectLabel = useAppStore((s) => s.selectLabel);
  const projectName = useAppStore((s) => s.projectName);
  const setCurrentStep = useAppStore((s) => s.setCurrentStep);

  const selected = labels.find((l) => l.id === selectedLabelId) ?? null;

  // Form mirrors either the selected label (edit) or the next new label (add).
  const [text, setText] = useState(`${projectName} V1.0`);
  const [font, setFont] = useState<LabelFont>('helvetiker');
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [depth, setDepth] = useState(DEFAULT_DEPTH);

  useEffect(() => {
    if (selected) {
      setText(selected.text); setFont(selected.font); setFontSize(selected.fontSize); setDepth(selected.depth);
    } else {
      setText(`${projectName} V1.0`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLabelId]);

  // Editing a field updates the selected label live (if one is selected).
  const patch = useCallback((u: Partial<LabelConfig>) => { if (selectedLabelId) updateLabel(selectedLabelId, u); }, [selectedLabelId, updateLabel]);

  const handleAdd = useCallback(() => {
    const label: LabelConfig = {
      id: `label-${Date.now()}`,
      text: text.trim() || 'Label',
      font, fontSize, depth,
      position: { x: 0, y: 0, z: 0 }, // tray centre; z derived to the top surface
      rotation: { x: 0, y: 0, z: 0 },
    };
    addLabel(label);
  }, [text, font, fontSize, depth, addLabel]);

  const posX = selected ? getPositionAxis(selected.position, 'x') : 0;
  const posY = selected ? getPositionAxis(selected.position, 'y') : 0;
  const rotDeg = selected ? radToDeg(getRotationZ(selected.rotation)) : 0;

  return (
    // h-full + scroll: the parent panel is overflow-hidden, so without this the label
    // list (and its delete buttons) at the bottom gets clipped and can't be reached.
    <div className="p-4 space-y-4 h-full overflow-y-auto">
      {/* Optional-step banner — Labels is not mandatory; skip straight to Export. */}
      <button onClick={() => setCurrentStep('export')}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-amber-300/60 bg-amber-50 dark:bg-amber-500/10 hover:bg-amber-100 dark:hover:bg-amber-500/20 transition-colors text-left">
        <SkipForward className="w-4 h-4 text-amber-600 flex-shrink-0" />
        <span className="text-[13px] font-semibold text-amber-700 dark:text-amber-400 flex-1">Skip this step</span>
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-200/70 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400">Optional</span>
      </button>

      {/* Live 3D preview */}
      <div className="rounded-xl overflow-hidden border border-[hsl(var(--border))]">
        <div className="h-[130px] bg-[hsl(var(--muted)/0.3)]">
          <Canvas camera={{ position: [0, 0, 80], fov: 50 }}>
            <ambientLight intensity={0.7} />
            <directionalLight position={[10, 10, 10]} intensity={0.8} />
            <Suspense fallback={null}><LabelPreview text={text} fontSize={fontSize} depth={depth} font={font} /></Suspense>
            <OrbitControls enablePan={false} enableZoom={false} minPolarAngle={Math.PI / 3} maxPolarAngle={Math.PI / 2} />
          </Canvas>
        </div>
      </div>

      {/* Text */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Label Text</label>
        <input value={text} onChange={(e) => { setText(e.target.value); patch({ text: e.target.value }); }}
          placeholder="Enter label text…"
          className="w-full h-8 px-2.5 rounded-lg border border-[hsl(var(--border))] bg-transparent text-[13px] font-tech" />
      </div>

      {/* Font */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Font</label>
        <select value={font} onChange={(e) => { setFont(e.target.value as LabelFont); patch({ font: e.target.value as LabelFont }); }}
          className="w-full h-8 px-2 rounded-lg border border-[hsl(var(--border))] bg-transparent text-[13px] font-tech">
          {LABEL_FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
      </div>

      <Slider label={`Font Size (min ${MIN_FONT_SIZE}mm)`} value={fontSize} min={MIN_FONT_SIZE} max={MAX_FONT_SIZE} step={1}
        onChange={(v) => { setFontSize(v); patch({ fontSize: v }); }} />
      <Slider label="Emboss Height" value={depth} min={MIN_DEPTH} max={MAX_DEPTH} step={0.1}
        onChange={(v) => { setDepth(v); patch({ depth: v }); }} fmt={(v) => v.toFixed(1)} />

      {/* Position + rotation — only meaningful for the selected label */}
      {selected && (
        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-1">
            <label className="text-[10px] font-mono text-red-500">X (mm)</label>
            <input type="number" value={posX.toFixed(0)} step={1}
              onChange={(e) => patch({ position: { x: parseFloat(e.target.value) || 0, y: posY, z: 0 } })}
              className="w-full h-7 px-1.5 rounded border border-[hsl(var(--border))] bg-transparent text-[11px] font-mono" />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-mono text-blue-500">Y (mm)</label>
            <input type="number" value={posY.toFixed(0)} step={1}
              onChange={(e) => patch({ position: { x: posX, y: parseFloat(e.target.value) || 0, z: 0 } })}
              className="w-full h-7 px-1.5 rounded border border-[hsl(var(--border))] bg-transparent text-[11px] font-mono" />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-mono text-[hsl(var(--muted-foreground))]">Rot (°)</label>
            <input type="number" value={rotDeg.toFixed(0)} step={5}
              onChange={(e) => patch({ rotation: { x: 0, y: 0, z: degToRad(parseFloat(e.target.value) || 0) } })}
              className="w-full h-7 px-1.5 rounded border border-[hsl(var(--border))] bg-transparent text-[11px] font-mono" />
          </div>
        </div>
      )}

      {/* Add button */}
      <button onClick={handleAdd} disabled={!text.trim()}
        className="w-full h-9 px-3 rounded-xl text-[13px] font-semibold flex items-center justify-center gap-1.5 text-white disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ background: 'var(--gradient-primary)', boxShadow: 'var(--shadow-btn)' }}>
        <Plus className="w-4 h-4" /> Add Label to Tray
      </button>
      <p className="text-[10px] text-[hsl(var(--muted-foreground))] text-center">
        Select a label below to edit its text, size, position and rotation. Labels are raised on the tray top and print with the STL.
      </p>

      {/* Label list */}
      {labels.length > 0 && (
        <div className="space-y-1.5 pt-2 border-t border-[hsl(var(--border))]">
          <label className="text-[11px] font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide">
            Labels ({labels.length})
          </label>
          {labels.map((l, i) => (
            <div key={l.id}
              onClick={() => selectLabel(l.id)}
              className={`flex items-center gap-2 px-2 py-1.5 rounded-lg border cursor-pointer transition-colors ${l.id === selectedLabelId ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.08)]' : 'border-[hsl(var(--border))] hover:border-[hsl(var(--primary)/0.5)]'}`}>
              <div className="w-5 h-5 rounded bg-[hsl(var(--muted)/0.6)] flex items-center justify-center text-[10px] font-tech">{i + 1}</div>
              <Type className="w-3 h-3 text-[hsl(var(--muted-foreground))]" />
              <span className="text-[11px] truncate flex-1">{l.text}</span>
              <span className="text-[10px] text-[hsl(var(--muted-foreground))]">{l.fontSize}mm</span>
              <button onClick={(e) => { e.stopPropagation(); removeLabel(l.id); }}
                className="w-6 h-6 flex items-center justify-center rounded text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)/0.1)]" title="Delete label">
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Continue → Export */}
      <button onClick={() => setCurrentStep('export')}
        className="w-full h-9 px-3 rounded-xl text-[13px] font-semibold flex items-center justify-center gap-1.5 text-white"
        style={{ background: 'var(--gradient-primary)', boxShadow: 'var(--shadow-btn)' }}>
        Continue to Export
        <ChevronRight className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};

export default LabelsStepPanel;
