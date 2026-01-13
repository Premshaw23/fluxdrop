# Redis Session Store Integration (Backend)

FluxDrop uses Upstash Redis as an ephemeral session store for secure, scalable, and stateless signaling. This enables instant, collision-free session code generation and robust session lifecycle management.

## How It Works
- **Session Code Reservation:**
  - When a sender requests a new session, the backend reserves a 6-digit code in Redis using a key like `reserved:123456` (type: STRING, value: 'reserved').
  - This ensures no two sessions can use the same code at the same time.
- **Session Data Storage:**
  - When the session is created, a new Redis hash is stored at `session:123456` with metadata (createdAt, expiresAt, hasReceiver).
  - The original reservation key is left to expire naturally or is deleted during cleanup.
- **Session Expiry:**
  - Both reservation and session keys are set with a TTL (5 minutes by default).
  - Expired sessions are cleaned up automatically by Redis and periodically by the backend.
- **No File or Key Storage:**
  - Only ephemeral session metadata is stored. No file data or encryption keys are ever written to Redis.

## Redis Key Structure
- `reserved:<code>` — Used for code reservation (STRING, TTL)
- `session:<code>` — Used for session metadata (HASH, TTL)

## Example Session Lifecycle
1. **Code Generation:**
   - `SETNX reserved:123456 "reserved"` (if returns 1, code is reserved)
   - `EXPIRE reserved:123456 300`
2. **Session Creation:**
   - `HSET session:123456 createdAt <ts> expiresAt <ts> hasReceiver false`
   - `EXPIRE session:123456 300`
3. **Receiver Joins:**
   - `HSET session:123456 hasReceiver true`
4. **Session Cleanup:**
   - On expiry or disconnect, both `reserved:123456` and `session:123456` are deleted

## Why This Design?
- **Prevents Redis WRONGTYPE errors:** Reservation and session data never conflict.
- **Stateless and scalable:** No sticky sessions or in-memory state required for code uniqueness.
- **Safe for concurrent users:** No race conditions or code collisions.
- **Production-ready:** Works with Upstash, Redis Cloud, or self-hosted Redis.

## Configuration
- Set `REDIS_URL` in your backend `.env` and Railway project.
- Upstash free tier is sufficient for most use cases.

---

For more details, see the backend code in `fluxdrop-server/src/session.ts`.
