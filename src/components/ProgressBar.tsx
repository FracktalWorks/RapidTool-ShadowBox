/**
 * ProgressBar — a thin top loading line + a centered status pill, driven by the
 * global progressStore. Rendered through a portal to <body> so no ancestor's
 * transform/backdrop-filter/overflow can clip or mis-position the fixed bar.
 * Mounted once at the app shell; shows for any long flow.
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { useProgress } from '../stores/progressStore';

export const ProgressBar: React.FC = () => {
  const active = useProgress((s) => s.active);
  const label = useProgress((s) => s.label);
  const percent = useProgress((s) => s.percent);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className={`pointer-events-none fixed inset-x-0 top-0 z-[9999] transition-opacity duration-300 ${active ? 'opacity-100' : 'opacity-0'}`}
      aria-hidden={!active}
    >
      {/* top progress line */}
      <div className="h-[4px] w-full bg-[hsl(var(--primary)/0.12)]">
        <div
          className="h-full rounded-r-full bg-[hsl(var(--primary))] shadow-[0_0_12px_hsl(var(--primary))] transition-[width] duration-200 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>

      {/* centered status pill — sits BELOW the ~56px header so it never overlaps
          the centered file (new/open/save) buttons */}
      {active && (
        <div className="mx-auto mt-[68px] flex w-fit items-center gap-2 rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--background))]/95 px-3.5 py-1.5 text-[12.5px] shadow-lg backdrop-blur-sm">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[hsl(var(--primary))]" />
          <span className="font-medium text-[hsl(var(--foreground))]">{label}</span>
          <span className="font-tech tabular-nums text-[hsl(var(--primary))]">{Math.round(percent)}%</span>
        </div>
      )}
    </div>,
    document.body,
  );
};
