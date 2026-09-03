# RapidTool Nest — Product Requirements Document
### A sheet-nesting workflow app for the RapidTool suite, built to nest2d's problem, RapidTool's design system

**Status:** Draft for founder review
**Date:** 2026-09-03
**Formatted version:** https://claude.ai/code/artifact/4bc5b273-c75e-4354-b60f-9a39890d1935
**Related:** [nest2d](https://github.com/VovaStelmashchuk/nest2d) (reference implementation), RapidTool-Fixture, RapidTool-SoftJaws, RapidTool-ShadowBox (sibling products / shared design system)

> This planning doc is cross-posted identically to all three RapidTool product repos (Fixture, SoftJaws, ShadowBox) since the proposed product — codename **RapidTool Nest** — doesn't have its own repo yet and reuses design-system code from all three. It should move to that new repo's `docs/` once created, and be deleted here.

---

## 1. Executive summary

Build a new RapidTool product — working name **RapidTool Nest** — that solves the same problem as [nest2d](https://nest2d.stelmashchuk.dev/): given a set of flat parts (DXF/SVG) and a sheet of material, automatically arrange ("nest") the parts on the sheet(s) to minimize waste, so a shop can cut them on a laser, plasma, router, or plotter.

This is **not** a fork of nest2d's Nuxt/Vue/MongoDB codebase. It is a ground-up React/TypeScript app that follows the exact three-layer architecture, workflow-step UX pattern, and design system already proven across RapidTool-Fixture, RapidTool-SoftJaws, and RapidTool-ShadowBox — so it looks, feels, and is built like the rest of the suite, and can share `cad-ui` / `cad-core` code with them.

nest2d is the closest working reference for scope and pitfalls (it has shipped, has paying users, and its git history documents real mistakes worth avoiding — a Java→Rust→Nuxt migration, a strip-nesting mode added after the fact, a credit-based billing system). Treat it as a **spec by example**, not a template to copy structurally.

---

## 2. Problem statement

Sheet-based CNC cutting (laser, plasma, router, waterjet, vinyl/plotter) always starts with the same question: *how do I lay these parts out on my sheet so I waste the least material and make the fewest cuts?* Doing this by hand in CAD is slow and gets worse as part count grows. Dedicated nesting software exists (SigmaNEST, ProNest, Deepnest, SVGnest, nest2d) but:

- **Industrial tools** (SigmaNEST, ProNest) are expensive, desktop-only, and overkill for small shops and makers.
- **Free tools** (Deepnest, SVGnest) are unmaintained-feeling, have rough UX, and run entirely client-side with no project persistence.
- **nest2d** is the most modern free/open option, but it is a single-purpose SaaS with its own account system, billing, and UI — it doesn't fit inside a shop's existing RapidTool workflow (design a fixture, design soft jaws, design a tool organizer, now separately go nest sheet parts on a different site with a different login).

RapidTool's opportunity: users who already fixture, soft-jaw, or organize their tools in RapidTool are exactly the users who also cut sheet parts. Owning nesting inside the same suite — same login, same design language, same "workflow steps" mental model — removes a tool-switching tax and is a natural cross-sell.

---

## 3. Goals

1. **Functional parity with nest2d's core loop**: import DXF/SVG parts → set quantities → configure sheet material & size → auto-nest → review result (placed vs. unplaced parts) → export cut-ready files.
2. **Same design system as the rest of RapidTool**: `DashboardLayout`, workflow steps + gates, `cad-ui` primitives, dark/light theme, RapidTool branding — indistinguishable in polish from Fixture/SoftJaws/ShadowBox.
3. **Shared, not duplicated, infrastructure**: reuse `packages/cad-core` (STL/geometry helpers), `packages/cad-ui` (generic components + stores), and `packages/storage` (autosave/session pattern from Fixture/ShadowBox) wherever the "would another RapidTool product use this unchanged?" test passes.
4. **Ship an MVP that a real shop can use**: single-sheet nesting of DXF parts with rotation, spacing, and quantity controls, producing a downloadable cut-ready DXF/SVG.

### Non-goals (v1)

- Multi-tenant billing/credits system (defer — RapidTool's existing account/entitlement model, if any, should be reused rather than nest2d's Stripe+credits scheme being copied verbatim; flagged as an open question in §12).
- G-code generation / CAM (nest2d doesn't do this either — output is cut-ready vector files, not toolpaths).
- Server-side multi-user real-time collaboration.
- True optimality guarantees — like nest2d, this is a heuristic nesting problem (NP-hard); "good enough, fast enough" is the bar, not provably optimal packing.

---

## 4. Reference: what nest2d actually does

(From reading the [nest2d source](https://github.com/VovaStelmashchuk/nest2d) directly — its README undersells the current feature set.)

| Area | What nest2d does today |
|---|---|
| **Input** | DXF upload only (SVG mentioned as a legacy/preview-only format in the README, not really user-facing anymore). Up to 20 files, 5MB each. Each DXF may contain one or more closed-loop parts; the app extracts them individually and lets the user set a **quantity** per part. |
| **Two nesting modes** | **Project (2D bin nesting)**: fixed width × height plate, spacing, sheet count (multi-sheet), "add out shape" option. **Strip nesting**: fixed height only, unbounded length — for stock material sold as a continuous strip/coil, common in sheet metal. |
| **Engine** | Python worker wrapping [`jagua-rs`](https://github.com/JeroenGar/jagua-rs) (Rust, irregular 2D cutting/packing via collision-detection + local search). Jobs are queued in MongoDB (`nesting_jobs` collection, status: `pending → processing → done/error`), picked up by a polling worker process. Async — user waits (with an optional email notification on completion) rather than the browser computing the layout. |
| **Result** | DXF viewer (via `dxf-viewer` + Three.js) showing the nested layout; single-sheet → direct DXF download; multi-sheet → per-sheet DXF + "download all" ZIP. Shows requested-vs-placed part counts and a clear "no solution found — increase plate size or reduce part count" failure state. |
| **Persistence** | Named "projects", listed per user, re-nest-able after changing files/settings ("Change settings or files to generate again" gate — mirrors RapidTool's own step-invalidation pattern). |
| **Auth & billing** | Google/GitHub OAuth. 3 free nests, then $7.99/mo subscription with 7-day trial, 30-day refund policy, credit-based accounting server-side (`balance -= 10` per completed nest). |
| **UX texture worth stealing** | The disabled-button-with-reason pattern ("Change settings or files to generate again"), the plate-too-small inline error with the exact required dimensions, the requested/placed part count readout, per-sheet pagination in the result modal. |

---

## 5. Personas & use cases

| Persona | Use case |
|---|---|
| **Sheet-metal / laser-cutting job shop owner** | Has 40 unique bracket DXFs from a customer order, quantities vary per part. Needs to know how many 4×8 ft sheets to buy and get cut-ready files for the laser. |
| **Maker / hobbyist with a plasma or router** | Designed a batch of parts in Fusion360/OnShape, exported DXFs, wants to lay them out on the one sheet of plywood/aluminum they have without doing math by hand. |
| **Existing RapidTool-Fixture / SoftJaws user** | Already exports flat baseplate or bracket profiles from a fixture design; wants to nest several fixture parts onto stock sheet without leaving the suite or creating a second account. |
| **Shop estimator** | Wants a quick "will this order fit on N sheets of this size" answer before quoting a job — doesn't need to finalize the layout, just the sheet count. |
| **Strip/coil stock user** (sheet metal specifically) | Buys material as a continuous strip of fixed width (or height, per nest2d's convention) rather than fixed sheets; needs 1D strip-packing, not 2D bin-packing. |

---

## 6. Feature scope (v1 / MVP)

Mapped to nest2d parity, minus what's genuinely out of scope for a v1:

**In scope:**
- DXF import, multi-file, multi-part-per-file extraction, per-part quantity.
- Single sheet-size nesting mode (the "Project" mode — this is the 80% use case; strip mode deferred to v1.1, see §11 phasing).
- Sheet width/height, part spacing (kerf/gap), sheet count (multi-sheet overflow) as adjustable parameters.
- Rotation allowance per part (nest2d doesn't clearly expose this in the UI reviewed — worth exceeding parity here; 0°/90°/free-rotation as a setting).
- Run nest → progress/loading state → result view with placed/unplaced counts and the "plate too small" pre-flight check nest2d already does well.
- Export: single-sheet DXF, multi-sheet ZIP of DXFs. SVG export as a stretch (useful for laser software that prefers SVG).
- Project-style persistence consistent with whatever session/storage pattern RapidTool already uses (see `packages/storage` in Fixture/ShadowBox — `useFileSession`, `FileAutoSave`).

**Explicitly deferred (v1.1+):**
- Strip/coil nesting mode.
- SVG import (nest2d itself is DXF-first now).
- Any billing/credits UI.
- Email notification for long-running jobs.

---

## 7. UX flow — expressed as RapidTool workflow steps

RapidTool's established pattern (SoftJaws' 7 steps, Fixture's 6, ShadowBox's `Photo → Detect Paper → Trace Tools → Layout → 3D Design → Export`) is a **linear, gated workflow** rendered via `DashboardLayout` + `useWorkflowStore`, with a right-side `ContextOptionsPanel` per step. RapidTool Nest should be no exception:

| # | Step | Role | Gate to advance |
|---|---|---|---|
| 1 | **Import Parts** | Upload DXF file(s); parse and extract closed-loop parts; per-part thumbnail + dimensions (mirrors SoftJaws' `import/` step and nest2d's `FileParts.vue`/`ProjectFiles.vue`). | ≥1 part imported |
| 2 | **Part Quantities & Rotation** | Set quantity per part; per-part or global rotation-allowance setting. | ≥1 part with quantity > 0 |
| 3 | **Sheet Setup** | Sheet width/height, spacing/kerf, sheet count, material preset (optional — nice-to-have catalog of common sheet sizes/materials). | Sheet dimensions valid and ≥ largest part's bounding box (nest2d's exact pre-flight check) |
| 4 | **Nest** | Run the algorithm (worker-driven, see §9); progress indicator; this is the "generate" step in RapidTool's CSG-hook pattern — `status: idle/running/success/error`. | Nest completes with ≥1 part placed |
| 5 | **Review Results** | 2D viewport (not 3D — this is a flat-nesting problem) showing the nested sheet(s); per-sheet pagination if multi-sheet; placed/unplaced count; re-nest affordance if settings changed since last run (nest2d's "Change settings or files to generate again" pattern, reused as `isNewParams` gate). | — |
| 6 | **Export** | Download DXF (single) / ZIP (multi-sheet); SVG stretch goal. | — |

This is a straight adaptation of nest2d's actual UX (which is good — via `MainSettings`/`StripSettings`, `ResultModal`, the requested/placed readout) into RapidTool's step-gate idiom instead of nest2d's single-page-with-modal-result idiom. The 2D viewport in step 5 is the one genuinely new UI surface relative to Fixture/SoftJaws/ShadowBox (which are all 3D-viewport-first); it should be a new `cad-ui` primitive if another future 2D-layout product would want it too (candidate: an SVG/canvas pan-zoom viewer), otherwise it stays local to this app's `src/`.

---

## 8. Design system reuse plan

Following the "would another RapidTool product use this unchanged?" test from `packages/cad-ui/CLAUDE.md`:

**Reuse as-is from `cad-ui`:**
`DashboardLayout`, `useWorkflowStore` (configure the 6 steps above), `useUIStore`, `CollapsiblePanel`, `NumberInput`, `PartThumbnail`, `StepProgress`, `SkipStep`, `LoadingIndicator`/`LoadingOverlay`, `Button`/`Accordion`/`Badge`/`DropdownMenu`, `RapidToolLogo`, `ThemeToggle`.

**Reuse from `cad-core`:** the STL parser isn't relevant here (DXF, not STL), but the mesh-export/file-download utility (`downloadFile(data, name, mime)`) and any generic AABB/bbox helpers are directly reusable. **New pure-algorithm code belongs in a new sibling package** (proposed `packages/nest-core`, see §9) — it is pure compute with zero React/DOM, matching `cad-core`'s own hard rules, but it is *not* CAD-mesh code (no STL, no CSG, no Three.js geometry), so it doesn't belong inside `cad-core` itself. `cad-core`'s own `CLAUDE.md` scope ("STL parser, CSGEngine, mesh export, coordinate helpers") doesn't include DXF/SVG parsing or 2D bin-packing — extending it there would violate its "pure CAD *mesh* algorithms" framing. Recommendation: `packages/nest-core` as a new sibling, or fold DXF parsing into `cad-core` (genuinely reusable — Fixture/SoftJaws export flat profiles too) while keeping the nesting algorithm itself app-local in `src/features/nest/utils/`.

**New, app-local (`src/`):** DXF parser (unless promoted to `cad-core`, see above), part-extraction/dedup logic, the nesting engine integration, the 2D sheet viewport component, sheet/material presets, all nest-domain Zustand stores (`nestStore`, `sheetStore`).

**Storage pattern:** copy Fixture/ShadowBox's `packages/storage` (`useFileSession`, `FileAutoSave`, `UndoRedoManager`) rather than reinventing project persistence — this is exactly the "named project, re-open later, autosave" behavior nest2d also has, and RapidTool already has a working implementation of it.

---

## 9. Technical architecture

### 9.1 Where does the nesting computation run? (the one big decision)

nest2d runs it server-side: MongoDB job queue + Python worker wrapping the Rust `jagua-rs` engine, because true irregular-polygon nesting (no-fit-polygon + local search/genetic optimization) is compute-heavy and nest2d wants it off the user's device (their landing page literally advertises "No client resource require — all calculation done by server"). Fixture, SoftJaws, and ShadowBox, by contrast, are RapidTool's established pattern of **browser-first compute** (CSG in Web Workers, OpenCV.js in a Web Worker) with only Fixture carrying a real backend (Postgres/Prisma, for auth and fixture persistence — not for compute).

This is a real fork in the road, not a detail to hand-wave:

| Option | Pros | Cons |
|---|---|---|
| **A. Client-side, Web Worker, JS/WASM nesting algorithm** (SVGnest-style NFP + genetic algorithm, or a WASM build of an NFP library) | Fits RapidTool's existing architecture and cost model exactly (no server compute bill, no job queue, works offline-ish); consistent with SoftJaws/ShadowBox's worker-in-browser pattern | Nesting is genuinely CPU-heavy for irregular polygons with many parts; browser tab compute is bounded (no multi-core batch cluster like a server farm); large jobs (50+ unique parts × high quantities) may be slow or need a lower iteration budget than nest2d's server can afford |
| **B. Lightweight backend job queue**, à la nest2d but simplified (a queue + a nesting worker service, reusing an existing NFP engine rather than porting jagua-rs) | Handles large/complex jobs without punishing the user's browser; matches nest2d's proven approach; can share Fixture's existing Postgres+backend pattern instead of adding Mongo | Adds real backend infrastructure RapidTool doesn't uniformly have today (only Fixture does); async job UX (poll/notify) is more complex than a synchronous worker call |
| **C. Hybrid**: client-side worker for common/small jobs (fast, free, fits the suite), with an opt-in "send to server" path for large jobs | Best of both, matches nest2d's own trajectory of prioritizing "speed and optimization quality" pragmatically over guaranteed optimality | Most engineering surface area; two code paths to maintain |

**Recommendation:** start with **Option A** for the MVP — a rectangle/irregular-polygon nesting algorithm (bottom-left-fill heuristic as the v1 baseline, no-fit-polygon + simple local search as the v1.1 quality upgrade) running in a Web Worker via `cad-core`'s existing worker-manager pattern. This is the option that requires zero new infrastructure, is consistent with every other RapidTool product's "the browser does the work" identity, and gets a real MVP in front of users fastest. Revisit Option C only once real usage shows the browser-side algorithm timing out or producing meaningfully worse layouts than jagua-rs on realistic job sizes — don't build the backend queue speculatively.

### 9.2 Algorithm approach

- **v1 (MVP):** Bottom-left-fill (BLF) heuristic with axis-aligned bounding-box collision checks and 0°/90°/180°/270° rotation options. Simple, fast, well-understood, gets a shippable "it works" result. This is roughly where the *original* SVGnest/Nest4J lineage that nest2d itself descended from started.
- **v1.1 (quality upgrade):** No-fit-polygon (NFP) based placement for true irregular-shape nesting (not just bounding boxes) — this is what actually gets nest2d-competitive packing density. Either hand-roll NFP+local-search in TS, or evaluate a WASM port — note `jagua-rs` is pure Rust with no browser bindings today; a WASM build is a real (but nontrivial, multi-week) undertaking, not a drop-in.
- **Multi-sheet overflow:** once a sheet is full, start a new sheet, up to the configured sheet count — same behavior as nest2d's `sheetCount` parameter.
- **Strip mode (deferred):** 1D strip packing (fixed height/width, unbounded other dimension) is a materially different algorithm from 2D bin packing, not a parameter tweak — treat it as its own feature in v1.1+, exactly as nest2d's own git history shows it arrived after the core 2D mode.

### 9.3 File format handling

- **DXF import:** parse closed polylines/entities into part outlines. This needs a real DXF parser (arcs, polylines, splines-to-polyline tessellation) — evaluate an existing JS DXF library before hand-rolling one; nest2d's own dependency list (`dxf-viewer` for *display*) is a useful pointer but their *parsing* is server-side Python (`dxf_utils.py`), which we won't reuse directly since this is a JS/TS stack.
- **DXF export:** write the nested layout back out per-sheet as DXF (and SVG as a stretch), preserving original part geometry (not re-tessellated/lossy).
- Reuse `cad-core`'s `downloadFile()` for the browser-download mechanics either way.

### 9.4 New stores

- `nestStore` (Zustand): imported parts (geometry + bbox + quantity + rotation setting), per-part status.
- `sheetStore` (Zustand): width/height, spacing, sheet count, material preset — mirrors SoftJaws' `viseStore` role (global config that downstream steps depend on).
- Result state (placed/unplaced parts, per-sheet layouts) — either its own store or folded into `nestStore`, decide during implementation based on how the CSG-hook `{status, error, generate}` pattern (already used for SoftJaws steps 4/6) maps onto "run nest."

---

## 10. Non-functional requirements

- **File limits:** match or exceed nest2d's stated limits as a starting bar (20 files, 5MB each) — revisit once real DXF part-count/complexity data exists.
- **Performance budget:** a nest run should give the user feedback (progress or at least a spinner with elapsed time) within 1–2s of starting, and the v1 BLF algorithm should complete typical shop jobs (≤50 unique parts, ≤500 total placed instances) in well under nest2d's own async-job UX threshold (they added email notification specifically because jobs can take minutes) — target seconds, not minutes, for the client-side v1 algorithm's target job sizes; document the practical part-count ceiling once benchmarked rather than promising one now.
- **Failure UX:** replicate nest2d's clear pre-flight ("plate too small: need at least W×H, current plate is w×h") and post-run ("no solution found, N of M parts placed") messaging — this is genuinely good UX worth matching exactly, not reinventing.
- **Theming/accessibility:** same bar as the rest of the suite (CSS-variable theming, dark/light).

---

## 11. Engineering project plan

### Phase 0 — Setup (few days)
- Scaffold a new repo (proposed name: **`RapidTool-Nest`**, avoiding "nest2d" itself to keep clear separation from the reference project) following the Fixture/SoftJaws/ShadowBox monorepo shape: `src/`, `packages/cad-ui/`, `packages/cad-core/`, `packages/storage/`.
- Copy `cad-ui` and `cad-core` from the most structurally similar sibling (ShadowBox is the closest analog: browser-only, worker-driven, 2D-input-to-manufacturable-output) as the starting point, then prune what's irrelevant (e.g., 3D-only pieces if a 2D-first viewport is added).
- Stand up the empty `DashboardLayout` shell with the 6 workflow steps registered (stubs) and step gates wired, before any real feature logic — this is the fastest way to get something demoable and to validate the design-system reuse assumption in §8 early.

### Phase 1 — MVP core loop (largest phase)
1. DXF import + part extraction (step 1) — this is the riskiest new dependency (DXF parsing is fiddly); spike it first.
2. Quantities & rotation (step 2).
3. Sheet setup + pre-flight validation (step 3) — straightforward, low risk, do it in parallel with #1.
4. BLF nesting algorithm in a Web Worker (step 4) — second-riskiest item; spike alongside DXF parsing since both gate everything downstream.
5. 2D result viewport + placed/unplaced readout (step 5).
6. DXF export, single + multi-sheet ZIP (step 6).

**Exit criterion:** a user can upload real shop DXFs, set a sheet size, get a nested layout, and download cut-ready files — full parity with nest2d's core loop, BLF quality (not yet NFP quality).

### Phase 2 — Quality & parity gaps
- NFP-based placement to close the packing-density gap vs. nest2d's jagua-rs engine.
- Strip/coil nesting mode.
- SVG export.
- Material/sheet-size presets catalog.
- Project persistence via `packages/storage` (autosave, reopen).

### Phase 3 — Suite integration & polish
- Cross-product entry points (e.g., "Send to Nest" from a Fixture/SoftJaws flat-profile export, if that's a real workflow — validate with users before building).
- Whatever RapidTool's shared account/entitlement system is (this PRD deliberately does not assume nest2d's Stripe+credits model — see open question in §12).
- Benchmark real job sizes against the performance budget in §10; revisit the Option A/B/C decision in §9.1 only if data says so.

### Suggested sequencing rationale
DXF parsing and the nesting algorithm are the two components with no RapidTool precedent to lean on (everything else — layout, gates, stores, file download, project persistence — is "do what SoftJaws/ShadowBox/Fixture already do"). De-risk those two first with throwaway spikes before investing in the full step-by-step UI around them.

---

## 12. Open questions for the founder

1. **Compute location (§9.1):** confirm Option A (client-side, matches the rest of the suite) vs. deliberately taking on server infrastructure like nest2d's. This is the single biggest architecture decision and should be signed off before Phase 0.
2. **Product name & positioning:** "RapidTool Nest" is a placeholder — confirm before the repo is created, since renaming later touches branding, URLs, and the RapidTool suite's cross-links.
3. **Business model:** does this ship free (loss-leader / suite-value-add), bundled into an existing RapidTool plan, or does it need its own metering like nest2d's credit system? This affects whether Phase 3 needs real billing work.
4. **DXF-only or DXF+SVG import?** nest2d has drifted to DXF-only in practice; confirm that's the right v1 scope for RapidTool's audience (SVG is more common outside sheet-metal-specific contexts, e.g., for the ShadowBox/laser-cutter-hobbyist crowd).
5. **Cross-suite integration depth:** is "nest a profile exported from another RapidTool product" a real, prioritized use case, or a nice-to-have for later? Changes whether Phase 3's integration work should move earlier.

---

## 13. Success metrics (draft — refine with founder)

- Time from DXF upload to downloaded cut-ready file (target: under a few minutes end-to-end for a typical job, matching nest2d's own "in under 10 minutes" framing style used elsewhere in the RapidTool family, e.g. ShadowBox's README).
- Packing efficiency (used sheet area / total sheet area) on a benchmark part set — track BLF (v1) vs. NFP (v1.1) to justify the phase 2 investment.
- % of nest runs that place 100% of requested parts on the first try (pre-flight validation should push this high).
- Adoption by existing Fixture/SoftJaws/ShadowBox users (suite cross-sell signal) vs. net-new users (standalone-tool signal) — different growth stories, worth tracking separately from day one.
