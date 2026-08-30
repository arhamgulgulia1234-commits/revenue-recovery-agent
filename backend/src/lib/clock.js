/**
 * What "now" means, per case.
 *
 * The synthetic book is pinned to SEED_NOW so the demo's numbers are
 * byte-identical between runs — that is the whole point of the anchor, and the
 * batch, the scorer and the frozen narration all depend on it.
 *
 * A case that sent a real WhatsApp message to a real phone cannot live on that
 * clock. Its response window expires in wall-clock time, and a payment webhook
 * arrives in wall-clock time.
 *
 * So the two run on different clocks, and which one a case gets is decided by
 * `delivery_mode`. This is what keeps a scheduler ticking every minute from
 * quietly walking the seeded book past its anchor and moving the demo numbers.
 */

/** The pinned anchor, or null when dates should follow the wall clock. */
export const SEED_NOW = process.env.SEED_NOW
  ? new Date(process.env.SEED_NOW).getTime()
  : null;

/** Wall clock for a live case; the pinned anchor, if set, for a simulated one. */
export function nowFor(deliveryMode) {
  if (deliveryMode === 'live') return Date.now();
  return SEED_NOW ?? Date.now();
}

export const anchorPinned = () => SEED_NOW !== null;
