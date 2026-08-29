/**
 * Recovery-likelihood scoring.
 *
 * "Given where this case stands right now, how likely is it to end up recovered?"
 * Answered as a number between 0 and 100 with the arithmetic shown.
 *
 * ── How the score is built ────────────────────────────────────────────────────
 *
 *   1. BASE      A weighted blend of three empirical rates measured off the
 *                batch: root cause, customer segment, and how many attempts
 *                have already failed. Weights are in BLEND_WEIGHTS and sum to 1.
 *
 *   2. MODIFIERS Multiplicative adjustments for things specific to this
 *                customer that the population rates can't see — their own
 *                recovery history, their reliability, and whether this amount
 *                is unusual for them. Each is a factor near 1.0.
 *
 *   3. OVERRIDES Hard rules that ignore the arithmetic entirely. An opted-out
 *                customer scores 0 because the agent is forbidden to act, not
 *                because the money is unrecoverable.
 *
 * Every step returns its own explanation string, so the score is never a number
 * without a reason attached. To tune it, change the constants below — there is
 * nothing else to retrain.
 */

import { BUCKETS } from './classifier.js';

/** How much each population signal counts toward the base. Must sum to 1. */
export const BLEND_WEIGHTS = {
  rootCause: 0.45, // strongest signal — what broke largely determines fixability
  attempt: 0.35,   // each failed try is real evidence this one is hard
  segment: 0.20,   // weakest — segment mostly proxies for amount and channel
};

/** Multiplicative modifiers. Each entry is [factor, reason]. */
export const MODIFIERS = {
  // Prior cases this customer recovered, capped at 3 so one good payer
  // can't run away with the score.
  priorRecoveryStep: 0.12,
  priorFailureStep: 0.10,
  priorCap: 3,

  // reliability_score 0..1 mapped onto a gentle 0.88..1.12 band.
  reliabilitySpread: 0.12,

  // Amount relative to what this customer normally pays.
  largeAmountRatio: 3,
  largeAmountFactor: 0.82,
  smallAmountRatio: 0.5,
  smallAmountFactor: 1.06,
};

export const BANDS = [
  { min: 0.6, label: 'High', tone: 'high' },
  { min: 0.3, label: 'Medium', tone: 'medium' },
  { min: 0, label: 'Low', tone: 'low' },
];

export const band = (score) => BANDS.find((b) => score >= b.min);

/**
 * @param {object} args.caseRow      the case being scored
 * @param {object} args.customer     its customer
 * @param {object} args.priors       from buildPriors()
 * @param {object} args.history      this customer's entry from buildCustomerHistory()
 * @param {number} [args.attemptIndex] how many interventions have already failed.
 *                 Defaults to the case's own attempts_used. Pass 0 to ask
 *                 "what would we have predicted when this case opened?".
 * @returns {{score, band, explanation, factors, base}}
 */
export function scoreCase({ caseRow, customer, priors, history, attemptIndex }) {
  // Failed attempts so far. The priors only go to 2, but a case can sit at 3 —
  // clamp the lookup, report the real number.
  const failedSoFar = attemptIndex ?? caseRow.attempts_used ?? 0;
  const k = Math.min(failedSoFar, 2);
  const factors = [];

  // -- 3. Overrides first: no arithmetic can override a compliance stop -------
  if (customer.disputed_at || customer.opted_out_at) {
    const which = customer.disputed_at ? 'raised a dispute' : 'opted out of contact';
    return {
      score: 0,
      band: band(0),
      base: 0,
      factors: [{ name: 'hard_stop', kind: 'override', value: 0,
        detail: `Customer has ${which} — the agent is permanently barred from acting` }],
      explanation:
        `0% — not scoreable. This customer ${which}, so the agent may never retry or ` +
        `message them again. The money may well be collectable; the agent just isn't allowed to try.`,
    };
  }

  // -- 1. Base: weighted blend of population rates ---------------------------
  const rc = priors.byRootCause[caseRow.root_cause];
  const seg = priors.bySegment[customer.segment];
  const att = priors.byAttempt[k];

  const causeLabel = (BUCKETS[caseRow.root_cause]?.label ?? caseRow.root_cause).toLowerCase();
  const parts = [
    { name: 'root_cause', weight: BLEND_WEIGHTS.rootCause, rate: rc?.rate ?? priors.globalRate,
      n: rc?.n ?? 0,
      // A root cause with no batch history is not a 0% bucket — it is an unknown
      // one, so it falls back to the global rate and says so rather than
      // reporting a confident-looking number built on nothing.
      detail: rc
        ? `${causeLabel} failures recover ${pct(rc.rate)} of the time (${rc.n} in the batch)`
        : `no history yet for "${caseRow.root_cause}", so falling back to the ` +
          `${pct(priors.globalRate)} baseline across all causes` },
    { name: 'attempt', weight: BLEND_WEIGHTS.attempt, rate: att?.rate ?? priors.globalRate,
      n: att?.n ?? 0,
      detail: failedSoFar === 0
        ? `nothing has been tried yet (cases at that stage recover ${pct(att?.rate)})`
        : `${failedSoFar} of 3 attempts have already failed, where cases recover only ` +
          `${pct(att?.rate)} of the time` },
    { name: 'segment', weight: BLEND_WEIGHTS.segment, rate: seg?.rate ?? priors.globalRate,
      n: seg?.n ?? 0,
      detail: `${customer.segment} customers recover ${pct(seg?.rate ?? priors.globalRate)} of the time` },
  ];

  let base = 0;
  for (const p of parts) {
    const contribution = p.weight * p.rate;
    base += contribution;
    factors.push({ ...p, kind: 'base', value: contribution });
  }

  // -- 2. Modifiers: what the population rates can't see ---------------------
  let score = base;
  // Only what was already known when this case opened — see buildCustomerHistory.
  const others = (history?.cases ?? []).filter(
    (c) => c.case_id !== caseRow.id && c.opened_at < caseRow.opened_at);
  const priorRecoveries = others.filter((c) => c.status === 'recovered').length;
  const priorFailures = others.filter((c) => c.status === 'stopped').length;

  const applyModifier = (name, factor, detail) => {
    if (Math.abs(factor - 1) < 0.005) return;
    const before = score;
    score *= factor;
    factors.push({ name, kind: 'modifier', factor, delta: score - before, detail });
  };

  if (priorRecoveries > 0) {
    const capped = Math.min(priorRecoveries, MODIFIERS.priorCap);
    applyModifier('prior_recoveries', 1 + MODIFIERS.priorRecoveryStep * capped,
      `they have recovered ${priorRecoveries} previous case${priorRecoveries === 1 ? '' : 's'}`);
  }
  if (priorFailures > 0) {
    const capped = Math.min(priorFailures, MODIFIERS.priorCap);
    applyModifier('prior_failures', 1 - MODIFIERS.priorFailureStep * capped,
      `${priorFailures} previous case${priorFailures === 1 ? '' : 's'} of theirs went unrecovered`);
  }

  const rel = customer.reliability_score;
  applyModifier('reliability',
    1 - MODIFIERS.reliabilitySpread + rel * MODIFIERS.reliabilitySpread * 2,
    `their payment reliability is ${rel.toFixed(2)}${rel >= 0.8 ? ', which is strong' : rel <= 0.45 ? ', which is poor' : ''}`);

  const typical = history?.typicalAmount;
  if (typical) {
    const ratio = caseRow.amount_at_risk_inr / typical;
    if (ratio >= MODIFIERS.largeAmountRatio) {
      applyModifier('amount_size', MODIFIERS.largeAmountFactor,
        `this is ${ratio.toFixed(1)}× their typical payment, which takes longer to clear`);
    } else if (ratio <= MODIFIERS.smallAmountRatio) {
      applyModifier('amount_size', MODIFIERS.smallAmountFactor,
        `this sits well below their typical payment, so it clears easily`);
    }
  }

  score = Math.max(0.01, Math.min(0.97, score));

  return {
    score,
    band: band(score),
    base,
    factors,
    explanation: explain(score, factors, caseRow),
  };
}

/**
 * Plain-English "why this number".
 * Leads with the strongest base signal, then names the modifiers that actually
 * moved it — no point listing a factor of 1.01.
 */
function explain(score, factors, caseRow) {
  const bases = factors.filter((f) => f.kind === 'base').sort((a, b) => b.value - a.value);
  const mods = factors.filter((f) => f.kind === 'modifier')
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  // Two population signals is enough prose; the third is always the weakest.
  const lead = `${pct(score)} — ${bases[0].detail}, and ${bases[1].detail}`;

  // Anything under 2.5 points is noise in a sentence, however real in the maths.
  const strong = mods.filter((m) => Math.abs(m.delta) >= 0.025).slice(0, 2);
  if (!strong.length) return `${lead}.`;

  const up = strong.filter((m) => m.delta > 0).map((m) => m.detail);
  const down = strong.filter((m) => m.delta < 0).map((m) => m.detail);

  const clauses = [];
  if (up.length) clauses.push(`up because ${join(up)}`);
  if (down.length) clauses.push(`down because ${join(down)}`);
  return `${lead}. Adjusted ${join(clauses)}.`;
}

const join = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0]);

const pct = (n) => (n == null ? '—' : `${Math.round(n * 100)}%`);

/**
 * Cases a human should probably take over.
 *
 * Two groups qualify: cases still running that the agent is unlikely to close,
 * and cases it already gave up on at the attempt cap. The second group matters
 * most — the agent stopping is not the same as the money being uncollectable,
 * and a person picking up the phone is exactly the escalation the cap exists
 * to trigger.
 *
 * Hard-stopped cases are excluded, and stay excluded. A human may not contact
 * an opted-out customer either.
 */
export function needsAttention(scored, { minAmount = 0, maxScore = 0.5 } = {}) {
  return scored
    .filter((s) => s.caseRow.status !== 'recovered'
      && s.caseRow.amount_at_risk_inr >= minAmount
      && s.score <= maxScore
      && !s.factors.some((f) => f.kind === 'override'))
    // Rank by what is actually at stake: money weighted by how likely we are to lose it.
    .map((s) => ({ ...s, expectedLoss: s.caseRow.amount_at_risk_inr * (1 - s.score) }))
    .sort((a, b) => b.expectedLoss - a.expectedLoss);
}
