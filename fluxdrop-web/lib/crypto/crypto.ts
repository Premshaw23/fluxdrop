// fluxdrop-web/lib/crypto/crypto.ts
// Utility functions for ECDH key generation, AES-256-GCM encryption/decryption, and SHA-256

export async function generateECDHKeyPair() {
  return await window.crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    true,
    ['deriveKey', 'deriveBits']
  );
}

export async function exportPublicKey(key: CryptoKey): Promise<ArrayBuffer> {
  return await window.crypto.subtle.exportKey('raw', key);
}

export async function importPublicKey(raw: ArrayBuffer): Promise<CryptoKey> {
  return await window.crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

export async function deriveSharedSecret(privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> {
  return await window.crypto.subtle.deriveKey(
    {
      name: 'ECDH',
      public: publicKey,
    },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}


export async function encryptAESGCM(key: CryptoKey, data: ArrayBuffer, iv: BufferSource): Promise<ArrayBuffer> {
  return await window.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    key,
    data
  );
}


export async function decryptAESGCM(key: CryptoKey, data: ArrayBuffer, iv: BufferSource): Promise<ArrayBuffer> {
  return await window.crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    key,
    data
  );
}

export async function sha256(data: ArrayBuffer): Promise<ArrayBuffer> {
  return await window.crypto.subtle.digest('SHA-256', data);
}
