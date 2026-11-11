import { createHash, randomBytes } from 'node:crypto';
import { sign, verify } from 'hono/jwt';

// A login opens a session, which lasts while the app keeps using it. The app holds
// two tokens for it:
// - An access token: a JWT signed with SESSION_SECRET (HS256) that the app sends as
//   "Authorization: Bearer <token>". It names the session, which must still exist,
//   so logging out ends it at once. It lasts an hour.
// - A refresh token: a random value that gets the app a new pair once the access
//   token runs out. Only its hash is stored, and each use replaces it.

export const ACCESS_TOKEN_LIFETIME_SECONDS = 60 * 60;

export interface AccessToken {
  token: string;
  expiresAt: Date;
}

/** Who a valid access token is for. The session is null for a token from before sessions. */
export interface TokenClaims {
  userId: number;
  sessionId: number | null;
}

export async function createAccessToken(secret: string, userId: number, sessionId: number): Promise<AccessToken> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expires = issuedAt + ACCESS_TOKEN_LIFETIME_SECONDS;
  const token = await sign({ sub: String(userId), sid: sessionId, iat: issuedAt, exp: expires }, secret, 'HS256');
  return { token, expiresAt: new Date(expires * 1000) };
}

const ID = /^\d{1,10}$/;

/** The user and session in a valid, unexpired token, or null for anything else. */
export async function readAccessToken(secret: string, token: string): Promise<TokenClaims | null> {
  try {
    // verify() checks exp only when it's present, so a token without one is refused here.
    const { sub, sid, exp } = await verify(token, secret, 'HS256');
    if (typeof exp !== 'number' || typeof sub !== 'string' || !ID.test(sub)) return null;
    // Tokens from before sessions have no sid. They lasted 12 hours, so none outlive the deploy by more.
    if (sid === undefined) return { userId: Number(sub), sessionId: null };
    return Number.isInteger(sid) && (sid as number) > 0 ? { userId: Number(sub), sessionId: sid as number } : null;
  } catch {
    return null;
  }
}

/** 256 random bits, URL-safe. */
export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The value stored instead of the refresh token. It's random enough that a fast hash is safe here. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}
