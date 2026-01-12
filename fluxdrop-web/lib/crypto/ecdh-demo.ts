// fluxdrop-web/lib/crypto/ecdh-demo.ts
// Example: ECDH key generation and shared secret derivation
import {
  generateECDHKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedSecret
} from './crypto';

export async function demoECDH() {
  // Alice generates key pair
  const aliceKeys = await generateECDHKeyPair();
  // Bob generates key pair
  const bobKeys = await generateECDHKeyPair();

  // Exchange public keys
  const alicePubRaw = await exportPublicKey(aliceKeys.publicKey);
  const bobPubRaw = await exportPublicKey(bobKeys.publicKey);

  const aliceImportedBobPub = await importPublicKey(bobPubRaw);
  const bobImportedAlicePub = await importPublicKey(alicePubRaw);

  // Derive shared secrets
  const aliceSecret = await deriveSharedSecret(aliceKeys.privateKey, aliceImportedBobPub);
  const bobSecret = await deriveSharedSecret(bobKeys.privateKey, bobImportedAlicePub);

  // Both secrets should be equivalent (but are CryptoKey objects)
  return { aliceSecret, bobSecret };
}
