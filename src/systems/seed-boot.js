/**
 * systems/seed-boot.js — boot-time seed resolution + share URLs (Day 241).
 *
 * Keeps seeded boot honest across Electron (config.seed) and web (?seed=).
 */

/** Parse `?seed=ALPHA` (or `&seed=`) from a location search string. */
export function seedFromSearch(search = '') {
  const raw = new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search
  ).get('seed');
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  return s.length > 0 ? s.slice(0, 32) : null;
}

/**
 * Pick the menu seed: config override wins, then URL share param, else roll.
 * @param {{ configSeed: string|null|undefined, search?: string, roll: () => string }} opts
 */
export function resolveMenuSeed({ configSeed, search = '', roll }) {
  if (configSeed != null && String(configSeed).length > 0) return String(configSeed);
  const fromUrl = seedFromSearch(search);
  if (fromUrl) return fromUrl;
  return roll();
}

/** Build a shareable URL for a run seed (web Pages / static host). */
export function shareUrlForSeed(seed, origin = '', pathname = '/') {
  const base = `${origin}${pathname}`;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}seed=${encodeURIComponent(String(seed))}`;
}
