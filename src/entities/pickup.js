/**
 * entities/pickup.js — things dropped by dead enemies.
 *
 * kind 'dna'     -> protein chip into Lab inventory (arena diamonds)
 * kind 'element' -> legacy alias for dna (payload.element)
 * kind 'score'   -> points only (fallback when no drop pool)
 */
import { Entity } from './entity.js';

export class Pickup extends Entity {
  /**
   * @param {number} x
   * @param {number} y
   * @param {object} payload
   */
  constructor(x, y, payload) {
    super(x, y, 10);
    this.payload = payload;
    this.t = 0; // bob animation clock (visual only — not part of the sim)
  }

  update(dt) {
    this.beginStep();
    this.t += dt;
  }

  render(ctx, alpha) {
    const x = this.renderX(alpha);
    const y = this.renderY(alpha) + Math.sin(this.t * 4) * 3;

    ctx.font = '18px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (this.payload.kind === 'dna' || this.payload.kind === 'element') {
      ctx.fillText(this.payload.element?.icon || '💎', x, y);
    } else {
      ctx.fillText('💎', x, y);
    }
  }
}
