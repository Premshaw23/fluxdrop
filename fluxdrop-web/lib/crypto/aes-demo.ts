// fluxdrop-web/lib/crypto/aes-demo.ts
// Example: AES-256-GCM encryption and decryption
import { generateECDHKeyPair, deriveSharedSecret, encryptAESGCM, decryptAESGCM } from './crypto';

export async function demoAESGCM() {
  // Generate a key (simulate ECDH shared secret)
  const { privateKey, publicKey } = await generateECDHKeyPair();
  const key = await deriveSharedSecret(privateKey, publicKey);

  // Data to encrypt
  const encoder = new TextEncoder();
  const data = encoder.encode('Hello, FluxDrop!');
  const iv = window.crypto.getRandomValues(new Uint8Array(12));

  // Encrypt
  const encrypted = await encryptAESGCM(key, data.buffer, iv);
  // Decrypt
  const decrypted = await decryptAESGCM(key, encrypted, iv);
  const decoded = new TextDecoder().decode(decrypted);

  return { encrypted, decrypted, decoded };
}
