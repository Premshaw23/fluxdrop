import { describe, it, expect } from 'vitest';
import { demoECDH } from '../lib/crypto/ecdh-demo';
import { demoAESGCM } from '../lib/crypto/aes-demo';

// These tests require a browser-like crypto API (jsdom)
describe('Crypto Demos', () => {
  it('ECDH shared secrets should be equivalent', async () => {
    const { aliceSecret, bobSecret } = await demoECDH();
    // Compare exported raw keys
    const aliceRaw = await crypto.subtle.exportKey('raw', aliceSecret);
    const bobRaw = await crypto.subtle.exportKey('raw', bobSecret);
    expect(Buffer.from(aliceRaw)).toEqual(Buffer.from(bobRaw));
  });

  it('AES-GCM encrypt/decrypt roundtrip', async () => {
    const { decoded } = await demoAESGCM();
    expect(decoded).toBe('Hello, FluxDrop!');
  });
});
