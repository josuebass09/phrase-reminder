import { createHmac, timingSafeEqual } from 'node:crypto';

// Bearer tokens let the app on its own Railway domain call this API. Browsers treat
// two *.up.railway.app domains as different sites, so the session cookie doesn't
// reach this API from the app, and Safari blocks it outright.
//
// A token is "v1.<expiry in Unix seconds>.<HMAC of the first two parts>". There is
// nothing to look up: changing SESSION_SECRET invalidates every token at once.

const VERSION = 'v1';
export const TOKEN_LIFETIME_SECONDS = 60 * 60 * 24 * 365;

function signature(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createToken(secret: string, now = Date.now()): string {
  const expires = Math.floor(now / 1000) + TOKEN_LIFETIME_SECONDS;
  const payload = `${VERSION}.${expires}`;
  return `${payload}.${signature(secret, payload)}`;
}

export function verifyToken(secret: string, token: string, now = Date.now()): boolean {
  const [version, expires, given, ...rest] = token.split('.');
  if (rest.length > 0 || version !== VERSION || !/^\d{1,12}$/.test(expires ?? '') || !given) {
    return false;
  }
  const expected = Buffer.from(signature(secret, `${version}.${expires}`));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  return Number(expires) * 1000 > now;
}
