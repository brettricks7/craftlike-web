/**
 * systems/abilities.js — data-driven ability cast helpers (Phase A).
 * World owns cooldowns / loadout; this module resolves modules + CD checks.
 */
export function moduleById(abilityModules, id) {
  if (!id || !abilityModules) return null;
  if (abilityModules instanceof Map) return abilityModules.get(id) ?? null;
  const list = abilityModules.modules ?? abilityModules;
  return list.find((m) => m.id === id) ?? null;
}

/** Seconds of cooldown for a module (fallback small gate). */
export function moduleCooldown(mod) {
  if (!mod) return 0;
  return Number(mod.cooldown) > 0 ? Number(mod.cooldown) : 0.05;
}

/**
 * Can this slot cast right now?
 * @returns {{ ok: boolean, reason?: string }}
 */
export function canCast(abilitySlots, cooldowns, slot, abilityModules) {
  if (slot !== 0 && slot !== 1) return { ok: false, reason: 'bad slot' };
  const id = abilitySlots[slot];
  if (!id) return { ok: false, reason: 'empty' };
  if ((cooldowns[slot] ?? 0) > 0) return { ok: false, reason: 'cooldown' };
  const mod = moduleById(abilityModules, id);
  if (!mod && id !== 'blink') return { ok: false, reason: 'unknown module' };
  return { ok: true };
}

/**
 * Equip a module id into Ability A (0) or B (1).
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateEquip(abilityModules, slot, moduleId) {
  if (slot !== 0 && slot !== 1) return { ok: false, reason: 'bad slot' };
  if (moduleId === null || moduleId === undefined || moduleId === '') {
    return { ok: true }; // clear slot
  }
  if (typeof moduleId !== 'string') return { ok: false, reason: 'bad id' };
  if (slot === 0 && moduleId !== 'blink') {
    // Starter A can be replaced later in Lab; allow any known module.
  }
  const mod = moduleById(abilityModules, moduleId);
  if (!mod) return { ok: false, reason: 'unknown module' };
  return { ok: true };
}

/**
 * Day 240 — true when Ability B gets a new non-null module (equip or swap).
 * Clear and no-change paths stay quiet.
 */
export function abilityBEquipChanged(prevId, nextId) {
  if (!nextId) return false;
  return prevId !== nextId;
}
