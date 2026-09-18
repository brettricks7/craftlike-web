/**
 * systems/hex.js — Hex DNA occupancy, layout, adjacency edges.
 * Pattern bonuses / combat payouts live in hive-bonuses.js (edit those there).
 * Day 151: true honeycomb rings (beehive), inter-ring neighbors, +1 ring.
 * Empty hex ⇒ no bonuses. Center seat is always "you" (not placeable).
 */

/** Cube directions (orientation-agnostic). */
const CUBE_DIRS = [
  [+1, 0, -1], [+1, -1, 0], [0, -1, +1],
  [-1, 0, +1], [-1, +1, 0], [0, +1, -1]
];

/**
 * Honeycomb capacity: ring r has 6r seats; total = 3·R·(R+1).
 * `ringSlots` stays 6 (innermost ring size) for pattern rules.
 */
export function hexCapacity(dnaPatterns, loadoutHex = {}) {
  const cfg = dnaPatterns?.hex ?? {};
  const ringSlots = Number(loadoutHex.ringSlots ?? cfg.ringSlots ?? 6) || 6;
  const maxRings = Number(cfg.maxRings ?? loadoutHex.maxRings ?? 4) || 4;
  const layout = cfg.layout ?? loadoutHex.layout ?? 'honeycomb';
  const total = layout === 'honeycomb'
    ? 3 * maxRings * (maxRings + 1)
    : ringSlots * maxRings;
  return { ringSlots, maxRings, total, layout };
}

/** Innermost ring — compass order matches secret_triad N/NE/SE/S/SW/NW. */
const RING1_COMPASS = [
  { q: 0, r: -1, s: 1 },  // N
  { q: 1, r: -1, s: 0 },  // NE
  { q: 1, r: 0, s: -1 },  // SE
  { q: 0, r: 1, s: -1 },  // S
  { q: -1, r: 1, s: 0 },  // SW
  { q: -1, r: 0, s: 1 }   // NW
];

/**
 * Ordered cube coords for rings 1..maxRings.
 * Ring 1 = compass order; outer rings = classic cube spiral (complete hive).
 */
export function honeycombCubes(maxRings) {
  const out = [];
  if (maxRings < 1) return out;
  for (const c of RING1_COMPASS) out.push({ ...c, ring: 1 });
  for (let ring = 2; ring <= maxRings; ring++) {
    // Classic: start at scale(dir4, ring), walk 6 edges × ring steps
    let q = -ring;
    let r = ring;
    let s = 0;
    for (let dir = 0; dir < 6; dir++) {
      const [dq, dr, ds] = CUBE_DIRS[dir];
      for (let step = 0; step < ring; step++) {
        out.push({ q, r, s, ring });
        q += dq;
        r += dr;
        s += ds;
      }
    }
  }
  return out;
}

function cubeKey(q, r, s) {
  return `${q},${r},${s}`;
}

/** @returns {{ center, ringSlots, maxRings, layout, slots, cubes, indexByCube }} */
export function createHexState(dnaPatterns, loadoutHex = {}) {
  const cfg = dnaPatterns?.hex ?? {};
  const { ringSlots, maxRings, total, layout } = hexCapacity(dnaPatterns, loadoutHex);
  const cubes = layout === 'honeycomb'
    ? honeycombCubes(maxRings)
    : null;
  const indexByCube = new Map();
  if (cubes) {
    cubes.forEach((c, i) => indexByCube.set(cubeKey(c.q, c.r, c.s), i));
  }
  return {
    center: cfg.center ?? loadoutHex.center ?? 'self',
    ringSlots,
    maxRings,
    layout,
    slots: Array.from({ length: total }, () => null),
    cubes,
    indexByCube
  };
}

/**
 * World positions for honeycomb seats (pointy-top — matches real comb packing).
 * Centers spaced so adjacent hexes share full walls (size = center→vertex).
 * @returns {{ x, y, r, slot, ring, q, rCube, s, corners: {x,y}[] }[]}
 */
export function hexSlotLayout(hex, cx, cy, { size = 22, seatR = 14 } = {}) {
  if (!hex?.slots?.length) return [];
  if (hex.layout === 'honeycomb' && hex.cubes?.length) {
    return hex.cubes.map((c, i) => {
      // pointy-top axial → pixel (must pair with pointy hexCorners)
      const sqrt3 = Math.sqrt(3);
      const x = cx + size * (sqrt3 * c.q + sqrt3 / 2 * c.r);
      const y = cy + size * (1.5 * c.r);
      return {
        slot: i,
        ring: c.ring,
        q: c.q,
        rCube: c.r,
        s: c.s,
        x,
        y,
        r: seatR,
        size,
        corners: hexCorners(x, y, size)
      };
    });
  }
  // Legacy polar fallback
  const out = [];
  const per = hex.ringSlots || 6;
  const baseRadius = 56;
  const ringGap = 42;
  for (let i = 0; i < hex.slots.length; i++) {
    const ring = Math.floor(i / per);
    const idx = i % per;
    const rad = baseRadius + ring * ringGap;
    const ang = (idx / per) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(ang) * rad;
    const y = cy + Math.sin(ang) * rad;
    out.push({
      slot: i,
      ring,
      x,
      y,
      r: seatR,
      corners: hexCorners(x, y, seatR)
    });
  }
  return out;
}

/** Pointy-top hexagon corner vertices (vertex at 12 o'clock). */
export function hexCorners(cx, cy, size) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 180) * (60 * i - 30);
    pts.push({ x: cx + size * Math.cos(ang), y: cy + size * Math.sin(ang) });
  }
  return pts;
}

/**
 * Neighbor seat indices — true honeycomb adjacency when cubes exist.
 * Legacy polar: same-ring wrap only (`hexNeighbors(0, 6) → [1,5]`).
 */
export function hexNeighbors(slotIdx, ringSlotsOrHex = 6) {
  if (ringSlotsOrHex && typeof ringSlotsOrHex === 'object') {
    const hex = ringSlotsOrHex;
    if (hex.layout === 'honeycomb' && hex.cubes?.[slotIdx]) {
      const c = hex.cubes[slotIdx];
      const out = [];
      for (const [dq, dr, ds] of CUBE_DIRS) {
        const j = hex.indexByCube?.get(cubeKey(c.q + dq, c.r + dr, c.s + ds));
        if (j != null) out.push(j);
      }
      return out;
    }
    ringSlotsOrHex = hex.ringSlots || 6;
  }
  const per = ringSlotsOrHex || 6;
  const ring = Math.floor(slotIdx / per);
  const idx = slotIdx % per;
  const base = ring * per;
  return [
    base + ((idx + 1) % per),
    base + ((idx - 1 + per) % per)
  ];
}

/**
 * Day 093 — neighboring seats that share ≥1 tag.
 * @param {(id: string) => {tags?: string[]}|null} getChip
 */
export function resolveAdjacency(hex, getChip) {
  if (!hex?.slots?.length) return [];
  const edges = [];
  const seen = new Set();
  for (let i = 0; i < hex.slots.length; i++) {
    const idA = hex.slots[i];
    if (!idA) continue;
    const chipA = getChip(idA);
    const tagsA = new Set(chipA?.tags ?? []);
    if (tagsA.size === 0) continue;
    for (const j of hexNeighbors(i, hex)) {
      if (j <= i) continue;
      const idB = hex.slots[j];
      if (!idB) continue;
      const key = `${i}:${j}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const chipB = getChip(idB);
      const shared = [...tagsA].filter((t) => (chipB?.tags ?? []).includes(t));
      if (shared.length > 0) edges.push({ a: i, b: j, tags: shared });
    }
  }
  return edges;
}

export function isHexSeatUnlocked(slotIdx, unlockedSeats) {
  return Number.isInteger(slotIdx) && slotIdx >= 0 && slotIdx < (unlockedSeats ?? 0);
}

/** Tunable hive knobs — single read point for tests / UI. */
export function hiveConfig(dnaPatterns = {}) {
  const dp = dnaPatterns ?? {};
  const slot = dp.slotUnlock ?? {};
  const adj = dp.adjacency ?? {};
  const offers = dp.offers ?? {};
  const { maxRings, total } = hexCapacity(dp);
  return {
    startingSeats: Number(slot.startingSeats ?? 6) || 6,
    costPerSeat: Math.max(1, Number(slot.costPerSeat ?? 1) || 1),
    inventoryCapExtra: Math.max(0, Number(slot.inventoryCapExtra ?? 2) || 0),
    unlockMode: slot.mode ?? 'discard',
    maxSeats: total,
    maxRings,
    adjacency: adj,
    offers,
    patterns: dp.patterns ?? [],
    balance: dp.balance ?? {}
  };
}

/**
 * How many DNA chips the bag may hold given seated + unlocked seats.
 * @returns {number}
 */
export function dnaInventoryRoom(unlockedSeats, seatedCount, inventoryCount, dnaPatterns) {
  const { inventoryCapExtra } = hiveConfig(dnaPatterns);
  const cap = (unlockedSeats ?? 0) + inventoryCapExtra;
  return Math.max(0, cap - (seatedCount ?? 0) - (inventoryCount ?? 0));
}

/** DNA still needed to fill all unlocked seats (inventory counts). */
export function dnaNeedToFillSeats(unlockedSeats, seatedCount, inventoryCount) {
  return Math.max(0, (unlockedSeats ?? 0) - (seatedCount ?? 0) - (inventoryCount ?? 0));
}

/** Smallest ring count whose cumulative seats >= n. */
export function ringsCoveringSeats(seats, dnaPatterns, loadoutHex = {}) {
  const { maxRings } = hexCapacity(dnaPatterns, loadoutHex);
  let covered = 0;
  const n = Math.max(0, Number(seats) || 0);
  for (let r = 1; r <= maxRings; r++) {
    covered += 6 * r;
    if (covered >= n) return r;
  }
  return maxRings;
}
