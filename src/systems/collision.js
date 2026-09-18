/**
 * systems/collision.js — axis-aligned chamber geometry helpers.
 *
 * Walls are AABBs `{ x, y, w, h }` in arena space. Circles (player, enemies,
 * projectiles) resolve against them. Pure functions only — no RNG, no clock.
 */

/** Clamp v into [lo, hi]. */
function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * Push a circle out of an AABB if overlapping. Returns new center.
 * When the center is inside the box, ejects along the shallowest face.
 */
export function resolveCircleAabb(x, y, r, wall) {
  const left = wall.x;
  const top = wall.y;
  const right = wall.x + wall.w;
  const bottom = wall.y + wall.h;

  const nearestX = clamp(x, left, right);
  const nearestY = clamp(y, top, bottom);
  let dx = x - nearestX;
  let dy = y - nearestY;
  const dist2 = dx * dx + dy * dy;

  if (dist2 >= r * r) return { x, y, hit: false };

  // Fully inside the AABB (or exactly on nearest point): min-penetration eject.
  if (dist2 === 0) {
    const dl = x - left;
    const dr = right - x;
    const dt = y - top;
    const db = bottom - y;
    const m = Math.min(dl, dr, dt, db);
    if (m === dl) return { x: left - r, y, hit: true };
    if (m === dr) return { x: right + r, y, hit: true };
    if (m === dt) return { x, y: top - r, hit: true };
    return { x, y: bottom + r, hit: true };
  }

  const dist = Math.sqrt(dist2);
  const push = (r - dist) / dist;
  return { x: x + dx * push, y: y + dy * push, hit: true };
}

/** True if circle overlaps AABB. */
export function circleHitsAabb(x, y, r, wall) {
  const nearestX = clamp(x, wall.x, wall.x + wall.w);
  const nearestY = clamp(y, wall.y, wall.y + wall.h);
  const dx = x - nearestX;
  const dy = y - nearestY;
  return dx * dx + dy * dy < r * r;
}

/**
 * Segment (x0,y0)->(x1,y1) vs AABB expanded by radius r (circle swept as
 * a point against a Minkowski-expanded box). Liang–Barsky style clip.
 */
export function sweptCircleHitsAabb(x0, y0, x1, y1, r, wall) {
  const minX = wall.x - r;
  const minY = wall.y - r;
  const maxX = wall.x + wall.w + r;
  const maxY = wall.y + wall.h + r;

  // Either endpoint already inside the expanded box.
  if (x0 >= minX && x0 <= maxX && y0 >= minY && y0 <= maxY) return true;
  if (x1 >= minX && x1 <= maxX && y1 >= minY && y1 <= maxY) return true;

  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;

  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };

  return clip(-dx, x0 - minX) &&
    clip(dx, maxX - x0) &&
    clip(-dy, y0 - minY) &&
    clip(dy, maxY - y0);
}

/**
 * Resolve entity position against every wall, then clamp to the arena.
 * Mutates `entity.x` / `entity.y`.
 */
export function resolveSolid(entity, walls, arena) {
  for (const wall of walls) {
    if (wall.ruptured) continue;
    const out = resolveCircleAabb(entity.x, entity.y, entity.radius, wall);
    entity.x = out.x;
    entity.y = out.y;
  }
  entity.x = Math.min(Math.max(entity.x, entity.radius), arena.w - entity.radius);
  entity.y = Math.min(Math.max(entity.y, entity.radius), arena.h - entity.radius);
}

/** True if the circle sits clear of every wall AABB. */
export function circleClearOfWalls(x, y, r, walls) {
  for (const wall of walls) {
    if (wall.ruptured) continue;
    if (circleHitsAabb(x, y, r, wall)) return false;
  }
  return true;
}

/**
 * Deterministic clear spawn near a preferred point (spiral search).
 * Last resort: resolveSolid eject from the preferred point.
 */
export function findClearSpawn(preferredX, preferredY, r, walls, arena, opts = {}) {
  const step = opts.step ?? 8;
  const maxRings = opts.maxRings ?? 48;
  let x = clamp(preferredX, r, arena.w - r);
  let y = clamp(preferredY, r, arena.h - r);
  if (circleClearOfWalls(x, y, r, walls)) return { x, y };

  for (let ring = 1; ring <= maxRings; ring++) {
    const dist = ring * step;
    const samples = Math.max(8, ring * 8);
    for (let i = 0; i < samples; i++) {
      const ang = (i / samples) * Math.PI * 2;
      const nx = clamp(x + Math.cos(ang) * dist, r, arena.w - r);
      const ny = clamp(y + Math.sin(ang) * dist, r, arena.h - r);
      if (circleClearOfWalls(nx, ny, r, walls)) return { x: nx, y: ny };
    }
  }

  const eject = { x, y, radius: r };
  resolveSolid(eject, walls, arena);
  return { x: eject.x, y: eject.y };
}

/** True if a thin segment from (x0,y0)→(x1,y1) never clips a wall. */
export function segmentClearOfWalls(x0, y0, x1, y1, walls, radius = 2) {
  for (const wall of walls) {
    if (wall.ruptured) continue;
    if (sweptCircleHitsAabb(x0, y0, x1, y1, radius, wall)) return false;
  }
  return true;
}

/**
 * Kill a projectile if its step segment (or resting circle) hits a wall.
 * Returns the wall hit, or null.
 */
export function absorbProjectileOnWalls(proj, walls) {
  for (const wall of walls) {
    if (wall.ruptured) continue;
    if (sweptCircleHitsAabb(
      proj.prevX, proj.prevY, proj.x, proj.y, proj.radius, wall
    )) {
      proj.alive = false;
      return wall;
    }
  }
  return null;
}

/**
 * Assign a room template id to a vessel node (mutates node).
 * Uses pickPool + rooms stream; forceTemplate overrides for debugging.
 */
export function assignNodeRoom(node, roomsData, roomsStream, opts = {}) {
  if (!node || !roomsData?.templates) {
    if (node) node.roomTemplateId = null;
    return null;
  }
  if (roomsData.forceTemplate && roomsData.templates[roomsData.forceTemplate]) {
    node.roomTemplateId = roomsData.forceTemplate;
    return node.roomTemplateId;
  }
  let pool = (roomsData.pickPool ?? Object.keys(roomsData.templates))
    .filter((id) => roomsData.templates[id] && id !== roomsData.labTemplateId);
  if (opts.pool?.length) {
    const wanted = opts.pool.filter((id) => roomsData.templates[id] && id !== roomsData.labTemplateId);
    if (wanted.length) pool = wanted;
  }
  if (pool.length === 0) {
    node.roomTemplateId = null;
    return null;
  }
  // Consume one roll per node even if we later add weights — keeps streams stable.
  const picked = roomsStream.pick(pool);
  const curriculum = opts.curriculum;
  if (
    curriculum?.teachRoom
    && node.isStart
    && node.depth <= (curriculum.maxDepth ?? 0)
    && roomsData.templates[curriculum.teachRoom]
    && (!opts.pool?.length || opts.pool.includes(curriculum.teachRoom))
  ) {
    node.roomTemplateId = curriculum.teachRoom;
    return node.roomTemplateId;
  }
  node.roomTemplateId = picked;
  return node.roomTemplateId;
}

/**
 * Load wall AABBs for the active chamber from the node's assigned template.
 */
export function loadChamberWalls(roomsData, _arena, node = null) {
  const empty = { roomId: null, walls: [], props: [], name: null, blurb: '', look: null };
  if (!roomsData?.templates) return empty;
  const id = node?.roomTemplateId
    ?? roomsData.forceTemplate
    ?? null;
  const tmpl = id ? roomsData.templates[id] : null;
  if (!tmpl) return { ...empty, roomId: id };
  return {
    roomId: id,
    walls: (tmpl.walls ?? []).map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h })),
    // Props are cosmetic only — no collision (Day 024).
    props: (tmpl.props ?? []).map((p) => ({
      id: p.id,
      x: p.x,
      y: p.y,
      size: p.size ?? 40
    })),
    name: tmpl.name ?? id,
    blurb: tmpl.blurb ?? '',
    look: {
      ...(roomsData.look ?? {}),
      ...(tmpl.look ?? {})
    },
    // Lab zones (pedestals / demo / exit) — interact wiring Day 073+
    zones: tmpl.zones ? structuredClone(tmpl.zones) : null
  };
}
