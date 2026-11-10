import { sign, verify } from 'hono/jwt';

// Access tokens are JWTs signed with SESSION_SECRET (HS256), sent by the app as
// "Authorization: Bearer <token>". They aren't stored anywhere: a token works until
// it expires, and changing SESSION_SECRET invalidates every token at once.

export const ACCESS_TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;

export interface AccessToken {
  token: string;
  expiresAt: Date;
}

export async function createAccessToken(secret: string, userId: number): Promise<AccessToken> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expires = issuedAt + ACCESS_TOKEN_LIFETIME_SECONDS;
  const token = await sign({ sub: String(userId), iat: issuedAt, exp: expires }, secret, 'HS256');
  return { token, expiresAt: new Date(expires * 1000) };
}

/** The user id in a valid, unexpired token, or null for anything else. */
export async function readAccessToken(secret: string, token: string): Promise<number | null> {
  try {
    // verify() checks exp only when it's present, so a token without one is refused here.
    const { sub, exp } = await verify(token, secret, 'HS256');
    if (typeof exp !== 'number') return null;
    return typeof sub === 'string' && /^\d{1,10}$/.test(sub) ? Number(sub) : null;
  } catch {
    return null;
  }
}
