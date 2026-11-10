import { describe, expect, it } from 'vitest';
import { createToken, TOKEN_LIFETIME_SECONDS, verifyToken } from '../src/auth.js';

const SECRET = 'test-secret';
const NOW = Date.UTC(2026, 10, 10);

describe('tokens', () => {
  it('accepts a token it created', () => {
    expect(verifyToken(SECRET, createToken(SECRET, NOW), NOW)).toBe(true);
  });

  it('accepts a token until it expires a year later', () => {
    const token = createToken(SECRET, NOW);
    const lifetime = TOKEN_LIFETIME_SECONDS * 1000;

    expect(verifyToken(SECRET, token, NOW + lifetime - 1000)).toBe(true);
    expect(verifyToken(SECRET, token, NOW + lifetime)).toBe(false);
  });

  it('rejects a token signed with another secret', () => {
    expect(verifyToken(SECRET, createToken('other-secret', NOW), NOW)).toBe(false);
  });

  it('rejects a token whose expiry was changed', () => {
    const [version, expires, signature] = createToken(SECRET, NOW).split('.');
    const extended = `${version}.${Number(expires) + 1_000_000}.${signature}`;

    expect(verifyToken(SECRET, extended, NOW)).toBe(false);
  });

  it.each([
    ['an empty string', ''],
    ['a session cookie value', 'ok'],
    ['too few parts', 'v1.123'],
    ['too many parts', 'v1.123.abc.def'],
    ['another version', 'v2.9999999999.abc'],
    ['a non-numeric expiry', 'v1.soon.abc'],
  ])('rejects %s', (_name, token) => {
    expect(verifyToken(SECRET, token, NOW)).toBe(false);
  });
});
