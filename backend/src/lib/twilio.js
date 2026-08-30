/**
 * Sending a WhatsApp message for real, through the Twilio Sandbox.
 *
 * The whole client is one form-encoded POST, so it is written against `fetch`
 * rather than pulling in the Twilio SDK — one fewer dependency, and the request
 * on the wire is visible in the code rather than three layers down in a vendor
 * library. Everything configurable comes from the environment; nothing here is
 * ever hardcoded, and the credentials are never logged.
 *
 * ## What the sandbox is
 *
 * Twilio will not let anyone send WhatsApp messages to arbitrary strangers. The
 * Sandbox is the test path: one shared Twilio number, and a phone may only
 * receive from it after that phone has explicitly opted in by messaging
 * `join <code>` to it. That opt-in is the reason this integration cannot
 * silently spam anyone, and it is also the single most common reason a send
 * "succeeds" and nothing arrives — see `JOIN_HINT`.
 *
 * ## The 24-hour window
 *
 * Outside 24 hours from the recipient's last inbound message, WhatsApp only
 * permits pre-approved template messages. The sandbox has no approved
 * templates, so a free-form send after that window is accepted by the API and
 * then silently dropped. Twilio reports this as error 63016 on the message
 * resource, which `describeError` translates rather than leaving as a number.
 */

/**
 * Overridable for two reasons: Twilio publishes regional edges (au1, ie1) that
 * some accounts must use, and pointing this at a local stub is the only way to
 * exercise the success path without sending a real message to a real person.
 */
const API_ROOT = () => process.env.TWILIO_API_ROOT || 'https://api.twilio.com/2010-04-01';

/** Read fresh each call so a .env edit does not need a restart to take effect. */
const config = () => ({
  accountSid: process.env.TWILIO_ACCOUNT_SID || '',
  authToken: process.env.TWILIO_AUTH_TOKEN || '',
  from: process.env.TWILIO_WHATSAPP_FROM || '',
  joinCode: process.env.TWILIO_SANDBOX_JOIN_CODE || '',
});

export class TwilioError extends Error {
  constructor(message, { status = null, code = null, retriable = false } = {}) {
    super(message);
    this.name = 'TwilioError';
    this.status = status;
    this.code = code;
    this.retriable = retriable;
  }
}

/** Which required settings are missing, if any. */
export function missingConfig() {
  const c = config();
  const missing = [];
  if (!c.accountSid) missing.push('TWILIO_ACCOUNT_SID');
  if (!c.authToken) missing.push('TWILIO_AUTH_TOKEN');
  if (!c.from) missing.push('TWILIO_WHATSAPP_FROM');
  return missing;
}

export const isConfigured = () => missingConfig().length === 0;

/**
 * Safe to serialise anywhere, including to the browser: the account SID is
 * truncated and the auth token never appears.
 */
export function configSummary() {
  const c = config();
  return {
    configured: isConfigured(),
    missing: missingConfig(),
    from: c.from || null,
    joinCode: c.joinCode || null,
    accountSid: c.accountSid ? `${c.accountSid.slice(0, 6)}…${c.accountSid.slice(-4)}` : null,
    joinHint: c.joinCode && c.from
      ? `Send "join ${c.joinCode}" on WhatsApp to ${c.from.replace('whatsapp:', '')} once, from the phone you want to receive messages on.`
      : null,
  };
}

/** `whatsapp:+1415...` — the channel prefix Twilio's WhatsApp API requires. */
const wa = (number) => {
  const s = String(number).trim();
  return s.startsWith('whatsapp:') ? s : `whatsapp:${s}`;
};

/**
 * Send one WhatsApp message.
 *
 * @param {{to:string, body:string, timeoutMs?:number}} args  `to` in E.164
 * @returns {Promise<{sid:string, status:string, to:string, from:string}>}
 * @throws {TwilioError}
 */
export async function sendWhatsApp({ to, body, timeoutMs = 15000 }) {
  const missing = missingConfig();
  if (missing.length) {
    throw new TwilioError(
      `Twilio is not configured — set ${missing.join(', ')} in .env`, { code: 'not_configured' });
  }
  if (!body || !String(body).trim()) {
    throw new TwilioError('Refusing to send an empty message.', { code: 'empty_body' });
  }

  const { accountSid, authToken, from } = config();
  const form = new URLSearchParams({ From: wa(from), To: wa(to), Body: String(body) });

  // Twilio has no server-side timeout that helps here; without this an unhealthy
  // connection would hold a scheduler tick open indefinitely.
  const abort = AbortSignal.timeout(timeoutMs);

  let res;
  try {
    res = await fetch(`${API_ROOT()}/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        // Basic auth, per Twilio's REST spec. Built here rather than put in a
        // URL so the token cannot end up in a redirect or a log line.
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
      signal: abort,
    });
  } catch (err) {
    // Network-level failure: worth another go on a later tick.
    throw new TwilioError(
      err.name === 'TimeoutError'
        ? `Twilio did not respond within ${timeoutMs / 1000}s`
        : `Could not reach Twilio: ${err.message}`,
      { code: 'network', retriable: true });
  }

  const payload = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new TwilioError(describeError(res.status, payload), {
      status: res.status,
      code: payload.code ?? null,
      // 429 is rate limiting and 5xx is Twilio's own trouble; both pass.
      // A 4xx is a bad request and will fail identically forever.
      retriable: res.status === 429 || res.status >= 500,
    });
  }

  return {
    sid: payload.sid,
    status: payload.status,
    to: payload.to,
    from: payload.from,
  };
}

/** Turn Twilio's numeric codes into something actionable. */
function describeError(status, payload) {
  const code = payload?.code;
  const base = payload?.message || `Twilio returned HTTP ${status}`;

  switch (code) {
    case 63007:
      return `${base} — TWILIO_WHATSAPP_FROM (${process.env.TWILIO_WHATSAPP_FROM}) is not a WhatsApp sender on this account. Use the sandbox number from Messaging → Try it out → Send a WhatsApp message.`;
    case 63015:
    case 63016:
      return `${base} — outside WhatsApp's 24-hour session window. The recipient must message the sandbox again (any text) before a free-form message can reach them.`;
    case 63018:
      return `${base} — the recipient has not joined the sandbox, or their opt-in has lapsed. ${configSummary().joinHint ?? 'Send the sandbox join code from that phone.'}`;
    case 21211:
      return `${base} — "${payload?.more_info ?? 'the To number'}" is not a valid phone number.`;
    case 20003:
      return `${base} — Twilio rejected the credentials. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.`;
    default:
      return code ? `${base} (Twilio code ${code})` : base;
  }
}
