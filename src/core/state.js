/**
 * core/state.js — finite state machine for high-level game flow.
 *
 * States used by the game: boot -> menu -> playing <-> paused -> gameover.
 *
 * Each state is a plain object with optional hooks:
 *   enter(params)        called when the state becomes active
 *   exit()               called when leaving the state
 *   update(dt)           fixed-timestep simulation hook
 *   render(ctx, alpha, fps)  draw hook
 *
 * Keeping states as data (instead of subclasses) keeps game.js readable and
 * makes it trivial to add states later (e.g. "lobby" for co-op).
 */
export class StateMachine {
  constructor() {
    this._states = new Map();
    this._current = null;
    this._currentName = '';
  }

  /** Register a state object under a name. Chainable. */
  register(name, state) {
    this._states.set(name, state);
    return this;
  }

  /** Name of the active state ('' before the first change()). */
  get current() {
    return this._currentName;
  }

  /** Switch states, firing exit/enter hooks. */
  change(name, params = {}) {
    const next = this._states.get(name);
    if (!next) throw new Error(`Unknown state: ${name}`);
    this._current?.exit?.();
    this._currentName = name;
    this._current = next;
    next.enter?.(params);
  }

  update(dt) {
    this._current?.update?.(dt);
  }

  render(ctx, alpha, fps) {
    this._current?.render?.(ctx, alpha, fps);
  }
}
