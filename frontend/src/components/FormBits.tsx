'use client';

/**
 * The small form pieces both panels use.
 *
 * Pulled out of the simulate page when it split into two sections. They are
 * shared for one reason only — a field should look the same whichever panel it
 * is in — and they carry no behaviour beyond layout. Nothing about which panel
 * is simulated and which one talks to Razorpay lives here.
 */

export const fieldClass =
  'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-accent/60';

export function Group({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-muted mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted mt-1.5 leading-relaxed">{hint}</p>}
    </div>
  );
}

export function Segmented({
  options, value, onChange, danger = false,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  danger?: boolean;
}) {
  return (
    <div className="flex rounded-md border border-border overflow-hidden">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={`flex-1 text-xs py-1.5 px-1 transition-colors border-r border-border last:border-r-0 ${
              active
                ? danger
                  ? 'bg-red-500/15 text-red-500 font-medium'
                  : 'bg-accent/15 text-accent font-medium'
                : 'text-muted hover:text-foreground hover:bg-background'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
