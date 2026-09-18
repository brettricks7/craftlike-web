/**
 * game.js — renderer-process entry point: the THIN shell around the sim.
 *
 * Responsibility split (this is what keeps everything testable):
 *   src/world.js   ALL game logic. Headless, deterministic, action-driven.
 *                  Tested in plain Node (tests/world.test.js).
 *   this file      Presentation + intent only: translates InputManager state
 *                  into per-tick `actions`, owns the state machine and HUD,
 *                  and draws the world. Nothing here may affect sim outcomes
 *                  except through the actions object.
 *
 * Frame-rate / resolution independence:
 *   - The sim runs at a fixed hz (core/loop.js) — rendering interpolates.
 *   - The arena is a FIXED logical size from config.json (config.arena),
 *     letterboxed into whatever window/monitor the player has. Same seed =
 *     same run on a 4K ultrawide or a laptop. Mouse input is converted from
 *     screen pixels to world units before the sim ever sees it.
 *
 * Controls:
 *   WASD/arrows/left-stick  move          mouse/right-stick  aim
 *   click/space/A           Attack        Shift/B/E/LB       castA (Blink)
 *   R / RB                  castB         Esc/P/Start        pause
 *   Lab (after clear)       pedestals → demo pad → exit (rearrange owns DNA)
 *   C / Tab                 debug forge only when config.debugForge
 *   N (menu)                reroll seed
 *
 * Nano-Forge: debug-only mid-fight splicer (`debugForge`). Happy path uses Lab.
 */
import { GameLoop } from './core/loop.js';
import { StateMachine } from './core/state.js';
import { InputManager } from './input.js';
import { SteamManager } from './steam.js';
import { World } from './world.js';
import {
  preloadArt, drawFragmentIcon, drawAbilityIcon, propSprite, fxSprite, uiSprite,
  drawWorldSprite, abilitySprite, projectileArtId, projectileSprite
} from './art.js';
import { hexSlotLayout, resolveAdjacency, hexCorners, isHexSeatUnlocked, hiveConfig } from './systems/hex.js';
import {
  chamberIntensity,
  effectiveRoute,
  formatGreedCallout,
  formatGreedRewardLine,
  formatHealAttritionLine,
  needsRouteChoice
} from './systems/routes.js';
import {
  layoutGenomePanel, formatAttackDmgLine, formatBondLine,
  attackEngineFingerprint, attackFormChanged, describeAttackFormSilhouette,
  describeRunEngine, formatAttackPivotFlash,
  formatLabTakeToast
} from './systems/genome-ui.js';
import {
  loadProfile, unlockIntoProfile, resetProfile
} from './profile.js';
import { layoutVesselMinimap, MINIMAP_READABILITY, CORE_APPROACH } from './systems/vesselmap.js';
import {
  PRESSURE_DIAL,
  pressureBandSegments,
  pressureBarPct,
  pressureRiskTier,
  pressureThresholdPct,
  routePressurePick
} from './systems/pressure-hud.js';
import { previewPatient } from './systems/patients.js';
import { createJuice, classifyCombatHit, clearHeartbeatTiming, patternAlmostTiming, secretDiscoverTiming, synergyFindTiming } from './systems/juice.js';
import { isVolatileCraftResult, describeVolatileFuseStamp } from './systems/crafting.js';
import { abilityBEquipChanged } from './systems/abilities.js';
import { AudioBus } from './systems/audio.js';
import {
  offerCardAxes,
  offerFantasyLine,
  offerHealCallout,
  offerPierceCallout,
  offerChainCallout,
  offerKnockbackCallout,
  offerHonestNumbers
} from './systems/offers.js';
import { resolveMenuSeed, shareUrlForSeed } from './systems/seed-boot.js';
import { setFormMotionConfig } from './systems/form-motion.js';
import { setTagSecondaryConfig } from './systems/tag-secondary.js';
import { setComboFingerprintConfig } from './systems/combo-fingerprint.js';

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

// preload.cjs exposes config + all balance data here.
const bridge = window.bridge;
if (!bridge) {
  // Opened outside Electron (plain browser) — fail loudly but gracefully.
  ctx.fillStyle = '#fff';
  ctx.font = '16px monospace';
  ctx.fillText('No bridge found — run via Electron (python manage.py dev).', 20, 40);
  throw new Error('window.bridge missing: this game must run inside Electron.');
}

const config = bridge.config;
const data = bridge.data;
const juiceCfg = data.juice ?? {};
setFormMotionConfig(data.formMotion ?? null);
setTagSecondaryConfig(data.tagSecondary ?? null);
setComboFingerprintConfig(data.comboFingerprint ?? null);
const clearBeat = clearHeartbeatTiming(juiceCfg);
const discoverBeat = secretDiscoverTiming(juiceCfg);
const synergyBeat = synergyFindTiming(juiceCfg);
const almostBeat = patternAlmostTiming(juiceCfg);
const juice = createJuice(juiceCfg);
const audio = new AudioBus();
let presentationClock = 0;
if (bridge.env?.noShake === '1') juice.shakeEnabled = false;

// Fixed logical playfield — gameplay NEVER depends on window size.
const ARENA = { w: config.arena.width, h: config.arena.height };

/* ------------------------------------------------------------------ *
 * Viewport: letterbox the fixed arena into the window, crisp on any DPI
 * ------------------------------------------------------------------ */

const view = { scale: 1, ox: 0, oy: 0, dpr: 1 };

function resize() {
  // Render at native device resolution (retina-crisp), lay out in CSS px.
  view.dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * view.dpr);
  canvas.height = Math.round(window.innerHeight * view.dpr);

  // Fit the arena into the window, preserving aspect ratio (letterbox).
  view.scale = Math.min(window.innerWidth / ARENA.w, window.innerHeight / ARENA.h);
  view.ox = (window.innerWidth - ARENA.w * view.scale) / 2;
  view.oy = (window.innerHeight - ARENA.h * view.scale) / 2;
}
window.addEventListener('resize', resize);
resize();

/** Screen (CSS px) -> world (arena units). Used for mouse aim. */
function screenToWorld(sx, sy) {
  return { x: (sx - view.ox) / view.scale, y: (sy - view.oy) / view.scale };
}

const input = new InputManager(canvas);
const steam = new SteamManager(config);
steam.init();

const fsm = new StateMachine();

/**
 * Seed for the NEXT run. config.seed (when non-null) pins it for
 * reproducible testing; otherwise we roll a fresh one per session.
 * (Math.random is fine HERE — choosing a seed is the one moment allowed to
 * be non-deterministic. Everything after flows from the chosen seed.)
 */
function randomSeed() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
const bootSearch = typeof location !== 'undefined' ? location.search : '';
let menuSeed = resolveMenuSeed({
  configSeed: config.seed,
  search: bootSearch,
  roll: randomSeed
});

/** The active run's simulation. Null outside playing/paused/gameover. */
let world = null;

/** UI-only state: toasts and forge selection live OUTSIDE the sim. */
const ui = {
  toast: null,            // { text, t }
  forgeA: null,           // ingredient descriptors ({kind:'stock',id} / {kind:'slot',idx})
  forgeB: null,
  forgeCursor: 0,         // index into forgeEntries() (keyboard fallback)
  forgeReplaceSlot: 0,    // loadout slot a stock craft will replace
  forgeHitboxes: [],      // filled each forge render for click hit-testing
  forgeReturn: 'playing', // state to resume when the forge closes
  offerA: -1,             // indices into world.offer
  offerB: -1,
  offerHitboxes: [],      // filled each offer render for click hit-testing
  routeHitboxes: [],      // filled each route render for click hit-testing
  hexBagIdx: -1,         // Day 092 — selected bag chip for hex place
  hexHitboxes: [],        // Lab hex seats + bag row
  genomeOpen: false,       // Day 153 — Tab expands full hive
  attackDelta: null,       // { text, t } run-engine pivot flash (Day 234)
  prevAttackFp: null,
  prevAttackSnapshot: null,
  quip: '',               // game-over flavor line
  pulse: null,            // { t, kind: 'clear'|'splice' } presentation juice
  splicePending: false,   // true while splice FX plays before route
  craftedSlot: -1         // loadout slot for splice pop target
};

/** Live meta genome (persisted). */
let profile = loadProfile(data.elements);

function toast(text, seconds = 2.5) {
  ui.toast = { text, t: seconds };
}

/** Unlocked hive seats (scarce capacity). */
function hiveUnlockedSeats() {
  return world?.hexUnlockedSeats ?? hiveConfig(world?.dnaPatterns).startingSeats;
}

function noteAttackDelta(prevAtk = null) {
  const atk = world?.attack;
  const fp = attackEngineFingerprint(atk);
  if (ui.prevAttackFp != null && ui.prevAttackFp !== fp && atk) {
    const prior = prevAtk ?? (ui.prevAttackSnapshot ?? null);
    ui.attackDelta = {
      text: formatAttackPivotFlash(prior, atk),
      t: 2.4
    };
    triggerAttackFormBeat(prior);
  }
  ui.prevAttackFp = fp;
  ui.prevAttackSnapshot = atk ? { ...atk, stats: { ...atk.stats } } : null;
}

/** Day 239 — brief shot-form silhouette when delivery form shifts (not pivot toast / lab commit). */
function resolveAttackFormBeatAnchor() {
  if (ui.genomeOpen && world?.inLab) {
    const bag = world.dnaInventory ?? [];
    const unlockedSeats = hiveUnlockedSeats();
    const atk = world.attack;
    const active = (world.activePatterns ?? []).filter((p) => p && !p.secret);
    const layout = layoutGenomePanel({
      panelX: 200,
      panelY: 60,
      panelW: 880,
      panelH: 600,
      bagCount: bag.length,
      dmgLine: formatAttackDmgLine(atk?.stats?.damage, atk?.stats?.cooldown),
      bondLine: formatBondLine(atk?.hexBonds),
      kbLine: atk?.stats?.knockback ? `KB ${Math.round(atk.stats.knockback)}` : '',
      bonusCount: active.length,
      showBurn: bag.length > 0 && unlockedSeats < (world.hex?.slots?.length ?? 60)
    });
    return {
      x: layout.art.x + layout.art.w / 2,
      y: layout.art.y + layout.art.h / 2,
      w: layout.art.w,
      h: layout.art.h
    };
  }
  const pad = world?.labZones?.demoPad;
  if (pad) {
    const r = pad.r ?? 48;
    return { x: pad.x, y: pad.y, w: r * 1.5, h: r * 1.5 };
  }
  return { x: ARENA.w / 2, y: ARENA.h * 0.35, w: 72, h: 72 };
}

function triggerAttackFormBeat(prevAtk) {
  const atk = world?.attack;
  if (!atk || !attackFormChanged(prevAtk, atk)) return;
  const anchor = resolveAttackFormBeatAnchor();
  juice.onAttackFormBeat({
    form: atk.form ?? 'bolt',
    label: describeAttackFormSilhouette(atk),
    x: anchor.x,
    y: anchor.y,
    boxW: anchor.w,
    boxH: anchor.h
  }, ARENA);
  audio.play('attack_form');
}

/** Day 240 — Ability B module stamp on HUD slot (distinct from Attack form silhouette). */
function resolveAbilityBBeatAnchor() {
  return { x: 27, y: 82, size: 44 };
}

function triggerAbilityBBeat(moduleId) {
  if (!moduleId || !world?.inLab) return;
  const anchor = resolveAbilityBBeatAnchor();
  juice.onAbilityBBeat({
    moduleId,
    x: anchor.x,
    y: anchor.y,
    size: anchor.size
  }, ARENA);
  audio.play('ability_equip');
}

/** Day 246 — volatile mutation spike on fuse/craft (distinct from form / B / pivot toast). */
function triggerVolatileFuseBeat(result) {
  if (!isVolatileCraftResult(result)) return;
  const anchor = resolveAttackFormBeatAnchor();
  juice.onVolatileFuseBeat({
    label: describeVolatileFuseStamp(result),
    x: anchor.x,
    y: anchor.y,
    boxW: anchor.w,
    boxH: anchor.h
  }, ARENA);
  audio.play('volatile_fuse');
}

function drawHoneyCells(c, seats, {
  interactive = false,
  hitboxes = null,
  unlockedSeats = 99
} = {}) {
  const edges = resolveAdjacency(world.hex, (id) => world.crafting.get(id));
  const bySlot = new Map(seats.map((s) => [s.slot, s]));

  // Bond edges (geometry from adjacency; combat numbers live on attack.hexBonds)
  for (const e of edges) {
    const a = bySlot.get(e.a);
    const b = bySlot.get(e.b);
    if (!a || !b) continue;
    if (a.slot >= unlockedSeats || b.slot >= unlockedSeats) continue;
    const tag = e.tags?.[0];
    const tint = tag === 'heat' ? 'rgba(251,146,60,0.55)'
      : tag === 'cold' || tag === 'chill' ? 'rgba(125,211,252,0.55)'
      : tag === 'mass' ? 'rgba(196,163,90,0.5)'
      : tag === 'shock' ? 'rgba(250,204,21,0.5)'
      : 'rgba(148,163,184,0.4)';
    c.strokeStyle = tint;
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(a.x, a.y);
    c.lineTo(b.x, b.y);
    c.stroke();
  }

  for (const seat of seats) {
    const sealed = !isHexSeatUnlocked(seat.slot, unlockedSeats);
    const chipId = world.hex.slots[seat.slot];
    const corners = seat.corners ?? hexCorners(seat.x, seat.y, seat.size ?? 14);
    if (interactive && !sealed) {
      (hitboxes || ui.hexHitboxes).push({ role: 'seat', slot: seat.slot, x: seat.x, y: seat.y, r: seat.r });
    }
    c.beginPath();
    c.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < corners.length; i++) c.lineTo(corners[i].x, corners[i].y);
    c.closePath();
    if (sealed) {
      c.fillStyle = 'rgba(12,12,14,0.55)';
      c.strokeStyle = 'rgba(40,40,48,0.45)';
    } else if (chipId) {
      c.fillStyle = 'rgba(61,42,20,0.92)';
      c.strokeStyle = '#e8c56a';
    } else {
      c.fillStyle = 'rgba(26,20,14,0.85)';
      c.strokeStyle = '#6a5430';
    }
    c.fill();
    c.lineWidth = 1.25;
    c.stroke();
    if (chipId && !sealed) {
      drawFragmentIcon(c, world.crafting.get(chipId) ?? { id: chipId }, seat.x, seat.y, seat.r * 1.6);
    }
  }
}

function drawYouCell(c, cx, cy, size) {
  const youCorners = hexCorners(cx, cy, size);
  c.beginPath();
  c.moveTo(youCorners[0].x, youCorners[0].y);
  for (let i = 1; i < youCorners.length; i++) c.lineTo(youCorners[i].x, youCorners[i].y);
  c.closePath();
  c.fillStyle = 'rgba(12, 18, 28, 0.95)';
  c.fill();
  c.strokeStyle = '#5eead4';
  c.lineWidth = 2;
  c.stroke();
  c.fillStyle = '#eef';
  c.font = `bold ${Math.max(8, Math.floor(size * 0.55))}px monospace`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('YOU', cx, cy);
}

function renderHexLab(c) {
  if (!world?.inLab || !world.hex) return;
  ui.hexHitboxes = [];
  const unlockedSeats = hiveUnlockedSeats();
  const seated = world.hex.slots.filter(Boolean).length;
  const bag = world.dnaInventory;
  const atk = world.attack;

  // --- Mini hive (always on) ---
  const miniCx = 88;
  const miniCy = 600;
  const miniSize = 9;
  const miniSeats = hexSlotLayout(world.hex, miniCx, miniCy, { size: miniSize, seatR: miniSize * 0.7 });
  c.save();
  c.fillStyle = 'rgba(8,12,16,0.78)';
  c.strokeStyle = 'rgba(196,163,90,0.4)';
  c.lineWidth = 1;
  c.fillRect(12, 530, 152, 150);
  c.strokeRect(12.5, 530.5, 151, 149);
  c.fillStyle = '#c4a35a';
  c.font = 'bold 10px monospace';
  c.textAlign = 'left';
  c.textBaseline = 'top';
  c.fillText(`HIVE  ${seated}/${unlockedSeats}`, 20, 538);
  c.fillStyle = '#6f8682';
  c.font = '9px monospace';
  c.fillText('Tab expand', 20, 552);
  drawYouCell(c, miniCx, miniCy, miniSize);
  drawHoneyCells(c, miniSeats, { interactive: false, unlockedSeats });
  ui.hexHitboxes.push({ role: 'mini', x: 12 + 76, y: 530 + 75, r: 70 });
  c.restore();

  // Inventory strip when closed
  if (bag.length > 0 && !ui.genomeOpen) {
    const bagY = 500;
    c.fillStyle = '#ffd166';
    c.font = 'bold 10px monospace';
    c.textAlign = 'left';
    c.fillText(`Inventory ${bag.length} — Tab to place`, 180, bagY);
    const show = Math.min(bag.length, 8);
    for (let i = 0; i < show; i++) {
      const x = 180 + i * 28;
      const y = bagY + 22;
      ui.hexHitboxes.push({ role: 'bag', idx: i, x, y, r: 12 });
      c.beginPath();
      c.arc(x, y, 12, 0, Math.PI * 2);
      c.fillStyle = ui.hexBagIdx === i ? 'rgba(255,209,102,0.4)' : 'rgba(30,40,55,0.85)';
      c.fill();
      drawFragmentIcon(c, world.crafting.get(bag[i]), x, y, 18);
    }
  }

  if (!ui.genomeOpen) return;

  // --- Expanded genome modal ---
  c.save();
  c.fillStyle = 'rgba(0,0,0,0.5)';
  c.fillRect(0, 0, ARENA.w, ARENA.h);
  const panelX = 200, panelY = 60, panelW = 880, panelH = 600;
  c.fillStyle = '#0a0e12';
  c.strokeStyle = 'rgba(196,163,90,0.55)';
  c.lineWidth = 2;
  c.fillRect(panelX, panelY, panelW, panelH);
  c.strokeRect(panelX + 0.5, panelY + 0.5, panelW - 1, panelH - 1);
  c.fillStyle = '#e8f4ef';
  c.font = 'bold 16px monospace';
  c.textAlign = 'left';
  c.fillText('GENOME', panelX + 20, panelY + 28);
  c.fillStyle = '#6f8682';
  c.font = '11px monospace';
  c.fillText(`${seated}/${unlockedSeats} seats · Esc/Tab close`, panelX + 120, panelY + 28);

  const cx = panelX + 280;
  const cy = panelY + panelH * 0.52;
  const size = 16;
  const seats = hexSlotLayout(world.hex, cx, cy, { size, seatR: size * 0.72 });
  drawYouCell(c, cx, cy, size);
  drawHoneyCells(c, seats, { interactive: true, unlockedSeats });

  // --- Live Attack / Inventory columns (layoutGenomePanel owns coordinates) ---
  const active = (world.activePatterns ?? []).filter((p) => p && !p.secret);
  const dmg = atk?.stats?.damage;
  const cd = atk?.stats?.cooldown;
  const kbLine = atk?.stats?.knockback
    ? `KB ${Math.round(atk.stats.knockback)}`
    : '';
  const layout = layoutGenomePanel({
    panelX,
    panelY,
    panelW,
    panelH,
    bagCount: bag.length,
    dmgLine: formatAttackDmgLine(dmg, cd),
    bondLine: formatBondLine(atk?.hexBonds),
    kbLine,
    bonusCount: active.length,
    showBurn: bag.length > 0 && unlockedSeats < (world.hex?.slots?.length ?? 60)
  });
  const { shotX, shotY, art } = layout;

  c.fillStyle = '#9ab';
  c.font = 'bold 11px monospace';
  c.textAlign = 'left';
  c.fillText(
    atk?.form === 'beam' ? 'ATTACK SHOT · BEAM'
      : atk?.form === 'spray' ? 'ATTACK SHOT · SPRAY'
        : atk?.form === 'rocket' ? 'ATTACK SHOT · ROCKET'
          : 'ATTACK SHOT',
    shotX,
    shotY
  );
  const artId = projectileArtId(atk);
  const spr = projectileSprite(artId);
  c.fillStyle = 'rgba(20,28,36,0.9)';
  c.fillRect(art.x, art.y, art.w, art.h);
  c.strokeStyle = '#5eead4';
  c.strokeRect(art.x + 0.5, art.y + 0.5, art.w - 1, art.h - 1);
  if (spr) {
    c.imageSmoothingEnabled = false;
    c.drawImage(spr, art.x + 12, art.y + 12, 48, 48);
  } else {
    c.fillStyle = '#5eead4';
    c.beginPath();
    c.arc(art.x + art.w / 2, art.y + art.h / 2, 10, 0, Math.PI * 2);
    c.fill();
  }
  for (const line of layout.shotStats) {
    if (line.key === 'dmg') {
      c.fillStyle = '#e8f4ef';
      c.font = 'bold 13px monospace';
    } else if (line.key === 'bond') {
      c.fillStyle = '#c4a35a';
      c.font = '11px monospace';
    } else {
      c.fillStyle = '#889';
      c.font = '10px monospace';
    }
    c.fillText(line.text, line.x, line.y);
  }
  // LAB_PIVOT — run-engine chrome (teal label, gold arrow target; Bob silhouette hook)
  if (ui.attackDelta && ui.attackDelta.t > 0) {
    const pivotY = layout.bonuses.title.y - 14;
    c.globalAlpha = Math.min(1, ui.attackDelta.t * 2);
    const line = ui.attackDelta.text ?? '';
    const arrow = line.indexOf('→');
    if (arrow >= 0) {
      const head = line.slice(0, arrow + 2).trimEnd();
      const tail = line.slice(arrow + 2).trim();
      c.font = 'bold 11px monospace';
      c.fillStyle = '#5eead4';
      c.fillText(head, shotX, pivotY);
      c.fillStyle = '#fbbf24';
      c.font = 'bold 12px monospace';
      c.fillText(tail, shotX + c.measureText(head).width + 4, pivotY);
    } else {
      c.fillStyle = '#5eead4';
      c.font = 'bold 12px monospace';
      c.fillText(line, shotX, pivotY);
    }
    c.globalAlpha = 1;
  }

  // Active hive pattern bonuses — named so the player sees what they earned.
  c.fillStyle = '#9ab';
  c.font = 'bold 11px monospace';
  c.textAlign = 'left';
  c.fillText(layout.bonuses.title.text, layout.bonuses.title.x, layout.bonuses.title.y);
  if (active.length === 0) {
    c.fillStyle = '#556';
    c.font = '10px monospace';
    c.fillText('seat a symmetry / motif…', shotX, layout.bonuses.title.y + 18);
  } else {
    active.slice(0, 6).forEach((p, i) => {
      const row = layout.bonuses.rows[i];
      const y = row?.y ?? layout.bonuses.title.y + 18 + i * 28;
      c.fillStyle = '#e8f4ef';
      c.font = 'bold 12px monospace';
      c.fillText(p.name ?? p.id, shotX, y);
      c.fillStyle = '#5eead4';
      c.font = '10px monospace';
      c.fillText(p.bonusLabel || 'bonus', shotX, y + 14);
    });
  }

  // Inventory column (exclusive right strip — do not draw shot text into it)
  c.fillStyle = '#9ab';
  c.font = '11px monospace';
  c.textAlign = 'left';
  c.fillText('INVENTORY', layout.invLabel.x, layout.invLabel.y);
  c.fillStyle = '#556';
  c.font = '9px monospace';
  c.fillText('select · click seat', layout.invHint.x, layout.invHint.y);
  for (const chip of layout.bagChips) {
    ui.hexHitboxes.push({ role: 'bag', idx: chip.idx, x: chip.x, y: chip.y, r: chip.r });
    c.beginPath();
    c.arc(chip.x, chip.y, chip.r, 0, Math.PI * 2);
    c.fillStyle = ui.hexBagIdx === chip.idx ? 'rgba(255,209,102,0.4)' : 'rgba(30,40,55,0.85)';
    c.fill();
    c.strokeStyle = ui.hexBagIdx === chip.idx ? '#ffd166' : '#667';
    c.stroke();
    drawFragmentIcon(c, world.crafting.get(bag[chip.idx]), chip.x, chip.y, 22);
  }
  if (bag.length === 0) {
    c.fillStyle = '#556';
    c.font = '11px monospace';
    c.fillText('— empty —', layout.invLabel.x + 10, panelY + 100);
  }

  if (layout.burn) {
    const { x: bx, y: by, r } = layout.burn;
    ui.hexHitboxes.push({ role: 'burn', x: bx, y: by, r });
    c.fillStyle = ui.hexBagIdx >= 0 ? 'rgba(180,60,40,0.85)' : 'rgba(60,40,40,0.7)';
    c.beginPath();
    c.arc(bx, by, 26, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = '#f87171';
    c.stroke();
    c.fillStyle = '#fecaca';
    c.font = 'bold 9px monospace';
    c.textAlign = 'center';
    c.fillText('BURN', bx, by - 4);
    c.fillText('+1 seat', bx, by + 8);
  }

  ui.hexHitboxes.push({
    role: 'close',
    x: layout.close.x,
    y: layout.close.y,
    r: layout.close.r
  });
  c.fillStyle = '#c4a35a';
  c.font = 'bold 18px monospace';
  c.textAlign = 'center';
  c.fillText('×', layout.close.x, panelY + 28);
  c.restore();
}

/** Day 152 — EXIT must be the loudest Lab landmark. */
function renderLabExit(c) {
  const z = world?.labZones?.exit;
  if (!z || !world?.inLab) return;
  const t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  const pulse = 0.55 + 0.45 * Math.sin(t * 3.2);
  const r = (z.r ?? 56) + 10;

  c.save();
  c.fillStyle = `rgba(255,209,102,${0.10 + 0.08 * pulse})`;
  c.beginPath();
  c.arc(z.x, z.y, r + 18, 0, Math.PI * 2);
  c.fill();

  c.strokeStyle = `rgba(255,209,102,${0.55 + 0.4 * pulse})`;
  c.lineWidth = 4;
  c.beginPath();
  c.arc(z.x, z.y, r, 0, Math.PI * 2);
  c.stroke();
  c.strokeStyle = 'rgba(128,255,219,0.55)';
  c.lineWidth = 2;
  c.beginPath();
  c.arc(z.x, z.y, r - 10, 0, Math.PI * 2);
  c.stroke();

  c.fillStyle = `rgba(255,209,102,${0.7 + 0.3 * pulse})`;
  c.font = 'bold 28px sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('❯❯', z.x - 4, z.y);

  c.fillStyle = '#ffd166';
  c.font = 'bold 22px monospace';
  c.fillText('EXIT', z.x, z.y - r - 22);
  c.fillStyle = '#cde';
  c.font = '12px monospace';
  c.fillText('walk here  ·  F', z.x, z.y + r + 18);
  c.restore();
}

/** Click Lab hex bag or seat. Returns true if handled. */
function hexClick(wx, wy) {
  if (!world?.inLab) return false;
  for (const h of ui.hexHitboxes) {
    if (Math.hypot(wx - h.x, wy - h.y) > h.r) continue;
    if (h.role === 'mini') {
      ui.genomeOpen = true;
      return true;
    }
    if (h.role === 'close') {
      ui.genomeOpen = false;
      ui.hexBagIdx = -1;
      return true;
    }
    if (h.role === 'bag') {
      ui.hexBagIdx = ui.hexBagIdx === h.idx ? -1 : h.idx;
      if (!ui.genomeOpen && world.dnaInventory.length) ui.genomeOpen = true;
      return true;
    }
    if (h.role === 'burn') {
      const idx = ui.hexBagIdx >= 0 ? ui.hexBagIdx : 0;
      if (world.burnDnaForSeat(idx)) {
        toast('seat unlocked', 1.6);
        ui.hexBagIdx = -1;
        noteAttackDelta();
      } else {
        toast('select inventory protein to burn', 1.4);
      }
      return true;
    }
    if (h.role === 'seat') {
      if (!ui.genomeOpen) continue;
      if (!isHexSeatUnlocked(h.slot, hiveUnlockedSeats())) {
        toast('seat sealed — burn DNA to open', 1.4);
        return true;
      }
      if (world.hex.slots[h.slot]) {
        if (ui.hexBagIdx >= 0) {
          world.clearHexSlot(h.slot);
          if (world.placeHexChip(ui.hexBagIdx, h.slot)) {
            toast('reseated', 1.0);
            ui.hexBagIdx = -1;
            noteAttackDelta();
          }
          return true;
        }
        world.clearHexSlot(h.slot);
        toast('returned to inventory', 1.2);
        noteAttackDelta();
        return true;
      }
      if (ui.hexBagIdx >= 0) {
        if (world.placeHexChip(ui.hexBagIdx, h.slot)) {
          toast('seated on hive', 1.0);
          ui.hexBagIdx = -1;
          noteAttackDelta();
        }
        return true;
      }
      if (world.dnaInventory.length > 0) {
        if (world.placeHexChip(0, h.slot)) {
          toast('seated on hive', 1.0);
          ui.hexBagIdx = -1;
          noteAttackDelta();
        }
        return true;
      }
      toast('take a pedestal chip first', 1.4);
      return true;
    }
  }
  // Click scrim (outside panel) closes expand
  if (ui.genomeOpen) {
    ui.genomeOpen = false;
    ui.hexBagIdx = -1;
    return true;
  }
  return false;
}

/** Day 230 — anchor Lab commit FX at pedestal or hive seat (presentation only). */
function resolveLabCommitAnchor(payload) {
  if (Number.isFinite(payload.x) && Number.isFinite(payload.y)
    && payload.kind !== 'seat') {
    return { x: payload.x, y: payload.y };
  }
  if (payload.kind === 'seat' && Number.isInteger(payload.slotIdx) && world?.hex) {
    const panelX = 200;
    const panelY = 60;
    const panelH = 600;
    const cx = panelX + 280;
    const cy = panelY + panelH * 0.52;
    const size = 16;
    const seats = hexSlotLayout(world.hex, cx, cy, { size, seatR: size * 0.72 });
    const seat = seats.find((s) => s.slot === payload.slotIdx);
    if (seat) return { x: seat.x, y: seat.y };
  }
  if (Number.isFinite(payload.x) && Number.isFinite(payload.y)) {
    return { x: payload.x, y: payload.y };
  }
  return { x: ARENA.w / 2, y: ARENA.h / 2 };
}

/* ------------------------------------------------------------------ *
 * Run lifecycle
 * ------------------------------------------------------------------ */

function wireWorldPresentation(w) {
  w.events.on('combat:hit', (payload) => {
    const { heavy, kind } = classifyCombatHit(payload.enemy, payload.damage, juiceCfg);
    juice.onCombatHit({ heavy, kind, x: payload.x, y: payload.y });
  });
  w.events.on('chamber:cleared', () => {
    juice.onChamberClear(ARENA);
  });
  w.events.on('crafted', ({ result, fromOffer, slot }) => {
    if (fromOffer && Number.isInteger(slot)) {
      juice.startSpliceFx(result, slot, ARENA);
      ui.craftedSlot = slot;
    }
  });
  w.events.on('lab:entered', () => {
    toast('Take chips · Tab hive · EXIT → (or F)', 3.2);
  });
  w.events.on('hex:seat-unlock', ({ seats }) => {
    toast(`Hive seat ${seats} unlocked`, 2.2);
  });
  w.events.on('lab:commit', (payload) => {
    // Secret activation owns the beat — skip generic seat chrome (Day 231 Gaben bar)
    if (payload.secretPulse) return;
    // Clever partial pattern find — louder synergy beat (Day 235)
    if (payload.synergyFind) {
      const anchor = resolveLabCommitAnchor(payload);
      juice.onSynergyFind({ ...payload, x: anchor.x, y: anchor.y }, ARENA);
      ui.pulse = { t: synergyBeat.duration, kind: 'synergy' };
      return;
    }
    // Pattern almost-there nudge — soft amber whisper (Day 260)
    if (payload.patternAlmost) {
      const anchor = resolveLabCommitAnchor(payload);
      juice.onPatternAlmost({ ...payload, x: anchor.x, y: anchor.y }, ARENA);
      ui.pulse = { t: almostBeat.duration, kind: 'almost' };
      return;
    }
    // Mindless hive seat — quiet vs clever/secret find (Day 235)
    if (payload.kind === 'seat') return;
    const anchor = resolveLabCommitAnchor(payload);
    juice.onLabCommit({ ...payload, x: anchor.x, y: anchor.y }, ARENA);
    const hook = payload.kind === 'seat' ? 'seat' : 'take';
    ui.pulse = { t: hook === 'seat' ? 0.24 : 0.32, kind: hook === 'seat' ? 'seat' : 'commit' };
    // Day 234 — take pivot copy (fuse Attack beat handled via crafted + noteAttackDelta)
    if (payload.kind === 'take' && payload.id && !String(payload.id).includes('+')) {
      const mod = (data.abilityModules?.modules ?? []).find((m) => m.id === payload.id);
      if (mod) {
        toast(formatLabTakeToast('ability', { abilityName: mod.name ?? payload.id }), 2.4);
      } else {
        const chip = w.crafting.get(payload.id);
        toast(formatLabTakeToast('dna', { chipName: chip?.name ?? payload.id }), 2.4);
      }
    }
  });
  // Day 231 — real secret: true match activates: soft pulse only (no toast / no coach text)
  w.events.on('pattern:secret-discovered', () => {
    ui.pulse = { t: discoverBeat.duration, kind: 'discover' };
  });
  // Day 128 — cast commit juice (respects CRAFTLIKE_NO_SHAKE via juice.shakeEnabled)
  w.events.on('ability:cast', (payload) => {
    const p = w.player;
    juice.onCast({ x: p?.x, y: p?.y, moduleId: payload.moduleId }, ARENA);
  });
  // Day 240 — Ability B equip/swap identity beat (Lab only; no-change stays quiet)
  w.events.on('ability:equip', (payload) => {
    if (payload.slot !== 1 || !w.inLab) return;
    if (!abilityBEquipChanged(payload.prevModuleId, payload.moduleId)) return;
    triggerAbilityBBeat(payload.moduleId);
  });
  // Day 246 — hive/bag fuse volatile spike (crafted event covers Lab fuse take)
  w.events.on('hex:fuse', ({ resultId }) => {
    const el = w.crafting.get(resultId);
    if (isVolatileCraftResult(el)) triggerVolatileFuseBeat(el);
  });
  w.events.on('dna:fuse', ({ resultId }) => {
    const el = w.crafting.get(resultId);
    if (isVolatileCraftResult(el)) triggerVolatileFuseBeat(el);
  });
  // offer:skipped — no juice (Day 083 Done-when: skip feels empty)
  audio.bindWorld(w, { onDash: true, onShoot: true });
}

/** Drop transient presentation state so restart/abandon never inherits hit-stop. */
function resetRunPresentation() {
  juice.resetRun();
  ui.toast = null;
  ui.pulse = null;
  ui.attackDelta = null;
  ui.quip = null;
}

/** Leave the current run for menu; preserve seed for the next Enter. */
function abandonToMenu() {
  if (world) menuSeed = world.seed;
  world = null;
  resetRunPresentation();
  fsm.change('menu');
}

/** Instant retry — same seed, no menu detour (Day 241). */
function restartRun(seed) {
  menuSeed = String(seed);
  resetRunPresentation();
  startRun(menuSeed);
  fsm.change('playing');
}

function startRun(seed) {
  profile = loadProfile(data.elements);
  world = new World(data, seed, ARENA, { unlockedIds: profile.unlockedIds });
  ui.toast = null;
  ui.pulse = null;
  ui.splicePending = false;
  ui.craftedSlot = -1;
  ui.forgeA = null;
  ui.forgeB = null;
  ui.forgeCursor = 0;
  ui.forgeReplaceSlot = defaultReplaceSlot();
  ui.forgeHitboxes = [];
  ui.offerA = -1;
  ui.offerB = -1;
  ui.hexBagIdx = -1;
  ui.hexHitboxes = [];
  ui.genomeOpen = false;
  ui.prevAttackFp = attackEngineFingerprint(world.attack);
  ui.prevAttackSnapshot = world.attack
    ? { ...world.attack, stats: { ...world.attack.stats } }
    : null;
  ui.attackDelta = null;

  // The world reports what happened; the shell decides how to present it.
  world.events.on('element:gained', ({ element, asScore, asDna }) => {
    if (!element) return;
    if (asDna) toast(`+protein ${element.icon} ${element.name}`, 1.6);
    else if (asScore) toast(`+score from ${element.icon} ${element.name}`, 1.4);
    else toast(`Protein: ${element.icon} ${element.name}`, 1.8);
  });
  world.events.on('crafted', ({ result, isNew, fromOffer }) => {
    ui.pulse = { t: 0.28, kind: 'splice' };
    if (isVolatileCraftResult(result)) triggerVolatileFuseBeat(result);
    if (fromOffer && world.inLab) {
      // Day 234 — fuse rewrites this run's engine, not a wiki splice line
      noteAttackDelta();
      toast(`RUN ENGINE → ${describeRunEngine(world.attack)}`, 2.8);
    } else {
      toast(fromOffer
        ? (isNew ? `Spliced: ${result.icon} ${result.name}!` : `Known splice: ${result.icon} ${result.name}`)
        : (isNew ? `Forged: ${result.icon} ${result.name}!` : `Known: ${result.icon} ${result.name}`));
    }
    if (isNew && world.crafting.discoveries === 1) {
      steam.unlockAchievement('FIRST_CRAFT');
    }
  });
  world.events.on('chamber:cleared', () => {
    ui.pulse = { t: clearBeat.duration, kind: 'clear' };
    toast('♥ Chamber clear', 1.2);
  });
  world.events.on('genome:depth-toy', ({ added, depth }) => {
    if (added?.length) {
      unlockIntoProfile(profile, added, data.elements);
      toast(`Depth toy D${depth + 1}: ${added.join(', ')}`, 3);
    }
  });
  world.events.on('run:won', ({ unlocked }) => {
    if (unlocked?.length) {
      unlockIntoProfile(profile, unlocked, data.elements);
      const names = unlocked.map((id) => world.crafting.get(id)?.name ?? id).join(', ');
      toast(`Genome +${unlocked.length}: ${names}`, 4);
    } else {
      toast('Patient stabilized', 3);
    }
  });
  world.events.on('node:entered', ({ node, routeType, heal, leadsToCore }) => {
    const route = data.map.routes[routeType];
    if (node.isEnd || leadsToCore) {
      const healBit = heal > 0 ? ` (+${heal} HP)` : '';
      toast(`${route.label} → INFECTION CORE${healBit}`, 3.5);
    } else {
      toast(`${route.label} → Chamber ${node.depth + 1}/${world.map.depth}`, 3);
    }
  });
  world.events.on('core:phase', ({ phase, telegraphSec }) => {
    const wait = telegraphSec ?? 0.75;
    toast(`Infection Core — phase ${phase} reinforcements incoming`, wait + 0.4);
  });
  wireWorldPresentation(world);
}

/* ------------------------------------------------------------------ *
 * Input -> actions (the only door into the simulation)
 * ------------------------------------------------------------------ */

/** Open the Nano-Forge, remembering which state to resume afterwards. */
function openForge(returnTo) {
  // Day 078: mid-fight / route forge is debug-only — Lab owns rearrange.
  if (!config.debugForge) {
    toast('Rearrange in the Lab — forge is debug-only', 2.0);
    return;
  }
  ui.forgeA = null;
  ui.forgeB = null;
  ui.forgeCursor = 0;
  ui.forgeReplaceSlot = defaultReplaceSlot();
  ui.forgeHitboxes = [];
  ui.forgeReturn = returnTo;
  fsm.change('forge');
}

/* ------------------------------------------------------------------ *
 * Forge helpers (pure UI — the sim only sees world.craft/canCraft)
 * ------------------------------------------------------------------ */

/** Rough power for "which slot should a new craft replace?" */
function forgePower(el) {
  if (!el) return 0;
  return el.stats.damage / el.stats.cooldown;
}

/** Default replace target: empty, else weakest starter, else weakest crafted. */
function defaultReplaceSlot() {
  if (!world) return 0;
  let best = world.activeIdx;
  let bestP = Infinity;
  world.inventory.forEach((el, i) => {
    let p;
    if (!el) p = -1;
    else if (!el.crafted) p = forgePower(el);
    else p = 1000 + forgePower(el);
    if (p < bestP) { bestP = p; best = i; }
  });
  return best;
}

/** Everything in the forge grid: 4 loadout slots, then stock types. */
function forgeEntries() {
  const entries = [];
  for (let i = 0; i < world.inventory.length; i++) {
    entries.push({ kind: 'slot', idx: i });
  }
  for (const id of Object.keys(world.stock)) {
    entries.push({ kind: 'stock', id });
  }
  return entries;
}

/** Resolve a forge descriptor to its element (or null for empty slots). */
function forgeElement(d) {
  if (!d) return null;
  return d.kind === 'slot' ? world.inventory[d.idx] : world.crafting.get(d.id);
}

function sameEntry(a, b) {
  return !!a && !!b && a.kind === b.kind &&
    (a.kind === 'slot' ? a.idx === b.idx : a.id === b.id);
}

/**
 * Craftable ingredient? Stock with count, or a crafted ability in a slot.
 * Base starters are weapons only — click them to set the replace target.
 */
function forgeIsIngredient(d) {
  if (!d) return false;
  if (d.kind === 'stock') return (world.stock[d.id] ?? 0) > 0;
  const el = world.inventory[d.idx];
  return !!(el && el.crafted);
}

function forgeIsStarterSlot(d) {
  if (!d || d.kind !== 'slot') return false;
  const el = world.inventory[d.idx];
  return !!(el && !el.crafted);
}

/** Tier of an entry for the equal-tier visual filter (null if empty). */
function forgeEntryTier(d) {
  const el = forgeElement(d);
  return el ? el.tier : null;
}

/** Dim when A is selected and this entry's tier cannot pair with it. */
function forgeTierMismatch(d) {
  if (!ui.forgeA || !forgeIsIngredient(d)) return false;
  const tA = forgeEntryTier(ui.forgeA);
  const t = forgeEntryTier(d);
  return tA != null && t != null && t !== tA;
}

/** Interact with a grid entry: ingredient select, or set replace slot. */
function forgeActivate(d) {
  if (!d) return;
  if (forgeIsStarterSlot(d) || (d.kind === 'slot' && !world.inventory[d.idx])) {
    ui.forgeReplaceSlot = d.idx;
    return;
  }
  if (!forgeIsIngredient(d)) return;
  forgeSelect(d);
}

/** Toggle-select an ingredient into A/B. */
function forgeSelect(d) {
  if (sameEntry(ui.forgeA, d)) {
    ui.forgeA = ui.forgeB;
    ui.forgeB = null;
    return;
  }
  if (sameEntry(ui.forgeB, d)) {
    ui.forgeB = null;
    return;
  }
  if (!forgeIsIngredient(d)) return;
  if (!ui.forgeA) ui.forgeA = d;
  else if (!ui.forgeB) ui.forgeB = d;
  else ui.forgeB = d;
}

/** Commit A+B immediately (passes replace slot when the loadout is full). */
function forgeCommit() {
  const check = world.canCraft(ui.forgeA, ui.forgeB);
  if (!check.ok) return false;
  const slot = check.needsSlot ? ui.forgeReplaceSlot : null;
  if (world.craft(ui.forgeA, ui.forgeB, slot)) {
    ui.forgeA = null;
    ui.forgeB = null;
    ui.forgeReplaceSlot = defaultReplaceSlot();
    return true;
  }
  return false;
}

function forgeHitbox(role, x, y, w, h, extra = {}) {
  ui.forgeHitboxes.push({ role, x, y, w, h, ...extra });
}

function forgeHitAt(wx, wy) {
  // Topmost last-drawn wins (Combine is registered after cards).
  for (let i = ui.forgeHitboxes.length - 1; i >= 0; i--) {
    const h = ui.forgeHitboxes[i];
    if (wx >= h.x && wx <= h.x + h.w && wy >= h.y && wy <= h.y + h.h) return h;
  }
  return null;
}

/** Handle a forge click at world coords. */
function forgeClick(wx, wy) {
  const hit = forgeHitAt(wx, wy);
  if (!hit) return;
  if (hit.role === 'combine') {
    forgeCommit();
    return;
  }
  if (hit.role === 'tray') {
    if (hit.side === 'A') {
      ui.forgeA = ui.forgeB;
      ui.forgeB = null;
    } else if (hit.side === 'B') {
      ui.forgeB = null;
    }
    return;
  }
  if (hit.role === 'card' && hit.entry) {
    forgeActivate(hit.entry);
    const entries = forgeEntries();
    const idx = entries.findIndex((e) => sameEntry(e, hit.entry));
    if (idx >= 0) ui.forgeCursor = idx;
  }
}

/* ------------------------------------------------------------------ *
 * Offer helpers (chamber reward: pick 2, splice, discard rest)
 * ------------------------------------------------------------------ */

function leaveOffer() {
  ui.offerA = -1;
  ui.offerB = -1;
  if (!needsRouteChoice(world.node, world._nodeById)) {
    world.advance(0);
    fsm.change('playing');
  } else {
    fsm.change('route');
  }
}

function offerSelect(idx) {
  if (!world.offer || idx < 0 || idx >= world.offer.length) return;
  if (ui.offerA === idx) { ui.offerA = ui.offerB; ui.offerB = -1; return; }
  if (ui.offerB === idx) { ui.offerB = -1; return; }
  if (ui.offerA < 0) ui.offerA = idx;
  else if (ui.offerB < 0) ui.offerB = idx;
  else ui.offerB = idx;
}

function commitOffer() {
  if (ui.offerA < 0 || ui.offerB < 0) return false;
  if (!world.acceptOffer(ui.offerA, ui.offerB)) return false;
  ui.splicePending = true;
  ui.offerA = -1;
  ui.offerB = -1;
  return true;
}

function offerClick(wx, wy) {
  for (let i = (ui.offerHitboxes?.length ?? 0) - 1; i >= 0; i--) {
    const h = ui.offerHitboxes[i];
    if (wx >= h.x && wx <= h.x + h.w && wy >= h.y && wy <= h.y + h.h) {
      if (h.role === 'combine') commitOffer();
      else if (h.role === 'skip') {
        world.skipOffer();
        leaveOffer();
      } else if (h.role === 'card') offerSelect(h.idx);
      return;
    }
  }
}

function renderOffer(c) {
  ui.offerHitboxes = [];
  c.fillStyle = 'rgba(6, 8, 14, 0.94)';
  c.fillRect(0, 0, ARENA.w, ARENA.h);

  // Title block — Offer is the star (Day 015).
  c.textAlign = 'center';
  c.fillStyle = '#80ffdb';
  c.font = 'bold 36px sans-serif';
  c.fillText('GENE OFFER', ARENA.w / 2, 56);
  c.fillStyle = '#9ab';
  c.font = '15px sans-serif';
  c.fillText('Click two proteins → Splice. Unused proteins are discarded forever.', ARENA.w / 2, 86);

  // Step rail
  const step = ui.offerA < 0 ? 1 : ui.offerB < 0 ? 2 : 3;
  const steps = ['1 · Pick', '2 · Pick', '3 · Splice'];
  steps.forEach((label, i) => {
    const sx = ARENA.w / 2 - 160 + i * 160;
    c.fillStyle = i + 1 === step ? '#ffd166' : i + 1 < step ? '#52b788' : '#445';
    c.font = i + 1 === step ? 'bold 14px monospace' : '13px monospace';
    c.fillText(label, sx, 118);
  });

  const ids = world.offer || [];
  const cardW = 200, cardH = 220, gap = 28;
  const total = ids.length * (cardW + gap) - gap;
  const x0 = (ARENA.w - total) / 2;
  const y0 = 140;

  ids.forEach((card, i) => {
    const kind = typeof card === 'string' ? 'dna' : (card?.kind ?? 'dna');
    const id = typeof card === 'string' ? card : (card?.id ?? `${card?.idA}+${card?.idB}`);
    const el = kind === 'dna' ? world.crafting.get(id) : null;
    const x = x0 + i * (cardW + gap);
    const selected = i === ui.offerA || i === ui.offerB;
    ui.offerHitboxes.push({ role: 'card', idx: i, x, y: y0, w: cardW, h: cardH });

    // Pixel-lean card chrome
    c.fillStyle = selected ? 'rgba(128,255,219,0.16)' : 'rgba(18,24,36,0.95)';
    c.fillRect(x, y0, cardW, cardH);
    c.strokeStyle = i === ui.offerA ? '#ffd166' : i === ui.offerB ? '#4cc9f0' : '#3d5a80';
    c.lineWidth = selected ? 3 : 2;
    c.strokeRect(x + 1, y0 + 1, cardW - 2, cardH - 2);
    c.strokeStyle = selected ? 'rgba(128,255,219,0.35)' : 'rgba(76,201,240,0.15)';
    c.lineWidth = 1;
    c.strokeRect(x + 5, y0 + 5, cardW - 10, cardH - 10);

    c.textAlign = 'left';
    c.font = 'bold 13px monospace';
    c.fillStyle = '#80ffdb';
    c.fillText(`[${i + 1}] ${kind.toUpperCase()}`, x + 12, y0 + 24);
    if (selected) {
      c.textAlign = 'right';
      c.fillStyle = i === ui.offerA ? '#ffd166' : '#4cc9f0';
      c.font = 'bold 16px monospace';
      c.fillText(i === ui.offerA ? 'A' : 'B', x + cardW - 12, y0 + 24);
    }

    c.textAlign = 'center';
    drawFragmentIcon(c, el ?? { id, icon: '?' }, x + cardW / 2, y0 + 78, 64);
    c.font = 'bold 17px sans-serif';
    c.fillStyle = '#eef';
    c.fillText(el?.name ?? id, x + cardW / 2, y0 + 128);
    // Day 109 — fantasy leads; honest numbers stay visible (no wiki-bait fog)
    c.font = 'italic 11px sans-serif';
    c.fillStyle = '#a8c4b8';
    const fantasy = offerFantasyLine(card, world);
    c.fillText(fantasy.slice(0, 28), x + cardW / 2, y0 + 148);
    c.font = '12px monospace';
    c.fillStyle = '#8899aa';
    const axes = offerCardAxes(card, world, { max: 3 });
    const axisLine = axes.map((a) => (a.value ? `${a.label} ${a.value}` : a.label)).join(' · ');
    c.fillText(axisLine || '—', x + cardW / 2, y0 + 168);
    c.fillStyle = '#667788';
    const nums = offerHonestNumbers(card, world);
    if (nums) c.fillText(nums, x + cardW / 2, y0 + 188);
    else if (el?.stats?.damage != null) c.fillText(`dmg ${el.stats.damage}`, x + cardW / 2, y0 + 188);
  });

  const can = ui.offerA >= 0 && ui.offerB >= 0;
  let preview = null;
  const offerId = (c) => (typeof c === 'string' ? c : c?.id);
  if (can) {
    const a = offerId(ids[ui.offerA]);
    const b = offerId(ids[ui.offerB]);
    if (a && b) preview = world.crafting.preview(a, b);
  }

  const py = 400;
  if (preview) {
    const r = preview.result;
    const a = offerId(ids[ui.offerA]);
    const b = offerId(ids[ui.offerB]);
    c.fillStyle = '#cde';
    c.font = '16px sans-serif';
    c.fillText(
      `${world.crafting.get(a)?.name ?? a} + ${world.crafting.get(b)?.name ?? b}  →  ${r.name}`,
      ARENA.w / 2, py
    );
    c.fillStyle = preview.isNew ? '#ffd166' : '#889';
    c.font = '13px monospace';
    c.fillText(
      `tier ${r.tier} · dmg ${r.stats.damage.toFixed(0)} · ${(1 / r.stats.cooldown).toFixed(1)}/s` +
      (preview.isNew ? ' · NEW PROTOCOL' : ' · known'),
      ARENA.w / 2, py + 22
    );
  } else {
    c.fillStyle = '#778';
    c.font = '16px sans-serif';
    c.fillText(
      ui.offerA >= 0 ? 'Click a second protein (or press its number)' : 'Click a protein card — or press 1 / 2 / 3',
      ARENA.w / 2, py + 10
    );
  }

  const btnW = 240, btnH = 52;
  const btnX = (ARENA.w - btnW) / 2;
  const btnY = 455;
  ui.offerHitboxes.push({ role: 'combine', x: btnX, y: btnY, w: btnW, h: btnH });
  c.fillStyle = can ? 'rgba(128,255,219,0.3)' : 'rgba(255,255,255,0.04)';
  c.fillRect(btnX, btnY, btnW, btnH);
  c.strokeStyle = can ? '#80ffdb' : '#334';
  c.lineWidth = can ? 3 : 1;
  c.strokeRect(btnX, btnY, btnW, btnH);
  c.fillStyle = can ? '#80ffdb' : '#556';
  c.font = 'bold 20px sans-serif';
  c.fillText(can ? 'SPLICE ↵' : 'SPLICE', btnX + btnW / 2, btnY + 34);

  // Skip hitbox
  const skipW = 160, skipH = 36;
  const skipX = (ARENA.w - skipW) / 2;
  const skipY = 530;
  ui.offerHitboxes.push({ role: 'skip', x: skipX, y: skipY, w: skipW, h: skipH });
  c.strokeStyle = '#445';
  c.lineWidth = 1;
  c.strokeRect(skipX, skipY, skipW, skipH);
  c.fillStyle = '#778';
  c.font = '13px sans-serif';
  c.fillText('Skip (no power) · C', skipX + skipW / 2, skipY + 24);

  c.fillStyle = '#556';
  c.font = '13px sans-serif';
  c.fillText('Mouse click · keys 1–3 · Enter splice · Q clear picks', ARENA.w / 2, ARENA.h - 28);
}

/** Unit aim vector: right stick wins, else mouse (in world space), else null. */
function currentAim() {
  const pad = input.padAim();
  if (pad) return pad;
  const m = screenToWorld(input.mouse.x, input.mouse.y);
  const dx = m.x - world.player.x;
  const dy = m.y - world.player.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.0001) return null; // cursor on top of player: keep last aim
  return { x: dx / len, y: dy / len };
}

/* ------------------------------------------------------------------ *
 * States
 * ------------------------------------------------------------------ */

fsm.register('boot', {
  enter() {
    // Sanity-check the balance data so a bad patch fails fast and loud.
    for (const [name, blob] of Object.entries(data)) {
      if (!blob || typeof blob !== 'object') {
        throw new Error(`Balance data "${name}" failed to load.`);
      }
    }
  },
  update() {
    fsm.change('menu'); // nothing heavy to load (yet) — straight to menu
  },
  render(c) {
    c.fillStyle = '#0d0f14';
    c.fillRect(0, 0, ARENA.w, ARENA.h);
  }
});

fsm.register('menu', {
  update() {
    input.update();
    if (input.wasPressed('confirm')) {
      startRun(menuSeed);
      fsm.change('playing');
    }
    if (input.wasPressed('newSeed')) {
      menuSeed = randomSeed();
    }
    if (input.wasPressed('resetGenome')) {
      profile = resetProfile(data.elements);
      toast(`Genome reset (${profile.unlockedIds.length} proteins)`, 2.5);
    }
    if (input.wasPressed('genome')) {
      input.endFrame();
      fsm.change('genome');
      return;
    }
    if (input.wasPressed('mute')) {
      const muted = audio.toggleMute();
      toast(muted ? 'Audio muted (M)' : 'Audio on (M)', 1.5);
    }
    input.endFrame();
  },
  render(c) {
    c.fillStyle = '#0d0f14';
    c.fillRect(0, 0, ARENA.w, ARENA.h);
    // Pixel grid backdrop
    c.strokeStyle = 'rgba(76,201,240,0.04)';
    for (let x = 0; x < ARENA.w; x += 32) {
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, ARENA.h); c.stroke();
    }

    const titleImg = uiSprite('menu_title');
    if (titleImg) {
      c.imageSmoothingEnabled = false;
      c.drawImage(titleImg, ARENA.w / 2 - 160, ARENA.h * 0.22, 320, 64);
    }

    c.textAlign = 'center';
    if (!titleImg) {
      c.fillStyle = '#4cc9f0';
      c.font = 'bold 64px sans-serif';
      c.fillText(config.title.toUpperCase(), ARENA.w / 2, ARENA.h * 0.32);
    }

    c.fillStyle = '#aaa';
    c.font = '18px sans-serif';
    c.fillText('Nanobot gene surgery in a dying patient — not parasite graft heaven.', ARENA.w / 2, ARENA.h * 0.32 + (titleImg ? 56 : 40));

    const cta = uiSprite('menu_cta');
    const ctaY = ARENA.h * 0.54;
    if (cta) {
      c.imageSmoothingEnabled = false;
      c.drawImage(cta, ARENA.w / 2 - 140, ctaY - 20, 280, 40);
    }
    c.fillStyle = '#fff';
    c.font = '24px sans-serif';
    c.fillText('Press ENTER to start', ARENA.w / 2, ctaY + 6);

    c.fillStyle = '#ffd166';
    c.font = '18px monospace';
    c.fillText(`Seed: ${menuSeed}   (N = reroll)`, ARENA.w / 2, ctaY + 40);

    {
      const pt = previewPatient(data.patients, menuSeed);
      if (pt) {
        c.fillStyle = '#80ffdb';
        c.font = '16px sans-serif';
        c.fillText(`Patient: ${pt.name}`, ARENA.w / 2, ctaY + 68);
        c.fillStyle = '#8ab';
        c.font = 'italic 13px sans-serif';
        c.fillText(pt.blurb, ARENA.w / 2, ctaY + 88);
      }
    }

    c.fillStyle = '#666';
    c.font = '14px sans-serif';
    c.fillText('Attack: click/space · castA Blink: Shift/E · castB: R · Pause: Esc', ARENA.w / 2, ARENA.h * 0.85);
    c.fillStyle = '#556';
    c.fillText('Clear → Lab: take chips · Tab hive · EXIT. Discover patterns.', ARENA.w / 2, ARENA.h * 0.85 + 24);
    c.fillStyle = '#445';
    c.font = '13px monospace';
    c.fillText(`Genome: ${profile.unlockedIds.length} unlocked   (V = view · G = reset)`, ARENA.w / 2, ARENA.h * 0.85 + 48);
    c.fillStyle = audio.muted ? '#667' : '#556';
    c.fillText(`Audio: ${audio.muted ? 'muted' : 'on'}   (M = toggle)`, ARENA.w / 2, ARENA.h * 0.85 + 68);
  }
});

fsm.register('genome', {
  enter() {
    profile = loadProfile(data.elements);
    ui.genomePage = 0;
  },
  update() {
    input.update();
    if (
      input.wasPressed('pause') ||
      input.wasPressed('confirm') ||
      input.wasPressed('genome') ||
      input.wasPressed('clear')
    ) {
      input.endFrame();
      fsm.change('menu');
      return;
    }
    // Day 123 — page DNA grid (volume without clutter)
    if (input.wasPressed('left') || input.wasPressed('slot1')) {
      ui.genomePage = Math.max(0, (ui.genomePage ?? 0) - 1);
    }
    if (input.wasPressed('right') || input.wasPressed('slot2')) {
      ui.genomePage = (ui.genomePage ?? 0) + 1;
    }
    input.endFrame();
  },
  render(c) {
    c.fillStyle = '#070c12';
    c.fillRect(0, 0, ARENA.w, ARENA.h);
    c.strokeStyle = 'rgba(76,201,240,0.06)';
    c.lineWidth = 1;
    for (let x = 0; x < ARENA.w; x += 32) {
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, ARENA.h); c.stroke();
    }
    for (let y = 0; y < ARENA.h; y += 32) {
      c.beginPath(); c.moveTo(0, y); c.lineTo(ARENA.w, y); c.stroke();
    }

    c.textAlign = 'center';
    c.fillStyle = '#4cc9f0';
    c.font = 'bold 40px sans-serif';
    c.fillText('GENOME', ARENA.w / 2, 52);
    c.fillStyle = '#9ab';
    c.font = '15px sans-serif';
    c.fillText('Sequenced protocols feed Gene Offers. Locked stay ??? until you stabilize a run.', ARENA.w / 2, 82);

    const unlocked = new Set(profile.unlockedIds);
    const frags = (data.elements.elements ?? []).filter((e) => !e.crafted && e.offerable !== false);
    const mods = (data.abilityModules?.modules ?? []).filter((m) => m && m.id);
    const cell = 78;
    const gap = 10;
    const cols = 8;
    const rowsPerPage = 3;
    const pageSize = cols * rowsPerPage;
    const pageCount = Math.max(1, Math.ceil(frags.length / pageSize));
    const page = Math.min(ui.genomePage ?? 0, pageCount - 1);
    ui.genomePage = page;
    const pageFrags = frags.slice(page * pageSize, page * pageSize + pageSize);
    const gridW = cols * cell + (cols - 1) * gap;
    const gridH = rowsPerPage * cell + (rowsPerPage - 1) * gap;
    const gx0 = (ARENA.w - gridW) / 2;
    const gy0 = 110;

    c.fillStyle = '#4cc9f0';
    c.font = 'bold 13px monospace';
    c.textAlign = 'left';
    c.fillText(`DNA CHIPS  ·  page ${page + 1}/${pageCount}  (←/→)`, gx0, gy0 - 10);

    pageFrags.forEach((el, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = gx0 + col * (cell + gap);
      const y = gy0 + row * (cell + gap);
      const isOn = unlocked.has(el.id);

      c.fillStyle = isOn ? 'rgba(82,183,136,0.12)' : 'rgba(20,24,36,0.9)';
      c.fillRect(x, y, cell, cell);
      c.strokeStyle = isOn ? '#52b788' : '#334455';
      c.lineWidth = isOn ? 2 : 1;
      c.strokeRect(x + 1, y + 1, cell - 2, cell - 2);

      if (isOn) {
        drawFragmentIcon(c, el, x + cell / 2, y + cell / 2 - 8, 36);
        c.textAlign = 'center';
        c.fillStyle = '#eef';
        c.font = 'bold 9px sans-serif';
        const label = el.name.length > 9 ? `${el.name.slice(0, 8)}…` : el.name;
        c.fillText(label, x + cell / 2, y + cell - 8);
      } else {
        c.fillStyle = '#1a2230';
        c.beginPath();
        c.arc(x + cell / 2, y + cell / 2 - 6, 14, 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = '#445566';
        c.stroke();
        c.textAlign = 'center';
        c.fillStyle = '#667788';
        c.font = 'bold 14px monospace';
        c.fillText('???', x + cell / 2, y + cell / 2);
        c.fillStyle = '#445';
        c.font = '8px monospace';
        c.fillText('locked', x + cell / 2, y + cell - 8);
      }
    });

    // Ability modules strip
    const my0 = gy0 + gridH + 36;
    c.textAlign = 'left';
    c.fillStyle = '#e040fb';
    c.font = 'bold 13px monospace';
    c.fillText('ABILITY MODULES', gx0, my0 - 10);
    const mCell = 100;
    const mGap = 16;
    const modRowW = mods.length * mCell + (mods.length - 1) * mGap;
    const mx0 = (ARENA.w - modRowW) / 2;
    mods.forEach((mod, i) => {
      const x = mx0 + i * (mCell + mGap);
      const y = my0;
      const isOn = mod.offerable !== false || mod.id === 'blink';
      c.fillStyle = isOn ? 'rgba(224,64,251,0.12)' : 'rgba(20,24,36,0.9)';
      c.fillRect(x, y, mCell, mCell);
      c.strokeStyle = isOn ? '#e040fb' : '#334455';
      c.lineWidth = isOn ? 2 : 1;
      c.strokeRect(x + 1, y + 1, mCell - 2, mCell - 2);
      if (isOn) {
        drawAbilityIcon(c, mod, x + mCell / 2, y + mCell / 2 - 10, 44);
        c.textAlign = 'center';
        c.fillStyle = '#eef';
        c.font = 'bold 10px sans-serif';
        c.fillText(mod.name?.slice(0, 12) ?? mod.id, x + mCell / 2, y + mCell - 12);
      } else {
        c.textAlign = 'center';
        c.fillStyle = '#667788';
        c.font = 'bold 18px monospace';
        c.fillText('???', x + mCell / 2, y + mCell / 2);
        c.fillStyle = '#445';
        c.font = '9px monospace';
        c.fillText('teaser', x + mCell / 2, y + mCell - 12);
      }
    });

    const nOn = frags.filter((e) => unlocked.has(e.id)).length;
    const nMod = mods.filter((m) => m.offerable !== false || m.id === 'blink').length;
    c.textAlign = 'center';
    c.fillStyle = '#80ffdb';
    c.font = '13px monospace';
    c.fillText(
      `${nOn} / ${frags.length} DNA · ${nMod} / ${mods.length} modules`,
      ARENA.w / 2,
      Math.min(my0 + mCell + 28, ARENA.h - 56)
    );
    c.fillStyle = '#667';
    c.font = '14px sans-serif';
    c.fillText('Esc / Enter / V — back', ARENA.w / 2, ARENA.h - 28);
  }
});

fsm.register('playing', {
  update(dt) {
    input.update();
    presentationClock += dt;

    if (input.wasPressed('mute')) {
      const muted = audio.toggleMute();
      toast(muted ? 'Audio muted (M)' : 'Audio on (M)', 1.5);
    }

    if (input.wasPressed('pause')) {
      if (world.inLab && ui.genomeOpen) {
        ui.genomeOpen = false;
        ui.hexBagIdx = -1;
        input.endFrame();
        return;
      }
      input.endFrame();
      fsm.change('paused');
      return;
    }
    if (input.wasPressed('craft')) {
      // Day 153: Tab expands Lab genome; mid-fight forge is debugForge only.
      if (world.inLab) {
        ui.genomeOpen = !ui.genomeOpen;
        if (!ui.genomeOpen) ui.hexBagIdx = -1;
        input.endFrame();
        return;
      }
      input.endFrame();
      openForge('playing');
      return;
    }

    // Slot keys 1-4 equip directly while fighting.
    const slot = input.pressedSlot();
    const equip = slot && slot <= world.inventory.length ? slot - 1 : null;

    const opThreshold = data.map.pressureEffects.overpressureThreshold;
    const overpressure = world.pressure > opThreshold;
    juice.setOverpressure(overpressure);
    if (overpressure) audio.playOverpressureWarning(presentationClock);

    // Hit-stop: renderer-only sim freeze (see data/juice.json + juice.js).
    if (!juice.isSimFrozen()) {
      const inLab = world.inLab;
      world.update(dt, {
        move: input.axis(),
        aim: currentAim(),
        fire: inLab ? false : input.isDown('fire'),
        // Day 064: Shift/B dash and E/LB castA both trigger Blink (Ability A).
        castA: input.wasPressed('castA') || input.wasPressed('dash'),
        castB: input.wasPressed('castB'),
        // Day 073: confirm / fire edge selects nearest Offer pedestal.
        interact: inLab && (input.wasPressed('confirm') || input.wasPressed('fire')),
        equip
      });
    }
    juice.tick(dt, overpressure);

    // Toast countdown is UI-side, ticked by the same fixed step.
    if (ui.toast && (ui.toast.t -= dt) <= 0) ui.toast = null;
    if (ui.attackDelta && (ui.attackDelta.t -= dt) <= 0) ui.attackDelta = null;
    if (ui.pulse && (ui.pulse.t -= dt) <= 0) ui.pulse = null;

    if (world.victory) {
      input.endFrame();
      fsm.change('victory');
      return;
    }
    if (world.gameOver) {
      input.endFrame();
      fsm.change('gameover');
      return;
    }
    if (world.chamberCleared) {
      // Day 071–072: Lab is walkable; exit zone → route / advance (tryExitLab).
      // Day 092: click hex bag/seats (fast place) before pedestal interact.
      if (world.inLab) {
        if (input.wasPressed('fire')) {
          const m = screenToWorld(input.mouse.x, input.mouse.y);
          if (m && hexClick(m.x, m.y)) {
            input.endFrame();
            return;
          }
        }
        if (input.wasPressed('clear')) ui.hexBagIdx = -1;
        // Day 110 — Lab time budget shortcuts
        if (input.wasPressed('labSkip') && world.offer) {
          world.skipOffer();
          ui.toast = { text: 'Offers discarded', t: 1.2 };
        }
        if (input.wasPressed('labExit')) {
          if (world.dnaInventory.length > 0) {
            toast('Overflow chips stay unpowered — seat them on the hive', 2.2);
          }
          const r = world.confirmExitLab();
          input.endFrame();
          if (r === 'route') {
            fsm.change('route');
            return;
          }
          return;
        }
        input.endFrame();
        return;
      }
      // Offer menu-only is off the happy path (debugOfferMenu reinstates it).
      if (world.offer && config.debugOfferMenu) {
        ui.offerA = -1;
        ui.offerB = -1;
        input.endFrame();
        fsm.change('offer');
        return;
      }
      if (world.offer) world.skipOffer();
      if (!needsRouteChoice(world.node, world._nodeById)) {
        world.advance(0);
      } else {
        input.endFrame();
        fsm.change('route');
        return;
      }
    }

    input.endFrame();
  },
  render(c, alpha, fps) {
    renderWorld(c, alpha);
    renderHud(c, fps);
  }
});

fsm.register('paused', {
  update() {
    input.update();
    if (input.wasPressed('pause') || input.wasPressed('confirm')) {
      input.endFrame();
      fsm.change('playing');
      return;
    }
    if (input.wasPressed('clear')) {
      input.endFrame();
      abandonToMenu();
      return;
    }
    if (input.wasPressed('craft')) {
      input.endFrame();
      openForge('paused');
      return;
    }
    input.endFrame();
  },
  render(c, alpha, fps) {
    renderWorld(c, 1); // frozen world behind the overlay
    renderHud(c, fps);
    overlay(c, 'PAUSED', config.debugForge
      ? 'Esc/Enter resume · Q abandon · Attack click · castA Shift/E · castB R · C forge (debug)'
      : (config.debug
        ? 'Esc/Enter resume · Q abandon · Attack · casts · Lab · cheat.* console (debug kit)'
        : 'Esc/Enter resume · Q abandon · Attack click · castA Shift/E · castB R · rearrange in Lab'));
  }
});

fsm.register('offer', {
  // After a chamber: pick two Gene Fragments from the Offer, splice them,
  // discard the rest — then continue to route / next chamber.
  update(dt) {
    input.update();
    presentationClock += dt;
    juice.tick(dt, false);

    if (ui.splicePending) {
      if (!juice.spliceFx) {
        ui.splicePending = false;
        leaveOffer();
      }
      input.endFrame();
      return;
    }

    if (!world.offer || world.offer.length === 0) {
      input.endFrame();
      leaveOffer();
      return;
    }

    const n = world.offer.length;

    if (input.wasPressed('clear')) {
      ui.offerA = -1;
      ui.offerB = -1;
    }

    // Click a card or Combine
    if (input.wasPressed('fire')) {
      const m = screenToWorld(input.mouse.x, input.mouse.y);
      offerClick(m.x, m.y);
    }

    // Accept every slot edge this step (1+2 in the same frame must both land).
    for (let i = 1; i <= n; i++) {
      if (input.wasPressed(`slot${i}`)) offerSelect(i - 1);
    }

    if (input.wasPressed('confirm')) {
      if (ui.offerA >= 0 && ui.offerB >= 0) commitOffer();
      else if (ui.offerA < 0 && n > 0) offerSelect(0);
    }

    // Optional skip (no power) — Q already clears; Hold Escape? Use craft key as skip.
    if (input.wasPressed('craft')) {
      world.skipOffer();
      input.endFrame();
      leaveOffer();
      return;
    }

    input.endFrame();
  },
  render(c, alpha, fps) {
    renderWorld(c, alpha);
    renderHud(c, fps);
    renderOffer(c);
    renderSpliceFx(c);
  }
});

fsm.register('forge', {
  // The Nano-Forge: freeze the fight. Click ingredients into the recipe
  // tray, then Combine. Keyboard (arrows/Enter) remains a fallback.
  // The ONLY sim mutation here is world.craft(a, b, targetSlot).
  update() {
    input.update();

    if (input.wasPressed('craft') || input.wasPressed('pause')) {
      input.endFrame();
      fsm.change(ui.forgeReturn);
      return;
    }
    if (input.wasPressed('clear')) {
      ui.forgeA = null;
      ui.forgeB = null;
    }

    const entries = forgeEntries();
    const slotCount = world.inventory.length;
    const stockCount = entries.length - slotCount;

    // --- Mouse click: select / replace-target / Combine ---
    if (input.wasPressed('fire')) {
      const m = screenToWorld(input.mouse.x, input.mouse.y);
      forgeClick(m.x, m.y);
    }

    // --- Grid navigation (keyboard fallback) ---
    let cur = Math.min(ui.forgeCursor, Math.max(0, entries.length - 1));
    const inSlots = cur < slotCount;
    if (input.wasPressed('left')) cur = (cur + entries.length - 1) % entries.length;
    if (input.wasPressed('right')) cur = (cur + 1) % entries.length;
    if ((input.wasPressed('up') || input.wasPressed('down')) && stockCount > 0) {
      cur = inSlots
        ? slotCount + Math.min(cur, stockCount - 1)
        : Math.min(cur - slotCount, slotCount - 1);
    }
    ui.forgeCursor = cur;

    // Slot keys 1-4: starters / empty → replace target; crafted → select as ingredient.
    const slot = input.pressedSlot();
    if (slot && slot <= slotCount) {
      ui.forgeCursor = slot - 1;
      forgeActivate(entries[slot - 1]);
    }

    // Enter: Combine if both picked, else activate the focused card.
    // (Space/click already handled via fire → forgeClick above.)
    if (input.wasPressed('confirm')) {
      if (ui.forgeA && ui.forgeB) forgeCommit();
      else if (entries[ui.forgeCursor]) forgeActivate(entries[ui.forgeCursor]);
    }

    input.endFrame();
  },
  render(c, alpha, fps) {
    renderWorld(c, 1); // frozen fight behind the forge
    renderHud(c, fps);
    renderForge(c);
  }
});

function pickRoute(exitIdx) {
  if (!world.advance(exitIdx)) return false;
  fsm.change('playing');
  return true;
}

function routeClick(wx, wy) {
  for (let i = (ui.routeHitboxes?.length ?? 0) - 1; i >= 0; i--) {
    const h = ui.routeHitboxes[i];
    if (wx >= h.x && wx <= h.x + h.w && wy >= h.y && wy <= h.y + h.h) {
      pickRoute(h.idx);
      return;
    }
  }
}

fsm.register('route', {
  // The Circulatory Flow junction: pick which vessel the heart pumps you
  // into next. Also the natural between-rounds moment to forge (C).
  update() {
    input.update();
    if (input.wasPressed('craft')) {
      input.endFrame();
      openForge('route');
      return;
    }
    // Click parity with the Offer screen — cards look interactive, so they are.
    if (input.wasPressed('fire')) {
      const m = screenToWorld(input.mouse.x, input.mouse.y);
      routeClick(m.x, m.y);
      if (fsm.current === 'playing') {
        input.endFrame();
        return;
      }
    }
    const exits = world.node.exits;
    const slot = input.pressedSlot();
    if (slot && slot <= exits.length && pickRoute(slot - 1)) {
      input.endFrame();
      return;
    }
    input.endFrame();
  },
  render(c, alpha, fps) {
    renderWorld(c, 1);
    renderHud(c, fps);
    c.fillStyle = 'rgba(13, 15, 20, 0.82)';
    c.fillRect(0, 0, ARENA.w, ARENA.h);

    c.textAlign = 'center';
    c.fillStyle = '#4cc9f0';
    c.font = 'bold 34px sans-serif';
    c.fillText('CHAMBER STERILIZED', ARENA.w / 2, ARENA.h * 0.2);
    c.fillStyle = '#aaa';
    c.font = '17px sans-serif';
    c.fillText('The heart is pumping. Choose your vessel.', ARENA.w / 2, ARENA.h * 0.2 + 30);

    renderVesselMinimap(c);
    renderRouteCards(c, world.node.exits);

    const nowBand = pressureRiskTier(data.map, world.pressure);
    const footerY = ARENA.h * 0.88;
    c.font = 'bold 13px monospace';
    const riskPrefix = 'Risk now · ';
    const prefixW = c.measureText(riskPrefix).width;
    const bandW = c.measureText(nowBand.label).width;
    const riskX = ARENA.w / 2 - (prefixW + bandW) / 2;
    c.textAlign = 'left';
    c.fillStyle = PRESSURE_DIAL.pickFooterColor;
    c.fillText(riskPrefix, riskX, footerY);
    c.fillStyle = nowBand.fill;
    c.fillText(nowBand.label, riskX + prefixW, footerY);
    c.textAlign = 'center';
    c.fillStyle = '#80ffdb';
    c.font = '14px sans-serif';
    c.fillText('click / 1–N choose vessel · C ability splicer', ARENA.w / 2, footerY + 36);
  }
});

fsm.register('victory', {
  enter() {
    steam.unlockAchievement('PATIENT_STABILIZED');
    steam.setRichPresence('status', 'saved a life today');
    profile = loadProfile(data.elements);
    ui.victoryUnlocks = [...(profile.unlockedIds || [])];
  },
  update() {
    input.update();
    if (input.wasPressed('confirm')) {
      input.endFrame();
      abandonToMenu();
      return;
    }
    if (input.wasPressed('genome')) {
      input.endFrame();
      if (world) menuSeed = world.seed;
      world = null;
      resetRunPresentation();
      fsm.change('genome');
      return;
    }
    input.endFrame();
  },
  render(c) {
    renderWorld(c, 1);
    c.fillStyle = 'rgba(13, 15, 20, 0.88)';
    c.fillRect(0, 0, ARENA.w, ARENA.h);

    c.textAlign = 'center';
    c.fillStyle = '#52b788';
    c.font = 'bold 52px sans-serif';
    c.fillText('PATIENT STABILIZED', ARENA.w / 2, ARENA.h * 0.22);

    c.fillStyle = '#aaa';
    c.font = 'italic 16px sans-serif';
    c.fillText('The infection core is sterile. Protocols sequenced into your Genome.', ARENA.w / 2, ARENA.h * 0.22 + 32);

    c.fillStyle = '#fff';
    c.font = '18px sans-serif';
    c.fillText(
      `Score ${world.score}   ·   ${world.kills} kills   ·   ${world.crafting.discoveries} discoveries`,
      ARENA.w / 2,
      ARENA.h * 0.38
    );

    // Genome strip
    c.fillStyle = '#4cc9f0';
    c.font = 'bold 14px monospace';
    c.fillText(`GENOME  ${profile.unlockedIds.length} sequenced`, ARENA.w / 2, ARENA.h * 0.48);
    const ids = profile.unlockedIds.slice(0, 8);
    const stamp = 44;
    const total = ids.length * (stamp + 8) - 8;
    let sx = (ARENA.w - total) / 2;
    for (const id of ids) {
      const el = world.crafting.get(id) || { id, icon: '?' };
      drawFragmentIcon(c, el, sx + stamp / 2, ARENA.h * 0.48 + 40, stamp);
      sx += stamp + 8;
    }

    c.fillStyle = '#ffd166';
    c.font = '16px monospace';
    c.fillText(`Seed: ${world.seed} — can your friends save this patient?`, ARENA.w / 2, ARENA.h * 0.72);

    c.fillStyle = '#888';
    c.font = '15px sans-serif';
    c.fillText('ENTER menu · V Genome', ARENA.w / 2, ARENA.h * 0.82);
  }
});

fsm.register('gameover', {
  enter() {
    // Seeded quip — even the trash talk is reproducible.
    ui.quip = world.rng.stream('quips').pick(data.player.gameOverQuips);
    steam.setRichPresence('status', 'staring at a game over screen');
  },
  update() {
    input.update();
    if (input.wasPressed('confirm')) {
      input.endFrame();
      restartRun(world.seed);
      return;
    }
    if (input.wasPressed('pause')) {
      input.endFrame();
      abandonToMenu();
      return;
    }
    input.endFrame();
  },
  render(c) {
    renderWorld(c, 1);
    c.fillStyle = 'rgba(13, 15, 20, 0.85)';
    c.fillRect(0, 0, ARENA.w, ARENA.h);

    c.textAlign = 'center';
    c.fillStyle = '#e63946';
    c.font = 'bold 56px sans-serif';
    c.fillText('GAME OVER', ARENA.w / 2, ARENA.h * 0.35);

    c.fillStyle = '#aaa';
    c.font = 'italic 18px sans-serif';
    c.fillText(ui.quip, ARENA.w / 2, ARENA.h * 0.35 + 36);

    c.fillStyle = '#fff';
    c.font = '20px sans-serif';
    c.fillText(
      `Score ${world.score}   ·   Wave ${world.wave}   ·   ${world.crafting.discoveries} discoveries`,
      ARENA.w / 2,
      ARENA.h * 0.5
    );

    c.fillStyle = '#ffd166';
    c.font = '18px monospace';
    c.fillText(`Seed: ${world.seed} — dare a friend to beat it`, ARENA.w / 2, ARENA.h * 0.5 + 32);

    c.fillStyle = '#888';
    c.font = '16px sans-serif';
    c.fillText('ENTER retry · Esc menu', ARENA.w / 2, ARENA.h * 0.65);
  }
});

// Auto-pause when the window loses focus — never kill an alt-tabbed player.
window.addEventListener('blur', () => {
  if (fsm.current === 'playing') fsm.change('paused');
});

/* ------------------------------------------------------------------ *
 * Rendering helpers (world coordinates — viewport transform applied below)
 * ------------------------------------------------------------------ */

function renderWorld(c, alpha) {
  c.save();
  c.translate(juice.shakeX, juice.shakeY);

  // Background + subtle grid — biome tint when present.
  c.fillStyle = world.biomeBg || '#0d0f14';
  c.fillRect(0, 0, ARENA.w, ARENA.h);
  c.strokeStyle = world.biomeGrid || 'rgba(255,255,255,0.04)';
  c.lineWidth = 1;
  for (let x = 0; x < ARENA.w; x += 40) {
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, ARENA.h); c.stroke();
  }
  for (let y = 0; y < ARENA.h; y += 40) {
    c.beginPath(); c.moveTo(0, y); c.lineTo(ARENA.w, y); c.stroke();
  }

  // Chamber walls — neon-edge wet plaque; tint from room template look.
  const look = world.roomLook || { fill: '#121820', edge: '#3d5a80', neon: 'rgba(76,201,240,0.45)' };
  for (const wall of world.walls) {
    if (wall.ruptured) {
      c.strokeStyle = 'rgba(255,107,138,0.7)';
      c.lineWidth = 2;
      c.setLineDash([4, 4]);
      c.strokeRect(wall.x + 2, wall.y + 2, wall.w - 4, wall.h - 4);
      c.setLineDash([]);
      continue;
    }
    // Day 224 — scabbed breach: sealed crust, still fragile (re-ruptures fast).
    if (wall.scabbed) {
      c.fillStyle = look.fill || '#121820';
      c.fillRect(wall.x, wall.y, wall.w, wall.h);
      c.fillStyle = 'rgba(255,107,138,0.22)';
      c.fillRect(wall.x + 3, wall.y + 3, wall.w - 6, wall.h - 6);
      c.strokeStyle = 'rgba(255,107,138,0.55)';
      c.lineWidth = 2;
      c.strokeRect(wall.x + 1, wall.y + 1, wall.w - 2, wall.h - 2);
      continue;
    }
    c.fillStyle = look.fill || '#121820';
    c.fillRect(wall.x, wall.y, wall.w, wall.h);
    c.strokeStyle = look.edge || '#3d5a80';
    c.lineWidth = 2;
    c.strokeRect(wall.x + 1, wall.y + 1, wall.w - 2, wall.h - 2);
    c.strokeStyle = look.neon || 'rgba(76, 201, 240, 0.45)';
    c.lineWidth = 1;
    c.strokeRect(wall.x + 4, wall.y + 4, wall.w - 8, wall.h - 8);
    // Biome wall kit — pixel dot accents (Days 031–032).
    const pat = look.wallPattern;
    if (pat === 'neural' || pat === 'marrow') {
      c.fillStyle = pat === 'neural' ? 'rgba(224,64,251,0.35)' : 'rgba(230,57,70,0.35)';
      const step = 14;
      for (let py = wall.y + 8; py < wall.y + wall.h - 4; py += step) {
        for (let px = wall.x + 8; px < wall.x + wall.w - 4; px += step) {
          if ((px + py) % (step * 2) === 0) {
            c.fillRect(px, py, 3, 3);
          }
        }
      }
    }
  }

  for (const s of world.suctionFields ?? []) {
    // Day 178 — the burst is on a timer; the ring collapses as it fades so
    // "wait it out or walk out" reads at fight distance.
    const frac = s.maxLife ? Math.max(0, Math.min(1, s.life / s.maxLife)) : 1;
    c.strokeStyle = `rgba(255,107,138,${(0.25 + 0.6 * frac).toFixed(3)})`;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(s.x, s.y, s.radius * (0.45 + 0.55 * frac), 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = `rgba(255,107,138,${(0.05 + 0.1 * frac).toFixed(3)})`;
    c.beginPath();
    c.arc(s.x, s.y, s.radius * 0.35 * frac, 0, Math.PI * 2);
    c.fill();
  }

  // Day 249 — ranged spit windup tell (cyan ring while pendingShot counts down).
  for (const enemy of world.enemies) {
    if (!enemy.alive || enemy.dying) continue;
    const ps = enemy.pendingShot;
    if (!ps || (ps.delay ?? 0) <= 0) continue;
    const frac = ps.maxDelay ? Math.max(0, 1 - ps.delay / ps.maxDelay) : 1;
    const r = enemy.radius * (1.05 + 0.35 * frac);
    c.strokeStyle = `rgba(128,255,219,${(0.35 + 0.45 * frac).toFixed(3)})`;
    c.lineWidth = 2 + frac;
    c.beginPath();
    c.arc(enemy.x, enemy.y, r, 0, Math.PI * 2);
    c.stroke();
  }

  // Day 212 — nerve rails (floor strips) + telegraph glow.
  for (const rail of world.nerveRails ?? []) {
    const armed = (world.nerveTelegraphs ?? []).some((t) => t.railId === rail.id);
    c.fillStyle = armed ? 'rgba(224,64,251,0.55)' : 'rgba(224,64,251,0.28)';
    c.fillRect(rail.x, rail.y, rail.w, rail.h);
    c.strokeStyle = armed ? '#f48fff' : '#e040fb';
    c.lineWidth = armed ? 2 : 1;
    c.strokeRect(rail.x + 0.5, rail.y + 0.5, rail.w - 1, rail.h - 1);
    if (armed) {
      const tg = world.nerveTelegraphs.find((t) => t.railId === rail.id);
      const frac = tg?.maxDelay ? Math.max(0, 1 - tg.delay / tg.maxDelay) : 1;
      c.strokeStyle = `rgba(244,143,255,${(0.35 + 0.45 * frac).toFixed(3)})`;
      c.lineWidth = 3;
      c.strokeRect(rail.x - 3, rail.y - 3, rail.w + 6, rail.h + 6);
    }
  }

  // Cosmetic props — no collision (Day 024).
  for (const prop of world.props ?? []) {
    const img = propSprite(prop.id);
    if (!drawWorldSprite(c, img, prop.x, prop.y, prop.size ?? 40)) {
      c.fillStyle = 'rgba(76,201,240,0.25)';
      c.beginPath();
      c.arc(prop.x, prop.y, (prop.size ?? 40) * 0.2, 0, Math.PI * 2);
      c.fill();
    }
  }

  // Day 152 — pedestals: icon + name only (no essay under each).
  if (world.inLab) {
    for (const ped of world.labPedestals()) {
      if (!ped.id) continue;
      c.save();
      c.strokeStyle = ped.selected ? '#ffd166' : (ped.applicable ? 'rgba(128,255,219,0.4)' : 'rgba(80,90,110,0.35)');
      c.lineWidth = ped.selected ? 3 : 1.5;
      c.beginPath();
      c.arc(ped.x, ped.y, ped.r, 0, Math.PI * 2);
      c.stroke();
      if (ped.kind === 'ability') {
        const mod = (data.abilityModules?.modules ?? []).find((m) => m.id === ped.id);
        drawAbilityIcon(c, mod ?? ped.id, ped.x, ped.y - 10, 36);
        c.fillStyle = ped.selected ? '#ffd166' : '#4cc9f0';
        c.font = 'bold 12px monospace';
        c.textAlign = 'center';
        c.textBaseline = 'top';
        c.fillText(String(mod?.name ?? ped.id).slice(0, 14), ped.x, ped.y + 22);
      } else if (ped.kind === 'fuse') {
        c.fillStyle = ped.selected ? '#ffd166' : '#e040fb';
        c.font = 'bold 12px monospace';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText('FUSE', ped.x, ped.y - 8);
        c.font = '11px monospace';
        c.fillText(String(ped.id).slice(0, 14), ped.x, ped.y + 10);
      } else {
        const el = world.crafting.get(ped.id);
        drawFragmentIcon(c, el, ped.x, ped.y - 8, 32);
        c.fillStyle = ped.selected ? '#ffd166' : '#80ffdb';
        c.font = 'bold 12px monospace';
        c.textAlign = 'center';
        c.textBaseline = 'top';
        c.fillText(String(el?.name ?? ped.id).slice(0, 12), ped.x, ped.y + 22);
        const pedCard = ped.card ?? { kind: 'dna', id: ped.id };
        const axisLine =
          offerHealCallout(pedCard, world) ||
          offerPierceCallout(pedCard, world) ||
          offerChainCallout(pedCard, world) ||
          offerKnockbackCallout(pedCard, world);
        if (axisLine) {
          c.fillStyle = '#8899aa';
          c.font = '10px monospace';
          c.textBaseline = 'top';
          c.fillText(axisLine, ped.x, ped.y + 36);
        }
      }
      c.restore();
    }
    // Day 140 — demo pad is the star of Lab
    const pad = world.labZones?.demoPad;
    if (pad) {
      const active = world.demoPadActive;
      c.save();
      c.strokeStyle = active ? 'rgba(255,209,102,0.85)' : 'rgba(128,255,219,0.35)';
      c.lineWidth = active ? 3 : 1.5;
      c.beginPath();
      c.arc(pad.x, pad.y, (pad.r ?? 48) + (active ? 6 : 0), 0, Math.PI * 2);
      c.stroke();
      if (active) {
        c.fillStyle = 'rgba(255,209,102,0.08)';
        c.beginPath();
        c.arc(pad.x, pad.y, pad.r ?? 48, 0, Math.PI * 2);
        c.fill();
      }
      const focusIdx = world.offerHighlight?.length
        ? world.offerHighlight[world.offerHighlight.length - 1]
        : null;
      const focusPed = focusIdx != null
        ? world.labPedestals().find((p) => p.idx === focusIdx)
        : null;
      let padLabel = 'try';
      if (active) {
        if (focusPed?.id) {
          padLabel = focusPed.kind === 'fuse'
            ? 'FUSE'
            : String(focusPed.id).slice(0, 8).toUpperCase();
        } else {
          padLabel = 'LIVE';
        }
      }
      c.fillStyle = active ? '#ffd166' : '#80ffdb';
      c.font = 'bold 14px monospace';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(padLabel, pad.x, pad.y - (pad.r ?? 48) - 12);
      c.restore();
    }
    renderLabExit(c);
    renderHexLab(c);
  }

  for (const pickup of world.pickups) pickup.render(c, alpha);
  for (const enemy of world.enemies) enemy.render(c, alpha);
  for (const proj of world.projectiles) proj.render(c, alpha);
  world.player.render(c, alpha);

  // Chain-lightning arcs + pixel pops + Lab demo ability FX (Day 023 / 087).
  for (const f of world.fx) {
    if (f.kind === 'pop') {
      const maxT = f.pop === 'death' ? 0.32 : 0.22;
      const a = Math.max(f.t / maxT, 0);
      const stamp = fxSprite(f.pop === 'death' ? 'death_pop' : 'pickup_pop');
      c.save();
      c.globalAlpha = a;
      if (!drawWorldSprite(c, stamp, f.x, f.y, 28 + (1 - a) * 10)) {
        c.fillStyle = f.color ?? '#ffd166';
        c.beginPath();
        c.arc(f.x, f.y, 6 + (1 - a) * 8, 0, Math.PI * 2);
        c.fill();
      }
      c.restore();
      continue;
    }
    // Day 087 — distinct demo-pad archetype FX
    if (f.kind === 'demo-shield' || f.kind === 'demo-pull' || f.kind === 'nova' || f.kind === 'demo-nova') {
      const maxT = f.life ?? f.t ?? 0.3;
      const a = Math.max(f.t / maxT, 0);
      const fxId = f.kind === 'demo-shield' ? 'shield'
        : (f.kind === 'demo-pull' ? 'pull' : 'nova');
      const stamp = fxSprite(fxId);
      c.save();
      c.globalAlpha = a;
      const size = (f.r ? Math.min(f.r * 0.35, 96) : 48) * (0.7 + (1 - a) * 0.5);
      if (!drawWorldSprite(c, stamp, f.x, f.y, size)) {
        c.strokeStyle = fxId === 'pull' ? '#e040fb' : fxId === 'nova' ? '#e63946' : '#80ffdb';
        c.lineWidth = 3;
        c.beginPath();
        c.arc(f.x, f.y, (f.r ?? 40) * (0.4 + (1 - a) * 0.4), 0, Math.PI * 2);
        c.stroke();
      }
      // Ring for pull / nova radius readability
      if (f.r) {
        c.strokeStyle = fxId === 'pull' ? 'rgba(224,64,251,0.45)' : 'rgba(230,57,70,0.4)';
        c.lineWidth = 2;
        c.beginPath();
        c.arc(f.x, f.y, f.r * a, 0, Math.PI * 2);
        c.stroke();
      }
      c.restore();
      continue;
    }
    if (f.x1 == null) continue;
    c.strokeStyle = f.color;
    c.globalAlpha = Math.max(f.t / 0.15, 0);
    c.lineWidth = 2;
    c.beginPath(); c.moveTo(f.x1, f.y1); c.lineTo(f.x2, f.y2); c.stroke();
    c.globalAlpha = 1;
  }

  // Heartbeat / splice / Lab commit pulse (presentation only).
  if (ui.pulse && ui.pulse.t > 0) {
    const maxT = ui.pulse.kind === 'clear'
      ? clearBeat.duration
      : ui.pulse.kind === 'discover'
        ? discoverBeat.duration
        : ui.pulse.kind === 'synergy'
          ? synergyBeat.duration
          : ui.pulse.kind === 'almost'
            ? almostBeat.duration
            : ui.pulse.kind === 'commit'
            ? 0.32
            : 0.28;
    const phase = 1 - ui.pulse.t / maxT;
    const a = Math.sin(phase * Math.PI) * (
      ui.pulse.kind === 'clear'
        ? clearBeat.pulseAlpha
        : ui.pulse.kind === 'discover'
          ? discoverBeat.pulseAlpha
          : ui.pulse.kind === 'synergy'
            ? synergyBeat.pulseAlpha
            : ui.pulse.kind === 'almost'
              ? almostBeat.pulseAlpha
              : 0.45
    );
    if (ui.pulse.kind === 'clear') {
      // Vignette pulse — stronger at edges (Day 044 full heartbeat).
      const grd = c.createRadialGradient(
        ARENA.w / 2, ARENA.h / 2, ARENA.h * 0.15,
        ARENA.w / 2, ARENA.h / 2, ARENA.h * 0.72
      );
      grd.addColorStop(0, 'rgba(230,57,70,0)');
      grd.addColorStop(1, `rgba(230,57,70,${a})`);
      c.fillStyle = grd;
      c.fillRect(0, 0, ARENA.w, ARENA.h);
    } else if (ui.pulse.kind === 'discover') {
      // Bob hook — soft violet pulse only (no text / no recipe / no pattern name).
      const rgb = discoverBeat.vignetteColor.replace('#', '');
      const r = parseInt(rgb.slice(0, 2), 16);
      const g = parseInt(rgb.slice(2, 4), 16);
      const b = parseInt(rgb.slice(4, 6), 16);
      const grd = c.createRadialGradient(
        ARENA.w / 2, ARENA.h / 2, ARENA.h * 0.2,
        ARENA.w / 2, ARENA.h / 2, ARENA.h * 0.75
      );
      grd.addColorStop(0, `rgba(${r},${g},${b},0)`);
      grd.addColorStop(1, `rgba(${r},${g},${b},${a})`);
      c.fillStyle = grd;
      c.fillRect(0, 0, ARENA.w, ARENA.h);
    } else if (ui.pulse.kind === 'synergy') {
      // Bob hook — teal synergy find pulse (no text / no recipe / no pattern name).
      const rgb = synergyBeat.vignetteColor.replace('#', '');
      const r = parseInt(rgb.slice(0, 2), 16);
      const g = parseInt(rgb.slice(2, 4), 16);
      const b = parseInt(rgb.slice(4, 6), 16);
      const grd = c.createRadialGradient(
        ARENA.w / 2, ARENA.h / 2, ARENA.h * 0.12,
        ARENA.w / 2, ARENA.h / 2, ARENA.h * 0.78
      );
      grd.addColorStop(0, `rgba(${r},${g},${b},0)`);
      grd.addColorStop(0.55, `rgba(255,209,102,${a * 0.18})`);
      grd.addColorStop(1, `rgba(${r},${g},${b},${a})`);
      c.fillStyle = grd;
      c.fillRect(0, 0, ARENA.w, ARENA.h);
    } else if (ui.pulse.kind === 'almost') {
      // Bob hook — warm amber almost pulse (no text / no recipe / no pattern name).
      const rgb = almostBeat.vignetteColor.replace('#', '');
      const r = parseInt(rgb.slice(0, 2), 16);
      const g = parseInt(rgb.slice(2, 4), 16);
      const b = parseInt(rgb.slice(4, 6), 16);
      const grd = c.createRadialGradient(
        ARENA.w / 2, ARENA.h / 2, ARENA.h * 0.22,
        ARENA.w / 2, ARENA.h / 2, ARENA.h * 0.68
      );
      grd.addColorStop(0, `rgba(${r},${g},${b},0)`);
      grd.addColorStop(1, `rgba(${r},${g},${b},${a})`);
      c.fillStyle = grd;
      c.fillRect(0, 0, ARENA.w, ARENA.h);
    } else if (ui.pulse.kind === 'commit') {
      c.fillStyle = `rgba(128,255,219,${a * 0.55})`;
      c.fillRect(0, 0, ARENA.w, ARENA.h);
    } else {
      c.fillStyle = `rgba(76,201,240,${a})`;
      c.fillRect(0, 0, ARENA.w, ARENA.h);
    }
  }

  renderJuiceParticles(c);
  renderLabCommitStamp(c);
  renderSynergyFindStamp(c);
  renderPatternAlmostStamp(c);
  renderAttackFormBeat(c);
  renderVolatileFuseBeat(c);
  renderAbilityBBeat(c);
  renderOverpressureVignette(c);

  c.restore();
}

/** Pixel heart / impact / Lab commit sparks (Days 044 / 083). */
function renderJuiceParticles(c) {
  for (const p of juice.clearParticles) {
    const a = Math.max(p.t / 0.45, 0);
    c.save();
    c.globalAlpha = a;
    if (p.kind === 'heart') {
      c.fillStyle = '#e63946';
      const s = p.size;
      c.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      c.fillRect(p.x - s, p.y - s / 2, s * 0.6, s * 0.6);
      c.fillRect(p.x + s * 0.4, p.y - s / 2, s * 0.6, s * 0.6);
    } else if (p.kind === 'commit-take') {
      c.fillStyle = '#80ffdb';
      const s = p.size;
      c.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    } else if (p.kind === 'commit-seat') {
      c.fillStyle = '#ffd166';
      const s = p.size;
      c.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      c.fillRect(p.x - s / 4, p.y - s / 4, s / 2, s / 2);
    } else if (p.kind === 'synergy') {
      c.fillStyle = '#4cc9f0';
      const s = p.size;
      c.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      c.fillStyle = '#ffd166';
      c.fillRect(p.x - s / 4, p.y - s / 4, s / 2, s / 2);
    } else if (p.kind === 'almost') {
      c.fillStyle = '#f4a261';
      const s = p.size;
      c.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    } else if (p.kind === 'commit') {
      c.fillStyle = '#80ffdb';
      const s = p.size;
      c.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    } else if (p.kind === 'form-beat') {
      c.fillStyle = '#fbbf24';
      const s = p.size;
      c.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      c.fillStyle = '#5eead4';
      c.fillRect(p.x - s / 4, p.y - s / 4, Math.max(1, s / 2), Math.max(1, s / 2));
    } else if (p.kind === 'ability-beat') {
      c.fillStyle = '#e040fb';
      const s = p.size;
      c.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      c.fillStyle = '#80ffdb';
      c.fillRect(p.x - s / 4, p.y - s / 4, Math.max(1, s / 2), Math.max(1, s / 2));
    } else if (p.kind === 'volatile-beat') {
      c.fillStyle = '#ef4444';
      const s = p.size;
      c.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      c.fillStyle = '#fb923c';
      c.fillRect(p.x - s / 4, p.y - s / 4, Math.max(1, s / 2), Math.max(1, s / 2));
    } else {
      c.fillStyle = '#ffd166';
      c.fillRect(p.x - 2, p.y - 2, 4, 4);
    }
    c.restore();
  }
}

/** Day 083 / 230 — take vs seat commit stamp (Bob). */
function renderLabCommitStamp(c) {
  const fx = juice.labCommitFx;
  if (!fx) return;
  const u = 1 - fx.t / fx.maxT;
  const isSeat = fx.hook === 'seat';
  const r = (isSeat ? 12 : 18) + u * (isSeat ? 28 : 42);
  const a = Math.sin((1 - u) * Math.PI) * (isSeat ? 0.72 : 0.85);
  c.save();
  c.globalAlpha = a;
  c.strokeStyle = fx.stampOuter ?? '#80ffdb';
  c.lineWidth = isSeat ? 2 : 3;
  if (isSeat) {
    c.beginPath();
    for (let i = 0; i < 6; i++) {
      const ang = Math.PI / 6 + (i / 6) * Math.PI * 2;
      const px = fx.x + Math.cos(ang) * r;
      const py = fx.y + Math.sin(ang) * r;
      if (i === 0) c.moveTo(px, py);
      else c.lineTo(px, py);
    }
    c.closePath();
    c.stroke();
  } else {
    c.beginPath();
    c.arc(fx.x, fx.y, r, 0, Math.PI * 2);
    c.stroke();
  }
  c.strokeStyle = fx.stampInner ?? '#ffd166';
  c.lineWidth = isSeat ? 1 : 1.5;
  c.beginPath();
  c.arc(fx.x, fx.y, r * (isSeat ? 0.45 : 0.55), 0, Math.PI * 2);
  c.stroke();
  c.restore();
}

/** Day 235 — clever pattern synergy find stamp (Bob silhouette: dual hex burst). */
function renderSynergyFindStamp(c) {
  const fx = juice.synergyFindFx;
  if (!fx) return;
  const u = 1 - fx.t / fx.maxT;
  const rOuter = 16 + u * 52;
  const rInner = 10 + u * 28;
  const a = Math.sin((1 - u) * Math.PI) * 0.88;
  c.save();
  c.globalAlpha = a;
  c.strokeStyle = fx.stampOuter ?? '#4cc9f0';
  c.lineWidth = 3;
  for (const base of [0, Math.PI / 6]) {
    c.beginPath();
    for (let i = 0; i < 6; i++) {
      const ang = base + (i / 6) * Math.PI * 2;
      const px = fx.x + Math.cos(ang) * rOuter;
      const py = fx.y + Math.sin(ang) * rOuter;
      if (i === 0) c.moveTo(px, py);
      else c.lineTo(px, py);
    }
    c.closePath();
    c.stroke();
  }
  c.strokeStyle = fx.stampInner ?? '#ffd166';
  c.lineWidth = 2;
  c.beginPath();
  c.arc(fx.x, fx.y, rInner, 0, Math.PI * 2);
  c.stroke();
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2;
    c.beginPath();
    c.moveTo(fx.x, fx.y);
    c.lineTo(fx.x + Math.cos(ang) * rOuter * 0.72, fx.y + Math.sin(ang) * rOuter * 0.72);
    c.stroke();
  }
  c.restore();
}

/** Day 260 — pattern almost-there stamp (Bob silhouette: single faint hex). */
function renderPatternAlmostStamp(c) {
  const fx = juice.patternAlmostFx;
  if (!fx) return;
  const u = 1 - fx.t / fx.maxT;
  const r = 10 + u * 22;
  const a = Math.sin((1 - u) * Math.PI) * 0.55;
  c.save();
  c.globalAlpha = a;
  c.strokeStyle = fx.stampOuter ?? '#f4a261';
  c.lineWidth = 1.5;
  c.beginPath();
  for (let i = 0; i < 6; i++) {
    const ang = Math.PI / 6 + (i / 6) * Math.PI * 2;
    const px = fx.x + Math.cos(ang) * r;
    const py = fx.y + Math.sin(ang) * r;
    if (i === 0) c.moveTo(px, py);
    else c.lineTo(px, py);
  }
  c.closePath();
  c.stroke();
  c.strokeStyle = fx.stampInner ?? '#e9c46a';
  c.lineWidth = 1;
  c.beginPath();
  c.arc(fx.x, fx.y, r * 0.35, 0, Math.PI * 2);
  c.stroke();
  c.restore();
}

/** Day 239 — Attack form silhouette stamp on shot art (Bob). Distinct from LAB_PIVOT text + lab commit ring. */
function renderAttackFormBeat(c) {
  const fx = juice.attackFormBeatFx;
  if (!fx) return;
  const u = 1 - fx.t / fx.maxT;
  const a = Math.sin((1 - u) * Math.PI) * 0.92;
  const cx = fx.x;
  const cy = fx.y;
  const boxW = fx.boxW ?? 72;
  const boxH = fx.boxH ?? 72;
  const pulse = 0.55 + u * 0.55;
  c.save();
  c.globalAlpha = a;
  c.strokeStyle = fx.stampOuter ?? '#fbbf24';
  c.lineWidth = 2.5;
  c.fillStyle = `rgba(94,234,212,${0.12 + (1 - u) * 0.18})`;
  c.fillRect(cx - boxW * pulse / 2, cy - boxH * pulse / 2, boxW * pulse, boxH * pulse);
  c.strokeRect(
    cx - boxW * pulse / 2 + 0.5,
    cy - boxH * pulse / 2 + 0.5,
    boxW * pulse - 1,
    boxH * pulse - 1
  );
  c.strokeStyle = fx.stampInner ?? '#5eead4';
  c.lineWidth = 2;
  const form = fx.form ?? 'bolt';
  if (form === 'beam') {
    const w = boxW * 0.62 * pulse;
    const h = boxH * 0.14 * pulse;
    c.fillStyle = `rgba(251,191,36,${0.35 + (1 - u) * 0.35})`;
    c.fillRect(cx - w / 2, cy - h / 2, w, h);
    c.strokeRect(cx - w / 2, cy - h / 2, w, h);
    c.beginPath();
    c.moveTo(cx + w / 2, cy);
    c.lineTo(cx + w / 2 + boxW * 0.08, cy - boxH * 0.06);
    c.lineTo(cx + w / 2 + boxW * 0.08, cy + boxH * 0.06);
    c.closePath();
    c.stroke();
  } else if (form === 'spray') {
    for (let i = -2; i <= 2; i++) {
      const ang = (i / 5) * 0.85 - Math.PI / 2;
      const len = boxW * 0.34 * pulse;
      c.beginPath();
      c.moveTo(cx, cy);
      c.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
      c.stroke();
    }
  } else if (form === 'rocket') {
    c.beginPath();
    c.moveTo(cx, cy - boxH * 0.28 * pulse);
    c.lineTo(cx + boxW * 0.18 * pulse, cy + boxH * 0.22 * pulse);
    c.lineTo(cx - boxW * 0.18 * pulse, cy + boxH * 0.22 * pulse);
    c.closePath();
    c.stroke();
    c.beginPath();
    c.moveTo(cx, cy + boxH * 0.22 * pulse);
    c.lineTo(cx, cy + boxH * 0.36 * pulse);
    c.stroke();
  } else {
    c.beginPath();
    c.arc(cx, cy, boxW * 0.16 * pulse, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.arc(cx, cy, boxW * 0.08 * pulse, 0, Math.PI * 2);
    c.stroke();
  }
  c.fillStyle = '#fbbf24';
  c.font = 'bold 10px monospace';
  c.textAlign = 'center';
  c.textBaseline = 'top';
  c.fillText(fx.label ?? 'BOLT', cx, cy + boxH * 0.34);
  c.restore();
}

/** Day 246 — volatile fuse jagged fracture stamp (Bob). Distinct from form silhouette / B diamond / pivot toast. */
function renderVolatileFuseBeat(c) {
  const fx = juice.volatileFuseBeatFx;
  if (!fx) return;
  const u = 1 - fx.t / fx.maxT;
  const a = Math.sin((1 - u) * Math.PI) * 0.94;
  const cx = fx.x;
  const cy = fx.y;
  const base = Math.min(fx.boxW ?? 72, fx.boxH ?? 72) * 0.42;
  const pulse = 0.5 + u * 0.65;
  const rOuter = base * pulse;
  const rInner = rOuter * 0.42;
  c.save();
  c.globalAlpha = a;
  c.strokeStyle = fx.stampOuter ?? '#ef4444';
  c.lineWidth = 2.5;
  c.beginPath();
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? rOuter : rOuter * 0.55;
    const px = cx + Math.cos(ang) * r;
    const py = cy + Math.sin(ang) * r;
    if (i === 0) c.moveTo(px, py);
    else c.lineTo(px, py);
  }
  c.closePath();
  c.stroke();
  c.strokeStyle = fx.stampInner ?? '#fb923c';
  c.lineWidth = 2;
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2 + Math.PI / 8;
    c.beginPath();
    c.moveTo(cx + Math.cos(ang) * rInner * 0.3, cy + Math.sin(ang) * rInner * 0.3);
    c.lineTo(cx + Math.cos(ang) * rOuter * 0.92, cy + Math.sin(ang) * rOuter * 0.92);
    c.stroke();
  }
  c.beginPath();
  c.arc(cx, cy, rInner, 0, Math.PI * 2);
  c.stroke();
  c.fillStyle = '#ef4444';
  c.font = 'bold 10px monospace';
  c.textAlign = 'center';
  c.textBaseline = 'top';
  c.fillText(fx.label ?? 'SPIKE', cx, cy + rOuter * 0.55);
  c.restore();
}

/** Day 240 — Ability B module stamp flash on HUD slot (Bob). Distinct from form silhouette + lab commit ring. */
function renderAbilityBBeat(c) {
  const fx = juice.abilityBBeatFx;
  if (!fx) return;
  const u = 1 - fx.t / fx.maxT;
  const a = Math.sin((1 - u) * Math.PI) * 0.9;
  const cx = fx.x;
  const cy = fx.y;
  const base = fx.size ?? 44;
  const pulse = 0.7 + u * 0.45;
  const size = base * pulse;
  c.save();
  c.globalAlpha = a;
  c.strokeStyle = fx.stampOuter ?? '#e040fb';
  c.lineWidth = 2.5;
  const r = size * 0.58;
  c.beginPath();
  for (let i = 0; i < 4; i++) {
    const ang = Math.PI / 4 + (i / 4) * Math.PI * 2;
    const px = cx + Math.cos(ang) * r;
    const py = cy + Math.sin(ang) * r;
    if (i === 0) c.moveTo(px, py);
    else c.lineTo(px, py);
  }
  c.closePath();
  c.stroke();
  c.strokeStyle = fx.stampInner ?? '#80ffdb';
  c.lineWidth = 1.5;
  c.beginPath();
  c.arc(cx, cy, size * 0.32, 0, Math.PI * 2);
  c.stroke();
  const mod = (data.abilityModules?.modules ?? []).find((m) => m.id === fx.moduleId);
  drawAbilityIcon(c, mod ?? fx.moduleId, cx, cy, size * 0.72);
  c.restore();
}

/** Overpressure edge warning — throttled pulse, not spammy (Day 046). */
function renderOverpressureVignette(c) {
  if (!juice.overpressureActive) return;
  const a = juice.overpressureAlpha(
    data.map.pressureEffects.overpressureThreshold,
    world.pressure
  );
  if (a <= 0.01) return;
  const grd = c.createRadialGradient(
    ARENA.w / 2, ARENA.h / 2, ARENA.h * 0.35,
    ARENA.w / 2, ARENA.h / 2, ARENA.h * 0.85
  );
  grd.addColorStop(0, 'rgba(230,57,70,0)');
  grd.addColorStop(1, `rgba(230,57,70,${a})`);
  c.fillStyle = grd;
  c.fillRect(0, 0, ARENA.w, ARENA.h);
}

/** Splice commit flash + icon pop into loadout (Day 045). */
function renderSpliceFx(c) {
  const fx = juice.spliceFx;
  if (!fx) return;
  const u = 1 - fx.t / fx.maxT;
  const flash = Math.sin(u * Math.PI) * 0.55;

  c.fillStyle = `rgba(128,255,219,${flash * 0.35})`;
  c.fillRect(0, 0, ARENA.w, ARENA.h);

  const ease = 1 - Math.pow(1 - u, 3);
  const x = fx.x + (fx.tx - fx.x) * ease;
  const y = fx.y + (fx.ty - fx.y) * ease;
  const scale = 48 + ease * 24;

  c.save();
  c.globalAlpha = 0.85 + 0.15 * Math.sin(u * Math.PI);
  drawFragmentIcon(c, fx.result, x, y, scale);
  c.strokeStyle = '#80ffdb';
  c.lineWidth = 2;
  c.beginPath();
  c.arc(x, y, scale * 0.55, 0, Math.PI * 2);
  c.stroke();
  c.restore();

  if (u > 0.55) {
    c.textAlign = 'center';
    c.fillStyle = '#80ffdb';
    c.font = 'bold 22px sans-serif';
    c.fillText(`+ ${fx.result.name}`, ARENA.w / 2, ARENA.h * 0.32);
  }
}

function renderHud(c, fps) {
  const p = world.player;
  const hpFrame = uiSprite('hp_frame');
  const prFrame = uiSprite('pressure_frame');
  const dashFrame = uiSprite('dash_frame');

  // HP bar (top-left) — pixel chrome frame when loaded.
  if (hpFrame) {
    c.imageSmoothingEnabled = false;
    c.drawImage(hpFrame, 16, 16, 220, 18);
  } else {
    c.fillStyle = '#222';
    c.fillRect(16, 16, 220, 18);
    c.strokeStyle = '#000';
    c.strokeRect(16, 16, 220, 18);
  }
  c.fillStyle = p.hp / p.maxHp > 0.3 ? '#52b788' : '#e63946';
  c.fillRect(18, 18, Math.max(0, 216 * (p.hp / p.maxHp)), 14);
  c.fillStyle = '#fff';
  c.font = '12px monospace';
  c.textAlign = 'left';
  c.fillText(`${Math.ceil(p.hp)}/${p.maxHp}`, 22, 29);

  const pr = data.map.pressure;
  const pct = pressureBarPct(data.map, world.pressure);
  const tier = pressureRiskTier(data.map, world.pressure);
  const trackX = 18;
  const trackY = 42;
  const trackW = 216;
  const trackH = 6;
  if (prFrame) {
    c.imageSmoothingEnabled = false;
    c.drawImage(prFrame, 16, 40, 220, 10);
  } else {
    c.fillStyle = '#222';
    c.fillRect(16, 40, 220, 10);
    c.strokeStyle = '#000';
    c.strokeRect(16, 40, 220, 10);
  }
  // Day 225 — banded track so BP reads as a risk dial (Bob palette via PRESSURE_DIAL).
  for (const band of pressureBandSegments(data.map)) {
    const span = pr.max - pr.min;
    const x0 = trackX + trackW * ((band.from - pr.min) / span);
    const x1 = trackX + trackW * ((band.to - pr.min) / span);
    c.fillStyle = band.track;
    c.fillRect(x0, trackY, Math.max(0, x1 - x0), trackH);
  }
  c.fillStyle = tier.fill;
  c.fillRect(trackX, trackY, Math.max(0, trackW * pct), trackH);

  const threshX = trackX + trackW * pressureThresholdPct(data.map);
  c.strokeStyle = PRESSURE_DIAL.thresholdMarker;
  c.lineWidth = 1.5;
  c.beginPath();
  c.moveTo(threshX, 40);
  c.lineTo(threshX, 50);
  c.stroke();

  // Overpressure bar flash (Day 046).
  if (juice.overpressureActive) {
    const flash = juice.barFlashAlpha();
    c.fillStyle = `rgba(230,57,70,${flash})`;
    c.fillRect(trackX, trackY, Math.max(0, trackW * pct), trackH);
  }

  c.fillStyle = '#9ab';
  c.font = '11px monospace';
  c.fillText(`BP ${Math.round(world.pressure)}`, 242, 49);

  if (world.inLab) {
    // Lab HUD: HP/BP + one line. EXIT portal carries the rest.
    c.textAlign = 'center';
    c.font = 'bold 20px sans-serif';
    c.fillStyle = '#fff';
    c.fillText('LAB', ARENA.w / 2, 30);
    c.font = '13px monospace';
    c.fillStyle = '#ffd166';
    c.fillText('take chips  ·  Tab hive  ·  EXIT →', ARENA.w / 2, 50);
  } else {
    const blink = data.abilityModules?.modules?.find((m) => m.id === 'blink')
      ?? data.player.dash;
    if (blink) {
      const cd = Math.max(world.abilityCooldown[0], p.dashCooldown);
      const maxCd = blink.cooldown ?? data.player.dash?.cooldown ?? 1.8;
      const ready = cd <= 0;
      const frac = ready ? 1 : 1 - cd / maxCd;
      const blinkIcon = abilitySprite('blink');
      if (blinkIcon) {
        c.imageSmoothingEnabled = false;
        c.globalAlpha = ready ? 1 : 0.45;
        c.drawImage(blinkIcon, 16, 52, 22, 22);
        c.globalAlpha = 1;
      }
      if (dashFrame) {
        c.imageSmoothingEnabled = false;
        c.drawImage(dashFrame, 42, 56, 90, 7);
      } else {
        c.fillStyle = '#222';
        c.fillRect(42, 56, 90, 7);
        c.strokeStyle = '#000';
        c.strokeRect(42, 56, 90, 7);
      }
      c.fillStyle = ready ? '#80ffdb' : '#557';
      c.fillRect(44, 58, Math.max(0, 86 * frac), 3);
      c.fillStyle = '#9ab';
      c.fillText(ready ? 'BLINK E/⇧' : 'blink…', 138, 63);
    }

    {
      const bId = world.ability?.[1];
      const bCd = world.abilityCooldown?.[1] ?? 0;
      c.fillStyle = '#9ab';
      c.font = '11px monospace';
      if (!bId) {
        c.fillText('B: empty (R)', 16, 88);
      } else {
        const mod = (data.abilityModules?.modules ?? []).find((m) => m.id === bId);
        const maxCd = mod?.cooldown ?? 1;
        const readyB = bCd <= 0;
        const fracB = readyB ? 1 : 1 - bCd / maxCd;
        drawAbilityIcon(c, mod ?? bId, 27, 82, 22);
        c.fillStyle = '#222';
        c.fillRect(42, 78, 90, 7);
        c.fillStyle = readyB ? '#ffd166' : '#557';
        c.fillRect(44, 80, Math.max(0, 86 * fracB), 3);
        c.fillStyle = '#9ab';
        c.fillText(readyB ? `B: ${mod?.name ?? bId} R` : 'B…', 138, 88);
      }
    }

    c.textAlign = 'center';
    c.font = 'bold 20px sans-serif';
    c.fillStyle = '#fff';
    c.fillText(
      `Chamber ${world.node.depth + 1}/${world.map.depth}    ` +
      `Wave ${world.wavesSpawned}/${world.wavesRequired}    Score ${world.score}`,
      ARENA.w / 2, 30
    );
    if (world.roomName) {
      c.font = '13px sans-serif';
      c.fillStyle = '#9ab';
      c.fillText(world.roomName, ARENA.w / 2, 48);
    }
    if (world.patient?.blurb) {
      c.font = '12px sans-serif';
      c.fillStyle = '#80ffdb';
      c.fillText(world.patient.blurb, ARENA.w / 2, 64);
    }

    if (config.debug) {
      c.textAlign = 'right';
      c.font = '12px monospace';
      c.fillStyle = '#7f8c9b';
      const lines = [
        `fps ${fps.toFixed(0)}`,
        `state ${fsm.current}`,
        `seed ${world.seed}`,
        `enemies ${world.enemies.length}  proj ${world.projectiles.length}`,
        `discoveries ${world.crafting.discoveries}`
      ];
      lines.forEach((line, i) => c.fillText(line, ARENA.w - 16, 24 + i * 16));
    }

    renderInventoryBar(c);
  }

  // Transient toast (forge / element messages).
  if (ui.toast) {
    c.textAlign = 'center';
    c.font = 'bold 18px sans-serif';
    c.fillStyle = '#ffd166';
    c.globalAlpha = Math.min(ui.toast.t, 1);
    c.fillText(ui.toast.text, ARENA.w / 2, ARENA.h - 110);
    c.globalAlpha = 1;
  }
}

function renderInventoryBar(c) {
  const slotW = 92;
  const slotH = 58;
  const total = world.inventory.length * (slotW + 8) - 8;
  const x0 = (ARENA.w - total) / 2;
  const y0 = ARENA.h - slotH - 16;

  world.inventory.forEach((el, i) => {
    const x = x0 + i * (slotW + 8);

    // Slot background; highlight the equipped weapon.
    c.fillStyle = 'rgba(255,255,255,0.06)';
    c.fillRect(x, y0, slotW, slotH);
    if (i === world.activeIdx) {
      c.strokeStyle = '#4cc9f0';
      c.lineWidth = 2;
      c.strokeRect(x, y0, slotW, slotH);
    }

    // Key number.
    c.textAlign = 'left';
    c.font = '11px monospace';
    c.fillStyle = '#888';
    c.fillText(String(i + 1), x + 5, y0 + 13);

    if (!el) {
      c.textAlign = 'center';
      c.font = '11px sans-serif';
      c.fillStyle = '#455';
      c.fillText('empty', x + slotW / 2, y0 + slotH / 2 + 4);
      return;
    }

    c.textAlign = 'center';
    c.font = '20px sans-serif';
    c.fillStyle = '#fff';
    drawFragmentIcon(c, el, x + slotW / 2, y0 + 28, 28);

    if (el.crafted) {
      c.textAlign = 'right';
      c.font = 'bold 11px monospace';
      c.fillStyle = '#ffd166';
      c.fillText(`t${el.tier}`, x + slotW - 5, y0 + 14);
    }

    c.textAlign = 'center';
    c.font = '10px sans-serif';
    c.fillStyle = el.crafted ? '#ffd166' : '#ccc';
    const label = el.name.length > 13 ? `${el.name.slice(0, 12)}…` : el.name;
    c.fillText(label, x + slotW / 2, y0 + 50);
  });
}

function renderRouteCards(c, exits) {
  const cardW = 280;
  const cardH = 190;
  const gap = 24;
  const total = exits.length * (cardW + gap) - gap;
  const x0 = (ARENA.w - total) / 2;
  const y0 = ARENA.h * 0.38;
  ui.routeHitboxes = [];

  const displayRows = world.routeDisplay?.length === exits.length
    ? world.routeDisplay
    : exits.map((exit, idx) => ({
      idx,
      exit,
      display: data.map.routes[exit.type],
      realType: exit.type,
      suspicious: false,
      leadsToCore: !!world._nodeById?.get(exit.to)?.isEnd
    }));

  displayRows.forEach((row, i) => {
    const route = row.display;
    const x = x0 + i * (cardW + gap);
    ui.routeHitboxes.push({ idx: i, x, y: y0, w: cardW, h: cardH });

    c.fillStyle = 'rgba(255,255,255,0.05)';
    c.fillRect(x, y0, cardW, cardH);
    c.strokeStyle = route.color;
    c.lineWidth = 2;
    c.strokeRect(x, y0, cardW, cardH);

    c.textAlign = 'center';
    const cx = x + cardW / 2;

    c.fillStyle = route.color;
    c.font = 'bold 20px sans-serif';
    c.fillText(`${i + 1}. ${route.label}`, cx, y0 + 34);

    if (row.suspicious) {
      c.fillStyle = '#ffd166';
      c.font = 'bold 11px monospace';
      c.fillText('? suspicious read', cx, y0 + 52);
    }

    c.fillStyle = '#999';
    c.font = 'italic 13px sans-serif';
    c.fillText(route.blurb, cx, y0 + (row.suspicious ? 68 : 56));

    // Day 169/180 — greed must be readable before commit, with the numbers
    // the sim will actually apply (greed ramps in with destination depth).
    const dest = world._nodeById?.get?.(row.exit.to);
    const skipN = dest ? Math.max(0, dest.depth - world.node.depth - 1) : 0;
    const eff = effectiveRoute(
      data.map, row.realType, dest?.depth ?? world.node.depth + 1
    );
    const realRoute = data.map.routes[row.realType];
    const pick = routePressurePick(data.map, world.pressure, eff.pressureDelta);
    const threatNow = chamberIntensity(data.map, eff.intensity, world.pressure);
    const threatAfter = chamberIntensity(data.map, eff.intensity, pick.afterPressure);
    let yBody = row.suspicious ? 86 : 74;
    if (row.leadsToCore) {
      c.fillStyle = CORE_APPROACH.corePulseColor;
      c.font = 'bold 13px monospace';
      c.fillText(CORE_APPROACH.callout, cx, yBody);
      yBody += 18;
    }
    const ramped = data.map.greedRamp?.routes?.includes(row.realType);
    if (route.cardCallout || skipN > 0) {
      c.fillStyle = route.color;
      c.font = 'bold 12px monospace';
      if (ramped) {
        const call = formatGreedCallout(data.map, row.realType, eff, skipN);
        if (call.line1) {
          c.fillText(call.line1, cx, yBody);
          yBody += 18;
        }
        if (call.line2) {
          c.fillText(call.line2, cx, yBody);
          yBody += 18;
        }
      } else {
        const call = route.cardCallout
          || (skipN > 0 ? `SKIP +${skipN} · x${route.intensity.toFixed(1)} THREAT` : '');
        if (call) {
          c.fillText(call, cx, yBody);
          yBody += 18;
        }
      }
    }
    if (ramped) {
      const rewardLine = formatGreedRewardLine(eff, realRoute);
      if (rewardLine) {
        c.fillStyle = '#ffd166';
        c.font = 'bold 12px monospace';
        c.fillText(rewardLine, cx, yBody);
        yBody += 18;
      }
    }

    c.font = 'bold 13px monospace';
    c.fillStyle = pick.now.fill;
    c.fillText(pick.now.label, cx - 36, yBody);
    c.fillStyle = '#888';
    c.fillText('→', cx, yBody);
    c.fillStyle = pick.after.fill;
    c.fillText(pick.after.label, cx + 36, yBody);
    c.fillStyle = '#ddd';
    c.font = '14px monospace';
    c.fillText(
      `Threat ×${threatNow.toFixed(1)} → ×${threatAfter.toFixed(1)}`,
      cx,
      yBody + 20
    );
    yBody += 20;
    const healLine = formatHealAttritionLine(row.realType, eff, realRoute);
    if (healLine) {
      c.fillStyle = route.color;
      c.font = 'bold 12px monospace';
      c.fillText(healLine, cx, yBody + 4);
      yBody += 18;
    }
    if (skipN > 0 && !ramped) {
      c.fillText(`Skip     +${skipN} chamber${skipN > 1 ? 's' : ''}`, cx, yBody + 4);
      yBody += 20;
    }

    if (!ramped) {
      c.fillStyle = '#ffd166';
      const lines = [];
      if (eff.score) lines.push(`+${eff.score} score`);
      if (realRoute.rewards.elementChance >= 1) lines.push('guaranteed protein');
      else if (realRoute.rewards.elementChance > 0) {
        lines.push(`${Math.round(realRoute.rewards.elementChance * 100)}% protein`);
      }
      const rewardY0 = yBody + 24;
      lines.forEach((line, j) => c.fillText(line, cx, rewardY0 + j * 17));
    }
  });
}

/** Vessel tree — where you are in the patient (Day 017). */
function renderVesselMinimap(c) {
  if (!world?.map) return;
  const box = { x: ARENA.w / 2 - 280, y: 118, w: 560, h: 110 };
  c.fillStyle = 'rgba(8, 12, 20, 0.85)';
  c.fillRect(box.x, box.y, box.w, box.h);
  c.strokeStyle = '#3d5a80';
  c.lineWidth = 2;
  c.strokeRect(box.x, box.y, box.w, box.h);

  const { nodes: pos, meta } = layoutVesselMinimap(world.map, box);
  const trunkEdgeSet = new Set(meta.trunkEdges);
  const byId = new Map(world.map.nodes.map((n) => [n.id, n]));
  const here = world.node?.id;
  const chrome = MINIMAP_READABILITY;

  // Edges — branch lanes dim, trunk spine emphasized (Day 219)
  for (const node of world.map.nodes) {
    const a = pos.get(node.id);
    if (!a) continue;
    for (const exit of node.exits) {
      const b = pos.get(exit.to);
      if (!b) continue;
      const isTrunk = trunkEdgeSet.has(`${node.id}->${exit.to}`);
      const route = data.map.routes[exit.type];
      if (isTrunk) {
        c.strokeStyle = chrome.trunkStroke;
        c.lineWidth = chrome.trunkWidth;
        c.globalAlpha = 1;
      } else {
        c.strokeStyle = route?.color ?? '#556';
        c.lineWidth = exit.type === 'shortcut' ? 3 : 2;
        c.globalAlpha = chrome.branchAlpha;
      }
      if (exit.type === 'shortcut') c.setLineDash([6, 4]);
      else if (exit.type === 'capillary') c.setLineDash(chrome.capillaryDash);
      else if (exit.type === 'rejoin') c.setLineDash(chrome.rejoinDash);
      else c.setLineDash([]);
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(b.x, b.y);
      c.stroke();
      c.setLineDash([]);
      c.globalAlpha = 1;
    }
  }

  // Nodes
  for (const node of world.map.nodes) {
    const p = pos.get(node.id);
    if (!p) continue;
    const isHere = node.id === here;
    const cleared = (world.clearedNodes && world.clearedNodes.has(node.id)) ||
      (node.depth < (world.node?.depth ?? 0));
    const r = isHere ? 7
      : node.isEnd ? chrome.coreNodeRadius
      : node.isPinch ? chrome.pinchNodeRadius
      : node.isCapillary ? 5 : 4;
    c.fillStyle = isHere ? '#ffd166'
      : node.isEnd ? chrome.coreColor
      : node.isPinch ? chrome.pinchColor
      : node.isCapillary ? '#c77dff'
      : p.isOnTrunk ? (cleared ? '#52b788' : '#a8b8c8')
      : cleared ? '#52b788'
      : '#667788';
    c.beginPath();
    c.arc(p.x, p.y, r, 0, Math.PI * 2);
    c.fill();
    if (node.isPinch) {
      c.strokeStyle = chrome.pinchColor;
      c.lineWidth = 2;
      c.beginPath();
      c.arc(p.x, p.y, r + chrome.pinchRingOffset, 0, Math.PI * 2);
      c.stroke();
    }
    if (node.isEnd) {
      const approachCore = world.node?.exits?.some(
        (e) => e.to === node.id
      );
      if (approachCore) {
        const t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
        const pulse = 0.55 + 0.45 * Math.sin(t * 3.2);
        c.strokeStyle = CORE_APPROACH.corePulseColor;
        c.lineWidth = 2.5;
        c.globalAlpha = CORE_APPROACH.corePulseAlpha + 0.35 * pulse;
        c.beginPath();
        c.arc(p.x, p.y, r + chrome.coreRingOffset + 4 + 3 * pulse, 0, Math.PI * 2);
        c.stroke();
        c.globalAlpha = 1;
      }
      c.strokeStyle = chrome.coreColor;
      c.lineWidth = 2;
      c.beginPath();
      c.arc(p.x, p.y, r + chrome.coreRingOffset, 0, Math.PI * 2);
      c.stroke();
    }
    if (isHere) {
      c.strokeStyle = '#80ffdb';
      c.lineWidth = 2;
      c.beginPath();
      c.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
      c.stroke();
    }
  }

  c.textAlign = 'left';
  c.fillStyle = '#889';
  c.font = '11px monospace';
  c.fillText('VESSEL MAP', box.x + 10, box.y + 14);
  c.textAlign = 'right';
  c.fillStyle = '#889';
  c.font = '11px monospace';
  c.fillText(byId.get(here)?.isEnd ? 'CORE' : `D${(world.node?.depth ?? 0) + 1}`,
    box.x + box.w - 10, box.y + 14);
}

/** Human-readable line for one data-driven effect block. */
function describeEffect(e) {
  switch (e.effect) {
    case 'burn': return `${e.icon} Ignites: ${e.dps} dmg/s for ${e.duration}s`;
    case 'chill': return `${e.icon} Chills: ${Math.round(e.slow * 100)}% slower for ${e.duration}s`;
    case 'chain': return `${e.icon} Lightning arcs to ${e.jumps} nearby foes`;
    case 'poison': return `${e.icon} Poisons: ${e.dps} dmg/s for ${e.duration}s`;
    case 'stagger': return `${e.icon} Heavy impact: massive knockback`;
    case 'haste': return `${e.icon} Rapid fire: ${Math.round((1 - e.cooldownMult) * 100)}% faster`;
    case 'split': return `${e.icon} Splits into ${e.splits} fragments on impact`;
    case 'pull': return `${e.icon} Implodes: drags nearby foes together`;
    case 'pierce': return `${e.icon} Pierces through ${e.pierces} foes`;
    default: return e.effect;
  }
}

/** Compact stat line for a forge card (full stats live in the preview). */
function statLine(el) {
  const s = el.stats;
  return `dmg ${s.damage.toFixed(0)} · ${(1 / s.cooldown).toFixed(1)}/s`;
}

/** Draw one forge card; shared by the loadout row and the stock grid. */
function forgeCard(c, entry, x, y, w, h) {
  const el = forgeElement(entry);
  const isA = sameEntry(ui.forgeA, entry);
  const isB = sameEntry(ui.forgeB, entry);
  const isCursor = sameEntry(forgeEntries()[ui.forgeCursor], entry);
  const isStarter = forgeIsStarterSlot(entry);
  const isReplace = entry.kind === 'slot' && entry.idx === ui.forgeReplaceSlot;
  const mismatch = forgeTierMismatch(entry);
  const pendingNeedsSlot = ui.forgeA && ui.forgeB &&
    world.canCraft(ui.forgeA, ui.forgeB).needsSlot;

  forgeHitbox('card', x, y, w, h, { entry });

  let fill = 'rgba(255,255,255,0.05)';
  if (isA || isB) fill = 'rgba(128,255,219,0.14)';
  else if (isReplace && (pendingNeedsSlot || isStarter)) fill = 'rgba(255,209,102,0.10)';
  c.fillStyle = fill;
  c.fillRect(x, y, w, h);

  let stroke = '#334';
  let lw = 1;
  if (isA) { stroke = '#ffd166'; lw = 3; }
  else if (isB) { stroke = '#4cc9f0'; lw = 3; }
  else if (isReplace && (pendingNeedsSlot || isStarter)) { stroke = '#ffd166'; lw = 2; }
  else if (isCursor) { stroke = '#80ffdb'; lw = 2; }
  c.strokeStyle = stroke;
  c.lineWidth = lw;
  c.strokeRect(x, y, w, h);

  if (isA || isB) {
    c.textAlign = 'right';
    c.font = 'bold 12px monospace';
    c.fillStyle = isA ? '#ffd166' : '#4cc9f0';
    c.fillText(isA ? 'A' : 'B', x + w - 6, y + 16);
  } else if (isReplace && (pendingNeedsSlot || !ui.forgeA)) {
    c.textAlign = 'right';
    c.font = 'bold 9px monospace';
    c.fillStyle = '#ffd166';
    c.fillText('replaces', x + w - 4, y + 12);
  }

  c.textAlign = 'center';
  if (!el) {
    c.fillStyle = '#455';
    c.font = '13px sans-serif';
    c.fillText('empty', x + w / 2, y + h / 2 + 4);
    return;
  }

  // Dim: zero stock, starters (not ingredients), or tier mismatch.
  let alpha = 1;
  if (entry.kind === 'stock' && (world.stock[entry.id] ?? 0) <= 0) alpha = 0.3;
  else if (isStarter) alpha = 0.45;
  else if (mismatch) alpha = 0.28;
  c.globalAlpha = alpha;

  c.font = '24px sans-serif';
  c.fillStyle = '#fff';
  drawFragmentIcon(c, el, x + w / 2, y + h * 0.32, 32);

  c.font = '11px sans-serif';
  c.fillStyle = el.crafted ? '#ffd166' : '#dde';
  const label = el.name.length > 14 ? `${el.name.slice(0, 13)}…` : el.name;
  c.fillText(label, x + w / 2, y + h * 0.38 + 18);

  c.font = '10px monospace';
  if (entry.kind === 'slot') {
    if (el.crafted) {
      c.fillStyle = '#ffd166';
      c.fillText(`tier ${el.tier} · ${statLine(el)}`, x + w / 2, y + h - 8);
    } else {
      c.fillStyle = '#778';
      c.fillText('weapon · click to replace', x + w / 2, y + h - 8);
    }
  } else {
    const n = world.stock[entry.id] ?? 0;
    c.fillStyle = n > 0 ? '#80ffdb' : '#566';
    c.fillText(`x${n} stock`, x + w / 2, y + h - 8);
  }

  if (mismatch) {
    c.globalAlpha = 0.9;
    c.fillStyle = '#e63946';
    c.font = 'bold 10px monospace';
    c.fillText(`tier ${el.tier}`, x + w / 2, y + h * 0.55);
  }
  c.globalAlpha = 1;
}

/** Mini ingredient chip inside the recipe tray. */
function drawTrayChip(c, d, x, y, w, h, label) {
  forgeHitbox('tray', x, y, w, h, { side: label });
  const el = forgeElement(d);
  c.fillStyle = el ? 'rgba(128,255,219,0.10)' : 'rgba(255,255,255,0.04)';
  c.fillRect(x, y, w, h);
  c.strokeStyle = el ? (label === 'A' ? '#ffd166' : '#4cc9f0') : '#445';
  c.lineWidth = el ? 2 : 1;
  c.strokeRect(x, y, w, h);

  c.textAlign = 'center';
  if (!el) {
    c.fillStyle = '#667';
    c.font = '12px sans-serif';
    c.fillText(label === 'A' ? 'click an ingredient' : 'then another', x + w / 2, y + h / 2 + 4);
    return;
  }
  c.font = '28px sans-serif';
  c.fillStyle = '#fff';
  drawFragmentIcon(c, el, x + w / 2, y + h * 0.36, 36);
  c.font = '13px sans-serif';
  c.fillStyle = '#dde';
  c.fillText(el.name, x + w / 2, y + h * 0.42 + 20);
  c.font = '11px monospace';
  c.fillStyle = '#889';
  c.fillText(`tier ${el.tier}`, x + w / 2, y + h - 12);
}

function renderForge(c) {
  ui.forgeHitboxes = [];

  c.fillStyle = 'rgba(8, 10, 16, 0.94)';
  c.fillRect(0, 0, ARENA.w, ARENA.h);

  c.textAlign = 'center';
  c.fillStyle = '#80ffdb';
  c.font = 'bold 28px sans-serif';
  c.fillText('NANO-SPLICER', ARENA.w / 2, 40);
  c.fillStyle = '#9ab';
  c.font = '15px sans-serif';
  c.fillText('Fuse two same-tier equipped abilities. New proteins come from Offers after chambers.', ARENA.w / 2, 64);

  const entries = forgeEntries();
  const slotCount = world.inventory.length;
  const check = (ui.forgeA && ui.forgeB)
    ? world.canCraft(ui.forgeA, ui.forgeB)
    : { ok: false, needsSlot: false };

  // --- Row 1: weapons (crafted fuse; starters set replace target) ---
  c.textAlign = 'left';
  c.fillStyle = '#889';
  c.font = 'bold 12px monospace';
  const slotW = 168, slotH = 86, slotGap = 14;
  const slotsX = (ARENA.w - (slotCount * (slotW + slotGap) - slotGap)) / 2;
  c.fillText('WEAPONS  —  fuse two same-tier abilities · click a starter to choose what a new craft replaces',
    slotsX, 88);
  entries.slice(0, slotCount).forEach((entry, i) => {
    const x = slotsX + i * (slotW + slotGap);
    forgeCard(c, entry, x, 96, slotW, slotH);
    c.textAlign = 'left';
    c.font = '11px monospace';
    c.fillStyle = '#889';
    c.fillText(String(i + 1), x + 6, 96 + 15);
  });

  // --- Row 2: ingredient stock ---
  const stockEntries = entries.slice(slotCount);
  const stW = 116, stH = 78, stGap = 10;
  const stX = (ARENA.w - (stockEntries.length * (stW + stGap) - stGap)) / 2;
  c.textAlign = 'left';
  c.fillStyle = '#889';
  c.font = 'bold 12px monospace';
  c.fillText('INGREDIENTS  —  spend stock to craft (these are not weapons)',
    Math.max(stX, 24), 204);
  stockEntries.forEach((entry, i) => {
    forgeCard(c, entry, stX + i * (stW + stGap), 212, stW, stH);
  });

  // --- Recipe tray (the combine story) ---
  const trayY = 310;
  const trayW = 720;
  const trayH = 280;
  const trayX = (ARENA.w - trayW) / 2;
  c.fillStyle = 'rgba(255,255,255,0.035)';
  c.fillRect(trayX, trayY, trayW, trayH);
  c.strokeStyle = check.ok ? '#80ffdb' : '#3a4050';
  c.lineWidth = 2;
  c.strokeRect(trayX, trayY, trayW, trayH);

  c.textAlign = 'left';
  c.fillStyle = '#667';
  c.font = 'bold 11px monospace';
  c.fillText('RECIPE', trayX + 14, trayY + 18);

  const chipW = 160, chipH = 88;
  const chipY = trayY + 32;
  const chipAx = trayX + 40;
  const chipBx = trayX + 250;
  drawTrayChip(c, ui.forgeA, chipAx, chipY, chipW, chipH, 'A');
  c.textAlign = 'center';
  c.fillStyle = '#80ffdb';
  c.font = 'bold 28px sans-serif';
  c.fillText('+', trayX + 225, chipY + chipH / 2 + 8);
  drawTrayChip(c, ui.forgeB, chipBx, chipY, chipW, chipH, 'B');

  c.fillStyle = '#667';
  c.font = 'bold 22px sans-serif';
  c.fillText('→', trayX + 430, chipY + chipH / 2 + 8);

  // Result panel (right side of tray)
  const resX = trayX + 460;
  const resW = 230;
  c.fillStyle = 'rgba(0,0,0,0.25)';
  c.fillRect(resX, chipY, resW, chipH + 100);
  c.strokeStyle = '#445';
  c.lineWidth = 1;
  c.strokeRect(resX, chipY, resW, chipH + 100);

  c.textAlign = 'center';
  const elA = forgeElement(ui.forgeA);
  const elB = forgeElement(ui.forgeB);

  if (!elA || !elB) {
    c.fillStyle = '#667';
    c.font = '13px sans-serif';
    c.fillText(elA ? 'Pick a second ingredient' : 'Result appears here',
      resX + resW / 2, chipY + 55);
  } else if (!check.ok) {
    c.fillStyle = '#e63946';
    c.font = 'bold 13px sans-serif';
    const reason = check.reason || 'Cannot combine';
    // wrap roughly
    const words = reason.split(' ');
    let line = '', ly = chipY + 40;
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (c.measureText(next).width > resW - 16) {
        c.fillText(line, resX + resW / 2, ly);
        line = w;
        ly += 18;
      } else line = next;
    }
    if (line) c.fillText(line, resX + resW / 2, ly);
  } else {
    const preview = world.crafting.preview(elA.id, elB.id);
    const r = preview.result;
    c.fillStyle = r.color ?? '#fff';
    c.font = '22px sans-serif';
    drawFragmentIcon(c, r, resX + resW / 2, chipY + 24, 28);
    c.font = 'bold 14px sans-serif';
    const name = r.name.length > 18 ? `${r.name.slice(0, 17)}…` : r.name;
    c.fillText(name, resX + resW / 2, chipY + 48);
    c.fillStyle = '#889';
    c.font = '11px monospace';
    c.fillText(`tier ${r.tier}${preview.isNew ? ' · NEW' : ''}`, resX + resW / 2, chipY + 66);
    c.fillStyle = '#dde';
    c.font = '12px monospace';
    c.fillText(`dmg ${r.stats.damage.toFixed(0)} · ${(1 / r.stats.cooldown).toFixed(1)}/s`,
      resX + resW / 2, chipY + 88);
    c.font = '11px sans-serif';
    c.fillStyle = '#9fd';
    (r.effects ?? []).slice(0, 3).forEach((e, i) => {
      const desc = describeEffect(e);
      const short = desc.length > 28 ? `${desc.slice(0, 27)}…` : desc;
      c.fillText(short, resX + resW / 2, chipY + 110 + i * 16);
    });
  }

  // Replace hint when needed
  if (check.needsSlot) {
    const slotEl = world.inventory[ui.forgeReplaceSlot];
    c.fillStyle = '#ffd166';
    c.font = '13px sans-serif';
    c.textAlign = 'center';
    const who = slotEl ? `${slotEl.icon} ${slotEl.name}` : 'empty slot';
    c.fillText(`Will replace loadout ${ui.forgeReplaceSlot + 1}: ${who}  (click a weapon to change)`,
      ARENA.w / 2, trayY + trayH - 58);
  }

  // Combine button
  const btnW = 200, btnH = 40;
  const btnX = (ARENA.w - btnW) / 2;
  const btnY = trayY + trayH - 48;
  forgeHitbox('combine', btnX, btnY, btnW, btnH);
  const can = check.ok;
  c.fillStyle = can ? 'rgba(128,255,219,0.22)' : 'rgba(255,255,255,0.05)';
  c.fillRect(btnX, btnY, btnW, btnH);
  c.strokeStyle = can ? '#80ffdb' : '#445';
  c.lineWidth = can ? 2 : 1;
  c.strokeRect(btnX, btnY, btnW, btnH);
  c.textAlign = 'center';
  c.fillStyle = can ? '#80ffdb' : '#556';
  c.font = 'bold 16px sans-serif';
  c.fillText(can ? 'COMBINE' : 'COMBINE', btnX + btnW / 2, btnY + 26);

  renderForgeFooter(c);
}

function renderForgeFooter(c) {
  c.textAlign = 'center';
  c.fillStyle = '#667';
  c.font = '14px sans-serif';
  c.fillText('click to select · Enter / Combine · Q clear · C / Esc close',
    ARENA.w / 2, ARENA.h - 24);
}

function overlay(c, title, subtitle) {
  c.fillStyle = 'rgba(13, 15, 20, 0.7)';
  c.fillRect(0, 0, ARENA.w, ARENA.h);
  c.textAlign = 'center';
  c.fillStyle = '#fff';
  c.font = 'bold 48px sans-serif';
  c.fillText(title, ARENA.w / 2, ARENA.h / 2 - 12);
  c.fillStyle = '#aaa';
  c.font = '18px sans-serif';
  c.fillText(subtitle, ARENA.w / 2, ARENA.h / 2 + 28);
}

/* ------------------------------------------------------------------ *
 * Test hooks + ignition
 * ------------------------------------------------------------------ */

// Stable introspection surface for automated tests (tests/boot.spec.js) and
// for poking around in devtools. Not used by game logic.
window.__game = {
  state: () => fsm.current,
  seed: () => (world ? world.seed : menuSeed),
  shareUrl: () => shareUrlForSeed(
    world ? world.seed : menuSeed,
    typeof location !== 'undefined' ? location.origin : '',
    typeof location !== 'undefined' ? location.pathname : '/'
  ),
  snapshot: () => (world ? world.snapshot() : null),
  profile: () => profile,  // Day 192: expose for web genome persistence testing
  version: '0.1.0',
  juice: () => juice,
  audio: () => audio
};

// Debug-only cheats for fast manual/automated testing of the run flow.
// Stripped from the surface simply by flipping config.debug off.
if (config.debug) {
  window.__game.cheat = {
    clearChamber() {
      if (!world) return;
      world.enemies = [];
      world.wavesSpawned = world.wavesRequired;
    },

    /** Day 241 — force game over for restart smoke tests. */
    die() {
      if (!world) return false;
      world.player.hp = 0;
      world.player.alive = false;
      world.gameOver = true;
      return true;
    },

    /** Forge UI hitboxes from the last render (for click-automation tests). */
    forgeHitboxes() {
      return ui.forgeHitboxes.map((h) => ({ ...h, entry: h.entry ? { ...h.entry } : null }));
    },

    /** Route vessel-card hitboxes from the last render. */
    routeHitboxes() {
      return (ui.routeHitboxes ?? []).map((h) => ({ ...h }));
    },

    /** Simulate a forge click at world coordinates. */
    forgeClick(wx, wy) {
      forgeClick(wx, wy);
    },

    /**
     * Leave Lab / cleared chamber into next node (Day 071+). Skips lingering
     * Offer so headless progression does not softlock waiting for pedestals.
     */
    advance(idx = 0) {
      if (!world) return false;
      if (world.offer) world.skipOffer();
      return world.advance(idx);
    },

    /**
     * Day 072 — walk toward Lab exit until out of Lab; if multi-exit left
     * chamberCleared, auto-pick exit 0 (boot/progression tests).
     */
    walkLabExit(maxSteps = 1800) {
      if (!world || !world.inLab) return 0;
      const dt = 1 / config.simulation.hz;
      let n = 0;
      const cap = Math.min(Math.max(Math.floor(maxSteps), 1), 36000);
      while (world.inLab && n < cap) {
        const z = world.labZones?.exit;
        let move = { x: 1, y: 0 };
        if (z) {
          const dx = z.x - world.player.x;
          const dy = z.y - world.player.y;
          const len = Math.hypot(dx, dy) || 1;
          move = { x: dx / len, y: dy / len };
        }
        world.update(dt, { move });
        n++;
      }
      if (world.chamberCleared) {
        if (world.offer) world.skipOffer();
        world.advance(0);
      }
      if (fsm.current !== 'playing') fsm.change('playing');
      return n;
    },

    /**
     * Fast-forward the game synchronously by n fixed steps — no waiting,
     * no wall clock, perfectly deterministic. 1800 steps = 30 sim-seconds,
     * returned to the caller in however long the CPU needs (~ms).
     */
    step(n = 1) {
      const dt = 1 / config.simulation.hz;
      const count = Math.min(Math.max(Math.floor(n), 1), 36000); // cap: 10 sim-min
      for (let i = 0; i < count; i++) fsm.update(dt);
      return count;
    },

    /** Live-adjust the realtime speed multiplier (clamped 0.1x..100x). */
    setTimeScale(x) {
      loop.timeScale = Math.min(Math.max(Number(x) || 1, 0.1), 100);
      return loop.timeScale;
    },

    setShakeEnabled(on) {
      juice.shakeEnabled = !!on;
      return juice.shakeEnabled;
    },

    /** Day 158 — unlock hive seats (clamped to max). */
    unlockSeats(n) {
      if (!world) return null;
      return world.debugUnlockSeats(n);
    },

    /** Day 158 — grant DNA kit into inventory (optional id list). */
    grantDnaKit(ids) {
      if (!world) return null;
      return world.debugGrantDnaKit(ids);
    },

    /** Day 158 — jump to node id or first node at depth. */
    jumpToNode(opts) {
      if (!world) return null;
      return world.debugJumpToNode(opts ?? {});
    },

    /** Day 158 — spawn named archetype in the current chamber. */
    spawnArchetype(id) {
      if (!world) return null;
      return world.debugSpawnArchetype(id);
    }
  };
}

// Preload art PNGs (circle/emoji fallback if missing).
const fragmentIds = (data.elements?.elements ?? [])
  .map((e) => e.id)
  .filter(Boolean);
const enemyIds = (data.enemies?.archetypes ?? []).map((a) => a.id).filter(Boolean);
const affixIds = (data.enemies?.affixes ?? []).map((a) => a.id).filter(Boolean);
preloadArt({
  fragments: fragmentIds,
  player: 'nanobot',
  enemies: [...enemyIds, 'spawnling'],
  projectiles: ['default', 'heat', 'chill', 'hostile', 'mass', 'flow', 'shock', 'pierce', 'toxic', 'air', 'gravity', 'vitality', 'beam', 'spray', 'rocket'],
  props: [
    'plaque_node', 'vessel_tube', 'membrane_fold',
    'synapse_node', 'axon_filament', 'marrow_crystal', 'ossicle_spike',
    'lab_pedestal', 'lab_demo_pad', 'lab_exit', 'lab_dummy'
  ],
  affixes: affixIds,
  fx: [
    'death_pop', 'pickup_pop', 'status_burn', 'status_poison', 'status_chill',
    'blink', 'shield', 'pull', 'nova'
  ],
  abilities: (data.abilityModules?.modules ?? []).map((m) => m.id).filter(Boolean),
  ui: ['hp_frame', 'pressure_frame', 'dash_frame', 'panel_corner', 'menu_title', 'menu_cta', 'badge_pierce', 'badge_chain', 'badge_knockback', 'frame_dna', 'frame_ability', 'frame_fuse']
});

fsm.change('boot');

const loop = new GameLoop({
  // hz NEVER changes with speedup — GAME_TIME_SCALE just runs more fixed
  // steps per wall-second, so sped-up tests exercise the exact same sim.
  hz: config.simulation.hz,
  maxCatchUpSteps: config.simulation.maxCatchUpSteps,
  update: (dt) => fsm.update(dt),
  render: (alpha, fps) => {
    // Apply the viewport transform: device pixels -> letterboxed arena.
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.fillStyle = '#05060a'; // letterbox bars
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

    ctx.save();
    ctx.translate(view.ox, view.oy);
    ctx.scale(view.scale, view.scale);
    ctx.beginPath();
    ctx.rect(0, 0, ARENA.w, ARENA.h);
    ctx.clip(); // nothing ever draws into the letterbox bars
    fsm.render(ctx, alpha, fps);
    ctx.restore();
  }
});

// Speedup mode for tests/dev: GAME_TIME_SCALE=20 python3 manage.py dev
const envScale = Number(bridge.env?.timeScale);
if (Number.isFinite(envScale) && envScale > 0) {
  loop.timeScale = Math.min(envScale, 100);
}

loop.start();
