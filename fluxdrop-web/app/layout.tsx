// fluxdrop-web/app/layout.tsx
import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: {
    default: "FluxDrop - Fast, Secure & Instant File Sharing (P2P)",
    template: "%s | FluxDrop",
  },
  description:
    "Share files instantly across any device with FluxDrop. Peer-to-peer, end-to-end encrypted, and no file size limits. Zero setup, no account needed.",
  keywords: [
    "file sharing",
    "instant transfer",
    "p2p file transfer",
    "secure file sharing",
    "WebRTC",
    "send files",
    "FluxDrop",
    "no registration file sharing",
    "fast file transfer",
    "cross-platform sharing",
    "wireless file transfer",
  ],
  authors: [{ name: "FluxDrop Team" }],
  creator: "Prem Shaw",
  publisher: "FluxDrop",
  applicationName: "FluxDrop",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "FluxDrop",
  },
  formatDetection: {
    telephone: false,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  alternates: {
    canonical: "https://flux-drop.vercel.app",
  },
  openGraph: {
    title: "FluxDrop - Instant P2P File Sharing",
    description:
      "Transfer files directly between devices with zero setup. Secure, fast, and private end-to-end encrypted file sharing.",
    url: "https://flux-drop.vercel.app",
    siteName: "FluxDrop",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "FluxDrop - Instant File Sharing",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "FluxDrop - Fast & Secure File Sharing",
    description:
      "No more emails or cables. Share files instantly between any device with FluxDrop.",
    images: ["/og-image.png"],
  },
  other: {
    "google-site-verification": "3qjYnT7GW81-zwJBwv3wJABvxbiSOgDyAlTCKxh9nEs",
    "application/ld+json": JSON.stringify([
      {
        "@context": "https://schema.org",
        "@type": "WebApplication",
        "name": "FluxDrop",
        "url": "https://flux-drop.vercel.app",
        "description": "Instant peer-to-peer file sharing application using WebRTC technology.",
        "applicationCategory": "FileSharingApplication",
        "operatingSystem": "All",
        "offers": {
          "@type": "Offer",
          "price": "0",
          "priceCurrency": "USD"
        },
        "featureList": [
          "Peer-to-Peer Transfer",
          "End-to-End Encryption",
          "No File Size Limits",
          "No Account Required",
          "Cross-device Compatibility"
        ]
      },
      {
        "@context": "https://schema.org",
        "@type": "Organization",
        "name": "FluxDrop",
        "url": "https://flux-drop.vercel.app",
        "logo": "https://flux-drop.vercel.app/icons/logo-512x512.png"
      }
    ])
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
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
        <script async src="https://www.googletagmanager.com/gtag/js?id=G-3qjYnT7GW81-zwJBwv3wJABvxbiSOgDyAlTCKxh9nEs"></script>
        <script dangerouslySetInnerHTML={{
          __html: `
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'G-3qjYnT7GW81-zwJBwv3wJABvxbiSOgDyAlTCKxh9nEs');
          `
        }} />
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" href="/logo.png" type="image/png" />
        <link rel="icon" href="/icons/logo-32x32.png" sizes="32x32" />
        <link rel="icon" href="/icons/logo-16x16.png" sizes="16x16" />
        <link rel="apple-touch-icon" href="/icons/logo-192x192.png" />
      </head>
      <body className={inter.className}>{children}</body>
    </html>
  );
}