/**
 * systems/spawner.js — seeded, data-driven enemy generation.
 *
 * Enemies are composed, not authored: archetype x wave scaling x affixes.
 * A wave-5 "Swift Armored Brute" was never hand-placed — it falls out of
 * data/enemies.json and the run seed. Same seed -> same waves, always.
 *
 * All randomness comes from one named RandomStream owned by the run
 * (rng.stream('spawns')), so loot rolls or combat rolls can never shift
 * which enemies appear.
 */

import { circleClearOfWalls, findClearSpawn, segmentClearOfWalls } from './collision.js';

/** Weighted pick using the provided stream. */
function weightedPick(stream, items) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let r = stream.float(0, total);
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

export class Spawner {
  /**
   * @param {object} enemiesData data/enemies.json
   * @param {RandomStream} stream the run's 'spawns' stream
   */
  constructor(enemiesData, stream) {
    this.data = enemiesData;
    this.scaling = enemiesData.scaling;
    this.stream = stream;
    this._serial = 0; // unique id counter for spawned enemies
  }

  /**
   * @param {number} n          wave number (difficulty driver)
   * @param {{w,h}}  arena
   * @param {number} intensity
   * @param {object[]} walls
   * @param {{ depth?: number, waveInChamber?: number }} [ctx]
   */
  wave(n, arena, intensity = 1, walls = [], ctx = {}) {
    const s = this.scaling;
    const count = Math.max(
      1,
      Math.floor((s.countBase + s.countPerWave * (n - 1)) * intensity)
    );

    const depth = Number(ctx.depth ?? 0) || 0;
    const waveInChamber = Number(ctx.waveInChamber ?? n) || n;
    const teach = this.data.curriculum?.puzzleTeach;
    const teachB = this.data.curriculum?.puzzleTeachB;
    const specs = [];
    for (let i = 0; i < count; i++) {
      const forceA =
        teach &&
        i === 0 &&
        depth <= (teach.maxDepth ?? 1) &&
        waveInChamber === (teach.guaranteeOnWave ?? 1);
      const forceB =
        !forceA &&
        teachB &&
        i === 0 &&
        depth >= (teachB.minDepth ?? 0) &&
        depth <= (teachB.maxDepth ?? 2) &&
        waveInChamber === (teachB.guaranteeOnWave ?? 2);
      if (forceA || forceB) {
        const id = forceA ? teach.archetypeId : teachB.archetypeId;
        specs.push(this.named(id, arena, walls, intensity));
        specs[specs.length - 1].wave = n;
      } else {
        specs.push(this._buildSpec(n, arena, intensity, walls, { depth }));
      }
    }

    // Day 181 — turret-breaker: from minDepth, every wave carries ranged
    // fire so a stationary player can't face-tank the whole chamber.
    const rp = this.data.curriculum?.rangedPressure;
    if (rp && depth >= (rp.minDepth ?? 2) && specs.length >= 2 &&
        !specs.some((sp) => sp.behavior === 'ranged')) {
      this._swapSlotForArchetype(
        specs, n, arena, walls, intensity, rp.archetypeId, -1,
        (sp) => sp.behavior === 'ranged'
      );
    }

    // Day 215 — neural-only: extra ranged at depth 0 + flank mover so
    // stand-still turret / corner stall cannot face-tank nerve chambers.
    const np = this.data.curriculum?.neuralPressure;
    if (np && ctx.patientId === 'neural') {
      if (np.ranged) {
        this._swapSlotForArchetype(
          specs, n, arena, walls, intensity,
          np.ranged.archetypeId ?? 'spitter', -1,
          (sp) => sp.behavior === 'ranged',
          np.ranged.minDepth ?? 0, depth
        );
      }
      if (np.mover) {
        this._swapSlotForArchetype(
          specs, n, arena, walls, intensity,
          np.mover.archetypeId ?? 'skitter', 0,
          (sp) => sp.behavior === 'flank' || sp.archetypeId === 'darter',
          np.mover.minDepth ?? 0, depth
        );
      }
    }
    return specs;
  }

  /** Swap one wave slot for a named archetype when pressure is missing. */
  _swapSlotForArchetype(
    specs, n, arena, walls, intensity, archetypeId, slotIndex,
    hasPressure, minDepth = 0, depth = 0
  ) {
    if (depth < minDepth || specs.length < 2 || specs.some(hasPressure)) return;
    const forced = this.named(archetypeId, arena, walls, intensity);
    forced.wave = n;
    specs[slotIndex < 0 ? specs.length + slotIndex : slotIndex] = forced;
  }

  /** Infection Core boss + opening guards (Day 018). */
  coreBoss(arena, walls = []) {
    const arch = this.data.archetypes.find((a) => a.id === 'infection_core');
    if (!arch) throw new Error('infection_core archetype missing');
    const spot = findClearSpawn(arena.w / 2, arena.h * 0.38, arch.radius, walls, arena);
    return this._specFromArch(arch, spot.x, spot.y, 1);
  }

  /** Named archetype spawn (no affixes) for Core phase adds. */
  named(archetypeId, arena, walls = [], intensity = 1) {
    const arch = this.data.archetypes.find((a) => a.id === archetypeId);
    if (!arch) throw new Error(`unknown archetype ${archetypeId}`);
    const { x, y } = this._safeEdgePoint(arena, this.scaling.spawnMargin, arch.radius, walls);
    return this._specFromArch(arch, x, y, intensity);
  }

  _specFromArch(arch, x, y, intensity = 1) {
    return {
      id: `enemy:${this._serial++}`,
      archetypeId: arch.id,
      name: arch.name,
      x,
      y,
      hp: arch.hp * intensity,
      speed: arch.speed,
      damage: arch.damage * intensity,
      radius: arch.radius,
      color: arch.color,
      xp: Math.ceil(arch.xp * intensity),
      affixes: [],
      onDeath: null,
      childSpec: null,
      wave: 0,
      behavior: arch.behavior ?? 'chase',
      preferDistance: arch.preferDistance ?? 0,
      projectile: arch.projectile ? { ...arch.projectile } : null,
      isBoss: !!arch.isBoss,
      weakTags: Array.isArray(arch.weakTags) ? [...arch.weakTags] : [],
      weakMult: arch.weakMult ?? 2,
      resistMult: arch.resistMult ?? 1
    };
  }

  _buildSpec(n, arena, intensity = 1, walls = [], ctx = {}) {
    const s = this.scaling;
    const depth = Number(ctx.depth ?? 0) || 0;
    const teach = this.data.curriculum?.puzzleTeach;
    const archPool = this.data.archetypes
      .filter((a) => (a.weight ?? 0) > 0)
      .map((a) => {
        let w = a.weight ?? 0;
        const teach = this.data.curriculum?.puzzleTeach;
        const teachB = this.data.curriculum?.puzzleTeachB;
        if (teach && a.id === teach.archetypeId) {
          w *= depth <= (teach.maxDepth ?? 1)
            ? Number(teach.earlyWeightMult ?? 1)
            : Number(teach.lateWeightMult ?? 1);
        }
        if (teachB && a.id === teachB.archetypeId) {
          const early = depth >= (teachB.minDepth ?? 0) && depth <= (teachB.maxDepth ?? 2);
          w *= early
            ? Number(teachB.earlyWeightMult ?? 1)
            : Number(teachB.lateWeightMult ?? 1);
        }
        return { ...a, weight: Math.max(w, 0.01) };
      });
    const arch = weightedPick(this.stream, archPool);

    // --- Affixes: chance scales with wave, capped, no duplicates ---
    const affixes = [];
    const chance = Math.min(s.affixChanceCap, s.affixChancePerWave * n);
    const pool = [...this.data.affixes];
    for (let i = 0; i < s.maxAffixes && pool.length > 0; i++) {
      if (!this.stream.chance(chance)) break;
      const idx = this.stream.int(0, pool.length - 1);
      affixes.push(pool.splice(idx, 1)[0]);
    }

    // --- Wave scaling x chamber intensity, then affix multipliers on top ---
    // (speed is intentionally NOT intensity-scaled: harder should mean
    // tankier and meaner, not unreadably fast.)
    const waveMult = (per) => 1 + per * (n - 1);
    let hp = arch.hp * waveMult(s.hpPerWave) * intensity;
    let speed = arch.speed * waveMult(s.speedPerWave);
    let damage = arch.damage * waveMult(s.damagePerWave) * intensity;
    let radius = arch.radius;
    let onDeath = null;
    let childSpec = null;

    for (const affix of affixes) {
      hp *= affix.mults?.hp ?? 1;
      speed *= affix.mults?.speed ?? 1;
      damage *= affix.mults?.damage ?? 1;
      radius *= affix.mults?.radius ?? 1;
      if (affix.onDeath === 'split') {
        onDeath = 'split';
        childSpec = { count: affix.childCount, scale: affix.childScale };
      }
    }

    // --- Spawn position: edge point that clears chamber walls ---
    const { x, y } = this._safeEdgePoint(arena, s.spawnMargin, radius, walls);

    return {
      id: `enemy:${this._serial++}`,
      archetypeId: arch.id,
      name: [...affixes.map((a) => a.name), arch.name].join(' '),
      x,
      y,
      hp,
      speed,
      damage,
      radius,
      color: arch.color,
      // Elites and high-pressure chambers are worth more.
      xp: Math.ceil(arch.xp * (1 + affixes.length) * intensity),
      affixes,
      onDeath,
      childSpec,
      wave: n,
      behavior: arch.behavior ?? 'chase',
      preferDistance: arch.preferDistance ?? 0,
      projectile: arch.projectile
        ? { ...arch.projectile }
        : null,
      isBoss: !!arch.isBoss,
      weakTags: Array.isArray(arch.weakTags) ? [...arch.weakTags] : [],
      weakMult: arch.weakMult ?? 2,
      resistMult: arch.resistMult ?? 1
    };
  }

  /** Build a child spec for splitting enemies (no affixes, scaled down). */
  childOf(parentSpec, offsetIndex) {
    const scale = parentSpec.childSpec.scale;
    return {
      ...parentSpec,
      id: `enemy:${this._serial++}`,
      name: 'Spawnling',
      isSpawnling: true,
      x: parentSpec.x + (offsetIndex * 2 - 1) * 14, // fan children out a bit
      y: parentSpec.y,
      hp: parentSpec.hp * scale,
      damage: parentSpec.damage * scale,
      radius: Math.max(parentSpec.radius * scale, 5),
      xp: Math.ceil(parentSpec.xp * scale),
      affixes: [],
      onDeath: null, // children never split again
      childSpec: null
    };
  }

  /**
   * Edge spawn that rejects wall overlap (re-roll), then spirals clear.
   * Prefers a shot-line to arena center so cover doesn't softlock chamber 1.
   */
  _safeEdgePoint(arena, margin, radius, walls) {
    const attempts = 24;
    const cx = arena.w / 2;
    const cy = arena.h / 2;
    let last = { x: cx, y: margin };
    let fallback = null;
    for (let i = 0; i < attempts; i++) {
      last = this._edgePoint(arena, margin);
      if (!circleClearOfWalls(last.x, last.y, radius, walls)) continue;
      if (!fallback) fallback = last;
      // Prefer spawns that can see the chamber middle (player entry zone).
      if (segmentClearOfWalls(last.x, last.y, cx, cy, walls, Math.max(2, radius * 0.3))) {
        return last;
      }
    }
    if (fallback) return fallback;
    return findClearSpawn(last.x, last.y, radius, walls, arena);
  }

  _edgePoint(arena, margin) {
    const side = this.stream.int(0, 3); // 0=top 1=right 2=bottom 3=left
    switch (side) {
      case 0: return { x: this.stream.float(0, arena.w), y: margin };
      case 1: return { x: arena.w - margin, y: this.stream.float(0, arena.h) };
      case 2: return { x: this.stream.float(0, arena.w), y: arena.h - margin };
      default: return { x: margin, y: this.stream.float(0, arena.h) };
    }
  }
}
