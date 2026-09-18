/**
 * systems/hive-bonuses.js — Hive pattern matching + combat bonus application.
 *
 * SILO: change bonus math / grades / labels HERE (and data/dna_patterns.json).
 * hex.js owns seats, neighbors, and adjacency edges — not payouts.
 *
 * Sections:
 *   1. Labels / symmetry grade resolution
 *   2. Pattern matchers (rules from dna_patterns.patterns[].rule)
 *   3. Bonus kind application (edit applyPatternBonus when redesigning payouts)
 *   4. Adjacency → mods, forms, hexCombatMods aggregator
 */
import { resolveAdjacency } from './hex.js';

// ─── 1. Labels & symmetry grade payouts ─────────────────────────────────────

/** Pick flat damage for achieved grade; each pattern authors its own ladder. */
export function resolveSymmetryBonus(bonus, grade) {
  if (!bonus || typeof bonus !== 'object') {
    return { kind: 'symmetry_damage', flat: 0, grade };
  }
  const flat = Number(
    bonus[grade] ??
      (grade === 'exact' ? bonus.exact : null) ??
      (grade === 'color' ? bonus.color : null) ??
      bonus.flat ??
      bonus.damageFlat ??
      0
  );
  return { kind: 'symmetry_damage', flat, grade, ...bonus };
}

export function formatSymmetryBonusLabel(pat, grade, bonus) {
  const flat = bonus?.flat ?? 0;
  const sym = pat?.symmetry ?? 'mirror';
  const symWord =
    sym === 'rotate180' ? '180°' : sym === 'rotate120' ? '120°' : 'mirror';
  if (!flat) return `${symWord} ${grade}`;
  return `+${flat} dmg (${symWord} ${grade})`;
}

/** Human-readable bonus chip for Genome UI. */
export function formatBonusLabel(bonus) {
  if (!bonus || typeof bonus !== 'object') return '';
  if (bonus.kind === 'tag_power') {
    const pct = Math.round((bonus.pct ?? 0) * 100);
    return pct ? `+${pct}% tag power` : '+tag power';
  }
  if (bonus.kind === 'damage_flat' || bonus.kind === 'symmetry_damage') {
    const flat = bonus.flat ?? bonus.damageFlat ?? 0;
    const grade = bonus.grade ? ` ${bonus.grade}` : '';
    return flat ? `+${flat} dmg${grade}` : '+dmg';
  }
  if (bonus.kind === 'mixed_axes') {
    const bits = [];
    if (bonus.damageFlat) bits.push(`+${bonus.damageFlat} dmg`);
    if (bonus.knockbackPct) bits.push('+KB');
    if (bonus.pierceChance) bits.push('+pierce');
    return bits.join(' · ') || '+mixed axes';
  }
  if (bonus.kind === 'reveal') return 'secret find';
  return bonus.kind ? String(bonus.kind) : '';
}

function summarize(pat) {
  return {
    id: pat.id,
    name: pat.secret ? '???' : (pat.name ?? pat.id),
    secret: !!pat.secret,
    bonus: pat.bonus ?? {},
    bonusLabel: pat.bonusLabel ?? formatBonusLabel(pat.bonus)
  };
}

function summarizeSymmetry(pat, grade) {
  const bonus = resolveSymmetryBonus(pat.bonus, grade);
  const label =
    pat.bonusLabels?.[grade] ??
    formatSymmetryBonusLabel(pat, grade, bonus) ??
    pat.bonusLabel ??
    formatBonusLabel(bonus);
  return {
    id: pat.id,
    name: pat.secret ? '???' : (pat.name ?? pat.id),
    secret: !!pat.secret,
    grade,
    bonus,
    bonusLabel: label
  };
}

// ─── 2. Pattern matchers ────────────────────────────────────────────────────

function ring0Slots(hex) {
  const per = hex.ringSlots || 6;
  return hex.slots.slice(0, per);
}

function seatOcc(chip) {
  return chip ? 1 : 0;
}

function primaryTag(chip) {
  return (chip?.tags ?? [])[0] ?? null;
}

/** Grade one filled pair: exact id > shared primary tag; mismatch = null. */
function pairGrade(a, b) {
  if (!a || !b) return null;
  if (a.id && b.id && a.id === b.id) return 'exact';
  const ta = primaryTag(a);
  const tb = primaryTag(b);
  if (ta && tb && ta === tb) return 'color';
  return null;
}

/** Best matching pair wins. No color/exact pairs → no bonus. */
function collapseGrades(pairGrades) {
  const matched = pairGrades.filter((g) => g === 'exact' || g === 'color');
  if (!matched.length) return null;
  if (matched.includes('exact')) return 'exact';
  return 'color';
}

function gradeRank(g) {
  if (g === 'exact') return 2;
  if (g === 'color') return 1;
  return 0;
}

/**
 * Innermost-ring geometric symmetry (mirror / 180° / 120°).
 * Occupancy must mirror, but bonus requires ≥1 color or exact protein pair.
 * @returns {'color'|'exact'|null}
 */
export function gradeRingSymmetry(ringChips, pat) {
  const n = ringChips.length || 0;
  if (n < 2) return null;
  const minFilled = Number(pat.minFilled ?? 2) || 2;
  const filled = ringChips.filter(Boolean).length;
  if (filled < minFilled) return null;
  const kind = pat.symmetry ?? 'mirror';
  if (kind === 'mirror') return gradeMirrorSymmetry(ringChips);
  if (kind === 'rotate180') return gradeRotationalSymmetry(ringChips, 2);
  if (kind === 'rotate120') return gradeRotationalSymmetry(ringChips, 3);
  return null;
}

function gradeMirrorSymmetry(ringChips) {
  const n = ringChips.length;
  let best = null;
  // Vertex axes + edge axes (NW↔SW needs edge; NE↔NW needs vertex).
  for (const edge of [false, true]) {
    for (let axis = 0; axis < n; axis++) {
      let ok = true;
      const grades = [];
      for (let i = 0; i < n; i++) {
        const j = edge
          ? (((2 * axis + 1 - i) % n) + n) % n
          : (((2 * axis - i) % n) + n) % n;
        if (i >= j) continue;
        const a = ringChips[i];
        const b = ringChips[j];
        if (seatOcc(a) !== seatOcc(b)) {
          ok = false;
          break;
        }
        if (a && b) grades.push(pairGrade(a, b));
      }
      if (!ok || grades.length < 1) continue;
      const g = collapseGrades(grades);
      if (!g) continue;
      if (!best || gradeRank(g) > gradeRank(best)) best = g;
    }
  }
  return best;
}

function gradeRotationalSymmetry(ringChips, order) {
  const n = ringChips.length;
  if (n % order !== 0) return null;
  const step = n / order;
  const grades = [];
  for (let i = 0; i < n; i++) {
    const j = (i + step) % n;
    const a = ringChips[i];
    const b = ringChips[j];
    if (seatOcc(a) !== seatOcc(b)) return null;
    if (a && b) grades.push(pairGrade(a, b));
  }
  if (grades.length < 1) return null;
  return collapseGrades(grades);
}

function matchMonoRing(ringChips, pat) {
  const min = pat.minSlots ?? 3;
  const filled = ringChips.filter(Boolean);
  if (filled.length < min) return false;
  const tagSets = filled.map((c) => new Set(c.tags ?? []));
  if (tagSets.length === 0) return false;
  let common = [...tagSets[0]];
  for (const s of tagSets.slice(1)) {
    common = common.filter((t) => s.has(t));
  }
  return common.length > 0;
}

function matchAlternating(ringChips, pat) {
  const min = pat.minSlots ?? 4;
  const filled = ringChips.filter(Boolean);
  if (filled.length < min) return false;
  const primaries = filled.map((c) => (c.tags ?? [])[0]).filter(Boolean);
  if (primaries.length < filled.length) return false;
  const a = primaries[0];
  const b = primaries[1];
  if (!a || !b || a === b) return false;
  for (let i = 0; i < primaries.length; i++) {
    const expect = i % 2 === 0 ? a : b;
    if (primaries[i] !== expect) return false;
  }
  return true;
}

const COMPASS = { N: 0, NE: 1, SE: 2, S: 3, SW: 4, NW: 5 };

function matchAuthoredShape(hex, pat, getChip) {
  const shape = pat.shape ?? [];
  if (shape.length < (pat.minSlots ?? 3)) return false;
  const per = hex.ringSlots || 6;
  const ids = [];
  for (const label of shape) {
    const idx = COMPASS[label];
    if (idx == null || idx >= per) return false;
    const id = hex.slots[idx];
    if (!id) return false;
    ids.push(id);
  }
  return ids.every((id) => Boolean(getChip(id)));
}

/** One seat shy of authored_shape match (shape seats filled, not complete). */
function almostAuthoredShape(hex, pat, getChip) {
  if (matchAuthoredShape(hex, pat, getChip)) return false;
  const shape = pat.shape ?? [];
  const min = pat.minSlots ?? shape.length;
  if (shape.length < 2 || min < 2) return false;
  const per = hex.ringSlots || 6;
  let filled = 0;
  for (const label of shape) {
    const idx = COMPASS[label];
    if (idx == null || idx >= per) continue;
    const id = hex.slots[idx];
    if (id && getChip(id)) filled++;
  }
  return filled >= min - 1 && filled < min;
}

/** One seat shy of mono ring (shared tag across ring chips). */
function almostMonoRing(ringChips, pat) {
  if (matchMonoRing(ringChips, pat)) return false;
  const min = pat.minSlots ?? 3;
  if (min < 2) return false;
  const filled = ringChips.filter(Boolean);
  if (filled.length !== min - 1) return false;
  const tagSets = filled.map((c) => new Set(c.tags ?? []));
  if (tagSets.length === 0) return false;
  let common = [...tagSets[0]];
  for (const s of tagSets.slice(1)) {
    common = common.filter((t) => s.has(t));
  }
  return common.length > 0;
}

/** Tag proteins seated but bond edge not formed yet. */
function almostAdjacentSharedTag(hex, pat, getChip) {
  if (matchAdjacentSharedTag(hex, pat, getChip)) return false;
  const tag = pat.tag;
  if (!tag) return false;
  const per = hex.ringSlots || 6;
  let chipCount = 0;
  for (const id of hex.slots.slice(0, per)) {
    if (!id) continue;
    const chip = getChip(id);
    if (chip && (chip.tags ?? []).includes(tag)) chipCount++;
  }
  return chipCount >= 2;
}

/** Prefix of alternating ring one seat short of minSlots. */
function almostAlternating(ringChips, pat) {
  if (matchAlternating(ringChips, pat)) return false;
  const min = pat.minSlots ?? 4;
  const filled = ringChips.filter(Boolean);
  if (filled.length !== min - 1) return false;
  const primaries = filled.map((c) => (c.tags ?? [])[0]).filter(Boolean);
  if (primaries.length < filled.length) return false;
  const a = primaries[0];
  const b = primaries[1];
  if (!a || !b || a === b) return false;
  for (let i = 0; i < primaries.length; i++) {
    const expect = i % 2 === 0 ? a : b;
    if (primaries[i] !== expect) return false;
  }
  return true;
}

function matchAdjacentSharedTag(hex, pat, getChip) {
  const tag = pat.tag;
  if (!tag) return false;
  const need = Number(pat.minEdges ?? 1) || 1;
  const edges = resolveAdjacency(hex, getChip);
  let n = 0;
  for (const e of edges) {
    if ((e.tags ?? []).includes(tag)) n += 1;
  }
  return n >= need;
}

/**
 * Active pattern matches for current occupancy.
 * Add new `rule` handlers here when inventing patterns.
 */
export function matchHexPatterns(hex, dnaPatterns, getChip = () => null) {
  if (!hex?.slots?.length) return [];
  const filled = hex.slots.filter(Boolean);
  if (filled.length === 0) return [];

  const patterns = dnaPatterns?.patterns ?? [];
  const hits = [];
  const ring = ring0Slots(hex);
  const ringChips = ring.map((id) => (id ? getChip(id) : null));

  for (const pat of patterns) {
    if (!pat?.id) continue;
    if (pat.rule === 'all_same_tag') {
      if (matchMonoRing(ringChips, pat)) hits.push(summarize(pat));
    } else if (pat.rule === 'alternating_two_tags') {
      if (matchAlternating(ringChips, pat)) hits.push(summarize(pat));
    } else if (pat.rule === 'authored_shape') {
      if (matchAuthoredShape(hex, pat, getChip)) hits.push(summarize(pat));
    } else if (pat.rule === 'adjacent_shared_tag') {
      if (matchAdjacentSharedTag(hex, pat, getChip)) hits.push(summarize(pat));
    } else if (pat.rule === 'ring_symmetry') {
      const grade = gradeRingSymmetry(ringChips, pat);
      if (grade) hits.push(summarizeSymmetry(pat, grade));
    }
  }
  return hits;
}

/**
 * True when hive is one seat from a pattern match (no full hits).
 * Presentation-only probe — never returns pattern ids/names.
 */
export function almostMatchHexPatterns(hex, dnaPatterns, getChip = () => null) {
  if (!hex?.slots?.length) return false;
  if (hex.slots.filter(Boolean).length === 0) return false;

  const fullIds = new Set(
    matchHexPatterns(hex, dnaPatterns, getChip).map((p) => p.id).filter(Boolean)
  );
  const patterns = dnaPatterns?.patterns ?? [];
  const ring = ring0Slots(hex);
  const ringChips = ring.map((id) => (id ? getChip(id) : null));

  for (const pat of patterns) {
    if (!pat?.id || fullIds.has(pat.id)) continue;
    if (pat.rule === 'all_same_tag') {
      if (almostMonoRing(ringChips, pat)) return true;
    } else if (pat.rule === 'alternating_two_tags') {
      if (almostAlternating(ringChips, pat)) return true;
    } else if (pat.rule === 'authored_shape') {
      if (almostAuthoredShape(hex, pat, getChip)) return true;
    } else if (pat.rule === 'adjacent_shared_tag') {
      if (almostAdjacentSharedTag(hex, pat, getChip)) return true;
    }
  }
  return false;
}

// ─── 3. Bonus kind application (edit this when redesigning payouts) ─────────

/**
 * Apply one pattern bonus onto a mutable combat accumulator.
 * @param {object} bonus — pattern.bonus (may include resolved grade/flat)
 * @param {{ damage: number, knockbackPct: number, pierceChance: number, pierceCount: number, shotTag: string|null }} acc
 * @param {{ tagScale: number, revealFlat: number }} ctx — from dna_patterns.balance
 */
export function applyPatternBonus(bonus, acc, ctx = {}) {
  if (!bonus || typeof bonus !== 'object') return acc;
  const tagScale = ctx.tagScale ?? 10;
  const revealFlat = ctx.revealFlat ?? 2;

  switch (bonus.kind) {
    case 'tag_power':
      acc.damage += Number(((bonus.pct ?? 0.08) * tagScale).toFixed(2));
      break;
    case 'damage_flat':
    case 'symmetry_damage':
      acc.damage += Number(bonus.flat ?? bonus.damageFlat ?? 0);
      break;
    case 'mixed_axes':
      acc.damage += Number(bonus.damageFlat ?? 1);
      break;
    case 'reveal':
      acc.damage += Number(revealFlat);
      break;
    default:
      break;
  }

  if (bonus.knockbackPct) {
    acc.knockbackPct = Math.max(acc.knockbackPct, bonus.knockbackPct);
  }
  if (bonus.pierceChance) {
    acc.pierceChance = Math.max(acc.pierceChance, bonus.pierceChance);
    acc.pierceCount = Math.max(acc.pierceCount, bonus.pierceCount ?? 1);
    if (!acc.shotTag && acc.pierceChance > 0) acc.shotTag = 'pierce';
  }
  return acc;
}

// ─── 4. Adjacency mods, shot forms, combat aggregator ───────────────────────

/**
 * Typed adjacency: each shared-tag edge contributes from adjacency.byTag.
 * Dominant shotTag = most edges (tie → higher damagePerEdge).
 */
export function typedAdjacencyMods(edges, dnaPatterns) {
  const cfg = dnaPatterns?.adjacency ?? {};
  const byTag = cfg.byTag ?? {};
  const fallback = Number(cfg.fallbackDamagePerEdge ?? 0.25) || 0;
  const tagCounts = new Map();
  let damage = 0;
  let knockbackPct = 0;
  let pierceChance = 0;
  let pierceCount = 0;
  const bondCounts = {};

  for (const e of edges ?? []) {
    const tags = e.tags ?? [];
    let best = null;
    let bestDmg = -1;
    for (const t of tags) {
      const row = byTag[t];
      const dmg = row ? Number(row.damagePerEdge ?? fallback) : fallback;
      if (dmg > bestDmg) {
        bestDmg = dmg;
        best = t;
      }
    }
    const tag = best ?? tags[0] ?? null;
    const row = tag ? byTag[tag] : null;
    damage += row ? Number(row.damagePerEdge ?? fallback) : fallback;
    if (row?.knockbackPctPerEdge) {
      knockbackPct += Number(row.knockbackPctPerEdge);
    }
    if (row?.pierceChancePerEdge) {
      pierceChance += Number(row.pierceChancePerEdge);
      pierceCount = Math.max(pierceCount, Number(row.pierceCount ?? 1));
    }
    if (tag) {
      bondCounts[tag] = (bondCounts[tag] ?? 0) + 1;
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  let shotTag = null;
  let bestCount = 0;
  for (const [tag, n] of tagCounts) {
    if (n > bestCount) {
      bestCount = n;
      shotTag = byTag[tag]?.shotTag ?? tag;
    }
  }

  return {
    damage: Number(damage.toFixed(2)),
    edges: edges?.length ?? 0,
    knockbackPct: Number(Math.min(1, knockbackPct).toFixed(3)),
    pierceChance: Number(Math.min(1, pierceChance).toFixed(3)),
    pierceCount,
    shotTag,
    bonds: bondCounts
  };
}

/**
 * Attack delivery form from hive bonds (beam / spray / rocket / …).
 * Highest priority matching form wins; null → default bolt.
 */
export function resolveShotForm(bonds, dnaPatterns) {
  const forms = dnaPatterns?.forms ?? {};
  const ranked = Object.entries(forms)
    .filter(([k, v]) => !k.startsWith('_') && v && typeof v === 'object')
    .sort((a, b) => (Number(b[1].priority) || 0) - (Number(a[1].priority) || 0));

  for (const [id, cfg] of ranked) {
    const need = Number(cfg.minBondEdges ?? 1) || 1;
    const tags = [];
    if (cfg.requireTag) tags.push(cfg.requireTag);
    if (Array.isArray(cfg.requireTagsAlt)) tags.push(...cfg.requireTagsAlt);
    if (Array.isArray(cfg.requireTags)) tags.push(...cfg.requireTags);
    if (tags.length === 0) continue;
    const count = Math.max(0, ...tags.map((t) => Number(bonds[t] ?? 0) || 0));
    if (count < need) continue;
    return {
      id,
      stats: cfg.stats ? { ...cfg.stats } : null,
      pierce: cfg.pierce ?? null,
      color: cfg.color ?? null,
      pellets: cfg.pellets ?? null,
      spread: cfg.spread ?? null,
      pelletDamage: cfg.pelletDamage ?? null,
      splashRadius: cfg.splashRadius ?? null,
      splashFalloff: cfg.splashFalloff ?? null
    };
  }
  return null;
}

/** Aggregate damage/tag bonuses from typed adjacency + patterns. */
export function hexCombatMods(hex, dnaPatterns, getChip) {
  const bal = dnaPatterns?.balance ?? {};
  const ctx = {
    tagScale: bal.tagPowerFlatScale ?? 10,
    revealFlat: bal.revealDamageFlat ?? 2
  };
  const edges = resolveAdjacency(hex, getChip);
  const adj = typedAdjacencyMods(edges, dnaPatterns);
  const patterns = matchHexPatterns(hex, dnaPatterns, getChip);
  const acc = {
    damage: adj.damage,
    knockbackPct: adj.knockbackPct,
    pierceChance: adj.pierceChance,
    pierceCount: adj.pierceCount,
    shotTag: adj.shotTag
  };
  for (const p of patterns) {
    applyPatternBonus(p.bonus, acc, ctx);
  }
  
  // Discovery incentive: scale down per-chip adjacency when no patterns found.
  const ringScales = bal.ringScales ?? [];
  if (ringScales.length > 0 && patterns.length === 0) {
    const ring0 = ring0Slots(hex);
    const filled = ring0.filter((id) => id && getChip(id)).length;
    const scale = ringScales[filled] ?? 1.0;
    acc.damage = Number((acc.damage * scale).toFixed(2));
  }
  
  return {
    damage: Number(acc.damage.toFixed(2)),
    edges: adj.edges,
    bonds: adj.bonds,
    patterns,
    knockbackPct: acc.knockbackPct,
    pierceChance: acc.pierceChance,
    pierceCount: acc.pierceCount,
    shotTag: acc.shotTag,
    form: resolveShotForm(adj.bonds ?? {}, dnaPatterns)
  };
}
