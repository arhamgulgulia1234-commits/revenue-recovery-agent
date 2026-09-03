/**
 * Phone numbers, normalised to E.164.
 *
 * E.164: a leading '+', a country code, then the subscriber number — no spaces,
 * no dashes, no parentheses, at most 15 digits. It is what Razorpay wants for a
 * payment link's contact, and its error for a malformed number is far enough
 * from the cause to be worth catching here instead.
 *
 * Indian numbers are the common case and the common mistake: people type the
 * ten digits they dial locally, or paste '091', or a number with the spaces
 * their contacts app shows. `normalise` accepts those and returns E.164, and
 * refuses anything it cannot read unambiguously rather than guessing.
 */

/** Digits, and a '+' only in the first position. */
const clean = (raw) => String(raw ?? '').trim().replace(/[\s()\-.]/g, '');

const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || '91';

export class InvalidPhone extends Error {}

/**
 * @param {string} raw   as typed
 * @returns {string}     E.164, e.g. '+919876543210'
 * @throws {InvalidPhone}
 */
export function normalisePhone(raw) {
  let s = clean(raw);
  if (!s) throw new InvalidPhone('Give a phone number.');

  // 00 is the international prefix in much of the world; '+' is what E.164 wants.
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  // A bare Indian mobile, as typed into a local handset: 10 digits, or 11 with
  // the domestic trunk '0'. Only assume a country code when the shape is
  // unmistakable — a 12-digit string is already '91' + number and needs no help.
  else if (/^0\d{10}$/.test(s)) s = `+${DEFAULT_COUNTRY_CODE}${s.slice(1)}`;
  else if (/^[6-9]\d{9}$/.test(s)) s = `+${DEFAULT_COUNTRY_CODE}${s}`;
  else if (!s.startsWith('+')) s = `+${s}`;

  if (!/^\+[1-9]\d{7,14}$/.test(s)) {
    throw new InvalidPhone(
      `"${raw}" is not a phone number I can send to. Use international format, ` +
      'e.g. +919876543210.');
  }
  return s;
}

/** True if `raw` is already usable, without throwing. */
export function isValidPhone(raw) {
  try { normalisePhone(raw); return true; } catch { return false; }
}

/**
 * Mask for anywhere a number is shown but does not need to be read in full.
 * Keeps the country code and the last two digits: +9198XXXXXX10.
 */
export function maskPhone(e164) {
  const s = String(e164 ?? '');
  if (s.length < 7) return s;
  return `${s.slice(0, 5)}${'X'.repeat(Math.max(0, s.length - 7))}${s.slice(-2)}`;
}
