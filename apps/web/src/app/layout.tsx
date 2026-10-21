import type { Metadata, Viewport } from 'next';
import { Inter, Newsreader } from 'next/font/google';
import { AuthProvider } from '@/lib/auth/auth-context';
import './globals.css';

// Self-hosted by Next at build time: the browser never calls Google Fonts.
const newsreader = Newsreader({
  subsets: ['latin'],
  variable: '--font-newsreader',
  style: ['normal', 'italic'],
  display: 'swap',
});
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Bookie', template: '%s · Bookie' },
  description:
    'Decide whether to read a book: public reception and your personal match, kept apart.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${newsreader.variable} ${inter.variable}`}>
      <body className="min-h-dvh bg-background text-on-background">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
