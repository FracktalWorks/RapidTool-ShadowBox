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
  AlertCircle, ArrowRight, X, CheckCircle2, Loader2,
  Undo2, Redo2, HelpCircle, FolderPlus, FolderOpen, Save,
  Moon, Sun,
} from 'lucide-react';
import { RapidToolLogo, SidebarIcon, SidebarIconGroup, LoadingOverlay, StepProgress } from '@rapidtool/cad-ui';
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
interface StepConfig {
  step: WorkflowStep;
  label: string;
  description: string;
  icon: React.ReactNode;
  IconComponent: React.ComponentType<{ className?: string }>;
  helpText: string[];
}
const stepConfigs: StepConfig[] = [
  { 
    step: 'paper',  
    label: 'Detect Paper',     
    description: 'Upload and calibrate image scale', 
    icon: <FileText className="w-4 h-4" />, 
    IconComponent: FileText,
    helpText: [
      'Double-click the name on the title bar to rename your project',
      'Upload a clear photo of tools placed on standard white A4 paper',
      'Adjust corner handles manually if auto-detection misses the paper edges'
    ]
  },
  { 
    step: 'tools',  
    label: 'Trace Tools',      
    description: 'Extract tool contour boundaries', 
    icon: <Wrench className="w-4 h-4" />, 
    IconComponent: Wrench,
    helpText: [
      'Use Auto Detect to extract all tool boundaries at once using AI/SOD models',
      'Use Click Trace to capture individual tools by clicking inside their shapes',
      'Select a tool and use Refine Edges (Left-click / Shift-click) to repair details'
    ]
  },
  { 
    step: 'layout', 
    label: 'Configure Layout', 
    description: 'Arrange pocket layouts on baseplate', 
    icon: <LayoutGrid className="w-4 h-4" />, 
    IconComponent: LayoutGrid,
    helpText: [
      'Set columns and rows to define the Gridfinity or custom tray cell division',
      'Drag and rotate pockets within the layout boundaries to optimize spacing',
      'Add finger notches to allow easy retrieval of tools from their cutouts'
    ]
  },
  { 
    step: 'design', 
    label: '3D Design',        
    description: 'Configure holder height and thickness', 
    icon: <Box className="w-4 h-4" />, 
    IconComponent: Box,
    helpText: [
      'Adjust Cutout Depth to match the thickness of your tools',
      'Toggle Gridfinity Base to generate standard interlocking mounting feet at the bottom',
      'Rotate and zoom the 3D model to inspect wall thickness and edge chamfering'
    ]
  },
  { 
    step: 'export', 
    label: 'Export',           
    description: 'Save as SVG or 3D STL file', 
    icon: <Download className="w-4 h-4" />, 
    IconComponent: Download,
    helpText: [
      'Select SVG format to export vector outlines for laser cutting or drawer liners',
      'Select STL format to export a watertight 3D print-ready model',
      'Check the dimensions summary on the left to verify your drawer space'
    ]
  },
];
const stepOrder = stepConfigs.map((c) => c.step);

const VIEW_BUTTONS: { o: string; Icon: React.FC<{ className?: string }>; cls: string; title: string }[] = [
  { o: 'front', Icon: IconIsoFace,     cls: '',           title: 'Front View' },
  { o: 'back',  Icon: IconIsoFace,     cls: 'rotate-180', title: 'Back View' },
  { o: 'left',  Icon: IconIsoLeftFace, cls: '',           title: 'Left View' },
  { o: 'right', Icon: IconIsoFace,     cls: '',           title: 'Right View' },
  { o: 'top',   Icon: IconIsoTop,      cls: '',           title: 'Top View' },
  { o: 'iso',   Icon: IconIsoCorner,   cls: '',           title: 'Isometric View' },
];



// ── Shell ─────────────────────────────────────────────────────────────────────
export const WorkflowShell: React.FC = () => {
  const {
    currentStep, setCurrentStep, projectName, setProjectName,
    isProcessing, processingMessage,
    paperDetected, toolOutlines, layoutState, resetAll,
  } = useAppStore();
  const logout = useAuthStore((s) => s.logout);
  const { theme, toggleTheme } = useTheme();
  const [isAccountOpen, setIsAccountOpen] = useState(false);

  const [isContextCollapsed, setIsContextCollapsed] = useState(false);
  const [isPropertiesCollapsed, setIsPropertiesCollapsed] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(projectName);
  const nameInputRef = useRef<HTMLInputElement>(null);



  const [isTipsVisible, setIsTipsVisible] = useState(true);

  const handleStepClick = useCallback((step: WorkflowStep) => {
    setCurrentStep(step);
  }, [setCurrentStep]);

  useEffect(() => {
    setIsTipsVisible(true);
  }, [currentStep]);

  useEffect(() => {
    setIsTipsVisible(true);
  }, [currentStep]);

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

  const handleSaveSession = useCallback(() => {
    const state = useAppStore.getState();
    const sessionData = {
      version: '1.0.0',
      projectName: state.projectName,
      paperCorners: state.paperCorners,
      paperDetected: state.paperDetected,
      paperConfidence: state.paperConfidence,
      pixelsPerMm: state.pixelsPerMm,
      toolOutlines: state.toolOutlines,
      clearanceValue: state.clearanceValue,
      layoutState: state.layoutState,
      designSettings: state.designSettings,
    };
    const blob = new Blob([JSON.stringify(sessionData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.projectName.toLowerCase().replace(/\s+/g, '-')}.rapidtool`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleOpenSession = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.rapidtool,application/json';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const data = JSON.parse(event.target?.result as string);
          if (data.projectName) {
            const store = useAppStore.getState();
            useAppStore.setState({
              projectName: data.projectName,
              paperCorners: data.paperCorners || null,
              paperDetected: data.paperDetected || false,
              paperConfidence: data.paperConfidence || 0,
              pixelsPerMm: data.pixelsPerMm || null,
              toolOutlines: data.toolOutlines || [],
              clearanceValue: data.clearanceValue ?? 0.5,
              layoutState: data.layoutState || store.layoutState,
              designSettings: data.designSettings || store.designSettings,
              currentStep: 'paper',
            });
            alert(`Session "${data.projectName}" loaded successfully! Note: Please re-upload your workpiece image if calibrating.`);
          } else {
            alert('Invalid session file format.');
          }
        } catch (err) {
          alert('Failed to parse the file.');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }, []);

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
      <header className="h-14 flex items-center justify-between px-4 border-b border-border/60 tech-glass">
        {/* Left */}
        <div className="flex items-center gap-4">
          <RapidToolLogo productName="tooltrace" icon={<Wrench className="w-4 h-4 text-amber-500 flex-shrink-0" />} />
          <div className="w-px h-6 bg-border/50" />
            <div className="flex items-center gap-2">
              <button onClick={handleReset} title="Reset session"
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold text-black dark:text-white hover:bg-accent hover:text-accent-foreground tech-transition cursor-pointer">
                <RotateCcw className="w-3.5 h-3.5 mr-0.5" /> Reset
              </button>
            <div className="w-px h-6 bg-border/50" />
            <div className="flex items-center gap-1">
              <button disabled className="w-8 h-8 flex items-center justify-center rounded-md text-muted-foreground opacity-40 cursor-not-allowed">
                <Undo2 className="w-4 h-4" />
              </button>
              <button disabled className="w-8 h-8 flex items-center justify-center rounded-md text-muted-foreground opacity-40 cursor-not-allowed">
                <Redo2 className="w-4 h-4" />
              </button>
            </div>
            <div className="w-px h-6 bg-border/50" />
              <button className="w-8 h-8 flex items-center justify-center rounded-md text-black dark:text-white hover:bg-accent hover:text-accent-foreground tech-transition cursor-pointer" title="Restart Tutorial">
                <HelpCircle className="w-4 h-4" />
              </button>
          </div>
        </div>

        {/* Center — project name + file session controls */}
        <div className="flex items-center gap-4 absolute left-1/2 -translate-x-1/2">
          <div className="flex items-center gap-1">
            <button onClick={handleReset} className="w-8 h-8 flex items-center justify-center rounded-md text-black dark:text-white hover:bg-accent hover:text-accent-foreground tech-transition cursor-pointer" title="New design file">
              <FolderPlus className="w-4 h-4" />
            </button>
            <button onClick={handleOpenSession} className="w-8 h-8 flex items-center justify-center rounded-md text-black dark:text-white hover:bg-accent hover:text-accent-foreground tech-transition cursor-pointer" title="Open .rapidtool file">
              <FolderOpen className="w-4 h-4" />
            </button>
            <button onClick={handleSaveSession} className="w-8 h-8 flex items-center justify-center rounded-md text-black dark:text-white hover:bg-accent hover:text-accent-foreground tech-transition cursor-pointer" title="Save now">
              <Save className="w-4 h-4" />
            </button>
          </div>
          <div className="w-px h-6 bg-border/50" />
          <div className="flex items-center gap-2 text-sm font-tech">
            {isEditingName ? (
              <input ref={nameInputRef} type="text" value={nameDraft} autoFocus
                onChange={(e) => setNameDraft(e.target.value)} onBlur={saveName}
                onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setIsEditingName(false); }}
                className="bg-muted/50 border border-border rounded px-2 py-0.5 text-sm font-tech w-48 focus:outline-none focus:ring-1 focus:ring-primary" />
            ) : (
              <span onDoubleClick={startEditingName} title="Double-click to rename"
                className="text-black dark:text-white cursor-pointer hover:text-primary transition-colors px-2 py-0.5 rounded hover:bg-muted/30 font-medium">
                {projectName}
              </span>
            )}
          </div>
          {isProcessing && (
            <div className="flex items-center gap-2 text-xs font-tech text-primary">
              <div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
              <span>{processingMessage || 'Processing…'}</span>
            </div>
          )}
        </div>

        {/* Right — view buttons + theme */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1">
            {VIEW_BUTTONS.map(({ o, Icon, cls, title }) => (
              <button key={o} onClick={() => handleOrientation(o)} title={title}
                className="w-8 h-8 flex items-center justify-center rounded-md text-black dark:text-white hover:bg-accent hover:text-accent-foreground tech-transition cursor-pointer">
                <Icon className={`w-4 h-4 ${cls}`} />
              </button>
            ))}
          </div>
          <div className="w-px h-6 bg-border/50" />
          {/* Mapped as outline button to match Fixture style */}
          <button onClick={toggleTheme} className="w-8 h-8 flex items-center justify-center rounded-md border border-border text-black dark:text-white hover:bg-accent hover:text-accent-foreground hover:border-accent tech-transition shadow-sm cursor-pointer" title="Toggle theme">
            {theme === 'light' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {/* ── Main content ─────────────────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left icon rail — workflow steps */}
        <aside className="w-14 flex-shrink-0 border-r border-border/50 tech-glass flex flex-col" role="toolbar" aria-label="Workflow steps">
          <SidebarIconGroup direction="vertical" gap={8} className="p-2 flex-1">
            {stepConfigs.map((c) => {
              const active = c.step === currentStep;
              return (
                <SidebarIcon
                  key={c.step}
                  icon={<span className={active ? 'opacity-100' : 'opacity-60'}>{c.icon}</span>}
                  label={c.label}
                  tooltip={c.label}
                  active={active}
                  onClick={() => handleStepClick(c.step)}
                  size="md"
                />
              );
            })}
          </SidebarIconGroup>
          <div className="p-3 border-t border-border/50 flex items-center justify-center">
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
        <aside className="border-r border-border/50 tech-glass flex flex-col overflow-hidden flex-shrink-0"
          style={{ width: isContextCollapsed ? 48 : 320, transition: 'width 300ms ease-in-out' }}>
          <div className="p-2 border-b border-border/50 flex items-center justify-between flex-shrink-0">
            {!isContextCollapsed && <h3 className="font-tech font-semibold text-sm whitespace-nowrap">Context Options</h3>}
            <button onClick={() => {
                setIsContextCollapsed((v) => !v);
                setTimeout(() => {
                  window.dispatchEvent(new Event('resize'));
                  window.dispatchEvent(new CustomEvent('viewer-resize'));
                }, 320);
              }}
              title={isContextCollapsed ? 'Expand Panel' : 'Collapse Panel'}
              className={`w-8 h-8 flex items-center justify-center rounded-md tech-transition text-muted-foreground hover:bg-muted hover:text-foreground ${isContextCollapsed ? 'mx-auto' : ''}`}>
              {isContextCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
            </button>
          </div>
          {!isContextCollapsed && (
            <>
              {/* Step Header */}
              <div className="p-4 border-b border-border/50 flex-shrink-0">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                    {(() => {
                      const cfg = stepConfigs.find(s => s.step === currentStep);
                      if (cfg) {
                        const Icon = cfg.IconComponent;
                        return <Icon className="w-5 h-5 text-primary" />;
                      }
                      return null;
                    })()}
                  </div>
                  <div className="flex-1">
                    <h2 className="font-tech font-semibold text-base leading-tight text-foreground">
                      {stepConfigs.find(s => s.step === currentStep)?.label}
                    </h2>
                    <p className="text-[11px] text-muted-foreground font-tech mt-0.5">
                      {stepConfigs.find(s => s.step === currentStep)?.description}
                    </p>
                  </div>
                  {isProcessing && (
                    <Loader2 className="w-4 h-4 text-primary animate-spin" />
                  )}
                </div>

                {/* Progress indicator */}
                <StepProgress
                  currentStep={stepOrder.indexOf(currentStep) + 1}
                  totalSteps={stepConfigs.length}
                  completedCount={
                    [
                      paperDetected,
                      toolOutlines.length > 0,
                      layoutState.shapes.length > 0,
                      currentStep === 'export' || (currentStep === 'design' && layoutState.shapes.length > 0),
                    ].filter(Boolean).length
                  }
                  barHeight={5}
                  className="mt-3"
                />
              </div>

              <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                <ErrorBoundary><ControlPanel /></ErrorBoundary>
              </div>
              {/* Step Navigation Mini-Map */}
              <div className="p-3 border-t border-border/50 flex-shrink-0">
                <div className="flex items-center justify-between gap-1">
                  {stepConfigs.map((c, i) => {
                    const active = c.step === currentStep;
                    
                    let isCompleted = false;
                    if (c.step === 'paper') isCompleted = paperDetected;
                    else if (c.step === 'tools') isCompleted = toolOutlines.length > 0;
                    else if (c.step === 'layout') isCompleted = layoutState.shapes.length > 0;
                    else if (c.step === 'design') isCompleted = currentStep === 'export';
                    
                    const status = active ? 'current' : isCompleted ? 'completed' : 'upcoming';

                    return (
                      <button
                        key={c.step}
                        onClick={() => handleStepClick(c.step)}
                        className={`
                          relative flex items-center justify-center w-8 h-8 rounded-md transition-all cursor-pointer
                          ${status === 'current'
                            ? 'bg-primary text-primary-foreground font-bold shadow-sm'
                            : status === 'completed'
                              ? 'bg-primary/20 text-primary hover:bg-primary/30'
                              : 'bg-muted/50 text-muted-foreground hover:bg-muted'
                          }
                        `}
                        title={`${i + 1}. ${c.label}`}
                      >
                        {status === 'completed' ? (
                          <CheckCircle2 className="w-4 h-4" />
                        ) : (
                          c.icon
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </aside>

        {/* Viewport */}
        <main className="flex-1 relative min-w-0 overflow-hidden">
          <ErrorBoundary>{renderWorkspace()}</ErrorBoundary>
          <LoadingOverlay isVisible={isProcessing} message={processingMessage || 'Processing...'} positioning="absolute" type="import" />

          {/* Tips overlay */}
          {(() => {
            const cfg = stepConfigs.find(s => s.step === currentStep);
            if (!cfg?.helpText?.length) return null;
            const nextStep = stepOrder[stepOrder.indexOf(currentStep) + 1];
            const nextCfg = nextStep ? stepConfigs.find(s => s.step === nextStep) : null;
            
            return (
              <div className={`absolute top-4 left-4 z-10 max-w-xs transition-opacity duration-300 ${isTipsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
                <div className="relative tech-glass rounded-lg p-3 text-xs text-[hsl(var(--muted-foreground))] font-tech space-y-1.5 bg-[hsl(var(--background))/80] backdrop-blur-sm border border-[hsl(var(--border))/50] shadow-lg pr-6">
                  <button onClick={() => setIsTipsVisible(false)} className="absolute top-2 right-2 p-0.5 text-[hsl(var(--muted-foreground))/50] hover:text-[hsl(var(--foreground))] transition-colors cursor-pointer">
                    <X className="w-3 h-3" />
                  </button>
                  <p className="font-semibold text-[hsl(var(--foreground))] flex items-center gap-1.5">
                    <span>💡</span> Tips
                  </p>
                  <ul className="space-y-1 ml-1">
                    {cfg.helpText.map((tip, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <ChevronRight className="w-3 h-3 mt-0.5 flex-shrink-0 text-[hsl(var(--primary))]" />
                        <span>{tip}</span>
                      </li>
                    ))}
                  </ul>
                  {nextCfg && (
                    <div className="mt-2 pt-2 border-t border-[hsl(var(--border))/50]">
                      <button
                        onClick={() => handleStepClick(nextCfg.step)}
                        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold font-tech text-white bg-orange-400 hover:bg-orange-500 active:bg-orange-600 transition-all shadow-sm w-full cursor-pointer"
                      >
                        <span>→</span>
                        <span>Next: {nextCfg.label}</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
        </main>

        {/* Right Properties panel */}
        <aside className="border-l border-border/50 tech-glass flex flex-col overflow-hidden flex-shrink-0"
          style={{ width: isPropertiesCollapsed ? 48 : 280, transition: 'width 300ms ease-in-out' }}>
          <div className="p-2 border-b border-border/50 flex items-center justify-between flex-shrink-0">
            {!isPropertiesCollapsed && <h3 className="font-tech font-semibold text-sm whitespace-nowrap">Properties</h3>}
            <button onClick={() => {
                setIsPropertiesCollapsed((v) => !v);
                setTimeout(() => {
                  window.dispatchEvent(new Event('resize'));
                  window.dispatchEvent(new CustomEvent('viewer-resize'));
                }, 320);
              }}
              title={isPropertiesCollapsed ? 'Expand Properties' : 'Collapse Properties'}
              className={`w-8 h-8 flex items-center justify-center rounded-md tech-transition text-muted-foreground hover:bg-muted hover:text-foreground ${isPropertiesCollapsed ? 'mx-auto' : ''}`}>
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



      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer className="h-6 border-t border-border/50 tech-glass flex items-center justify-between px-4 text-xs font-tech text-muted-foreground">
        <div className="flex items-center gap-4">
          <span>Ready</span>
          <span>•</span>
          <span>WebGL 2.0</span>
        </div>
      </footer>



      <AccountSettings open={isAccountOpen} onOpenChange={setIsAccountOpen} onLogout={handleLogout} />
    </div>
  );
};

export default WorkflowShell;
