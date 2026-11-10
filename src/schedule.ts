// When each user's daily reminder is due. The cron job runs every 15 minutes and
// sends a reminder once per local day, at or soon after the user's chosen time.

/** How long after the chosen time a reminder can still go out, if runs were missed. */
export const CATCH_UP_MINUTES = 180;

export const MAX_PHRASES_PER_DAY = 5;

export function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function isValidTimeZone(value: string): boolean {
  if (!value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The local day (YYYY-MM-DD) and minute of the day at `now` in a time zone. */
export function localClock(now: Date, timeZone: string): { day: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function previousDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
}

/**
 * The local day whose reminder is due at `now`, or null if none is. A reminder is
 * due from its time until CATCH_UP_MINUTES later, which can run past midnight.
 */
export function dueReminderDay(now: Date, reminderTime: string, timeZone: string): string | null {
  const { day, minutes } = localClock(now, timeZone);
  const [hours, mins] = reminderTime.split(':').map(Number);
  const sinceToday = minutes - (hours * 60 + mins);
  if (sinceToday >= 0) return sinceToday < CATCH_UP_MINUTES ? day : null;
  return sinceToday + 24 * 60 < CATCH_UP_MINUTES ? previousDay(day) : null;
}
