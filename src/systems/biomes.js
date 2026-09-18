/**
 * systems/biomes.js — depth band → presentation kit (palette, names, tints).
 * Pure data lookup; no RNG. Presentation may tint enemies/walls; sim combat
 * numbers are unchanged.
 */

/**
 * @param {object} biomesData data/biomes.json
 * @param {number} depth node.depth (0-based)
 * @returns {object|null} band or null
 */
export function biomeForDepth(biomesData, depth) {
  const bands = biomesData?.bands;
  if (!bands?.length) return null;
  const d = Number(depth) || 0;
  for (const band of bands) {
    if (d >= band.minDepth && d <= band.maxDepth) return band;
  }
  return bands[bands.length - 1];
}

/**
 * Merge looks: room template first, then biome wins on fill/edge/neon so depth
 * bands always read as different places.
 */
export function mergeChamberLook(biome, roomLook) {
  return {
    fill: '#121820',
    edge: '#3d5a80',
    neon: 'rgba(76, 201, 240, 0.45)',
    ...(roomLook ?? {}),
    ...(biome?.look ?? {})
  };
}

/** Display name: "Neural · Plaque Pillars" */
export function biomeRoomName(biome, templateName, roomId) {
  const room = templateName || roomId || 'Chamber';
  if (!biome?.label) return room;
  return `${biome.label} · ${room}`;
}

/** Merge room template props with biome kit props (cosmetic only). */
export function mergeChamberProps(biome, roomProps) {
  const base = (roomProps ?? []).map((p) => ({ ...p }));
  for (const p of biome?.props ?? []) {
    base.push({ ...p });
  }
  return base;
}
