/**
 * WorkflowShell — ToolTrace application frame.
 *
 * Mirrors RapidTool-Fixture's shell structure (src/layout/WorkflowShell.tsx) for
 * family UI parity: a glass header, a w-14 icon rail, a collapsible "Context
 * Options" panel, the 3D/2D viewport, a collapsible "Properties" panel and a
 * status-bar footer — all styled with the shared design tokens (tech-glass,
 * font-tech) and cad-ui components.
 *
 * ToolTrace's own 5-step workflow content is re-skinned into this frame:
 *   - rail            → the 5 workflow steps
 *   - Context Options → <ControlPanel/> (existing per-step UI)
 *   - viewport        → the active workspace
 *   - Properties      → <PropertiesPanel/> (selected-item editor)
 *
 * Header view buttons / Reset dispatch window CustomEvents the 3D viewport listens
 * for ('viewer-orientation', 'viewer-reset'). Undo/Redo and file Save/Open are
 * intentionally omitted (no underlying system) — matching the look, wiring what fits.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  FileText, Wrench, LayoutGrid, Box, Download,
  RotateCcw, ChevronLeft, ChevronRight, UserCircle2,
  AlertCircle, ArrowRight, X,
} from 'lucide-react';
import { RapidToolLogo, ThemeToggle, SidebarIcon, SidebarIconGroup, LoadingOverlay } from '@rapidtool/cad-ui';
import { IconIsoFace, IconIsoTop, IconIsoLeftFace, IconIsoCorner } from './icons';
import { useAppStore, type WorkflowStep } from '../stores';
import { useAuthStore } from '../stores/authStore';
import { useTheme } from '../hooks';
import { ControlPanel } from './ControlPanel';
import { PropertiesPanel } from './PropertiesPanel';
import { AccountSettings } from './AccountSettings';
import { ImageWorkspace } from './ImageWorkspace';
import { LayoutWorkspace } from './LayoutWorkspace';
import { DesignWorkspace } from './DesignWorkspace';
import { ExportWorkspace } from './ExportWorkspace';
import { ErrorBoundary } from './ErrorBoundary';

// ── Step config ─────────────────────────────────────────────────────────────
interface StepConfig { step: WorkflowStep; label: string; icon: React.ReactNode; }
const stepConfigs: StepConfig[] = [
  { step: 'paper',  label: 'Detect Paper',     icon: <FileText className="w-4 h-4" /> },
  { step: 'tools',  label: 'Trace Tools',      icon: <Wrench className="w-4 h-4" /> },
  { step: 'layout', label: 'Configure Layout', icon: <LayoutGrid className="w-4 h-4" /> },
  { step: 'design', label: '3D Design',        icon: <Box className="w-4 h-4" /> },
  { step: 'export', label: 'Export',           icon: <Download className="w-4 h-4" /> },
];
const stepOrder = stepConfigs.map((c) => c.step);

const DEFAULT_DESIGN_SETTINGS = { baseHeight: 5, wallThickness: 2, cutoutDepth: 15, chamferSize: 2, gridfinityBase: true };

const VIEW_BUTTONS: { o: string; Icon: React.FC<{ className?: string }>; cls: string; title: string }[] = [
  { o: 'front', Icon: IconIsoFace,     cls: '',           title: 'Front View' },
  { o: 'back',  Icon: IconIsoFace,     cls: 'rotate-180', title: 'Back View' },
  { o: 'left',  Icon: IconIsoLeftFace, cls: '',           title: 'Left View' },
  { o: 'right', Icon: IconIsoFace,     cls: '',           title: 'Right View' },
  { o: 'top',   Icon: IconIsoTop,      cls: '',           title: 'Top View' },
  { o: 'iso',   Icon: IconIsoCorner,   cls: '',           title: 'Isometric View' },
];

// ── Prerequisites notification (ported from Sidebar) ─────────────────────────
const PrerequisitesNotification: React.FC<{
  isOpen: boolean; onClose: () => void; targetStep: WorkflowStep | null;
  incompleteSteps: StepConfig[]; onGoToStep: (step: WorkflowStep) => void;
}> = ({ isOpen, onClose, targetStep, incompleteSteps, onGoToStep }) => {
  const targetConfig = stepConfigs.find((s) => s.step === targetStep);
  if (!isOpen || !targetConfig) return null;
  return (
    <div className="fixed top-20 left-1/2 -translate-x-1/2 z-40 w-full max-w-md pointer-events-auto" style={{ animation: 'fadeIn 0.2s ease-out' }}>
      <div className="bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-xl shadow-xl overflow-hidden">
        <div className="px-4 py-3 flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-[hsl(var(--warning)/0.15)] flex items-center justify-center shrink-0">
            <AlertCircle className="w-4 h-4 text-[hsl(var(--warning))]" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-xs font-semibold text-[hsl(var(--foreground))]">Complete previous steps</h3>
            <p className="mt-0.5 text-[11px] text-[hsl(var(--muted-foreground))] leading-relaxed">
              <span className="font-medium text-[hsl(var(--foreground))]">{targetConfig.label}</span> requires the following:
            </p>
          </div>
          <button onClick={onClose} className="w-6 h-6 rounded-md flex items-center justify-center text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))] transition-colors shrink-0">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="px-4 pb-3">
          <div className="flex flex-wrap gap-1.5">
            {incompleteSteps.map((sc) => (
              <button key={sc.step} onClick={() => { onGoToStep(sc.step); onClose(); }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[hsl(var(--muted)/0.6)] hover:bg-[hsl(var(--primary)/0.1)] border border-[hsl(var(--border)/0.5)] hover:border-[hsl(var(--primary)/0.3)] transition-colors group">
                <span className="text-[hsl(var(--muted-foreground))] group-hover:text-[hsl(var(--primary))] transition-colors">{sc.icon}</span>
                <span className="text-[11px] font-medium text-[hsl(var(--foreground))] group-hover:text-[hsl(var(--primary))] transition-colors">{sc.label}</span>
                <ArrowRight className="w-3 h-3 text-[hsl(var(--muted-foreground))] group-hover:text-[hsl(var(--primary))] transition-colors" />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

// ── Shell ─────────────────────────────────────────────────────────────────────
export const WorkflowShell: React.FC = () => {
  const {
    currentStep, setCurrentStep, projectName, setProjectName,
    isProcessing, processingMessage,
    paperDetected, toolOutlines, layoutState, designSettings, resetAll,
  } = useAppStore();
  const logout = useAuthStore((s) => s.logout);
  const { theme, toggleTheme } = useTheme();
  const [isAccountOpen, setIsAccountOpen] = useState(false);

  const [isContextCollapsed, setIsContextCollapsed] = useState(false);
  const [isPropertiesCollapsed, setIsPropertiesCollapsed] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(projectName);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [prereqModal, setPrereqModal] = useState<{ isOpen: boolean; targetStep: WorkflowStep | null; incompleteSteps: StepConfig[] }>(
    { isOpen: false, targetStep: null, incompleteSteps: [] }
  );

  // ── Step completion / prerequisites (ported from Sidebar) ──────────────────
  const getStepCompletion = useCallback((step: WorkflowStep): boolean => {
    switch (step) {
      case 'paper':  return paperDetected;
      case 'tools':  return toolOutlines.length > 0;
      case 'layout': return layoutState.shapes.length > 0;
      case 'design': {
        const hasElements = layoutState.shapes.length > 0;
        const d = designSettings;
        const changed = d.baseHeight !== DEFAULT_DESIGN_SETTINGS.baseHeight
          || d.wallThickness !== DEFAULT_DESIGN_SETTINGS.wallThickness
          || d.cutoutDepth !== DEFAULT_DESIGN_SETTINGS.cutoutDepth
          || d.chamferSize !== DEFAULT_DESIGN_SETTINGS.chamferSize
          || d.gridfinityBase !== DEFAULT_DESIGN_SETTINGS.gridfinityBase;
        return hasElements && changed;
      }
      default: return false;
    }
  }, [paperDetected, toolOutlines.length, layoutState.shapes.length, designSettings]);

  const getIncompletePrerequisites = useCallback((step: WorkflowStep): StepConfig[] => {
    const incomplete: StepConfig[] = [];
    const targetIndex = stepOrder.indexOf(step);
    for (let i = 0; i < targetIndex; i++) {
      const prereq = stepOrder[i];
      let ok = false;
      switch (prereq) {
        case 'paper':  ok = paperDetected; break;
        case 'tools':  ok = toolOutlines.length > 0; break;
        case 'layout': ok = layoutState.shapes.length > 0; break;
        default:       ok = true;
      }
      if (!ok) { const c = stepConfigs.find((s) => s.step === prereq); if (c) incomplete.push(c); }
    }
    return incomplete;
  }, [paperDetected, toolOutlines.length, layoutState.shapes.length]);

  const handleStepClick = useCallback((step: WorkflowStep) => {
    const incomplete = getIncompletePrerequisites(step);
    setCurrentStep(step);
    if (incomplete.length > 0) setPrereqModal({ isOpen: true, targetStep: step, incompleteSteps: incomplete });
  }, [getIncompletePrerequisites, setCurrentStep]);

  useEffect(() => {
    if (currentStep === 'paper' && prereqModal.isOpen) setPrereqModal((p) => ({ ...p, isOpen: false }));
  }, [currentStep, prereqModal.isOpen]);

  // ── View orientation / reset → 3D viewport via events ──────────────────────
  const handleOrientation = useCallback((o: string) => {
    window.dispatchEvent(new CustomEvent('viewer-orientation', { detail: o }));
  }, []);
  const handleReset = useCallback(() => {
    if (window.confirm('Reset the whole session? This clears the image, traces and layout.')) {
      resetAll();
      window.dispatchEvent(new CustomEvent('viewer-reset'));
    }
  }, [resetAll]);

  // ── Project name editing ───────────────────────────────────────────────────
  const startEditingName = useCallback(() => { setNameDraft(projectName); setIsEditingName(true); setTimeout(() => nameInputRef.current?.select(), 0); }, [projectName]);
  const saveName = useCallback(() => { const t = nameDraft.trim(); if (t) setProjectName(t); setIsEditingName(false); }, [nameDraft, setProjectName]);

  const handleLogout = useCallback(async () => { await logout(); setIsAccountOpen(false); }, [logout]);

  // ── Viewport ───────────────────────────────────────────────────────────────
  const renderWorkspace = () => {
    switch (currentStep) {
      case 'layout': return <LayoutWorkspace />;
      case 'design': return <DesignWorkspace />;
      case 'export': return <ExportWorkspace />;
      default:       return <ImageWorkspace />;
    }
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <header className="h-14 flex items-center justify-between px-4 border-b border-[hsl(var(--border)/0.6)] tech-glass">
        {/* Left */}
        <div className="flex items-center gap-3">
          <RapidToolLogo productName="ToolTrace" icon={<Wrench size={18} />} />
          <div className="w-px h-6 bg-[hsl(var(--border))]" />
          <button onClick={handleReset} title="Reset session"
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--accent-foreground))] hover:bg-[hsl(var(--accent))] tech-transition">
            <RotateCcw className="w-4 h-4" /> Reset
          </button>
        </div>

        {/* Center — project name + processing */}
        <div className="flex items-center gap-4 absolute left-1/2 -translate-x-1/2">
          <div className="flex items-center gap-2 text-sm font-tech">
            {isEditingName ? (
              <input ref={nameInputRef} type="text" value={nameDraft} autoFocus
                onChange={(e) => setNameDraft(e.target.value)} onBlur={saveName}
                onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setIsEditingName(false); }}
                className="bg-[hsl(var(--muted)/0.5)] border border-[hsl(var(--border))] rounded px-2 py-0.5 text-sm font-tech w-48 focus:outline-none focus:ring-1 focus:ring-[hsl(var(--primary))]" />
            ) : (
              <span onDoubleClick={startEditingName} title="Double-click to rename"
                className="text-[hsl(var(--foreground))] cursor-pointer hover:text-[hsl(var(--primary))] transition-colors px-2 py-0.5 rounded hover:bg-[hsl(var(--muted)/0.3)]">
                {projectName}
              </span>
            )}
          </div>
          {isProcessing && (
            <div className="flex items-center gap-2 text-xs font-tech text-[hsl(var(--primary))]">
              <div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
              <span>{processingMessage || 'Processing…'}</span>
            </div>
          )}
        </div>

        {/* Right — view buttons + theme */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            {VIEW_BUTTONS.map(({ o, Icon, cls, title }) => (
              <button key={o} onClick={() => handleOrientation(o)} title={title}
                className="w-8 h-8 flex items-center justify-center rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--accent))] hover:bg-[hsl(var(--accent)/0.12)] tech-transition">
                <Icon className={`w-4 h-4 ${cls}`} />
              </button>
            ))}
          </div>
          <div className="w-px h-6 bg-[hsl(var(--border))]" />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      {/* ── Main content ─────────────────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left icon rail — steps (top) + account (bottom), matching Fixture's VerticalToolbar */}
        <aside className="w-14 flex-shrink-0 border-r border-[hsl(var(--border)/0.5)] tech-glass flex flex-col" role="toolbar" aria-label="Workflow steps">
          <SidebarIconGroup direction="vertical" gap={8} className="p-2 flex-1">
            {stepConfigs.map((c) => {
              const active = c.step === currentStep;
              const completed = getStepCompletion(c.step);
              return (
                <SidebarIcon
                  key={c.step}
                  icon={<span className={active ? 'opacity-100' : 'opacity-60'}>{c.icon}</span>}
                  label={c.label}
                  tooltip={c.label}
                  active={active}
                  onClick={() => handleStepClick(c.step)}
                  size="md"
                  badge={completed && !active ? '✓' : undefined}
                  badgeVariant="success"
                />
              );
            })}
          </SidebarIconGroup>
          <div className="p-3 border-t border-[hsl(var(--border)/0.5)] flex justify-center">
            <SidebarIcon
              icon={<UserCircle2 className="w-4 h-4 opacity-60" />}
              label="Account Settings"
              tooltip="Account Settings"
              onClick={() => setIsAccountOpen(true)}
              size="sm"
            />
          </div>
        </aside>

        {/* Context Options panel */}
        <aside className="border-r border-[hsl(var(--border)/0.5)] tech-glass flex flex-col overflow-hidden flex-shrink-0"
          style={{ width: isContextCollapsed ? 48 : 320, transition: 'width 300ms ease-in-out' }}>
          <div className="p-2 border-b border-[hsl(var(--border)/0.5)] flex items-center justify-between flex-shrink-0">
            {!isContextCollapsed && <h3 className="font-tech font-semibold text-sm whitespace-nowrap">Context Options</h3>}
            <button onClick={() => setIsContextCollapsed((v) => !v)}
              title={isContextCollapsed ? 'Expand Panel' : 'Collapse Panel'}
              className={`w-8 h-8 flex items-center justify-center rounded-md tech-transition text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent)/0.12)] hover:text-[hsl(var(--accent))] ${isContextCollapsed ? 'mx-auto' : ''}`}>
              {isContextCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
            </button>
          </div>
          {!isContextCollapsed && (
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              <ErrorBoundary><ControlPanel /></ErrorBoundary>
            </div>
          )}
        </aside>

        {/* Viewport */}
        <main className="flex-1 relative min-w-0 overflow-hidden">
          <ErrorBoundary>{renderWorkspace()}</ErrorBoundary>
          <LoadingOverlay isVisible={isProcessing} message={processingMessage || 'Processing...'} positioning="absolute" type="import" />
        </main>

        {/* Right Properties panel */}
        <aside className="border-l border-[hsl(var(--border)/0.5)] tech-glass flex flex-col overflow-hidden flex-shrink-0"
          style={{ width: isPropertiesCollapsed ? 48 : 280, transition: 'width 300ms ease-in-out' }}>
          <div className="p-2 border-b border-[hsl(var(--border)/0.5)] flex items-center justify-between flex-shrink-0">
            {!isPropertiesCollapsed && <h3 className="font-tech font-semibold text-sm whitespace-nowrap">Properties</h3>}
            <button onClick={() => setIsPropertiesCollapsed((v) => !v)}
              title={isPropertiesCollapsed ? 'Expand Properties' : 'Collapse Properties'}
              className={`w-8 h-8 flex items-center justify-center rounded-md tech-transition text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent)/0.12)] hover:text-[hsl(var(--accent))] ${isPropertiesCollapsed ? 'mx-auto' : ''}`}>
              {isPropertiesCollapsed ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>
          </div>
          {!isPropertiesCollapsed && (
            <div className="p-4 flex-1 overflow-auto">
              <ErrorBoundary><PropertiesPanel /></ErrorBoundary>
            </div>
          )}
        </aside>
      </div>

      {/* ── Flow steps bar — horizontal workflow stepper (mirrors Fixture's bottom bar) ── */}
      <div className="h-12 border-t border-[hsl(var(--border)/0.5)] tech-glass flex items-center px-3">
        <SidebarIconGroup direction="horizontal" gap={4} align="center">
          {stepConfigs.map((c, i) => {
            const active = c.step === currentStep;
            return (
              <SidebarIcon
                key={c.step}
                icon={c.icon}
                label={c.label}
                tooltip={`${i + 1}. ${c.label}`}
                active={active}
                onClick={() => handleStepClick(c.step)}
                size="md"
              />
            );
          })}
        </SidebarIconGroup>
      </div>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer className="h-6 border-t border-[hsl(var(--border)/0.5)] tech-glass flex items-center justify-between px-4 text-[10px] font-tech text-[hsl(var(--muted-foreground))]">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-[hsl(var(--success))] inline-block" /> Ready
          </span>
          <span className="text-[hsl(var(--border))]">•</span>
          <span>WebGL 2.0</span>
        </div>
        <span className="text-[hsl(var(--muted-foreground)/0.5)]">ToolTrace</span>
      </footer>

      <PrerequisitesNotification
        isOpen={prereqModal.isOpen}
        onClose={() => setPrereqModal((p) => ({ ...p, isOpen: false }))}
        targetStep={prereqModal.targetStep}
        incompleteSteps={prereqModal.incompleteSteps}
        onGoToStep={setCurrentStep}
      />

      <AccountSettings open={isAccountOpen} onOpenChange={setIsAccountOpen} onLogout={handleLogout} />
    </div>
  );
};

export default WorkflowShell;
