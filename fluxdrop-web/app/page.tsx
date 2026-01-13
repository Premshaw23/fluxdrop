// fluxdrop-web/app/page.tsx
'use client';

import { useState } from 'react';
import { Upload, Download, Zap } from 'lucide-react';
import Link from 'next/link';
import Image from 'next/image';

export default function HomePage() {
  return (
    <div className="min-h-screen bg-linear-to-br from-blue-100 via-white to-purple-100">
      {/* Header */}
      <header className="border-b bg-white/50 backdrop-blur-sm" role="banner">
        <div className="container mx-auto px-4 py-2">
          <div className="flex items-center gap-2">
            <Image src={"/logo.png"} width={200} height={200} className="w-10 h-10 text-blue-600 rounded-2xl" alt='FluxDrop logo'/>
            <h1 className="text-2xl font-bold text-gray-900">FluxDrop</h1>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-16" id="main-content" tabIndex={-1} role="main">
        <div className="max-w-4xl mx-auto text-center mb-16">
          <h2 className="text-5xl font-bold text-gray-900 mb-6">
            Instant <span className="text-blue-600">file sharing</span> with <span className="text-blue-600">P2P</span> technology.
            <br />
            <span className="text-blue-600">Zero friction. Secure. Fast.</span>
          </h2>
          <p className="text-xl text-gray-600 mb-8">
            FluxDrop lets you <strong>share files</strong> instantly and securely between any devices using <strong>peer-to-peer (P2P)</strong> connections powered by <strong>WebRTC</strong>.
            No accounts, no installation, no storage—just direct, <strong>end-to-end encrypted file transfer</strong>.
            Experience <strong>secure sharing</strong> with blazing speed and privacy.
          </p>
        </div>

        {/* Action Cards */}
        <div className="grid md:grid-cols-2 gap-8 max-w-4xl mx-auto mb-16">
          {/* Send Card */}
          <Link href="/send">
            <div className="group bg-white rounded-2xl p-8 shadow-lg hover:shadow-xl transition-all cursor-pointer border-2 border-transparent hover:border-blue-500">
              <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mb-6 group-hover:bg-blue-600 transition-colors" aria-hidden="true">
                <Upload className="w-8 h-8 text-blue-600 group-hover:text-white" aria-label="Send files icon" />
              </div>
              <h3 className="text-2xl font-bold text-gray-900 mb-3">Send Files</h3>
              <p className="text-gray-600 mb-6">
                Choose your files, get a code, and share instantly with anyone.
              </p>
              <div className="inline-flex items-center text-blue-600 font-semibold group-hover:gap-3 transition-all">
                Start sending
                <span className="ml-2 group-hover:ml-0">→</span>
              </div>
            </div>
          </Link>

          {/* Receive Card */}
          <Link href="/receive">
            <div className="group bg-white rounded-2xl p-8 shadow-lg hover:shadow-xl transition-all cursor-pointer border-2 border-transparent hover:border-purple-500">
              <div className="w-16 h-16 bg-purple-100 rounded-full flex items-center justify-center mb-6 group-hover:bg-purple-600 transition-colors" aria-hidden="true">
                <Download className="w-8 h-8 text-purple-600 group-hover:text-white" aria-label="Receive files icon" />
              </div>
              <h3 className="text-2xl font-bold text-gray-900 mb-3">Receive Files</h3>
              <p className="text-gray-600 mb-6">
                Enter the 6-digit code and download files directly to your device.
              </p>
              <div className="inline-flex items-center text-purple-600 font-semibold group-hover:gap-3 transition-all">
                Start receiving
                <span className="ml-2 group-hover:ml-0">→</span>
              </div>
            </div>
          </Link>
        </div>

        {/* Features */}
        <section aria-label="Features" className="max-w-4xl mx-auto">
          <div className="grid md:grid-cols-3 gap-8">
            <div className="text-center">
              <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4" aria-hidden="true">
                <span className="text-2xl" role="img" aria-label="Lightning Fast">⚡</span>
              </div>
              <h3 className="font-semibold text-gray-900 mb-2">Lightning Fast</h3>
              <p className="text-gray-600 text-sm">Direct P2P transfers at LAN speeds</p>
            </div>
            <div className="text-center">
              <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4" aria-hidden="true">
                <span className="text-2xl" role="img" aria-label="Private & Secure">🔒</span>
              </div>
              <h3 className="font-semibold text-gray-900 mb-2">Private & Secure</h3>
              <p className="text-gray-600 text-sm">End-to-end encrypted, no server storage</p>
            </div>
            <div className="text-center">
              <div className="w-12 h-12 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-4" aria-hidden="true">
                <span className="text-2xl" role="img" aria-label="Universal">🌍</span>
              </div>
              <h3 className="font-semibold text-gray-900 mb-2">Universal</h3>
              <p className="text-gray-600 text-sm">Works on any device with a browser</p>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t bg-white/50 backdrop-blur-sm mt-24" role="contentinfo">
        <div className="container mx-auto px-4 py-8">
          <div className="text-center text-gray-600 text-sm">
            <p>Built with ❤️ for instant file sharing</p>
            <p className="mt-2">No tracking. No storage. Just pure transfer.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}