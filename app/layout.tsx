import type { Metadata, Viewport } from 'next';
import { Geist } from 'next/font/google';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/AppShell';
import './globals.css';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Whal Bot · Terminal', template: '%s · Whal Bot' },
  description: 'Operator terminal for the Whal Bot engine (mock data).',
  icons: { icon: '/logo.png' },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: '#000000', colorScheme: 'dark' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={geist.variable}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
