import type { Metadata, Viewport } from 'next';
import { Geist, Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/AppShell';
import './globals.css';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist', display: 'swap' });
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Odex Bot · Terminal', template: '%s · Odex Bot' },
  description: 'Operator terminal for the Odex Bot engine.',
  icons: { icon: '/Fav.png', shortcut: '/Fav.png', apple: '/Fav.png' },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: '#000000', colorScheme: 'dark' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${geist.variable}`} suppressHydrationWarning>
      <body suppressHydrationWarning>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
