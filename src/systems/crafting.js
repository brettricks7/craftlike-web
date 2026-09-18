/**
 * systems/crafting.js — the deterministic, infinite-craft-style ability forge.
 *
 * Core idea: combining two elements is a PURE FUNCTION of
 *   (element A, element B, run seed, balance data)
 * No network, no AI calls, no nondeterministic RNG. The same seed and the same pair
 * always produce the same ability — on every machine, in every replay, and
 * (later) for every co-op peer.
 *
 * Because crafted results are themselves elements, results can be re-combined
 * forever — but ONLY with equals: fire+water -> a tier-1, tier-1+tier-1 ->
 * a tier-2, and so on. Tier N embodies 2^N base units, so depth is earned,
 * never chained for free. The search space still grows with every element
 * collected, so the discovery phase never ends.
 *
 * Balance lives entirely in data/abilities.json (combineRules, effectBlocks,
 * naming). Wiggle numbers there; this file only implements the rules.
 */
import { hashString, mulberry32, RandomStream } from '../core/rng.js';

/** Attach effectBlocks for base element tags when effects missing. */
export function hydrateBaseEffects(el, abilities) {
  if (!el || el.crafted) return el;
  if (el.effects?.length) return el;
  const blocks = abilities?.effectBlocks ?? {};
  const effects = (el.tags ?? [])
    .filter((t) => blocks[t])
    .map((t) => ({ tag: t, ...blocks[t] }));
  if (!effects.length) return el;
  return { ...el, effects };
}

/** Stable cache/identity key for a pair — order independent. */
export function comboKey(idA, idB) {
  return [idA, idB].sort().join('+');
}

/**
 * Pure crafting function.
 *
 * THE TIER LAW: only equal tiers fuse. Two tier-0 base elements make a
 * tier-1 ability; two tier-1s make a tier-2; two tier-2s a tier-3. A tier-N
 * result therefore embodies 2^N base units — power grows with tier but the
 * ingredient bill grows exponentially, which is what keeps crafting from
 * running away (callers gate mismatches via canCraft/preview; calling this
 * directly with mismatched tiers is a programming error).
 *
 * @param {object} a         element object
 * @param {object} b         element object
 * @param {string} seed      run seed
 * @param {object} abilities data/abilities.json
 * @returns {object} a brand-new element (id, name, icon, tags, tier, stats, effects, recipe)
 */
export function craftPair(a, b, seed, abilities) {
  if (a.tier !== b.tier) {
    throw new Error(`Tier mismatch in craft: ${a.id} (t${a.tier}) + ${b.id} (t${b.tier})`);
  }
  const key = comboKey(a.id, b.id);

  // One private RNG stream per (seed, pair). Pulling numbers for THIS combo
  // can never disturb any other combo's results.
  const rnd = new RandomStream(hashString(`${seed}|craft|${key}`));

  // Sort the ingredients by id so a+b === b+a in every detail below.
  const [first, second] = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));

  // --- Tags: union of both parents, deterministically trimmed to maxTags ---
  const union = [...new Set([...first.tags, ...second.tags])];
  const tags = union.length > abilities.maxTags
    ? rnd.shuffle([...union]).slice(0, abilities.maxTags)
    : union;

  // --- Tier: one deeper than the (equal-tier) parents ---
  const tier = first.tier + 1;

  // --- Stats: per-stat data-driven merge ---
  // result = (A + B) * blend * tierFactor^tier * seeded jitter, then clamped.
  // Day 186 — soft-cap tier scaling so equal-tier depth isn't a second god axis
  const stats = {};
  for (const [stat, rule] of Object.entries(abilities.combineRules)) {
    const base = ((first.stats[stat] ?? 0) + (second.stats[stat] ?? 0)) * rule.blend;
    // Apply tier scaling with soft-cap: cap effective tier for exponential growth
    const effectiveTier = rule.tierScaleCap != null 
      ? Math.min(tier, rule.tierScaleCap)
      : tier;
    const grown = base * Math.pow(rule.tierFactor, effectiveTier);
    const jittered = grown * rnd.jitter(rule.jitter);
    stats[stat] = Math.min(Math.max(jittered, rule.min), rule.max);
  }

  // --- Effects: every surviving tag contributes its effect block ---
  const effects = tags
    .filter((t) => abilities.effectBlocks[t])
    .map((t) => ({ tag: t, ...abilities.effectBlocks[t] }));

  // Tag-driven stat hooks (e.g. "air" grants haste = faster fire rate).
  for (const e of effects) {
    if (e.effect === 'haste') {
      stats.cooldown = Math.max(
        stats.cooldown * e.cooldownMult,
        abilities.combineRules.cooldown.min
      );
    }
  }

  // --- Name: rare epic names, otherwise prefix-of-tag-1 + suffix-of-tag-2 ---
  const naming = abilities.naming;
  let name;
  if (rnd.chance(naming.epicChance)) {
    name = rnd.pick(naming.epicNames);
  } else {
    const prefTag = tags[0];
    const sufTag = tags[1] ?? tags[0];
    const prefix = rnd.pick(naming.prefixes[prefTag] ?? ['Strange']);
    const suffix = rnd.pick(naming.suffixes[sufTag] ?? ['Thing']);
    name = `${prefix} ${suffix}`;
  }

  // Visuals inherit from the dominant effect.
  const icon = effects[0]?.icon ?? '✨';
  const color = effects[0]?.color ?? '#ffffff';

  let result = {
    id: `craft:${key}`,
    name,
    icon,
    color,
    tags,
    tier,
    stats,
    effects,
    crafted: true,
    recipe: [first.id, second.id]
  };

  // Day 124 — rare authored mutation spikes (seed-local, still previewable)
  result = applyMutationSpike(result, rnd, abilities?.mutations);
  return result;
}

/**
 * Apply a rare broken-combo spike if mutation table matches.
 * Deterministic via the craft RandomStream (already advanced for naming).
 */
export function applyMutationSpike(result, rnd, mutations) {
  if (!mutations?.enabled || !mutations.rules?.length) return result;
  const tags = new Set(result.tags ?? []);
  const candidates = [];
  for (const rule of mutations.rules) {
    if (rule.minTier != null && (result.tier ?? 0) < rule.minTier) continue;
    if (rule.whenTags?.length) {
      const ok = rule.requireBoth
        ? rule.whenTags.every((t) => tags.has(t))
        : rule.whenTags.some((t) => tags.has(t));
      if (!ok) continue;
    }
    candidates.push(rule);
  }
  if (candidates.length === 0) return result;
  // Base chance then pick among matching rules
  const chance = mutations.chance ?? 0.08;
  // Use first matching rule's chanceOverride if present when we roll spike
  const rule = candidates[0];
  const p = rule.chanceOverride ?? chance;
  if (!rnd.chance(p)) return result;
  const pick = candidates.length === 1 ? rule : rnd.pick(candidates);
  const spike = pick.spike ?? {};
  const stats = { ...result.stats };
  if (spike.damageMult) stats.damage = Number((stats.damage * spike.damageMult).toFixed(2));
  if (spike.knockbackMult) {
    stats.knockback = Number(((stats.knockback ?? 0) * spike.knockbackMult).toFixed(1));
  }
  const effects = [...(result.effects ?? [])];
  if (spike.addEffect) {
    const key = spike.addEffect.effect;
    const without = effects.filter((e) => e.effect !== key);
    without.push({ ...spike.addEffect });
    effects.length = 0;
    effects.push(...without);
  }
  const name = spike.namePrefix
    ? `${spike.namePrefix} ${result.name}`
    : result.name;
  return {
    ...result,
    name,
    stats,
    effects,
    mutationId: pick.id,
    volatile: true
  };
}

/** True when a craft/fuse result rolled a mutation spike (Day 246 gate). */
export function isVolatileCraftResult(result) {
  return !!(result?.volatile);
}

/** Short stamp label for volatile fuse identity beat (Bob squint). */
export function describeVolatileFuseStamp(result) {
  if (!isVolatileCraftResult(result)) return '';
  const id = String(result.mutationId ?? '');
  if (id.includes('heat')) return 'SPIKE';
  if (id.includes('pierce')) return 'RIPTIDE';
  if (id.includes('vitality')) return 'BLOOM';
  if (id.includes('tier2')) return 'FRACTURE';
  return 'VOLATILE';
}

/**
 * Stateful wrapper used by a run: registry of known elements + combo cache.
 */
export class CraftingSystem {
  /**
   * @param {object} data { elements: data/proteins.json, abilities: data/abilities.json }
   * @param {string} seed run seed
   */
  constructor(data, seed) {
    this.abilities = data.abilities;
    // Day 124 — optional mutation table rides with abilities for craftPair
    if (data.mutations) {
      this.abilities = { ...this.abilities, mutations: data.mutations };
    }
    this.seed = String(seed);

    // All elements known to this run, base + crafted, by id.
    this.elements = new Map();
    for (const el of data.elements.elements) {
      this.elements.set(el.id, hydrateBaseEffects(el, this.abilities));
    }

    this.startingIds = [...data.elements.starting];
    this.cache = new Map(); // comboKey -> crafted element
    this.discoveries = 0;   // unique combos found this run
  }

  /** Look up any known element (base or crafted) by id. */
  get(id) {
    return this.elements.get(id);
  }

  /**
   * Combine two known elements by id.
   * @returns {{ result: object, isNew: boolean }}
   */
  craft(idA, idB) {
    const key = comboKey(idA, idB);
    if (this.cache.has(key)) {
      return { result: this.cache.get(key), isNew: false };
    }
    const a = this.get(idA);
    const b = this.get(idB);
    if (!a || !b) throw new Error(`Unknown element in craft: ${idA} + ${idB}`);

    const result = craftPair(a, b, this.seed, this.abilities);
    this.cache.set(key, result);
    this.elements.set(result.id, result);
    this.discoveries++;
    return { result, isNew: true };
  }

  /**
   * Preview a combination WITHOUT committing it: no cache write, no
   * discovery counted, no element registered. Pure — safe to call from UI
   * every frame. Same inputs always preview the same result the real craft
   * would produce (that's the whole point of deterministic crafting).
   */
  preview(idA, idB) {
    const key = comboKey(idA, idB);
    if (this.cache.has(key)) {
      return { result: this.cache.get(key), isNew: false };
    }
    const a = this.get(idA);
    const b = this.get(idB);
    if (!a || !b || a.tier !== b.tier) return null;
    return { result: craftPair(a, b, this.seed, this.abilities), isNew: true };
  }

  /** All droppable base elements (the loot pool — stock refills from here). */
  dropPool() {
    return [...this.elements.values()].filter((el) => el.droppable && !el.crafted);
  }
}
