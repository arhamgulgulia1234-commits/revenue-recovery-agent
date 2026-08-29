/**
 * Claude narrator.
 *
 * Implements the same contract as the template narrator — reasoning strings and
 * outreach copy — but with Claude writing the prose. It runs as a *second pass*
 * over cases the engine has already decided, not inside the engine loop, for two
 * reasons:
 *
 *   1. better-sqlite3 is synchronous and the batch runs inside one transaction.
 *      An await cannot go there.
 *   2. More importantly, it keeps the decision and the description of the
 *      decision strictly separate. Claude sees what was decided and explains it.
 *      It cannot change what was chosen, when, or over which channel — those are
 *      already rows in the database by the time this runs.
 *
 * One request per case, not per audit entry: the whole case goes in and every
 * reasoning string plus every message comes back together. That is ~80 calls for
 * the batch instead of ~600, and it lets each explanation refer to the ones
 * around it instead of being written blind.
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { formatIst } from '../lib/time.js';
import { BUCKETS } from './classifier.js';
import { ACTION_LABELS } from './matrix.js';
import { POLICY } from '../lib/taxonomy.js';

export const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
export const MERCHANT_NAME = process.env.MERCHANT_NAME || 'Trellis';

const NarrationSchema = z.object({
  audit: z.array(z.object({
    sequence: z.number().describe('the audit entry sequence number this reasoning is for'),
    reasoning: z.string().describe(
      'Two or three sentences of plain English explaining this decision to an auditor.'),
  })),
  messages: z.array(z.object({
    sequence: z.number().describe('the intervention sequence number this message is for'),
    subject: z.string().describe('Email subject line. Empty string for SMS and WhatsApp.'),
    body: z.string().describe('The message body exactly as the customer would receive it.'),
  })),
});

/**
 * The stable half of the prompt — policy, voice, and the output contract.
 * Kept byte-identical across every call so it caches; the per-case facts go in
 * the user turn, after the cache breakpoint.
 */
const SYSTEM_PROMPT = `You are the audit-and-communications layer of an automated revenue recovery agent for ${MERCHANT_NAME}, an Indian business collecting subscription payments and B2B invoices in INR.

A deterministic rules engine has ALREADY made every decision on the case you are given: the root cause, which intervention to run, on which channel, in which tone, and when. Those decisions are settled and recorded. Your job is only to explain them and to write the customer-facing copy.

Never contradict, second-guess, or propose an alternative to a decision you are shown. If a decision looks odd to you, explain the reasoning that supports it as recorded.

## Writing the audit reasoning

Each reasoning string is read by a compliance auditor reconstructing why the agent acted. Write two or three sentences of specific, plain English. Refer to the actual facts of this case — the decline code, the amount, the customer's history, the timing — not generic statements that would fit any case. No jargon, no bullet points, no headings. Do not begin with "This decision" or "The agent".

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

Return one reasoning string for every audit entry given, and one message for every intervention that has a channel other than "none". Silent retries send nothing — omit them from messages.`;

export function makeClient() {
  return new Anthropic();
}

/** Shape one case into the facts Claude needs, and nothing more. */
export function buildCasePayload({ caseRow, customer, attempt, subscription, invoice, audit, interventions }) {
  const link = `${MERCHANT_NAME.toLowerCase()}.in/p/${attempt.id.replace('pay_', '')}`;

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
      confidence: caseRow.root_cause_confidence,
    },
    final_status: caseRow.status,
    closure_reason: caseRow.closure_reason,
    payment_link: link,
    audit_entries_to_explain: audit.map((a) => ({
      sequence: a.sequence,
      event_type: a.event_type,
      decision_recorded: a.decision,
      // The template reasoning is passed as the factual record of what happened,
      // not as prose to imitate.
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

/**
 * Narrate one case. Returns null on any failure so the caller keeps the
 * template text — a narration outage must never take the demo down.
 */
export async function narrateCase(client, payload, { signal } = {}) {
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content:
        'Explain every decision on this recovery case, and write the outreach copy.\n\n' +
        '```json\n' + JSON.stringify(payload, null, 2) + '\n```',
    }],
    output_config: { format: zodOutputFormat(NarrationSchema) },
  }, { signal });

  return { parsed: response.parsed_output, usage: response.usage };
}

export { SYSTEM_PROMPT, NarrationSchema };
