# REVYN

An agent that recovers revenue at risk — failed payments, failed subscription
mandates, and overdue B2B invoices. It detects the failure, diagnoses the root
cause, decides the right intervention, executes it, tracks the outcome, and
enforces compliant stopping rules — leaving a plain-English audit trail behind
every decision.

Built for the **Razorpay AI Buildathon — Track 3: AI Revenue Recovery**.

---

## Architecture: monorepo (Express backend + Next.js frontend)

Two workspaces rather than a single Next.js app with API routes:

| | |
|---|---|
| `backend/` | Express 5 + SQLite (`better-sqlite3`). The recovery engine, the data model, the batch simulator. |
| `frontend/` | Next.js 16 (App Router) + React 19 + Tailwind v4. The dashboard. |

**Why this split.** The engine has to run *headless* — a batch run pushes
the whole synthetic book through detection → diagnosis → intervention → outcome
in one batch, with no browser involved. That is the demo, and it is also how the
numbers get sanity-checked. Wrapping that in Next.js API routes would have meant
booting a web framework to run a batch job, and would have blurred the line
between "the agent" and "the screen showing the agent". Keeping the engine a
plain Node module means it stays deterministic, testable, and auditable on its
own terms. `npm run dev` still starts both halves with one command, so the
demo ergonomics are unchanged.

**Storage** is a local SQLite file (`backend/data/recovery.sqlite`), created on
first run. No external service, nothing to provision — it runs fully offline.

---

## Quickstart

```bash
npm install
npm run demo      # reset + seed the synthetic book
npm run dev       # backend :4000 + frontend :3000
```

Open <http://localhost:3000>, or <http://localhost:3000/simulate> to run a
failure of your own through the agent live. To deploy, see
**[DEPLOY.md](DEPLOY.md)**.

| Script | What it does |
|---|---|
| `npm run dev` | Backend and frontend together |
| `npm run seed` | Generate the synthetic at-risk book (~80 failures) |
| `npm run reset` | Drop and recreate every table |
| `npm run verify` | Independently re-check every compliance rule against stored rows |
| `npm run case` | Print full decision histories for a few representative cases |
| `npm run score` | Inspect the priors, example scores, needs-attention list and calibration |
| `npm run narrate` | Rewrite the reasoning and message copy with an LLM (`-- --dry-run` to preview the prompt) |
| `npm run narrate:export` | Freeze the narration to `narration.json` so deploys get it without API calls |
| `npm run compare` | Side-by-side against the naive blind-retry baseline |
| `npm run demo` | `reset` + `seed` + `simulate` + `verify` — a clean run from scratch |

Copy `.env.example` to `.env` and set `GROQ_API_KEY` (free at
[console.groq.com/keys](https://console.groq.com/keys)) to enable LLM narration.
The engine falls back to deterministic templates when no key is set, so the demo
always runs either way.

---

## The recovery loop

1. **Detect** — a payment, mandate, or invoice fails.
2. **Diagnose** — map the gateway decline code to a root cause.
3. **Decide** — pick the intervention from root cause × retry count × customer value.
4. **Execute** — generate the outreach copy and simulate a probabilistic outcome.
5. **Track** — recovered / still failed / promise-to-pay.
6. **Stop** — enforce the compliance rules, and log why.

### Root cause → intervention

| Root cause | Intervention |
|---|---|
| `insufficient_funds` | Retry timed near the customer's likely salary-credit date |
| `expired_card` | Send an update-payment-method link |
| `do_not_honor` / `card_declined` | Suggest an alternate method (UPI instead of card) |
| `technical_error` / `gateway_timeout` | Immediate short-delay auto-retry |
| `invalid_cvv` / `authentication_failed` | Payment link prompting re-entry — never a silent retry |
| `abandoned_checkout` | Nudge, optionally with an incentive |
| `invoice_overdue` | Escalating reminders: polite → firmer → escalation flag. Never threatening. |

### Compliance rules (enforced, not implied)

- **Max 3 attempts** per case.
- **No outreach during quiet hours** — 9:00 PM to 8:00 AM, evaluated in the
  *customer's* timezone (IST), never the server's.
- **Immediate permanent stop** on dispute or opt-out. No further retries or
  messages, ever.
- **Every stop is logged with a reason**, and surfaced in a dedicated
  "stopped" view on the dashboard.

### Where the LLM is used — and where it deliberately isn't

The model writes **(a)** the plain-English reasoning on each audit entry and
**(b)** the outreach message copy, in the right tone for the channel.

It runs as a **second pass** over cases the engine has already decided
(`npm run narrate`), never inside the decision loop. By the time it runs, the
action, channel, tone and timing are already rows in the database — it explains
them and cannot change them. Any case that fails keeps its template text, so a
narration outage degrades the prose rather than breaking the run.

Provider is swappable via `LLM_PROVIDER`: `groq` (default, free tier,
`openai/gpt-oss-120b`) or `anthropic` (`claude-opus-5`). Same prompt, same
strict JSON schema, same contract.

Root-cause classification and the intervention matrix are **plain rules**. A
recovery decision that touches someone's money should be deterministic,
reproducible, and explainable without re-running a model. The LLM explains and
communicates the decision; it does not make it.

---

## Live simulator — `/simulate`

A control panel for demoing the agent on a case you invent on the spot. Type a
customer, segment, amount, decline code and which attempt this is; optionally
flag the customer as opted-out or disputed. Press run and the case is worked
**live**, one stage at a time:

| | Stage | Who decides |
|---|---|---|
| 1 | Root cause | `classifier.js` — a lookup table |
| 2 | Recovery likelihood | `scorer.js` + priors counted off the batch |
| 3 | Recovery action | `matrix.js`, screened by `policy.js` — **can stop the case here** |
| 4 | Response | the LLM narrator — the only stage that calls a model |
| 5 | Outcome | `outcomes.js`, rolled against the same probability tables |

The stage order is the argument. Stages 1–3 are pure rules; by the time the
model runs at stage 4 the decision is already a row in a database, and the panel
labels each stage with where its text came from so that is checkable rather than
claimed.

**It reuses the engine rather than mirroring it.** `engine/live-run.js` imports
the same classifier, matrix, gates, scorer, narrator and outcome tables the
batch uses, and calls `createRunner().runCase()` — the actual agent loop. It
assembles inputs and reads results back out; it re-implements nothing. The
frontend holds no copy of any of it and only renders an event stream.

**Nothing is persisted.** The runner writes as it goes, so it is handed a
throwaway in-memory SQLite database with the same schema. The real book is read
for the priors and the customer roster, never written — a demo run cannot move
the dashboard's numbers.

Two details worth knowing before demoing it:

- **The failure is back-dated** (24 days, or 50 for an invoice). The agent
  schedules real interventions days apart — up to day 30 for an invoice — and
  stops at the first one not yet due. A failure stamped "just now" would always
  end at *scheduled, not yet due* and never reach an outcome.
- **The outcome is a fresh draw** each run, from the same tables as the batch.
  The same inputs will not always land the same way; the seed is shown on the
  final card.

The stopping rules are the thing it demonstrates best. Set the flag to **opted
out** or **disputed**, or the attempt to **cap reached**, and the run halts at
stage 3 with stages 4 and 5 visibly never running — no action chosen, no message
written, nothing sent. Streamed over SSE (`POST /api/simulate/stream`), so the
pause at stage 4 is the model call actually happening.

---

## Real payment links — the panel's second mode

The same panel has a **Real payment link** mode, and it is the opposite of the
simulated one in every respect that matters. It runs on `POST /api/live/cases`,
not the SSE stream.

| | Simulated | Real payment link |
|---|---|---|
| Database | throwaway, in-memory | the real book, `source = 'live'` |
| Failure timestamp | back-dated 24–50 days | now, unaltered |
| Payment link | synthetic text | a **real Razorpay test-mode link** |
| Outcome | rolled off `outcomes.js` | never invented — only Razorpay can close it |
| Afterwards | nothing to return to | a case id, and a status you can re-check |

**Nothing is transmitted, in either mode.** There is no messaging provider in
this build. `channel` on an intervention is the agent's *decision* — which
channel it would use, screened by quiet hours and the customer's preference —
and the copy it writes is shown on the timeline. The payment link is the one
artefact a customer could actually act on, which is why it is the only thing
that can close a live case.

**The link is minted before the case, not during it.** The runner is synchronous
— better-sqlite3 is, and every caller depends on that — so no HTTP call can
happen inside `runCase()`. Nor can the link be fetched afterwards: it has to
*exist before the copy that quotes it*. So `prepareLiveCase()` asks the matrix
what it will choose, and `mintForCase()` mints a link only if that first action
carries one. A case whose
first action is a silent retry mints nothing, which is correct: a link nobody is
sent is a link nobody pays. The decline-code dropdown labels each code `· link`
or `· silent retry` accordingly, read from the matrix rather than hardcoded.

**Settling is a pull, not a webhook.** *Check payment status* calls
`GET /v1/payment_links/:id`. A webhook would be right in production and wrong
here: it needs a public URL, a signing secret and a tunnel, and it fails silently
when any of the three is off. The trade is that payment is recorded when someone
asks rather than the instant it lands — which is exactly why **the case closes at
Razorpay's payment timestamp, not ours**. Pay at 14:02, check at 16:40, and the
case still closes at 14:02; otherwise every elapsed time on the dashboard would
quietly be wrong.

When Razorpay reports the link paid, the case goes to **recovered**, the
outreach it was parked on is resolved, and an audit entry is written with
`reasoning_source = 'system'`:

> Payment confirmed via Razorpay — case closed.

Pressing the button again re-reads the status and changes nothing else.

**Test keys only.** `rzp_live_…` is refused outright rather than warned about —
see `keyMode()` in `lib/razorpay.js`. Razorpay's own SMS and email notifications
are switched off on every link (`notify: {sms: false, email: false}`,
`reminder_enable: false`): the agent decides what to say, on which channel, at
which hour, under quiet-hours and opt-out rules, and a second uncontrolled
message from the gateway would sit outside all of them.

Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in `.env` — see `.env.example`
for where to get them and which test cards and UPI IDs actually work. Without
them the mode still opens real cases; they just carry the synthetic link text.

---

## Data model

```
customers ──┬── subscriptions ──┐
            └── invoices ───────┴── payment_attempts ── recovery_cases ──┬── intervention_logs
                                                                          ├── promises_to_pay
                                                                          └── audit_entries
```

| Table | Holds |
|---|---|
| `customers` | Identity, segment, reliability score, LTV, preferred channel, **opt-out / dispute flags** |
| `subscriptions` | Plan, amount, frequency, mandate type (UPI autopay / card / eNACH) |
| `invoices` | B2B invoices with issue date, due date, PO number |
| `payment_attempts` | The failure event: amount, decline code, gateway message, attempt number |
| `recovery_cases` | The agent's unit of work: root cause, status, attempts used, closure reason, and — on a live case — the Razorpay link, its last-known status and the real payment timestamp |
| `intervention_logs` | Every action taken: type, channel, tone, message text, outcome |
| `promises_to_pay` | Promised date and amount, and whether it was honoured |
| `audit_entries` | One row per decision, with reasoning text and its source (`llm` / `template`) |

Schema: [`backend/src/db/schema.sql`](backend/src/db/schema.sql).

---

## Synthetic data

`backend/src/data/generator.js` produces a realistic book of at-risk revenue,
driven by a **seeded PRNG** — every run generates the identical dataset, so demo
numbers never move between runs.

Dates are anchored to `SEED_NOW` (set in `.env`). Without it they follow the wall
clock, and the headline recovery rate drifts a point or two between runs as
scheduled interventions come due — pinning it makes the batch byte-identical,
which is what you want when a demo quotes specific numbers.

Current seed (`SEED=20260829`, `SEED_NOW=2026-08-29T18:00:00+05:30`) yields:

- 60 customers across consumer / prosumer / SMB / enterprise
- 76 subscriptions, 27 B2B invoices
- **80 failed payments, ₹81,91,320 at risk**
- 5 customers already opted out or in dispute — so the hard-stop rule visibly
  fires on the very first engine run

Realism is not uniform noise. Decline codes are conditioned on the customer:
chronically unreliable payers bounce for insufficient funds, reliable ones fail
on expired cards. Failures cluster on billing days and business hours, but ~24%
land inside quiet hours — which is exactly what makes the quiet-hours rule worth
enforcing.

```
insufficient_funds      13  ██████████
authentication_failed    9  ███████
do_not_honor             8  ██████
expired_card             8  ██████
abandoned_checkout       7  █████
card_declined            6  █████
invalid_cvv              6  █████
technical_error          4  ███
gateway_timeout          4  ███
invoice_overdue         15  ███████████
```

---

## Results

A full batch over the 80-case book (`SEED=20260829`):

```
Revenue at risk       ₹81,91,320
Revenue recovered     ₹22,45,150
Recovery rate         46.3% of cases · 27.4% of value
Avg days to recovery  3.0

Recovered  37    Still retrying  15    Stopped  28
```

Recovery rate by root cause:

| Root cause | Cases | Recovered | Rate |
|---|---|---|---|
| User input error | 15 | 10 | 67% |
| Bank-side block | 14 | 7 | 50% |
| Timing issue | 13 | 6 | 46% |
| Transient | 8 | 5 | 63% |
| Instrument issue | 8 | 3 | 38% |
| Drop-off | 7 | 2 | 29% |
| Receivable | 15 | 4 | 27% |

Value recovery (27%) sits well below case recovery (46%) because the large
enterprise invoices are the hardest to collect — they land on email, they need a
human approval chain, and five of them belong to customers the agent is forbidden
to contact. That gap is the honest shape of the problem, not a bug.

### Verified, not asserted

`npm run verify` re-derives every compliance claim straight from the stored rows
rather than trusting the engine's own bookkeeping:

```
✓ No case exceeds the 3-attempt cap
✓ attempts_used matches executed interventions on every case
✓ No intervention executed after a customer opted out or disputed
✓ Every case on a hard-stopped customer is closed
✓ No outreach sent during quiet hours (9:00 PM – 8:00 AM IST)
✓ Every stopped case has a closure reason
✓ Every stopped case has a case_stopped audit entry
✓ Every case has a root cause
✓ Every executed intervention has an outcome audit entry
✓ Every audit entry carries real reasoning text
✓ Recovered amounts are consistent with case status
✓ Silent retries send no message
```

---

## Recovery-likelihood scoring

Every case carries a 0–100% score for how likely it is to end up recovered,
built from patterns in the batch rather than a trained model — `scorer.js` is a
function you can read and tune by editing constants.

1. **Base** — a weighted blend of three empirical rates: root cause (0.45),
   attempts already failed (0.35), customer segment (0.20).
2. **Modifiers** — multiplicative adjustments for what population rates cannot
   see: this customer's own prior recoveries and failures, their reliability,
   and whether this amount is unusual for them.
3. **Overrides** — an opted-out or disputed customer scores 0, because the agent
   is forbidden to act, not because the money is uncollectable.

Every factor carries its own explanation, so a score is never a number without a
reason:

> *"43% — receivable failures recover 42% of the time (11 in the batch), and 2 of
> 3 attempts have already failed, where cases recover only 24% of the time.
> Adjusted up because they have recovered 1 previous case and their payment
> reliability is 0.86, which is strong."*

Rates are smoothed toward the global average with 5 pseudo-observations, so a
five-case bucket at 100% reports as 76% rather than pretending certainty.

**Two denominator choices matter more than the arithmetic.** Cases the agent was
never permitted to touch are excluded — they measure permission, not
recoverability. And in-progress cases stay in the denominator as not-recovered:
a case that recovers closes immediately while a failing one grinds through all
three attempts and stays open, so conditioning on "settled" reads 67% against a
true rate of 46%.

### Calibration

```
predicted     n    actual
40–50%       11      36%
50–60%       32      59%
60%+         23      61%

Overall predicted 57% vs actual 56%
Mean score, recovered 58% · not recovered 55% · separation 2.6 points
```

Aggregate calibration is good and the ranking is monotonic, but separation is
modest. That is expected rather than broken: scored at case-open, the attempt
factor is identical for every case, so 35% of the weight does no work. The score
earns its keep as attempts accumulate, where that factor swings 53% → 31% → 24%.
It is also in-sample — at 80 cases there is no held-out set.

---

## Status

- [x] Project scaffold, SQLite schema, dev scripts
- [x] Synthetic data generator + seeded, reproducible dataset
- [x] Decision engine — classifier, intervention matrix, stopping rules, outcome simulator
- [x] Audit trail with plain-English reasoning on every decision
- [x] Outreach copy per channel and tone
- [x] Recovery dashboard: at risk vs recovered, recovery rate, per-case status
- [x] Independent compliance verifier
- [x] Recovery-likelihood scoring with per-factor explanations
- [x] Needs-attention triage ranked by expected loss, and an insights panel
- [x] LLM narrator (Groq or Anthropic) as a second pass over decided cases
- [x] Case timeline drill-down with the full decision story
- [x] Live simulator — hand-enter a failure and watch the real pipeline work it stage by stage
- [ ] Dedicated stopped-case compliance view
- [x] Naive baseline comparison (46.3% vs 32.5%)
- [ ] Deploy — see [DEPLOY.md](DEPLOY.md)
