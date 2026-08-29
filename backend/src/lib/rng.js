/**
 * Deterministic PRNG so every `npm run seed` produces the same dataset.
 * Reproducibility matters here: the demo numbers should not move between runs.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRandom(seed) {
  const next = mulberry32(seed);

  const rand = {
    next,
    /** Float in [min, max). */
    float: (min, max) => min + next() * (max - min),
    /** Integer in [min, max] inclusive. */
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    bool: (p = 0.5) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** Pick from `[value, weight]` pairs. */
    weighted: (pairs) => {
      const total = pairs.reduce((s, [, w]) => s + w, 0);
      let roll = next() * total;
      for (const [value, weight] of pairs) {
        roll -= weight;
        if (roll <= 0) return value;
      }
      return pairs[pairs.length - 1][0];
    },
    shuffle: (arr) => {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
    /** Rough normal via averaged uniforms, clamped to [min, max]. */
    normal: (mean, sd, min = -Infinity, max = Infinity) => {
      const u = (next() + next() + next() + next() + next() + next() - 3) / 1.5;
      return Math.min(max, Math.max(min, mean + u * sd));
    },
  };
  return rand;
}
