/**
 * Stitch the audit trail and the intervention log into one ordered story.
 *
 * The runner emits exactly one `intervention_selected` entry per intervention,
 * in order, so the Nth such entry pairs with the Nth intervention. Pairing on
 * position rather than on the log's `sequence` number matters: a case that
 * opens part-way through its sequence — which the live simulator does, to show
 * what the agent does on a second or third failure — numbers its interventions
 * from where it started, not from one. Matching sequence to ordinal there would
 * silently attach every decision to the wrong action.
 *
 * `attemptNumber` is the intervention's own sequence, because that is the real
 * answer to "which of the three attempts is this".
 *
 * Done once here rather than in each consumer, where a mismatch is invisible —
 * the case detail API and the live simulator both read it.
 */
export function buildTimeline(audit, interventions) {
  let index = -1;
  let current = null;

  return audit.map((a) => {
    if (a.event_type === 'intervention_selected') {
      index += 1;
      current = interventions[index] ?? null;
      return { ...a, intervention: current, attemptNumber: current?.sequence ?? index + 1 };
    }
    if (a.event_type === 'outcome_recorded') {
      return { ...a, intervention: current, attemptNumber: current?.sequence ?? null };
    }
    return { ...a, intervention: null, attemptNumber: null };
  });
}
