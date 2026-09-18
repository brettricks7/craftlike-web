/**
 * core/rng.js — deterministic, seedable randomness.
 *
 * STUDIO RULE: anything random flows through here, seeded by the run seed,
 * so every run is exactly reproducible ("beat my seed").
 *
 * Design:
 *   - hashString  : xmur3 — turns any string into a well-mixed 32-bit seed.
 *   - mulberry32  : tiny, fast, high-quality-enough PRNG for gameplay.
 *   - Rng.stream  : named sub-streams ("loot", "spawns", "combat"...) so one
 *                   system pulling extra numbers can NEVER shift the results
 *                   of another system. This is what keeps seeds stable across
 *                   balance patches.
 */

/** xmur3 string hash -> unsigned 32-bit int. Deterministic across platforms. */
export function hashString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** mulberry32 PRNG. Returns a function yielding floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A single PRNG stream with gameplay-friendly helpers. */
export class RandomStream {
  constructor(seedNumber) {
    this.next = mulberry32(seedNumber);
  }

  /** Float in [min, max). */
  float(min = 0, max = 1) {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max] inclusive. */
  int(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Random array element (undefined for empty arrays). */
  pick(arr) {
    if (!arr || arr.length === 0) return undefined;
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** True with probability p (0..1). */
  chance(p) {
    return this.next() < p;
  }

  /** Multiplier in [1-amount, 1+amount] — handy for stat jitter. */
  jitter(amount) {
    return 1 + (this.next() * 2 - 1) * amount;
  }

  /** In-place Fisher–Yates shuffle. Returns the same array. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

/** Root RNG for a run. Hand out named streams, one per system. */
export class Rng {
  constructor(seed) {
    this.seed = String(seed);
    this._streams = new Map();
  }

  /** Get (or lazily create) the named sub-stream. */
  stream(name) {
    if (!this._streams.has(name)) {
      this._streams.set(name, new RandomStream(hashString(`${this.seed}::${name}`)));
    }
    return this._streams.get(name);
  }
}
