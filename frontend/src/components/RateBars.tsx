import { inr, SCORE_BAND_STYLES } from '@/lib/api';

/**
 * A labelled rate bar list. Bars are scaled to the largest rate in the set,
 * not to 100%, so small differences between buckets stay readable.
 */
export function RateBars({
  title, note, rows,
}: {
  title: string;
  note?: string;
  rows: { label: string; rate: number; n: number; hint?: string }[];
}) {
  const max = Math.max(...rows.map((r) => r.rate), 0.01);
  return (
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {note && <p className="text-xs text-muted mt-0.5 mb-3">{note}</p>}
      <ul className={`space-y-2 ${note ? '' : 'mt-3'}`}>
        {rows.map((r) => (
          <li key={r.label} className="text-sm">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate">{r.label}</span>
              <span className="tabular-nums text-xs shrink-0">
                {(r.rate * 100).toFixed(0)}%
                <span className="text-muted"> · n={r.n}</span>
              </span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-border overflow-hidden">
              <div
                className="h-full rounded-full bg-brand transition-[width] duration-700 ease-out"
                style={{ width: `${(r.rate / max) * 100}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ScoreBadge({ score, band }: { score: number; band: string }) {
  return (
    <span className={`text-xs rounded-full px-2 py-0.5 font-medium tabular-nums ${SCORE_BAND_STYLES[band] ?? ''}`}>
      {Math.round(score * 100)}%
    </span>
  );
}

export function Money({ value }: { value: number }) {
  return <span className="tabular-nums">{inr(value)}</span>;
}
