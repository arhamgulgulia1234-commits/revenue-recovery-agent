'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const pathname = usePathname();
  const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`rounded-md px-3 py-1.5 transition-colors ${
        active
          ? 'text-brand font-medium bg-brand/10'
          : 'text-muted hover:text-foreground hover:bg-card'
      }`}
    >
      {children}
    </Link>
  );
}
