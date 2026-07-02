/**
 * ControlPanel
 *
 * Right sidebar with step-based workflow controls.
 * Steps: Detect Paper → Trace Tools → Configure Layout → 3D Design → Export
 */

import React, { useCallback, useRef, useState, useEffect } from "react";
import {
  Image as ImageIcon,
  Wrench,
  Download,
  Trash2,
  Check,
  AlertCircle,
  ChevronRight,
  Loader2,
  RefreshCw,
  MousePointerClick,
  MousePointer2,
  SquareDashed,
  Paintbrush,
  Hand,
  Circle,
  Square,
  RectangleHorizontal,
  Shapes,
  Lightbulb,
  Camera,
  FileText,
  Sparkles,
  Plus,
  Undo2,
  Upload,
} from "lucide-react";

import { useAppStore } from "../stores";
import { detectPaper, rectifyToA4, getImageData } from "../workers";
import { downloadSVG } from "../lib/exportSVG";
import { offsetPolygon } from "../lib/geometry";
import { useProgress } from "../stores/progressStore";

// ============================================================================
// Paper Detection Step Panel (includes image upload)
// ============================================================================

const PaperStepPanel: React.FC = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const {
    imageFile,
    setImage,
    clearImage,
    paperDetected,
    paperCorners,
    pixelsPerMm,
    imageUrl,
    isRectified,
    applyRectification,
    setCurrentStep,
    setPaperDetected,
    setPaperCorners,
    setPixelsPerMm,
  } = useAppStore();

  const [isDetecting, setIsDetecting] = useState(false);
  const [isRectifying, setIsRectifying] = useState(false);
  const [detectionMessage, setDetectionMessage] = useState<string | null>(null);

  // Skew-correct the photo to a flat A4 (using the detected/dragged corners), make
  // it the working image, then advance to tracing. For a top-down photo the warp is
  // ~identity (no-op). On any failure, fall through to tracing on the original image.
  const handleContinueToTrace = useCallback(async () => {
    if (!imageUrl || !paperCorners) { setCurrentStep("tools"); return; }

    // Only warp when there's REAL perspective skew. A near-top-down photo's quad is
    // already ~rectangular, so warping it would only resample (softening edges and
    // making tool shadows relatively more salient to detection) for no geometric gain.
    // Skew = how much opposite edges differ in length (0 = perfect rectangle).
    const c = paperCorners;
    const d = (a: typeof c.topLeft, b: typeof c.topLeft) => Math.hypot(a.x - b.x, a.y - b.y);
    const top = d(c.topLeft, c.topRight), bot = d(c.bottomLeft, c.bottomRight);
    const left = d(c.topLeft, c.bottomLeft), right = d(c.topRight, c.bottomRight);
    const skew = Math.max(Math.abs(top - bot) / Math.max(top, bot, 1), Math.abs(left - right) / Math.max(left, right, 1));
    if (skew < 0.04) { setCurrentStep("tools"); return; } // near-flat → keep the sharper original

    setIsRectifying(true);
    try {
      const imageData = await getImageData(imageUrl);
      const { rgba, width, height } = await rectifyToA4(imageData, paperCorners);
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
      const url: string = await new Promise((res, rej) =>
        canvas.toBlob((b) => (b ? res(URL.createObjectURL(b)) : rej(new Error("toBlob failed"))), "image/png")
      );
      const ppm = Math.max(width, height) / 297; // A4 long side = 297 mm → exact, uniform
      applyRectification(url, { width, height }, ppm);
    } catch (e) {
      console.warn("Skew-correction failed; tracing on the original image:", e);
    } finally {
      setIsRectifying(false);
      setCurrentStep("tools");
    }
  }, [imageUrl, paperCorners, applyRectification, setCurrentStep]);

  // Revert a rectified image back to the original photo to re-do paper detection.
  const handleRevertToOriginal = useCallback(() => {
    if (imageFile) setImage(imageFile);
  }, [imageFile, setImage]);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        setImage(file);
      }
    },
    [setImage],
  );

  const runAutoDetect = useCallback(async () => {
    if (!imageUrl) return;

    setIsDetecting(true);
    setDetectionMessage(null);

    try {
      const result = await detectPaper(imageUrl);

      if (result.detected && result.corners) {
        setPaperCorners(result.corners);
        setPaperDetected(true, result.confidence);
        if (result.pixelsPerMm) {
          setPixelsPerMm(result.pixelsPerMm);
        }
        setDetectionMessage(result.message || "Paper detected successfully");
      } else {
        setDetectionMessage(
          result.message ||
          "Could not detect paper. Please adjust corners manually.",
        );
        setPaperDetected(false, 0);
      }
    } catch (error) {
      console.error("Paper detection error:", error);
      setDetectionMessage("Detection failed. Please set corners manually.");
    } finally {
      setIsDetecting(false);
    }
  }, [imageUrl, setPaperDetected, setPaperCorners, setPixelsPerMm]);

  // Auto-detect when image is loaded
  React.useEffect(() => {
    if (imageUrl && !paperDetected && !isDetecting) {
      runAutoDetect();
    }
  }, [imageUrl]);

  const handleRetryDetection = useCallback(() => {
    setPaperDetected(false, 0);
    setDetectionMessage(null);
    runAutoDetect();
  }, [setPaperDetected, runAutoDetect]);

  const handleManualMode = useCallback(() => {
    setPaperCorners({
      topLeft: { x: 100, y: 100 },
      topRight: { x: 400, y: 100 },
      bottomRight: { x: 400, y: 500 },
      bottomLeft: { x: 100, y: 500 },
    });
    setPaperDetected(true, 0.5);
    setDetectionMessage("Manual mode - drag corners to match paper edges");
  }, [setPaperCorners, setPaperDetected]);

  return (
    <div className="h-full flex flex-col">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileSelect}
        className="hidden"
      />

      {/* When no image is loaded - show helpful getting started content */}
      {!imageFile ? (
        <div className="h-full flex flex-col">
          {/* Top section - scrollable tips */}
          <div className="flex-1 overflow-y-auto space-y-4 px-4 py-4">
            {/* Upload Dropzone Card (Aligned with RapidTool-Fixture style) */}
            <div
              onClick={() => fileInputRef.current?.click()}
              className="
                relative overflow-hidden tech-glass border-2 border-dashed border-[hsl(var(--border))] 
                hover:border-[hsl(var(--primary)/0.5)] rounded-xl p-6 text-center cursor-pointer 
                transition-all duration-300 group
              "
            >
              <div className="mx-auto mb-3.5 w-14 h-14 rounded-2xl bg-[hsl(var(--muted)/0.4)] border border-[hsl(var(--border)/0.6)] flex items-center justify-center transition-colors group-hover:bg-[hsl(var(--primary)/0.05)] group-hover:border-[hsl(var(--primary)/0.2)]">
                <Upload className="w-6 h-6 text-[hsl(var(--muted-foreground))] transition-colors group-hover:text-[hsl(var(--primary))]" />
              </div>
              <h3 className="font-tech font-semibold text-sm text-[hsl(var(--foreground))]">Import Paper Image</h3>
              <p className="text-xs text-[hsl(var(--muted-foreground))] font-tech mt-2 leading-relaxed text-center flex flex-col items-center">
                <span>Drag and drop image here, or</span>
                <span className="text-[hsl(var(--primary))] hover:underline font-medium mt-1 cursor-pointer">browse files</span>
              </p>
              
              <div className="mt-5 pt-4 border-t border-[hsl(var(--border)/0.5)] space-y-2">
                <div className="flex items-center justify-center gap-2 text-xs text-[hsl(var(--muted-foreground))] font-tech">
                  <FileText className="w-3.5 h-3.5" />
                  <span>Supported formats: JPEG, PNG, WEBP, BMP</span>
                </div>
                <div className="flex items-center justify-center gap-2 text-xs text-[hsl(var(--muted-foreground))] font-tech">
                  <AlertCircle className="w-3.5 h-3.5" />
                  <span>Maximum file size: 50 MB</span>
                </div>
              </div>
            </div>

            {/* Quick Start & Supported Formats Card */}
            <div className="tech-glass rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-[hsl(var(--primary))]" />
                <h4 className="text-xs font-semibold text-[hsl(var(--foreground))]">Quick Start</h4>
              </div>
              <p className="text-xs text-[hsl(var(--muted-foreground))] leading-relaxed font-tech">
                Upload a photo of your tools on white A4 paper. We'll automatically calibrate scale dimensions and trace their outlines.
              </p>
              <div className="h-px bg-[hsl(var(--border)/0.5)] my-2" />
              <div className="text-xs text-[hsl(var(--muted-foreground))] font-tech space-y-1.5">
                <p className="font-semibold text-[hsl(var(--foreground))]">Supported formats:</p>
                <div className="flex flex-wrap gap-1.5">
                  {['JPEG', 'PNG', 'WEBP', 'BMP'].map(fmt => (
                    <span key={fmt} className="px-1.5 py-0.5 bg-[hsl(var(--muted)/0.6)] border border-[hsl(var(--border)/0.4)] rounded text-[10px] font-bold">
                      {fmt}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Best Practices */}
            <div className="space-y-2.5">
              <div className="flex items-center gap-2">
                <Lightbulb className="w-4 h-4 text-[hsl(var(--warning))]" />
                <h3 className="text-[13px] font-semibold" style={{ letterSpacing: '-0.02em' }}>Best Practices</h3>
              </div>

              <div className="space-y-2">
                {/* Tip 1 */}
                <div className="flex gap-2.5 p-3 bg-[hsl(var(--muted)/0.4)] rounded-xl">
                  <div className="w-6 h-6 rounded-md bg-[hsl(var(--primary)/0.1)] flex items-center justify-center shrink-0">
                    <FileText className="w-3.5 h-3.5 text-[hsl(var(--primary))]" />
                  </div>
                  <div>
                    <p className="text-[12px] font-medium">Use White A4 Paper</p>
                    <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5">Standard A4 provides accurate scale</p>
                  </div>
                </div>

                {/* Tip 2 */}
                <div className="flex gap-2.5 p-3 bg-[hsl(var(--muted)/0.4)] rounded-xl">
                  <div className="w-6 h-6 rounded-md bg-[hsl(var(--primary)/0.1)] flex items-center justify-center shrink-0">
                    <Camera className="w-3.5 h-3.5 text-[hsl(var(--primary))]" />
                  </div>
                  <div>
                    <p className="text-[12px] font-medium">Shoot from Above</p>
                    <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5">Keep camera parallel to paper</p>
                  </div>
                </div>

                {/* Tip 3 */}
                <div className="flex gap-2.5 p-3 bg-[hsl(var(--muted)/0.4)] rounded-xl">
                  <div className="w-6 h-6 rounded-md bg-[hsl(var(--primary)/0.1)] flex items-center justify-center shrink-0">
                    <Lightbulb className="w-3.5 h-3.5 text-[hsl(var(--primary))]" />
                  </div>
                  <div>
                    <p className="text-[12px] font-medium">Good Lighting</p>
                    <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5">Avoid shadows for cleaner detection</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom section - Progress */}
          <div className="pt-4 mt-auto border-t border-[hsl(var(--border))] space-y-4 px-4 pb-4">
            <div className="space-y-2.5">
              <h3 className="text-[11px] font-bold text-[hsl(var(--foreground))] uppercase tracking-widest px-1">
                Process
              </h3>
              <div className="space-y-2">
                <div className="flex items-center gap-2.5 opacity-60">
                  <div className="w-5 h-5 rounded-full bg-[hsl(var(--primary)/0.2)] text-[hsl(var(--primary))] flex items-center justify-center text-[10px] font-bold shrink-0">
                    1
                  </div>
                  <span className="text-[12px] font-medium text-[hsl(var(--muted-foreground))]">
                    Detect Paper
                  </span>
                </div>
                <div className="flex items-center gap-2.5 opacity-40">
                  <div className="w-5 h-5 rounded-full bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] flex items-center justify-center text-[10px] font-bold shrink-0">
                    2
                  </div>
                  <span className="text-[12px] font-medium text-[hsl(var(--muted-foreground))]">
                    Trace Tools
                  </span>
                </div>
              </div>
            </div>

            <button
              disabled
              className="
                w-full h-11 px-4 
                rounded-xl text-[14px] font-bold
                bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]
                cursor-not-allowed opacity-50
                flex items-center justify-center gap-2
              "
            >
              Continue to Tracing
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      ) : (
        /* When image is loaded - show image info and detection status */
        <>
          <div className="flex-1 overflow-y-auto space-y-3 px-4 py-4">
            {/* Loaded image indicator */}
            <div className="flex items-center gap-2.5 p-3 bg-[hsl(var(--muted)/0.4)] rounded-xl">
              <div className="w-8 h-8 rounded-lg bg-[hsl(var(--background))] flex items-center justify-center">
                <ImageIcon className="w-4 h-4 text-[hsl(var(--muted-foreground))]" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-medium truncate">{imageFile.name}</p>
                <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
                  {(imageFile.size / 1024 / 1024).toFixed(2)} MB
                </p>
              </div>
              <button
                onClick={clearImage}
                className="p-1.5 hover:bg-[hsl(var(--destructive)/0.1)] rounded transition-colors"
                title="Remove image"
              >
                <Trash2 className="w-3.5 h-3.5 text-[hsl(var(--destructive))]" />
              </button>
            </div>
          </div>

          {/* Bottom Section - Detection Status & CTA */}
          <div className="pt-3 border-t border-[hsl(var(--border))] mt-3 space-y-3 px-4 pb-4">
            {/* Detection Status */}
            {isDetecting ? (
              <div className="flex items-center gap-2 p-3 bg-[hsl(var(--primary)/0.05)] border border-[hsl(var(--primary)/0.1)] rounded-xl">
                <Loader2 className="w-3.5 h-3.5 text-[hsl(var(--primary))] animate-spin" />
                <span className="text-[13px] text-[hsl(var(--primary))] font-medium">
                  Detecting paper...
                </span>
              </div>
            ) : paperDetected ? (
              <>
                <div className="flex items-center gap-2 p-3 bg-[hsl(var(--success)/0.06)] border border-[hsl(var(--success)/0.12)] rounded-xl">
                  <Check className="w-3.5 h-3.5 text-[hsl(var(--success))]" />
                  <span className="text-[13px] text-[hsl(var(--success))] font-medium">
                    {detectionMessage || "Detected"}
                  </span>
                </div>

                {pixelsPerMm && (
                  <div className="flex items-center justify-between p-3 bg-[hsl(var(--muted)/0.4)] rounded-xl">
                    <span className="text-[11px] text-[hsl(var(--muted-foreground))] uppercase tracking-wider font-semibold">
                      Scale
                    </span>
                    <span className="text-[13px] font-semibold font-tech">
                      {pixelsPerMm.toFixed(2)} px/mm
                    </span>
                  </div>
                )}

                <p className="text-[11px] text-[hsl(var(--muted-foreground))] font-medium">
                  {isRectified
                    ? "Flattened to A4 — outlines will be to scale. Revert to re-detect on the original photo."
                    : "Drag corner handles in the viewport to fit the sheet. Continue straightens any tilt to a flat A4."}
                </p>

                <div className="flex gap-2">
                  <button
                    onClick={isRectified ? handleRevertToOriginal : handleRetryDetection}
                    disabled={isRectifying}
                    className="
                      flex-1 h-9 px-3 border border-[hsl(var(--border))]
                      rounded-xl text-[13px] font-medium hover:bg-[hsl(var(--muted))]
                      transition-all duration-200 flex items-center justify-center gap-1.5
                      disabled:opacity-50
                    "
                  >
                    <RefreshCw className="w-3 h-3" />
                    {isRectified ? "Revert" : "Re-detect"}
                  </button>
                  <button
                    onClick={handleContinueToTrace}
                    disabled={isRectifying}
                    className="
                      flex-1 h-9 px-3
                      rounded-xl text-[13px] font-semibold
                      transition-all duration-200 flex items-center justify-center gap-1.5
                      text-white disabled:opacity-60
                    "
                    style={{ background: 'var(--gradient-primary)', boxShadow: 'var(--shadow-btn)' }}
                  >
                    {isRectifying ? (
                      <><Loader2 className="w-3 h-3 animate-spin" /> Straightening…</>
                    ) : (
                      <>Continue <ChevronRight className="w-3 h-3" /></>
                    )}
                  </button>
                </div>
              </>
            ) : (
              <>
                {detectionMessage && (
                  <div className="flex items-start gap-2 p-3 bg-[hsl(var(--warning)/0.06)] border border-[hsl(var(--warning)/0.12)] rounded-xl">
                    <AlertCircle className="w-3.5 h-3.5 text-[hsl(var(--warning))] shrink-0 mt-0.5" />
                    <span className="text-[11px] text-[hsl(var(--warning))] font-medium">
                      {detectionMessage}
                    </span>
                  </div>
                )}

                <div className="flex gap-2">
                  <button
                    onClick={handleManualMode}
                    disabled={isDetecting}
                    className="
                      flex-1 h-9 px-3 border border-[hsl(var(--border))]
                      rounded-xl text-[13px] font-medium hover:bg-[hsl(var(--muted))]
                      transition-all duration-200
                    "
                  >
                    Set Manually
                  </button>
                  <button
                    onClick={runAutoDetect}
                    disabled={isDetecting}
                    className="
                      flex-1 h-9 px-3
                      rounded-xl text-[13px] font-semibold
                      transition-all duration-200 flex items-center justify-center gap-1.5
                      disabled:opacity-50 disabled:cursor-not-allowed text-white
                    "
                    style={{ background: 'var(--gradient-primary)', boxShadow: 'var(--shadow-btn)' }}
                  >
                    {isDetecting ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Detecting...
                      </>
                    ) : (
                      "Retry"
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
};

// ============================================================================
// Tools Step Panel
// ============================================================================

const ToolsStepPanel: React.FC = () => {
  const {
    toolOutlines,
    selectedOutlineId,
    selectOutline,
    removeToolOutline,
    setToolOutlines,
    setCurrentStep,
    clearanceValue,
    setClearanceValue,
    activeTool,
    setActiveTool,
    imageUrl,
    pixelsPerMm,
    paperCorners,
    snapToPill,
    refineHistory,
    undoRefine,
  } = useAppStore();

  const canUndoRefine = !!(selectedOutlineId && (refineHistory[selectedOutlineId]?.length ?? 0) > 0);

  const [isAutoDetecting, setIsAutoDetecting] = useState(false);
  const [autoDetectDone, setAutoDetectDone] = useState(false);
  const [autoDetectCount, setAutoDetectCount] = useState(0);
  const [isAiDetecting, setIsAiDetecting] = useState(false);
  const [aiProgress, setAiProgress] = useState<number | null>(null);
  // Live progress from the global store (real-time % for the detect banner).
  const progressActive = useProgress((s) => s.active);
  const progressPercent = useProgress((s) => s.percent);
  const progressLabel = useProgress((s) => s.label);

  // Show UI even when paper not detected, just disable interactions
  // const isDisabled = !paperDetected;
  const isDisabled = false;

  // Auto-detect all tools function
  const runAutoDetect = useCallback(async () => {
    if (!imageUrl || isAutoDetecting) return;

    setIsAutoDetecting(true);
    try {
      const { traceAllTools } = await import('../workers');
      const { smoothContour, getBoundingBox } = await import('../lib/geometry');

      const results = await traceAllTools(imageUrl, paperCorners);

      if (results && results.length > 0) {
        const TOOL_COLORS = [
          '#3b82f6', '#ef4444', '#22c55e', '#f59e0b',
          '#8b5cf6', '#ec4899', '#06b6d4', '#f97316',
        ];

        const newOutlines = results.map((result, index) => {
          // RDP-only (0 Chaikin) — keep sharp corners; default was 4 Chaikin passes.
          const smoothed = smoothContour(result.points, 1.5, 0);
          const bbox = getBoundingBox(result.points);
          return {
            id: `tool-${Date.now()}-${index}-${Math.random().toString(36).substring(2, 9)}`,
            points: result.points,
            smoothedPoints: smoothed,
            boundingBox: bbox,
            area: result.area,
            areaInMm2: pixelsPerMm ? result.area / (pixelsPerMm * pixelsPerMm) : undefined,
            color: TOOL_COLORS[index % TOOL_COLORS.length],
            name: `Tool ${index + 1}`,
            confidence: result.confidence,
          };
        });

        setToolOutlines(newOutlines);
        setAutoDetectCount(results.length);
      }
      setAutoDetectDone(true);
    } catch (error) {
      console.error('Auto-detect failed:', error);
      setAutoDetectDone(true);
    } finally {
      setIsAutoDetecting(false);
    }
  }, [imageUrl, isAutoDetecting, pixelsPerMm, setToolOutlines, paperCorners]);

  // Autonomous AI detection (SlimSAM): classical proposes prompts → SAM
  // segments each precisely (incl. chrome). Lazy-downloads the model once.
  const runAiDetect = useCallback(async () => {
    if (!imageUrl || isAiDetecting) return;
    setIsAiDetecting(true);
    setAiProgress(0);
    try {
      const { samAutoSegment } = await import('../workers');
      const { smoothContour, getBoundingBox } = await import('../lib/geometry');

      const results = await samAutoSegment(imageUrl, paperCorners, (p) => setAiProgress(Math.round(p.progress)));

      if (results && results.length > 0) {
        const TOOL_COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];
        const newOutlines = results.map((result, index) => {
          // RDP-only (0 Chaikin) — keep SAM's sharp corners crisp (see geometry.ts).
          const smoothed = smoothContour(result.points, 1.5, 0);
          return {
            id: `ai-${Date.now()}-${index}-${Math.random().toString(36).substring(2, 9)}`,
            points: result.points,
            smoothedPoints: smoothed,
            boundingBox: getBoundingBox(smoothed),
            area: result.area,
            areaInMm2: pixelsPerMm ? result.area / (pixelsPerMm * pixelsPerMm) : undefined,
            color: TOOL_COLORS[index % TOOL_COLORS.length],
            name: `Tool ${index + 1}`,
            confidence: result.confidence,
          };
        });
        setToolOutlines(newOutlines);
        setAutoDetectCount(results.length);
      } else {
        // Keep the workflow moving if SAM rejects every prompt; classical can
        // still provide a usable baseline that the user can refine manually.
        await runAutoDetect();
      }
      setAutoDetectDone(true);
    } catch (error) {
      console.error('AI detect failed, falling back to classical auto-detect:', error);
      await runAutoDetect();
      setAutoDetectDone(true);
    } finally {
      setIsAiDetecting(false);
      setAiProgress(null);
    }
  }, [imageUrl, isAiDetecting, pixelsPerMm, setToolOutlines, paperCorners, runAutoDetect]);

  // SOD detection (IS-Net, trained model): produces a clean foreground mask that
  // solves chrome, shadows and tool separation at the mask level, then routes
  // through the same OpenCV gates + RDP edges as classical. Falls back to the
  // classical foreground path if the model can't load or returns nothing.
  const runSodDetect = useCallback(async () => {
    if (!imageUrl || isAiDetecting) return;
    setIsAiDetecting(true);
    setAiProgress(0);
    try {
      const { sodDetect } = await import('../workers');
      const { smoothContour, getBoundingBox } = await import('../lib/geometry');

      const results = await sodDetect(imageUrl, paperCorners ?? undefined);

      // SOD keys on saliency, so an all-metallic / low-contrast tool (e.g. a bare
      // steel screw on greyish paper) reads as background and SOD returns only a
      // weak noise blob. Treat low best-confidence as failure and fall back to the
      // classical brightness/edge detector (which keys on contrast, not saliency).
      const maxConf = results && results.length ? Math.max(...results.map((r) => r.confidence ?? 0)) : 0;
      const sodWeak = !results || results.length === 0 || maxConf < 0.5;

      if (!sodWeak) {
        const TOOL_COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];
        const newOutlines = results.map((result, index) => {
          // SOD masks have organic, slightly serrated boundaries (1024² upscaled).
          // RDP (2.5) drops the staircase, then 2 Chaikin passes smooth the curve.
          const smoothed = smoothContour(result.points, 2.5, 2);
          return {
            id: `sod-${Date.now()}-${index}-${Math.random().toString(36).substring(2, 9)}`,
            points: result.points,
            smoothedPoints: smoothed,
            boundingBox: getBoundingBox(smoothed),
            area: result.area,
            areaInMm2: pixelsPerMm ? result.area / (pixelsPerMm * pixelsPerMm) : undefined,
            color: TOOL_COLORS[index % TOOL_COLORS.length],
            name: `Tool ${index + 1}`,
            confidence: result.confidence,
          };
        });
        setToolOutlines(newOutlines);
        setAutoDetectCount(results.length);
      } else {
        await runAutoDetect();
      }
      setAutoDetectDone(true);
    } catch (error) {
      console.error('SOD detect failed, falling back to classical auto-detect:', error);
      await runAutoDetect();
      setAutoDetectDone(true);
    } finally {
      setIsAiDetecting(false);
      setAiProgress(null);
    }
  }, [imageUrl, isAiDetecting, pixelsPerMm, setToolOutlines, paperCorners, runAutoDetect]);

  const autoDetectRef = useRef<string | null>(null);

  // Auto-run the trained SOD detector (IS-Net) on load — solves chrome, shadows
  // and separation at the mask level, with the classical foreground path as
  // fallback. SAM-per-prompt (runAiDetect) stays a manual button; one-click SAM
  // refine handles any touching/chrome stragglers.
  useEffect(() => {
    if (imageUrl && !autoDetectDone && toolOutlines.length === 0 && autoDetectRef.current !== imageUrl) {
      autoDetectRef.current = imageUrl;
      runSodDetect();
    }
  }, [imageUrl, autoDetectDone, toolOutlines.length, runSodDetect]);

  return (
    <div className="h-full flex flex-col">
      {/* Prerequisite Warning Banner */}
      {isDisabled && (
        <div className="mb-3 p-3 mx-4 mt-4 bg-[hsl(var(--warning)/0.08)] border border-[hsl(var(--warning)/0.15)] rounded-xl flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-[hsl(var(--warning))] shrink-0" />
          <p className="text-[12px] text-[hsl(var(--warning))] font-medium">
            Complete paper detection first to enable tracing
          </p>
        </div>
      )}

      {/* Scrollable Content */}
      <div
        className={`flex-1 overflow-y-auto space-y-3 px-4 py-4 ${isDisabled ? "opacity-60 pointer-events-none" : ""}`}
      >
        {/* Auto Detect (AI) Banner / Status */}
        {isAiDetecting && (
          <div className="flex items-center gap-2 p-2.5 bg-[hsl(var(--primary)/0.05)] border border-[hsl(var(--primary)/0.1)] rounded-lg">
            <Loader2 className="w-3.5 h-3.5 text-[hsl(var(--primary))] animate-spin" />
            <span className="text-xs text-[hsl(var(--primary))]">
              {progressActive ? `${progressLabel} ${Math.round(progressPercent)}%` : (aiProgress !== null ? `Detecting tools… ${aiProgress}%` : 'Preparing…')}
            </span>
          </div>
        )}

        {/* Auto Detect Tools (AI) Button */}
        <button
          onClick={runAiDetect}
          disabled={isAiDetecting || isDisabled}
          className="
            w-full h-9 px-3 text-white
            rounded-lg text-xs font-semibold transition-all
            flex items-center justify-center gap-1.5
            disabled:opacity-50 disabled:cursor-not-allowed
          "
          style={{ background: 'var(--gradient-primary)', boxShadow: 'var(--shadow-btn)' }}
          title="Automatically detect every tool on the sheet — precise even on shiny/chrome tools. Runs entirely on your device."
        >
          {isAiDetecting ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Detecting...
            </>
          ) : (
            <>
              <Sparkles className="w-3.5 h-3.5" />
              Auto Detect Tools
            </>
          )}
        </button>

        {/* Tracing Mode Selection */}
        <div className="space-y-1.5">
          <label className="text-[11px] font-semibold text-[hsl(var(--muted-foreground))] uppercase" style={{ letterSpacing: '0.08em' }}>
            Tracing Mode
          </label>
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => setActiveTool("box")}
              disabled={isDisabled}
              className={`
                p-3 rounded-xl border transition-all duration-200 text-left
                ${activeTool === "box"
                  ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.08)]"
                  : "border-[hsl(var(--border))] hover:border-[hsl(var(--primary)/0.5)] hover:bg-[hsl(var(--muted)/0.5)]"
                }
              `}
            >
              <SquareDashed
                className={`w-4 h-4 mb-1.5 ${activeTool === "box" ? "text-[hsl(var(--primary))]" : "text-[hsl(var(--muted-foreground))]"}`}
              />
              <div className="text-[13px] font-medium">Box Select</div>
              <div className="text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5">
                Draw rectangle area
              </div>
            </button>
            <button
              onClick={() => setActiveTool("trace")}
              disabled={isDisabled}
              className={`
                p-3 rounded-xl border transition-all duration-200 text-left
                ${activeTool === "trace"
                  ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.08)]"
                  : "border-[hsl(var(--border))] hover:border-[hsl(var(--primary)/0.5)] hover:bg-[hsl(var(--muted)/0.5)]"
                }
              `}
            >
              <MousePointerClick
                className={`w-4 h-4 mb-1.5 ${activeTool === "trace" ? "text-[hsl(var(--primary))]" : "text-[hsl(var(--muted-foreground))]"}`}
              />
              <div className="text-[13px] font-medium">Click Trace</div>
              <div className="text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5">
                Click a tool to trace it
              </div>
            </button>
            <button
              onClick={() => setActiveTool("edit")}
              disabled={isDisabled}
              className={`
                p-2.5 rounded-lg border transition-all text-left
                ${activeTool === "edit"
                  ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.08)]"
                  : "border-[hsl(var(--border))] hover:border-[hsl(var(--primary)/0.5)] hover:bg-[hsl(var(--muted)/0.5)]"
                }
              `}
            >
              <MousePointer2
                className={`w-4 h-4 mb-1.5 ${activeTool === "edit" ? "text-[hsl(var(--primary))]" : "text-[hsl(var(--muted-foreground))]"}`}
              />
              <div className="text-xs font-medium">Edit Pts</div>
              <div className="text-[10px] text-[hsl(var(--muted-foreground))] mt-0.5">
                Adjust points
              </div>
            </button>
          </div>

          {/* Refine — full-width, highlights the precision tool */}
          <button
            onClick={() => setActiveTool(activeTool === "refine" ? "box" : "refine")}
            disabled={isDisabled}
            className={`
              w-full flex items-center gap-2.5 p-3 rounded-xl border transition-all duration-200 text-left
              ${activeTool === "refine"
                ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.08)]"
                : "border-[hsl(var(--border))] hover:border-[hsl(var(--primary)/0.5)] hover:bg-[hsl(var(--muted)/0.5)]"
              }
            `}
          >
            <Paintbrush className={`w-4 h-4 shrink-0 ${activeTool === "refine" ? "text-[hsl(var(--primary))]" : "text-[hsl(var(--muted-foreground))]"}`} />
            <div className="flex-1">
              <div className="text-[13px] font-medium">Refine Edges</div>
              <div className="text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5">
                Click to add or remove regions from the selected tool
              </div>
            </div>
          </button>
        </div>

        {/* Mode Info — refine instructions when active */}
        {activeTool === "refine" ? (
          <div className="p-3 bg-[hsl(var(--primary)/0.05)] border border-[hsl(var(--primary)/0.15)] rounded-xl space-y-2.5">
            <p className="text-[12px] text-[hsl(var(--foreground))] leading-relaxed">
              <span className="inline-flex items-center gap-1 font-medium" style={{ color: 'hsl(142 76% 40%)' }}>● Left-click</span> = add region ·{" "}
              <span className="inline-flex items-center gap-1 font-medium" style={{ color: 'hsl(0 84% 55%)' }}>● Shift+click</span> = remove region.
              First select a tool outline in the list or viewport, then click to refine.
            </p>
          </div>
        ) : (
          <div className="p-3 bg-[hsl(var(--muted)/0.4)] rounded-xl">
            <p className="text-[12px] text-[hsl(var(--muted-foreground))] leading-relaxed">
              {activeTool === "box"
                ? "Draw a rectangle around one tool to trace it. Use Refine Edges to correct details."
                : activeTool === "trace"
                  ? "Click a tool — it's traced precisely on your device. Select a tool to refine it: left-click to add, Shift+click to subtract." : "Select a listed tool, then drag its anchor points to reshape the curve"}
            </p>
          </div>
        )}

        {/* Undo last refine edit on the selected tool (revert a bad click) */}
        {canUndoRefine && (
          <button
            onClick={() => selectedOutlineId && undoRefine(selectedOutlineId)}
            className="w-full flex items-center justify-center gap-1.5 h-8 rounded-lg border border-[hsl(var(--border))] text-xs font-medium text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))] hover:border-[hsl(var(--accent)/0.4)] tech-transition"
            title="Undo the last add/remove click on the selected tool"
          >
            <Undo2 className="w-3.5 h-3.5" />
            Undo last edit
          </button>
        )}

        {/* Tool List */}
        <div className="space-y-1.5">
          <label className="text-[11px] font-semibold text-[hsl(var(--muted-foreground))] uppercase" style={{ letterSpacing: '0.08em' }}>
            Traced Tools ({toolOutlines.length})
          </label>
          {toolOutlines.length > 0 ? (
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {toolOutlines.map((outline) => (
                <div
                  key={outline.id}
                  className={`
                    flex items-center gap-2 p-2.5 rounded-xl cursor-pointer transition-all duration-200
                    ${outline.id === selectedOutlineId
                      ? "bg-[hsl(var(--primary)/0.1)] border border-[hsl(var(--primary)/0.2)]"
                      : "hover:bg-[hsl(var(--muted)/0.5)] border border-transparent"
                    }
                  `}
                  onClick={() => selectOutline(outline.id)}
                >
                  <div
                    className="w-3 h-3 rounded-full shrink-0"
                    style={{ backgroundColor: outline.color }}
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-[13px] font-medium truncate flex items-center gap-1.5">
                      {outline.name}
                      {outline.templateMatched && (
                        <span className="inline-flex items-center text-[10px] text-[hsl(var(--success))] bg-[hsl(var(--success)/0.12)] px-1.5 py-0.5 rounded-full font-medium" title="Replaced with perfect database template">
                          <Sparkles className="w-2.5 h-2.5 mr-0.5" />
                          CAD
                        </span>
                      )}
                    </span>
                    <span className="flex items-center gap-1.5">
                      {outline.areaInMm2 && (
                        <span className="text-[11px] text-[hsl(var(--muted-foreground))]">
                          {outline.areaInMm2.toFixed(1)} mm²
                        </span>
                      )}
                      {outline.confidence !== undefined && outline.confidence < 0.85 && (
                        <span
                          className="inline-flex items-center gap-0.5 text-[10px] font-medium text-[hsl(var(--warning))]"
                          title={`Low detection confidence (${Math.round(outline.confidence * 100)}%) — review or re-trace this outline`}
                        >
                          <AlertCircle className="w-2.5 h-2.5" />
                          {Math.round(outline.confidence * 100)}%
                        </span>
                      )}
                    </span>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      snapToPill(outline.id);
                    }}
                    className="p-1 hover:bg-[hsl(var(--primary)/0.1)] rounded transition-colors shrink-0 mr-1"
                    title="Snap to geometric shape (Pill)"
                  >
                    <Sparkles className="w-3 h-3 text-[hsl(var(--primary))]" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeToolOutline(outline.id);
                    }}
                    className="p-1 hover:bg-[hsl(var(--destructive)/0.1)] rounded transition-colors shrink-0"
                    title="Remove"
                  >
                    <Trash2 className="w-3 h-3 text-[hsl(var(--destructive))]" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-4 border border-dashed border-[hsl(var(--border))] rounded-xl text-center">
              <Wrench className="w-5 h-5 mx-auto mb-1.5 text-[hsl(var(--muted-foreground))] opacity-50" />
              <p className="text-[12px] text-[hsl(var(--muted-foreground))]">
                No tools traced yet. Click on a tool in the image to begin.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Bottom Section - Clearance & CTA */}
      <div
        className={`pt-3 border-t border-[hsl(var(--border))] mt-3 space-y-3 px-4 pb-4 ${isDisabled ? "opacity-60 pointer-events-none" : ""}`}
      >
        {/* Clearance Control */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-[11px] font-semibold text-[hsl(var(--muted-foreground))] uppercase" style={{ letterSpacing: '0.08em' }}>
              Clearance
            </label>
            <span className="text-[13px] font-semibold font-tech">
              {clearanceValue.toFixed(1)}mm
            </span>
          </div>
          <input
            type="range"
            min="0"
            max="3"
            step="0.1"
            value={clearanceValue}
            onChange={(e) => setClearanceValue(parseFloat(e.target.value))}
            disabled={isDisabled}
            className="w-full h-1.5 bg-[hsl(var(--muted))] rounded-full appearance-none cursor-pointer"
          />
        </div>

        {/* CTA Button */}
        <button
          onClick={() => setCurrentStep("layout")}
          disabled={toolOutlines.length === 0}
          className="
            w-full h-9 px-3
            rounded-xl text-[13px] font-semibold
            transition-all duration-200 flex items-center justify-center gap-1.5
            disabled:opacity-50 disabled:cursor-not-allowed text-white
          "
          style={{ background: 'var(--gradient-primary)', boxShadow: 'var(--shadow-btn)' }}
        >
          Continue
          <ChevronRight className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
};

// ============================================================================
// Export Step Panel
// ============================================================================

const ExportStepPanel: React.FC = () => {
  const {
    toolOutlines,
    exportFormat,
    setExportFormat,
    setProcessing,
    pixelsPerMm,
    clearanceValue,
    layoutState,
    designSettings,
  } = useAppStore();

  // Check prerequisites
  const hasTools = toolOutlines.length > 0;
  const hasLayout = layoutState.shapes.length > 0;
  // const isDisabled = !hasTools || !hasLayout;
  const isDisabled = false;
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const flashMsg = useCallback((m: string) => { setExportMsg(m); setTimeout(() => setExportMsg(null), 6000); }, []);

  const handleExport = useCallback(async () => {
    if (!pixelsPerMm) {
      flashMsg("Calibrate the paper scale first so the export is to size.");
      return;
    }

    setProcessing(true, `Exporting ${exportFormat.toUpperCase()}...`);

    try {
      // Prepare outlines for export (apply clearance)
      const outlinesToExport = toolOutlines.map((outline) => {
        const basePoints = outline.regularizedPoints ?? outline.smoothedPoints;
        return {
          id: outline.id,
          name: outline.name,
          points:
            clearanceValue > 0
              ? offsetPolygon(
                basePoints,
                clearanceValue * pixelsPerMm,
              )
              : basePoints,
          color: outline.color,
        };
      });

      if (exportFormat === "svg") {
        downloadSVG(outlinesToExport, pixelsPerMm, "tooltrace-export.svg");
      } else {
        const { generateExportMesh, buildManifoldStlBlob } = await import("./ExportWorkspace");
        const THREE = await import("three");

        // Apply clearance via the mesh generator (offsetMm) for parity with the preview.
        const mesh = generateExportMesh(layoutState, toolOutlines, pixelsPerMm, designSettings, clearanceValue);
        const blob = await buildManifoldStlBlob(mesh);

        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'tooltrace-export.stl';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        // Clean up
        mesh.geometry.dispose();
        if (mesh.material instanceof THREE.Material) {
          mesh.material.dispose();
        }
      }
    } catch (error) {
      console.error("Export failed:", error);
      flashMsg("Couldn't export your design. Please try again.");
    } finally {
      setProcessing(false);
    }
  }, [exportFormat, setProcessing, toolOutlines, layoutState, designSettings, pixelsPerMm, clearanceValue, flashMsg]);

  return (
    <div className="h-full flex flex-col">
      {/* Prerequisite Warning Banner */}
      {isDisabled && (
        <div className="mb-3 p-3 mx-4 mt-4 bg-[hsl(var(--warning)/0.08)] border border-[hsl(var(--warning)/0.15)] rounded-xl flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-[hsl(var(--warning))] shrink-0 mt-0.5" />
          <div className="text-[12px] text-[hsl(var(--warning))] font-medium">
            {!hasTools && <p>• Trace tools in step 2</p>}
            {!hasLayout && <p>• Configure layout in step 3</p>}
          </div>
        </div>
      )}

      {/* Export message (replaces blocking alerts) */}
      {exportMsg && (
        <div className="mb-3 p-2.5 mx-4 mt-4 bg-[hsl(var(--destructive)/0.08)] border border-[hsl(var(--destructive)/0.2)] rounded-lg flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-[hsl(var(--destructive))] shrink-0" />
          <p className="text-[12px] text-[hsl(var(--destructive))] font-medium">{exportMsg}</p>
        </div>
      )}

      {/* Scrollable Content */}
      <div
        className={`flex-1 overflow-y-auto space-y-3 px-4 py-4 ${isDisabled ? "opacity-60 pointer-events-none" : ""}`}
      >
        {/* Format Selection */}
        <div className="space-y-1.5">
          <label className="text-[11px] font-semibold text-[hsl(var(--muted-foreground))] uppercase" style={{ letterSpacing: '0.08em' }}>
            Export Format
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setExportFormat("svg")}
              disabled={isDisabled}
              className={`
                h-9 px-3 rounded-xl font-semibold text-[13px] transition-all duration-200
                ${exportFormat === "svg"
                  ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                  : "bg-[hsl(var(--muted)/0.5)] text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))]"
                }
              `}
            >
              SVG
            </button>
            <button
              onClick={() => setExportFormat("stl")}
              disabled={isDisabled}
              className={`
                h-9 px-3 rounded-xl font-semibold text-[13px] transition-all duration-200
                ${exportFormat === "stl"
                  ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                  : "bg-[hsl(var(--muted)/0.5)] text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))]"
                }
              `}
            >
              STL
            </button>
          </div>
        </div>

        {/* Format Info */}
        <div className="p-3 bg-[hsl(var(--muted)/0.4)] rounded-xl">
          <p className="text-[12px] text-[hsl(var(--muted-foreground))] leading-relaxed">
            {exportFormat === "svg"
              ? "Export as scalable vector graphic for laser cutting or CNC."
              : "Export as 3D mesh for Gridfinity-style tool holder cutouts."}
          </p>
        </div>

        {/* Export Summary */}
        <div className="space-y-1.5">
          <label className="text-[11px] font-semibold text-[hsl(var(--muted-foreground))] uppercase" style={{ letterSpacing: '0.08em' }}>
            Summary
          </label>
          <div className="p-3 border border-[hsl(var(--border))] rounded-xl space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-[hsl(var(--muted-foreground))]">
                Tools
              </span>
              <span className="text-[13px] font-semibold">{toolOutlines.length}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-[hsl(var(--muted-foreground))]">
                Layout Shapes
              </span>
              <span className="text-[13px] font-semibold">
                {layoutState.shapes.length}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-[hsl(var(--muted-foreground))]">
                Format
              </span>
              <span className="text-[13px] font-semibold">
                {exportFormat.toUpperCase()}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* CTA Button - Fixed at bottom */}
      <div
        className={`pt-3 border-t border-[hsl(var(--border))] mt-3 px-4 pb-4 ${isDisabled ? "opacity-60 pointer-events-none" : ""}`}
      >
        <button
          onClick={handleExport}
          disabled={isDisabled || toolOutlines.length === 0}
          className="
            w-full h-9 px-3 text-white
            rounded-xl text-[13px] font-semibold
            transition-all duration-200 flex items-center justify-center gap-1.5
            disabled:opacity-50 disabled:cursor-not-allowed
          "
          style={{ background: 'var(--gradient-primary)', boxShadow: 'var(--shadow-btn)' }}
        >
          <Download className="w-3 h-3" />
          Export {exportFormat.toUpperCase()}
        </button>
      </div>
    </div>
  );
};

// ============================================================================
// Configure Layout Step Panel
// ============================================================================

const LayoutStepPanel: React.FC = () => {
  const {
    toolOutlines,
    setCurrentStep,
    layoutState,
    setLayoutTool,
    setLayoutGrid,
    clearAllLayoutShapes,
    initializeLayoutFromTools,
    removeLayoutShape,
    clearanceValue,
    setClearanceValue,
  } = useAppStore();

  const { grid, shapes, layoutTool } = layoutState;

  // const isDisabled = !toolOutlines.length;
  const isDisabled = false;

  // Initialize layout from tools when entering this step
  useEffect(() => {
    if (shapes.length === 0 && toolOutlines.length > 0) {
      initializeLayoutFromTools();
    }
  }, []);

  return (
    <div className="h-full flex flex-col">
      {/* Prerequisite Warning Banner */}
      {isDisabled && (
        <div className="mb-3 p-3 mx-4 mt-4 bg-[hsl(var(--warning)/0.08)] border border-[hsl(var(--warning)/0.15)] rounded-xl flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-[hsl(var(--warning))] shrink-0" />
          <p className="text-[12px] text-[hsl(var(--warning))] font-medium">
            Trace tools in step 2 first to configure layout
          </p>
        </div>
      )}

      {/* Scrollable Content */}
      <div
        className={`flex-1 overflow-y-auto space-y-4 px-4 py-4 ${isDisabled ? "opacity-60 pointer-events-none" : ""}`}
      >
        {/* Grid Settings */}
        <div className="space-y-2">
          <label className="text-[11px] font-semibold text-[hsl(var(--muted-foreground))] uppercase" style={{ letterSpacing: '0.08em' }}>
            Grid Size
          </label>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <span className="text-[11px] text-[hsl(var(--muted-foreground))] font-medium">
                Columns
              </span>
              <input
                type="number"
                min={1}
                max={10}
                value={grid.cols}
                onChange={(e) =>
                  setLayoutGrid({
                    cols: Math.max(
                      1,
                      Math.min(10, parseInt(e.target.value) || 1),
                    ),
                  })
                }
                className="w-full h-9 px-3 text-[13px] rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] focus:outline-none focus:border-[hsl(var(--primary))] transition-colors"
              />
            </div>
            <div className="space-y-1">
              <span className="text-[11px] text-[hsl(var(--muted-foreground))] font-medium">
                Rows
              </span>
              <input
                type="number"
                min={1}
                max={10}
                value={grid.rows}
                onChange={(e) =>
                  setLayoutGrid({
                    rows: Math.max(
                      1,
                      Math.min(10, parseInt(e.target.value) || 1),
                    ),
                  })
                }
                className="w-full h-9 px-3 text-[13px] rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] focus:outline-none focus:border-[hsl(var(--primary))] transition-colors"
              />
            </div>
          </div>
          <p className="text-[11px] text-[hsl(var(--muted-foreground))] font-medium">
            {grid.cols * grid.cellWidthMm} × {grid.rows * grid.cellHeightMm} mm
            total
          </p>
        </div>

        {/* Offset — uniform clearance dilated around each pocket (drop-in fit) */}
        <div className="space-y-2">
          <label className="text-[11px] font-semibold text-[hsl(var(--muted-foreground))] uppercase" style={{ letterSpacing: '0.08em' }}>
            Offset
          </label>
          <div className="grid grid-cols-4 gap-1.5">
            {[{ l: 'None', v: 0 }, { l: 'Small', v: 0.5 }, { l: 'Medium', v: 1 }, { l: 'Large', v: 2 }].map((o) => {
              const active = Math.abs(clearanceValue - o.v) < 0.01;
              return (
                <button
                  key={o.l}
                  onClick={() => setClearanceValue(o.v)}
                  className={`h-9 text-[12px] rounded-lg border transition-colors ${active
                    ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.1)] text-[hsl(var(--primary))]'
                    : 'border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:border-[hsl(var(--primary)/0.5)]'}`}
                >
                  {o.l}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-[hsl(var(--muted-foreground))] font-medium">
            {clearanceValue.toFixed(1)} mm clearance around each tool pocket
          </p>
        </div>

        {/* Add Simple Shapes Section */}
        <div className="space-y-2">
          <label className="text-[11px] font-semibold text-[hsl(var(--muted-foreground))] uppercase" style={{ letterSpacing: '0.08em' }}>
            Add Simple Shapes
          </label>
          <div className="grid grid-cols-2 gap-1.5">
            {/* Finger Notch */}
            <button
              onClick={() =>
                setLayoutTool(
                  layoutTool === "finger-notch" ? "select" : "finger-notch",
                )
              }
              className={`
                flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl transition-all duration-200
                ${layoutTool === "finger-notch"
                  ? "bg-[hsl(var(--primary)/0.1)] border border-[hsl(var(--primary)/0.3)]"
                  : "hover:bg-[hsl(var(--muted)/0.5)] border border-[hsl(var(--border))]"
                }
              `}
            >
              <Hand
                className={`w-4 h-4 ${layoutTool === "finger-notch" ? "text-[hsl(var(--primary))]" : "text-[hsl(var(--muted-foreground))]"}`}
              />
              <span className="text-[11px] font-medium">Finger Notch</span>
            </button>

            {/* Circle */}
            <button
              onClick={() =>
                setLayoutTool(layoutTool === "circle" ? "select" : "circle")
              }
              className={`
                flex flex-col items-center justify-center gap-1 p-2.5 rounded-md transition-colors
                ${layoutTool === "circle"
                  ? "bg-[hsl(var(--primary)/0.1)] border border-[hsl(var(--primary)/0.3)]"
                  : "hover:bg-[hsl(var(--muted)/0.5)] border border-[hsl(var(--border))]"
                }
              `}
            >
              <Circle
                className={`w-4 h-4 ${layoutTool === "circle" ? "text-[hsl(var(--primary))]" : "text-[hsl(var(--muted-foreground))]"}`}
              />
              <span className="text-[11px] font-medium">Circle</span>
            </button>

            {/* Square */}
            <button
              onClick={() =>
                setLayoutTool(layoutTool === "square" ? "select" : "square")
              }
              className={`
                flex flex-col items-center justify-center gap-1 p-2.5 rounded-md transition-colors
                ${layoutTool === "square"
                  ? "bg-[hsl(var(--primary)/0.1)] border border-[hsl(var(--primary)/0.3)]"
                  : "hover:bg-[hsl(var(--muted)/0.5)] border border-[hsl(var(--border))]"
                }
              `}
            >
              <Square
                className={`w-4 h-4 ${layoutTool === "square" ? "text-[hsl(var(--primary))]" : "text-[hsl(var(--muted-foreground))]"}`}
              />
              <span className="text-[11px] font-medium">Square</span>
            </button>

            {/* Rectangle */}
            <button
              onClick={() =>
                setLayoutTool(
                  layoutTool === "rectangle" ? "select" : "rectangle",
                )
              }
              className={`
                flex flex-col items-center justify-center gap-1 p-2.5 rounded-md transition-colors
                ${layoutTool === "rectangle"
                  ? "bg-[hsl(var(--primary)/0.1)] border border-[hsl(var(--primary)/0.3)]"
                  : "hover:bg-[hsl(var(--muted)/0.5)] border border-[hsl(var(--border))]"
                }
              `}
            >
              <RectangleHorizontal
                className={`w-4 h-4 ${layoutTool === "rectangle" ? "text-[hsl(var(--primary))]" : "text-[hsl(var(--muted-foreground))]"}`}
              />
              <span className="text-[11px] font-medium">Rectangle</span>
            </button>
          </div>
        </div>

        {/* Layout Elements List */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-[11px] font-semibold text-[hsl(var(--muted-foreground))] uppercase" style={{ letterSpacing: '0.08em' }}>
              Layout Elements ({shapes.length})
            </label>
            {shapes.length > 0 && (
              <button
                onClick={() => {
                  clearAllLayoutShapes();
                }}
                className="p-1 hover:bg-[hsl(var(--destructive)/0.1)] rounded transition-colors"
                title="Clear all shapes"
              >
                <Trash2 className="w-3 h-3 text-[hsl(var(--destructive))]" />
              </button>
            )}
          </div>
          {shapes.length > 0 ? (
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {shapes.map((shape, index) => {
                const isTracedTool =
                  shape.type === "tool" || !!shape.toolOutlineId;
                const shapeIcon =
                  shape.type === "circle"
                    ? Circle
                    : shape.type === "square"
                      ? Square
                      : shape.type === "rectangle"
                        ? RectangleHorizontal
                        : shape.type === "finger-notch"
                          ? Hand
                          : Wrench; // Default for traced tools

                return (
                  <div
                    key={shape.id || index}
                    className="flex items-center gap-2 p-2.5 rounded-xl border border-[hsl(var(--border))] hover:bg-[hsl(var(--muted)/0.3)] transition-all duration-200"
                  >
                    <div className="w-4 h-4 flex items-center justify-center shrink-0">
                      {React.createElement(shapeIcon, {
                        className:
                          "w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]",
                      })}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-[hsl(var(--foreground))] truncate">
                        {`${shape.type || "Shape"} ${index + 1}`}
                      </div>
                      <div className="text-[11px] text-[hsl(var(--muted-foreground))]">
                        {isTracedTool ? "Traced tool" : "Added shape"}
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        if (shape.id && !isTracedTool) {
                          removeLayoutShape(shape.id);
                        }
                      }}
                      disabled={isTracedTool}
                      className="p-1 hover:bg-[hsl(var(--destructive)/0.1)] rounded transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                      title={
                        isTracedTool
                          ? "Cannot delete traced tools"
                          : "Remove shape"
                      }
                    >
                      <Trash2 className="w-3 h-3 text-[hsl(var(--destructive))]" />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="p-4 border border-dashed border-[hsl(var(--border))] rounded-xl text-center">
              <Shapes className="w-5 h-5 mx-auto mb-1.5 text-[hsl(var(--muted-foreground))] opacity-50" />
              <p className="text-[12px] text-[hsl(var(--muted-foreground))]">
                No layout elements yet. Add shapes or initialize from traced
                tools.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Layout Summary & CTA Button - Fixed at bottom */}
      <div className="pt-3 border-t border-[hsl(var(--border))] mt-3 space-y-3 px-4 pb-4">
        {/* Layout Summary */}
        <div className="p-3 bg-[hsl(var(--muted)/0.3)] rounded-xl">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <span className="text-[13px] font-semibold">{shapes.length}</span>
              <p className="text-[10px] text-[hsl(var(--muted-foreground))] font-medium">
                Shapes
              </p>
            </div>
            <div>
              <span className="text-[13px] font-semibold font-tech">
                {grid.cols}×{grid.rows}
              </span>
              <p className="text-[10px] text-[hsl(var(--muted-foreground))] font-medium">
                Grid
              </p>
            </div>
            <div>
              <span className="text-[13px] font-semibold font-tech">
                {grid.cols * grid.cellWidthMm}mm
              </span>
              <p className="text-[10px] text-[hsl(var(--muted-foreground))] font-medium">
                Width
              </p>
            </div>
          </div>
        </div>

        <button
          onClick={() => setCurrentStep("design")}
          disabled={shapes.length === 0}
          className="
            w-full h-9 px-3
            rounded-xl text-[13px] font-semibold
            transition-all duration-200 flex items-center justify-center gap-1.5
            disabled:opacity-50 disabled:cursor-not-allowed text-white
          "
          style={{ background: 'var(--gradient-primary)', boxShadow: 'var(--shadow-btn)' }}
        >
          Continue
          <ChevronRight className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
};

// ============================================================================
// 3D Design Step Panel (Placeholder)
// ============================================================================

const DesignStepPanel: React.FC = () => {
  const {
    layoutState,
    setCurrentStep,
    designSettings,
    updateDesignSettings,
    resetDesignSettings,
    toolOutlines,
  } = useAppStore();

  const { shapes } = layoutState;

  // Check prerequisites
  const hasTools = toolOutlines.length > 0;
  const hasLayout = shapes.length > 0;
  // const isDisabled = !hasTools || !hasLayout;
  const isDisabled = false;

  return (
    <div className="h-full flex flex-col">
      {/* Prerequisite Warning Banner */}
      {isDisabled && (
        <div className="mb-3 p-3 mx-4 mt-4 bg-[hsl(var(--warning)/0.08)] border border-[hsl(var(--warning)/0.15)] rounded-xl flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-[hsl(var(--warning))] shrink-0 mt-0.5" />
          <div className="text-[12px] text-[hsl(var(--warning))] font-medium">
            {!hasTools && <p>• Trace tools in step 2</p>}
            {!hasLayout && <p>• Configure layout in step 3</p>}
          </div>
        </div>
      )}

      {/* Scrollable Content */}
      <div
        className={`flex-1 overflow-y-auto space-y-4 px-4 py-4 ${isDisabled ? "opacity-60 pointer-events-none" : ""}`}
      >
        {/* Info */}
        <div className="p-3 bg-[hsl(var(--muted)/0.4)] rounded-xl">
          <div className="flex items-center justify-between">
            <p className="text-[12px] text-[hsl(var(--muted-foreground))] leading-relaxed">
              Customize your 3D tool holder design parameters
            </p>
            <button
              onClick={resetDesignSettings}
              className="
                px-2.5 py-1.5 text-[11px] font-semibold text-[hsl(var(--muted-foreground))]
                hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted)/0.5)]
                rounded-lg transition-all duration-200 flex items-center gap-1
              "
              title="Reset to default values"
            >
              <RefreshCw className="w-3 h-3" />
              Reset
            </button>
          </div>
        </div>

        {/* Depth Settings */}
        <div className="space-y-2">
          <label className="text-[11px] font-semibold text-[hsl(var(--muted-foreground))] uppercase" style={{ letterSpacing: '0.08em' }}>
            Cutout Depth
          </label>
          <div className="space-y-1.5">
            <input
              type="range"
              min={5}
              max={50}
              step={1}
              value={designSettings.cutoutDepth}
              onChange={(e) =>
                updateDesignSettings({
                  cutoutDepth: parseFloat(e.target.value),
                })
              }
              className="w-full h-1.5 bg-[hsl(var(--muted))] rounded-lg appearance-none cursor-pointer accent-[hsl(var(--primary))]"
            />
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-[hsl(var(--muted-foreground))] font-medium">
                5mm
              </span>
              <span className="text-[13px] font-semibold font-tech">
                {designSettings.cutoutDepth}mm
              </span>
              <span className="text-[11px] text-[hsl(var(--muted-foreground))] font-medium">
                50mm
              </span>
            </div>
          </div>
        </div>

        {/* Base Height */}
        <div className="space-y-2">
          <label className="text-[10px] font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wide">
            Base Height
          </label>
          <div className="space-y-1.5">
            <input
              type="range"
              min={2}
              max={15}
              step={0.5}
              value={designSettings.baseHeight}
              onChange={(e) =>
                updateDesignSettings({ baseHeight: parseFloat(e.target.value) })
              }
              className="w-full h-1.5 bg-[hsl(var(--muted))] rounded-lg appearance-none cursor-pointer accent-[hsl(var(--primary))]"
            />
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
                2mm
              </span>
              <span className="text-xs font-medium font-tech">
                {designSettings.baseHeight}mm
              </span>
              <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
                15mm
              </span>
            </div>
          </div>
        </div>

        {/* Chamfer Size */}
        <div className="space-y-2">
          <label className="text-[10px] font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wide">
            Edge Chamfer
          </label>
          <div className="space-y-1.5">
            <input
              type="range"
              min={0}
              max={20}
              step={0.5}
              value={designSettings.chamferSize}
              onChange={(e) =>
                updateDesignSettings({
                  chamferSize: parseFloat(e.target.value),
                })
              }
              className="w-full h-1.5 bg-[hsl(var(--muted))] rounded-lg appearance-none cursor-pointer accent-[hsl(var(--primary))]"
            />
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
                0mm
              </span>
              <span className="text-xs font-medium font-tech">
                {designSettings.chamferSize}mm
              </span>
              <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
                20mm
              </span>
            </div>
          </div>
        </div>

        {/* Material Preset */}
        <div className="space-y-2">
          <label className="text-[10px] font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wide">
            Tray Material / Color
          </label>
          <select
            value={designSettings.materialPreset || 'eva-foam'}
            onChange={(e) =>
              updateDesignSettings({
                materialPreset: e.target.value as any,
              })
            }
            className="
              w-full h-9 px-3 rounded-xl border border-[hsl(var(--border))]
              bg-[hsl(var(--background))] text-foreground text-[13px]
              focus:outline-none focus:border-[hsl(var(--primary))] transition-colors
              cursor-pointer font-medium
            "
          >
            <option value="eva-foam">EVA Foam (Dual-Tone Orange)</option>
            <option value="charcoal">Stealth Charcoal (Matte)</option>
            <option value="sky-blue">Tough PLA (Sky Blue)</option>
            <option value="orange">Signature Orange (Vivid)</option>
          </select>
        </div>

        {/* Gridfinity Base Toggle */}
        <div className="flex items-center justify-between p-3 border border-[hsl(var(--border))] rounded-xl">
          <div>
            <span className="text-[13px] font-semibold">Gridfinity Base</span>
            <p className="text-[11px] text-[hsl(var(--muted-foreground))] font-medium">
              Add 42mm grid pattern
            </p>
          </div>
          <button
            onClick={() =>
              updateDesignSettings({
                gridfinityBase: !designSettings.gridfinityBase,
              })
            }
            className={`
              w-10 h-5 rounded-full transition-colors relative
              ${designSettings.gridfinityBase
                ? "bg-[hsl(var(--primary))]"
                : "bg-[hsl(var(--muted))]"
              }
            `}
          >
            <span
              className={`
                absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform
                ${designSettings.gridfinityBase ? "left-5" : "left-0.5"}
              `}
            />
          </button>
        </div>
      </div>

      {/* Summary & CTA Button - Fixed at bottom */}
      <div className="pt-3 border-t border-[hsl(var(--border))] mt-3 space-y-3 px-4 pb-4">
        {/* Design Summary */}
        <div className="p-3 bg-[hsl(var(--muted)/0.3)] rounded-xl">
          <div className="grid grid-cols-2 gap-2 text-center">
            <div>
              <span className="text-[13px] font-semibold">{shapes.length}</span>
              <p className="text-[10px] text-[hsl(var(--muted-foreground))] font-medium">
                Cutouts
              </p>
            </div>
            <div>
              <span className="text-[13px] font-semibold font-tech">
                {designSettings.cutoutDepth}mm
              </span>
              <p className="text-[10px] text-[hsl(var(--muted-foreground))] font-medium">
                Depth
              </p>
            </div>
          </div>
        </div>

        <button
          onClick={() => setCurrentStep("export")}
          disabled={shapes.length === 0}
          className="
            w-full h-9 px-3
            rounded-xl text-[13px] font-semibold
            transition-all duration-200 flex items-center justify-center gap-1.5
            disabled:opacity-50 disabled:cursor-not-allowed text-white
          "
          style={{ background: 'var(--gradient-primary)', boxShadow: 'var(--shadow-btn)' }}
        >
          Continue
          <ChevronRight className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
};

// ============================================================================
// Main Control Panel
// ============================================================================

export const ControlPanel: React.FC = () => {
  const { currentStep } = useAppStore();

  return (
    <div className="h-full flex flex-col">
      {/* Step Content */}
      <div className="flex-1 overflow-hidden">
        {currentStep === "paper" && <PaperStepPanel />}
        {currentStep === "tools" && <ToolsStepPanel />}
        {currentStep === "layout" && <LayoutStepPanel />}
        {currentStep === "design" && <DesignStepPanel />}
        {currentStep === "export" && <ExportStepPanel />}
      </div>
    </div>
  );
};
