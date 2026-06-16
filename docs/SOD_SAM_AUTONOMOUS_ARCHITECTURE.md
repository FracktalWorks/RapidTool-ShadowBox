# Autonomous + Precise Tool Detection — Architecture

> **Thesis (current).** Tool detection that is *both* autonomous (no clicking) *and*
> precise (pixel-accurate, chrome included) is achievable in a browser-only app with
> **no dataset, no training, no servers, and no API** — through a **three-layer
> design**:
>
> 1. **SOD-primary autonomous detection** — a trained **Salient Object Detection**
>    model (IS-Net / DIS) outputs a clean binary foreground mask of *all* tools in
>    one pass. This is the workhorse.
> 2. **Classical fallback** — when SOD is unconfident (bare-metal / low-contrast
>    tools that read as paper to a saliency model), fall back to the classical
>    brightness/edge detector.
> 3. **SAM-assisted interactive refine** — SAM is the *human-in-the-loop* tool for
>    patching the rare miss (click / box-select a region → **union** it into the
>    tool), **not** the autonomous detector.
>
> **History note.** An earlier version of this document proposed *SAM Automatic Mask
> Generation (AMG) on SlimSAM* as the autonomous detector. We built and tested it; it
> was slow, fragmented multi-contrast tools, and over-merged neighbours. We pivoted:
> **SAM is a promptable *segmenter*, not a *detector*** — its objectness is generic,
> not tool-specific, and AMG needs a grid of prompts + heavy NMS. A purpose-built SOD
> model detects *foreground tools* directly and far more cleanly. SAM remains, but as
> the refine layer. This doc describes the design we actually ship.

---

## 1. The Constraint Set (the hard boundaries)

Every design decision is forced by these. Non-negotiable givens of the product.

| # | Constraint | Source |
|---|------------|--------|
| C1 | **No labeled dataset** | We have none and can't hand-label thousands |
| C2 | **No training compute budget** | Can't pay for GPU training |
| C3 | **No inference compute cost** | No server GPU — must be free at runtime |
| C4 | **No third-party API** | Nothing leaves the device; no keys |
| C5 | **Small / lazy delivery** | ~30 MB+ *eager* download is unacceptable |
| C6 | **Autonomous** | Upload → all tools detected, no per-tool clicks |
| C7 | **Pixel precision, incl. chrome-on-white** | Classical alone proven insufficient (measured) |
| C8 | **Browser-only SaaS** | No backend for compute; runs in the visitor's browser |
| C9 | **Usable latency on commodity hardware** | Must run in seconds on a laptop GPU/CPU |

Section 5 shows every alternative violates at least one; the chosen design violates none.

---

## 2. Working Structure (the pipeline)

```
            ┌────────────────────────────────────────────────────────────┐
  photo ──► │  STAGE 0 · CALIBRATE   (OpenCV)                            │
            │  Paper detection → pixels-per-mm + paper quad              │
            └────────────────────────────────────────────────────────────┘
                                   │  crop to paper interior
            ┌────────────────────────────────────────────────────────────┐
            │  STAGE 1 · DETECT (autonomous, primary)                    │
            │  SOD: IS-Net (DIS) → single binary foreground mask of ALL  │
            │  tools. Min-max normalise → threshold. Solves chrome,      │
            │  shadow, and tool-vs-tool separation at the MASK level.    │
            └────────────────────────────────────────────────────────────┘
                                   │  weak result? (low best-confidence)
            ┌────────────────────────────────────────────────────────────┐
            │  STAGE 1b · CLASSICAL FALLBACK                             │
            │  buildToolMask (Lab/brightness + edges). Keys on CONTRAST  │
            │  not saliency → catches bare-metal tools SOD reads as paper.│
            └────────────────────────────────────────────────────────────┘
                                   │  foreground mask
            ┌────────────────────────────────────────────────────────────┐
            │  STAGE 2 · TRACE + GATE   (OpenCV, shared)                 │
            │  tracePreparedMask: hole-fill → findContours → per-blob     │
            │  gates (minArea, solidity, aspect, min-thickness) → one     │
            │  result per tool with a geometric confidence.              │
            └────────────────────────────────────────────────────────────┘
                                   │  per-tool outlines
            ┌────────────────────────────────────────────────────────────┐
            │  STAGE 3 · REFINE   (SAM, interactive, optional)          │
            │  Click / box-select a missed part → SAM/GrabCut segments   │
            │  it → UNION into the nearest tool (never replace). Fixes    │
            │  chrome jaws / thin metal SOD can't see.                   │
            └────────────────────────────────────────────────────────────┘
                                   │  clean editable outlines
            ┌────────────────────────────────────────────────────────────┐
            │  STAGE 4 · GEOMETRY   (existing)                          │
            │  smooth (RDP+Chaikin) → Clipper OFFSET (clearance) →       │
            │  rotation → layout → 3D pockets + Gridfinity → STL/SVG     │
            └────────────────────────────────────────────────────────────┘
```

### Component responsibilities

| Stage | Component | Status | Responsibility |
|-------|-----------|--------|----------------|
| 0 | `cvWorker.detectPaper` | ✅ | Paper quad + scale |
| 1 | `sodWorker` (IS-Net via onnxruntime-web) | ✅ | One foreground mask of all tools |
| 1b | `cvWorker.buildToolMask` (classical) | ✅ | Fallback when SOD confidence < 0.5 |
| 2 | `cvWorker.tracePreparedMask` | ✅ | Mask → per-tool outlines + gates (shared by both paths) |
| 3 | `samWorker` (SlimSAM) + GrabCut + `unionPolygons` | ✅ | Interactive add/fix → union into nearest tool |
| 4 | `geometry` (offset/smooth) + `gridfinity*` + export | ✅ | Outlines → CAD pockets, feet, lip, STL/SVG |

---

## 3. Why SOD beats SAM-AMG for the autonomous layer

A screwdriver is one object with many appearances — yellow handle, black grip, a
**bright steel shaft** (reads as paper), darker shadowed steel, black edge faces.

| Approach | Result | Why |
|----------|--------|-----|
| Classical alone | **Fragments** — handle one blob, bright shaft *missed*, edges another | Segments colour/brightness regions, not objects |
| SAM-AMG (rejected) | Whole tool *sometimes*, but slow + fragments thin/chrome parts, over-merges neighbours; needs a prompt grid + heavy containment/IoU NMS | SAM is a *promptable segmenter* — generic objectness, no tool prior; AMG is a workaround |
| **SOD / IS-Net (chosen)** | **One clean mask of all the tools at once** | A model *trained to output the salient foreground* — exactly "the tools on the sheet". Separates touching tools and includes most chrome at the mask level, in a single forward pass |

**Key reframing:** SAM answers *"segment the thing at this prompt."* SOD answers
*"where is the foreground?"* — which **is** our question. So SOD is the detector and
SAM is demoted to refine.

### The honest residual
SOD scores *saliency*. A bare-metal, low-contrast tool under dim light (e.g. a steel
screw on grey-white paper) has almost no saliency → SOD returns noise. Two mitigations,
in order: **(1)** auto classical fallback (Stage 1b) keys on contrast; **(2)** the user
**Box-Selects** the tool (GrabCut inside the box → unioned in) — the reliable manual
path for metallic parts. Autonomy gets the common case; the refine layer guarantees
zero-loss on the exception.

---

## 4. Models + runtime (the C5/C9 reality)

| Model | Role | Format | Size | License |
|-------|------|--------|------|---------|
| **IS-Net (DIS)** | SOD autonomous detect | ONNX q8 (int8) | ~44 MB | Apache-2.0 |
| **SlimSAM** | interactive refine | transformers.js | lazy, cached | MIT |

**Execution-provider lesson (measured, the hard part of C9):**
- **q8 on WebGPU is a trap** — its quantize/dequantize ops fall back to CPU every
  layer (constant CPU↔GPU copies) → **1.5–2 min** per inference.
- **fp16 on WebGPU is fast but not portable** — needs the optional `shader-f16` GPU
  feature, which **many GPUs/drivers don't expose**; the fp16 shaders fail to compile.
- **Shipped: q8 on multi-threaded WASM** (SIMD + `navigator.hardwareConcurrency`
  threads) → **~10–15 s**, runs everywhere. Requires cross-origin isolation
  (COOP `same-origin` + COEP `credentialless`) to unlock `SharedArrayBuffer`; if
  absent, ORT silently drops to 1 thread (~60 s) — still works.
- IS-Net's ONNX exports 12 outputs (11 unused deep-supervision "side" heads); the
  pipeline reads only the main `output_image`. (Stripping the side heads also makes
  fp16 conversion valid, for GPUs that *do* support `shader-f16`.)

---

## 5. Why ONLY this family of designs fits — the elimination proof

| Approach | C1 data | C2 train | C3 infer$ | C4 API | C5 size | C6 auto | C7 chrome | C9 latency | Verdict |
|----------|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---------|
| Pure classical | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ❌ | ✅ | Dies on C7 (misses chrome) — but a great *fallback* |
| Train YOLO-seg now | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Dies on C1+C2 |
| Cloud SAM / detection API | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | Dies on C3+C4 |
| Self-hosted GPU inference | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | Dies on C3+C8 |
| Open-vocab detector + SAM | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ⚠️ | Dies on C5 (100s of MB) |
| Full SAM (ViT-H) AMG | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | Dies on C5+C9 |
| SAM-AMG on SlimSAM (old thesis) | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ❌ | Dies on C9 (slow) + weak autonomy/chrome |
| **SOD primary + classical fallback + SAM refine** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **Survives all** |

- Anything **trained-from-scratch** → exits on **C1/C2**.
- Anything **cloud/server** → exits on **C3/C4/C8**.
- Anything **big-model** → exits on **C5** (and usually **C9**).
- **SAM-AMG** technically fits the budget axes but loses on **C9** (latency) and is
  weak on autonomy/chrome — which is why we pivoted to SOD.

The surviving design uses a **pre-trained, off-the-shelf, permissively-licensed**
model (no C1/C2), runs it **on-device for free** (no C3/C4/C8), is **~44 MB lazy**
(C5), is **fully autonomous** (C6), includes **chrome at the mask level** with a
classical+SAM safety net (C7), and runs in **~10–15 s on a laptop** (C9).

---

## 6. Refine layer details (Stage 3)

- **Routing:** a click/box that lands inside *or near* an existing tool (within a
  size-scaled reach) **unions into the nearest tool** — no pre-selection needed; a
  far click on blank paper makes a new tool. This stops "add the caliper jaw" from
  spawning a duplicate.
- **Union, never replace:** `unionPolygons` (Clipper boolean OR) appends the new
  region to the existing outline so the body is never lost.
- **SAM vs GrabCut:** SAM (click) is fast for solid parts; **Box-Select (GrabCut)** is
  the reliable grab for thin/reflective chrome where SAM returns fragments.

---

## 7. False-positive control

Shadow/pencil-mark blobs are rejected by the shared Stage-2 gates: `minArea`
(≥10 000 px, scales with image — measured: real tools ≥30 k, noise ≤7.5 k),
`solidity ≥ 0.15`, `aspect ≤ 14`, and a minimum min-area-rect thickness. The SOD
threshold stays at 0.5 (lowering it to recover faint chrome backfired — it surfaced
pencil marks instead; chrome is handled by the refine layer instead).
