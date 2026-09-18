/**
 * core/loop.js — fixed-timestep game loop with interpolated rendering.
 *
 * Why fixed timestep?
 *   1. Determinism. The simulation always advances in identical slices
 *      (default 1/60 s), so a given seed + inputs replays identically on a
 *      60 Hz office monitor or a 240 Hz gaming panel. This is also the
 *      foundation for future lockstep co-op netcode.
 *   2. Stability. Physics/AI never see a giant dt after a hitch.
 *
 * Rendering still runs once per requestAnimationFrame and receives `alpha`
 * (how far we are between the previous and current sim step, 0..1) so
 * entities can be drawn at interpolated positions — buttery on any refresh
 * rate without affecting the simulation.
 *
 * Testability: the frame scheduler and clock are injectable, so unit tests
 * (tests/loop.test.js) drive the loop with fake timestamps and verify the
 * update count is a pure function of elapsed time — never of frame rate.
 */
export class GameLoop {
  /**
   * @param {object}   opts
   * @param {number}   opts.hz               Simulation rate (steps per second).
   * @param {number}   opts.maxCatchUpSteps  Max sim steps per frame; beyond
   *                                         this we drop time instead of
   *                                         spiraling (e.g. after the window
   *                                         was minimized).
   * @param {function} opts.update           update(dtSeconds) — fixed step.
   * @param {function} opts.render           render(alpha, fps).
   * @param {object}   [timing]              Injectable scheduler/clock for tests:
   *                                         { requestFrame, cancelFrame, now }.
   */
  constructor({ hz = 60, maxCatchUpSteps = 5, update, render }, timing = {}) {
    this.stepMs = 1000 / hz;
    this.stepSec = 1 / hz;
    this.maxCatchUpSteps = maxCatchUpSteps;
    this.update = update;
    this.render = render;

    this._requestFrame = timing.requestFrame ?? ((cb) => requestAnimationFrame(cb));
    this._cancelFrame = timing.cancelFrame ?? ((id) => cancelAnimationFrame(id));
    this._now = timing.now ?? (() => performance.now());

    this.running = false;
    this._accumulator = 0;
    this._last = 0;
    this._rafId = 0;

    // Speedup knob (tests/debug): sim-seconds advanced per wall-second.
    // The step size NEVER changes — a 10x scale just runs 10x more fixed
    // steps per frame, so determinism is completely unaffected.
    this.timeScale = 1;

    // Exponentially smoothed FPS for the debug overlay (render-side only —
    // NEVER an input to the simulation).
    this.fps = 0;

    this._frame = this._frame.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._last = this._now();
    this._accumulator = 0;
    this._rafId = this._requestFrame(this._frame);
  }

  stop() {
    this.running = false;
    this._cancelFrame(this._rafId);
  }

  _frame(now) {
    if (!this.running) return;
    this._rafId = this._requestFrame(this._frame);

    const rawElapsed = now - this._last;
    this._last = now;

    // FPS reads the REAL frame cadence, before any time scaling.
    if (rawElapsed > 0) {
      const instFps = 1000 / rawElapsed;
      this.fps = this.fps === 0 ? instFps : this.fps * 0.95 + instFps * 0.05;
    }

    // Guard against a zero/negative scale freezing the game silently.
    const scale = this.timeScale > 0 ? this.timeScale : 1;
    let elapsed = rawElapsed * scale;

    // Clamp huge gaps (tab hidden, debugger pause) so we never "fast-forward"
    // the player into a wall of enemies. Wasting the player's time is a sin;
    // so is killing them while the window was minimized. The clamp scales
    // with timeScale so speedup mode still gets its extra steps per frame.
    const stepBudget = Math.ceil(this.maxCatchUpSteps * scale);
    const maxElapsed = this.stepMs * stepBudget;
    if (elapsed > maxElapsed) elapsed = maxElapsed;

    this._accumulator += elapsed;

    // Advance the simulation in fixed slices.
    let steps = 0;
    while (this._accumulator >= this.stepMs && steps < stepBudget) {
      this.update(this.stepSec);
      this._accumulator -= this.stepMs;
      steps++;
    }
    // If we hit the step cap, drop the leftover time instead of letting it
    // build into a spiral of death on slow machines.
    if (this._accumulator > this.stepMs) this._accumulator = this.stepMs;

    // Render once, interpolated between the last two sim states.
    const alpha = this._accumulator / this.stepMs;
    this.render(Math.min(alpha, 1), this.fps);
  }
}
