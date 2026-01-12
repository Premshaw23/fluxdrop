# Security Overview: FluxDrop Encryption Flow

## End-to-End Encryption Design

FluxDrop uses modern browser cryptography APIs to provide end-to-end encryption for all file transfers. The encryption flow is as follows:

### 1. ECDH Key Exchange
- Both sender and receiver generate an ephemeral ECDH (P-256) key pair in the browser.
- Each party exports their public key and exchanges it via the signaling server (public keys are never secret).
- Each party imports the peer's public key and derives a shared secret using ECDH.

### 2. AES-256-GCM Encryption
- The shared secret is used as an AES-256-GCM key for encrypting file chunks.
- Each file chunk is encrypted with a unique, random 12-byte IV (Initialization Vector).
- The IV is sent alongside each encrypted chunk.

### 3. Chunk Integrity (SHA-256)
- Before sending, the sender computes a SHA-256 hash of each encrypted chunk and sends the hash with the chunk.
- The receiver verifies the hash after decryption to ensure integrity.

### 4. Key Lifecycle
- ECDH and AES keys are kept in memory only for the duration of the transfer.
- Keys are securely cleared from memory after transfer completion or on any error.

### 5. Security Properties
- The signaling server never sees file contents or shared secrets.
- Only the two peers can decrypt the files.
- Integrity is guaranteed for every chunk; tampering is detected immediately.

## Threat Model
- **Confidentiality:** Files are never exposed to the server or network intermediaries.
- **Integrity:** Any modification to encrypted data is detected via SHA-256.
- **Forward Secrecy:** Each session uses new ephemeral keys; compromise of one session does not affect others.

## Implementation Notes
- All cryptography uses the Web Crypto API (subtle crypto).
- ECDH: P-256 curve, ephemeral keys.
- AES: 256-bit GCM mode, random IV per chunk.
- Hash: SHA-256, base64-encoded.

---

For more details, see `lib/crypto/crypto.ts` and the transfer logic in `lib/transfer/FileTransfer.ts`.
