/**
 * LLM narrator.
 *
 * Implements the same contract as the template narrator — reasoning strings and
 * outreach copy — but with a model writing the prose. It runs as a *second pass*
 * over cases the engine has already decided, not inside the engine loop, for two
 * reasons:
 *
 *   1. better-sqlite3 is synchronous and the batch runs inside one transaction.
 *      An await cannot go there.
 *   2. More importantly, it keeps the decision and the description of the
 *      decision strictly separate. The model sees what was decided and explains
 *      it. It cannot change what was chosen, when, or over which channel — those
 *      are already rows in the database by the time this runs.
 *
 * One request per case, not per audit entry: the whole case goes in and every
 * reasoning string plus every message comes back together. That is ~80 calls for
 * the batch instead of ~600, and it lets each explanation refer to the ones
 * around it instead of being written blind.
 *
 * Two providers, same prompt and same schema:
 *   groq      (default) — free tier, OpenAI-compatible, strict JSON schema
 *   anthropic          — set LLM_PROVIDER=anthropic
 */

import { formatIst } from '../lib/time.js';
import { BUCKETS } from './classifier.js';
import { ACTION_LABELS } from './matrix.js';
import { POLICY } from '../lib/taxonomy.js';

export const PROVIDER = (process.env.LLM_PROVIDER || 'groq').toLowerCase();
export const MERCHANT_NAME = process.env.MERCHANT_NAME || 'Trellis';

/**
 * Defaults per provider. On Groq only the gpt-oss and qwen families support
 * strict JSON schema — a llama model here would silently fall back to prose
 * and every case would fail to parse.
 */
const DEFAULT_MODEL = { groq: 'openai/gpt-oss-120b', anthropic: 'claude-opus-5' };
export const MODEL = process.env.LLM_MODEL || DEFAULT_MODEL[PROVIDER] || DEFAULT_MODEL.groq;

/**
 * Groq's free tier caps tokens per minute, not requests (8k TPM, 1000 RPM at
 * time of writing). Parallelism cannot buy throughput against a token ceiling —
 * it only turns a steady stream into bursts that trip the limit — so Groq runs
 * one at a time and the caller paces by token budget instead.
 */
export const DEFAULT_CONCURRENCY = PROVIDER === 'groq' ? 1 : 6;

/**
 * How many completion tokens this case actually needs.
 *
 * A flat ceiling is what broke the first Groq run: the limit counts requested
 * completion tokens toward the per-minute budget, so asking for 8k on a case
 * that needs 2k spent the entire minute's allowance before the prompt was even
 * counted. Size the ask to the work.
 */
export function completionBudget({ auditCount, messageCount }) {
  const estimate = 200 + auditCount * 160 + messageCount * 380;
  return Math.min(Math.max(estimate, 600), 4000);
}

/** Rough token count. Only needs to be good enough to pace a rate limiter. */
export const estimateTokens = (text) => Math.ceil(text.length / 4);

/** Provider-neutral. Groq's strict mode needs every key required and no extras. */
export const NARRATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    audit: {
      type: 'array',
      description: 'One entry for every audit entry given, in the same order.',
      items: {
        type: 'object',
        properties: {
          sequence: { type: 'integer', description: 'the audit entry sequence number' },
          reasoning: {
            type: 'string',
            description: 'Two or three sentences of plain English explaining this decision.',
          },
        },
        required: ['sequence', 'reasoning'],
        additionalProperties: false,
      },
    },
    messages: {
      type: 'array',
      description: 'One entry for every intervention whose channel is not "none".',
      items: {
        type: 'object',
        properties: {
          sequence: { type: 'integer', description: 'the intervention sequence number' },
          subject: { type: 'string', description: 'Email subject. Empty string for SMS/WhatsApp.' },
          body: { type: 'string', description: 'The message exactly as the customer receives it.' },
        },
        required: ['sequence', 'subject', 'body'],
        additionalProperties: false,
      },
    },
  },
  required: ['audit', 'messages'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are the audit-and-communications layer of an automated revenue recovery agent for ${MERCHANT_NAME}, an Indian business collecting subscription payments and B2B invoices in INR.

A deterministic rules engine has ALREADY made every decision on the case you are given: the root cause, which intervention to run, on which channel, in which tone, and when. Those decisions are settled and recorded. Your job is only to explain them and to write the customer-facing copy.

Never contradict, second-guess, or propose an alternative to a decision you are shown. If a decision looks odd to you, explain the reasoning that supports it as recorded.

## Writing the audit reasoning

Each reasoning string is read by a compliance auditor reconstructing why the agent acted. Write two or three sentences of specific, plain English. Refer to the actual facts of this case — the decline code, the amount, the customer's history, the timing — not generic statements that would fit any case. No jargon, no bullet points, no headings.

Accuracy rules, in order of importance:

1. Restate only what the given facts say. Do not infer a cause, motive, or consequence that is not written there. Watch for facts that say an option was *considered and rejected* — describe it as rejected, never as the thing that was done. If the facts say salary alignment was rejected and a plain back-off used instead, do not write that the retry was timed around the customer's salary.
2. Never write a number that is not in the facts you were given. In particular, never invent or repeat probabilities, percentages, confidence scores, or estimated chances — an auditor reading "95% confidence" or "a 63% chance of success" will reasonably ask where the number came from. Describe certainty in words, using the wording given.
3. Never refer to "the model", "the LLM", or any scoring internals. The reader cares what the recovery agent did and why.
4. An outcome never "matches" or "confirms" an expectation. A retry that failed simply failed.
5. Write plainly about what the recovery agent did. Do not open with "This decision" or "The agent".

## Policy you must reflect accurately

- At most ${POLICY.MAX_ATTEMPTS_PER_CASE} interventions per case, then the case stops and goes to a human.
- No outreach during quiet hours (${POLICY.QUIET_HOURS_LABEL}), evaluated in the customer's own timezone. Silent retries are exempt because they notify nobody.
- If a customer has opted out or raised a dispute, the agent must never retry or message them again — on this case or any future one. This is permanent and covers the customer, not the case.
- Every stop is logged with its reason.

## Writing the outreach copy

- SMS: under 160 characters, no emoji, no greeting flourish.
- WhatsApp: conversational, two short paragraphs at most, no emoji.
- Email: a subject line plus a body with a greeting and a sign-off from ${MERCHANT_NAME}.
- Always state the amount and what it is for. Always include the payment link exactly as given.
- Never threaten legal action, credit reporting, or service termination. For overdue B2B invoices the strongest register available to you is "we are escalating this to your account manager" — firm and factual, never menacing.
- Never blame the customer for a bank-side decline. Say plainly that it happens and what fixes it.
- No exclamation marks. No "Dear Valued Customer". Write like a competent person at a company the customer already pays.

Return one reasoning string for every audit entry given, and one message for every intervention that has a channel other than "none". Silent retries send nothing — omit them from messages. Respond with JSON only.`;

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export async function makeClient() {
  if (PROVIDER === 'anthropic') {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    return { kind: 'anthropic', client: new Anthropic() };
  }
  const { default: Groq } = await import('groq-sdk');
  return { kind: 'groq', client: new Groq({ apiKey: process.env.GROQ_API_KEY }) };
}

export function credentialsPresent() {
  return PROVIDER === 'anthropic'
    ? Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
    : Boolean(process.env.GROQ_API_KEY);
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/** Shape one case into the facts the model needs, and nothing more. */
export function buildCasePayload({ caseRow, customer, attempt, subscription, invoice, audit, interventions }) {
  // A live case that minted a real Razorpay link hands the model that URL, so
  // the copy it writes is directly payable. Everything else keeps the synthetic
  // path, which is what the seeded book has always been narrated with.
  const link = caseRow?.payment_link_url
    || `${MERCHANT_NAME.toLowerCase()}.in/p/${attempt.id.replace('pay_', '')}`;

  return {
    merchant: MERCHANT_NAME,
    customer: {
      name: customer.name,
      segment: customer.segment,
      reliability_score: customer.reliability_score,
      preferred_channel: customer.preferred_channel,
      salary_day: customer.salary_day,
      opted_out_at: customer.opted_out_at ? formatIst(customer.opted_out_at) : null,
      disputed_at: customer.disputed_at ? formatIst(customer.disputed_at) : null,
    },
    failure: {
      amount_inr: attempt.amount_inr,
      decline_code: attempt.decline_code,
      gateway_message: attempt.gateway_message,
      gateway_attempts_before_us: attempt.attempt_number,
      failed_at: formatIst(attempt.created_at),
      item: subscription?.plan_name ?? invoice?.invoice_number ?? null,
      invoice_due_at: invoice ? formatIst(invoice.due_at) : null,
    },
    diagnosis: {
      root_cause: caseRow.root_cause,
      root_cause_label: BUCKETS[caseRow.root_cause]?.label,
      what_it_means: BUCKETS[caseRow.root_cause]?.summary,
      // Qualitative, not numeric. A narrator handed 0.95 will write "95%
      // confidence" into an audit trail no matter what the rules say — the
      // reliable fix is not to hand it the number.
      certainty: caseRow.root_cause_confidence >= 0.9
        ? 'the decline code states this cause directly'
        : caseRow.root_cause_confidence >= 0.7
          ? 'the decline code strongly implies this cause'
          : 'inferred — the issuer gave no specific reason',
    },
    final_status: caseRow.status,
    closure_reason: caseRow.closure_reason,
    payment_link: link,
    audit_entries_to_explain: audit.map((a) => ({
      sequence: a.sequence,
      event_type: a.event_type,
      decision_recorded: a.decision,
      // The template reasoning is the factual record of what happened,
      // not prose to imitate.
      facts: a.reasoning_text,
      at: formatIst(a.created_at),
    })),
    interventions_needing_copy: interventions
      .filter((i) => i.channel !== 'none')
      .map((i) => ({
        sequence: i.sequence,
        action: ACTION_LABELS[i.action_type] ?? i.action_type,
        action_type: i.action_type,
        channel: i.channel,
        tone: i.tone,
        scheduled_for: formatIst(i.scheduled_for),
        outcome: i.outcome,
      })),
  };
}

export const shapeOf = (payload) => ({
  auditCount: payload.audit_entries_to_explain.length,
  messageCount: payload.interventions_needing_copy.length,
});

export const userMessage = (payload) =>
  'Explain every decision on this recovery case, and write the outreach copy.\n\n' +
  '```json\n' + JSON.stringify(payload, null, 2) + '\n```';

// ---------------------------------------------------------------------------
// Narration
// ---------------------------------------------------------------------------

/** Narrate one case. Throws on failure; the caller keeps the template text. */
export async function narrateCase({ kind, client }, payload) {
  return kind === 'anthropic'
    ? narrateAnthropic(client, payload)
    : narrateGroq(client, payload);
}

async function narrateGroq(client, payload) {
  const request = {
    model: MODEL,
    temperature: 0.4,
    max_completion_tokens: completionBudget(shapeOf(payload)),
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage(payload) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'case_narration', strict: true, schema: NARRATION_JSON_SCHEMA },
    },
  };
  // gpt-oss models emit reasoning tokens that also count against the budget.
  // The decisions are already made; there is nothing here to reason hard about.
  if (MODEL.startsWith('openai/gpt-oss')) request.reasoning_effort = 'low';

  const res = await client.chat.completions.create(request);

  const text = res.choices?.[0]?.message?.content;
  if (!text) throw new Error('empty completion');
  return { parsed: validate(JSON.parse(text)), usage: normaliseUsage(res.usage) };
}

async function narrateAnthropic(client, payload) {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: completionBudget(shapeOf(payload)),
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMessage(payload) }],
    output_config: {
      format: { type: 'json_schema', schema: NARRATION_JSON_SCHEMA, name: 'case_narration' },
    },
  });

  const block = res.content.find((b) => b.type === 'text');
  if (!block) throw new Error('no text block in response');
  return { parsed: validate(JSON.parse(block.text)), usage: normaliseUsage(res.usage) };
}

/**
 * Trust nothing structurally. Strict schema mode is a strong guarantee about
 * shape, not about the model returning an entry for every sequence we asked
 * about — the caller only writes rows it gets back, so a short answer degrades
 * to partial narration rather than corrupting the trail.
 */
function validate(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('response was not an object');
  const audit = Array.isArray(obj.audit) ? obj.audit : [];
  const messages = Array.isArray(obj.messages) ? obj.messages : [];
  if (!audit.length) throw new Error('no audit reasoning returned');
  return {
    audit: audit.filter((a) => Number.isInteger(a?.sequence) && typeof a?.reasoning === 'string'),
    messages: messages.filter((m) => Number.isInteger(m?.sequence) && typeof m?.body === 'string'),
  };
}

const normaliseUsage = (u = {}) => ({
  input: u.prompt_tokens ?? u.input_tokens ?? 0,
  output: u.completion_tokens ?? u.output_tokens ?? 0,
  cached: u.cache_read_input_tokens ?? 0,
});

export { SYSTEM_PROMPT };
