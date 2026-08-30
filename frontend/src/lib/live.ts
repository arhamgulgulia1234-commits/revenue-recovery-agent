/**
 * Client for the live simulator's event stream.
 *
 * The run is a POST — it carries the form — which rules out EventSource, so the
 * response is read straight off `fetch` and split on the SSE record separator.
 * Each stage is handed to the caller the moment it arrives, which is the point:
 * the model call at stage 4 genuinely takes a few seconds, and the panel should
 * show that rather than hide it behind one long spinner.
 */

import { API_URL } from './api';

export type Segment = 'consumer' | 'prosumer' | 'smb' | 'enterprise';
export type HardStop = 'none' | 'opted_out' | 'disputed';
export type StageName = 'diagnose' | 'score' | 'decide' | 'respond' | 'outcome';

export type SimInput = {
  customerId: string | null;
  customerName: string;
  segment: Segment;
  amountInr: number;
  declineCode: string;
  attemptsUsed: number;
  hardStop: HardStop;
};

export type SimCustomer = {
  id: string; name: string; segment: string; reliability_score: number;
  preferred_channel: string; salary_day: number | null;
  opted_out_at: string | null; disputed_at: string | null; failed_attempts: number;
};

export type SimOptions = {
  customers: SimCustomer[];
  segments: Segment[];
  declineCodes: { code: string; label: string }[];
  policy: { MAX_ATTEMPTS_PER_CASE: number; QUIET_HOURS_LABEL: string };
  narrator: { provider: string; model: string; configured: boolean };
};

export type ScoreFactor = {
  name: string; kind: 'base' | 'modifier' | 'override'; detail: string;
  weight?: number; rate?: number; n?: number; value?: number;
  factor?: number; delta?: number;
};

export type MetaEvent = {
  type: 'meta';
  seed: number;
  now: string;
  customer: {
    id: string; name: string; segment: string; existing: boolean;
    reliability_score: number; preferred_channel: string; salary_day: number | null;
    opted_out_at: string | null; disputed_at: string | null;
  };
  failure: {
    amountInr: number; declineCode: string; declineLabel: string; gatewayMessage: string;
    failedAt: string; failedAtLabel: string; channel: string; item: string;
    invoiceDueAt: string | null; backdatedDays: number;
  };
  startingAttemptsUsed: number;
  maxAttempts: number;
  detection: string | null;
};

export type NarratorInfo = {
  provider: string; model: string; used: 'llm' | 'template'; note: string | null;
};

export type LiveEvent =
  | MetaEvent
  | { type: 'working'; stage: StageName; label: string }
  | {
      type: 'stage'; stage: 'diagnose'; rootCause: string; label: string;
      summary: string | null; confidence: number; reasoning: string | null; source: 'rules';
    }
  | {
      type: 'stage'; stage: 'score'; score: number; band: string; explanation: string;
      factors: ScoreFactor[]; isOverride: boolean;
      priors: {
        globalRate: number; sampleSize: number;
        rootCause: { rate: number; n: number } | null;
        segment: { rate: number; n: number } | null;
        attempt: { rate: number; n: number } | null;
      };
      source: 'rules';
    }
  | {
      type: 'stage'; stage: 'decide'; attemptNumber: number; maxAttempts: number;
      actionType: string | null; actionLabel: string | null; channel: string | null;
      tone: string | null; silent: boolean; scheduledFor: string | null;
      scheduledForLabel: string | null; reasoning: string;
      deferral: { reasoning: string; at: string } | null; source: 'rules';
    }
  | {
      type: 'stage'; stage: 'respond'; attemptNumber: number; narrator: NarratorInfo;
      reasoning: string; reasoningSource: 'llm' | 'template'; templateReasoning: string;
      channel: string | null; silent: boolean; message: string | null; source: 'llm';
    }
  | {
      type: 'stage'; stage: 'outcome'; attemptNumber: number; outcome: string | null;
      detail: string | null; reasoning: string; at: string | null; atLabel: string | null;
      source: 'simulated';
    }
  | { type: 'note'; event: string; reasoning: string; at: string }
  | {
      type: 'stopped'; atStage: 'decide' | 'final'; reason: string;
      kind: 'hard_stop' | 'attempt_cap' | 'sequence_exhausted' | null;
      label: string; reasoning: string | null; skipped: StageName[];
    }
  | {
      type: 'final'; status: string; closureReason: string | null;
      closureKind: 'hard_stop' | 'attempt_cap' | 'sequence_exhausted' | null;
      attemptsUsed: number; startingAttemptsUsed: number; amountAtRiskInr: number;
      recoveredInr: number; openedAt: string; closedAt: string | null;
      closedAtLabel: string | null; interventionsRun: number;
      promises: { promisedDate: string; promisedDateLabel: string; amountInr: number; fulfilled: boolean }[];
      seed: number;
    }
  | { type: 'error'; message: string; detail?: string }
  | { type: 'done' };

export async function fetchOptions(): Promise<SimOptions> {
  const res = await fetch(`${API_URL}/api/simulate/options`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load simulator options (${res.status})`);
  return res.json();
}

/** Run one case, yielding each stage as the server produces it. */
export async function* streamRun(input: SimInput, signal: AbortSignal): AsyncGenerator<LiveEvent> {
  const res = await fetch(`${API_URL}/api/simulate/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });

  // Input the engine refuses never opens a stream — it comes back as plain JSON.
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.message ?? `The simulator returned ${res.status}.`);
  }
  if (!res.body) throw new Error('This browser did not give us a readable stream.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Records are separated by a blank line; a chunk may hold several or half of one.
    let split: number;
    while ((split = buffer.indexOf('\n\n')) >= 0) {
      const record = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      if (!record.startsWith('data: ')) continue;
      yield JSON.parse(record.slice(6)) as LiveEvent;
    }
  }
}

export const CHANNEL_LABELS: Record<string, string> = {
  sms: 'SMS', whatsapp: 'WhatsApp', email: 'Email', voice: 'Voice', none: 'No message',
};

export const OUTCOME_DISPLAY: Record<string, { label: string; tone: 'good' | 'bad' | 'neutral' }> = {
  recovered: { label: 'Payment recovered', tone: 'good' },
  failed: { label: 'Attempt failed', tone: 'bad' },
  no_response: { label: 'No response', tone: 'bad' },
  promise_to_pay: { label: 'Promise to pay', tone: 'neutral' },
  suppressed: { label: 'Suppressed', tone: 'neutral' },
};

export const NOTE_LABELS: Record<string, string> = {
  promise_recorded: 'Promise to pay captured',
  promise_kept: 'Promise honoured',
  promise_broken: 'Promise broken',
};

/** Why a stop happened, said in full. The point of the panel is that this is legible. */
export const STOP_COPY: Record<string, string> = {
  customer_opted_out:
    'This customer opted out of contact before the failure happened. The agent takes no action at all — no retry, no message, not even a silent one. The opt-out attaches to the customer, not the case, so it covers every future failure too.',
  customer_disputed:
    'This customer has an open dispute. Any further debit attempt or collection message would be improper while it stands, so the agent stops and hands the case to a human.',
  max_attempts_reached:
    'The agent has spent its three interventions without recovering the money. The cap exists so it cannot pressure a customer indefinitely — the case is handed to a person rather than retried a fourth time.',
  opted_out_mid_recovery:
    'The customer opted out in response to an intervention. Contact ended immediately and permanently, on this case and every future one.',
  disputed_mid_recovery:
    'The customer raised a dispute in response to an intervention. All collection activity ended immediately.',
  sequence_exhausted:
    'Every intervention this root cause supports has been tried without recovery.',
};
