/**
 * profile.js — local meta genome (unlocked fragment ids).
 *
 * Presentation/shell concern: Electron has localStorage; headless tests pass
 * an in-memory Map-like storage. World still receives unlockedIds at construct.
 */
const KEY = 'microbiome.genome.v1';

/** Fresh profile unlock set from data (~4 fragments). */
export function starterUnlocks(elementsData) {
  const ids = elementsData?.unlockedStart ?? elementsData?.starting ?? ['pulse'];
  return [...new Set(ids)];
}

/**
 * @param {object} elementsData
 * @param {{ getItem?: Function, setItem?: Function }|null} storage
 */
export function loadProfile(elementsData, storage = defaultStorage()) {
  const starter = starterUnlocks(elementsData);
  try {
    const raw = storage?.getItem?.(KEY);
    if (!raw) return { unlockedIds: starter, version: 1 };
    const parsed = JSON.parse(raw);
    const ids = Array.isArray(parsed.unlockedIds) ? parsed.unlockedIds : starter;
    // Always keep starters; merge saved unlocks.
    return {
      unlockedIds: [...new Set([...starter, ...ids.filter((id) => typeof id === 'string')])],
      version: 1
    };
  } catch {
    return { unlockedIds: starter, version: 1 };
  }
}

export function saveProfile(profile, storage = defaultStorage()) {
  if (!storage?.setItem) return;
  storage.setItem(KEY, JSON.stringify({
    version: 1,
    unlockedIds: [...profile.unlockedIds]
  }));
}

/**
 * Unlock new fragment ids into the profile. Returns newly added ids.
 */
export function unlockIntoProfile(profile, ids, elementsData, storage = defaultStorage()) {
  const known = new Set(
    (elementsData?.elements ?? []).map((e) => e.id)
  );
  const before = new Set(profile.unlockedIds);
  const added = [];
  for (const id of ids) {
    if (!known.has(id) || before.has(id)) continue;
    profile.unlockedIds.push(id);
    before.add(id);
    added.push(id);
  }
  if (added.length) saveProfile(profile, storage);
  return added;
}

export function resetProfile(elementsData, storage = defaultStorage()) {
  const profile = { unlockedIds: starterUnlocks(elementsData), version: 1 };
  saveProfile(profile, storage);
  return profile;
}

function defaultStorage() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch { /* ignore */ }
  return null;
}

/** In-memory storage for Node tests. */
export function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map
  };
}
