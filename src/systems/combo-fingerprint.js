/**
 * systems/combo-fingerprint.js — presentation-only hive tag-set fingerprint (Day 263).
 *
 * Determinism policy: consumed ONLY by renderer paths (projectile draw).
 * Layers on form motion + tag secondary. Same (seed, tag set) → same look;
 * different tag sets → wildly different procedural identity at fight distance.
 */

import { hashString, RandomStream } from '../core/rng.js';
import { normalizeTagId } from './tag-secondary.js';
import { formMotionAt, formMotionKnobs } from './form-motion.js';
import { tagSecondaryAt } from './tag-secondary.js';

const TAU = Math.PI * 2;

/** Curated single-hue accents — no rainbow mud. */
const ACCENT_PALETTE = [
  [251, 146, 60], [125, 211, 252], [250, 204, 21], [56, 189, 248],
  [226, 232, 240], [74, 222, 128], [196, 163, 90], [168, 85, 247],
  [52, 211, 153], [244, 114, 182]
];

export const DEFAULT_COMBO_FINGERPRINT = {
  strength: 0.78,
  orbitAmpMin: 8,
  orbitAmpMax: 10.5,
  orbitHzMin: 4,
  orbitHzMax: 10,
  rhythmMin: 0.72,
  rhythmMax: 1.48,
  stripeAmpMin: 0.2,
  stripeAmpMax: 0.38,
  stripeHzMin: 10,
  stripeHzMax: 22,
  scaleBiasMin: 0.88,
  scaleBiasMax: 1.14,
  stretchBiasMin: 0.9,
  stretchBiasMax: 1.12,
  accentWashAlpha: 0.36
};

/** @type {object|null} */
let runtimeCfg = null;

/** @param {object} [cfg] data/combo_fingerprint.json */
export function setComboFingerprintConfig(cfg) {
  runtimeCfg = cfg ?? null;
}

export function getComboFingerprintConfig() {
  return runtimeCfg ?? DEFAULT_COMBO_FINGERPRINT;
}

/** Sorted unique tag ids from element tags, hexBonds, and shotTag. */
export function resolveTagSet(element) {
  const tags = new Set();
  for (const t of element?.tags ?? []) {
    const n = normalizeTagId(t);
    if (n) tags.add(n);
  }
  for (const [t, count] of Object.entries(element?.hexBonds ?? {})) {
    if (Number(count) > 0) {
      const n = normalizeTagId(t);
      if (n) tags.add(n);
    }
  }
  if (element?.shotTag) {
    const n = normalizeTagId(element.shotTag);
    if (n) tags.add(n);
  }
  return [...tags].sort();
}

/** Stable identity key for a tag set (order-independent). */
export function tagSetKey(tagSet) {
  const sorted = [...(tagSet ?? [])].filter(Boolean).sort();
  return sorted.length ? sorted.join('+') : 'neutral';
}

/**
 * Deterministic fingerprint knobs from run seed + sorted tag set.
 * @param {string[]} tagSet
 * @param {string} seed
 * @param {object} [cfg]
 */
export function comboFingerprintKnobs(tagSet, seed, cfg = getComboFingerprintConfig()) {
  const key = tagSetKey(tagSet);
  if (key === 'neutral') {
    return {
      key,
      strength: 0,
      orbitAmp: 0,
      orbitHz: 6,
      rhythmMul: 1,
      phaseOffset: 0,
      stripeAmp: 0,
      stripeHz: 14,
      scaleBias: 1,
      stretchBias: 1,
      accent: null,
      orbitHandedness: 1,
      accentWashAlpha: 0
    };
  }

  const rnd = new RandomStream(hashString(`${seed}|combo_fp|${key}`));
  const strength = Number(cfg.strength ?? 0.55);
  return {
    key,
    strength,
    orbitAmp: rnd.float(cfg.orbitAmpMin ?? 2.8, cfg.orbitAmpMax ?? 5.5),
    orbitHz: rnd.float(cfg.orbitHzMin ?? 4, cfg.orbitHzMax ?? 10),
    rhythmMul: rnd.float(cfg.rhythmMin ?? 0.72, cfg.rhythmMax ?? 1.48),
    phaseOffset: rnd.float(0, TAU),
    stripeAmp: rnd.float(cfg.stripeAmpMin ?? 0.1, cfg.stripeAmpMax ?? 0.22),
    stripeHz: rnd.float(cfg.stripeHzMin ?? 10, cfg.stripeHzMax ?? 22),
    scaleBias: rnd.float(cfg.scaleBiasMin ?? 0.88, cfg.scaleBiasMax ?? 1.14),
    stretchBias: rnd.float(cfg.stretchBiasMin ?? 0.9, cfg.stretchBiasMax ?? 1.12),
    accent: ACCENT_PALETTE[rnd.int(0, ACCENT_PALETTE.length - 1)],
    orbitHandedness: rnd.chance(0.5) ? 1 : -1,
    accentWashAlpha: Number(cfg.accentWashAlpha ?? 0.18)
  };
}

const NEUTRAL_SAMPLE = {
  orbitDx: 0,
  orbitDy: 0,
  stripeMod: 1,
  scaleMul: 1,
  stretchMul: 1,
  accent: null,
  wakeAlpha: 0
};

/**
 * Per-frame fingerprint sample for one projectile draw step.
 * @param {number} animT seconds since spawn
 * @param {object|null} knobs from comboFingerprintKnobs
 * @param {{ velAngle?: number, muted?: boolean }} [ctx]
 */
export function comboFingerprintAt(animT, knobs, ctx = {}) {
  if (ctx.muted || !knobs?.key || knobs.key === 'neutral' || !knobs.strength) {
    return { ...NEUTRAL_SAMPLE };
  }

  const strength = knobs.strength ?? 0.55;
  const t = (Number(animT) || 0) * (knobs.rhythmMul ?? 1) + (knobs.phaseOffset ?? 0);
  const velAngle = Number(ctx.velAngle) || 0;
  const orbit = (knobs.orbitAmp ?? 3) * strength
    * Math.sin(t * (knobs.orbitHz ?? 6) * TAU) * (knobs.orbitHandedness ?? 1);
  const stripePhase = (t * (knobs.stripeHz ?? 14)) % 1;
  const stripeMod = 1 - (knobs.stripeAmp ?? 0.15) * strength
    * (0.5 + 0.5 * Math.sin(stripePhase * TAU * 2));

  return {
    orbitDx: -Math.sin(velAngle) * orbit,
    orbitDy: Math.cos(velAngle) * orbit,
    stripeMod,
    scaleMul: 1 + ((knobs.scaleBias ?? 1) - 1) * strength,
    stretchMul: 1 + ((knobs.stretchBias ?? 1) - 1) * strength,
    accent: knobs.accent,
    wakeAlpha: (knobs.accentWashAlpha ?? 0.18) * strength
      * (0.5 + 0.5 * Math.sin(t * 5 * TAU))
  };
}

/** Timing warp shared by form motion + tag secondary when fingerprint present. */
export function fingerprintAnimT(animT, fingerprint) {
  if (!fingerprint?.key || fingerprint.key === 'neutral' || !fingerprint.strength) {
    return Number(animT) || 0;
  }
  return (Number(animT) || 0) * (fingerprint.rhythmMul ?? 1) + (fingerprint.phaseOffset ?? 0);
}

/** Flatten fingerprint samples into a signature vector for gate tests. */
export function sampleComboFingerprintSignature(
  tagSet, seed, cfg = getComboFingerprintConfig(), steps = 32, dt = 1 / 60
) {
  const knobs = comboFingerprintKnobs(tagSet, seed, cfg);
  const out = [];
  for (let i = 0; i < steps; i++) {
    const s = comboFingerprintAt(i * dt, knobs, { velAngle: 0.4, phase: 0.7 });
    out.push(
      s.orbitDx, s.orbitDy, s.stripeMod, s.scaleMul, s.stretchMul, s.wakeAlpha
    );
  }
  return out;
}

/**
 * Full layered signature — form + tag + combo fingerprint.
 * @param {string} formId
 * @param {string|null} tag
 * @param {string[]} tagSet
 * @param {string} seed
 */
export function sampleFullShotSignature(
  formId,
  tag,
  tagSet,
  seed,
  formCfg,
  tagCfg,
  fpCfg = getComboFingerprintConfig(),
  steps = 32,
  dt = 1 / 60
) {
  const fpKnobs = comboFingerprintKnobs(tagSet, seed, fpCfg);
  const motionKnobs = formMotionKnobs(formId, formCfg);
  const out = [];
  for (let i = 0; i < steps; i++) {
    const t = i * dt;
    const ctx = { velAngle: 0.4, phase: 0.7, fingerprint: fpKnobs };
    const motion = formMotionAt(formId, t, motionKnobs, ctx);
    const sec = tagSecondaryAt(tag, t, ctx);
    const fp = comboFingerprintAt(t, fpKnobs, ctx);
    out.push(
      motion.dx, motion.dy, motion.scale, motion.stretch, motion.rotExtra,
      sec.flicker, sec.pulseScale, sec.sparkDx, sec.sparkDy, sec.wakeAlpha,
      fp.orbitDx, fp.orbitDy, fp.stripeMod, fp.scaleMul, fp.stretchMul, fp.wakeAlpha
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
 * Assert divergent hive tag sets produce wildly distinct full-shot signatures.
 * @param {Array<{ id: string, tagSet: string[], seed: string, formId?: string, tag?: string }>} hives
 * @param {number} [minDist]
 */
export function assertWildlyDistinctHiveFingerprints(
  hives,
  formCfg,
  tagCfg,
  fpCfg = getComboFingerprintConfig(),
  minDist = 2.8
) {
  const sigs = {};
  for (const h of hives) {
    sigs[h.id] = sampleFullShotSignature(
      h.formId ?? 'bolt',
      h.tag ?? h.tagSet[0] ?? null,
      h.tagSet,
      h.seed,
      formCfg,
      tagCfg,
      fpCfg
    );
  }
  const pairs = [];
  for (let i = 0; i < hives.length; i++) {
    for (let j = i + 1; j < hives.length; j++) {
      const a = hives[i].id;
      const b = hives[j].id;
      const dist = signatureDistance(sigs[a], sigs[b]);
      pairs.push({ a, b, dist });
      if (dist < minDist) {
        throw new Error(
          `hive fingerprint ${a} vs ${b} too similar (dist=${dist.toFixed(3)} < ${minDist})`
        );
      }
    }
  }
  return pairs;
}
