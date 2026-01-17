# FluxDrop Signaling Server

The backbone of FluxDrop's peer discovery and session management.

## 🚀 Features
- **Discovery**: Handles 6-digit code generation and peer pairing.
- **Signaling**: Relays WebRTC offer/answer/candidates between peers.
- **Session Management**: Uses Redis for ephemeral storage of active sessions.
- **Validation**: Strict message schema validation using Zod.

## 🛠 Tech Stack
- **Runtime**: Node.js (TypeScript)
- **Communications**: `ws` (WebSocket)
- **Storage**: Redis (via `ioredis`)
- **Validation**: `Zod`
- **Testing**: `Vitest`

## 📦 Setup & Run

### 1. Environment Variables
Create a `.env` file:
```env
PORT=8080
REDIS_URL=your_redis_url
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Run Server
```bash
# Development
npm run dev

# Production
npm run build
npm start
```

## 📕 Documentation
- [Redis Integration](./REDIS.md)
