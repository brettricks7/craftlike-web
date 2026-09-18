/**
 * systems/audio.js — event → sound stub (Days 047–048).
 *
 * Procedural Web-Audio beeps when no asset files exist. Never throws if
 * AudioContext is unavailable (headless tests, autoplay policy).
 */

const STORAGE_KEY = 'craftlike_mute';

/** Default event → tone profile (freq Hz, duration s, type, gain). */
export const DEFAULT_SOUND_MAP = {
  shoot: { freq: 880, dur: 0.04, type: 'square', gain: 0.06 },
  hit: { freq: 220, dur: 0.05, type: 'triangle', gain: 0.08 },
  hit_heavy: { freq: 110, dur: 0.09, type: 'sawtooth', gain: 0.1 },
  dash: { freq: 660, dur: 0.07, type: 'sine', gain: 0.07, slide: -200 },
  clear: { freq: 92, dur: 0.055, type: 'sine', gain: 0.075, arpeggio: [92, 68] },
  splice: { freq: 440, dur: 0.22, type: 'triangle', gain: 0.1, arpeggio: [440, 554, 659] },
  lab_commit: { freq: 660, dur: 0.16, type: 'sine', gain: 0.09, arpeggio: [660, 880, 990] },
  lab_seat: { freq: 440, dur: 0.12, type: 'triangle', gain: 0.07, arpeggio: [440, 554] },
  secret_discover: { freq: 330, dur: 0.12, type: 'sine', gain: 0.055, arpeggio: [330, 415, 523] },
  synergy_find: { freq: 523, dur: 0.14, type: 'triangle', gain: 0.09, arpeggio: [523, 659, 784, 988] },
  pattern_almost: { freq: 392, dur: 0.09, type: 'sine', gain: 0.045, arpeggio: [392, 466] },
  attack_form: { freq: 740, dur: 0.11, type: 'sine', gain: 0.07, arpeggio: [740, 988, 1175] },
  volatile_fuse: { freq: 196, dur: 0.14, type: 'sawtooth', gain: 0.085, arpeggio: [392, 311, 247, 196] },
  ability_equip: { freq: 880, dur: 0.1, type: 'triangle', gain: 0.065, arpeggio: [880, 1047, 1319] },
  // Day 129 — distinct ability cast stubs
  cast_blink: { freq: 920, dur: 0.06, type: 'sine', gain: 0.07, slide: 180 },
  cast_shield: { freq: 280, dur: 0.14, type: 'triangle', gain: 0.08 },
  cast_pull: { freq: 160, dur: 0.12, type: 'sawtooth', gain: 0.07, slide: -120 },
  cast_nova: { freq: 520, dur: 0.18, type: 'square', gain: 0.08, arpeggio: [520, 660, 780] },
  overpressure: { freq: 180, dur: 0.12, type: 'sine', gain: 0.05 },
  pickup: { freq: 990, dur: 0.05, type: 'sine', gain: 0.05 }
};

export class AudioBus {
  /**
   * @param {object} [opts]
   * @param {Record<string, object>} [opts.map] event id → tone profile
   * @param {typeof localStorage|null} [opts.storage]
   */
  constructor(opts = {}) {
    this.map = { ...DEFAULT_SOUND_MAP, ...(opts.map ?? {}) };
    this._storage = opts.storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    this.muted = this._storage?.getItem(STORAGE_KEY) === '1';
    this._ctx = null;
    this._lastOverpressure = 0;
  }

  /** Lazy AudioContext — needs a user gesture in most browsers. */
  _ensureCtx() {
    if (this.muted) return null;
    if (this._ctx) return this._ctx;
    const Ctx = typeof AudioContext !== 'undefined'
      ? AudioContext
      : typeof webkitAudioContext !== 'undefined'
        ? webkitAudioContext
        : null;
    if (!Ctx) return null;
    try {
      this._ctx = new Ctx();
      return this._ctx;
    } catch {
      return null;
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this._storage) {
      if (this.muted) this._storage.setItem(STORAGE_KEY, '1');
      else this._storage.removeItem(STORAGE_KEY);
    }
    return this.muted;
  }

  setMuted(on) {
    this.muted = !!on;
    if (this._storage) {
      if (this.muted) this._storage.setItem(STORAGE_KEY, '1');
      else this._storage.removeItem(STORAGE_KEY);
    }
  }

  /** Play a mapped event id. Silent no-op when muted or unavailable. */
  play(eventId) {
    if (this.muted) return;
    const spec = this.map[eventId];
    if (!spec) return;
    const ctx = this._ensureCtx();
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') ctx.resume();
      if (spec.arpeggio) {
        spec.arpeggio.forEach((freq, i) => {
          this._beep(ctx, { ...spec, freq }, i * 0.07);
        });
      } else {
        this._beep(ctx, spec, 0);
      }
    } catch {
      /* swallow — missing files / autoplay must never crash */
    }
  }

  _beep(ctx, spec, delay) {
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = spec.type ?? 'sine';
    osc.frequency.setValueAtTime(spec.freq, t0);
    if (spec.slide) {
      osc.frequency.linearRampToValueAtTime(spec.freq + spec.slide, t0 + spec.dur);
    }
    const g = spec.gain ?? 0.08;
    gain.gain.setValueAtTime(g, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + spec.dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + spec.dur + 0.02);
  }

  /** Throttled overpressure warning — not spammy. */
  playOverpressureWarning(nowSec = 0) {
    if (nowSec - this._lastOverpressure < 1.1) return;
    this._lastOverpressure = nowSec;
    this.play('overpressure');
  }

  /** Wire world / UI events to sound ids. */
  bindWorld(world, uiHandlers = {}) {
    world.events.on('combat:hit', ({ heavy }) => {
      this.play(heavy ? 'hit_heavy' : 'hit');
    });
    world.events.on('chamber:cleared', () => this.play('clear'));
    world.events.on('crafted', ({ fromOffer }) => {
      if (fromOffer) this.play('splice');
    });
    world.events.on('lab:commit', ({ kind, secretPulse, synergyFind, patternAlmost }) => {
      if (secretPulse) return;
      if (synergyFind) {
        this.play('synergy_find');
        return;
      }
      if (patternAlmost) {
        this.play('pattern_almost');
        return;
      }
      if (kind === 'seat') return;
      this.play('lab_commit');
    });
    world.events.on('pattern:secret-discovered', () => this.play('secret_discover'));
    // Day 129 — ability cast identity
    world.events.on('ability:cast', ({ moduleId }) => {
      const id = moduleId === 'blink' ? 'cast_blink'
        : moduleId === 'shield' ? 'cast_shield'
          : moduleId === 'pull' ? 'cast_pull'
            : moduleId === 'nova' ? 'cast_nova'
              : 'dash';
      this.play(id);
    });
    // offer:skipped intentionally silent — greed discard, no fake reward (Day 083)
    world.events.on('enemy:killed', () => { /* omit — too noisy */ });
    if (uiHandlers.onDash) world.events.on('player:dash', () => this.play('dash'));
    if (uiHandlers.onShoot) world.events.on('player:shoot', () => this.play('shoot'));
  }
}
