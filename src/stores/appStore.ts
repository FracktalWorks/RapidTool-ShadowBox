/**
 * Main Application Store
 */

import { create } from 'zustand';
import type { Point2D, PaperCorners, BoundingBox, ToolOutline } from '../lib/geometry';
import { createOrientedPillShape, polygonArea, getBoundingBox, smoothContour } from '../lib/geometry';
import { regularizeContour } from '../lib/contourRegularizer';

// Re-export types
export type { Point2D, PaperCorners, BoundingBox, ToolOutline };

// ============================================================================
// Types
// ============================================================================

export type WorkflowStep = 'paper' | 'tools' | 'layout' | 'design' | 'export';

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
  setImage: (file: File | null) => void;
  clearImage: () => void;
  
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
  updateToolOutlineRefined: (id: string, points: Point2D[], samClicks: { x: number; y: number; label: number }[]) => void;
  removeToolOutline: (id: string) => void;
  selectOutline: (id: string | null) => void;
  snapToPill: (id: string) => void;
  
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
  paperCorners: null,
  paperDetected: false,
  paperConfidence: 0,
  pixelsPerMm: null,
  toolOutlines: [],
  selectedOutlineId: null,
  clearanceValue: 0.5,
  activeTool: 'box' as const,
  refineBrush: 12,
  exportFormat: 'svg' as const,
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
      currentStep: 'paper',
    });
  },
  
  setPaperCorners: (corners) => set({ paperCorners: corners }),
  
  setPaperDetected: (detected, confidence = 0) => set({
    paperDetected: detected,
    paperConfidence: confidence,
  }),
  
  setPixelsPerMm: (ppm) => set({ pixelsPerMm: ppm }),
  
  setToolOutlines: (outlines) => set({
    toolOutlines: outlines,
    selectedOutlineId: outlines.length > 0 ? outlines[0].id : null,
  }),
  
  addToolOutline: (outline) => set((state) => ({
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

  updateToolOutlineRefined: (id, points, samClicks) => set((state) => {
    const outline = state.toolOutlines.find(o => o.id === id);
    if (!outline) return state;
    
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
      toolOutlines: state.toolOutlines.map((o) =>
        o.id === id ? { ...o, points, smoothedPoints, regularizedPoints, boundingBox, area, areaInMm2, samClicks } : o
      ),
    };
  }),
  
  removeToolOutline: (id) => set((state) => ({
    toolOutlines: state.toolOutlines.filter((o) => o.id !== id),
    selectedOutlineId: state.selectedOutlineId === id ? null : state.selectedOutlineId,
  })),
  
  selectOutline: (id) => set({ selectedOutlineId: id }),

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

    // 2. AUTO-SIZE the grid to actually CONTAIN the tools (stacked vertically),
    //    so long tools are never clipped. Grid grows in whole 42 mm cells.
    const stackH = dims.reduce((s, d) => s + d.h, 0) + GAP * (dims.length - 1);
    const neededW = Math.max(...dims.map((d) => d.w)) + MARGIN * 2;
    const neededH = stackH + MARGIN * 2;
    const cols = Math.max(1, Math.ceil(neededW / cell));
    const rows = Math.max(1, Math.ceil(neededH / cell));
    const layoutW = cols * cell;
    const layoutH = rows * cell;

    // 3. Place tools: vertical centred stack, each horizontally centred.
    let y = (layoutH - stackH) / 2;
    const shapes: LayoutShape[] = dims.map((d) => {
      const shape: LayoutShape = {
        id: `layout-${d.outline.id}`,
        type: 'tool',
        x: (layoutW - d.w) / 2,
        y,
        width: d.w,
        height: d.h,
        rotation: 0,
        toolOutlineId: d.outline.id,
        color: d.outline.color,
      };
      y += d.h + GAP;
      return shape;
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