/**
 * entities/player.js — the player avatar.
 *
 * All balance numbers (hp, speed, i-frames...) come from data/player.json —
 * never hardcode a tunable here.
 */
import { Entity } from './entity.js';
import {
  playerSprite, playerSrc, drawWorldSprite, drawWorldSheet, sheetMeta
} from '../art.js';
import { pickSheetFrame } from '../systems/anim.js';

export class Player extends Entity {
  /**
   * @param {object} stats data/player.json
   * @param {number} x spawn x
   * @param {number} y spawn y
   */
  constructor(stats, x, y) {
    super(x, y, stats.radius);
    // Clone — Electron bridge freezes data/*.json; mutability needed for
    // Day 064 Blink knob sync from ability_modules.
    this.stats = {
      ...stats,
      dash: stats.dash ? { ...stats.dash } : undefined,
      loadout: stats.loadout ? { ...stats.loadout } : undefined
    };
    this.maxHp = stats.hp;
    this.hp = stats.hp;
    this.speed = stats.speed;
    this.invulnTimer = 0;     // seconds of remaining invulnerability
    this.fireCooldown = 0;    // seconds until the next shot is allowed
    this.aim = { x: 1, y: 0 };
    this.animT = 0;

    // Dash state (all knobs in data/player.json -> stats.dash).
    this.dashTimer = 0;               // remaining burst seconds
    this.dashCooldown = 0;            // seconds until the next dash
    this.dashDir = { x: 0, y: 0 };    // locked direction for the burst
    this.dashTrail = [];              // presentation afterimages [{x,y,t}]
    this.hurtTimer = 0;
    // Day 066 — absorb shield (Ability defense cast)
    this.shieldHp = 0;
    this.shieldTimer = 0;
  }

  /**
   * @param {number}  dt        fixed step seconds
   * @param {{x,y}}   move      normalized movement vector from InputManager
   * @param {{w,h}}   arena     playfield bounds for clamping
   */
  update(dt, move, arena) {
    this.beginStep();

    const d = this.stats.dash;
    if (this.dashTimer > 0 && d) {
      // The burst overrides steering — commit to the dash/blink.
      this.vx = this.dashDir.x * this.speed * d.speedMult;
      this.vy = this.dashDir.y * this.speed * d.speedMult;
      this.dashTimer -= dt;
    } else {
      this.vx = move.x * this.speed;
      this.vy = move.y * this.speed;
    }
    this.integrate(dt);

    // Keep the player inside the arena.
    this.x = Math.min(Math.max(this.x, this.radius), arena.w - this.radius);
    this.y = Math.min(Math.max(this.y, this.radius), arena.h - this.radius);

    if (this.invulnTimer > 0) this.invulnTimer -= dt;
    if (this.fireCooldown > 0) this.fireCooldown -= dt;
    if (this.dashCooldown > 0) this.dashCooldown -= dt;
    if (this.hurtTimer > 0) this.hurtTimer -= dt;
    if (this.shieldTimer > 0) {
      this.shieldTimer -= dt;
      if (this.shieldTimer <= 0) {
        this.shieldTimer = 0;
        this.shieldHp = 0;
      }
    }
    this.animT += dt;

    // Decay dash afterimages (presentation only).
    this.dashTrail = this.dashTrail.filter((g) => (g.t -= dt) > 0);
    if (this.dashTimer > 0 && Math.floor(this.animT * 45) % 2 === 0) {
      this.dashTrail.push({ x: this.x, y: this.y, t: 0.16 });
    }
  }

  /**
   * Start Blink-Dash burst (Ability A). Knobs from stats.dash
   * (synced from ability_modules.blink on World boot).
   * @returns {boolean} true if the blink started
   */
  requestBlink(move) {
    const d = this.stats.dash;
    if (!d || this.dashCooldown > 0) return false;
    const dir = (move.x || move.y) ? move : this.aim;
    const len = Math.hypot(dir.x, dir.y) || 1;
    this.dashDir = { x: dir.x / len, y: dir.y / len };
    this.dashTimer = d.duration;
    this.dashCooldown = d.cooldown;
    this.invulnTimer = Math.max(this.invulnTimer, d.invuln);
    return true;
  }

  /**
   * Day 066 — absorb shield. Duration ticks down in update(); HP pool absorbs hits.
   */
  activateShield({ absorb = 25, duration = 1.2 } = {}) {
    this.shieldHp = absorb;
    this.shieldTimer = duration;
  }

  /** Apply contact damage, respecting shield absorb then i-frames. Returns true if HP lost. */
  hit(damage) {
    if (this.shieldHp > 0 && damage > 0) {
      const absorbed = Math.min(this.shieldHp, damage);
      this.shieldHp -= absorbed;
      damage -= absorbed;
      if (this.shieldHp <= 0) {
        this.shieldHp = 0;
        this.shieldTimer = 0;
      }
      if (damage <= 0) return false;
    }
    if (this.invulnTimer > 0) return false;
    this.hp -= damage;
    this.invulnTimer = this.stats.invulnSeconds;
    this.hurtTimer = 0.16;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
    }
    return true;
  }

  render(ctx, alpha) {
    const x = this.renderX(alpha);
    const y = this.renderY(alpha);

    // Dash trail — cyan afterimages behind the nanobot.
    const size = this.radius * 2.6;
    const rot = Math.atan2(this.aim.y, this.aim.x);
    const img = playerSprite('nanobot');
    const meta = sheetMeta(playerSrc('nanobot'));
    for (const g of this.dashTrail) {
      const a = (g.t / 0.16) * 0.42;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = '#4cc9f0';
      ctx.beginPath();
      ctx.arc(g.x, g.y, this.radius * 0.85, 0, Math.PI * 2);
      ctx.fill();
      if (img) {
        ctx.globalAlpha = a * 0.55;
        if (meta && img) {
          const pick = pickSheetFrame(meta, 'move', this.animT);
          drawWorldSheet(ctx, img, g.x, g.y, size * 0.9, pick.frame, pick.cols, rot);
        } else {
          drawWorldSprite(ctx, img, g.x, g.y, size * 0.9, rot);
        }
      }
      ctx.restore();
    }

    // Blink while invulnerable — faster during dash i-frames.
    const dashInvuln = this.dashTimer > 0 && this.invulnTimer > 0;
    const flashRate = dashInvuln ? 18 : 12;
    const flashing = this.invulnTimer > 0 && Math.floor(this.invulnTimer * flashRate) % 2 === 0;
    ctx.globalAlpha = flashing ? (dashInvuln ? 0.25 : 0.35) : 1;

    const moving = Math.hypot(this.vx, this.vy) > 8;
    let animName = moving ? 'move' : 'idle';
    if (!this.alive && meta?.anims?.death) animName = 'death';
    else if (this.hurtTimer > 0 && meta?.anims?.hurt) animName = 'hurt';
    let drew = false;
    if (meta && img) {
      const pick = pickSheetFrame(meta, animName, this.animT);
      drew = drawWorldSheet(ctx, img, x, y, size, pick.frame, pick.cols, rot);
    } else {
      drew = drawWorldSprite(ctx, img, x, y, size, rot);
    }
    if (!drew) {
      // Fallback: circle stand-in if art missing.
      ctx.fillStyle = '#4cc9f0';
      ctx.beginPath();
      ctx.arc(x, y, this.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#caf0f8';
      ctx.beginPath();
      ctx.arc(x + this.aim.x * this.radius, y + this.aim.y * this.radius, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = 1;

    // Shield bubble (Day 066) — glanceable cyan ring while absorb remains.
    if (this.shieldHp > 0 && this.shieldTimer > 0) {
      ctx.save();
      ctx.strokeStyle = 'rgba(128,255,219,0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, this.radius + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
}
