/**
 * Main Application Store
 */

import { create } from 'zustand';
import type { Point2D, PaperCorners, BoundingBox, ToolOutline } from '../lib/geometry';
import { createOrientedPillShape, polygonArea, getBoundingBox, smoothContour } from '../lib/geometry';
import { regularizeContour } from '../lib/contourRegularizer';
import { packRects } from '../lib/packRects';
import type { LabelConfig } from '../features/labels/types';

// Re-export types
export type { Point2D, PaperCorners, BoundingBox, ToolOutline };
export type { LabelConfig };

// ============================================================================
// Types
// ============================================================================

export type WorkflowStep = 'paper' | 'tools' | 'layout' | 'design' | 'labels' | 'export';

// Layout-related types
export type LayoutShapeType = 'tool' | 'finger-notch' | 'circle' | 'square' | 'rectangle';

export interface LayoutShape {
  id: string;
  type: LayoutShapeType;
  // Position in mm from top-left of layout
  x: number;
  y: number;
  // Size in mm
  width: number;
  height: number;
  // Rotation in degrees
  rotation: number;
  // Original tool outline reference (if type === 'tool')
  toolOutlineId?: string;
  // For primitives
  color: string;
}

export interface LayoutGrid {
  rows: number;
  cols: number;
  cellWidthMm: number;
  cellHeightMm: number;
}

export interface LayoutState {
  // Grid configuration
  grid: LayoutGrid;
  // All shapes in the layout
  shapes: LayoutShape[];
  // Selected shape ID
  selectedShapeId: string | null;
  // Active layout tool
  layoutTool: 'select' | 'erase' | 'finger-notch' | 'circle' | 'square' | 'rectangle';
}

// 3D Design settings
export interface DesignSettings {
  baseHeight: number;      // Height of the base plate (mm)
  wallThickness: number;   // Thickness of walls around cutouts (mm)
  cutoutDepth: number;     // Depth of tool cutouts (mm)
  chamferSize: number;     // Chamfer on edges (mm)
  gridfinityBase: boolean; // Whether to include gridfinity base pattern
  materialPreset: 'eva-foam' | 'charcoal' | 'sky-blue' | 'orange';
}

export interface AppState {
  // Workflow
  currentStep: WorkflowStep;
  setCurrentStep: (step: WorkflowStep) => void;

  // Project name (cosmetic — shown/edited in the header)
  projectName: string;
  setProjectName: (name: string) => void;

  // Image
  imageFile: File | null;
  imageUrl: string | null;
  imageSize: { width: number; height: number } | null;
  isRectified: boolean; // true once the working image is a skew-corrected flat A4
  setImage: (file: File | null) => void;
  clearImage: () => void;
  // Replace the working image with a skew-corrected (rectified) flat-A4 image. The
  // original File is kept (imageFile), so reverting = setImage(imageFile).
  applyRectification: (rectifiedUrl: string, size: { width: number; height: number }, pixelsPerMm: number) => void;

  // Paper Detection
  paperCorners: PaperCorners | null;
  paperDetected: boolean;
  paperConfidence: number;
  setPaperCorners: (corners: PaperCorners | null) => void;
  setPaperDetected: (detected: boolean, confidence?: number) => void;
  
  // Scale Calibration
  pixelsPerMm: number | null;
  setPixelsPerMm: (ppm: number | null) => void;
  
  // Tool Outlines
  toolOutlines: ToolOutline[];
  selectedOutlineId: string | null;
  setToolOutlines: (outlines: ToolOutline[]) => void;
  addToolOutline: (outline: ToolOutline) => void;
  updateToolOutline: (id: string, points: Point2D[]) => void;
  updateToolOutlineSmoothed: (id: string, smoothedPoints: Point2D[]) => void;
  updateToolOutlineEdited: (id: string, points: Point2D[]) => void;
  updateToolOutlineRefined: (id: string, points: Point2D[], samClicks: { x: number; y: number; label: number }[]) => void;
  removeToolOutline: (id: string) => void;
  selectOutline: (id: string | null) => void;

  // Refine undo — transient per-tool geometry snapshots so a bad click can be reverted.
  refineHistory: Record<string, ToolOutline[]>;
  undoRefine: (id: string) => void;
  snapToPill: (id: string) => void;

  // Trace history — undo/redo of the whole tool list (add / remove / auto-detect).
  // Snapshots the list BEFORE each discrete change; Ctrl+Z / Ctrl+Y + header buttons.
  undoStack: ToolOutline[][];
  redoStack: ToolOutline[][];
  undo: () => void;
  redo: () => void;

  // Labels — embossed 3D text placed on the tray (Labels workflow step).
  labels: LabelConfig[];
  selectedLabelId: string | null;
  addLabel: (label: LabelConfig) => void;
  updateLabel: (id: string, updates: Partial<LabelConfig>) => void;
  removeLabel: (id: string) => void;
  selectLabel: (id: string | null) => void;
  
  // Clearance/Offset
  clearanceValue: number;
  setClearanceValue: (value: number) => void;
  
  // Active Tool
  activeTool: 'select' | 'pan' | 'trace' | 'box' | 'edit' | 'erase' | 'refine';
  setActiveTool: (tool: 'select' | 'pan' | 'trace' | 'box' | 'edit' | 'erase' | 'refine') => void;

  // GrabCut refine brush radius (image-space pixels)
  refineBrush: number;
  setRefineBrush: (r: number) => void;
  
  // Export Settings
  exportFormat: 'svg' | 'stl';
  setExportFormat: (format: 'svg' | 'stl') => void;
  
  // Layout State
  layoutState: LayoutState;
  setLayoutGrid: (grid: Partial<LayoutGrid>) => void;
  addLayoutShape: (shape: LayoutShape) => void;
  updateLayoutShape: (id: string, updates: Partial<LayoutShape>) => void;
  removeLayoutShape: (id: string) => void;
  selectLayoutShape: (id: string | null) => void;
  setLayoutTool: (tool: LayoutState['layoutTool']) => void;
  clearAllLayoutShapes: () => void;
  initializeLayoutFromTools: () => void;
  recenterLayoutShapes: () => void;
  
  // 3D Design Settings
  designSettings: DesignSettings;
  updateDesignSettings: (updates: Partial<DesignSettings>) => void;
  resetDesignSettings: () => void;
  
  // UI State
  isProcessing: boolean;
  processingMessage: string;
  setProcessing: (processing: boolean, message?: string) => void;
  
  // Reset
  resetAll: () => void;
}

// ============================================================================
// Constants
// ============================================================================

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/bmp'];

// Default Gridfinity-style grid (42mm x 42mm cells)
const DEFAULT_LAYOUT_GRID: LayoutGrid = {
  rows: 3,
  cols: 2,
  cellWidthMm: 42,
  cellHeightMm: 42,
};

const DEFAULT_LAYOUT_STATE: LayoutState = {
  grid: DEFAULT_LAYOUT_GRID,
  shapes: [],
  selectedShapeId: null,
  layoutTool: 'select',
};

// Default design settings
const DEFAULT_DESIGN_SETTINGS: DesignSettings = {
  baseHeight: 5,
  wallThickness: 2,
  cutoutDepth: 15,
  chamferSize: 2,
  gridfinityBase: true,
  materialPreset: 'eva-foam',
};

// ============================================================================
// Initial State
// ============================================================================

const initialState = {
  currentStep: 'paper' as WorkflowStep,
  projectName: 'Untitled',
  imageFile: null,
  imageUrl: null,
  imageSize: null,
  isRectified: false,
  paperCorners: null,
  paperDetected: false,
  paperConfidence: 0,
  pixelsPerMm: null,
  toolOutlines: [],
  selectedOutlineId: null,
  refineHistory: {} as Record<string, ToolOutline[]>,
  undoStack: [] as ToolOutline[][],
  redoStack: [] as ToolOutline[][],
  labels: [] as LabelConfig[],
  selectedLabelId: null as string | null,
  clearanceValue: 1.0, // default Offset preset = Medium (step 3: None 0 / Small 0.5 / Medium 1 / Large 2)
  activeTool: 'box' as const,
  refineBrush: 12,
  exportFormat: 'stl' as const,
  layoutState: DEFAULT_LAYOUT_STATE,
  designSettings: DEFAULT_DESIGN_SETTINGS,
  isProcessing: false,
  processingMessage: '',
};

// ============================================================================
// Store
// ============================================================================

export const useAppStore = create<AppState>((set, get) => ({
  ...initialState,
  
  setCurrentStep: (step) => set({ currentStep: step }),

  setProjectName: (name) => set({ projectName: name }),

  setImage: (file) => {
    // Revoke previous URL if exists
    const prevUrl = get().imageUrl;
    if (prevUrl) {
      URL.revokeObjectURL(prevUrl);
    }
    
    if (!file) {
      set({
        imageFile: null,
        imageUrl: null,
        imageSize: null,
      });
      return;
    }

    // Validate file type
    if (!ALLOWED_TYPES.includes(file.type)) {
      console.error(`Invalid file type: ${file.type}. Allowed: ${ALLOWED_TYPES.join(', ')}`);
      return;
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      console.error(`File too large: ${(file.size / 1024 / 1024).toFixed(2)}MB. Max: ${MAX_FILE_SIZE / 1024 / 1024}MB`);
      return;
    }

    // Show loading state
    set({ isProcessing: true, processingMessage: 'Loading image...' });

    const url = URL.createObjectURL(file);
    const img = new Image();
    
    img.onload = () => {
      set({
        imageFile: file,
        imageUrl: url,
        imageSize: { width: img.width, height: img.height },
        isRectified: false,
        currentStep: 'paper',
        isProcessing: false,
        processingMessage: '',
        // Reset paper/tool state when loading new image
        paperCorners: null,
        paperDetected: false,
        paperConfidence: 0,
        pixelsPerMm: null,
        toolOutlines: [],
        selectedOutlineId: null,
      });
    };
    
    img.onerror = () => {
      URL.revokeObjectURL(url);
      set({ isProcessing: false, processingMessage: '' });
      console.error('Failed to load image');
    };
    
    img.src = url;
  },

  applyRectification: (rectifiedUrl, size, pixelsPerMm) => set((state) => {
    // Swap the working image for the rectified flat A4. Revoke the previous working
    // URL (the raw upload's object URL); the original File stays in imageFile for
    // revert. Paper now fills the frame, so corners are the image border and the
    // scale is exact + uniform. Tools/outlines reset — they trace on the new image.
    if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
    return {
      imageUrl: rectifiedUrl,
      imageSize: size,
      isRectified: true,
      pixelsPerMm,
      paperDetected: true,
      paperCorners: {
        topLeft: { x: 0, y: 0 },
        topRight: { x: size.width, y: 0 },
        bottomRight: { x: size.width, y: size.height },
        bottomLeft: { x: 0, y: size.height },
      },
      toolOutlines: [],
      selectedOutlineId: null,
      refineHistory: {} as Record<string, ToolOutline[]>,
      undoStack: [],
      redoStack: [],
      labels: [],
      selectedLabelId: null,
    };
  }),

  clearImage: () => {
    const prevUrl = get().imageUrl;
    if (prevUrl) {
      URL.revokeObjectURL(prevUrl);
    }
    set({
      imageFile: null,
      imageUrl: null,
      imageSize: null,
      paperCorners: null,
      paperDetected: false,
      paperConfidence: 0,
      pixelsPerMm: null,
      toolOutlines: [],
      selectedOutlineId: null,
      undoStack: [],
      redoStack: [],
      labels: [],
      selectedLabelId: null,
      currentStep: 'paper',
    });
  },
  
  setPaperCorners: (corners) => set({ paperCorners: corners }),
  
  setPaperDetected: (detected, confidence = 0) => set({
    paperDetected: detected,
    paperConfidence: confidence,
  }),
  
  setPixelsPerMm: (ppm) => set({ pixelsPerMm: ppm }),
  
  setToolOutlines: (outlines) => set((state) => ({
    undoStack: [...state.undoStack, state.toolOutlines].slice(-50),
    redoStack: [],
    toolOutlines: outlines,
    selectedOutlineId: outlines.length > 0 ? outlines[0].id : null,
  })),

  addToolOutline: (outline) => set((state) => ({
    undoStack: [...state.undoStack, state.toolOutlines].slice(-50),
    redoStack: [],
    toolOutlines: [...state.toolOutlines, outline],
    selectedOutlineId: outline.id,
  })),
  
  updateToolOutline: (id, points) => set((state) => ({
    toolOutlines: state.toolOutlines.map((o) =>
      o.id === id ? { ...o, points } : o
    ),
  })),

  updateToolOutlineSmoothed: (id, smoothedPoints) => set((state) => {
    const outline = state.toolOutlines.find(o => o.id === id);
    if (!outline) return state;
    
    let regularizedPoints: Point2D[] | undefined;
    try {
      regularizedPoints = regularizeContour(smoothedPoints, {
        lineThreshold: 2.0,
        arcResidual: 5.0,
        // Symmetry OFF: forcing mirror-symmetry distorts asymmetric tools.
        symmetryStrength: 0.0,
      });
      if (!regularizedPoints || regularizedPoints.length < 4) {
        regularizedPoints = undefined;
      }
    } catch {
      regularizedPoints = undefined;
    }

    const displayPoints = regularizedPoints ?? smoothedPoints;
    const boundingBox = getBoundingBox(displayPoints);
    const area = polygonArea(displayPoints);
    const areaInMm2 = state.pixelsPerMm ? area / (state.pixelsPerMm * state.pixelsPerMm) : undefined;
    
    return {
      toolOutlines: state.toolOutlines.map((o) =>
        o.id === id ? { ...o, smoothedPoints, regularizedPoints, boundingBox, area, areaInMm2 } : o
      ),
    };
  }),

  // Live point-editing (Edit Points tool). Unlike updateToolOutlineSmoothed,
  // this does NOT re-run regularizeContour: the global line/arc fitter re-solves
  // the whole shape on every drag frame, so nudging one anchor on a rounded tool
  // makes a far edge snap into a different/bigger arc — the "shaky, big circle on
  // the other side" bug. During editing the displayed curve must be EXACTLY the
  // anchor-driven Chaikin curve (local + stable), so we store it as smoothedPoints
  // and clear regularizedPoints (display falls back to smoothedPoints).
  updateToolOutlineEdited: (id, points) => set((state) => {
    const outline = state.toolOutlines.find(o => o.id === id);
    if (!outline) return state;
    const boundingBox = getBoundingBox(points);
    const area = polygonArea(points);
    const areaInMm2 = state.pixelsPerMm ? area / (state.pixelsPerMm * state.pixelsPerMm) : undefined;
    return {
      toolOutlines: state.toolOutlines.map((o) =>
        o.id === id ? { ...o, smoothedPoints: points, regularizedPoints: undefined, boundingBox, area, areaInMm2 } : o
      ),
    };
  }),

  updateToolOutlineRefined: (id, points, samClicks) => set((state) => {
    const outline = state.toolOutlines.find(o => o.id === id);
    if (!outline) return state;

    // Snapshot the pre-update outline so this refine click can be undone (cap 25).
    const prevHist = state.refineHistory[id] ?? [];
    const refineHistory = { ...state.refineHistory, [id]: [...prevHist, outline].slice(-25) };

    const smoothedPoints = smoothContour(points, 1.5, 0); // RDP-only: keep SAM's sharp edges

    let regularizedPoints: Point2D[] | undefined;
    try {
      regularizedPoints = regularizeContour(smoothedPoints, {
        lineThreshold: 2.0,
        arcResidual: 5.0,
        // Symmetry OFF: forcing mirror-symmetry distorts asymmetric tools
        // (knife, L-square, adjustable wrench, caliper) on refine/edit.
        symmetryStrength: 0.0,
      });
      if (!regularizedPoints || regularizedPoints.length < 4) {
        regularizedPoints = undefined;
      }
    } catch {
      regularizedPoints = undefined;
    }
    
    const displayPoints = regularizedPoints ?? smoothedPoints;
    const boundingBox = getBoundingBox(displayPoints);
    const area = polygonArea(points);
    const areaInMm2 = state.pixelsPerMm ? area / (state.pixelsPerMm * state.pixelsPerMm) : undefined;
    
    return {
      // Each refine is a discrete click → also snapshot the whole list so global
      // Ctrl+Z / Redo covers click-and-trace refines, not just add/remove.
      undoStack: [...state.undoStack, state.toolOutlines].slice(-50),
      redoStack: [],
      refineHistory,
      toolOutlines: state.toolOutlines.map((o) =>
        o.id === id ? { ...o, points, smoothedPoints, regularizedPoints, boundingBox, area, areaInMm2, samClicks } : o
      ),
    };
  }),

  // Revert the selected tool to the state before its last refine click.
  undoRefine: (id) => set((state) => {
    const hist = state.refineHistory[id];
    if (!hist || hist.length === 0) return state;
    const prev = hist[hist.length - 1];
    return {
      refineHistory: { ...state.refineHistory, [id]: hist.slice(0, -1) },
      toolOutlines: state.toolOutlines.map((o) => (o.id === id ? prev : o)),
    };
  }),

  removeToolOutline: (id) => set((state) => {
    const { [id]: _drop, ...refineHistory } = state.refineHistory;
    return {
      undoStack: [...state.undoStack, state.toolOutlines].slice(-50),
      redoStack: [],
      refineHistory,
      toolOutlines: state.toolOutlines.filter((o) => o.id !== id),
      selectedOutlineId: state.selectedOutlineId === id ? null : state.selectedOutlineId,
    };
  }),

  // Global trace undo/redo — swap the whole list, moving the current one across stacks.
  undo: () => set((state) => {
    if (state.undoStack.length === 0) return {} as Partial<typeof state>;
    const prev = state.undoStack[state.undoStack.length - 1];
    return {
      toolOutlines: prev,
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, state.toolOutlines].slice(-50),
      selectedOutlineId: null,
    };
  }),
  redo: () => set((state) => {
    if (state.redoStack.length === 0) return {} as Partial<typeof state>;
    const next = state.redoStack[state.redoStack.length - 1];
    return {
      toolOutlines: next,
      redoStack: state.redoStack.slice(0, -1),
      undoStack: [...state.undoStack, state.toolOutlines].slice(-50),
      selectedOutlineId: null,
    };
  }),

  selectOutline: (id) => set({ selectedOutlineId: id }),

  // ── Labels ────────────────────────────────────────────────────────────────
  addLabel: (label) => set((state) => ({
    labels: [...state.labels, label],
    selectedLabelId: label.id,
  })),
  updateLabel: (id, updates) => set((state) => ({
    labels: state.labels.map((l) => (l.id === id ? { ...l, ...updates } : l)),
  })),
  removeLabel: (id) => set((state) => ({
    labels: state.labels.filter((l) => l.id !== id),
    selectedLabelId: state.selectedLabelId === id ? null : state.selectedLabelId,
  })),
  selectLabel: (id) => set({ selectedLabelId: id }),

  snapToPill: (id) => set((state) => {
    const outline = state.toolOutlines.find(o => o.id === id);
    if (!outline) return state;

    const pillPoints = createOrientedPillShape(outline.smoothedPoints);
    if (!pillPoints.length) return state;

    const area = polygonArea(pillPoints);
    const newBoundingBox = getBoundingBox(pillPoints);
    const areaInMm2 = state.pixelsPerMm ? area / (state.pixelsPerMm * state.pixelsPerMm) : undefined;
    
    return {
      toolOutlines: state.toolOutlines.map(o => 
        o.id === id 
          ? { 
              ...o, 
              points: pillPoints, 
              smoothedPoints: pillPoints, 
              regularizedPoints: pillPoints,
              boundingBox: newBoundingBox, 
              area, 
              areaInMm2 
            } 
          : o
      )
    };
  }),
  
  setClearanceValue: (value) => set({ clearanceValue: value }),
  
  setActiveTool: (tool) => set({ activeTool: tool }),

  setRefineBrush: (r) => set({ refineBrush: r }),
  
  setExportFormat: (format) => set({ exportFormat: format }),
  
  // Layout Actions
  setLayoutGrid: (gridUpdates) => set((state) => ({
    layoutState: {
      ...state.layoutState,
      grid: { ...state.layoutState.grid, ...gridUpdates },
    },
  })),
  
  addLayoutShape: (shape) => set((state) => ({
    layoutState: {
      ...state.layoutState,
      shapes: [...state.layoutState.shapes, shape],
      selectedShapeId: shape.id,
    },
  })),
  
  updateLayoutShape: (id, updates) => set((state) => ({
    layoutState: {
      ...state.layoutState,
      shapes: state.layoutState.shapes.map((s) =>
        s.id === id ? { ...s, ...updates } : s
      ),
    },
  })),
  
  removeLayoutShape: (id) => set((state) => ({
    layoutState: {
      ...state.layoutState,
      shapes: state.layoutState.shapes.filter((s) => s.id !== id),
      selectedShapeId: state.layoutState.selectedShapeId === id ? null : state.layoutState.selectedShapeId,
    },
  })),
  
  selectLayoutShape: (id) => set((state) => ({
    layoutState: { ...state.layoutState, selectedShapeId: id },
  })),
  
  setLayoutTool: (tool) => set((state) => ({
    layoutState: { ...state.layoutState, layoutTool: tool },
  })),
  
  clearAllLayoutShapes: () => set((state) => ({
    layoutState: {
      ...state.layoutState,
      // Only clear non-tool shapes (preserve tool outlines)
      shapes: state.layoutState.shapes.filter((s) => s.type === 'tool'),
      selectedShapeId: null,
    },
  })),
  
  initializeLayoutFromTools: () => {
    const state = get();
    const { toolOutlines, pixelsPerMm, clearanceValue, layoutState } = state;
    
    if (!pixelsPerMm || toolOutlines.length === 0) return;

    const cell = layoutState.grid.cellWidthMm || 42;
    // Margin/gap grow with the Offset so dilated pockets never overlap.
    const MARGIN = 8 + clearanceValue;     // mm border around the tools
    const GAP = 6 + clearanceValue * 2;    // mm between stacked tools

    // 1. Each tool's raw footprint in mm. (Clearance/Offset is applied as a true
    //    contour offset at render time — not baked into the box size here.)
    const dims = toolOutlines.map((o) => {
      const b = o.boundingBox;
      return {
        outline: o,
        w: (b.maxX - b.minX) / pixelsPerMm,
        h: (b.maxY - b.minY) / pixelsPerMm,
      };
    });

    // 2. 2D SKYLINE-PACK the tools into a compact landscape block (short tools nest
    //    beside long ones — a shelf/column can't do that), so the tray looks like a
    //    real shadow board instead of a tall sliver grid. Target bin width aims for a
    //    ~3:2 landscape and never narrower than the widest tool.
    const items = dims.map((d) => ({ w: d.w, h: d.h, ref: d }));
    const maxToolW = Math.max(...items.map((it) => it.w));
    const packArea = items.reduce((s, it) => s + (it.w + GAP) * (it.h + GAP), 0);
    const binW = Math.max(maxToolW + GAP, Math.sqrt(packArea * 1.5));
    const packed = packRects(items, binW, GAP);
    const contentW = packed.width;
    const contentH = packed.height;

    // Size the grid to contain the packed block + margin, in whole 42 mm cells.
    const cols = Math.max(1, Math.ceil((contentW + MARGIN * 2) / cell));
    const rows = Math.max(1, Math.ceil((contentH + MARGIN * 2) / cell));
    const layoutW = cols * cell;
    const layoutH = rows * cell;

    // 3. Centre the packed block within the grid.
    const offX = (layoutW - contentW) / 2;
    const offY = (layoutH - contentH) / 2;
    const shapes: LayoutShape[] = packed.placements.map(({ x, y, item }) => {
      const d = item.ref;
      return {
        id: `layout-${d.outline.id}`,
        type: 'tool' as const,
        x: offX + x,
        y: offY + y,
        width: d.w,
        height: d.h,
        rotation: 0,
        toolOutlineId: d.outline.id,
        color: d.outline.color,
      };
    });

    set({
      layoutState: {
        ...layoutState,
        grid: { ...layoutState.grid, cols, rows },
        shapes,
        selectedShapeId: null,
      },
    });
  },
  
  recenterLayoutShapes: () => set((state) => {
    const { shapes, grid } = state.layoutState;
    if (shapes.length === 0) return state;
    
    // Calculate bounding box of all shapes
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    shapes.forEach((s) => {
      minX = Math.min(minX, s.x);
      minY = Math.min(minY, s.y);
      maxX = Math.max(maxX, s.x + s.width);
      maxY = Math.max(maxY, s.y + s.height);
    });
    
    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    const layoutWidth = grid.cols * grid.cellWidthMm;
    const layoutHeight = grid.rows * grid.cellHeightMm;
    
    const offsetX = (layoutWidth - contentWidth) / 2 - minX;
    const offsetY = (layoutHeight - contentHeight) / 2 - minY;
    
    return {
      layoutState: {
        ...state.layoutState,
        shapes: shapes.map((s) => ({
          ...s,
          x: s.x + offsetX,
          y: s.y + offsetY,
        })),
      },
    };
  }),
  
  updateDesignSettings: (updates) => set((state) => ({
    designSettings: { ...state.designSettings, ...updates },
  })),
  
  resetDesignSettings: () => set({
    designSettings: DEFAULT_DESIGN_SETTINGS,
  }),
  
  setProcessing: (processing, message = '') => set({
    isProcessing: processing,
    processingMessage: message,
  }),
  
  resetAll: () => {
    const prevUrl = get().imageUrl;
    if (prevUrl) {
      URL.revokeObjectURL(prevUrl);
    }
    set(initialState);
  },
}));