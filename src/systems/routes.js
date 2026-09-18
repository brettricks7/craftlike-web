/**
 * systems/routes.js — route preview display (Day 025 troll spice) and the
 * Day 180 greed ramp (shared by sim advance() and the route card UI so the
 * numbers the player reads are the numbers the sim applies).
 *
 * Day 220 — core approach telegraph: flag exits that feed the Infection Core
 * so route UI / toasts can warn before commit (no silent +HP ambush).
 */

/** True when a vessel exit lands on the Infection Core (isEnd) node. */
export function exitLeadsToCore(exit, nodeById) {
  const dest = nodeById?.get?.(exit.to);
  return !!dest?.isEnd;
}

/**
 * Route picker must appear even for a lone exit when it feeds the Core —
 * otherwise advance() auto-skips the card and heals land without a tell.
 */
export function needsRouteChoice(node, nodeById) {
  if (!node?.exits?.length) return false;
  if (node.exits.length > 1) return true;
  return exitLeadsToCore(node.exits[0], nodeById);
}

/** Day 180 — greed scale-in factor for a destination depth (0..1). */
export function greedFactor(mapData, destDepth) {
  const g = mapData.greedRamp;
  if (!g) return 1;
  const floor = g.floor ?? 0.4;
  const rampDepth = Math.max(1, g.rampDepth ?? 5);
  return Math.min(1, floor + (1 - floor) * (Math.max(0, destDepth) / rampDepth));
}

/**
 * Effective threat/loot for a route into a chamber at destDepth. Greed routes
 * (map.greedRamp.routes) scale their EXTRA above the vein baseline by the
 * greed factor — survivable-with-scars early, full spice deep. Other routes
 * pass through untouched.
 */
export function effectiveRoute(mapData, exitType, destDepth) {
  const route = mapData.routes[exitType];
  const base = {
    intensity: route.intensity,
    score: route.rewards.score ?? 0,
    pressureDelta: route.pressureDelta ?? 0,
    factor: 1
  };
  if (!mapData.greedRamp?.routes?.includes(exitType)) return base;
  const f = greedFactor(mapData, destDepth);
  const vein = mapData.routes.vein;
  const baseI = vein?.intensity ?? 1.0;
  const baseS = vein?.rewards?.score ?? 40;
  const baseP = vein?.pressureDelta ?? 0;
  return {
    intensity: baseI + (route.intensity - baseI) * f,
    score: Math.round(baseS + ((route.rewards.score ?? 0) - baseS) * f),
    // A small fistula is a smaller wound: the pressure cost scales in too.
    pressureDelta: Math.round(baseP + ((route.pressureDelta ?? 0) - baseP) * f),
    factor: f
  };
}

/** Clamp pressure after applying a route delta (same bounds as advance()). */
export function projectedPressure(mapData, currentPressure, pressureDelta) {
  const p = mapData.pressure;
  return Math.min(
    Math.max(currentPressure + pressureDelta, p.min),
    p.max
  );
}

/**
 * Chamber threat after commit — route intensity scaled by post-route pressure.
 * Shared by advance() and route cards so Threat matches the next fight.
 */
export function chamberIntensity(mapData, routeIntensity, pressure) {
  const pe = mapData.pressureEffects;
  return Math.max(
    routeIntensity * (1 + (pressure - mapData.pressure.start) * pe.intensityPerPoint),
    pe.minIntensity
  );
}

/**
 * Day 180/223/236 — greed route callout with effective numbers (two lines for
 * 280px cards). L1: scar leads loot + identity; L2: skip/rejoin suffix.
 * Threat omitted — band shift line already shows post-commit fight spice.
 */
export function formatGreedCallout(mapData, exitType, eff, skipN = 0) {
  const veinScore = mapData.routes.vein?.rewards?.score || 40;
  const line1 = [];
  if (exitType === 'capillary') line1.push('SIDE BET');
  if (eff.pressureDelta > 0) line1.push(`SCAR +${eff.pressureDelta} BP`);
  line1.push(`${(eff.score / veinScore).toFixed(1)}× LOOT`);

  const line2 = [];
  if (exitType === 'capillary') line2.push('REJOIN');
  if (skipN > 0) line2.push(`SKIP +${skipN}`);

  return {
    line1: line1.join(' · '),
    line2: line2.length ? line2.join(' · ') : ''
  };
}

/** Day 236 — pick-moment reward line (honest eff.score + real protein odds). */
export function formatGreedRewardLine(eff, realRoute) {
  const parts = [];
  if (eff.score) parts.push(`+${eff.score} score`);
  if (realRoute.rewards.elementChance >= 1) parts.push('guaranteed protein');
  else if (realRoute.rewards.elementChance > 0) {
    parts.push(`${Math.round(realRoute.rewards.elementChance * 100)}% protein`);
  }
  return parts.join(' · ');
}

/**
 * Day 245 — heal pick line: numeric HP paired with scar/relief + attrition tag.
 * Heal is never vanity bait alone; threat band line stays on the card too.
 */
export function formatHealAttritionLine(exitType, eff, realRoute) {
  const heal = realRoute?.rewards?.heal ?? 0;
  if (heal <= 0) return '';
  const parts = [`+${heal} HP`];
  const pd = eff?.pressureDelta ?? 0;
  if (pd < 0) parts.push(`RELIEF ${pd} BP`);
  else if (pd > 0) parts.push(`SCAR +${pd} BP`);
  if (exitType === 'bypass') parts.push('THIN LOOT');
  else if (exitType === 'vein') parts.push('FAIR FIGHT');
  return parts.join(' · ');
}
export function buildRouteDisplay(mapData, exits, pressure, rngStream, nodeById = null) {
  const routes = mapData.routes;
  const rows = exits.map((exit, idx) => ({
    idx,
    exit,
    display: routes[exit.type],
    realType: exit.type,
    suspicious: false,
    leadsToCore: exitLeadsToCore(exit, nodeById)
  }));

  const troll = mapData.routePreviewTroll;
  if (!troll?.enabled || pressure < (troll.pressureThreshold ?? 75)) return rows;
  if (!rngStream.chance(troll.chance ?? 0.35)) return rows;
  if (exits.length < 2) return rows;

  const victimIdx = rngStream.int(0, exits.length - 1);
  const realType = exits[victimIdx].type;
  const alts = Object.keys(routes).filter((t) => t !== realType);
  const fakeType = alts[rngStream.int(0, alts.length - 1)];

  return rows.map((row, i) => {
    if (i !== victimIdx) return row;
    return {
      ...row,
      display: routes[fakeType],
      suspicious: true
    };
  });
}
