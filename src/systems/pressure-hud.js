/**
 * systems/pressure-hud.js — pressure risk bands (Day 225).
 *
 * Surfaces existing map.pressure + pressureEffects as pick-moment bands.
 * No new pressure math — route cards show band shift + post-commit threat.
 */

import { projectedPressure } from './routes.js';

/** Bob chrome hook — band palette + labels without touching sim knobs. */
export const PRESSURE_DIAL = {
  /** Band upper bounds (exclusive) on the BP scale; last band ends at overpressure. */
  bandBounds: [35, 70],
  bands: {
    cool: { label: 'COOL', fill: '#5bc8ff', track: 'rgba(91,200,255,0.22)' },
    stable: { label: 'STABLE', fill: '#52b788', track: 'rgba(82,183,136,0.22)' },
    hot: { label: 'HOT', fill: '#ffd166', track: 'rgba(255,209,102,0.22)' },
    overpressure: { label: 'OVERPRESS', fill: '#e63946', track: 'rgba(230,57,70,0.28)' }
  },
  thresholdMarker: '#e63946',
  pickFooterColor: '#9ab'
};

/** Normalized fill on the HUD bar (0..1). */
export function pressureBarPct(mapData, pressure) {
  const pr = mapData.pressure;
  return (pressure - pr.min) / (pr.max - pr.min);
}

/** Normalized overpressure threshold tick on the HUD bar (0..1). */
export function pressureThresholdPct(mapData) {
  const pr = mapData.pressure;
  const op = mapData.pressureEffects.overpressureThreshold;
  return (op - pr.min) / (pr.max - pr.min);
}

/**
 * Chamber threat multiplier from current BP alone (route intensity × this = Threat line).
 * Same pressure term as chamberIntensity().
 */
export function pressureThreatMult(mapData, pressure) {
  const pe = mapData.pressureEffects;
  return 1 + (pressure - mapData.pressure.start) * pe.intensityPerPoint;
}

/** Risk tier for HUD chrome — mirrors legacy bar color breakpoints. */
export function pressureRiskTier(mapData, pressure) {
  const op = mapData.pressureEffects.overpressureThreshold;
  const { bands, bandBounds } = PRESSURE_DIAL;
  if (pressure >= op) return { id: 'overpressure', ...bands.overpressure };
  if (pressure < bandBounds[0]) return { id: 'cool', ...bands.cool };
  if (pressure < bandBounds[1]) return { id: 'stable', ...bands.stable };
  return { id: 'hot', ...bands.hot };
}

/** Band segments for the bar track (start/end in BP, not normalized). */
export function pressureBandSegments(mapData) {
  const pr = mapData.pressure;
  const op = mapData.pressureEffects.overpressureThreshold;
  const [coolMax, stableMax] = PRESSURE_DIAL.bandBounds;
  const { bands } = PRESSURE_DIAL;
  return [
    { id: 'cool', from: pr.min, to: coolMax, ...bands.cool },
    { id: 'stable', from: coolMax, to: stableMax, ...bands.stable },
    { id: 'hot', from: stableMax, to: op, ...bands.hot },
    { id: 'overpressure', from: op, to: pr.max, ...bands.overpressure }
  ];
}

/** Headless-friendly dial snapshot for render + tests. */
export function pressureDialMeta(mapData, pressure) {
  const tier = pressureRiskTier(mapData, pressure);
  return {
    pressure,
    barPct: pressureBarPct(mapData, pressure),
    thresholdPct: pressureThresholdPct(mapData),
    overpressureThreshold: mapData.pressureEffects.overpressureThreshold,
    threatMult: pressureThreatMult(mapData, pressure),
    bands: pressureBandSegments(mapData).map((b) => b.id),
    tier: { id: tier.id, label: tier.label }
  };
}

function tierSnapshot(tier) {
  return { id: tier.id, label: tier.label, fill: tier.fill };
}

/** Route-pick band shift — how this vessel changes risk after commit. */
export function routePressurePick(mapData, currentPressure, pressureDelta) {
  const afterPressure = projectedPressure(mapData, currentPressure, pressureDelta);
  const nowTier = pressureRiskTier(mapData, currentPressure);
  const afterTier = pressureRiskTier(mapData, afterPressure);
  return {
    nowPressure: currentPressure,
    afterPressure,
    now: tierSnapshot(nowTier),
    after: tierSnapshot(afterTier),
    shiftsBand: nowTier.id !== afterTier.id,
    entersOverpressure:
      afterPressure >= mapData.pressureEffects.overpressureThreshold
      && currentPressure < mapData.pressureEffects.overpressureThreshold
  };
}
