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
  manifest: '/manifest.json',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {/* Google Analytics */}
        <script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
        <script dangerouslySetInnerHTML={{
          __html: `
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'G-XXXXXXXXXX');
          `
        }} />
        <link rel="canonical" href="https://fluxdrop.com/" />
        <script type="application/ld+json" dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Organization",
            "name": "FluxDrop",
            "url": "https://fluxdrop.com",
            "logo": "/icons/logo-512x512.png"
          })
        }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Product",
            "name": "FluxDrop",
            "description": "Share files instantly between devices. Zero setup, end-to-end encrypted, no storage.",
            "image": "/icons/logo-512x512.png",
            "brand": {
              "@type": "Brand",
              "name": "FluxDrop"
            }
          })
        }} />
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" href="/icons/logo-32x32.png" sizes="32x32" />
        <link rel="icon" href="/icons/logo-16x16.png" sizes="16x16" />
        <link rel="apple-touch-icon" href="/icons/logo-192x192.png" />
        <meta property="og:title" content="FluxDrop - Instant File Sharing" />
        <meta property="og:description" content="Share files instantly between devices. Zero setup, end-to-end encrypted, no storage." />
        <meta property="og:image" content="/icons/logo-512x512.png" />
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://fluxdrop.com" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="FluxDrop - Instant File Sharing" />
        <meta name="twitter:description" content="Share files instantly between devices. Zero setup, end-to-end encrypted, no storage." />
        <meta name="twitter:image" content="/icons/logo-512x512.png" />
      </head>
      <body className={inter.className}>{children}</body>
    </html>
  );
}