/**
 * systems/nerve-rails.js — Day 212 neural patient floor rails.
 *
 * Thin walkable AABB strips (no collision). Standing on a rail + fire or hit
 * arms a telegraph; after a fixed delay a pressure pulse damages only if the
 * player is still on that rail. Pure helpers — timing lives in World.update.
 */

import { circleHitsAabb } from './collision.js';

/**
 * @param {object|null} patient picked patient from data/patients.json
 * @param {string|null} roomId active chamber template id
 * @returns {Array<{id:number,x:number,y:number,w:number,h:number}>}
 */
export function loadNerveRails(patient, roomId) {
  if (patient?.id !== 'neural') return [];
  const cfg = patient.nerveRails;
  if (!cfg?.layouts) return [];
  const strips = cfg.layouts[roomId] ?? cfg.layouts._default ?? [];
  return strips.map((s, id) => ({
    id,
    x: s.x,
    y: s.y,
    w: s.w,
    h: s.h
  }));
}

/** Index of the rail under the player center, or -1. */
export function playerRailIndex(player, rails) {
  if (!rails?.length || !player?.alive) return -1;
  for (let i = 0; i < rails.length; i++) {
    if (circleHitsAabb(player.x, player.y, player.radius, rails[i])) return i;
  }
  return -1;
}

/** True when the player circle overlaps a specific rail AABB. */
export function playerOnRail(player, rail) {
  if (!rail || !player?.alive) return false;
  return circleHitsAabb(player.x, player.y, player.radius, rail);
}
