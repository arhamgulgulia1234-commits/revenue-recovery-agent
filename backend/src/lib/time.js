/**
 * Time helpers pinned to IST.
 *
 * Quiet hours are a compliance rule about the *customer's* wall clock, not the
 * server's. Every timestamp is stored as a UTC ISO string; these helpers convert
 * to and from IST explicitly so behaviour never depends on the host timezone.
 * India has no DST, so a fixed +05:30 offset is exact.
 */

export const IST_OFFSET_MIN = 330;
const MIN = 60000;

/** Wall-clock parts of an instant, as seen in IST. */
export function toIstParts(instant) {
  const ms = instant instanceof Date ? instant.getTime()
    : typeof instant === 'number' ? instant
    : new Date(instant).getTime();
  const shifted = new Date(ms + IST_OFFSET_MIN * MIN);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(), // 0 = Sunday
  };
}

export const istHour = (instant) => toIstParts(instant).hour;

/** Turn an IST wall-clock reading into the UTC instant it refers to. */
export function istToUtcMs(year, month, day, hour = 0, minute = 0, second = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, second) - IST_OFFSET_MIN * MIN;
}

/** Same instant, moved to the given IST hour on the same IST day. */
export function atIstHour(instant, hour, minute = 0) {
  const p = toIstParts(instant);
  return istToUtcMs(p.year, p.month, p.day, hour, minute);
}

/** "29 Aug 2026, 9:18 PM IST" — for message copy and the audit trail. */
export function formatIst(instant) {
  return new Date(instant).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }) + ' IST';
}

export const iso = (instant) => new Date(instant).toISOString();
