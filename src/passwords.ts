import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// scrypt ships with Node and is built for passwords: every guess costs time and memory.
const COST = { N: 16_384, r: 8, p: 1 };
const KEY_LENGTH = 64;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

/** Why a new password can't be used, or null if it can. */
export function checkNewPassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters`;
  return null;
}

function derive(password: string, salt: Buffer, cost: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, cost, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** Stored as "scrypt$N$r$p$salt$key", so the cost can rise later without breaking existing hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key, ...rest] = stored.split('$');
  if (scheme !== 'scrypt' || rest.length > 0 || !salt || !key) return false;
  try {
    const expected = Buffer.from(key, 'base64');
    const actual = await derive(password, Buffer.from(salt, 'base64'), { N: Number(n), r: Number(r), p: Number(p) });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false; // Unusable cost parameters.
  }
}

let dummy: Promise<string> | undefined;

/**
 * A hash no password matches. Checking it for an unknown email takes as long as a
 * real check, so response times don't reveal which emails have an account.
 */
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(32).toString('base64'));
  return dummy;
}
