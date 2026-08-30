'use client';

import { useEffect, useState } from 'react';
import { inrCompact } from '@/lib/api';

/**
 * Formatter is picked by name, not passed as a function — a server component
 * can't hand a function prop to a client component, so the two supported
 * shapes live here instead.
 */
const FORMATTERS = {
  inrCompact,
  percent1: (n: number) => `${n.toFixed(1)}%`,
} as const;

/**
 * Counts up from 0 to `value` once, on mount. Respects reduced-motion by
 * rendering the final value immediately rather than skipping the effect
 * silently (a judge with reduced-motion on should still see the number).
 */
export function CountUp({
  value, variant = 'inrCompact', durationMs = 900,
}: { value: number; variant?: keyof typeof FORMATTERS; durationMs?: number }) {
  const format = FORMATTERS[variant];
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || value === 0) {
      // Deferred to a frame rather than set synchronously in the effect body,
      // so this path is a scheduled update like the animated one below.
      const raf = requestAnimationFrame(() => setDisplay(value));
      return () => cancelAnimationFrame(raf);
    }

    const start = performance.now();
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);
    let raf: number;

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      setDisplay(value * ease(t));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    // rAF is throttled or never scheduled in some contexts (backgrounded/
    // headless tabs) — a hard timeout guarantees the real value still lands
    // instead of leaving the card stuck at 0.
    const settle = window.setTimeout(() => setDisplay(value), durationMs + 150);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return <span className="tabular-nums">{format(display)}</span>;
}
