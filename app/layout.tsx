import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { IBM_Plex_Sans, Unbounded } from 'next/font/google';
import { NotificationProvider } from '../components/ui/notification-provider';
import { AppErrorBoundary } from '../components/ui/error-boundary';
import './globals.css';

const plex = IBM_Plex_Sans({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600'],
  variable: '--font-ui',
  display: 'swap',
});

const unbounded = Unbounded({
  subsets: ['latin', 'cyrillic'],
  weight: ['600', '700'],
  variable: '--font-digits',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Taska',
  description: 'Taska: планировщик дел, полчаса на задачу, пять минут на перерыв',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#16282E',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang='ru' className={`${plex.variable} ${unbounded.variable}`}>
      <body>
        <NotificationProvider>
          <AppErrorBoundary>
            {children}
          </AppErrorBoundary>
        </NotificationProvider>
      </body>
    </html>
  );
}
