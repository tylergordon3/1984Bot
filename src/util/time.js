// Time helpers. All timestamps in the DB are stored as Unix epoch MILLISECONDS.

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** e.g. "Jul 24 – Jul 31, 2026" (or "Jul 31, 2025 – Jul 31, 2026" across years). */
export function formatDateRange(since, until) {
  const s = new Date(since);
  const u = new Date(until);
  const sameYear = s.getFullYear() === u.getFullYear();
  const sStr = s.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  const uStr = u.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `${sStr} – ${uStr}`;
}

/**
 * Resolve a named period into a { since, until, label, range } window ending "now".
 * `range` is the concrete calendar date range for display. Supported: day, week,
 * month, year, all.
 */
export function resolvePeriod(period = 'week') {
  const now = Date.now();
  const make = (since, label) => ({
    since,
    until: now,
    label,
    range: since === 0 ? 'all time' : formatDateRange(since, now),
  });
  switch (period) {
    case 'day':
      return make(now - DAY, 'past 24 hours');
    case 'week':
      return make(now - 7 * DAY, 'past 7 days');
    case 'month':
      return make(now - 30 * DAY, 'past 30 days');
    case 'year':
      return make(now - 365 * DAY, 'past 365 days');
    case 'all':
      return make(0, 'all time');
    default:
      return make(now - 7 * DAY, 'past 7 days');
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
