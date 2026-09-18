/**
 * systems/juice.js — presentation-only juice (Days 043–049).
 *
 * Determinism policy: this module is consumed ONLY by src/game.js (renderer).
 * src/world.js never imports it. Hit-stop may skip sim ticks in the renderer
 * loop for a brief beat; headless world tests and botplay bypass this path.
 */

/** Resolve Lab commit knobs by hook kind (Day 230: take vs seat). */
export function labCommitTiming(cfg = {}, kind = 'take') {
  const lab = cfg.labCommit ?? {};
  const hook = kind === 'seat' ? 'seat' : 'take';
  const sub = lab[hook] ?? lab;
  return {
    hook,
    duration: sub.duration ?? 0.36,
    particleCount: sub.particleCount ?? 10,
    shake: sub.shake ?? 2.8,
    stampOuter: sub.stampOuter ?? '#80ffdb',
    stampInner: sub.stampInner ?? '#ffd166'
  };
}

/** Presentation-only secret-pattern soft pulse (Day 231). Pulse + SFX only — no coach copy. */
export function secretDiscoverTiming(cfg = {}) {
  const fx = cfg.secretDiscoverFx ?? {};
  return {
    duration: fx.duration ?? 0.28,
    pulseAlpha: fx.pulseAlpha ?? 0.22,
    vignetteColor: fx.vignetteColor ?? '#b388ff'
  };
}

/** Presentation-only Attack form-change identity beat (Day 239). Distinct from pivot toast / lab commit. */
export function attackFormBeatTiming(cfg = {}) {
  const fx = cfg.attackFormBeat ?? {};
  return {
    duration: fx.duration ?? 0.32,
    shake: fx.shake ?? 1.2,
    particleCount: fx.particleCount ?? 8,
    stampOuter: fx.stampOuter ?? '#fbbf24',
    stampInner: fx.stampInner ?? '#5eead4'
  };
}

/** Presentation-only volatile fuse spike identity beat (Day 246). Distinct from form / B / pivot toast. */
export function volatileFuseBeatTiming(cfg = {}) {
  const fx = cfg.volatileFuseBeat ?? {};
  return {
    duration: fx.duration ?? 0.34,
    shake: fx.shake ?? 2.2,
    particleCount: fx.particleCount ?? 10,
    stampOuter: fx.stampOuter ?? '#ef4444',
    stampInner: fx.stampInner ?? '#fb923c'
  };
}

/** Presentation-only Ability B Lab equip identity beat (Day 240). Distinct from Attack form stamp. */
export function abilityBBeatTiming(cfg = {}) {
  const fx = cfg.abilityBBeat ?? {};
  return {
    duration: fx.duration ?? 0.28,
    shake: fx.shake ?? 1.0,
    particleCount: fx.particleCount ?? 6,
    stampOuter: fx.stampOuter ?? '#e040fb',
    stampInner: fx.stampInner ?? '#80ffdb'
  };
}

/** Presentation-only clever-pattern synergy find (Day 235). Louder than mindless seat — no coach copy. */
export function synergyFindTiming(cfg = {}) {
  const fx = cfg.synergyFindFx ?? {};
  return {
    duration: fx.duration ?? 0.38,
    pulseAlpha: fx.pulseAlpha ?? 0.42,
    shake: fx.shake ?? 3.4,
    particleCount: fx.particleCount ?? 14,
    stampOuter: fx.stampOuter ?? '#4cc9f0',
    stampInner: fx.stampInner ?? '#ffd166',
    vignetteColor: fx.vignetteColor ?? '#4cc9f0'
  };
}

/** Presentation-only pattern almost-there nudge (Day 260). Softer than synergy/secret — no coach copy. */
export function patternAlmostTiming(cfg = {}) {
  const fx = cfg.patternAlmostFx ?? {};
  return {
    duration: fx.duration ?? 0.22,
    pulseAlpha: fx.pulseAlpha ?? 0.14,
    particleCount: fx.particleCount ?? 4,
    stampOuter: fx.stampOuter ?? '#f4a261',
    stampInner: fx.stampInner ?? '#e9c46a',
    vignetteColor: fx.vignetteColor ?? '#f4a261'
  };
}

/** Presentation-only chamber-clear timing (Day 226). */
export function clearHeartbeatTiming(cfg = {}) {
  const clear = cfg.clearHeartbeat ?? {};
  const shake = cfg.shake ?? {};
  return {
    duration: clear.duration ?? 0.28,
    pulseAlpha: clear.pulseAlpha ?? 0.38,
    particleCount: clear.particleCount ?? 10,
    particleLife: clear.particleLife ?? 0.26,
    shake: clear.shake ?? shake.clear ?? 2.6
  };
}

/** @param {object} cfg data/juice.json */
export function createJuice(cfg = {}) {
  const hitCfg = cfg.hitStop ?? {};
  const shakeCfg = cfg.shake ?? {};
  const spliceCfg = cfg.spliceFx ?? {};
  const opCfg = cfg.overpressure ?? {};

  return {
    hitStopT: 0,
    shakeX: 0,
    shakeY: 0,
    shakeMag: 0,
    shakeEnabled: shakeCfg.enabled !== false,
    clearT: 0,
    clearParticles: [],
    spliceFx: null,
    labCommitFx: null,
    attackFormBeatFx: null,
    volatileFuseBeatFx: null,
    abilityBBeatFx: null,
    synergyFindFx: null,
    patternAlmostFx: null,
    castFx: null,
    overpressurePhase: 0,
    overpressureActive: false,
    _shakePhase: 0,

    /** Brief render-side hit-stop (sim may skip ticks in game.js only). */
    requestHitStop(duration) {
      const cap = hitCfg.maxStack ?? 0.12;
      this.hitStopT = Math.min(cap, Math.max(this.hitStopT, duration));
    },

    onCombatHit({ heavy, kind, x, y }) {
      if (heavy) {
        const dur = kind === 'boss'
          ? (hitCfg.boss ?? 0.085)
          : kind === 'elite'
            ? (hitCfg.elite ?? 0.055)
            : (hitCfg.heavy ?? 0.04);
        this.requestHitStop(dur);
        const shake = kind === 'boss'
          ? (shakeCfg.bossHit ?? 6)
          : kind === 'elite'
            ? (shakeCfg.eliteHit ?? 3.5)
            : (shakeCfg.heavyHit ?? 2.5);
        this.addShake(shake);
      }
      if (Number.isFinite(x) && Number.isFinite(y) && heavy) {
        this.clearParticles.push({
          x, y, vx: 0, vy: 0, t: 0.18, kind: 'impact', size: 6
        });
      }
    },

    onChamberClear(arena) {
      const beat = clearHeartbeatTiming(cfg);
      this.clearT = beat.duration;
      this.addShake(beat.shake);
      const n = beat.particleCount;
      const life = beat.particleLife;
      const cx = arena.w / 2;
      const cy = arena.h / 2;
      this.clearParticles = [];
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2;
        const spd = 75 + (i % 3) * 28;
        this.clearParticles.push({
          x: cx, y: cy,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd - 32,
          t: life + (i % 3) * 0.03,
          kind: 'heart',
          size: 4 + (i % 3)
        });
      }
    },

    startSpliceFx(result, slot, arena) {
      const slotW = 92;
      const slotH = 58;
      const total = 4 * (slotW + 8) - 8;
      const x0 = (arena.w - total) / 2;
      const y0 = arena.h - slotH - 16;
      const tx = x0 + slot * (slotW + 8) + slotW / 2;
      const ty = y0 + slotH / 2;
      this.spliceFx = {
        t: spliceCfg.duration ?? 0.42,
        maxT: spliceCfg.duration ?? 0.42,
        result,
        slot,
        x: arena.w / 2,
        y: arena.h * 0.42,
        tx,
        ty
      };
    },

    /**
     * Day 083 / 230 — Lab take vs seat bursts (presentation only).
     * Skip path must never call this. kind: 'take' | 'seat' (legacy dna/ability/fuse → take).
     */
    onLabCommit({ x, y, kind = 'take' } = {}, arena = { w: 1280, h: 720 }) {
      const beat = labCommitTiming(cfg, kind);
      const cx = Number.isFinite(x) ? x : arena.w / 2;
      const cy = Number.isFinite(y) ? y : arena.h / 2;
      const dur = beat.duration;
      this.labCommitFx = {
        t: dur, maxT: dur, x: cx, y: cy,
        hook: beat.hook,
        stampOuter: beat.stampOuter,
        stampInner: beat.stampInner
      };
      this.addShake(beat.shake);
      const n = beat.particleCount;
      const particleKind = beat.hook === 'seat' ? 'commit-seat' : 'commit-take';
      const baseSpd = beat.hook === 'seat' ? 52 : 70;
      const life = beat.hook === 'seat' ? 0.24 : 0.32;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 + (beat.hook === 'seat' ? Math.PI / 6 : 0);
        const spd = baseSpd + (i % 3) * (beat.hook === 'seat' ? 18 : 28);
        this.clearParticles.push({
          x: cx, y: cy,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd - (beat.hook === 'seat' ? 18 : 30),
          t: life + (i % 3) * 0.04,
          kind: particleKind,
          size: beat.hook === 'seat' ? 2 + (i % 2) : 3 + (i % 3)
        });
      }
    },

    /**
     * Day 239 — Attack delivery form shift (bolt↔beam etc). Shot stamp, not pivot copy.
     * @param {object} opts
     * @param {string|null} [opts.form]
     * @param {string} [opts.label]
     * @param {number} [opts.x]
     * @param {number} [opts.y]
     */
    onAttackFormBeat({ form = null, label = 'BOLT', x, y, boxW, boxH } = {}, arena = { w: 1280, h: 720 }) {
      const beat = attackFormBeatTiming(cfg);
      const cx = Number.isFinite(x) ? x : arena.w / 2;
      const cy = Number.isFinite(y) ? y : arena.h * 0.35;
      const dur = beat.duration;
      this.attackFormBeatFx = {
        t: dur,
        maxT: dur,
        x: cx,
        y: cy,
        boxW: Number.isFinite(boxW) ? boxW : 72,
        boxH: Number.isFinite(boxH) ? boxH : 72,
        form: form ?? 'bolt',
        label: String(label ?? 'BOLT').slice(0, 12),
        stampOuter: beat.stampOuter,
        stampInner: beat.stampInner
      };
      this.addShake(beat.shake);
      const n = beat.particleCount;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 + Math.PI / 8;
        const spd = 62 + (i % 3) * 20;
        this.clearParticles.push({
          x: cx, y: cy,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd - 24,
          t: 0.26 + (i % 3) * 0.03,
          kind: 'form-beat',
          size: 2 + (i % 3)
        });
      }
    },

    /**
     * Day 246 — volatile mutation spike on fuse/craft. Jagged fracture stamp, not form / B / pivot.
     * @param {object} opts
     * @param {string} [opts.label]
     * @param {number} [opts.x]
     * @param {number} [opts.y]
     * @param {number} [opts.boxW]
     * @param {number} [opts.boxH]
     */
    onVolatileFuseBeat({ label = 'SPIKE', x, y, boxW, boxH } = {}, arena = { w: 1280, h: 720 }) {
      const beat = volatileFuseBeatTiming(cfg);
      const cx = Number.isFinite(x) ? x : arena.w / 2;
      const cy = Number.isFinite(y) ? y : arena.h * 0.35;
      const dur = beat.duration;
      this.volatileFuseBeatFx = {
        t: dur,
        maxT: dur,
        x: cx,
        y: cy,
        boxW: Number.isFinite(boxW) ? boxW : 72,
        boxH: Number.isFinite(boxH) ? boxH : 72,
        label: String(label ?? 'SPIKE').slice(0, 12),
        stampOuter: beat.stampOuter,
        stampInner: beat.stampInner
      };
      this.addShake(beat.shake);
      const n = beat.particleCount;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 + (i % 2 ? 0.18 : -0.12);
        const spd = 78 + (i % 4) * 24;
        this.clearParticles.push({
          x: cx, y: cy,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd - 28,
          t: 0.3 + (i % 3) * 0.04,
          kind: 'volatile-beat',
          size: 3 + (i % 3)
        });
      }
    },

    /**
     * Day 240 — Ability B equip/swap in Lab. Module stamp flash, not Attack form silhouette.
     * @param {object} opts
     * @param {string} [opts.moduleId]
     * @param {number} [opts.x]
     * @param {number} [opts.y]
     * @param {number} [opts.size]
     */
    onAbilityBBeat({ moduleId = 'shield', x, y, size } = {}, arena = { w: 1280, h: 720 }) {
      const beat = abilityBBeatTiming(cfg);
      const cx = Number.isFinite(x) ? x : 27;
      const cy = Number.isFinite(y) ? y : 82;
      const dur = beat.duration;
      const stampSize = Number.isFinite(size) ? size : 44;
      this.abilityBBeatFx = {
        t: dur,
        maxT: dur,
        x: cx,
        y: cy,
        size: stampSize,
        moduleId: String(moduleId ?? 'shield'),
        stampOuter: beat.stampOuter,
        stampInner: beat.stampInner
      };
      this.addShake(beat.shake);
      const n = beat.particleCount;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 + Math.PI / 4;
        const spd = 48 + (i % 3) * 16;
        this.clearParticles.push({
          x: cx, y: cy,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd - 18,
          t: 0.22 + (i % 3) * 0.03,
          kind: 'ability-beat',
          size: 2 + (i % 2)
        });
      }
    },

    /**
     * Day 235 — clever partial pattern find (presentation only).
     * Louder than mindless hive seat; secrets keep Day 231 soft pulse instead.
     */
    onSynergyFind({ x, y } = {}, arena = { w: 1280, h: 720 }) {
      const beat = synergyFindTiming(cfg);
      const cx = Number.isFinite(x) ? x : arena.w / 2;
      const cy = Number.isFinite(y) ? y : arena.h / 2;
      const dur = beat.duration;
      this.synergyFindFx = {
        t: dur, maxT: dur, x: cx, y: cy,
        stampOuter: beat.stampOuter,
        stampInner: beat.stampInner
      };
      this.addShake(beat.shake);
      const n = beat.particleCount;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 + Math.PI / 12;
        const spd = 85 + (i % 4) * 22;
        this.clearParticles.push({
          x: cx, y: cy,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd - 35,
          t: 0.34 + (i % 3) * 0.04,
          kind: 'synergy',
          size: 3 + (i % 4)
        });
      }
    },

    /**
     * Day 260 — pattern almost-there nudge (presentation only).
     * Softer than synergy find and secret pulse; no shake / no coach copy.
     */
    onPatternAlmost({ x, y } = {}, arena = { w: 1280, h: 720 }) {
      const beat = patternAlmostTiming(cfg);
      const cx = Number.isFinite(x) ? x : arena.w / 2;
      const cy = Number.isFinite(y) ? y : arena.h / 2;
      const dur = beat.duration;
      this.patternAlmostFx = {
        t: dur, maxT: dur, x: cx, y: cy,
        stampOuter: beat.stampOuter,
        stampInner: beat.stampInner
      };
      const n = beat.particleCount;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 + Math.PI / 6;
        const spd = 42 + (i % 2) * 12;
        this.clearParticles.push({
          x: cx, y: cy,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd - 16,
          t: 0.2 + (i % 2) * 0.03,
          kind: 'almost',
          size: 2 + (i % 2)
        });
      }
    },

    /** Day 128 — cast use pop (presentation only). */
    onCast({ x, y, moduleId } = {}, arena = { w: 1280, h: 720 }) {
      const castCfg = cfg.castFx ?? {};
      const cx = Number.isFinite(x) ? x : arena.w / 2;
      const cy = Number.isFinite(y) ? y : arena.h / 2;
      const dur = castCfg.duration ?? 0.22;
      this.castFx = { t: dur, maxT: dur, x: cx, y: cy, moduleId: moduleId ?? 'cast' };
      this.addShake(castCfg.shake ?? 1.6);
      const n = castCfg.particleCount ?? 6;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2;
        const spd = 50 + (i % 2) * 20;
        this.clearParticles.push({
          x: cx, y: cy,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd - 20,
          t: 0.2,
          kind: 'cast',
          size: 3
        });
      }
    },

    addShake(magnitude) {
      if (!this.shakeEnabled) return;
      const max = shakeCfg.maxOffset ?? 7;
      this.shakeMag = Math.min(max, this.shakeMag + magnitude);
    },

    setOverpressure(active) {
      this.overpressureActive = active;
      if (!active) this.overpressurePhase = 0;
    },

    tick(dt, overpressure) {
      if (this.hitStopT > 0) this.hitStopT = Math.max(0, this.hitStopT - dt);
      if (this.clearT > 0) this.clearT = Math.max(0, this.clearT - dt);
      if (this.castFx) {
        this.castFx.t -= dt;
        if (this.castFx.t <= 0) this.castFx = null;
      }

      const decay = shakeCfg.decay ?? 14;
      if (this.shakeMag > 0) {
        this.shakeMag = Math.max(0, this.shakeMag - decay * dt);
        const max = shakeCfg.maxOffset ?? 7;
        const mag = Math.min(max, this.shakeMag);
        // Day 137 — presentation-only deterministic shake (no Math.random)
        this._shakePhase = (this._shakePhase ?? 0) + dt * 37;
        this.shakeX = Math.sin(this._shakePhase * 2.1) * mag;
        this.shakeY = Math.cos(this._shakePhase * 1.7) * mag;
      } else {
        this.shakeX = 0;
        this.shakeY = 0;
      }

      for (const p of this.clearParticles) {
        p.t -= dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 120 * dt;
      }
      this.clearParticles = this.clearParticles.filter((p) => p.t > 0);

      if (this.spliceFx) {
        this.spliceFx.t -= dt;
        if (this.spliceFx.t <= 0) this.spliceFx = null;
      }
      if (this.labCommitFx) {
        this.labCommitFx.t -= dt;
        if (this.labCommitFx.t <= 0) this.labCommitFx = null;
      }
      if (this.attackFormBeatFx) {
        this.attackFormBeatFx.t -= dt;
        if (this.attackFormBeatFx.t <= 0) this.attackFormBeatFx = null;
      }
      if (this.volatileFuseBeatFx) {
        this.volatileFuseBeatFx.t -= dt;
        if (this.volatileFuseBeatFx.t <= 0) this.volatileFuseBeatFx = null;
      }
      if (this.abilityBBeatFx) {
        this.abilityBBeatFx.t -= dt;
        if (this.abilityBBeatFx.t <= 0) this.abilityBBeatFx = null;
      }
      if (this.synergyFindFx) {
        this.synergyFindFx.t -= dt;
        if (this.synergyFindFx.t <= 0) this.synergyFindFx = null;
      }
      if (this.patternAlmostFx) {
        this.patternAlmostFx.t -= dt;
        if (this.patternAlmostFx.t <= 0) this.patternAlmostFx = null;
      }

      const opOn = overpressure ?? this.overpressureActive;
      if (opOn) {
        this.overpressurePhase += dt;
      } else {
        this.overpressurePhase = 0;
      }
    },

    /** Clear transient FX so a new run never inherits hit-stop / overlays (Day 241). */
    resetRun() {
      this.hitStopT = 0;
      this.shakeX = 0;
      this.shakeY = 0;
      this.shakeMag = 0;
      this.clearT = 0;
      this.clearParticles = [];
      this.spliceFx = null;
      this.labCommitFx = null;
      this.attackFormBeatFx = null;
      this.volatileFuseBeatFx = null;
      this.abilityBBeatFx = null;
      this.synergyFindFx = null;
      this.patternAlmostFx = null;
      this.castFx = null;
      this.overpressureActive = false;
      this.overpressurePhase = 0;
    },

    /** True while renderer should skip sim ticks (hit-stop). */
    isSimFrozen() {
      return this.hitStopT > 0;
    },

    overpressureAlpha(threshold, pressure) {
      if (!this.overpressureActive && pressure <= threshold) return 0;
      const period = opCfg.pulsePeriod ?? 1.15;
      const maxA = opCfg.maxAlpha ?? 0.2;
      const wave = 0.5 + 0.5 * Math.sin((this.overpressurePhase / period) * Math.PI * 2);
      return maxA * wave;
    },

    barFlashAlpha() {
      if (!this.overpressureActive) return 0;
      const period = opCfg.pulsePeriod ?? 1.15;
      const maxA = opCfg.barFlashAlpha ?? 0.45;
      const wave = 0.5 + 0.5 * Math.sin((this.overpressurePhase / period) * Math.PI * 2);
      return maxA * wave;
    }
  };
}

/** Classify a combat hit for juice (presentation-only). */
export function classifyCombatHit(enemy, damage, juiceCfg = {}) {
  const threshold = juiceCfg.hitStop?.heavyDamageThreshold ?? 14;
  if (enemy.isBoss) return { heavy: true, kind: 'boss' };
  if (enemy.affixes?.length > 0) return { heavy: true, kind: 'elite' };
  if (damage >= threshold) return { heavy: true, kind: 'heavy' };
  return { heavy: false, kind: 'normal' };
}
