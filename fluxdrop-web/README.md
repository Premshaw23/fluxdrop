# FluxDrop Web

> Instant, private, cross-device file sharing through your browser.

---

## 🚀 What is FluxDrop?
FluxDrop is a browser-based, peer-to-peer file transfer system. No accounts, no installation, no storage—just instant, encrypted transfers between any devices.

---

## Core Value Proposition
- **Zero setup:** Open browser, share code, transfer files
- **Maximum speed:** Direct P2P (LAN speed when possible)
- **Complete privacy:** End-to-end encrypted, no server storage
- **Universal:** Works on any device with a modern browser

---

## Technical Architecture
- **Frontend:** Next.js 14, TypeScript, Tailwind CSS, Zustand
- **Backend:** Node.js 20, ws (WebSocket), Upstash Redis (ephemeral session store), Zod (validation)
- **P2P Layer:** WebRTC DataChannels for direct transfer, TURN relay as fallback
- **Security:** ECDH key exchange, AES-256-GCM encryption, SHA-256 integrity checks

---

## How It Works
1. **Sender** opens app, selects files, gets a 6-digit code or QR
2. **Receiver** enters code or scans QR
3. **Signaling** via WebSocket server (no file data sent)
4. **ECDH key exchange** for secure session
5. **WebRTC P2P connection** established
6. **Files transferred** in encrypted chunks (AES-GCM)
7. **Session auto-expires** after 5 minutes

---

## Security Model
- **End-to-end encryption:** Only sender and receiver can decrypt
- **Ephemeral keys:** New keys for every session
- **No file or key storage** on server
- **Integrity:** SHA-256 hash per chunk
- **Zero-knowledge:** Server never sees file contents or keys

---

## Features
- Single/multiple file and folder support (browser limits apply)
- Drag & drop, real-time progress, speed, and ETA
- 6-digit code, QR, or link pairing
- Resume support (best-effort, browser dependent)
- Mobile-optimized, accessible UI (WCAG 2.1 AA)
- Clear error messages, offline detection

---

## Deployment & Infrastructure


---

## Deployment Guide

### Frontend (Vercel)
1. Go to [Vercel](https://vercel.com/) and sign in with GitHub.
2. Click "New Project" and import your fluxdrop repo.
3. Set the project root to `fluxdrop-web`.
4. Add environment variables from `.env.local` (TURN credentials, signaling URL).
5. Deploy! Vercel provides automatic HTTPS and global CDN.

### Backend (Railway)
1. Go to [Railway](https://railway.app/) and sign in with GitHub.
2. Create a new project and link your repo.
3. Set the project root to `fluxdrop-server`.
4. Add environment variables from `.env` (REDIS_URL, PORT).
5. Deploy. Railway provides a public WebSocket endpoint.

### Redis (Upstash)
1. Go to [Upstash](https://upstash.com/) and create a free Redis database.
2. Copy the Redis URL and set it as `REDIS_URL` in your backend `.env` and Railway project.
3. Upstash is serverless and has a generous free tier.

### TURN (Metered.ca)
1. Sign up at [Metered.ca](https://metered.ca/) for a free TURN/STUN account.
2. Copy your TURN credentials and add them to `.env.local` for the frontend.
3. Metered.ca provides 50GB/month relay bandwidth for free.

---

## Redis Session Store Integration

FluxDrop uses Upstash Redis for ephemeral session management. See the backend documentation for details:

- [Redis Session Store Integration (Backend)](../fluxdrop-server/REDIS.md)

---

## Documentation & Links
- [API & Protocol](./API.md)
- [Architecture](./ARCHITECTURE.md)
- [Security Model](./SECURITY.md)
- Demo: https://fluxdrop.app (when deployed)
- GitHub: https://github.com/yourusername/fluxdrop

---

**Philosophy:** Be the best at one thing—instant, private file transfer.

## Performance & Reliability
- **App load:** < 2s
- **WebRTC setup:** < 5s
- **LAN speed:** > 50 Mbps
- **P2P success:** > 90%
- **Session auto-expires:** 5 minutes idle
- **Fallback:** TURN relay if P2P fails
- **Resume:** Continue from last chunk (if possible)

---

## Known Limitations
- **Browser:** Safari lacks folder upload; all browsers ~2GB memory/file limit
- **Network:** Symmetric NAT/firewalls may require TURN relay
- **Design:** No transfer history (privacy), no resumption after browser close

---

## What FluxDrop Will Never Be
- Cloud storage or backup
- Social/messaging platform
- Analytics/tracking
- AI-powered or feature-bloated

---

## Quick Start (Development)
```bash
git clone https://github.com/yourusername/fluxdrop.git
cd fluxdrop/fluxdrop-web
npm install
npm run dev
# Visit http://localhost:3000
```
- Backend: `cd fluxdrop/fluxdrop-server && npm install && npm run dev`
- Add TURN/Redis credentials in `.env.local` and `.env`

---

## Documentation & Links
- [API & Protocol](./API.md)
- [Architecture](./ARCHITECTURE.md)
- [Security Model](./SECURITY.md)
- Demo: https://www.fluxdrop.app (when deployed)
- GitHub: https://github.com/yourusername/fluxdrop

---
 
**Philosophy:** Be the best at one thing—instant, private file transfer.
