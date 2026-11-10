import { afterEach, describe, expect, it, vi } from 'vitest';
import { sign } from 'hono/jwt';
import { ACCESS_TOKEN_LIFETIME_SECONDS, createAccessToken, readAccessToken } from '../src/auth.js';

const SECRET = 'test-secret-that-is-long-enough-for-hs256';

afterEach(() => vi.useRealTimers());

describe('access tokens', () => {
  it('last 12 hours', () => {
    expect(ACCESS_TOKEN_LIFETIME_SECONDS).toBe(12 * 60 * 60);
  });

  it('carry the user id and report when they expire', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-10T12:00:00Z') });

    const { token, expiresAt } = await createAccessToken(SECRET, 42);

    expect(await readAccessToken(SECRET, token)).toBe(42);
    expect(expiresAt.toISOString()).toBe('2026-11-11T00:00:00.000Z');
  });

  it('stop working once 12 hours have passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-10T12:00:00Z') });
    const { token } = await createAccessToken(SECRET, 42);

    vi.setSystemTime(new Date('2026-11-10T23:59:59Z'));
    expect(await readAccessToken(SECRET, token)).toBe(42);
    vi.setSystemTime(new Date('2026-11-11T00:00:01Z'));
    expect(await readAccessToken(SECRET, token)).toBeNull();
  });

  it('reject a token signed with another secret', async () => {
    const { token } = await createAccessToken('another-secret-that-is-also-long-enough', 42);

    expect(await readAccessToken(SECRET, token)).toBeNull();
  });

  it('reject a token whose payload was changed', async () => {
    const { token } = await createAccessToken(SECRET, 42);
    const [header, , signature] = token.split('.');
    const payload = Buffer.from(JSON.stringify({ sub: '1', exp: 9_999_999_999 })).toString('base64url');

    expect(await readAccessToken(SECRET, `${header}.${payload}.${signature}`)).toBeNull();
  });

  it('reject an unsigned token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: '42', exp: 9_999_999_999 })).toString('base64url');

    expect(await readAccessToken(SECRET, `${header}.${payload}.`)).toBeNull();
  });

  it('reject a token without an expiry or a numeric user id', async () => {
    const noExpiry = await sign({ sub: '42' }, SECRET, 'HS256');
    const badSubject = await sign({ sub: 'admin', exp: 9_999_999_999 }, SECRET, 'HS256');

    expect(await readAccessToken(SECRET, badSubject)).toBeNull();
    expect(await readAccessToken(SECRET, noExpiry)).toBeNull();
  });

  it.each(['', 'garbage', 'a.b.c', 'v1.9999999999.signature'])('reject %j', async (token) => {
    expect(await readAccessToken(SECRET, token)).toBeNull();
  });
});
