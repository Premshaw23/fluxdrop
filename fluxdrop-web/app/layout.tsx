// fluxdrop-web/app/layout.tsx
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'FluxDrop - Instant File Sharing',
  description: 'Share files instantly between devices. Zero setup, end-to-end encrypted, no storage.',
  keywords: 'file sharing, p2p, webrtc, file transfer, secure sharing',
  authors: [{ name: 'FluxDrop' }],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>{children}</body>
    </html>
  );
}