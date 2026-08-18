import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Adport Cloud', template: '%s · Adport Cloud' },
  description: 'Securely connect, report on, and manage advertising accounts from any AI agent.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
