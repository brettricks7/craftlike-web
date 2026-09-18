/**
 * systems/vesselmap.js — the Circulatory Flow map generator.
 *
 * The run is a seeded, layered DAG of blood vessels:
 *   - layer 0: the injection site (start chamber)
 *   - layers 1..depth-2: branching chambers, 2-3 wide
 *   - layer depth-1: the Infection Core (end chamber)
 *
 * Nodes are CHAMBERS (combat encounters). Edges are VESSELS, each typed as
 * artery / vein / bypass (data/map.json -> routes). The vessel you travel
 * decides the next chamber's threat and your blood-pressure change — the
 * same chamber reached via an artery is a nastier fight than via a bypass.
 *
 * Structural guarantees (enforced by tests/vesselmap.test.js):
 *   - deterministic: same stream seed => identical map, node for node
 *   - acyclic: edges only ever point FORWARD in depth (next layer, or
 *     Day 169 shortcut skip, or Day 173 capillary rejoin at the same depth)
 *   - traversable: every node is reachable from the start, and every
 *     non-end node has at least one exit, so the end is always reachable
 *
 * All randomness comes from one named RandomStream (rng.stream('map')) so
 * map generation can never disturb loot/spawn/craft results.
 */

/** Weighted pick over the routes table. Skips weight≤0 (edge-only types). */
function pickRouteType(stream, routes) {
  const entries = Object.entries(routes).filter(([, r]) => (r.weight ?? 0) > 0);
  if (entries.length === 0) return 'vein';
  const total = entries.reduce((sum, [, r]) => sum + r.weight, 0);
  let roll = stream.float(0, total);
  for (const [type, r] of entries) {
    roll -= r.weight;
    if (roll <= 0) return type;
  }
  return entries[entries.length - 1][0];
}

/**
 * @param {object} mapData data/map.json
 * @param {RandomStream} stream the run's 'map' stream
 * @returns {{ depth, startId, endId, nodes: object[] }} plain JSON-safe map
 */
export function generateVesselMap(mapData, stream) {
  const { depth, width, maxExits, wavesPerChamber, endBonusWaves, routes } = mapData;

  // --- Nodes, layer by layer ---
  const layers = [];
  for (let d = 0; d < depth; d++) {
    const isStart = d === 0;
    const isEnd = d === depth - 1;
    const isPinch = (mapData.pinchDepths ?? []).includes(d);
    const size = isStart || isEnd || isPinch ? 1 : stream.int(width.min, width.max);

    const layer = [];
    for (let i = 0; i < size; i++) {
      const baseWaves = Math.round(wavesPerChamber.base + wavesPerChamber.perDepth * d);
      layer.push({
        id: `c${d}-${i}`,
        depth: d,
        isStart,
        isEnd,
        isCapillary: false,
        isPinch,
        // The finale is a longer fight; everything clamps to data bounds.
        wavesRequired:
          Math.min(Math.max(baseWaves, 1), wavesPerChamber.max) +
          (isEnd ? endBonusWaves : 0),
        exits: [] // [{ to, type }] wired below
      });
    }
    layers.push(layer);
  }

  // --- Edges: each node reaches 1..maxExits nodes in the next layer ---
  for (let d = 0; d < depth - 1; d++) {
    const next = layers[d + 1];
    const hasParent = new Set();

    for (const node of layers[d]) {
      const k = stream.int(1, Math.min(maxExits, next.length));
      const targets = stream
        .shuffle(next.map((_, i) => i))
        .slice(0, k)
        .sort((a, b) => a - b); // stable left-to-right display order
      for (const t of targets) {
        node.exits.push({ to: next[t].id, type: pickRouteType(stream, routes) });
        hasParent.add(next[t].id);
      }
    }

    // Connectivity fix: any orphaned next-layer node gets fed by the
    // current-layer node with the fewest exits (deterministic tie-break).
    for (const orphan of next) {
      if (hasParent.has(orphan.id)) continue;
      let parent = layers[d][0];
      for (const candidate of layers[d]) {
        if (candidate.exits.length < parent.exits.length) parent = candidate;
      }
      parent.exits.push({ to: orphan.id, type: pickRouteType(stream, routes) });
      hasParent.add(orphan.id);
    }
  }

  // --- Day 169: optional shortcut edges (skip layers, typed shortcut) ---
  const sc = mapData.shortcuts;
  if (sc?.enabled && routes.shortcut) {
    const skip = Math.max(2, Number(sc.skipLayers ?? routes.shortcut.skipLayers ?? 2) || 2);
    const chance = Number(sc.chance ?? 0.4);
    const maxPerDepth = Math.max(1, Number(sc.maxPerDepth ?? 2) || 2);
    for (let d = 0; d <= depth - 1 - skip; d++) {
      let placed = 0;
      for (const node of layers[d]) {
        if (placed >= maxPerDepth) break;
        // Shortcuts may exceed maxExits by one — greed is an optional extra door.
        if (node.exits.filter((e) => e.type === 'shortcut').length > 0) continue;
        if (!stream.chance(chance)) continue;
        const destLayer = layers[d + skip];
        const t = stream.int(0, destLayer.length - 1);
        const dest = destLayer[t];
        if (node.exits.some((e) => e.to === dest.id)) continue;
        node.exits.push({ to: dest.id, type: 'shortcut' });
        placed++;
      }
    }
  }

  // --- Day 173: optional capillary side jobs (extra chamber, then rejoin) ---
  const cap = mapData.capillaries;
  if (cap?.enabled && routes.capillary && routes.rejoin) {
    const chance = Number(cap.chance ?? 0.35);
    const maxPerDepth = Math.max(1, Number(cap.maxPerDepth ?? 2) || 2);
    for (let d = 1; d <= depth - 3; d++) {
      if ((mapData.pinchDepths ?? []).includes(d + 1)) continue;
      let placed = 0;
      const parents = [...layers[d]];
      for (const node of parents) {
        if (placed >= maxPerDepth) break;
        if (node.isCapillary) continue;
        const mains = node.exits.filter((e) => e.type !== 'shortcut' && e.type !== 'capillary');
        if (mains.length === 0) continue;
        if (!stream.chance(chance)) continue;
        const dest = mains[stream.int(0, mains.length - 1)];
        const destNode = layers[d + 1].find((n) => n.id === dest.to);
        if (!destNode || destNode.isCapillary) continue;
        const capNode = {
          id: `cap-${node.id}`,
          depth: d + 1,
          isStart: false,
          isEnd: false,
          isCapillary: true,
          wavesRequired: destNode.wavesRequired,
          exits: [{ to: destNode.id, type: 'rejoin' }]
        };
        layers[d + 1].push(capNode);
        node.exits.push({ to: capNode.id, type: 'capillary' });
        placed++;
      }
    }
  }

  const nodes = layers.flat();
  return {
    depth,
    startId: layers[0][0].id,
    endId: layers[depth - 1][0].id,
    nodes
  };
}

/** Bob/minimap chrome hooks (Day 219) — tweak spine geometry without touching layout math. */
export const MINIMAP_READABILITY = {
  trunkStroke: '#ffd166',
  trunkWidth: 4.5,
  branchAlpha: 0.32,
  pinchColor: '#4cc9f0',
  coreColor: '#e63946',
  pinchNodeRadius: 8,
  coreNodeRadius: 8,
  pinchRingOffset: 5,
  coreRingOffset: 5,
  /** Day 223 — capillary fork vs unpaid rejoin hop read differently on the map. */
  capillaryDash: [2, 4],
  rejoinDash: [1, 6]
};

/** Bob/core-approach chrome hooks (Day 220) — card callout + minimap pulse palette. */
export const CORE_APPROACH = {
  callout: '→ INFECTION CORE',
  corePulseColor: '#e63946',
  corePulseAlpha: 0.35
};

function minimapRole(node) {
  if (node.isEnd) return 'core';
  if (node.isPinch) return 'pinch';
  if (node.isStart) return 'start';
  if (node.isCapillary) return 'capillary';
  return 'branch';
}

/**
 * Main spine: start → pinch → core via non-shortcut, non-capillary edges.
 * @param {{ depth: number, startId: string, endId: string, nodes: object[] }} map
 */
function computeMinimapTrunk(map) {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const pinchIds = map.nodes.filter((n) => n.isPinch).map((n) => n.id);
  const coreId = map.endId;
  const pinchDepth = pinchIds.length ? byId.get(pinchIds[0]).depth : map.depth - 1;

  const trunkNodeIds = new Set([map.startId]);
  const trunkEdges = new Set();
  let current = map.startId;

  while (current !== coreId) {
    const node = byId.get(current);
    const mains = node.exits.filter((e) => e.type !== 'shortcut' && e.type !== 'capillary');
    if (mains.length === 0) break;

    let next;
    if (node.isPinch) {
      next = mains.find((e) => byId.get(e.to).isEnd) ?? mains[0];
    } else if (node.depth < pinchDepth) {
      next = mains.find((e) => byId.get(e.to).isPinch) ??
        mains.reduce((best, e) => (byId.get(e.to).depth > byId.get(best.to).depth ? e : best), mains[0]);
    } else {
      next = mains.reduce((best, e) => (byId.get(e.to).depth > byId.get(best.to).depth ? e : best), mains[0]);
    }

    trunkEdges.add(`${current}->${next.to}`);
    current = next.to;
    trunkNodeIds.add(current);
  }

  return { pinchIds, coreId, trunkNodeIds, trunkEdges };
}

/**
 * Deterministic pixel layout for the vessel minimap (Day 017, Day 219).
 * Same map → same layout. Origin is top-left of the draw box.
 *
 * @param {{ depth: number, nodes: object[] }} map
 * @param {{ x: number, y: number, w: number, h: number }} box
 * @returns {{ nodes: Map<string, { x: number, y: number, role: string, isOnTrunk: boolean }>, meta: object }}
 */
export function layoutVesselMinimap(map, box) {
  const byDepth = new Map();
  for (const n of map.nodes) {
    if (!byDepth.has(n.depth)) byDepth.set(n.depth, []);
    byDepth.get(n.depth).push(n);
  }
  for (const layer of byDepth.values()) {
    layer.sort((a, b) => {
      const ac = a.isCapillary ? 1 : 0;
      const bc = b.isCapillary ? 1 : 0;
      if (ac !== bc) return ac - bc;
      return a.id.localeCompare(b.id);
    });
  }

  const padX = 18;
  const padY = 16;
  const usableW = Math.max(1, box.w - padX * 2);
  const usableH = Math.max(1, box.h - padY * 2);
  const maxDepth = Math.max(1, map.depth - 1);
  const trunk = computeMinimapTrunk(map);
  const nodes = new Map();

  for (let d = 0; d < map.depth; d++) {
    const layer = byDepth.get(d) || [];
    const n = layer.length || 1;
    layer.forEach((node, i) => {
      const y = box.y + padY + ((i + 0.5) / n) * usableH;
      let x = box.x + padX + (d / maxDepth) * usableW;
      if (node.isCapillary) x -= (usableW / maxDepth) * 0.32;
      nodes.set(node.id, {
        x,
        y,
        role: minimapRole(node),
        isOnTrunk: trunk.trunkNodeIds.has(node.id)
      });
    });
  }

  return {
    nodes,
    meta: {
      pinchIds: trunk.pinchIds,
      coreId: trunk.coreId,
      trunkNodeIds: [...trunk.trunkNodeIds],
      trunkEdges: [...trunk.trunkEdges]
    }
  };
}
