/**
 * Does Twilio actually work, before any of the rest of it is involved?
 *
 *   npm run whatsapp:test -- +919876543210
 *
 * Deliberately the smallest possible thing: no case, no engine, no database.
 * When a live case fails to deliver, this separates "Twilio is misconfigured or
 * the phone never joined the sandbox" from "something in the recovery pipeline
 * is wrong", which are very different problems with the same symptom.
 */
import '../lib/env.js';
import { sendWhatsApp, configSummary, isConfigured } from '../lib/twilio.js';
import { normalisePhone, InvalidPhone } from '../lib/phone.js';

const cfg = configSummary();

console.log('\n  Twilio WhatsApp Sandbox\n');
console.log(`  Account       ${cfg.accountSid ?? '—'}`);
console.log(`  From          ${cfg.from ?? '—'}`);
console.log(`  Join code     ${cfg.joinCode ?? '— (set TWILIO_SANDBOX_JOIN_CODE)'}`);

if (!isConfigured()) {
  console.error(`\n  ✗ Not configured. Missing: ${cfg.missing.join(', ')}`);
  console.error('    Add them to .env — see .env.example for where each value comes from.\n');
  process.exit(1);
}

const raw = process.argv[2];
if (!raw) {
  console.error('\n  ✗ Give a phone number: npm run whatsapp:test -- +919876543210\n');
  process.exit(1);
}

let to;
try {
  to = normalisePhone(raw);
} catch (err) {
  if (err instanceof InvalidPhone) { console.error(`\n  ✗ ${err.message}\n`); process.exit(1); }
  throw err;
}

const body = process.argv[3]
  || 'Test message from the payment recovery agent. If you can read this, the Twilio sandbox is wired up correctly.';

console.log(`  To            ${to}`);
console.log(`\n  Sending…`);

try {
  const r = await sendWhatsApp({ to, body });
  console.log(`\n  ✓ Twilio accepted it`);
  console.log(`    SID      ${r.sid}`);
  console.log(`    Status   ${r.status}`);
  console.log(`\n  "Accepted" is not "delivered". If nothing arrives within a minute, the`);
  console.log(`  usual cause is that this phone has not sent "join ${cfg.joinCode ?? '<code>'}" to`);
  console.log(`  ${cfg.from} on WhatsApp, or that the 72-hour opt-in has lapsed.`);
  console.log(`  The message's real fate is at console.twilio.com → Monitor → Logs → Messaging.\n`);
} catch (err) {
  console.error(`\n  ✗ ${err.message}\n`);
  process.exit(1);
}
