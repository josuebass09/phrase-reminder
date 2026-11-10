import { createHash, randomBytes } from 'node:crypto';

export const INVITE_LIFETIME_DAYS = 7;

/** 128 random bits, URL-safe, so the code can go straight into a link. */
export function newInviteCode(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * The value stored instead of the code. The code is random enough that a fast
 * hash is safe here, unlike with passwords.
 */
export function hashInviteCode(code: string): string {
  return createHash('sha256').update(code).digest('base64url');
}
