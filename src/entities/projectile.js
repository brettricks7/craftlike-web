/**
 * entities/projectile.js — a shot fired from a (possibly crafted) element
 * or a hostile enemy archetype.
 *
 * Player shots: numbers from element.stats (data/proteins.json + craft).
 * Hostile shots: numbers from archetype.projectile (data/enemies.json).
 */
import { Entity } from './entity.js';
import {
  projectileArtId, projectileSrc, projectileSprite,
  drawWorldSheet, drawWorldElongatedSheet, drawWorldSprite, sheetMeta
} from '../art.js';
import { pickSheetFrame } from '../systems/anim.js';
import {
  resolveShotFormId, formMotionAt, formMotionKnobs, getFormMotionConfig
} from '../systems/form-motion.js';
import { resolveShotTag, tagSecondaryAt } from '../systems/tag-secondary.js';
import { comboFingerprintAt } from '../systems/combo-fingerprint.js';

export class Projectile extends Entity {
  /**
   * @param {number} x
   * @param {number} y
   * @param {{x,y}}  dir unit direction
   * @param {object} element player element/ability OR synthetic { stats, color }
   * @param {{ hostile?: boolean, ownerId?: string }} [opts]
   */
  constructor(x, y, dir, element, opts = {}) {
    super(x, y, element.stats.radius);
    this.element = element;
    this.damage = element.stats.damage;
    this.knockbackForce = element.stats.knockback ?? 0;
    this.vx = dir.x * element.stats.speed;
    this.vy = dir.y * element.stats.speed;

    // Lifetime derived from range so "range" is the designer-facing knob.
    this.life = element.stats.range / Math.max(element.stats.speed, 1);

    // Pierce: how many extra enemies this shot can pass through.
    const pierce = element.effects?.find((e) => e.effect === 'pierce');
    this.pierceLeft = pierce ? pierce.pierces : 0;

    // Used so chain/split don't re-hit the same enemy in one impact.
    this.hitIds = new Set();

    this.color = element.color ?? '#ffffff';
    this.hostile = !!opts.hostile;
    this.ownerId = opts.ownerId ?? null;
    this.animT = 0;
    this.artId = projectileArtId(element, this.hostile);
    this.formId = this.hostile ? null : resolveShotFormId(element);
    this.motionPhase = Math.atan2(dir.y, dir.x);
  }

  /** Enemy spit / bolt — not crafted; still deterministic. */
  static hostile(x, y, dir, proj, ownerId) {
    const element = {
      stats: {
        damage: proj.damage,
        speed: proj.speed,
        radius: proj.radius,
        range: proj.range,
        knockback: proj.knockback ?? 0
      },
      color: proj.color ?? '#80ffdb',
      effects: []
    };
    return new Projectile(x, y, dir, element, { hostile: true, ownerId });
  }

  update(dt) {
    this.beginStep();
    this.integrate(dt);
    this.animT += dt;
    this.life -= dt;
    if (this.life <= 0) this.alive = false;
  }

  _fingerprintKnobs() {
    if (this.hostile) return null;
    return this.element?.comboFingerprint ?? null;
  }

  _motionSample(rot) {
    if (this.hostile || !this.formId) {
      return {
        dx: 0, dy: 0, scale: 1, stretch: 1, rotExtra: 0,
        thickness: 1, trailSegments: 0, exhaustSegments: 0
      };
    }
    const knobs = formMotionKnobs(this.formId, getFormMotionConfig());
    return formMotionAt(this.formId, this.animT, knobs, {
      velAngle: rot,
      phase: this.motionPhase,
      tag: resolveShotTag(this.element),
      fingerprint: this._fingerprintKnobs()
    });
  }

  _tagSecondarySample(rot) {
    if (this.hostile) return tagSecondaryAt(null, this.animT, { muted: true });
    return tagSecondaryAt(resolveShotTag(this.element), this.animT, {
      velAngle: rot,
      phase: this.motionPhase,
      fingerprint: this._fingerprintKnobs()
    });
  }

  _comboFingerprintSample(rot) {
    if (this.hostile) return comboFingerprintAt(this.animT, null, { muted: true });
    return comboFingerprintAt(this.animT, this._fingerprintKnobs(), { velAngle: rot });
  }

  render(ctx, alpha) {
    const rot = Math.atan2(this.vy, this.vx);
    const motion = this._motionSample(rot);
    const secondary = this._tagSecondarySample(rot);
    const fingerprint = this._comboFingerprintSample(rot);
    const x = this.renderX(alpha) + motion.dx + secondary.sparkDx + fingerprint.orbitDx;
    const y = this.renderY(alpha) + motion.dy + secondary.sparkDy + fingerprint.orbitDy;
    const drawRot = rot + motion.rotExtra;
    const stretchMul = motion.stretch * fingerprint.stretchMul;
    const size = Math.max(this.radius * 3.2, 14)
      * motion.scale * fingerprint.scaleMul * (1 + secondary.pulseScale);
    const pngPath = projectileSrc(this.artId);
    const img = projectileSprite(this.artId);
    const meta = sheetMeta(pngPath);
    let drew = false;

    this._drawComboFingerprintWash(ctx, x, y, drawRot, size, fingerprint);
    this._drawTagSecondaryCues(ctx, x, y, drawRot, size, secondary);

    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = prevAlpha * (secondary.flicker ?? 1) * (fingerprint.stripeMod ?? 1);

    const motionDraw = { ...motion, stretch: stretchMul };

    if (this.formId === 'beam') {
      drew = this._renderBeam(ctx, x, y, drawRot, size, img, meta, motionDraw);
    } else if (this.formId === 'rocket') {
      drew = this._renderRocket(ctx, x, y, drawRot, size, img, meta, motionDraw);
    } else if (this.formId === 'spray') {
      drew = this._renderSpray(ctx, x, y, drawRot, size, img, meta, motionDraw);
    } else if (meta && img) {
      const pick = pickSheetFrame(meta, 'pulse', this.animT);
      drew = drawWorldSheet(ctx, img, x, y, size, pick.frame, pick.cols, drawRot);
    } else {
      drew = drawWorldSprite(ctx, img, x, y, size, drawRot);
    }

    ctx.globalAlpha = prevAlpha;

    if (!drew) {
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.arc(x, y, this.radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Combo fingerprint accent wash — single hue, under form stamp (Day 263). */
  _drawComboFingerprintWash(ctx, x, y, rot, size, fingerprint) {
    if (!fingerprint.accent || !fingerprint.wakeAlpha) return;
    const [r, g, b] = fingerprint.accent;
    const alpha = fingerprint.wakeAlpha;
    const halo = size * 0.72;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = `rgba(${r},${g},${b},1)`;
    ctx.fillRect(-halo, -halo * 0.42, halo * 2.1, halo * 0.84);
    ctx.restore();
  }

  /** Tag secondary trail / wisps — layered under form stamp (Day 262). */
  _drawTagSecondaryCues(ctx, x, y, rot, size, secondary) {
    const segs = secondary.trailSegments || secondary.wispSegments || 0;
    if (segs <= 0 || !secondary.tint) return;
    const wide = secondary.trailWide ?? 1;
    const alphaBase = secondary.wakeAlpha || 0.2;
    const wispy = secondary.wispSegments > 0;
    for (let i = 1; i <= segs; i++) {
      const t = i / (segs + 1);
      const alpha = alphaBase * (1 - t);
      const back = size * (wispy ? 0.55 : 0.45) * t;
      const segSize = size * 0.22 * (1 - t * 0.3) * wide;
      const spread = wispy ? Math.sin(this.animT * 8 + i) * segSize * 0.35 : 0;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = secondary.tint;
      ctx.fillRect(-size * 0.15 - back, -segSize / 2 + spread, segSize * 1.35, segSize);
      ctx.restore();
    }
  }

  /** Beam lance: elongated stamp + deterministic trail (presentation only). */
  _renderBeam(ctx, x, y, rot, size, img, meta, motion) {
    const length = size * motion.stretch;
    const thick = size * motion.thickness;
    this._drawBeamTrail(ctx, x, y, rot, length, thick, motion);
    const pick = meta && img
      ? pickSheetFrame(meta, 'pulse', this.animT)
      : { frame: 0, cols: 1 };
    if (img) {
      return drawWorldElongatedSheet(
        ctx, img, x, y, length, thick, pick.frame, pick.cols, rot
      );
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.fillStyle = this.color;
    ctx.globalAlpha = 0.72;
    ctx.fillRect(-length / 2, -thick / 2, length, thick);
    ctx.restore();
    return true;
  }

  _drawBeamTrail(ctx, x, y, rot, length, thick, motion) {
    const segments = motion.trailSegments ?? 3;
    const pulse = motion.stretch / (formMotionKnobs('beam').stretchBase || 2.65);
    for (let i = 1; i <= segments; i++) {
      const t = i / (segments + 1);
      const alpha = (1 - t) * 0.32 * pulse;
      const segLen = length * 0.28 * (1 - t * 0.35);
      const back = length * 0.42 * t + this.radius * 0.6;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = this.color;
      ctx.fillRect(-length / 2 - back, -thick * 0.28, segLen, thick * 0.55);
      ctx.restore();
    }
  }

  /** Spray pellet: squashed stamp + high-frequency flutter. */
  _renderSpray(ctx, x, y, rot, size, img, meta, motion) {
    const length = size * motion.stretch;
    const thick = size;
    const pick = meta && img
      ? pickSheetFrame(meta, 'pulse', this.animT)
      : { frame: 0, cols: 1 };
    if (img) {
      return drawWorldElongatedSheet(
        ctx, img, x, y, length, thick, pick.frame, pick.cols, rot
      );
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.fillStyle = this.color;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(-length / 2, -thick / 2, length, thick);
    ctx.restore();
    return true;
  }

  /** Rocket: corkscrew drift + slow spin + exhaust puffs. */
  _renderRocket(ctx, x, y, rot, size, img, meta, motion) {
    const length = size * motion.stretch;
    const thick = size * motion.thickness;
    this._drawRocketExhaust(ctx, x, y, rot, length, thick, motion);
    const pick = meta && img
      ? pickSheetFrame(meta, 'pulse', this.animT)
      : { frame: 0, cols: 1 };
    if (img) {
      return drawWorldElongatedSheet(
        ctx, img, x, y, length, thick, pick.frame, pick.cols, rot
      );
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.fillStyle = this.color;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(-length / 2, -thick / 2, length, thick);
    ctx.restore();
    return true;
  }

  _drawRocketExhaust(ctx, x, y, rot, length, thick, motion) {
    const segments = motion.exhaustSegments ?? 2;
    for (let i = 1; i <= segments; i++) {
      const t = i / (segments + 1);
      const alpha = (1 - t) * 0.4;
      const puffLen = length * 0.22 * (1 - t * 0.2);
      const puffThick = thick * (1.1 + t * 0.35);
      const back = length * 0.55 * t + this.radius * 0.8;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = this.color;
      ctx.fillRect(-length / 2 - back, -puffThick / 2, puffLen, puffThick);
      ctx.restore();
    }
  }
}
