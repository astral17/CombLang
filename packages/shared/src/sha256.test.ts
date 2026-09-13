import { describe, expect, test } from 'vitest';

import { sha256Utf8Hex } from './sha256.js';

async function subtleSha256Utf8Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('synchronous UTF-8 SHA-256', () => {
  test.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    ['Привет, мир 🌍', '28185ce8f8b46ad4e81e4c1ca69e8b3b676cbefc725f9a8b9007ba111198d4c5'],
  ])('matches the SHA-256 vector for %j', (value, expected) => {
    expect(sha256Utf8Hex(value)).toBe(expected);
  });

  test('is deterministic, lowercase, and equal to Web Crypto', async () => {
    const value = 'CombLang profile identity — deterministic UTF-8';
    const digest = sha256Utf8Hex(value);

    expect(digest).toBe(sha256Utf8Hex(value));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(await subtleSha256Utf8Hex(value));
  });
});
