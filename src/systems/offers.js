/**
 * systems/offers.js — Lab Offer kinds (Day 074).
 *
 * VISION: pedestals drop DNA chips / ability modules / rare fuse prompts —
 * no shop, no currency. At least one card must be applicable to the current
 * loadout (never a dead Offer after a strong Attack).
 *
 * Gaben applicable rules:
 *   dna     — always (accrue into run DNA inventory)
 *   ability — always when an offerable module exists (equip / swap Ability B)
 *   fuse    — when two equal-tier fragment ids are available to splice Attack
 */
import { moduleById } from './abilities.js';

export const OFFER_KINDS = ['dna', 'ability', 'fuse'];

/** @returns {boolean} */
export function isOfferApplicable(card, world) {
  if (!card || !card.kind) return false;
  if (card.kind === 'dna') return Boolean(card.id);
  if (card.kind === 'ability') {
    if (!card.id || card.id === 'blink') return false;
    const mod = moduleById(world?.abilityModules, card.id);
    return Boolean(mod?.offerable !== false && mod);
  }
  if (card.kind === 'fuse') {
    const a = world?.crafting?.get(card.idA);
    const b = world?.crafting?.get(card.idB);
    return Boolean(a && b && a.tier === b.tier);
  }
  return false;
}

/** Offerable ability module ids (excludes Blink starter). */
export function abilityOfferPool(abilityModules) {
  const list = abilityModules?.modules ?? abilityModules;
  if (!list) return [];
  const arr = list instanceof Map ? [...list.values()] : list;
  return arr
    .filter((m) => m && m.id && m.id !== 'blink' && m.offerable !== false)
    .map((m) => m.id);
}

/**
 * Build N Offer cards. Guarantees ≥1 applicable card.
 * Fill knobs (dna_patterns.offers): top up DNA to fill unlocked seats; respect room.
 * @returns {object[]}
 */
export function rollOfferCards({
  n = 3,
  stream,
  fragmentIds = [],
  abilityIds = [],
  world = null,
  pressure = 0,
  pressureCfg = null,
  fill = null
}) {
  const cards = [];
  const frags = [...fragmentIds];
  const abs = [...abilityIds];
  const offerCfg = {
    abilityWeight: 0.22,
    fuseWeight: 0.1,
    minDnaWeightWhenFilling: 0.55,
    guaranteedDnaWhenNeed: true,
    ...(pressureCfg ?? {}),
    ...(fill?.knobs ?? {})
  };

  const takeFrag = () => {
    if (frags.length === 0) return null;
    const i = stream.int(0, frags.length - 1);
    return frags.splice(i, 1)[0];
  };
  const peekFragPair = () => {
    if (fragmentIds.length < 1) return null;
    const pool = fragmentIds.length ? fragmentIds : frags;
    if (pool.length === 0) return null;
    const idA = stream.pick(pool);
    const idB = stream.pick(pool);
    return { idA, idB };
  };
  const takeAbility = () => {
    if (abs.length === 0) return null;
    const i = stream.int(0, abs.length - 1);
    return abs.splice(i, 1)[0];
  };

  const need = Math.max(0, Number(fill?.need ?? 0) || 0);
  const room = Math.max(0, Number(fill?.room ?? 99) || 0);
  const fillSeats = fill?.fillUnlockedSeats !== false;
  let dnaBudget = fillSeats ? Math.min(need, room, n) : Math.min(2, n);

  // Guarantee DNA to fill empty unlocked seats (tunable).
  if (fragmentIds.length > 0 && offerCfg.guaranteedDnaWhenNeed !== false && dnaBudget > 0) {
    while (cards.length < dnaBudget && cards.length < n) {
      const id = takeFrag() ?? stream.pick(fragmentIds);
      cards.push({ kind: 'dna', id });
    }
  } else if (fragmentIds.length === 0 && abilityIds.length > 0 && cards.length === 0) {
    const id = takeAbility() ?? stream.pick(abilityIds);
    cards.push({ kind: 'ability', id });
  }

  while (cards.length < n) {
    const roll = stream.float();
    const p = Math.max(0, Number(pressure) || 0);
    let abilityW = (offerCfg.abilityWeight ?? 0.22) + p * (offerCfg.abilityBonusPerPressure ?? 0.003);
    let fuseW = (offerCfg.fuseWeight ?? 0.1) + p * (offerCfg.fuseBonusPerPressure ?? 0.0015);
    abilityW = Math.min(abilityW, offerCfg.maxAbilityWeight ?? 0.4);
    fuseW = Math.min(fuseW, offerCfg.maxFuseWeight ?? 0.2);
    // Still filling seats → keep DNA weight high; at cap → allow more utility
    const stillNeed = fillSeats && cards.filter((c) => c.kind === 'dna').length < need && room > cards.filter((c) => c.kind === 'dna').length;
    let dnaW = stillNeed
      ? Math.max(offerCfg.minDnaWeightWhenFilling ?? 0.55, 1 - abilityW - fuseW)
      : Math.max(0.15, 1 - abilityW - fuseW);
    if (room <= 0 || (fillSeats && need <= 0 && room <= 0)) {
      dnaW = 0.05;
      abilityW = Math.min(0.55, abilityW + 0.2);
      fuseW = Math.min(0.35, fuseW + 0.1);
    }
    const sum = dnaW + abilityW + fuseW;
    dnaW /= sum;
    abilityW /= sum;
    fuseW /= sum;
    const tAbility = dnaW;
    const tFuse = dnaW + abilityW;
    let kind = 'dna';
    if (roll >= tFuse) kind = 'fuse';
    else if (roll >= tAbility) kind = 'ability';

    if (kind === 'dna' && fragmentIds.length > 0 && room > cards.filter((c) => c.kind === 'dna').length) {
      const id = takeFrag() ?? stream.pick(fragmentIds);
      cards.push({ kind: 'dna', id });
      continue;
    }
    if (kind === 'ability' && abilityIds.length > 0) {
      const id = takeAbility() ?? stream.pick(abilityIds);
      cards.push({ kind: 'ability', id });
      continue;
    }
    if (kind === 'fuse' && fragmentIds.length > 0) {
      const pair = peekFragPair();
      if (pair && isOfferApplicable({ kind: 'fuse', ...pair }, world)) {
        cards.push({ kind: 'fuse', id: `${pair.idA}+${pair.idB}`, ...pair });
        continue;
      }
    }
    if (abilityIds.length > 0) {
      cards.push({ kind: 'ability', id: takeAbility() ?? stream.pick(abilityIds) });
    } else if (fragmentIds.length > 0 && room > cards.filter((c) => c.kind === 'dna').length) {
      cards.push({ kind: 'dna', id: takeFrag() ?? stream.pick(fragmentIds) });
    } else if (fragmentIds.length > 0) {
      // At inventory cap — still need a card; prefer ability else skip DNA flood
      const pair = peekFragPair();
      if (pair && isOfferApplicable({ kind: 'fuse', ...pair }, world)) {
        cards.push({ kind: 'fuse', id: `${pair.idA}+${pair.idB}`, ...pair });
      } else {
        break;
      }
    } else {
      break;
    }
  }

  if (cards.length > 0 && world && !cards.some((c) => isOfferApplicable(c, world))) {
    if (fragmentIds.length > 0 && room > 0) {
      cards[0] = { kind: 'dna', id: stream.pick(fragmentIds) };
    } else if (abilityIds.length > 0) {
      cards[0] = { kind: 'ability', id: stream.pick(abilityIds) };
    }
  }

  return cards;
}

/** Normalize legacy string offers and card offers to a display id. */
export function offerCardId(card) {
  if (card == null) return null;
  if (typeof card === 'string') return card;
  if (card.kind === 'fuse') return card.id ?? `${card.idA}+${card.idB}`;
  return card.id ?? null;
}

export function offerCardKind(card) {
  if (card == null) return null;
  if (typeof card === 'string') return 'dna'; // legacy fragment-only offers
  return card.kind ?? 'dna';
}

/**
 * Day 082 — Gaben: non-DPS axes first (knockback, pierce, status, tags).
 * DPS may appear but must not be the only readable signal.
 * @returns {{ key: string, label: string, value: string }[]}
 */
export function offerAxes(el, { max = 5 } = {}) {
  if (!el) return [];
  const axes = [];
  const stats = el.stats ?? {};
  const tags = el.tags ?? [];
  const effects = el.effects ?? [];

  if (stats.knockback != null && Number(stats.knockback) !== 0) {
    axes.push({ key: 'knockback', label: 'KB', value: String(Math.round(stats.knockback)) });
  }
  const pierceFx = effects.find((e) => e.effect === 'pierce');
  if (pierceFx || tags.includes('pierce')) {
    axes.push({
      key: 'pierce',
      label: 'pierce',
      value: pierceFx ? String(pierceFx.pierces ?? 1) : 'tag'
    });
  }
  const chainFx = effects.find((e) => e.effect === 'chain');
  if (chainFx || tags.includes('shock')) {
    axes.push({
      key: 'chain',
      label: 'chain',
      value: chainFx ? String(chainFx.jumps ?? 1) : 'on'
    });
  }
  for (const name of ['chill', 'burn', 'poison', 'stagger']) {
    const fx = effects.find((e) => e.effect === name);
    if (fx || tags.includes(name)) axes.push({ key: name, label: name, value: 'on' });
  }
  const healFx = effects.find((e) => e.effect === 'heal_on_hit');
  if (healFx || tags.includes('vitality')) {
    axes.push({
      key: 'heal',
      label: 'heal',
      value: healFx ? String(healFx.heal ?? 2) : 'on'
    });
  }
  if (stats.range != null) {
    axes.push({ key: 'range', label: 'rng', value: String(Math.round(stats.range)) });
  }
  for (const tag of tags) {
    if (axes.length >= max) break;
    if (tag === 'pierce') continue; // already surfaced
    if (!axes.some((a) => a.key === `tag:${tag}` || a.key === tag)) {
      axes.push({ key: `tag:${tag}`, label: tag, value: '' });
    }
  }
  // Guarantee ≥2 readable lines when possible (pad with tier / cooldown as non-DPS)
  if (axes.length < 2 && el.tier != null) {
    axes.push({ key: 'tier', label: 'tier', value: String(el.tier) });
  }
  if (axes.length < 2 && stats.cooldown != null) {
    axes.push({ key: 'cd', label: 'cd', value: `${Number(stats.cooldown).toFixed(1)}s` });
  }
  return axes.slice(0, max);
}

/** Ability module axes — archetype / control knobs, never DPS-only. */
export function abilityAxes(mod, { max = 4 } = {}) {
  if (!mod) return [];
  const axes = [];
  if (mod.archetype) axes.push({ key: 'archetype', label: mod.archetype, value: '' });
  if (mod.knockback != null && Number(mod.knockback) !== 0) {
    axes.push({ key: 'knockback', label: 'KB', value: String(Math.round(mod.knockback)) });
  }
  if (mod.absorb != null) axes.push({ key: 'absorb', label: 'absorb', value: String(mod.absorb) });
  if (mod.force != null) axes.push({ key: 'force', label: 'pull', value: String(Math.round(mod.force)) });
  if (mod.radius != null) axes.push({ key: 'radius', label: 'r', value: String(Math.round(mod.radius)) });
  for (const tag of mod.tags ?? []) {
    if (axes.length >= max) break;
    axes.push({ key: `tag:${tag}`, label: tag, value: '' });
  }
  if (axes.length < 2 && mod.cooldown != null) {
    axes.push({ key: 'cd', label: 'cd', value: `${Number(mod.cooldown).toFixed(1)}s` });
  }
  return axes.slice(0, max);
}

const TAG_FANTASY = {
  heat: 'Ignites the wound',
  cold: 'Freezes the lane',
  flow: 'Washes foes aside',
  mass: 'Crushes through mass',
  air: 'Cuts on a breath',
  shock: 'Chains the current',
  pierce: 'Threads straight through',
  toxic: 'Seeds a slow death',
  vitality: 'Drinks a drop of life',
  gravity: 'Pulls the room in'
};

const ARCHETYPE_FANTASY = {
  mobility: 'Slip the hit',
  defense: 'Hold the line',
  control: 'Reorder the field',
  offense: 'Burst the cluster'
};

/**
 * Day 109 — fantasy tagline leads the card; numbers stay honest below.
 * Never hides DPS/stats (those remain on the card body).
 */
export function offerFantasyLine(card, world) {
  const kind = offerCardKind(card);
  if (kind === 'ability') {
    const mod = moduleById(world?.abilityModules, card.id);
    if (!mod) return 'Ability module';
    if (mod.fantasy) return mod.fantasy;
    const arch = ARCHETYPE_FANTASY[mod.archetype] ?? mod.archetype ?? 'Cast';
    return `${arch} — ${mod.name ?? card.id}`;
  }
  if (kind === 'fuse') {
    return 'Equal-tier splice — rewrite the Attack';
  }
  const id = offerCardId(card);
  const el = world?.crafting?.get(id);
  if (!el) return 'DNA chip';
  if (el.fantasy) return el.fantasy;
  const tag = (el.tags ?? [])[0];
  const vibe = TAG_FANTASY[tag] ?? (tag ? `${tag} strand` : 'Gene scrap');
  return `${vibe}`;
}

/**
 * Honest numeric summary — always available (Day 109: no fog / no wiki-bait hide).
 * @returns {string}
 */
export function offerHonestNumbers(card, world) {
  const kind = offerCardKind(card);
  if (kind === 'ability') {
    const mod = moduleById(world?.abilityModules, card.id);
    if (!mod) return '';
    const parts = [];
    if (mod.cooldown != null) parts.push(`cd ${Number(mod.cooldown).toFixed(1)}s`);
    if (mod.absorb != null) parts.push(`abs ${mod.absorb}`);
    if (mod.radius != null) parts.push(`r ${Math.round(mod.radius)}`);
    if (mod.force != null) parts.push(`pull ${Math.round(mod.force)}`);
    return parts.join(' · ');
  }
  if (kind === 'fuse') {
    const a = world?.crafting?.get(card.idA);
    const b = world?.crafting?.get(card.idB);
    const da = a?.stats?.damage;
    const db = b?.stats?.damage;
    if (da != null && db != null) return `dmg ${da}+${db} · equal-tier`;
    return 'equal-tier splice';
  }
  const el = world?.crafting?.get(offerCardId(card));
  if (!el?.stats) return '';
  const s = el.stats;
  const parts = [];
  if (s.damage != null) parts.push(`dmg ${s.damage}`);
  const healFx = el.effects?.find((e) => e.effect === 'heal_on_hit');
  if (healFx && Number(healFx.heal) > 0) parts.push(`+${healFx.heal}/hit`);
  const pierceFx = el.effects?.find((e) => e.effect === 'pierce');
  if (pierceFx) parts.push(`pierce ${pierceFx.pierces ?? 1}`);
  else if ((el.tags ?? []).includes('pierce')) parts.push('pierce');
  const chainFx = el.effects?.find((e) => e.effect === 'chain');
  if (chainFx) parts.push(`chain ${chainFx.jumps ?? 1}`);
  else if ((el.tags ?? []).includes('shock')) parts.push('chain');
  if (s.cooldown != null) parts.push(`cd ${Number(s.cooldown).toFixed(1)}s`);
  if (s.knockback != null && Number(s.knockback) !== 0) parts.push(`KB ${Math.round(s.knockback)}`);
  return parts.join(' · ');
}

/**
 * Day 245 — Lab pedestal heal honesty (on-hit amount + connect cost).
 * @returns {string}
 */
export function offerHealCallout(card, world) {
  const kind = offerCardKind(card);
  if (kind !== 'dna') return '';
  const el = world?.crafting?.get(offerCardId(card));
  const healFx = el?.effects?.find((e) => e.effect === 'heal_on_hit');
  if (!healFx || !(Number(healFx.heal) > 0)) return '';
  return `+${healFx.heal}/hit · ON CONNECT`;
}

/**
 * Day 251 — Lab pedestal pierce honesty (control axis before take, not DPS vanity).
 * @returns {string}
 */
export function offerPierceCallout(card, world) {
  const kind = offerCardKind(card);
  if (kind !== 'dna') return '';
  const el = world?.crafting?.get(offerCardId(card));
  if (!el) return '';
  const pierceFx = el.effects?.find((e) => e.effect === 'pierce');
  if (pierceFx) {
    return `pierce ${pierceFx.pierces ?? 1} · THROUGH`;
  }
  if ((el.tags ?? []).includes('pierce')) {
    return 'pierce · ON SEAT';
  }
  return '';
}

/**
 * Day 259 — Lab pedestal chain honesty (control axis before take, not DPS vanity).
 * @returns {string}
 */
export function offerChainCallout(card, world) {
  const kind = offerCardKind(card);
  if (kind !== 'dna') return '';
  const el = world?.crafting?.get(offerCardId(card));
  if (!el) return '';
  const chainFx = el.effects?.find((e) => e.effect === 'chain');
  if (chainFx) {
    return `chain ${chainFx.jumps ?? 1} · ARC`;
  }
  if ((el.tags ?? []).includes('shock')) {
    return 'chain · ON SEAT';
  }
  return '';
}

/**
 * Day 254 — Lab pedestal knockback honesty (control axis before take, not DPS vanity).
 * @returns {string}
 */
export function offerKnockbackCallout(card, world) {
  const kind = offerCardKind(card);
  if (kind !== 'dna') return '';
  const el = world?.crafting?.get(offerCardId(card));
  const kb = el?.stats?.knockback;
  if (kb == null || Number(kb) === 0) return '';
  return `KB ${Math.round(kb)} · PUSH`;
}

/**
 * Resolve display axes for any Offer card (dna / ability / fuse).
 * @returns {{ key: string, label: string, value: string }[]}
 */
export function offerCardAxes(card, world, { max = 3 } = {}) {
  const kind = offerCardKind(card);
  if (kind === 'ability') {
    const mod = moduleById(world?.abilityModules, card.id);
    return abilityAxes(mod, { max });
  }
  if (kind === 'fuse') {
    const a = world?.crafting?.get(card.idA);
    const b = world?.crafting?.get(card.idB);
    const merged = offerAxes(a, { max: max + 2 }).concat(offerAxes(b, { max: max + 2 }));
    const seen = new Set();
    const out = [];
    for (const ax of merged) {
      if (seen.has(ax.key)) continue;
      seen.add(ax.key);
      out.push(ax);
      if (out.length >= max) break;
    }
    if (out.length < 2) {
      out.push({ key: 'fuse', label: 'equal-tier', value: 'splice' });
    }
    return out.slice(0, max);
  }
  // dna / legacy string
  const id = offerCardId(card);
  const el = world?.crafting?.get(id);
  return offerAxes(el, { max });
}

/** True if axes list is not DPS-only (Day 082 Done-when). */
export function offerAxesReadable(axes) {
  if (!axes || axes.length < 2) return false;
  return axes.every((a) => a.key !== 'dps' && a.key !== 'damage');
}
