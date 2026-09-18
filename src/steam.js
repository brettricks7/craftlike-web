/**
 * steam.js — SteamManager, safe-by-default Steam integration point.
 *
 * Toggled by config.json -> steam.enabled. While disabled (the default),
 * every method is a harmless no-op that just logs in debug mode, so the
 * game NEVER crashes when the Steam client isn't running.
 *
 * Shipping plan (when steam.enabled flips to true):
 *   1. Put the real App ID in steam_appid.txt (already in the repo root)
 *      and config.json -> steam.appId.
 *   2. `npm install steamworks.js` and initialize it in main.js (Steamworks
 *      must live in the MAIN process).
 *   3. Bridge these renderer-side methods over IPC (ipcRenderer.invoke via
 *      preload.cjs) to the main-process Steamworks client.
 *
 * Game code calls these methods unconditionally — the toggle lives here,
 * in exactly one place.
 */
export class SteamManager {
  /** @param {object} config config.json contents */
  constructor(config) {
    this.enabled = Boolean(config?.steam?.enabled);
    this.debug = Boolean(config?.debug);
    this.appId = config?.steam?.appId ?? 0;
  }

  _log(...args) {
    if (this.debug) console.log('[steam:stub]', ...args);
  }

  /** Returns true when the Steam API is actually live. */
  init() {
    if (!this.enabled) {
      this._log('disabled in config.json — running in local mode');
      return false;
    }
    // Real implementation: ipc call -> steamworks.init(this.appId) in main.
    this._log(`would initialize Steamworks for appId=${this.appId}`);
    return false; // flips to true once the real bridge exists
  }

  unlockAchievement(id) {
    if (!this.enabled) return;
    this._log(`would unlock achievement "${id}"`);
  }

  setRichPresence(key, value) {
    if (!this.enabled) return;
    this._log(`would set rich presence ${key}=${value}`);
  }

  shutdown() {
    if (!this.enabled) return;
    this._log('would shut down Steamworks');
  }
}
