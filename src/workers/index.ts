/**
 * Workers Module
 */

export {
  detectPaper,
  rectifyToA4,
  traceTool,
  traceRegion,
  traceAllTools,
  grabCutInit,
  grabCutRefine,
  grabCutClear,
  contourFromMask,
  getImageData,
  type PaperDetectionResult,
  type ToolTracingResult,
  type Stroke,
} from './cvWorkerManager';

export {
  samSegmentPoint,
  samAutoSegment,
  samPreload,
  samClear,
  samEverLoaded,
  type SamLoadProgress,
} from './samWorkerManager';

export {
  sodDetect,
  sodPreload,
  type SodProgress,
} from './sodWorkerManager';
