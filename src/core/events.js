/**
 * core/events.js — minimal pub/sub event bus.
 *
 * Decouples systems: the spawner doesn't know the HUD exists, the crafting
 * system doesn't know Steam achievements exist — they just emit events.
 */
export class EventBus {
  constructor() {
    this._listeners = new Map(); // event name -> Set<fn>
  }

  /** Subscribe. Returns an unsubscribe function. */
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  /** Subscribe for a single emission. */
  once(event, fn) {
    const off = this.on(event, (...args) => {
      off();
      fn(...args);
    });
    return off;
  }

  off(event, fn) {
    this._listeners.get(event)?.delete(fn);
  }

  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set) return;
    // Copy so handlers can unsubscribe while we iterate.
    for (const fn of [...set]) fn(...args);
  }
}
