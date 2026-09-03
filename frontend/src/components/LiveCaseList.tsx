'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { inr, istDateTime, STATUS_DISPLAY, type CaseStatus } from '@/lib/api';
import { API_URL } from '@/lib/api';
import { checkPaymentStatus, LINK_STATUS_TONE, type PaymentLink } from '@/lib/liveCase';

/**
 * Every live case on the book, not just the one you happened to make last.
 *
 * The panel above shows the case it just created and forgets it on reload, which
 * is fine while you are creating one and useless a minute later — the link is
 * real and persisted, so losing sight of it in the UI is a gap in the UI rather
 * than a property of the case. This reads /api/live/cases, which already existed
 * and had no consumer.
 *
 * Each row can be re-checked independently, because that is how it actually
 * gets used: mint a link, go and pay it on a phone, come back, press the row.
 */

type Row = {
  id: string;
  status: CaseStatus;
  customer_name: string;
  amount_at_risk_inr: number;
  recovered_amount_inr: number;
  opened_at: string;
  paid_at: string | null;
  paymentLink: PaymentLink;
};

export function LiveCaseList({ refreshKey = 0 }: { refreshKey?: number }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/live/cases`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Could not load live cases (${res.status})`);
      const data = await res.json();
      setRows(data.cases ?? []);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  async function recheck(id: string) {
    setBusyId(id);
    try {
      const r = await checkPaymentStatus(id);
      setNotes((n) => ({ ...n, [id]: r.caseClosedNow ? 'Payment confirmed — case closed.' : r.note }));
      await load();
    } catch (e) {
      setNotes((n) => ({ ...n, [id]: (e as Error).message }));
    } finally {
      setBusyId(null);
    }
  }

  if (error) {
    return (
      <p className="text-sm text-muted">{error}</p>
    );
  }
  if (!rows) return <p className="text-sm text-muted">Loading live cases…</p>;
  if (!rows.length) {
    return (
      <p className="text-sm text-muted">
        No live cases yet. Generate one above and it will appear here, with its link, for as long as
        it is on the book.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {rows.map((r) => {
        const badge = STATUS_DISPLAY[r.status] ?? STATUS_DISPLAY.open;
        const link = r.paymentLink;
        const tone = link?.status ? (LINK_STATUS_TONE[link.status] ?? 'neutral') : null;
        return (
          <li key={r.id} className="py-3 flex gap-4 items-start flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <Link
                  href={`/cases/${r.id}`}
                  className="font-mono text-xs underline hover:text-foreground"
                >
                  {r.id}
                </Link>
                <span className="text-sm font-medium truncate">{r.customer_name}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badge.className}`}>
                  {badge.label}
                </span>
                {link?.status && (
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded ${
                      tone === 'good' ? 'bg-recovered/10 text-recovered'
                        : tone === 'bad' ? 'bg-alert/10 text-alert'
                        : 'bg-pending/10 text-pending'
                    }`}
                  >
                    link {link.status}
                  </span>
                )}
              </div>

              {link?.url ? (
                <a
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block mt-1 font-mono text-xs text-comms underline break-all hover:opacity-80"
                >
                  {link.url}
                </a>
              ) : (
                <p className="mt-1 text-xs text-muted">
                  No link on this case — the agent retries this cause silently.
                </p>
              )}

              <p className="text-xs text-muted mt-1">
                opened {istDateTime(r.opened_at)}
                {r.paid_at && <> · paid {istDateTime(r.paid_at)}</>}
              </p>

              {notes[r.id] && <p className="text-xs text-muted mt-1.5">{notes[r.id]}</p>}
            </div>

            <div className="text-right shrink-0">
              <div className="text-sm font-semibold tabular-nums">
                {inr(r.status === 'recovered' ? r.recovered_amount_inr : r.amount_at_risk_inr)}
              </div>
              {link?.id && (
                <button
                  type="button"
                  onClick={() => recheck(r.id)}
                  disabled={busyId === r.id}
                  className="mt-1.5 text-xs px-2 py-1 rounded border border-border text-muted hover:text-foreground hover:border-brand/60 transition-colors disabled:opacity-40"
                >
                  {busyId === r.id ? 'Checking…' : 'Check payment status'}
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
