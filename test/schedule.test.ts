import { describe, expect, it } from 'vitest';
import { dueReminderDay, isValidTime, isValidTimeZone, localClock } from '../src/schedule.js';

describe('localClock', () => {
  it('gives the local day and minute in a time zone', () => {
    const now = new Date('2026-11-10T03:15:00Z');

    expect(localClock(now, 'America/Costa_Rica')).toEqual({ day: '2026-11-09', minutes: 21 * 60 + 15 });
    expect(localClock(now, 'Asia/Tokyo')).toEqual({ day: '2026-11-10', minutes: 12 * 60 + 15 });
    expect(localClock(new Date('2026-11-10T06:00:00Z'), 'America/Costa_Rica').minutes).toBe(0); // Midnight is 0, not 24:00.
  });
});

describe('dueReminderDay', () => {
  const at = (iso: string) => new Date(iso);

  it.each([
    ['just before the time', '2026-11-10T17:59:00Z', null],
    ['at the time', '2026-11-10T18:00:00Z', '2026-11-10'],
    ['2 hours 59 minutes after', '2026-11-10T20:59:00Z', '2026-11-10'],
    ['3 hours after', '2026-11-10T21:00:00Z', null],
  ])('for 12:00 in Costa Rica: %s', (_name, iso, day) => {
    expect(dueReminderDay(at(iso), '12:00', 'America/Costa_Rica')).toBe(day);
  });

  it('counts a reminder that runs past midnight as the day it was set for', () => {
    expect(dueReminderDay(at('2026-11-11T06:30:00Z'), '23:00', 'America/Costa_Rica')).toBe('2026-11-10'); // 00:30
    expect(dueReminderDay(at('2026-01-01T06:30:00Z'), '23:00', 'America/Costa_Rica')).toBe('2025-12-31');
  });

  it('follows daylight saving time', () => {
    // New York is UTC-4 in summer and UTC-5 in winter, so 08:00 there moves in UTC.
    expect(dueReminderDay(at('2026-07-01T12:00:00Z'), '08:00', 'America/New_York')).toBe('2026-07-01');
    expect(dueReminderDay(at('2026-12-01T12:00:00Z'), '08:00', 'America/New_York')).toBeNull();
    expect(dueReminderDay(at('2026-12-01T13:00:00Z'), '08:00', 'America/New_York')).toBe('2026-12-01');
  });
});

describe('setting checks', () => {
  it.each([
    ['08:30', true],
    ['23:59', true],
    ['24:00', false],
    ['8:30', false],
    ['08:60', false],
  ])('accepts %j as a time: %s', (value, valid) => {
    expect(isValidTime(value)).toBe(valid);
  });

  it.each([
    ['America/Costa_Rica', true],
    ['Europe/Madrid', true],
    ['UTC', true],
    ['Mars/Olympus_Mons', false],
    ['', false],
  ])('accepts %j as a time zone: %s', (value, valid) => {
    expect(isValidTimeZone(value)).toBe(valid);
  });
});
