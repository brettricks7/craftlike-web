/**
 * systems/tag-secondary.js — presentation-only tag cues (Day 262).
 *
 * Determinism policy: consumed ONLY by renderer paths (projectile draw).
 * Layers on form motion; form identity stays primary. Day 263 combo
 * fingerprint layers via `ctx.fingerprint` knobs (rhythm + phase warp).
 */

import { fingerprintAnimT } from './combo-fingerprint.js';

/** @type {object|null} */
let runtimeCfg = null;

const TAU = Math.PI * 2;

const NEUTRAL_SECONDARY = {
  flicker: 1,
  pulseScale: 0,
  trailSegments: 0,
  wispSegments: 0,
  sparkDx: 0,
  sparkDy: 0,
  wakeAlpha: 0,
  trailWide: 1,
  tint: null
};

/** Live tags with secondary cues (≥5 for Day 262 gate). */
export const LIVE_TAG_IDS = [
  'heat', 'chill', 'shock', 'flow', 'pierce', 'toxic', 'mass', 'gravity', 'air', 'vitality'
];

export const DEFAULT_TAG_SECONDARY = {
  strength: 0.35,
  tags: {
    heat: {
      cue: 'flicker-trail', flickerHz: 16, flickerAmp: 0.14, trailSegments: 2,
      tint: [251, 146, 60]
    },
    chill: { cue: 'pulse', pulseHz: 5.5, pulseAmp: 0.1, tint: [125, 211, 252] },
    shock: {
      cue: 'flicker-jitter', flickerHz: 32, flickerAmp: 0.18, jitterAmp: 1.2,
      tint: [250, 204, 21]
    },
    flow: {
      cue: 'trail', trailSegments: 3, trailAlpha: 0.28, tint: [56, 189, 248]
    },
    pierce: {
      cue: 'glint', glintHz: 18, glintAmp: 0.16, trailSegments: 1, tint: [226, 232, 240]
    },
    toxic: { cue: 'wobble', wobbleHz: 9, wobbleAmp: 1.4, tint: [74, 222, 128] },
    mass: {
      cue: 'trail', trailSegments: 2, trailAlpha: 0.35, trailWide: 1.35,
      tint: [196, 163, 90]
    },
    gravity: { cue: 'droop', droopHz: 4, droopAmp: 2.0, tint: [168, 85, 247] },
    air: { cue: 'wisps', wispSegments: 2, wispAlpha: 0.22, tint: [186, 230, 253] },
    vitality: { cue: 'pulse', pulseHz: 7, pulseAmp: 0.09, tint: [52, 211, 153] }
  }
};

/** @param {object} [cfg] data/tag_secondary.json */
export function setTagSecondaryConfig(cfg) {
  runtimeCfg = cfg ?? null;
}

export function getTagSecondaryConfig() {
  return runtimeCfg ?? DEFAULT_TAG_SECONDARY;
}

/** Normalize cold → chill for secondary cues. */
export function normalizeTagId(tag) {
  if (!tag) return null;
  if (tag === 'cold') return 'chill';
  return tag;
}

/** Resolve dominant shot tag from element (shotTag or tags[]). */
export function resolveShotTag(element) {
  if (element?.shotTag) return normalizeTagId(element.shotTag);
  const tags = element?.tags ?? [];
  for (const id of LIVE_TAG_IDS) {
    if (tags.includes(id) || (id === 'chill' && tags.includes('cold'))) return id;
  }
  return null;
}

export function tagSecondaryKnobs(tag, cfg = getTagSecondaryConfig()) {
  const norm = normalizeTagId(tag);
  if (!norm) return null;
  const base = cfg?.tags?.[norm] ?? {};
  const defaults = DEFAULT_TAG_SECONDARY.tags[norm] ?? {};
  return { ...defaults, ...base };
}

function tintRgba(rgb, alpha = 0.55) {
  if (!rgb || rgb.length < 3) return null;
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

/**
 * Deterministic tag secondary sample for one projectile draw step.
 *
 * @param {string|null} tag normalized tag id
 * @param {number} animT seconds since spawn
 * @param {{ velAngle?: number, phase?: number, fingerprint?: number, muted?: boolean, strength?: number }} [ctx]
 */
export function tagSecondaryAt(tag, animT, ctx = {}) {
  if (ctx.muted || !tag) return { ...NEUTRAL_SECONDARY };

  const knobs = tagSecondaryKnobs(tag);
  if (!knobs) return { ...NEUTRAL_SECONDARY };

  const cfg = getTagSecondaryConfig();
  const strength = Number(ctx.strength ?? cfg.strength ?? 0.35);
  const t = fingerprintAnimT(animT, ctx.fingerprint);
  const phase = Number(ctx.phase) || 0;
  const velAngle = Number(ctx.velAngle) || 0;
  const tint = tintRgba(knobs.tint);

  switch (knobs.cue) {
    case 'flicker-trail': {
      const flicker = 1 - knobs.flickerAmp * strength
        * (0.5 + 0.5 * Math.sin(t * knobs.flickerHz * TAU));
      return {
        ...NEUTRAL_SECONDARY,
        flicker,
        trailSegments: knobs.trailSegments ?? 2,
        wakeAlpha: 0.25 * strength,
        tint
      };
    }
    case 'flicker-jitter': {
      const flicker = 1 - knobs.flickerAmp * strength
        * (0.5 + 0.5 * Math.sin(t * knobs.flickerHz * TAU + phase));
      const jit = knobs.jitterAmp * strength * Math.sin(t * knobs.flickerHz * TAU * 1.7);
      return {
        ...NEUTRAL_SECONDARY,
        flicker,
        sparkDx: -Math.sin(velAngle) * jit,
        sparkDy: Math.cos(velAngle) * jit,
        tint
      };
    }
    case 'pulse': {
      const pulseScale = knobs.pulseAmp * strength
        * Math.sin(t * knobs.pulseHz * TAU + phase);
      return { ...NEUTRAL_SECONDARY, pulseScale, tint };
    }
    case 'glint': {
      const phaseT = ((t * knobs.glintHz) % 1 + 1) % 1;
      const spike = phaseT < 0.12 ? 1 - phaseT / 0.12 : 0;
      const pulseScale = knobs.glintAmp * strength * spike;
      return {
        ...NEUTRAL_SECONDARY,
        pulseScale,
        trailSegments: knobs.trailSegments ?? 1,
        wakeAlpha: 0.18 * strength * spike,
        tint
      };
    }
    case 'trail': {
      return {
        ...NEUTRAL_SECONDARY,
        trailSegments: knobs.trailSegments ?? 2,
        wakeAlpha: (knobs.trailAlpha ?? 0.3) * strength,
        trailWide: knobs.trailWide ?? 1,
        tint
      };
    }
    case 'wobble': {
      const wob = knobs.wobbleAmp * strength * Math.sin(t * knobs.wobbleHz * TAU + phase);
      return {
        ...NEUTRAL_SECONDARY,
        sparkDx: -Math.sin(velAngle) * wob,
        sparkDy: Math.cos(velAngle) * wob,
        wakeAlpha: 0.15 * strength,
        tint
      };
    }
    case 'droop': {
      const droop = knobs.droopAmp * strength * Math.sin(t * knobs.droopHz * TAU + phase * 0.5);
      const perp = velAngle + Math.PI / 2;
      return {
        ...NEUTRAL_SECONDARY,
        sparkDx: Math.cos(perp) * droop * 0.3,
        sparkDy: Math.sin(perp) * droop * 0.3,
        wakeAlpha: 0.12 * strength,
        tint
      };
    }
    case 'wisps': {
      return {
        ...NEUTRAL_SECONDARY,
        wispSegments: knobs.wispSegments ?? 2,
        wakeAlpha: (knobs.wispAlpha ?? 0.22) * strength,
        tint
      };
    }
    default:
      return { ...NEUTRAL_SECONDARY };
  }
}

/** Flatten tag secondary into a signature vector for gate tests. */
export function sampleTagSecondarySignature(tag, cfg = getTagSecondaryConfig(), steps = 32, dt = 1 / 60) {
  const out = [];
  for (let i = 0; i < steps; i++) {
    const s = tagSecondaryAt(tag, i * dt, { velAngle: 0.4, phase: 0.7 });
    out.push(
      s.flicker, s.pulseScale, s.trailSegments, s.wispSegments,
      s.sparkDx, s.sparkDy, s.wakeAlpha, s.trailWide
    );
  }
  return out;
}

/**
 * Layered form+tag signature — used to prove form dominates tag at fight distance.
 */
export function sampleLayeredSignature(
  formId, tag, formCfg, tagCfg, steps = 32, dt = 1 / 60,
  formMotionAtFn, formMotionKnobsFn
) {
  const out = [];
  const knobs = formMotionKnobsFn(formId, formCfg);
  for (let i = 0; i < steps; i++) {
    const t = i * dt;
    const motion = formMotionAtFn(formId, t, knobs, { velAngle: 0.4, phase: 0.7 });
    const sec = tagSecondaryAt(tag, t, { velAngle: 0.4, phase: 0.7 });
    out.push(
      motion.dx, motion.dy, motion.scale, motion.stretch, motion.rotExtra,
      sec.flicker, sec.pulseScale, sec.sparkDx, sec.sparkDy, sec.wakeAlpha
    );
  }
  return out;
}

/** L2 distance between signature vectors. */
export function signatureDistance(a, b) {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * Assert live tags have pairwise-distinct secondary signatures.
 * @param {string[]} tagIds
 * @param {number} [minDist]
 */
export function assertPairwiseDistinctTagSecondaries(
  tagIds = LIVE_TAG_IDS.slice(0, 5),
  cfg = getTagSecondaryConfig(),
  minDist = 0.35
) {
  const sigs = {};
  for (const id of tagIds) {
    sigs[id] = sampleTagSecondarySignature(id, cfg);
  }
  const pairs = [];
  for (let i = 0; i < tagIds.length; i++) {
    for (let j = i + 1; j < tagIds.length; j++) {
      const a = tagIds[i];
      const b = tagIds[j];
      const dist = signatureDistance(sigs[a], sigs[b]);
      pairs.push({ a, b, dist });
      if (dist < minDist) {
        throw new Error(
          `tag secondary ${a} vs ${b} too similar (dist=${dist.toFixed(3)} < ${minDist})`
        );
      }
    }
  }
  return pairs;
}
