/**
 * entities/enemy.js — an enemy instance built from a spawner spec.
 */
import { Entity } from './entity.js';
import {
  enemySprite, enemySrc, affixSprite, fxSprite,
  drawWorldSprite, drawWorldSheet, sheetMeta
} from '../art.js';
import { pickSheetFrame } from '../systems/anim.js';
import { circleClearOfWalls } from '../systems/collision.js';

export class Enemy extends Entity {
  /** @param {object} spec see Spawner.wave() */
  constructor(spec) {
    super(spec.x, spec.y, spec.radius);
    this.spec = spec;
    this.id = spec.id;
    this.name = spec.name;
    this.maxHp = spec.hp;
    this.hp = spec.hp;
    this.speed = spec.speed;
    this.damage = spec.damage;
    this.color = spec.color;
    this.affixes = spec.affixes;
    this.xp = spec.xp;
    this.onDeath = spec.onDeath ?? null;
    this.animT = 0;
    this.behavior = spec.behavior ?? 'chase';
    this.preferDistance = spec.preferDistance ?? 0;
    this.projectile = spec.projectile ?? null;
    this.fireCooldown = 0;
    this.pendingShot = null;
    this.isBoss = !!spec.isBoss;
    this.archetypeId = spec.archetypeId ?? null;
    this.weakTags = Array.isArray(spec.weakTags) ? [...spec.weakTags] : [];
    this.weakMult = Number(spec.weakMult ?? 2) || 2;
    this.resistMult = Number(spec.resistMult ?? 1) || 1;
    this.hurtTimer = 0;
    this.dying = false;
    this.dyingT = 0;
    this._killed = false;

    this.status = {
      burn: null,
      poison: null,
      chill: null
    };
  }

  applyEffect(block) {
    switch (block.effect) {
      case 'burn':
        this.status.burn = { dps: block.dps, t: block.duration };
        break;
      case 'poison':
        this.status.poison = { dps: block.dps, t: block.duration };
        break;
      case 'chill':
        this.status.chill = { slow: block.slow, t: block.duration };
        break;
      default:
        break;
    }
  }

  takeDamage(amount, opts = {}) {
    if (!this.alive || this.dying) return false;
    let dmg = amount;
    const tags = opts.tags ?? [];
    if (this.weakTags?.length) {
      const hit = tags.some((t) => this.weakTags.includes(t));
      dmg *= hit ? this.weakMult : this.resistMult;
    }
    this.hp -= dmg;
    this.hurtTimer = 0.14;
    if (this.hp <= 0) {
      this.dying = true;
      this.dyingT = 0.2;
      this.hp = 0;
      return true;
    }
    return false;
  }

  knockback(dirX, dirY, force) {
    this.x += dirX * force * 0.1;
    this.y += dirY * force * 0.1;
  }

  update(dt, player, walls = null, arena = null, resolveSolid = null) {
    this.beginStep();

    if (this.dying) {
      this.dyingT -= dt;
      if (this.dyingT <= 0) this.alive = false;
      return;
    }

    let slow = 0;
    for (const key of ['burn', 'poison']) {
      const s = this.status[key];
      if (s) {
        this.hp -= s.dps * dt;
        s.t -= dt;
        if (s.t <= 0) this.status[key] = null;
      }
    }
    if (this.status.chill) {
      slow = this.status.chill.slow;
      this.status.chill.t -= dt;
      if (this.status.chill.t <= 0) this.status.chill = null;
    }
    if (this.hurtTimer > 0) this.hurtTimer -= dt;
    if (this.hp <= 0) {
      this.dying = true;
      this.dyingT = 0.2;
      this.hp = 0;
      return;
    }

    const dx = player.x - this.x;
    const dy = player.y - this.y;
    const dist = Math.hypot(dx, dy) || 1;
    const speed = this.speed * (1 - slow);
    const ux = dx / dist;
    const uy = dy / dist;

    // Day 250 — hold still during windup tell in the preferDistance orbit band;
    // lateral strafe there skewed locked aim so standers dodged unfairly.
    const winding = this.pendingShot && (this.pendingShot.delay ?? 0) > 0;
    const inOrbitBand = this.behavior === 'ranged'
      && this.preferDistance > 0
      && dist <= this.preferDistance + 28
      && dist >= this.preferDistance - 28;
    if (winding && inOrbitBand) {
      this.vx = 0;
      this.vy = 0;
    } else if (this.behavior === 'ranged' && this.preferDistance > 0) {
      const slack = 28;
      if (dist > this.preferDistance + slack) {
        this.vx = ux * speed;
        this.vy = uy * speed;
      } else if (dist < this.preferDistance - slack) {
        this.vx = -ux * speed;
        this.vy = -uy * speed;
      } else {
        this.vx = -uy * speed * 0.35;
        this.vy = ux * speed * 0.35;
      }
    } else if (this.behavior === 'flank') {
      const side = (this.id.charCodeAt(this.id.length - 1) % 2) ? 1 : -1;
      const orbit = this.preferDistance || 110;
      if (dist > 95) {
        const tx = player.x - uy * orbit * side;
        const ty = player.y + ux * orbit * side;
        const odx = tx - this.x;
        const ody = ty - this.y;
        const olen = Math.hypot(odx, ody) || 1;
        this.vx = (odx / olen) * speed;
        this.vy = (ody / olen) * speed;
      } else {
        this.vx = ux * speed * 1.15;
        this.vy = uy * speed * 1.15;
      }
    } else if (this.behavior === 'boss') {
      const band = this.preferDistance || 180;
      if (dist > band + 40) {
        this.vx = ux * speed;
        this.vy = uy * speed;
      } else if (dist < band - 50) {
        this.vx = -ux * speed * 0.6;
        this.vy = -uy * speed * 0.6;
      } else {
        this.vx = -uy * speed * 0.25;
        this.vy = ux * speed * 0.25;
      }
    } else {
      // Day 159 — if the straight line to the player clips a wall, pick a
      // side and keep going around (sticky) until the path opens.
      let tx = player.x;
      let ty = player.y;
      if (walls && walls.length && arena) {
        const midClear = circleClearOfWalls(
          (this.x + player.x) * 0.5,
          (this.y + player.y) * 0.5,
          this.radius,
          walls
        );
        const nearClear = circleClearOfWalls(
          this.x + ux * (this.radius + 8),
          this.y + uy * (this.radius + 8),
          this.radius,
          walls
        );
        if (!midClear || !nearClear) {
          if (this._steerSide == null) {
            this._steerSide = (this.id.charCodeAt(this.id.length - 1) % 2) ? 1 : -1;
          }
          const side = this._steerSide;
          // Orbit-ish waypoint: sideways past the wall, still biased to player.
          tx = this.x + (-uy) * side * 110 + ux * 40;
          ty = this.y + (ux) * side * 110 + uy * 40;
          tx = Math.min(Math.max(tx, this.radius + 8), arena.w - this.radius - 8);
          ty = Math.min(Math.max(ty, this.radius + 8), arena.h - this.radius - 8);
        } else {
          this._steerSide = null;
        }
      }
      const odx = tx - this.x;
      const ody = ty - this.y;
      const olen = Math.hypot(odx, ody) || 1;
      this.vx = (odx / olen) * speed;
      this.vy = (ody / olen) * speed;
    }
    // World passes walls for slide; fallback Euler if not.
    if (walls && arena && resolveSolid) {
      this.integrateSlide(dt, walls, arena, resolveSolid);
    } else {
      this.integrate(dt);
    }
    this.animT += dt;

    if (this.fireCooldown > 0) this.fireCooldown -= dt;
    if (this.pendingShot) {
      this.pendingShot.delay -= dt;
    }
    const canShoot = this.behavior === 'ranged' || this.behavior === 'boss';
    if (
      canShoot &&
      this.projectile &&
      !this.pendingShot &&
      this.fireCooldown <= 0 &&
      dist < (this.projectile.range ?? 400) &&
      dist > 40
    ) {
      const windup = this.projectile.windupSec ?? 0;
      this.pendingShot = { x: ux, y: uy, delay: windup, maxDelay: windup };
      this.fireCooldown = this.projectile.cooldown ?? 1.4;
    }
  }

  render(ctx, alpha) {
    const x = this.renderX(alpha);
    const y = this.renderY(alpha);

    const artId = this.spec.isSpawnling ? 'spawnling' : this.spec.archetypeId;
    const img = enemySprite(artId);
    const size = (this.spec.isSpawnling ? this.radius * 2.2 : this.radius * 2.4);
    const meta = sheetMeta(enemySrc(artId));
    const moving = Math.hypot(this.vx, this.vy) > 8;
    let animName = moving ? 'move' : 'idle';
    if (this.dying && meta?.anims?.death) animName = 'death';
    else if (this.hurtTimer > 0 && meta?.anims?.hurt) animName = 'hurt';
    else if (
      this.pendingShot &&
      (this.pendingShot.delay ?? 0) > 0 &&
      meta?.anims?.telegraph
    ) {
      animName = 'telegraph';
    } else if (this.isBoss && meta?.anims) {
      if (this.hp < this.maxHp * 0.33 && meta.anims.hurt) animName = 'hurt';
      else if (this.fireCooldown > (this.projectile?.cooldown ?? 1) * 0.7
        && meta.anims.telegraph) animName = 'telegraph';
    }
    let drew = false;
    if (meta && img) {
      const pick = pickSheetFrame(meta, animName, this.animT);
      drew = drawWorldSheet(ctx, img, x, y, size, pick.frame, pick.cols);
    } else {
      drew = drawWorldSprite(ctx, img, x, y, size);
    }
    if (!drew) {
      ctx.fillStyle = this.biomeTint || this.color;
      ctx.beginPath();
      ctx.arc(x, y, this.radius, 0, Math.PI * 2);
      ctx.fill();
    } else if (this.biomeTint) {
      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = this.biomeTint;
      ctx.beginPath();
      ctx.arc(x, y, this.radius * 1.05, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    this.affixes.forEach((affix, i) => {
      const overlay = affixSprite(affix.id);
      const ringSize = size * (1.08 + i * 0.06);
      if (overlay) {
        ctx.save();
        ctx.globalAlpha = 0.92;
        drawWorldSprite(ctx, overlay, x, y, ringSize);
        ctx.restore();
      } else {
        ctx.strokeStyle = affix.tint;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, this.radius + 3 + i * 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    });

    const statusFx = [
      ['burn', 'status_burn', '#ff6b35'],
      ['poison', 'status_poison', '#7cfc00'],
      ['chill', 'status_chill', '#5bc8ff']
    ];
    statusFx.forEach(([key, fxId, fallback], i) => {
      if (!this.status[key]) return;
      const stamp = fxSprite(fxId);
      const ox = x - 8 + i * 8;
      const oy = y - this.radius - 8;
      if (!drawWorldSprite(ctx, stamp, ox, oy, 14)) {
        ctx.fillStyle = fallback;
        ctx.beginPath();
        ctx.arc(ox, oy, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    if (this.hp < this.maxHp && !this.dying) {
      const w = this.radius * 2;
      ctx.fillStyle = '#222';
      ctx.fillRect(x - w / 2, y + this.radius + 4, w, 3);
      ctx.fillStyle = '#e63946';
      ctx.fillRect(x - w / 2, y + this.radius + 4, w * Math.max(this.hp / this.maxHp, 0), 3);
    }
  }
}
