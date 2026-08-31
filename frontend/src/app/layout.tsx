import type { Metadata } from 'next';
import Image from 'next/image';
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';
import { NavLink } from '@/components/NavLink';

const plexSans = IBM_Plex_Sans({
  variable: '--font-plex-sans',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
});
const plexMono = IBM_Plex_Mono({
  variable: '--font-plex-mono',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
});

export const metadata: Metadata = {
  title: 'REVYN',
  description: 'Agentic recovery of failed payments, subscriptions and overdue invoices.',
};

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/stopped', label: 'Where we stopped' },
  { href: '/simulate', label: 'Simulate a failure' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${plexSans.variable} ${plexMono.variable} antialiased`}>
        <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur-sm">
          <div className="mx-auto max-w-6xl px-6 py-3.5 flex items-center gap-3 flex-wrap">
            <a href="/" className="flex items-center gap-2.5 shrink-0 group">
              <span className="grid h-7 w-7 place-items-center rounded-md bg-black shrink-0 overflow-hidden">
                <Image src="/logo.png" alt="REVYN" width={28} height={28} className="h-full w-full object-contain" priority />
              </span>
              <span className="text-[13px] font-semibold tracking-tight">REVYN</span>
            </a>
            <nav className="ml-auto flex items-center gap-1 text-sm">
              {NAV.map((item) => (
                <NavLink key={item.href} href={item.href}>
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
