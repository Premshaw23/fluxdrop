# FluxDrop API Overview

## Signaling Server (WebSocket)
- **URL:** `ws://<server>:3001`
- **Pairing:** 6-digit code, QR, or link
- **Messages:**
  - `join`: { code }
  - `offer`/`answer`/`ice-candidate`: WebRTC signaling
  - `session-cancel`, `session-expire`, `error`

## File Transfer
- **Protocol:** WebRTC DataChannel
- **Chunking:** 1MB per chunk
- **Encryption:** AES-256-GCM, ECDH key exchange
- **Integrity:** SHA-256 per chunk

## Session Management
- **Session expires:** 5 minutes idle
- **No file or key storage on server**

---

# Architecture Overview

## Frontend
- Next.js 14, TypeScript, Tailwind CSS
- State: Zustand
- PWA: manifest, service worker

## Backend
- Node.js 20, ws, Zod, Upstash Redis
- Session store: ephemeral, Redis-backed

## Flow
1. User opens app, chooses send/receive
2. Sender gets code/QR, receiver enters code/scans
3. Signaling via WebSocket, ECDH key exchange
4. WebRTC P2P connection, encrypted file transfer
5. Session auto-expires, keys cleared

---

For details, see SECURITY.md and code in `lib/crypto/`, `lib/transfer/`, and `src/session.ts`.
