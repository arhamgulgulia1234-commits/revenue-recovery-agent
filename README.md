# AI Revenue Recovery

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

**Why this split.** The engine has to run *headless* — `npm run simulate` pushes
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
npm run demo      # reset + seed the synthetic book (+ run the engine, once built)
npm run dev       # backend :4000 + frontend :3000
```

Open <http://localhost:3000>.

| Script | What it does |
|---|---|
| `npm run dev` | Backend and frontend together |
| `npm run seed` | Generate the synthetic at-risk book (~80 failures) |
| `npm run reset` | Drop and recreate every table |
| `npm run simulate` | Run the recovery engine over all open failures |
| `npm run demo` | `reset` + `seed` + `simulate` — a clean demo from scratch |

Copy `.env.example` to `.env` to set `ANTHROPIC_API_KEY`. The engine falls back
to deterministic templates when it is unset, so the demo always runs.

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

Claude writes **(a)** the plain-English reasoning on each audit entry and
**(b)** the outreach message copy, in the right tone for the channel.

Root-cause classification and the intervention matrix are **plain rules**. A
recovery decision that touches someone's money should be deterministic,
reproducible, and explainable without re-running a model. The LLM explains and
communicates the decision; it does not make it.

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
| `recovery_cases` | The agent's unit of work: root cause, status, attempts used, closure reason |
| `intervention_logs` | Every action taken: type, channel, tone, message text, outcome |
| `promises_to_pay` | Promised date and amount, and whether it was honoured |
| `audit_entries` | One row per decision, with reasoning text and its source (`llm` / `template`) |

Schema: [`backend/src/db/schema.sql`](backend/src/db/schema.sql).

---

## Synthetic data

`backend/src/data/generator.js` produces a realistic book of at-risk revenue,
driven by a **seeded PRNG** — every run generates the identical dataset, so demo
numbers never move between runs.

Current seed (`SEED=20260829`) yields:

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

## Status

- [x] Project scaffold, SQLite schema, dev scripts
- [x] Synthetic data generator + seeded, reproducible dataset
- [x] Portfolio API + at-risk dashboard view
- [ ] Decision engine — classifier, intervention matrix, stopping rules, outcome simulator
- [ ] LLM audit reasoning + outreach copy generation
- [ ] Case list, case timeline, and stopped-case compliance views
- [ ] Full batch run, targeting a realistic 35–55% recovery rate
