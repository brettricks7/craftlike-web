/**
 * systems/form-motion.js — presentation-only procedural shot motion (Day 261).
 *
 * Determinism policy: consumed ONLY by renderer paths (projectile draw).
 * src/world.js never imports this. Tag secondary (Day 262) layers in
 * tag-secondary.js + projectile draw. Combo fingerprint (Day 263) via
 * `ctx.fingerprint` knobs (rhythm + phase warp).
 */

import { fingerprintAnimT } from './combo-fingerprint.js';

/** @type {object|null} */
let runtimeCfg = null;

export const DEFAULT_FORM_MOTION = {
  forms: {
    bolt: { bobAmp: 2.2, bobHz: 14, scalePulse: 0.08, scaleHz: 12 },
    beam: {
      stretchBase: 2.65, stretchPulse: 0.16, stretchHz: 22,
      trailSegments: 3, thicknessRatio: 0.38
    },
    spray: { flutterAmp: 3.8, flutterHz: 28, scalePulse: 0.14, scaleHz: 18, squash: 0.82 },
    rocket: {
      corkscrewAmp: 5.5, corkscrewHz: 6, spinHz: 4.5,
      exhaustSegments: 2, stretch: 1.35
    }
  }
};

export const SHOT_FORM_IDS = ['bolt', 'beam', 'spray', 'rocket'];

/** @param {object} [cfg] data/form_motion.json */
export function setFormMotionConfig(cfg) {
  runtimeCfg = cfg ?? null;
}

export function getFormMotionConfig() {
  return runtimeCfg ?? DEFAULT_FORM_MOTION;
}

/** Resolve delivery form id from an Attack element or projectile payload. */
export function resolveShotFormId(element) {
  const form = element?.form;
  if (form === 'beam' || form === 'spray' || form === 'rocket') return form;
  return 'bolt';
}

/** Merge data knobs with built-in defaults for one form. */
export function formMotionKnobs(formId, cfg = getFormMotionConfig()) {
  const base = cfg?.forms?.[formId] ?? {};
  const defaults = DEFAULT_FORM_MOTION.forms[formId] ?? {};
  return { ...defaults, ...base };
}

const TAU = Math.PI * 2;

function perpOffset(wobble, velAngle) {
  return {
    dx: -Math.sin(velAngle) * wobble,
    dy: Math.cos(velAngle) * wobble
  };
}

/**
 * Deterministic in-flight motion sample for one projectile draw step.
 *
 * @param {string} formId bolt | beam | spray | rocket
 * @param {number} animT seconds since spawn
 * @param {object} knobs merged form knobs
 * @param {{ velAngle?: number, phase?: number, tag?: string|null, fingerprint?: number, muted?: boolean }} [ctx]
 * @returns {{
 *   dx: number, dy: number, scale: number, stretch: number, rotExtra: number,
 *   thickness: number, trailSegments: number, exhaustSegments: number
 * }}
 */
export function formMotionAt(formId, animT, knobs, ctx = {}) {
  const velAngle = Number(ctx.velAngle) || 0;
  const phase = Number(ctx.phase) || 0;
  const t = fingerprintAnimT(animT, ctx.fingerprint);

  if (ctx.muted) {
    return {
      dx: 0, dy: 0, scale: 1, stretch: 1, rotExtra: 0,
      thickness: 1, trailSegments: 0, exhaustSegments: 0
    };
  }

  switch (formId) {
    case 'beam': {
      const pulse = 1 + knobs.stretchPulse * Math.sin(t * knobs.stretchHz);
      const stretch = knobs.stretchBase * pulse;
      return {
        dx: 0,
        dy: 0,
        scale: 1,
        stretch,
        rotExtra: 0,
        thickness: knobs.thicknessRatio,
        trailSegments: knobs.trailSegments ?? 3,
        exhaustSegments: 0
      };
    }
    case 'spray': {
      const wobble = knobs.flutterAmp * Math.sin(t * knobs.flutterHz * TAU + phase);
      const { dx, dy } = perpOffset(wobble, velAngle);
      const scale = 1 + knobs.scalePulse * Math.sin(t * knobs.scaleHz * TAU + phase * 0.5);
      return {
        dx, dy, scale, stretch: knobs.squash ?? 0.82, rotExtra: 0,
        thickness: 1, trailSegments: 0, exhaustSegments: 0
      };
    }
    case 'rocket': {
      const wobble = knobs.corkscrewAmp * Math.sin(t * knobs.corkscrewHz * TAU + phase);
      const { dx, dy } = perpOffset(wobble, velAngle);
      const rotExtra = knobs.spinHz * TAU * 0.08 * Math.sin(t * knobs.spinHz * TAU);
      return {
        dx, dy,
        scale: 1,
        stretch: knobs.stretch ?? 1.35,
        rotExtra,
        thickness: 0.55,
        trailSegments: 0,
        exhaustSegments: knobs.exhaustSegments ?? 2
      };
    }
    default: {
      const wobble = knobs.bobAmp * Math.sin(t * knobs.bobHz * TAU + phase);
      const { dx, dy } = perpOffset(wobble, velAngle);
      const scale = 1 + knobs.scalePulse * Math.sin(t * knobs.scaleHz * TAU);
      return {
        dx, dy, scale, stretch: 1, rotExtra: 0,
        thickness: 1, trailSegments: 0, exhaustSegments: 0
      };
    }
  }
}

/**
 * Flatten motion samples into a signature vector for gate tests.
 * @param {string} formId
 * @param {object} [cfg]
 * @param {number} [steps]
 * @param {number} [dt]
 */
export function sampleFormMotionSignature(formId, cfg = getFormMotionConfig(), steps = 32, dt = 1 / 60) {
  const knobs = formMotionKnobs(formId, cfg);
  const out = [];
  for (let i = 0; i < steps; i++) {
    const m = formMotionAt(formId, i * dt, knobs, { velAngle: 0, phase: 0.7 });
    out.push(m.dx, m.dy, m.scale, m.stretch, m.rotExtra);
  }
  return out;
}

/** L2 distance between two motion signatures. */
export function motionSignatureDistance(a, b) {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * Assert all four forms have pairwise-distinct flight motion signatures.
 * @param {object} [cfg]
 * @param {number} [minDist] minimum L2 distance between any pair
 */
export function assertPairwiseDistinctFormMotion(cfg = getFormMotionConfig(), minDist = 2.5) {
  const sigs = {};
  for (const id of SHOT_FORM_IDS) {
    sigs[id] = sampleFormMotionSignature(id, cfg);
  }
  const pairs = [];
  for (let i = 0; i < SHOT_FORM_IDS.length; i++) {
    for (let j = i + 1; j < SHOT_FORM_IDS.length; j++) {
      const a = SHOT_FORM_IDS[i];
      const b = SHOT_FORM_IDS[j];
      const dist = motionSignatureDistance(sigs[a], sigs[b]);
      pairs.push({ a, b, dist });
      if (dist < minDist) {
        throw new Error(
          `form motion ${a} vs ${b} too similar (dist=${dist.toFixed(3)} < ${minDist})`
        );
      }
    }
  }
  return pairs;
}
