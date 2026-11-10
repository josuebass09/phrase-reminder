import { describe, expect, it } from 'vitest';
import { checkNewPassword, dummyHash, hashPassword, verifyPassword } from '../src/passwords.js';

describe('passwords', () => {
  it('match the password they were made from and nothing else', async () => {
    const stored = await hashPassword('correct horse battery staple');

    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('correct horse battery stapler', stored)).toBe(false);
    expect(stored).not.toContain('correct horse');
  });

  it('use a new salt each time', async () => {
    expect(await hashPassword('same password')).not.toBe(await hashPassword('same password'));
  });

  it.each([
    ['an empty value', ''],
    ['another scheme', 'bcrypt$2b$10$abc'],
    ['missing parts', 'scrypt$16384$8$1$c2FsdA=='],
    ['unusable cost parameters', 'scrypt$3$8$1$c2FsdA==$a2V5'],
  ])('never match %s', async (_name, stored) => {
    expect(await verifyPassword('anything', stored)).toBe(false);
  });

  it('provide a dummy hash that no password matches', async () => {
    expect(await verifyPassword('', await dummyHash())).toBe(false);
  });

  it('require new passwords of 12 to 200 characters', () => {
    expect(checkNewPassword('x'.repeat(11))).toBe('Use at least 12 characters');
    expect(checkNewPassword('x'.repeat(12))).toBeNull();
    expect(checkNewPassword('x'.repeat(201))).toBe('Use at most 200 characters');
  });
});
