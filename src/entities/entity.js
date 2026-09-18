/**
 * entities/entity.js — base class for everything that lives in the arena.
 *
 * Stores the previous step's position so the renderer can interpolate between
 * sim steps (see core/loop.js `alpha`) — smooth on any refresh rate while the
 * simulation stays fixed-step and deterministic.
 */
export class Entity {
  constructor(x, y, radius) {
    this.x = x;
    this.y = y;
    this.prevX = x;
    this.prevY = y;
    this.vx = 0;
    this.vy = 0;
    this.radius = radius;
    this.alive = true;
  }

  /** Call at the top of each sim step, before moving. */
  beginStep() {
    this.prevX = this.x;
    this.prevY = this.y;
  }

  /** Basic Euler integration. */
  integrate(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
  }

  /**
   * Move with axis separation so walls slide instead of softlocking chase AI.
   * @param {number} dt
   * @param {object[]} walls
   * @param {{w:number,h:number}} arena
   * @param {(e: object, walls: object[], arena: object) => void} resolveSolid
   */
  integrateSlide(dt, walls, arena, resolveSolid) {
    const ox = this.x;
    const oy = this.y;
    this.x = ox + this.vx * dt;
    resolveSolid(this, walls, arena);
    const xAfter = this.x;
    this.x = ox;
    this.y = oy + this.vy * dt;
    resolveSolid(this, walls, arena);
    this.x = xAfter;
    resolveSolid(this, walls, arena);
  }

  /** Interpolated draw position. */
  renderX(alpha) {
    return this.prevX + (this.x - this.prevX) * alpha;
  }

  renderY(alpha) {
    return this.prevY + (this.y - this.prevY) * alpha;
  }

  /** Circle-vs-circle overlap test. */
  static overlaps(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const r = a.radius + b.radius;
    return dx * dx + dy * dy <= r * r;
  }
}
