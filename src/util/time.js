// Time helpers. All timestamps in the DB are stored as Unix epoch MILLISECONDS.

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * Resolve a named period into a { since, until, label } window ending "now".
 * Supported: day, week, month, year, all.
 */
export function resolvePeriod(period = 'week') {
  const now = Date.now();
  switch (period) {
    case 'day':
      return { since: now - DAY, until: now, label: 'past 24 hours' };
    case 'week':
      return { since: now - 7 * DAY, until: now, label: 'past 7 days' };
    case 'month':
      return { since: now - 30 * DAY, until: now, label: 'past 30 days' };
    case 'year':
      return { since: now - 365 * DAY, until: now, label: 'past 365 days' };
    case 'all':
      return { since: 0, until: now, label: 'all time' };
    default:
      return { since: now - 7 * DAY, until: now, label: 'past 7 days' };
  }
}

/** Human-friendly duration from milliseconds, e.g. "3h 12m". */
export function formatDuration(ms) {
  if (!ms || ms < 0) ms = 0;
  const totalMinutes = Math.floor(ms / MINUTE);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(' ');
}
