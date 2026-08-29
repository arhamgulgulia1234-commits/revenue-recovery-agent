'use client';

import { useRouter } from 'next/navigation';
import type { ReactNode, KeyboardEvent, MouseEvent } from 'react';

/**
 * A table row that navigates when clicked anywhere, not just on the one cell
 * that happens to contain a link.
 *
 * The rows already had a hover highlight, which promises the whole row is
 * clickable — but only the customer name was an anchor, so clicking the amount
 * or the status did nothing and the UI looked broken. The inner anchor stays
 * (it keeps middle-click, ctrl-click and screen-reader semantics working); this
 * only widens the hit area to match what the hover state advertises.
 */
export function ClickableRow({
  href, children, className = '',
}: { href: string; children: ReactNode; className?: string }) {
  const router = useRouter();

  const go = (e: MouseEvent<HTMLTableRowElement>) => {
    // Let real links, and anything the user is trying to select, behave normally.
    if ((e.target as HTMLElement).closest('a, button')) return;
    if (window.getSelection()?.toString()) return;
    router.push(href);
  };

  const onKey = (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      router.push(href);
    }
  };

  return (
    <tr
      onClick={go}
      onKeyDown={onKey}
      tabIndex={0}
      role="link"
      aria-label={`Open ${href.split('/').pop()}`}
      className={`${className} cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-accent/60`}
    >
      {children}
    </tr>
  );
}
