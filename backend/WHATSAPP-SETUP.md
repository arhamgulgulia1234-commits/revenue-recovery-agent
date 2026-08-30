# Sending real WhatsApp messages (Twilio Sandbox)

Everything below is a one-time setup. Until it's done the app runs exactly as
before — live cases still open and still park on a real response window, their
messages just sit in the outbox marked *held* instead of going out. Nothing is
lost while you're setting up; press dispatch afterwards and they send.

---

## 1. Twilio account

Sign up at **[twilio.com/try-twilio](https://www.twilio.com/try-twilio)**. The free
trial is enough — no card, no upgrade. Verify your email and phone when asked.

From **[console.twilio.com](https://console.twilio.com)**, on the dashboard under
**Account Info**, copy two values:

| Value | Looks like |
|---|---|
| **Account SID** | `AC` followed by 32 hex characters |
| **Auth Token** | 32 hex characters (click to reveal) |

The Auth Token is a password. It goes in `.env`, which is gitignored, and it is
never logged or returned by any endpoint.

## 2. The WhatsApp Sandbox

In the Console go to **Messaging → Try it out → Send a WhatsApp message**.

That page shows two things you need:

- **The sandbox number** — a shared Twilio number, usually `+1 415 523 8886`
- **Your join code** — two words, shown as `join <something-something>`

## 3. Join from your phone — the step everything depends on

**On the phone you want the messages to arrive on**, open WhatsApp, start a chat
with the sandbox number, and send exactly:

```
join <your-code>
```

Twilio replies to confirm. **This is required.** Twilio will not deliver to a
number that has not done it, and the API still returns success when it refuses —
the message is simply accepted and dropped. If a send "works" and nothing
arrives, this is almost always why.

> **It lapses.** The opt-in expires after **72 hours of inactivity**. If messages
> stop arriving after a few days, send the join code again.

Each person who wants to receive test messages does this from their own phone.

## 4. Configure the app

Add to `.env` in the repo root:

```bash
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token_here
TWILIO_WHATSAPP_FROM=+14155238886       # the sandbox number, E.164, no "whatsapp:"
TWILIO_SANDBOX_JOIN_CODE=your-join-code # just the code, used for error messages
```

Restart the backend.

## 5. Check it works, smallest thing first

```bash
cd backend
npm run whatsapp:test -- +919876543210
```

No case, no engine, no database — just Twilio. If this fails, the problem is the
credentials or the join step, not the recovery pipeline. If it succeeds and
nothing arrives on the phone, go back to step 3.

Confirm the app agrees:

```bash
curl -s localhost:4000/api/live/config | jq .twilio
```

## 6. Run a real case

```bash
curl -s -X POST localhost:4000/api/live/cases \
  -H 'Content-Type: application/json' \
  -d '{
    "customerName": "Your Name",
    "phone": "+919876543210",
    "segment": "consumer",
    "declineCode": "expired_card",
    "amountInr": 2499
  }' | jq .
```

The response tells you what actually happened: the root cause the classifier
picked, the message the narrator wrote, the Twilio message SID, and when the
response window closes.

### What to expect

- **The message arrives within seconds.** It's the real generated copy, not a
  template with your name pasted in.
- **The case sits in `awaiting_response`** for 3 days. It does not fail. This is
  Stage 1's fix — a case with no reply waits rather than burning its attempts.
- **The failure is dated a few hours in the past.** Deliberate: the matrix
  schedules a card-update reminder some hours after the failure, so the failure
  is back-dated by exactly that offset to make the first message due now. The
  response says `backdatedByHours`.

### Choosing inputs

| Field | Notes |
|---|---|
| `phone` | `+919876543210`, `9876543210`, `+91 98765 43210` all work. Must be a phone that joined the sandbox. |
| `segment` | `consumer`, `prosumer` or `smb`. **Not `enterprise`** — the matrix routes enterprise to email unconditionally, so it would never send. The API rejects it and says so. |
| `declineCode` | `expired_card` is the clearest first test. Avoid `technical_error` and `gateway_timeout`: those classify as *transient* and correctly start with a **silent** gateway retry, so no message is sent. `GET /api/live/config` flags this per code as `sendsMessageFirst`. |
| `amountInr` | Anything from ₹1. |

## 7. Watching it

```bash
curl -s localhost:4000/api/live/cases | jq .          # live cases + outbox depth
curl -s localhost:4000/api/live/cases/case_0081 | jq . # one case, full audit trail
curl -s localhost:4000/api/scheduler | jq .            # what's waiting, and until when
npm run tick                                           # force a scheduled check now
```

Twilio's own view of what happened to a message: **Monitor → Logs → Messaging**
in the Console. The `provider_message_id` on the intervention is the SID to look
for.

## Testing attempt 2 without waiting 3 days

Attempt 2 fires when the response window expires. Shorten the window in `.env`:

```bash
RESPONSE_WINDOW_DAYS=0.01   # ~15 minutes; fractional values are fine
```

Restart, open a case, wait, and the scheduler sends attempt 2 on its own — no
button. Note that **attempt 3 is routed to email by the matrix**, so on a live
case it is recorded as `skipped` rather than delivered. That's honest: this build
doesn't send email.

Put the value back to `3` when you're done.

## Clearing test cases

```bash
npm run live:reset
```

Removes only live cases and the rows they created. The 80-case demo book is
untouched — no reseed, no re-simulate.

## If something goes wrong

| Symptom | Cause |
|---|---|
| `delivery.held: "Twilio not configured"` | Missing env vars. The message is kept, not lost — fix `.env`, restart, then `curl -X POST localhost:4000/api/live/dispatch`. |
| Send succeeds, nothing arrives | The phone hasn't joined the sandbox, or the 72-hour opt-in lapsed. Send `join <code>` again. |
| `Authentication Error - invalid username` | Wrong `TWILIO_ACCOUNT_SID` or `TWILIO_AUTH_TOKEN`. |
| `outside WhatsApp's 24-hour session window` | WhatsApp only allows free-form messages within 24h of the recipient's last inbound message. Message the sandbox from your phone, then retry. |
| `is not a WhatsApp sender on this account` | `TWILIO_WHATSAPP_FROM` isn't the sandbox number. |
| `delivery_status: "skipped"` | The matrix chose email for this attempt, or the case has no phone. Not an error. |

## What this does not do yet

- The payment link in the message is still a placeholder (`trellis.in/p/…`).
  Stage 3 replaces it with a real Razorpay test-mode payment link.
- Nothing detects payment yet. The case can only close by the window expiring.
  Stage 4 adds the Razorpay webhook.
