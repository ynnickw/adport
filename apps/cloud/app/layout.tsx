import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';

// Same faces as adport.dev (website/fonts), self-hosted so the CSP stays font-src 'self'.
const overpass = localFont({
  src: './fonts/overpass-latin-wght-normal.woff2',
  weight: '100 900',
  variable: '--font-overpass',
  display: 'swap',
});
const overpassMono = localFont({
  src: './fonts/overpass-mono-latin-wght-normal.woff2',
  weight: '300 700',
  variable: '--font-overpass-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: { default: 'Adport', template: '%s · Adport' },
  description: 'Securely connect, report on, and manage advertising accounts from any AI agent.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${overpass.variable} ${overpassMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
