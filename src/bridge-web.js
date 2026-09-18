/**
 * bridge-web.js — fetch-based bridge for static web hosting (Phase Web W.1)
 *
 * This shim provides the same `window.bridge` API as preload.cjs, but uses
 * fetch() instead of Node's fs module. It enables static hosting on GitHub
 * Pages, CDNs, or any static file server.
 *
 * Usage:
 *   - Include this script BEFORE src/game.js when running in a browser
 *   - Do NOT include when running in Electron (preload.cjs handles it)
 *
 * API contract (matches preload.cjs):
 *   window.bridge = {
 *     config: {...},           // config.json
 *     data: {...},             // all data/*.json files
 *     env: { timeScale, noShake }, // test/dev knobs (null in web)
 *     versions: { ... }        // version info (simplified in web)
 *   }
 */

/**
 * Fetch and parse a JSON file, with error handling.
 */
async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${path}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

/**
 * Initialize the bridge by loading all config and data files.
 * Returns a Promise that resolves to the bridge object.
 */
async function initBridge() {
  try {
    // Load config first
    const config = await fetchJson('config.json');

    // Load all data files in parallel
    const [
      proteins,
      abilities,
      enemies,
      player,
      map,
      rooms,
      biomes,
      patients,
      juice,
      formMotion,
      tagSecondary,
      comboFingerprint,
      loadout,
      abilityModules,
      dnaPatterns,
      mutations
    ] = await Promise.all([
      fetchJson('data/proteins.json'),
      fetchJson('data/abilities.json'),
      fetchJson('data/enemies.json'),
      fetchJson('data/player.json'),
      fetchJson('data/map.json'),
      fetchJson('data/rooms.json'),
      fetchJson('data/biomes.json'),
      fetchJson('data/patients.json'),
      fetchJson('data/juice.json'),
      fetchJson('data/form_motion.json'),
      fetchJson('data/tag_secondary.json'),
      fetchJson('data/combo_fingerprint.json'),
      fetchJson('data/loadout.json'),
      fetchJson('data/ability_modules.json'),
      fetchJson('data/dna_patterns.json'),
      fetchJson('data/mutations.json')
    ]);

    // Assemble the data object (matching preload.cjs structure)
    const data = {
      // CEO Q&A 2026-08-06: surface name = proteins. `elements` kept as alias.
      proteins,
      elements: proteins,
      abilities,
      enemies,
      player,
      map,
      rooms,
      biomes,
      patients,
      juice,
      formMotion,
      tagSecondary,
      comboFingerprint,
      loadout,
      abilityModules,
      dnaPatterns,
      mutations
    };

    // Construct the bridge object
    const bridge = {
      config,
      data,
      // Test/dev knobs: not available in web (no process.env)
      env: {
        timeScale: null,
        noShake: null
      },
      // Version info: simplified for web
      versions: {
        electron: null,
        chrome: navigator.userAgent.match(/Chrome\/([0-9.]+)/)?.[1] || 'unknown',
        node: null
      }
    };

    return bridge;
  } catch (err) {
    // Display error to user if bridge initialization fails
    const canvas = document.getElementById('game');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.font = '16px monospace';
      ctx.fillText('Failed to load game data:', 20, 40);
      ctx.fillText(err.message, 20, 60);
    }
    throw err;
  }
}

/**
 * Install the bridge on window and return a Promise that resolves when ready.
 * The game code should await this before accessing window.bridge.
 */
export async function installBridge() {
  const bridge = await initBridge();
  window.bridge = bridge;
  return bridge;
}

/**
 * Auto-install if running as a module script (not imported).
 * This allows simple usage: <script type="module" src="src/bridge-web.js"></script>
 */
if (typeof document !== 'undefined' && document.currentScript?.src.includes('bridge-web.js')) {
  // Auto-install mode: set up bridge immediately
  installBridge().catch(err => {
    console.error('Bridge initialization failed:', err);
  });
}
