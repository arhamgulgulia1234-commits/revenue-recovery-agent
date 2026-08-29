import type { Metadata } from 'next';
import Link from 'next/link';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'AI Revenue Recovery',
  description: 'Agentic recovery of failed payments, subscriptions and overdue invoices.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <header className="border-b border-border">
          <div className="mx-auto max-w-6xl px-6 py-4 flex items-baseline gap-4 flex-wrap">
            <Link href="/" className="text-base font-semibold tracking-tight">
              AI Revenue Recovery
            </Link>
            <span className="text-xs text-muted">Razorpay AI Buildathon · Track 3</span>
            <nav className="ml-auto flex items-center gap-4 text-sm">
              <Link href="/" className="text-muted hover:text-foreground transition-colors">
                Dashboard
              </Link>
              <Link href="/stopped" className="text-muted hover:text-foreground transition-colors">
                Where we stopped
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
