import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Adport Cloud', template: '%s — Adport Cloud' },
  description: 'Securely connect, report on, and manage advertising accounts from any AI agent.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <header className="shell topbar">
          <Link className="brand" href="/">adport<span>.cloud</span></Link>
          <nav className="actions"><Link href="/dashboard">Dashboard</Link><a href="https://adport.dev/privacy">Privacy</a></nav>
        </header>
        {children}
      </body>
    </html>
  );
}
