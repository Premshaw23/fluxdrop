# FluxDrop Architecture

## System Diagram

```
┌─────────────┐                    ┌─────────────┐
│  Browser A  │  WebSocket Signal  │  Browser B  │
│  (Sender)   │◄──────────────────►│ (Receiver)  │
└──────┬──────┘                    └──────┬──────┘
       │                                  │
       │  ┌──────────────────────────┐   │
       └─►│  Signaling Server        │◄──┘
          │  (Session matching)      │
          └──────────────────────────┘
       │                                  │
       │        WebRTC P2P Connection     │
       ├══════════════════════════════════┤
       │     (Encrypted file data)        │
       │                                  │
       │  ┌──────────────────────────┐   │
       └─►│  TURN Relay (fallback)   │◄──┘
          │  (When P2P fails)        │
          └──────────────────────────┘
```

## Key Components
- **Frontend:** Next.js, React, Zustand, Tailwind
- **Backend:** Node.js, ws, Upstash Redis
- **Signaling:** WebSocket, ephemeral session
- **P2P:** WebRTC, TURN fallback
- **Crypto:** ECDH, AES-GCM, SHA-256

## Security
- End-to-end encrypted
- No file/key storage on server
- Session auto-expires

## Deployment
- Frontend: Vercel
- Backend: Railway
- Redis: Upstash
- TURN: Metered.ca

---

For more, see API.md and SECURITY.md.
