/**
 * Global progress store — one thin top bar for every long async flow (paper
 * detection, BiRefNet/IS-Net trace, SAM refine, STL build…).
 *
 * Two modes:
 *  • Estimated (opaque ops, e.g. a single 18s backend fetch): `start(label, estMs)`
 *    eases the bar toward ~92% over estMs and `done()` snaps it to 100%. A single
 *    request can't report true %, so this is the honest, never-stall pattern.
 *  • Staged (ops with milestones, e.g. SAM load→embed→decode): call `set(percent)`
 *    at each step for real progress.
 */
import { create } from 'zustand';

interface ProgressState {
  active: boolean;
  label: string;
  percent: number; // 0–100
  start: (label: string, estMs?: number) => void;
  set: (percent: number, label?: string) => void; // staged updates (monotonic) + optional relabel
  done: () => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
const clear = () => { if (timer) { clearInterval(timer); timer = null; } };

export const useProgress = create<ProgressState>((set, get) => ({
  active: false,
  label: '',
  percent: 0,

  start: (label, estMs = 8000) => {
    clear();
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    set({ active: true, label, percent: 1 });
    const t0 = Date.now();
    // Asymptotic ease toward 92% — reaches ~80% at estMs, then keeps creeping so a
    // slow op never looks frozen. done() snaps to 100%.
    timer = setInterval(() => {
      const e = Date.now() - t0;
      const p = 92 * (1 - Math.exp(-e / (estMs * 0.55)));
      if (p > get().percent) set({ percent: p });
    }, 120);
  },

  set: (percent, label) => set((s) => ({
    percent: Math.max(s.percent, Math.min(99.5, percent)),
    label: label ?? s.label,
  })),

  done: () => {
    clear();
    set({ percent: 100 });
    hideTimer = setTimeout(() => set({ active: false, percent: 0, label: '' }), 400);
  },
}));
