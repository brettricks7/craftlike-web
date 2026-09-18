/**
 * world.js — the ENTIRE game simulation, headless and deterministic.
 *
 * THE CONTRACT (this is what makes everything testable):
 *   next state = World.update(fixedDt, actions)
 *
 *   - No canvas, no DOM, no InputManager, no wall clock. The world advances
 *     only when update() is called with a fixed dt and a plain `actions`
 *     object. It runs identically in Electron and in `node --test`.
 *   - No nondeterministic RNG / wall clock anywhere in the sim
 *     (tests/world.test.js literally greps the source to enforce this).
 *   - Same seed + same action sequence => bit-identical snapshots, no matter
 *     the frame rate, window size, or machine. This is also the future
 *     co-op netcode boundary: remote players are just other action streams.
 *
 * Actions consumed each tick (all optional):
 *   {
 *     move:  {x,y}   movement vector (clamped to unit length by caller)
 *     aim:   {x,y}   unit aim vector, or null to keep the previous aim
 *     fire:  bool    trigger held this tick
 *     dash:  bool    dash request (edge) — burst along move dir, brief i-frames
 *     castA: bool    Ability A cast request (edge) — Day 063+
 *     castB: bool    Ability B cast request (edge) — Day 063+
 *     equip: int     loadout slot (0-3) to equip (gated unless weaponSwapEnabled)
 *     craft: [a, b]  combine two ingredient DESCRIPTORS:
 *                      { kind: 'stock', id }   a collected base element unit
 *                      { kind: 'slot',  idx }  an equipped crafted ability
 *     craftSlot: int loadout slot the result should replace (required when
 *                    both ingredients are stock and no slot is free)
 *   }
 *
 * THE CIRCULATORY FLOW (data/map.json):
 *   A run traverses a seeded vessel tree (systems/vesselmap.js). Each node
 *   is a chamber: survive `wavesRequired` waves and kill everything, and the
 *   chamber is cleared — the heart pumps you forward. At junctions the shell
 *   asks the player to pick a vessel and calls advance(exitIdx):
 *     artery  -> pressure UP,   nasty chamber, fat rewards
 *     bypass  -> pressure DOWN, quiet chamber, thin rewards
 *   Pressure scales chamber threat, and sustained overpressure damages the
 *   nanobot directly. Clearing the final chamber stabilizes the patient
 *   (victory = true).
 *
 * UI concerns (toasts, craft-mode selection, pause, route menus) live in
 * game.js; the world reports what happened through its EventBus:
 *   'crafted' {result,isNew} · 'element:gained' {element} · 'wave:start' n
 *   'enemy:killed' {enemy}   · 'player:died'
 *   'chamber:cleared' {node} · 'node:entered' {node, routeType} · 'run:won'
 */
import { Rng } from './core/rng.js';
import { EventBus } from './core/events.js';
import { CraftingSystem } from './systems/crafting.js';
import { canCast, moduleById, moduleCooldown, validateEquip } from './systems/abilities.js';
import {
  abilityOfferPool,
  isOfferApplicable,
  offerCardId,
  offerCardKind,
  rollOfferCards
} from './systems/offers.js';
import { Spawner } from './systems/spawner.js';
import {
  absorbProjectileOnWalls,
  assignNodeRoom,
  findClearSpawn,
  loadChamberWalls,
  resolveSolid,
  segmentClearOfWalls
} from './systems/collision.js';
import { biomeForDepth, biomeRoomName, mergeChamberLook, mergeChamberProps } from './systems/biomes.js';
import {
  buildRouteDisplay,
  chamberIntensity,
  effectiveRoute,
  needsRouteChoice
} from './systems/routes.js';
import { generateVesselMap } from './systems/vesselmap.js';
import { pickPatient, patientRoomPool } from './systems/patients.js';
import { loadNerveRails, playerOnRail, playerRailIndex } from './systems/nerve-rails.js';
import { createHexState, hexSlotLayout, hiveConfig, dnaInventoryRoom, dnaNeedToFillSeats, isHexSeatUnlocked } from './systems/hex.js';
import { almostMatchHexPatterns, hexCombatMods } from './systems/hive-bonuses.js';
import { comboFingerprintKnobs, resolveTagSet } from './systems/combo-fingerprint.js';
import { Player } from './entities/player.js';
import { Enemy } from './entities/enemy.js';
import { Projectile } from './entities/projectile.js';
import { Pickup } from './entities/pickup.js';
import { Entity } from './entities/entity.js';

export const LOADOUT_CAP_DEFAULT = 3; // overridden by data.elements.loadoutCap when present

function loadoutCap(data) {
  return data?.elements?.loadoutCap ?? LOADOUT_CAP_DEFAULT;
}

/**
 * Swept circle test: did a circle of radius r moving P -> Q touch center C?
 * Prevents fast projectiles from tunneling straight through small enemies
 * between two fixed steps (classic discrete-collision gotcha).
 */
function sweptHit(px, py, qx, qy, cx, cy, r) {
  const dx = qx - px;
  const dy = qy - py;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((cx - px) * dx + (cy - py) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const ex = px + t * dx - cx;
  const ey = py + t * dy - cy;
  return ex * ex + ey * ey <= r * r;
}

export class World {
  /**
   * @param {object} data  { elements, abilities, enemies, player } (data/*.json)
   * @param {string} seed  run seed
   * @param {{w,h}}  arena FIXED logical playfield (never the window size —
   *                       gameplay must not depend on the player's monitor)
   */
  constructor(data, seed, arena, opts = {}) {
    this.data = data;
    this.seed = String(seed);
    this.arena = { w: arena.w, h: arena.h };

    this.rng = new Rng(this.seed);
    this.events = new EventBus();
    this.crafting = new CraftingSystem(
      { elements: data.elements, abilities: data.abilities, mutations: data.mutations },
      this.seed
    );
    this.spawner = new Spawner(data.enemies, this.rng.stream('spawns'));

    this.player = new Player(data.player, this.arena.w / 2, this.arena.h / 2);
    // Day 064: Blink module owns dash knobs (Ability A).
    this.abilityModules = new Map(
      (data.abilityModules?.modules ?? []).map((m) => [m.id, m])
    );
    {
      const blink = this.abilityModules.get('blink');
      if (blink && this.player.stats.dash) {
        this.player.stats.dash = {
          speedMult: blink.speedMult,
          duration: blink.duration,
          cooldown: blink.cooldown,
          invuln: blink.invuln
        };
      }
    }
    this.enemies = [];
    this.projectiles = [];
    this.pickups = [];
    this.fx = []; // transient render data (chain arcs, pops); cosmetic
    this.props = []; // cosmetic chamber props (no collision)
    this.routeDisplay = null; // UI-only route card labels (Day 025)

    // Loadout: Phase A — single Attack protocol owns fire (Day 062).
    // Inventory remains for interim Offer/fuse plumbing until Lab lands;
    // equip-to-swap-weapons is gated off the happy path (weaponSwapEnabled).
    this.loadoutCap = loadoutCap(data);
    this.inventory = new Array(this.loadoutCap).fill(null);
    // DNA bag before setAttack — do not null attackProtocol after clone.
    this.dnaInventory = []; // Lab inventory — place onto hive manually
    this.dnaPatterns = data.dnaPatterns ?? null;
    this.hex = createHexState(this.dnaPatterns, data.loadout?.hex);
    {
      const hive = hiveConfig(this.dnaPatterns);
      this.hexUnlockedSeats = hive.startingSeats;
    }
    this.activePatterns = [];
    this._depthToysGranted = new Set();
    this.discoveredPatterns = new Set(); // organic finds this run (Genome shows names)
    const starterId =
      data.player?.loadout?.attackElementId ??
      data.loadout?.defaults?.attackElementId ??
      data.elements.defaultProtocol ??
      data.elements.starting?.[0];
    this.setAttack(this.crafting.get(starterId));
    this.weaponSwapEnabled = false; // multi-weapon swap not the product loop

    // Stock is no longer the primary craft path (Offers are). Kept empty /
    // score-adjacent so old APIs don't explode; mid-run stock crafts are gated.
    this.stock = { ...(data.elements.startingStock ?? {}) };

    // Unlocked fragment pool for this profile (persisted via src/profile.js).
    this.unlockedIds = opts.unlockedIds
      ? [...opts.unlockedIds]
      : [...(data.elements.unlockedStart ?? data.elements.starting)];

    // After a chamber: Offer cards (Day 074 kinds) or legacy fragment ids.
    this.offer = null; // OfferCard[] | null

    // Ability cast plumbing (Day 063+). Runtime effects land Day 064–068.
    this.ability = [null, null]; // module ids or module objects later
    this.abilityCooldown = [0, 0];
    this.castLog = []; // { t, slot: 0|1 } deterministic record for tests
    this.pullFx = null; // Day 067 — { t, radius, force } active vacuoles
    {
      const lo = data.player?.loadout ?? data.loadout?.defaults ?? {};
      this.ability[0] = lo.abilityA ?? 'blink';
      this.ability[1] = lo.abilityB ?? null;
    }

    // Per-run loot palette (route bonus / rare drops → score flavor).
    const bias = this.rng.stream('lootbias');
    const palette = bias.shuffle(this.crafting.dropPool().map((el) => el.id));
    const curve = data.elements.lootBiasCurve ?? [6, 5, 4, 3, 2, 1, 1, 1, 1];
    this.lootWeights = {};
    palette.forEach((id, i) => {
      this.lootWeights[id] = curve[Math.min(i, curve.length - 1)];
    });

    // --- Patient identity (Day 172): one body per seed, not a depth Act ---
    this.patient = pickPatient(data.patients, this.rng.stream('patient'));
    this.patientId = this.patient?.id ?? null;

    // --- Circulatory Flow: the seeded vessel tree for this run ---
    this.map = generateVesselMap(data.map, this.rng.stream('map'));
    this._nodeById = new Map(this.map.nodes.map((n) => [n.id, n]));
    // Chamber templates: one seeded pick per node (rng.stream('rooms')).
    {
      const roomsStream = this.rng.stream('rooms');
      const pool = patientRoomPool(this.patient);
      const curriculum = this.patient?.roomCurriculum ?? null;
      for (const node of this.map.nodes) {
        assignNodeRoom(node, data.rooms, roomsStream, { pool, curriculum });
      }
    }
    this.node = this._nodeById.get(this.map.startId);
    this.syncHexSeatUnlocks();
    this.pressure = data.map.pressure.start;
    this.intensity = 1; // current chamber threat multiplier
    this.wavesRequired = this.node.wavesRequired;
    this.wavesSpawned = 0;
    this.chamberCleared = false;
    this.inLab = false; // Day 071 — Interstitial Lab after clear
    this.labZones = null;
    this.offerHighlight = []; // Day 073 — selected pedestal indices (max 2)
    this.labDummies = []; // Day 076 — demo pad targets
    this.demoFireCooldown = 0;
    this.demoAbilityCooldown = 0; // Day 077 — ability preview sandbox CD
    this.demoPadActive = false;
    this.victory = false;
    this.coreState = null;

    // Chamber geometry for the starting node — then park the bot in clear space.
    this.roomId = null;
    this.walls = [];
    this.suctionFields = [];
    this.nerveRails = [];
    this.nerveTelegraphs = [];
    this._loadChamberGeometry();
    this._placePlayerClear();

    this.wave = 0;      // lifetime wave counter (HUD/flavor)
    this.waveTimer = 0; // first wave spawns on the first tick
    this._waveSize = 0; // how many enemies the last wave spawned (pacing)
    this.score = 0;
    this.kills = 0;
    this.time = 0;
    this.gameOver = false;
  }

  /* ---------------------------------------------------------------- *
   * Tick
   * ---------------------------------------------------------------- */

  /**
   * Advance the simulation by exactly one fixed step.
   * @param {number} dt      fixed step seconds (1/hz — always the same value)
   * @param {object} actions see class docs
   */
  update(dt, actions = {}) {
    if (this.gameOver || this.victory) return;
    this.time += dt;
    const p = this.player;

    // --- Player intent ---
    // Weapon-slot swap is gated (Phase A: Attack owns fire). Equip is a no-op
    // unless weaponSwapEnabled is flipped for debug / legacy tests.
    if (this.weaponSwapEnabled &&
        Number.isInteger(actions.equip) &&
        actions.equip >= 0 && actions.equip < this.loadoutCap &&
        this.inventory[actions.equip]) {
      this.activeIdx = actions.equip;
    }
    if (Array.isArray(actions.craft)) {
      this.craft(actions.craft[0], actions.craft[1],
        Number.isInteger(actions.craftSlot) ? actions.craftSlot : null);
    }
    if (actions.aim && (actions.aim.x !== 0 || actions.aim.y !== 0)) {
      p.aim = { x: actions.aim.x, y: actions.aim.y };
    }

    const wasBlinking = p.dashTimer > 0;
    const move = actions.move ?? { x: 0, y: 0 };
    // Day 064: dash input delegates to Ability A (Blink). castA is the verb.
    if (actions.castA || actions.dash) this.castAbility(0, move);
    if (actions.castB) this.castAbility(1, move);
    p.update(dt, move, this.arena);
    if ((actions.castA || actions.dash) && !wasBlinking && p.dashTimer > 0) {
      this.events.emit('player:dash');
    }
    resolveSolid(p, this.walls, this.arena);
    if (actions.fire) this.fire();

    // Day 072–076: Lab interact, demo pad preview, then exit zone.
    if (this.inLab) {
      if (actions.interact) this.trySelectNearestPedestal();
      this.updateDemoPad(dt);
      this.tryExitLab();
    }

    for (let i = 0; i < this.abilityCooldown.length; i++) {
      if (this.abilityCooldown[i] > 0) {
        this.abilityCooldown[i] = Math.max(0, this.abilityCooldown[i] - dt);
      }
    }
    // Keep Ability A CD mirrored to blink burst CD for HUD.
    if (this.ability[0] === 'blink') {
      this.abilityCooldown[0] = Math.max(this.abilityCooldown[0], p.dashCooldown);
    }

    // Day 067 — sustained pull toward the nanobot.
    if (this.pullFx) {
      this.pullFx.t -= dt;
      const { radius, force } = this.pullFx;
      for (const enemy of this.enemies) {
        if (!enemy.alive) continue;
        const dx = p.x - enemy.x;
        const dy = p.y - enemy.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 1 || dist > radius) continue;
        const step = force * dt / dist;
        enemy.x += dx * step;
        enemy.y += dy * step;
      }
      if (this.pullFx.t <= 0) this.pullFx = null;
    }

    // Day 176/178 — ruptured thin walls suck, but as a BURST, not a life
    // sentence: fields expire, the player can always walk out (pull < walk
    // speed), and enemies get yanked harder and vented at the breach mouth.
    // Blink i-frames still dodge the linger DPS.
    if (!this.inLab && this.suctionFields.length) {
      // Player: only the strongest field in range applies (overlapping
      // breaches must never stack past walk speed).
      let grip = null;
      let gripPull = 0;
      for (const s of this.suctionFields) {
        s.life -= dt;
        if (s.life <= 0) continue;
        const dist = Math.hypot(s.x - p.x, s.y - p.y);
        if (dist > s.radius) continue;
        if (s.force > gripPull) {
          grip = s;
          gripPull = s.force;
        }
      }
      if (grip && p.alive) {
        const dx = grip.x - p.x;
        const dy = grip.y - p.y;
        const dist = Math.hypot(dx, dy);
        if (dist >= 1) {
          const step = grip.force * dt / dist;
          p.x += dx * step;
          p.y += dy * step;
        }
        if ((p.invulnTimer ?? 0) <= 0) {
          p.hp -= grip.dps * dt;
          if (p.hp <= 0) {
            p.hp = 0;
            p.alive = false;
          }
        }
      }
      // Enemies: every field grabs them, harder than the player — and the
      // breach mouth vents anything dragged into it. Rupture is a weapon.
      for (const s of this.suctionFields) {
        if (s.life <= 0) continue;
        const eForce = s.force * (s.enemyForceMult ?? 2.2);
        for (const enemy of this.enemies) {
          if (!enemy.alive || enemy.dying) continue;
          const dx = s.x - enemy.x;
          const dy = s.y - enemy.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 1 || dist > s.radius) continue;
          const step = eForce * dt / dist;
          enemy.x += dx * step;
          enemy.y += dy * step;
          if (dist <= (s.ventRadius ?? 30)) {
            enemy.takeDamage((s.ventDps ?? 60) * dt, { tags: [] });
          }
        }
      }
      // Day 224 — burst end scabs the breach before fields are culled.
      for (const s of this.suctionFields) {
        if (s.life <= 0 && s.wallRef && !s._scabDone) {
          this._scabWall(s.wallRef);
          s._scabDone = true;
        }
      }
      this.suctionFields = this.suctionFields.filter((s) => s.life > 0);
      if (this.suctionFields.length) resolveSolid(p, this.walls, this.arena);
    }

    // Overpressure: run too hot for too long and the patient's own
    // bloodstream starts crushing the nanobot. Bypass a few fights to cool
    // off. (Internal pressure ignores i-frames by design.)
    const pe = this.data.map.pressureEffects;
    if (this.pressure > pe.overpressureThreshold && p.alive) {
      p.hp -= (this.pressure - pe.overpressureThreshold) * pe.overpressureDps * dt;
      if (p.hp <= 0) {
        p.hp = 0;
        p.alive = false;
      }
    }

    // --- Projectiles (walls absorb; friendly vs hostile paths) ---
    for (const proj of this.projectiles) {
      proj.update(dt);
      if (!proj.alive) continue;
      const hitWall = absorbProjectileOnWalls(proj, this.walls);
      if (hitWall) {
        this._damageWall(hitWall, proj.damage ?? 8);
        continue;
      }
      if (proj.hostile) {
        if (p.alive && sweptHit(
          proj.prevX, proj.prevY, proj.x, proj.y,
          p.x, p.y, proj.radius + p.radius
        )) {
          if (p.hit(proj.damage)) this._tryArmNerveTelegraph();
          proj.alive = false;
        }
        continue;
      }
      // Day 076 — preview shots only dent Lab dummies (never real enemies).
      if (proj.preview) {
        for (const d of this.labDummies) {
          if (!d.alive) continue;
          if (sweptHit(proj.prevX, proj.prevY, proj.x, proj.y,
                       d.x, d.y, proj.radius + d.radius)) {
            d.hp -= proj.damage;
            if (d.hp <= 0) d.alive = false;
            proj.alive = false;
            break;
          }
        }
        continue;
      }
      for (const enemy of this.enemies) {
        if (!enemy.alive || enemy.dying || proj.hitIds.has(enemy.id)) continue;
        if (sweptHit(proj.prevX, proj.prevY, proj.x, proj.y,
                     enemy.x, enemy.y, proj.radius + enemy.radius)) {
          this.impact(proj, enemy);
          if (!proj.alive) break;
        }
      }
    }

    // --- Enemies ---
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      enemy.update(dt, p, this.walls, this.arena, resolveSolid);
      if (enemy.dying && !enemy._killed) {
        this.killEnemy(enemy);
        continue;
      }
      if (!enemy.alive) continue;
      // Slide already resolved inside update; keep a final clamp for safety.
      resolveSolid(enemy, this.walls, this.arena);
      // Day 159 / beatability — stuck means slide sideways, never teleport.
      // intended uses speed (not speed*dt): at 60Hz, v*dt is ~1 and never cleared the old >4 gate.
      {
        const moved = Math.hypot(enemy.x - enemy.prevX, enemy.y - enemy.prevY);
        const speedNow = Math.hypot(enemy.vx, enemy.vy);
        if (speedNow > 20 && moved < 0.55) {
          enemy._stuckT = (enemy._stuckT ?? 0) + dt;
          if (enemy._stuckT > 0.08) {
            if (enemy._steerSide == null) {
              enemy._steerSide = (enemy.id.charCodeAt(enemy.id.length - 1) % 2) ? 1 : -1;
            }
            const dx = p.x - enemy.x;
            const dy = p.y - enemy.y;
            const len = Math.hypot(dx, dy) || 1;
            const side = enemy._steerSide;
            const nx = (-dy / len) * side;
            const ny = (dx / len) * side;
            const step = Math.max(speedNow, 100) * dt * 2.2;
            const tryA = { x: enemy.x + nx * step, y: enemy.y + ny * step, radius: enemy.radius };
            resolveSolid(tryA, this.walls, this.arena);
            const dA = Math.hypot(tryA.x - enemy.x, tryA.y - enemy.y);
            if (dA > 0.4) {
              enemy.x = tryA.x;
              enemy.y = tryA.y;
            } else {
              enemy._steerSide = -side;
              const tryB = {
                x: enemy.x + (-nx) * step,
                y: enemy.y + (-ny) * step,
                radius: enemy.radius
              };
              resolveSolid(tryB, this.walls, this.arena);
              if (Math.hypot(tryB.x - enemy.x, tryB.y - enemy.y) > 0.4) {
                enemy.x = tryB.x;
                enemy.y = tryB.y;
              }
            }
          }
        } else {
          enemy._stuckT = 0;
          if (moved >= 0.55) enemy._steerSide = null;
        }
      }
      // Day 177 — restore Day 168's escape hatch (deleted by day 170's edit):
      // a foe whose shot-line stays blocked too long burrows through tissue
      // and re-emerges at a clear spot along its path. Slide (Day 159) is the
      // first resort; this only fires when sliding failed for >2s, so cover
      // still matters moment to moment.
      {
        const gap = Math.hypot(p.x - enemy.x, p.y - enemy.y);
        const pad = Math.max(2, enemy.radius * 0.25);
        const blocked = gap > 70 &&
          !segmentClearOfWalls(enemy.x, enemy.y, p.x, p.y, this.walls, pad);
        if (blocked) {
          enemy._noLosT = (enemy._noLosT ?? 0) + dt;
          if (enemy._noLosT > 2.0) {
            // Prefer a clear point along the path that regains shot-line —
            // never onto the player's toes (turret would soft-win the trade).
            let spot = null;
            const dx = p.x - enemy.x;
            const dy = p.y - enemy.y;
            for (let t = 0.85; t >= 0.35; t -= 0.1) {
              const cand = findClearSpawn(
                enemy.x + dx * t, enemy.y + dy * t,
                enemy.radius, this.walls, this.arena
              );
              if (Math.hypot(p.x - cand.x, p.y - cand.y) < 64) continue;
              if (segmentClearOfWalls(cand.x, cand.y, p.x, p.y, this.walls, pad)) {
                spot = cand;
                break;
              }
            }
            if (!spot) {
              spot = findClearSpawn(
                p.x + ((enemy.id.charCodeAt(0) % 2) ? 72 : -72), p.y,
                enemy.radius, this.walls, this.arena
              );
            }
            this.fx.push({
              kind: 'pop', pop: 'death', x: enemy.x, y: enemy.y,
              t: 0.28, color: enemy.color ?? '#e63946'
            });
            this.fx.push({
              kind: 'pop', pop: 'pickup', x: spot.x, y: spot.y,
              t: 0.22, color: enemy.color ?? '#e63946'
            });
            this.events.emit('enemy:burrow', {
              id: enemy.id, fromX: enemy.x, fromY: enemy.y, toX: spot.x, toY: spot.y
            });
            enemy.x = spot.x;
            enemy.y = spot.y;
            enemy.prevX = spot.x;
            enemy.prevY = spot.y;
            enemy._noLosT = 0;
            enemy._stuckT = 0;
          }
        } else {
          enemy._noLosT = 0;
        }
      }
      if (enemy.pendingShot && enemy.projectile
          && (enemy.pendingShot.delay ?? 0) <= 0) {
        const dir = enemy.pendingShot;
        enemy.pendingShot = null;
        const muzzle = enemy.radius + (enemy.projectile.radius ?? 4);
        this.projectiles.push(Projectile.hostile(
          enemy.x + dir.x * muzzle,
          enemy.y + dir.y * muzzle,
          dir,
          enemy.projectile,
          enemy.id
        ));
      }
      if (Entity.overlaps(enemy, p) && p.hit(enemy.damage)) {
        this._tryArmNerveTelegraph();
      }
    }

    // --- Pickups ---
    for (const pickup of this.pickups) {
      pickup.update(dt);
      const d = Math.hypot(pickup.x - p.x, pickup.y - p.y);
      if (d < p.stats.pickupRadius + pickup.radius) this.collect(pickup);
    }

    this.updateWaves(dt);

    // Day 212 — telegraph countdown + pressure pulse (after fire/hits this tick).
    this._updateNerveTelegraphs(dt);

    // --- Bookkeeping ---
    this.projectiles = this.projectiles.filter((x) => x.alive);
    this.enemies = this.enemies.filter((x) => x.alive || (x.dying && x.dyingT > 0));
    this.pickups = this.pickups.filter((x) => x.alive);
    this.fx = this.fx.filter((f) => (f.t -= dt) > 0);

    if (!p.alive) {
      this.gameOver = true;
      this.events.emit('player:died');
    }
  }

  /* ---------------------------------------------------------------- *
   * Crafting (consumes element stock — forging is a real decision)
   * ---------------------------------------------------------------- */

  /** Resolve an ingredient descriptor to its element, or null if invalid. */
  _ingredient(d) {
    if (!d || typeof d !== 'object') return null;
    if (d.kind === 'stock') {
      const el = this.crafting.get(d.id);
      return el && !el.crafted ? el : null;
    }
    if (d.kind === 'slot' && Number.isInteger(d.idx) &&
        d.idx >= 0 && d.idx < this.loadoutCap) {
      return this.inventory[d.idx];
    }
    return null;
  }

  /**
   * Can these two ingredient descriptors be combined right now?
   * Mid-run stock crafts are gated — base fragments arrive via Offers.
   * Loadout fusion (two crafted abilities) still works between fights.
   */
  canCraft(a, b) {
    const elA = this._ingredient(a);
    const elB = this._ingredient(b);
    if (!elA || !elB) return { ok: false, reason: 'Pick two ingredients' };

    // Offers own base-fragment splicing; stock is not a warehouse anymore.
    if (a.kind === 'stock' || b.kind === 'stock') {
      return { ok: false, reason: 'Splice fragments from an Offer after a chamber' };
    }

    // Only one copy of an equipped ability exists — no self-fusing.
    if (a.kind === 'slot' && b.kind === 'slot' && a.idx === b.idx) {
      return { ok: false, reason: 'Need two different abilities' };
    }

    // Default protocol / base starters in slots aren't fuse fuel.
    for (const [d, el] of [[a, elA], [b, elB]]) {
      if (d.kind === 'slot' && !el.crafted) {
        return { ok: false, reason: `${el.name} is your starter — use Offers to grow` };
      }
    }

    if (elA.tier !== elB.tier) {
      return {
        ok: false,
        reason: `Tiers must match — two tier-${Math.min(elA.tier, elB.tier)}s make a tier-${Math.min(elA.tier, elB.tier) + 1}`
      };
    }

    const known = this.crafting.preview(elA.id, elB.id);
    if (known && !known.isNew &&
        this.inventory.some((el) => el && el.id === known.result.id)) {
      return { ok: true, reason: 'Already spliced — will equip', needsSlot: false };
    }

    const freesSlot = a.kind === 'slot' || b.kind === 'slot';
    const hasFree = this.inventory.some((el) => el === null);
    return { ok: true, needsSlot: !freesSlot && !hasFree };
  }

  /**
   * Commit a craft. `targetSlot` (0-3) is required when canCraft() reports
   * needsSlot — it names the loadout slot the result replaces.
   * Returns true if the craft (or free re-equip) happened.
   */
  craft(a, b, targetSlot = null) {
    const check = this.canCraft(a, b);
    if (!check.ok) return false;

    const elA = this._ingredient(a);
    const elB = this._ingredient(b);

    // Re-forging something already equipped: free re-equip, no cost.
    const pv = this.crafting.preview(elA.id, elB.id);
    const existing = this.inventory.findIndex((el) => el && el.id === pv.result.id);
    if (existing >= 0 && !pv.isNew) {
      this.activeIdx = existing;
      return true;
    }

    if (check.needsSlot &&
        !(Number.isInteger(targetSlot) && targetSlot >= 0 && targetSlot < this.loadoutCap)) {
      return false; // caller must choose what to replace
    }

    const { result, isNew } = this.crafting.craft(elA.id, elB.id);

    // Pay the costs: stock for elements, the ability itself for fusions
    // (fusing destroys the ingredient — evolution, not duplication).
    let slot = null;
    for (const d of [a, b]) {
      if (d.kind === 'stock') {
        this.stock[d.id]--;
      } else {
        this.inventory[d.idx] = null;
        if (slot === null) slot = d.idx; // result takes the first freed slot
      }
    }
    if (slot === null) {
      const free = this.inventory.findIndex((el) => el === null);
      slot = free >= 0 ? free : targetSlot;
    }

    this.inventory[slot] = result;
    this.activeIdx = slot;
    // Phase A: spliced result becomes the Attack protocol (owns fire).
    this.setAttack(result);

    this.events.emit('crafted', { result, isNew, slot });
    return true;
  }

  /* ---------------------------------------------------------------- *
   * Offers (pick 2 fragments → splice → discard the rest)
   * ---------------------------------------------------------------- */

  /** Fragments the Offer table may draw from (unlocked + offerable). */
  offerPool() {
    const out = [];
    for (const id of this.unlockedIds) {
      const el = this.crafting.get(id);
      if (el && el.offerable !== false && !el.crafted) out.push(el);
    }
    // Fallback: any droppable base if unlock list is empty/broken.
    if (out.length === 0) return this.crafting.dropPool();
    return out;
  }

  /**
   * Roll a fresh Offer of N cards with kinds (dna / ability / fuse).
   * Guarantees ≥1 applicable card. Idempotent while an offer is pending.
   */
  rollOffer() {
    if (this.offer) return this.offer;
    const hiveOffers = this.dnaPatterns?.offers ?? {};
    const n = hiveOffers.offerSize ?? 4;
    const stream = this.rng.stream('offers');
    const fragmentIds = this.offerPool().map((el) => el.id);
    const abilityIds = abilityOfferPool(this.data.abilityModules);
    const seated = (this.hex?.slots ?? []).filter(Boolean).length;
    const inv = this.dnaInventory.length;
    const unlock = this.hexUnlockedSeats ?? hiveConfig(this.dnaPatterns).startingSeats;
    const need = dnaNeedToFillSeats(unlock, seated, inv);
    const room = dnaInventoryRoom(unlock, seated, inv, this.dnaPatterns);
    this.offer = rollOfferCards({
      n,
      stream,
      fragmentIds,
      abilityIds,
      world: this,
      pressure: this.pressure,
      pressureCfg: hiveOffers,
      fill: {
        fillUnlockedSeats: hiveOffers.fillUnlockedSeats !== false,
        need,
        room,
        knobs: hiveOffers
      }
    });
    this.events.emit('offer:ready', {
      offer: this.offer.map((c) => ({ ...c }))
    });
    return this.offer;
  }

  /**
   * Splice two DNA/fuse Offer indices into Attack (legacy Lab menu + fuse
   * cards). Prefer taking a single pedestal once Day 075+ wires take.
   */
  acceptOffer(idxA, idxB, targetSlot = null) {
    if (!this.offer || this.offer.length < 2) return false;
    if (!Number.isInteger(idxA) || !Number.isInteger(idxB)) return false;
    if (idxA < 0 || idxA >= this.offer.length || idxB < 0 || idxB >= this.offer.length) {
      return false;
    }
    if (idxA === idxB) return false;

    const cardA = this.offer[idxA];
    const cardB = this.offer[idxB];
    // Fuse card: apply its pair directly when either index is a fuse kind.
    if (offerCardKind(cardA) === 'fuse' || offerCardKind(cardB) === 'fuse') {
      const fuse = offerCardKind(cardA) === 'fuse' ? cardA : cardB;
      return this._applyFuse(fuse.idA, fuse.idB, targetSlot);
    }
    if (offerCardKind(cardA) !== 'dna' || offerCardKind(cardB) !== 'dna') {
      return false;
    }

    const idA = offerCardId(cardA);
    const idB = offerCardId(cardB);
    const a = this.crafting.get(idA);
    const b = this.crafting.get(idB);
    if (!a || !b) return false;
    if (a.tier !== b.tier) return false;
    return this._applyFuse(idA, idB, targetSlot);
  }

  _applyFuse(idA, idB, targetSlot = null) {
    const { result, isNew } = this.crafting.craft(idA, idB);

    let slot = this.inventory.findIndex((el) => el === null);
    if (slot < 0) {
      if (Number.isInteger(targetSlot) && targetSlot >= 0 && targetSlot < this.loadoutCap) {
        slot = targetSlot;
      } else {
        slot = 0;
        let best = Infinity;
        this.inventory.forEach((el, i) => {
          const p = el ? el.stats.damage / el.stats.cooldown : -1;
          if (p < best) { best = p; slot = i; }
        });
      }
    }

    this.inventory[slot] = result;
    this.activeIdx = slot;
    this.offer = null;
    this.offerHighlight = [];
    this.setAttack(result);
    this.events.emit('crafted', { result, isNew, slot, fromOffer: true });
    return true;
  }

  /** Accrue a DNA chip into inventory (no auto-seat — player places on hive). */
  takeDna(idx) {
    if (!this.offer || !Number.isInteger(idx)) return false;
    const card = this.offer[idx];
    if (offerCardKind(card) !== 'dna') return false;
    if (!isOfferApplicable(card, this)) return false;
    const seated = (this.hex?.slots ?? []).filter(Boolean).length;
    const unlock = this.hexUnlockedSeats ?? hiveConfig(this.dnaPatterns).startingSeats;
    if (dnaInventoryRoom(unlock, seated, this.dnaInventory.length, this.dnaPatterns) <= 0) {
      this.events.emit('dna:cap', { id: card.id });
      return false;
    }
    const zone = this.labZones?.pedestals?.[idx];
    this.dnaInventory.push(card.id);
    this.events.emit('lab:commit', {
      kind: 'take', id: card.id, idx,
      x: zone?.x ?? this.player.x, y: zone?.y ?? this.player.y,
      seated: false
    });
    this._removeOfferIndex(idx);
    this.events.emit('dna:accrued', {
      id: card.id,
      dnaInventory: [...this.dnaInventory],
      seated: false,
      slotIdx: null
    });
    return true;
  }

  /**
   * Burn inventory DNA to unlock the next hive seat (slotUnlock.mode=discard).
   * Cost tunable via dna_patterns.slotUnlock.costPerSeat.
   */
  burnDnaForSeat(invIdx = 0) {
    const cfg = hiveConfig(this.dnaPatterns);
    if (cfg.unlockMode !== 'discard') return false;
    if (!Number.isInteger(invIdx) || invIdx < 0 || invIdx >= this.dnaInventory.length) {
      return false;
    }
    if (this.hexUnlockedSeats >= cfg.maxSeats) return false;
    const cost = cfg.costPerSeat;
    if (this.dnaInventory.length < cost) return false;
    // Burn `cost` chips starting at invIdx (wrap-safe: splice cost times from idx)
    const burned = [];
    let idx = invIdx;
    for (let c = 0; c < cost; c++) {
      if (idx >= this.dnaInventory.length) idx = 0;
      burned.push(this.dnaInventory.splice(idx, 1)[0]);
    }
    this.hexUnlockedSeats = Math.min(cfg.maxSeats, this.hexUnlockedSeats + 1);
    this.events.emit('hex:seat-unlock', {
      seats: this.hexUnlockedSeats,
      burned,
      dnaInventory: [...this.dnaInventory]
    });
    return true;
  }

  /**
   * Day 080 — free rearrange of already-owned DNA in the Lab (linear strip
   * stub until Hex UI). Does not consume Offers or add chips.
   * @param {number} fromIdx
   * @param {number} toIdx  insertion index after removal (clamped)
   */
  rearrangeDna(fromIdx, toIdx) {
    if (!this.inLab) return false;
    const n = this.dnaInventory.length;
    if (!Number.isInteger(fromIdx) || !Number.isInteger(toIdx)) return false;
    if (fromIdx < 0 || fromIdx >= n) return false;
    if (fromIdx === toIdx) return true;
    const [chip] = this.dnaInventory.splice(fromIdx, 1);
    let dest = toIdx;
    if (dest > fromIdx) dest -= 1; // account for removal
    dest = Math.max(0, Math.min(dest, this.dnaInventory.length));
    this.dnaInventory.splice(dest, 0, chip);
    this.events.emit('dna:rearrange', {
      fromIdx,
      toIdx: dest,
      dnaInventory: [...this.dnaInventory]
    });
    return true;
  }

  /** Equip an ability module from an Offer pedestal into Ability B. */
  takeAbility(idx) {
    if (!this.offer || !Number.isInteger(idx)) return false;
    const card = this.offer[idx];
    if (offerCardKind(card) !== 'ability') return false;
    if (!isOfferApplicable(card, this)) return false;
    if (!this.setAbility(1, card.id)) return false;
    const zone = this.labZones?.pedestals?.[idx];
    this.events.emit('lab:commit', {
      kind: 'take', id: card.id, idx,
      x: zone?.x ?? this.player.x, y: zone?.y ?? this.player.y
    });
    this._removeOfferIndex(idx);
    this.events.emit('ability:taken', { id: card.id });
    return true;
  }

  /** Apply a fuse pedestal — splices Attack and discards remaining Offers. */
  takeFuse(idx) {
    if (!this.offer || !Number.isInteger(idx)) return false;
    const card = this.offer[idx];
    if (offerCardKind(card) !== 'fuse') return false;
    if (!isOfferApplicable(card, this)) return false;
    const zone = this.labZones?.pedestals?.[idx];
    const ok = this._applyFuse(card.idA, card.idB);
    if (ok) {
      this.events.emit('lab:commit', {
        kind: 'take', id: card.id ?? `${card.idA}+${card.idB}`, idx,
        x: zone?.x ?? this.player.x, y: zone?.y ?? this.player.y
      });
    }
    return ok;
  }

  /** Take whatever kind is on pedestal `idx` (Day 075 accrue path). */
  takeOffer(idx) {
    if (!this.offer || !Number.isInteger(idx)) return false;
    const kind = offerCardKind(this.offer[idx]);
    if (kind === 'dna') return this.takeDna(idx);
    if (kind === 'ability') return this.takeAbility(idx);
    if (kind === 'fuse') return this.takeFuse(idx);
    return false;
  }

  _removeOfferIndex(idx) {
    this.offer.splice(idx, 1);
    this.offerHighlight = this.offerHighlight
      .filter((i) => i !== idx)
      .map((i) => (i > idx ? i - 1 : i));
    if (this.offer.length === 0) this.offer = null;
  }

  /** Discard the pending offer without splicing (no power gain). */
  skipOffer() {
    if (!this.offer) return false;
    this.offer = null;
    this.offerHighlight = [];
    // Day 083: skip is intentionally empty — no lab:commit / reward juice.
    this.events.emit('offer:skipped');
    return true;
  }

  /**
   * Victory meta: unlock up to `count` locked offerable fragments.
   * Shell persists via profile.js; sim only mutates unlockedIds.
   */

  /**
   * Day 102 — depth-band toy unlocks (+1 into pool). Never a progress gate.
   * @returns {string[]} newly unlocked ids this call
   */
  grantDepthToys() {
    const bands = this.data.elements?.depthUnlocks?.bands ?? [];
    const depth = this.node?.depth ?? 0;
    const have = new Set(this.unlockedIds);
    const candidates = [];
    for (const el of this.crafting.elements.values()) {
      if (el.crafted || el.offerable === false || have.has(el.id)) continue;
      if (el.id === 'pulse') continue;
      candidates.push(el.id);
    }
    if (candidates.length === 0) return [];
    const stream = this.rng.stream('depthToys');
    const added = [];
    for (const band of bands) {
      if (depth < (band.minDepth ?? 99)) continue;
      const key = `depthToy:${band.minDepth}`;
      if (this._depthToysGranted?.has(key)) continue;
      if (!this._depthToysGranted) this._depthToysGranted = new Set();
      this._depthToysGranted.add(key);
      const n = Math.min(band.unlockCount ?? 1, candidates.length);
      for (let i = 0; i < n; i++) {
        const pick = stream.pick(candidates.filter((id) => !have.has(id)));
        if (!pick) break;
        this.unlockedIds.push(pick);
        have.add(pick);
        added.push(pick);
      }
    }
    if (added.length) this.events.emit('genome:depth-toy', { depth, added });
    return added;
  }

    grantVictoryUnlocks(count = 2) {
    const have = new Set(this.unlockedIds);
    const candidates = [];
    for (const el of this.crafting.elements.values()) {
      if (el.crafted || el.offerable === false || have.has(el.id)) continue;
      candidates.push(el.id);
    }
    if (candidates.length === 0) return [];
    const stream = this.rng.stream('meta');
    const bag = stream.shuffle([...candidates]);
    const n = Math.min(Math.max(1, count), bag.length);
    const added = bag.slice(0, n);
    for (const id of added) this.unlockedIds.push(id);
    this.events.emit('genome:unlock', { added });
    return added;
  }

  /* ---------------------------------------------------------------- *
   * Combat
   * ---------------------------------------------------------------- */

  /**
   * Set the primary Attack protocol (Phase A fire source).
   * Mirrors into inventory[0] so interim Offer/forge UI keeps working.
   */
  /**
   * Cast Ability A/B. Blink (slot 0) starts the mobility burst.
   * @param {0|1} slot
   * @param {{x,y}} [move]
   */
  /**
   * Equip an ability module into slot A (0) or B (1). Lab/debug path —
   * no mid-fight forge required (Day 069).
   * @param {0|1} slot
   * @param {string|null} moduleId  null clears the slot
   * @returns {boolean}
   */
  setAbility(slot, moduleId) {
    const check = validateEquip(this.abilityModules, slot, moduleId);
    if (!check.ok) return false;
    const prevId = this.ability[slot] ?? null;
    const id = moduleId === '' ? null : moduleId;
    this.ability[slot] = id;
    this.abilityCooldown[slot] = 0;
    this.events.emit('ability:equip', { slot, moduleId: id, prevModuleId: prevId });
    return true;
  }

  castAbility(slot, move = { x: 0, y: 0 }) {
    if (slot !== 0 && slot !== 1) return false;
    const check = canCast(this.ability, this.abilityCooldown, slot, this.abilityModules);
    if (!check.ok) return false;

    const moduleId = this.ability[slot];
    const mod = moduleById(this.abilityModules, moduleId);

    if (moduleId === 'blink' || mod?.archetype === 'mobility') {
      if (!this.player.requestBlink(move)) return false;
      this.abilityCooldown[slot] = moduleCooldown(mod) || this.player.stats.dash.cooldown;
      this.castLog.push({ t: this.time, slot });
      this.events.emit('ability:cast', { slot, moduleId });
      return true;
    }

    if (moduleId === 'shield' || mod?.archetype === 'defense') {
      this.player.activateShield({
        absorb: mod?.absorb ?? 25,
        duration: mod?.duration ?? 1.2
      });
      this.castLog.push({ t: this.time, slot });
      this.events.emit('ability:cast', { slot, moduleId });
      this.events.emit('ability:shield', {
        absorb: this.player.shieldHp,
        duration: this.player.shieldTimer
      });
      this.abilityCooldown[slot] = moduleCooldown(mod);
      return true;
    }

    if (moduleId === 'pull' || mod?.archetype === 'control') {
      this.pullFx = {
        t: mod?.duration ?? 0.45,
        radius: mod?.radius ?? 180,
        force: mod?.force ?? 420
      };
      this.castLog.push({ t: this.time, slot });
      this.events.emit('ability:cast', { slot, moduleId });
      this.events.emit('ability:pull', { ...this.pullFx });
      this.abilityCooldown[slot] = moduleCooldown(mod);
      return true;
    }

    if (moduleId === 'nova' || mod?.archetype === 'burst') {
      const radius = mod?.radius ?? 120;
      const damage = mod?.damage ?? 18;
      const knock = mod?.knockback ?? 220;
      const p = this.player;
      for (const enemy of this.enemies) {
        if (!enemy.alive) continue;
        const dx = enemy.x - p.x;
        const dy = enemy.y - p.y;
        const dist = Math.hypot(dx, dy);
        if (dist > radius) continue;
        const killed = enemy.takeDamage(damage);
        if (dist > 0.1) {
          enemy.knockback(dx / dist, dy / dist, knock);
        }
        this.events.emit('combat:hit', {
          enemy, damage, x: enemy.x, y: enemy.y, killed
        });
        if (killed) {
          // Mirror minimal kill path used elsewhere when needed later.
        }
      }
      this.fx.push({
        kind: 'nova', x: p.x, y: p.y, r: radius, t: 0.25, life: 0.25
      });
      this.castLog.push({ t: this.time, slot });
      this.events.emit('ability:cast', { slot, moduleId });
      this.events.emit('ability:nova', { radius, damage });
      this.abilityCooldown[slot] = moduleCooldown(mod);
      return true;
    }

    this.castLog.push({ t: this.time, slot });
    this.events.emit('ability:cast', { slot, moduleId });
    this.abilityCooldown[slot] = moduleCooldown(mod);
    return true;
  }

  setAttack(el) {
    if (!el) return;
    // Clone so DNA place mods never mutate the protocol reference.
    this.attackProtocol = {
      ...el,
      stats: { ...el.stats },
      tags: [...(el.tags ?? [])]
    };
    this.attack = this.attackProtocol;
    this.inventory[0] = this.attack;
    this.activeIdx = 0;
    if (this.hex?.slots?.some(Boolean)) this._applyHexToAttack();
  }

  /**
   * Place inventory DNA onto the first empty unlocked hive seat.
   * Compat shim for botplay / older tests — prefer placeHexChip.
   */
  placeDna(idx) {
    if (!this.hex?.slots) return false;
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.dnaInventory.length) {
      return false;
    }
    const unlock = this.hexUnlockedSeats ?? hiveConfig(this.dnaPatterns).startingSeats;
    for (let s = 0; s < unlock; s++) {
      if (this.hex.slots[s] == null) return this.placeHexChip(idx, s);
    }
    return false;
  }

  /** Return the first seated hive chip to inventory (compat for clearDnaPlace). */
  clearDnaPlace() {
    if (!this.hex?.slots) return false;
    const idx = this.hex.slots.findIndex(Boolean);
    if (idx < 0) {
      this._applyHexToAttack();
      return true;
    }
    return this.clearHexSlot(idx);
  }

  /**
   * Place bag chip onto hex seat. Chip leaves the bag.
   */
  placeHexChip(invIdx, slotIdx) {
    if (!this.hex?.slots) return false;
    if (!Number.isInteger(invIdx) || invIdx < 0 || invIdx >= this.dnaInventory.length) {
      return false;
    }
    if (!Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx >= this.hex.slots.length) {
      return false;
    }
    if (this.hex.slots[slotIdx] != null) return false; // occupied
    if (!isHexSeatUnlocked(slotIdx, this.hexUnlockedSeats)) return false;
    const [chipId] = this.dnaInventory.splice(invIdx, 1);
    this.hex.slots[slotIdx] = chipId;
    this._applyHexToAttack();
    this.events.emit('hex:place', {
      chipId, slotIdx, slots: [...this.hex.slots], dnaInventory: [...this.dnaInventory]
    });
    this.events.emit('lab:commit', {
      kind: 'seat', chipId, slotIdx,
      x: this.player.x, y: this.player.y,
      secretPulse: !!this._secretPulseActive,
      synergyFind: !!this._synergyFindActive && !this._secretPulseActive,
      patternAlmost: !!this._patternAlmostActive
        && !this._secretPulseActive && !this._synergyFindActive
    });
    return true;
  }

  /** Return a hex seat chip to the DNA bag. */
  clearHexSlot(slotIdx) {
    if (!this.hex?.slots) return false;
    if (!Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx >= this.hex.slots.length) {
      return false;
    }
    const chipId = this.hex.slots[slotIdx];
    if (!chipId) return false;
    this.hex.slots[slotIdx] = null;
    this.dnaInventory.push(chipId);
    this._applyHexToAttack();
    this.events.emit('hex:clear', {
      chipId, slotIdx, slots: [...this.hex.slots], dnaInventory: [...this.dnaInventory]
    });
    return true;
  }

  /** Aggregate all hex chips onto Attack (replaces linear dnaPlaced when hex used). */
  _applyHexToAttack() {
    const proto = this.attackProtocol ?? this.attack;
    if (!proto) return false;
    const getChip = (id) => this.crafting.get(id);
    const chips = (this.hex?.slots ?? []).filter(Boolean)
      .map((id) => getChip(id))
      .filter(Boolean);
    if (chips.length === 0) {
      const emptyTags = [...(proto.tags ?? [])];
      this.attack = {
        ...proto,
        stats: { ...proto.stats },
        tags: emptyTags,
        comboTagSet: resolveTagSet({ tags: emptyTags }),
        comboFingerprint: comboFingerprintKnobs(resolveTagSet({ tags: emptyTags }), this.seed)
      };
      delete this.attack.dnaChipId;
      delete this.attack.dnaChipName;
      delete this.attack.hexChipCount;
      delete this.attack.hexPatterns;
      delete this.attack.hexAdjEdges;
      delete this.attack.hexBonds;
      delete this.attack.hexBonusDamage;
      delete this.attack.shotTag;
      delete this.attack.form;
      delete this.attack.formPellets;
      delete this.attack.formSpread;
      delete this.attack.formPelletDamage;
      delete this.attack.splashRadius;
      delete this.attack.splashFalloff;
      this.inventory[0] = this.attack;
      this.activePatterns = [];
      return true;
    }
    const tags = new Set(proto.tags ?? []);
    let dmgBonus = 0;
    const chipScale = this.dnaPatterns?.balance?.chipDamageScale ?? 0.08;
    for (const chip of chips) {
      for (const t of chip.tags ?? []) tags.add(t);
      dmgBonus += (chip.stats?.damage ?? 0) * chipScale;
    }
    const mods = hexCombatMods(this.hex, this.dnaPatterns, getChip);
    dmgBonus += mods.damage;
    const protoScale = this.dnaPatterns?.balance?.protocolDamageScale ?? 1.0;
    const baseDamage = Number((proto.stats.damage * protoScale).toFixed(2));
    let knockback = proto.stats.knockback ?? 0;
    if (mods.knockbackPct) {
      knockback = Number((knockback * (1 + mods.knockbackPct)).toFixed(1));
    }
    // Day 108 — mixed patterns can grant pierce as a control axis (honest, previewable)
    let effects = [...(proto.effects ?? [])];
    if (mods.pierceChance > 0 && mods.pierceCount > 0) {
      effects = effects.filter((e) => e.effect !== 'pierce');
      effects.push({
        effect: 'pierce',
        pierces: mods.pierceCount,
        chance: mods.pierceChance
      });
    }
    const prevActiveSecret = new Set(
      (this.activePatterns ?? []).filter((p) => p?.secret && p?.id).map((p) => p.id)
    );
    const prevActiveIds = new Set(
      (this.activePatterns ?? []).filter((p) => p?.id).map((p) => p.id)
    );
    this.activePatterns = mods.patterns;
    const hadAlmost = !!this._patternAlmostActive;
    this._secretPulseActive = false;
    this._synergyFindActive = false;
    for (const p of mods.patterns) {
      if (!p?.id) continue;
      this.discoveredPatterns.add(p.id);
      // Day 231 — real secret: true pattern newly active (no payload / no coach copy)
      if (p.secret === true && !prevActiveSecret.has(p.id)) {
        this._secretPulseActive = true;
      } else if (!p.secret && !prevActiveIds.has(p.id)) {
        // Day 235 — clever partial pattern find (non-secret); seat emits once below
        this._synergyFindActive = true;
      }
    }
    const hasFullFind = this._secretPulseActive || this._synergyFindActive;
    this._patternAlmostActive = !hasFullFind && almostMatchHexPatterns(
      this.hex, this.dnaPatterns, (id) => this.crafting.get(id)
    );
    if (this._secretPulseActive) {
      this.events.emit('pattern:secret-discovered', {});
    } else if (this._synergyFindActive) {
      this.events.emit('pattern:synergy-found', {});
    } else if (this._patternAlmostActive && !hadAlmost) {
      this.events.emit('pattern:almost', {});
    }
    const tagList = [...tags];
    const comboTagSet = resolveTagSet({
      tags: tagList,
      hexBonds: mods.bonds ?? {},
      shotTag: mods.shotTag ?? null
    });
    this.attack = {
      ...proto,
      tags: tagList,
      effects,
      stats: {
        ...proto.stats,
        damage: Number((baseDamage + dmgBonus).toFixed(2)),
        knockback
      },
      dnaChipId: chips[0].id,
      dnaChipName: chips[0].name,
      hexChipCount: chips.length,
      hexPatterns: mods.patterns.map((p) => p.id),
      hexAdjEdges: mods.edges,
      hexBonds: mods.bonds ?? {},
      hexBonusDamage: mods.damage,
      shotTag: mods.shotTag ?? null,
      form: mods.form?.id ?? null,
      comboTagSet,
      comboFingerprint: comboFingerprintKnobs(comboTagSet, this.seed)
    };
    if (mods.form?.id) {
      const fs = mods.form.stats ?? {};
      this.attack.stats = {
        ...this.attack.stats,
        speed: fs.speed ?? this.attack.stats.speed,
        radius: fs.radius ?? this.attack.stats.radius,
        range: fs.range ?? this.attack.stats.range,
        cooldown: fs.cooldown ?? this.attack.stats.cooldown,
        knockback: fs.knockback ?? this.attack.stats.knockback
      };
      if (mods.form.id === 'beam' && mods.form.pierce) {
        this.attack.effects = [
          ...this.attack.effects.filter((e) => e.effect !== 'pierce'),
          { effect: 'pierce', pierces: mods.form.pierce ?? 5 }
        ];
      }
      if (mods.form.id === 'spray') {
        this.attack.formPellets = mods.form.pellets ?? 5;
        this.attack.formSpread = mods.form.spread ?? 0.5;
        this.attack.formPelletDamage = mods.form.pelletDamage ?? 0.42;
      } else {
        delete this.attack.formPellets;
        delete this.attack.formSpread;
        delete this.attack.formPelletDamage;
      }
      if (mods.form.id === 'rocket') {
        this.attack.splashRadius = mods.form.splashRadius ?? 70;
        this.attack.splashFalloff = mods.form.splashFalloff ?? 0.45;
      } else {
        delete this.attack.splashRadius;
        delete this.attack.splashFalloff;
      }
      if (mods.form.color) this.attack.color = mods.form.color;
    } else {
      delete this.attack.form;
      delete this.attack.formPellets;
      delete this.attack.formSpread;
      delete this.attack.formPelletDamage;
      delete this.attack.splashRadius;
      delete this.attack.splashFalloff;
    }
    this.inventory[0] = this.attack;
    return true;
  }



  /**
   * Day 098 — equal-tier fuse of two hex seats → one higher-tier chip in bag.
   * Consumes both seats (two → one). Recomputes Attack/patterns.
   */
  fuseHexSlots(slotA, slotB) {
    if (!this.hex?.slots) return false;
    if (!Number.isInteger(slotA) || !Number.isInteger(slotB) || slotA === slotB) return false;
    const idA = this.hex.slots[slotA];
    const idB = this.hex.slots[slotB];
    const a = this.crafting.get(idA);
    const b = this.crafting.get(idB);
    if (!a || !b || a.tier !== b.tier) return false;
    const { result, isNew } = this.crafting.craft(idA, idB);
    this.hex.slots[slotA] = null;
    this.hex.slots[slotB] = null;
    this.dnaInventory.push(result.id);
    this._applyHexToAttack();
    this.events.emit('hex:fuse', {
      slotA, slotB, idA, idB, resultId: result.id, tier: result.tier, isNew,
      dnaInventory: [...this.dnaInventory], slots: [...this.hex.slots]
    });
    return true;
  }

  /** Day 097 — swap two hex seats; recomputes Attack + patterns. */

  swapHexSlots(a, b) {
    if (!this.hex?.slots) return false;
    if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
    if (a < 0 || b < 0 || a >= this.hex.slots.length || b >= this.hex.slots.length) return false;
    if (!isHexSeatUnlocked(a, this.hexUnlockedSeats) || !isHexSeatUnlocked(b, this.hexUnlockedSeats)) {
      return false;
    }
    const tmp = this.hex.slots[a];
    this.hex.slots[a] = this.hex.slots[b];
    this.hex.slots[b] = tmp;
    this._applyHexToAttack();
    this.events.emit('hex:swap', { a, b, slots: [...this.hex.slots], patterns: [...(this.attack?.hexPatterns ?? [])] });
    return true;
  }

  /** Force Attack + pattern recompute from current hex. */
  recomputeHexAttack() {
    return this._applyHexToAttack();
  }

  /** Lab hex seat layout (for UI / click tests). */
  hexLayout(cx = 200, cy = 360) {
    return hexSlotLayout(this.hex, cx, cy);
  }

  /**
   * Day 081 — equal-tier fuse of two owned DNA chips → higher-tier chip in bag.
   * Consumes both indices; result appended. Clears place if either was placed.
   */
  fuseDna(idxA, idxB) {
    if (!Number.isInteger(idxA) || !Number.isInteger(idxB)) return false;
    if (idxA === idxB) return false;
    const idA = this.dnaInventory[idxA];
    const idB = this.dnaInventory[idxB];
    const a = this.crafting.get(idA);
    const b = this.crafting.get(idB);
    if (!a || !b || a.tier !== b.tier) return false;

    const { result, isNew } = this.crafting.craft(idA, idB);
    const hi = Math.max(idxA, idxB);
    const lo = Math.min(idxA, idxB);
    this.dnaInventory.splice(hi, 1);
    this.dnaInventory.splice(lo, 1);
    this.dnaInventory.push(result.id);

    this.events.emit('dna:fuse', {
      idA, idB, resultId: result.id, tier: result.tier, isNew,
      dnaInventory: [...this.dnaInventory]
    });
    this._applyHexToAttack();
    return true;
  }

  fire() {
    const el = this.attack;
    if (!el) return;
    const p = this.player;
    if (p.fireCooldown > 0) return;

    const dir = p.aim;
    const muzzleX = p.x + dir.x * p.radius;
    const muzzleY = p.y + dir.y * p.radius;

    if (el.form === 'spray') {
      const n = Math.max(2, Math.min(9, Number(el.formPellets) || 5));
      const spread = Number(el.formSpread) || 0.5;
      const dmgScale = Number(el.formPelletDamage) || 0.42;
      const base = Math.atan2(dir.y, dir.x);
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0.5 : i / (n - 1);
        const ang = base + (t - 0.5) * spread;
        const d = { x: Math.cos(ang), y: Math.sin(ang) };
        const pellet = {
          ...el,
          stats: {
            ...el.stats,
            damage: Number((el.stats.damage * dmgScale).toFixed(2))
          }
        };
        this.projectiles.push(new Projectile(muzzleX, muzzleY, d, pellet));
      }
    } else {
      this.projectiles.push(new Projectile(muzzleX, muzzleY, dir, el));
    }
    this.events.emit('player:shoot');
    // `+=` keeps the sub-step remainder so the real fire rate matches the
    // cooldown stat instead of being quantized up to whole sim steps.
    // (player.update stops decrementing at <= 0, so the remainder is bounded.)
    p.fireCooldown += el.stats.cooldown;
    this._tryArmNerveTelegraph();
  }

  /** Primary highlighted pedestal for demo preview (last selected). */
  _demoFocusedOfferIndex() {
    if (!this.offer?.length || !this.offerHighlight?.length) return null;
    const idx = this.offerHighlight[this.offerHighlight.length - 1];
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.offer.length) return null;
    return idx;
  }

  /** Clone current Attack element for preview return values. */
  _cloneAttackElement(el) {
    if (!el) return el;
    return {
      ...el,
      stats: { ...el.stats },
      tags: [...(el.tags ?? [])],
      effects: [...(el.effects ?? [])]
    };
  }

  /** Snapshot sim fields that _applyHexToAttack mutates (preview-only). */
  _attackPreviewSnapshot() {
    return {
      slots: [...this.hex.slots],
      attack: this.attack,
      attackProtocol: this.attackProtocol,
      inv0: this.inventory[0],
      activePatterns: [...(this.activePatterns ?? [])],
      discovered: new Set(this.discoveredPatterns),
      secretPulse: this._secretPulseActive,
      synergyFind: this._synergyFindActive,
      patternAlmost: this._patternAlmostActive
    };
  }

  _restoreAttackPreviewSnapshot(snap) {
    this.hex.slots = snap.slots;
    this.attack = snap.attack;
    this.attackProtocol = snap.attackProtocol;
    this.inventory[0] = snap.inv0;
    this.activePatterns = snap.activePatterns;
    this.discoveredPatterns = snap.discovered;
    this._secretPulseActive = snap.secretPulse;
    this._synergyFindActive = snap.synergyFind;
    this._patternAlmostActive = snap.patternAlmost;
  }

  /**
   * Day 244 — Attack after seating highlighted DNA on first empty hive seat.
   * Preview ≡ take+seat path (not legacy two-pedestal craft bait).
   */
  _previewAttackWithSeatedChip(chipId) {
    if (!chipId || !this.hex?.slots) return null;
    const unlock = this.hexUnlockedSeats ?? hiveConfig(this.dnaPatterns).startingSeats;
    let seat = -1;
    for (let s = 0; s < unlock; s++) {
      if (this.hex.slots[s] == null) {
        seat = s;
        break;
      }
    }
    if (seat < 0) return null;

    const snap = this._attackPreviewSnapshot();
    this.hex.slots[seat] = chipId;
    this._applyHexToAttack();
    const preview = this._cloneAttackElement(this.attack);
    this._restoreAttackPreviewSnapshot(snap);
    return preview;
  }

  /**
   * Day 244 — Attack after taking a fuse Offer (new protocol + seated hex mods).
   */
  _previewFuseTakeAttack(idA, idB) {
    const pv = this.crafting.preview(idA, idB);
    if (!pv?.result) return null;

    const snap = this._attackPreviewSnapshot();
    this.attackProtocol = {
      ...pv.result,
      stats: { ...pv.result.stats },
      tags: [...(pv.result.tags ?? [])],
      effects: [...(pv.result.effects ?? [])]
    };
    this._applyHexToAttack();
    const preview = this._cloneAttackElement(this.attack);
    this._restoreAttackPreviewSnapshot(snap);
    return preview;
  }

  /**
   * Day 076 / 244 — Attack element the demo pad fires. Preview ≡ take/seat for
   * the focused Offer (DNA seat sim, fuse take sim); current Attack when idle.
   */
  demoPreviewElement() {
    const idx = this._demoFocusedOfferIndex();
    if (idx == null || !this.offer) return this.attack;

    const card = this.offer[idx];
    const kind = offerCardKind(card);
    if (kind === 'fuse') {
      return this._previewFuseTakeAttack(card.idA, card.idB) ?? this.attack;
    }
    if (kind === 'dna') {
      return this._previewAttackWithSeatedChip(offerCardId(card)) ?? this.attack;
    }
    return this.attack;
  }

  /** True when the nanobot stands on the Lab demo pad. */
  onDemoPad() {
    if (!this.inLab) return false;
    const z = this.labZones?.demoPad;
    if (!z) return false;
    const p = this.player;
    return Math.hypot(p.x - z.x, p.y - z.y) <= (z.r ?? 64) + p.radius;
  }

  /**
   * Day 077 / 244 — Ability preview only when the focused Offer is an ability
   * (matches takeAbility — no cross-highlight bait).
   */
  demoPreviewAbilityId() {
    const idx = this._demoFocusedOfferIndex();
    if (idx == null || !this.offer) return null;
    const card = this.offer[idx];
    if (offerCardKind(card) === 'ability') return offerCardId(card);
    return null;
  }

  /**
   * Preview-cast an ability at Lab dummies without mutating run loadout
   * (ability slots / Attack / DNA stay unchanged).
   */
  previewCastAbility(moduleId) {
    if (!moduleId || moduleId === 'blink') return false;
    const mod = moduleById(this.abilityModules, moduleId);
    if (!mod) return false;
    const p = this.player;

    if (moduleId === 'shield' || mod.archetype === 'defense') {
      // Visual-only absorb flash — do not write player.shieldHp (isolation).
      this.fx.push({
        kind: 'demo-shield', x: p.x, y: p.y, t: 0.4, life: 0.4,
        absorb: mod.absorb ?? 25
      });
      this.events.emit('lab:demo-ability', { moduleId, preview: true });
      return true;
    }

    if (moduleId === 'pull' || mod.archetype === 'control') {
      const radius = mod.radius ?? 180;
      const force = mod.force ?? 420;
      const duration = mod.duration ?? 0.45;
      // One-shot tug on dummies (not sustained pullFx — that would affect enemies).
      for (const d of this.labDummies) {
        if (!d.alive) continue;
        const dx = p.x - d.x;
        const dy = p.y - d.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 1 || dist > radius) continue;
        const step = force * duration / dist;
        d.x += dx * step * 0.05;
        d.y += dy * step * 0.05;
      }
      this.fx.push({ kind: 'demo-pull', x: p.x, y: p.y, r: radius, t: 0.3, life: 0.3 });
      this.events.emit('lab:demo-ability', { moduleId, preview: true });
      return true;
    }

    if (moduleId === 'nova' || mod.archetype === 'burst') {
      const radius = mod.radius ?? 120;
      const damage = mod.damage ?? 18;
      for (const d of this.labDummies) {
        if (!d.alive) continue;
        const dist = Math.hypot(d.x - p.x, d.y - p.y);
        if (dist > radius) continue;
        d.hp -= damage;
        if (d.hp <= 0) d.alive = false;
      }
      this.fx.push({
        kind: 'nova', x: p.x, y: p.y, r: radius, t: 0.25, life: 0.25, preview: true
      });
      this.events.emit('lab:demo-ability', { moduleId, preview: true, radius, damage });
      return true;
    }

    this.events.emit('lab:demo-ability', { moduleId, preview: true });
    return true;
  }

  /**
   * While on the demo pad, auto-fire preview Attack shots and (Day 077)
   * preview Ability casts at Lab dummies. Sandbox cooldowns only — does not
   * touch player fireCooldown, ability[], or abilityCooldown.
   */
  updateDemoPad(dt) {
    if (!this.onDemoPad()) {
      this.demoPadActive = false;
      return;
    }
    this.demoPadActive = true;

    this.demoFireCooldown = Math.max(0, (this.demoFireCooldown ?? 0) - dt);
    if (this.demoFireCooldown <= 0) {
      const el = this.demoPreviewElement();
      if (el?.stats) {
        const p = this.player;
        let tx = p.x + p.aim.x * 100;
        let ty = p.y + p.aim.y * 100;
        let best = Infinity;
        for (const d of this.labDummies) {
          if (!d.alive) continue;
          const dist = Math.hypot(d.x - p.x, d.y - p.y);
          if (dist < best) {
            best = dist;
            tx = d.x;
            ty = d.y;
          }
        }
        const len = Math.hypot(tx - p.x, ty - p.y) || 1;
        const dir = { x: (tx - p.x) / len, y: (ty - p.y) / len };
        p.aim = { ...dir };
        const proj = new Projectile(
          p.x + dir.x * p.radius,
          p.y + dir.y * p.radius,
          dir,
          el
        );
        proj.preview = true;
        this.projectiles.push(proj);
        this.demoFireCooldown = el.stats.cooldown;
        this.events.emit('lab:demo-fire', { id: el.id, preview: true });
      }
    }

    this.demoAbilityCooldown = Math.max(0, (this.demoAbilityCooldown ?? 0) - dt);
    const abId = this.demoPreviewAbilityId();
    if (abId && this.demoAbilityCooldown <= 0) {
      if (this.previewCastAbility(abId)) {
        const mod = moduleById(this.abilityModules, abId);
        this.demoAbilityCooldown = moduleCooldown(mod) || 1.0;
      }
    }
  }

  /** Resolve one projectile hitting one enemy. Effects are data-driven. */
  impact(p, enemy) {
    p.hitIds.add(enemy.id);

    const tags = [
      ...(p.element?.tags ?? []),
      ...(p.element?.shotTag ? [p.element.shotTag] : [])
    ];
    const dealt = enemy.weakTags?.length
      ? p.damage * (tags.some((t) => enemy.weakTags.includes(t))
        ? enemy.weakMult
        : enemy.resistMult)
      : p.damage;
    const killed = enemy.takeDamage(p.damage, { tags });
    this.events.emit('combat:hit', {
      enemy,
      damage: dealt,
      x: enemy.x,
      y: enemy.y,
      killed
    });

    let knockback = p.knockbackForce;
    for (const effect of p.element.effects ?? []) {
      switch (effect.effect) {
        case 'burn':
        case 'poison':
        case 'chill':
          enemy.applyEffect(effect);
          break;

        case 'stagger':
          knockback += effect.knockbackBonus;
          break;

        case 'heal_on_hit': {
          // Day 099 — scarce lifesteal; clamp to maxHp
          const heal = Number(effect.heal ?? 0);
          if (heal > 0) {
            this.player.hp = Math.min(this.player.maxHp, this.player.hp + heal);
          }
          break;
        }

        case 'chain': {
          // Arc to up to `jumps` nearby enemies with falloff damage.
          let from = enemy;
          let dmg = p.damage;
          for (let j = 0; j < effect.jumps; j++) {
            const next = this.nearestEnemy(from.x, from.y, effect.range, p.hitIds);
            if (!next) break;
            dmg *= effect.falloff;
            p.hitIds.add(next.id);
            this.fx.push({
              kind: 'chain',
              x1: from.x, y1: from.y, x2: next.x, y2: next.y,
              t: 0.15, color: effect.color
            });
            if (next.takeDamage(dmg, { tags })) this.killEnemy(next);
            from = next;
          }
          break;
        }

        case 'pull':
          // Drag everything near the impact point toward it (instantaneous
          // displacement per hit — not per frame, so not rate-dependent).
          for (const other of this.enemies) {
            if (!other.alive || other === enemy) continue;
            const dx = enemy.x - other.x;
            const dy = enemy.y - other.y;
            const dist = Math.hypot(dx, dy);
            if (dist > effect.radius || dist < 1) continue;
            const pullDist = Math.min(effect.force * 0.2, dist);
            other.x += (dx / dist) * pullDist;
            other.y += (dy / dist) * pullDist;
            resolveSolid(other, this.walls, this.arena);
          }
          break;

        default:
          break; // pierce/split/haste handled elsewhere
      }
    }

    // Knockback along the projectile's travel direction.
    const vlen = Math.hypot(p.vx, p.vy) || 1;
    enemy.knockback(p.vx / vlen, p.vy / vlen, knockback);
    resolveSolid(enemy, this.walls, this.arena);

    if (killed) this.killEnemy(enemy);

    // Rocket splash — AoE around the impact (once per projectile death path).
    if (
      p.element?.form === 'rocket' &&
      !p._splashDone &&
      (p.pierceLeft <= 0 || killed)
    ) {
      p._splashDone = true;
      const R = Number(p.element.splashRadius) || 70;
      const falloff = Number(p.element.splashFalloff) || 0.45;
      this.fx.push({
        kind: 'pop', pop: 'death', x: enemy.x, y: enemy.y,
        t: 0.28, color: p.element.color ?? '#7ec8e3'
      });
      for (const other of this.enemies) {
        if (!other.alive || other.dying || other === enemy) continue;
        if (p.hitIds.has(other.id)) continue;
        const dist = Math.hypot(other.x - enemy.x, other.y - enemy.y);
        if (dist > R || dist < 0.5) continue;
        const mult = Math.max(falloff, 1 - (dist / R) * (1 - falloff));
        const splashDmg = p.damage * mult;
        p.hitIds.add(other.id);
        if (other.takeDamage(splashDmg, { tags })) this.killEnemy(other);
      }
    }

    // Pierce: pass through up to N enemies before dying.
    if (p.pierceLeft > 0) {
      p.pierceLeft--;
    } else {
      p.alive = false;

      // Split: on death the shot fragments into weaker children (once).
      const split = !p.noSplit && p.element.effects?.find((e) => e.effect === 'split');
      if (split) {
        const combat = this.rng.stream('combat');
        for (let i = 0; i < split.splits; i++) {
          const angle = combat.float(0, Math.PI * 2);
          const dir = { x: Math.cos(angle), y: Math.sin(angle) };
          const child = new Projectile(p.x, p.y, dir, p.element);
          child.damage = p.damage * split.splitDamage;
          child.noSplit = true; // children never split again
          child.hitIds = new Set(p.hitIds);
          this.projectiles.push(child);
        }
      }
    }
  }

  nearestEnemy(x, y, range, excludeIds) {
    let best = null;
    let bestDist = range;
    for (const e of this.enemies) {
      if (!e.alive || excludeIds.has(e.id)) continue;
      const d = Math.hypot(e.x - x, e.y - y);
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    return best;
  }

  killEnemy(enemy) {
    if (enemy._killed) return;
    enemy._killed = true;
    this.score += enemy.xp;
    this.kills++;
    this.events.emit('enemy:killed', { enemy });
    this.fx.push({
      kind: 'pop', pop: 'death', x: enemy.x, y: enemy.y,
      t: 0.32, color: enemy.color ?? '#e63946'
    });

    // Splitting affix: children pop out at the death spot.
    if (enemy.onDeath === 'split' && enemy.spec.childSpec) {
      for (let i = 0; i < enemy.spec.childSpec.count; i++) {
        const childSpec = this.spawner.childOf(
          { ...enemy.spec, x: enemy.x, y: enemy.y }, i
        );
        const spot = findClearSpawn(
          childSpec.x, childSpec.y, childSpec.radius, this.walls, this.arena
        );
        childSpec.x = spot.x;
        childSpec.y = spot.y;
        const child = new Enemy(childSpec);
        child.biomeTint = this.enemyTint;
        this.enemies.push(child);
      }
    }

    // Loot: diamond pickups grant proteins (DNA chips) — score is secondary.
    const s = this.data.enemies.scaling;
    const loot = this.rng.stream('loot');
    const dropChance = s.dropChance + (enemy.affixes.length > 0 ? s.eliteDropBonus : 0);
    if (loot.chance(dropChance)) {
      const el = this.pickLoot(loot);
      if (el) {
        this.pickups.push(new Pickup(enemy.x, enemy.y, {
          kind: 'dna',
          id: el.id,
          element: el,
          score: 8 + Math.floor(enemy.xp * 0.35)
        }));
      } else {
        this.pickups.push(new Pickup(enemy.x, enemy.y, { kind: 'score', value: 15 + enemy.xp }));
      }
    }
  }

  /** Weighted element pick using this run's seeded loot palette. */
  pickLoot(stream) {
    const pool = this.crafting.dropPool();
    if (pool.length === 0) return null;
    let total = 0;
    for (const el of pool) total += this.lootWeights[el.id] ?? 1;
    let r = stream.float(0, total);
    for (const el of pool) {
      r -= this.lootWeights[el.id] ?? 1;
      if (r <= 0) return el;
    }
    return pool[pool.length - 1];
  }

  collect(pickup) {
    pickup.alive = false;
    this.fx.push({
      kind: 'pop', pop: 'pickup', x: pickup.x, y: pickup.y,
      t: 0.22, color: '#ffd166'
    });
    const kind = pickup.payload?.kind;
    if (kind === 'dna' || kind === 'element') {
      const id = pickup.payload.id ?? pickup.payload.element?.id;
      const chip = id ? this.crafting.get(id) : pickup.payload.element;
      const chipId = chip?.id ?? id;
      const unlock = this.hexUnlockedSeats ?? hiveConfig(this.dnaPatterns).startingSeats;
      const seated = (this.hex?.slots ?? []).filter(Boolean).length;
      const room = dnaInventoryRoom(unlock, seated, this.dnaInventory.length, this.dnaPatterns);
      if (chipId && room > 0) {
        this.dnaInventory.push(chipId);
        this.events.emit('dna:gained', { id: chipId, from: 'pickup' });
        this.events.emit('element:gained', { element: chip, isNewType: false, asDna: true });
      } else {
        // Bag full — still pay something so the diamond isn't a dud.
        this.score += pickup.payload.score ?? 20;
        this.events.emit('element:gained', { element: chip, isNewType: false, asScore: true });
      }
      if (pickup.payload.score && room > 0) {
        this.score += pickup.payload.score;
      }
      return;
    }
    this.score += pickup.payload.value ?? 0;
  }

  /**
   * Legacy stock grant — Offers are the discovery path now. Convert to score
   * so old call sites stay safe without rebuilding a warehouse.
   */
  grantElement(el) {
    this.score += 20;
    this.events.emit('element:gained', { element: el, isNewType: false, asScore: true });
  }

  /* ---------------------------------------------------------------- *
   * Chambers & waves (Circulatory Flow)
   * ---------------------------------------------------------------- */

  updateWaves(dt) {
    if (this.inLab || this.chamberCleared) return;
    if (this.node?.isEnd) {
      this._updateCoreEncounter(dt);
      return;
    }
    const s = this.data.enemies.scaling;
    const m = this.data.map;
    const alive = this.enemies.filter((e) => e.alive).length;

    if (this.wavesSpawned < this.wavesRequired) {
      this.waveTimer -= dt;

      // Adaptive pacing: waveInterval is only a CEILING. Once the current
      // wave is mostly dead the next one comes early (after a minimum gap),
      // so strong builds never stand in an empty arena (rule 1).
      const sinceSpawn = s.waveInterval - this.waveTimer;
      const nearlyDead =
        this.wavesSpawned > 0 &&
        alive <= Math.ceil(this._waveSize * (s.waveAdvanceFraction ?? 0)) &&
        sinceSpawn >= (s.minWaveGap ?? 0);

      if ((this.waveTimer <= 0 || nearlyDead) && alive < s.maxAlive) {
        this.wavesSpawned++;
        this.wave++;
        // Difficulty grows with map depth, wave-in-chamber, and intensity.
        const difficultyWave =
          Math.round(this.node.depth * m.depthWaveFactor) + this.wavesSpawned;
        const specs = this.spawner.wave(
          difficultyWave, this.arena, this.intensity, this.walls,
          {
            depth: this.node?.depth ?? 0,
            waveInChamber: this.wavesSpawned,
            patientId: this.patientId
          }
        );
        for (const spec of specs) {
          const e = new Enemy(spec);
          e.biomeTint = this.enemyTint;
          this.enemies.push(e);
        }
        this._waveSize = specs.length;
        this.waveTimer = s.waveInterval;
        this.events.emit('wave:start', this.wave);
      }
    } else if (alive === 0) {
      // All waves down — the chamber is sterilized.
      this.chamberCleared = true;

      // Vacuum any leftover drops; the heart is about to pump the player
      // forward and we never let loot rot on the floor (rule 1).
      for (const pk of this.pickups) {
        if (pk.alive) this.collect(pk);
      }

      this._refreshRouteDisplay();
      this.events.emit('chamber:cleared', { node: this.node });
      // Day 071: walkable Interstitial Lab (Offer pedestals Day 073).
      this.enterLab();
    }
  }

  /**
   * Enter the Interstitial Lab after a chamber clear. Short walkable room —
   * no enemies, Offer still rolled for pedestals (Day 073). Exit → route is
   * Day 072; until then headless callers may still `advance()` from Lab.
   */
  enterLab() {
    if (this.inLab || this.victory || this.gameOver) return false;
    this.syncHexSeatUnlocks();
    const labId = this.data.rooms?.labTemplateId ?? 'lab';
    const tmpl = this.data.rooms?.templates?.[labId];
    if (!tmpl) return false;

    this.inLab = true;
    this.enemies = [];
    this.projectiles = [];
    this.pickups = [];
    this.fx = [];

    const loaded = loadChamberWalls(this.data.rooms, this.arena, {
      roomTemplateId: labId
    });
    this.roomId = loaded.roomId;
    this.walls = loaded.walls;
    this.suctionFields = [];
    this.nerveRails = [];
    this.nerveTelegraphs = [];
    this.roomName = loaded.name ?? 'Interstitial Lab';
    this.roomBlurb = loaded.blurb ?? '';
    this.roomLook = {
      ...(this.data.rooms?.look ?? {}),
      ...(loaded.look ?? {})
    };
    this.labZones = loaded.zones;
    this.enemyTint = null;
    this.demoFireCooldown = 0;
    this.demoAbilityCooldown = 0;
    this.demoPadActive = false;
    // Dummy targets around the demo pad (cosmetic + preview hits).
    const pad = this.labZones?.demoPad ?? { x: 640, y: 420 };
    this.labDummies = [
      { id: 'dummy0', x: pad.x - 90, y: pad.y - 70, radius: 16, hp: 40, maxHp: 40, alive: true },
      { id: 'dummy1', x: pad.x + 90, y: pad.y - 70, radius: 16, hp: 40, maxHp: 40, alive: true }
    ];
    this.props = [
      ...(loaded.props ?? []).map((p) => ({ ...p })),
      ...this.labDummies.map((d) => ({ id: 'lab_dummy', x: d.x, y: d.y, size: 36 }))
    ];
    this._placePlayerClear();

    if (!this.offer) this.rollOffer();
    this.offerHighlight = [];
    this.grantDepthToys();
    this.events.emit('lab:entered', {
      roomId: this.roomId,
      zones: this.labZones,
      offer: this.offer ? this.offer.map((c) => ({ ...c })) : null
    });
    return true;
  }

  /**
   * Day 073–074 — pedestals mirror Offer cards (kind + id + applicable).
   */
  labPedestals() {
    if (!this.inLab || !this.offer || !this.labZones?.pedestals) return [];
    return this.labZones.pedestals.map((z, idx) => {
      const card = this.offer[idx] ?? null;
      return {
        idx,
        kind: offerCardKind(card),
        id: offerCardId(card),
        card: card && typeof card === 'object' ? { ...card } : card,
        applicable: card ? isOfferApplicable(
          typeof card === 'string' ? { kind: 'dna', id: card } : card,
          this
        ) : false,
        x: z.x,
        y: z.y,
        r: z.r ?? 48,
        selected: this.offerHighlight.includes(idx)
      };
    });
  }

  /** Toggle highlight on a pedestal (max two selections for fuse pairing). */
  selectPedestal(idx) {
    if (!this.inLab || !this.offer) return false;
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.offer.length) return false;
    const at = this.offerHighlight.indexOf(idx);
    if (at >= 0) {
      this.offerHighlight.splice(at, 1);
    } else if (this.offerHighlight.length < 2) {
      this.offerHighlight.push(idx);
    } else {
      this.offerHighlight[1] = idx;
    }
    this.events.emit('lab:pedestal', {
      idx,
      selected: [...this.offerHighlight],
      offer: this.offer.map((c) => (typeof c === 'object' ? { ...c } : c))
    });
    return true;
  }

  /** Interact: take nearest pedestal (Day 075 accrue). */
  trySelectNearestPedestal() {
    const pedestals = this.labPedestals();
    if (pedestals.length === 0) return false;
    const p = this.player;
    let best = null;
    let bestD = Infinity;
    for (const ped of pedestals) {
      if (!ped.id) continue;
      const d = Math.hypot(ped.x - p.x, ped.y - p.y);
      if (d < ped.r + p.radius && d < bestD) {
        bestD = d;
        best = ped;
      }
    }
    if (!best) return false;
    // Highlight first for UI feedback, then take (accrue).
    this.selectPedestal(best.idx);
    return this.takeOffer(best.idx);
  }

  /**
   * Day 072–075 — Lab exit discards unused Offers (greed honesty).
   * @returns {'none'|'advanced'|'route'}
   */
  tryExitLab() {
    if (!this.inLab) return 'none';
    const zone = this.labZones?.exit;
    if (!zone) return 'none';
    const p = this.player;
    const reach = (zone.r ?? 40) + (p.radius ?? 12);
    if (Math.hypot(p.x - zone.x, p.y - zone.y) > reach) return 'none';
    return this.confirmExitLab();
  }

  /**
   * Day 110 — leave Lab immediately (skip leftover Offers). Experienced
   * players use KeyF; walking the exit zone still calls the same path.
   * @returns {'none'|'advanced'|'route'}
   */
  confirmExitLab() {
    if (!this.inLab) return 'none';
    const discarded = this.offer ? this.offer.length : 0;
    if (this.offer) this.skipOffer();
    this.inLab = false;
    this.labZones = null;
    this.labDummies = [];
    this.demoPadActive = false;
    this.events.emit('lab:exited', { node: this.node, discarded, fast: true });

    if (!needsRouteChoice(this.node, this._nodeById)) {
      this.advance(0);
      return 'advanced';
    }
    return 'route';
  }

  /**
   * Infection Core finale (Day 018): distinct encounter script — boss +
   * HP-threshold add phases. Victory only after Core is dead and adds clear.
   */
  _updateCoreEncounter(dt) {
    if (!this.coreState) {
      this.coreState = {
        spawned: false,
        coreDead: false,
        phasesFired: {},
        pendingPhases: [],
        maxHp: 0
      };
    }
    const st = this.coreState;
    const cfg = this.data.enemies.coreEncounter || {};

    if (st.pendingPhases?.length) {
      for (let i = st.pendingPhases.length - 1; i >= 0; i--) {
        const pending = st.pendingPhases[i];
        pending.delay -= dt;
        if (pending.delay > 0) continue;
        const phase = pending.phase;
        const ids = phase.archetypes || [];
        const n = phase.count ?? ids.length;
        for (let j = 0; j < n; j++) {
          const aid = ids[j % ids.length];
          const e = new Enemy(this.spawner.named(aid, this.arena, this.walls, this.intensity));
          e.biomeTint = this.enemyTint;
          this.enemies.push(e);
        }
        st.pendingPhases.splice(i, 1);
      }
    }

    if (!st.spawned) {
      const bossSpec = this.spawner.coreBoss(this.arena, this.walls);
      const boss = new Enemy(bossSpec);
      boss.biomeTint = this.enemyTint;
      this.enemies.push(boss);
      st.maxHp = boss.maxHp;
      for (const id of (cfg.guardArchetypes || ['spitter']).slice(0, 2)) {
        const g = new Enemy(this.spawner.named(id, this.arena, this.walls, this.intensity));
        g.biomeTint = this.enemyTint;
        this.enemies.push(g);
      }
      st.spawned = true;
      this.wavesSpawned = 1;
      this.wave = Math.max(this.wave, 1);
      this.wavesRequired = 1; // scripted; not wave-count gated
      this.events.emit('wave:start', this.wave);
      this.events.emit('core:spawned', { id: boss.id });
      return;
    }

    const core = this.enemies.find((e) => e.alive && e.isBoss);
    if (!core) {
      st.coreDead = true;
    } else {
      const frac = core.hp / (st.maxHp || core.maxHp || 1);
      const phases = cfg.phaseAdds || {};
      for (const [key, phase] of Object.entries(phases)) {
        if (st.phasesFired[key]) continue;
        if (frac <= (phase.hpFrac ?? 0)) {
          st.phasesFired[key] = true;
          const telegraphSec = cfg.phaseTelegraphSec ?? 0.75;
          if (!st.pendingPhases) st.pendingPhases = [];
          st.pendingPhases.push({ phase, delay: telegraphSec });
          this.events.emit('core:phase', {
            phase: Number(key),
            hpFrac: frac,
            telegraphSec,
            count: phase.count ?? (phase.archetypes || []).length
          });
        }
      }
    }

    const alive = this.enemies.filter((e) => e.alive).length;
    if (st.coreDead && alive === 0) {
      this.chamberCleared = true;
      for (const pk of this.pickups) {
        if (pk.alive) this.collect(pk);
      }
      this.victory = true;
      const unlocked = this.grantVictoryUnlocks(2);
      this.events.emit('run:won', { unlocked });
    }
  }

  /** Clamp unlocked seats to config (boot / chamber enter). */
  syncHexSeatUnlocks() {
    const cfg = hiveConfig(this.dnaPatterns);
    this.hexUnlockedSeats = Math.min(
      cfg.maxSeats,
      Math.max(this.hexUnlockedSeats ?? cfg.startingSeats, cfg.startingSeats)
    );
    return this.hexUnlockedSeats;
  }

  /** @deprecated alias — seats are the unlock authority */
  syncHexRingUnlocks() {
    return this.syncHexSeatUnlocks();
  }

  // --- Debug / late-run kit (Day 158) — call from cheats or headless tests ---

  /** Unlock hive seats to `n` (clamped). Returns new seat count. */
  debugUnlockSeats(n) {
    const cfg = hiveConfig(this.dnaPatterns);
    const target = Math.min(cfg.maxSeats, Math.max(0, Math.floor(Number(n) || 0)));
    this.hexUnlockedSeats = target;
    return this.hexUnlockedSeats;
  }

  /**
   * Push DNA chip ids into inventory (bypasses soft cap). Default kit = first
   * few offerable elements. Returns inventory after grant.
   */
  debugGrantDnaKit(ids) {
    const list = Array.isArray(ids) && ids.length
      ? ids.map(String)
      : (this.data.elements?.elements ?? [])
        .filter((e) => e.id && e.id !== 'pulse' && e.offerable !== false)
        .slice(0, 8)
        .map((e) => e.id);
    const known = new Set((this.data.elements?.elements ?? []).map((e) => e.id));
    for (const id of list) {
      if (!known.has(id)) continue;
      this.dnaInventory.push(id);
    }
    return [...this.dnaInventory];
  }

  /**
   * Jump to a vessel node by id, or the first node at `depth`. Resets chamber
   * combat state (no route rewards). Returns node id or null.
   */
  debugJumpToNode({ nodeId = null, depth = null } = {}) {
    let node = null;
    if (nodeId != null) node = this._nodeById.get(String(nodeId)) ?? null;
    else if (depth != null) {
      const d = Math.floor(Number(depth));
      node = this.map.nodes.find((n) => n.depth === d) ?? null;
    }
    if (!node) return null;

    this.node = node;
    this.syncHexSeatUnlocks();
    this.wavesRequired = this.node.wavesRequired;
    this.wavesSpawned = 0;
    this.waveTimer = 0;
    this._waveSize = 0;
    this.chamberCleared = false;
    this.inLab = false;
    this.labZones = null;
    this.labDummies = [];
    this.demoPadActive = false;
    this.offerHighlight = [];
    this.offer = null;
    this.coreState = null;
    this.victory = false;
    this.gameOver = false;
    this.enemies = [];
    this.projectiles = [];
    this.pickups = [];
    this.fx = [];
    this.routeDisplay = null;
    this._loadChamberGeometry();
    this._placePlayerClear();
    this.player.invulnTimer = 1.0;
    this.events.emit('node:entered', { node: this.node, routeType: 'debug' });
    return this.node.id;
  }

  /** Spawn a named archetype (no affixes) at a clear edge point. */
  debugSpawnArchetype(archetypeId) {
    const id = String(archetypeId || '');
    if (!id) return null;
    const arch = this.data.enemies?.archetypes?.find((a) => a.id === id);
    if (!arch) return null;
    const spec = this.spawner.named(id, this.arena, this.walls, this.intensity);
    const e = new Enemy(spec);
    e.biomeTint = this.enemyTint;
    this.enemies.push(e);
    return e.id;
  }

  /**
   * Travel through exit `exitIdx` of the cleared chamber: apply the vessel's
   * pressure delta and rewards, then set up the next chamber. Returns false
   * for invalid requests (not cleared yet, bad index, run already over).
   */
  advance(exitIdx) {
    if (!this.chamberCleared || this.victory || this.gameOver) return false;
    const exit = this.node.exits[exitIdx];
    if (!exit) return false;

    const m = this.data.map;
    const route = m.routes[exit.type];
    // Day 180 — greed routes scale in with destination depth (shared helper
    // keeps the card UI and the sim on the same numbers).
    const destDepth = this._nodeById.get(exit.to)?.depth ?? this.node.depth + 1;
    const eff = effectiveRoute(m, exit.type, destDepth);

    // --- Pressure shifts the moment you commit to the vessel ---
    this.pressure = Math.min(
      Math.max(this.pressure + eff.pressureDelta, m.pressure.min),
      m.pressure.max
    );

    // --- Rewards for the route you dared to take ---
    this.score += eff.score;
    const healAmount = route.rewards.heal ?? 0;
    if (healAmount > 0) {
      this.player.hp = Math.min(this.player.hp + healAmount, this.player.maxHp);
    }
    const loot = this.rng.stream('loot');
    if ((route.rewards.elementChance ?? 0) > 0 && loot.chance(route.rewards.elementChance)) {
      // Route "element" bonus is score/heal flavor until meta unlocks land.
      this.score += 40;
    }

    // --- Enter the next chamber ---
    this.node = this._nodeById.get(exit.to);
    this.syncHexSeatUnlocks();
    this.intensity = chamberIntensity(m, eff.intensity, this.pressure);
    this.wavesRequired = this.node.wavesRequired;
    this.wavesSpawned = 0;
    this.waveTimer = 0;
    this._waveSize = 0;
    this.chamberCleared = false;
    this.inLab = false;
    this.labZones = null;
    this.labDummies = [];
    this.demoPadActive = false;
    this.offerHighlight = [];
    this.offer = null;
    this.coreState = null;

    // Fresh battlefield: recenter the bot with a moment of entry grace.
    this.enemies = [];
    this.projectiles = [];
    this.pickups = [];
    this.fx = [];
    this.routeDisplay = null;
    const p = this.player;
    p.x = this.arena.w / 2;
    p.y = this.arena.h / 2;
    p.prevX = p.x;
    p.prevY = p.y;
    p.invulnTimer = 1.0;

    this._loadChamberGeometry();
    this._placePlayerClear();

    const destIsCore = !!this.node?.isEnd;
    if (healAmount > 0) {
      this.events.emit('route:healed', {
        amount: healAmount,
        routeType: exit.type,
        leadsToCore: destIsCore
      });
    }
    this.events.emit('node:entered', {
      node: this.node,
      routeType: exit.type,
      heal: healAmount,
      leadsToCore: destIsCore
    });
    return true;
  }

  /** Park the player in wall-free space (preferred: arena center). */
  _placePlayerClear() {
    const p = this.player;
    const spot = findClearSpawn(
      this.arena.w / 2, this.arena.h / 2, p.radius, this.walls, this.arena
    );
    p.x = spot.x;
    p.y = spot.y;
    p.prevX = p.x;
    p.prevY = p.y;
  }

  /** Load walls + biome presentation for the current chamber. */
  _loadChamberGeometry() {
    const loaded = loadChamberWalls(this.data.rooms, this.arena, this.node);
    const biome = biomeForDepth(this.data.biomes, this.node?.depth ?? 0);
    this.biomeId = biome?.id ?? null;
    this.biome = biome;
    this.roomId = loaded.roomId;
    const labId = this.data.rooms?.labTemplateId ?? 'lab';
    const destructible = !!(this.patient?.wallHp) && loaded.roomId !== labId;
    this.walls = loaded.walls.map((w) => {
      const wall = { x: w.x, y: w.y, w: w.w, h: w.h, ruptured: false };
      if (destructible) {
        wall.hp = this.patient.wallHp;
        wall.maxHp = this.patient.wallHp;
      }
      return wall;
    });
    this.suctionFields = [];
    this.nerveRails = loadNerveRails(this.patient, loaded.roomId);
    this.nerveTelegraphs = [];
    const chamber = biomeRoomName(biome, loaded.name, loaded.roomId);
    this.roomName = this.patient?.name ? `${this.patient.name} · ${chamber}` : chamber;
    this.roomLook = mergeChamberLook(biome, loaded.look);
    if (this.patient?.look) this.roomLook = { ...this.roomLook, ...this.patient.look };
    this.roomBlurb = loaded.blurb ?? '';
    this.props = mergeChamberProps(biome, loaded.props ?? []);
    if (this.patient?.props?.length) {
      for (const p of this.patient.props) this.props.push({ ...p });
    }
    this.enemyTint = biome?.enemyTint ?? null;
    this.biomeBg = this.patient?.bg ?? biome?.bg ?? null;
    this.biomeGrid = this.patient?.grid ?? biome?.grid ?? null;
  }

  /** Day 212 — fire/hit on a nerve rail arms a readable telegraph. */
  _tryArmNerveTelegraph() {
    if (this.inLab || !this.nerveRails.length || !this.player.alive) return;
    const idx = playerRailIndex(this.player, this.nerveRails);
    if (idx < 0) return;
    const maxDelay = this.patient?.nerveRails?.telegraphDelay ?? 0.75;
    let telegraph = this.nerveTelegraphs.find((t) => t.railId === idx);
    if (telegraph) {
      telegraph.delay = maxDelay;
      telegraph.maxDelay = maxDelay;
    } else {
      telegraph = { railId: idx, delay: maxDelay, maxDelay };
      this.nerveTelegraphs.push(telegraph);
    }
    const rail = this.nerveRails[idx];
    this.events.emit('nerve:telegraph', {
      railId: idx,
      x: rail.x + rail.w / 2,
      y: rail.y + rail.h / 2,
      w: rail.w,
      h: rail.h
    });
  }

  /** Day 212 — countdown telegraphs; pressure pulse only if still on that rail. */
  _updateNerveTelegraphs(dt) {
    if (this.inLab || !this.nerveTelegraphs.length) return;
    const p = this.player;
    const damage = this.patient?.nerveRails?.pulseDamage ?? 22;
    for (let i = this.nerveTelegraphs.length - 1; i >= 0; i--) {
      const telegraph = this.nerveTelegraphs[i];
      telegraph.delay -= dt;
      if (telegraph.delay > 0) continue;
      const rail = this.nerveRails[telegraph.railId];
      let hit = false;
      if (rail && playerOnRail(p, rail) && p.alive && (p.invulnTimer ?? 0) <= 0) {
        p.hp -= damage;
        p.hurtTimer = 0.16;
        if (p.hp <= 0) {
          p.hp = 0;
          p.alive = false;
        }
        hit = true;
      }
      this.nerveTelegraphs.splice(i, 1);
      this.events.emit('nerve:pulse', { railId: telegraph.railId, hit });
    }
  }

  /** Thin-walled: projectiles chip wall HP. Plaque walls have no hp. */
  _damageWall(wall, amount) {
    if (!wall || wall.ruptured || wall.hp == null) return;
    wall.hp -= amount;
    if (wall.hp <= 0) this._ruptureWall(wall);
  }

  /** Day 224 — suction burst fades into a sealed scab: solid again, low HP. */
  _scabWall(wall) {
    if (!wall || !wall.ruptured || wall.scabbed) return;
    const suc = this.patient?.suction ?? {};
    wall.ruptured = false;
    wall.scabbed = true;
    wall.hp = suc.scabHp ?? 12;
    wall.maxHp = wall.hp;
    this.events.emit('wall:scab', {
      x: wall.x + wall.w / 2,
      y: wall.y + wall.h / 2,
      hp: wall.hp
    });
  }

  _ruptureWall(wall) {
    if (!wall || wall.ruptured) return;
    const fromScab = !!wall.scabbed;
    wall.scabbed = false;
    wall.hp = 0;
    wall.ruptured = true;
    const suc = this.patient?.suction ?? {};
    const baseLife = suc.life ?? 2.5;
    const life = fromScab ? baseLife * (suc.reburstLifeMult ?? 0.4) : baseLife;
    const field = {
      x: wall.x + wall.w / 2,
      y: wall.y + wall.h / 2,
      radius: suc.radius ?? 150,
      // Day 178 — player pull stays under walk speed (escapable by design).
      force: suc.force ?? 150,
      enemyForceMult: suc.enemyForceMult ?? 2.2,
      dps: suc.dps ?? 16,
      life,
      maxLife: life,
      ventRadius: suc.ventRadius ?? 30,
      ventDps: suc.ventDps ?? 60,
      wallRef: wall,
      reburst: fromScab
    };
    this.suctionFields.push(field);
    this.events.emit('wall:rupture', { ...field, wallRef: undefined });
  }

  /** UI-only route card labels; sim advance() always uses exit.type. */
  _refreshRouteDisplay() {
    if (!this.node?.exits?.length) {
      this.routeDisplay = null;
      return;
    }
    this.routeDisplay = buildRouteDisplay(
      this.data.map,
      this.node.exits,
      this.pressure,
      this.rng.stream('routeUi'),
      this._nodeById
    );
  }

  /* ---------------------------------------------------------------- *
   * Introspection
   * ---------------------------------------------------------------- */

  /**
   * Full, JSON-safe state snapshot. Two worlds with the same seed and the
   * same action history must produce deepEqual snapshots — that property is
   * enforced by tests and is the future co-op desync detector.
   */
  snapshot() {
    const p = this.player;
    return {
      seed: this.seed,
      time: this.time,
      wave: this.wave,
      score: this.score,
      kills: this.kills,
      gameOver: this.gameOver,
      victory: this.victory,
      nodeId: this.node.id,
      pressure: this.pressure,
      intensity: this.intensity,
      wavesSpawned: this.wavesSpawned,
      wavesRequired: this.wavesRequired,
      waveSize: this._waveSize,
      chamberCleared: this.chamberCleared,
      inLab: this.inLab,
      labZones: this.labZones
        ? JSON.parse(JSON.stringify(this.labZones))
        : null,
      offerHighlight: [...this.offerHighlight],
      labPedestals: this.labPedestals().map((p) => ({
        idx: p.idx,
        kind: p.kind,
        id: p.id,
        applicable: p.applicable,
        x: p.x,
        y: p.y,
        r: p.r,
        selected: p.selected
      })),
      dnaInventory: [...this.dnaInventory],
      hexUnlockedSeats: this.hexUnlockedSeats ?? hiveConfig(this.dnaPatterns).startingSeats,
      discoveredPatterns: [...(this.discoveredPatterns ?? [])],
      hex: {
        center: this.hex?.center ?? 'self',
        ringSlots: this.hex?.ringSlots ?? 0,
        slots: [...(this.hex?.slots ?? [])]
      },
      attackDnaChip: this.attack?.dnaChipId ?? null,
      demoPadActive: this.demoPadActive,
      labDummies: this.labDummies.map((d) => ({
        id: d.id, x: d.x, y: d.y, hp: d.hp, alive: d.alive
      })),
      roomId: this.roomId,
      roomName: this.roomName,
      biomeId: this.biomeId,
      patientId: this.patientId,
      enemyTint: this.enemyTint,
      walls: this.walls.map((w) => ({
        x: w.x, y: w.y, w: w.w, h: w.h,
        hp: w.hp ?? null,
        ruptured: !!w.ruptured,
        scabbed: !!w.scabbed
      })),
      suctionFields: this.suctionFields.map(({ wallRef, _scabDone, ...s }) => ({ ...s })),
      nerveRails: this.nerveRails.map((r) => ({ ...r })),
      nerveTelegraphs: this.nerveTelegraphs.map((t) => ({ ...t })),
      offer: this.offer
        ? this.offer.map((c) => (typeof c === 'object' ? { ...c } : c))
        : null,
      unlockedIds: [...this.unlockedIds],
      discoveries: this.crafting.discoveries,
      attack: this.attack ? this.attack.id : null,
      ability: [...this.ability],
      abilityCooldown: [...this.abilityCooldown],
      castLog: this.castLog.map((c) => ({ t: c.t, slot: c.slot })),
      pullFx: this.pullFx ? { ...this.pullFx } : null,
      activeIdx: this.activeIdx,
      inventory: this.inventory.map((el) => (el ? el.id : null)),
      stock: { ...this.stock },
      loadoutCap: this.loadoutCap,
      weaponSwapEnabled: !!this.weaponSwapEnabled,
      player: {
        x: p.x, y: p.y, hp: p.hp,
        invuln: p.invulnTimer, cooldown: p.fireCooldown,
        aim: { x: p.aim.x, y: p.aim.y },
        dash: { t: p.dashTimer, cd: p.dashCooldown, dx: p.dashDir.x, dy: p.dashDir.y },
        shield: { hp: p.shieldHp, t: p.shieldTimer }
      },
      enemies: this.enemies.map((e) => ({
        id: e.id, x: e.x, y: e.y, hp: e.hp,
        burn: e.status.burn ? { ...e.status.burn } : null,
        poison: e.status.poison ? { ...e.status.poison } : null,
        chill: e.status.chill ? { ...e.status.chill } : null
      })),
      projectiles: this.projectiles.map((pr) => ({
        x: pr.x, y: pr.y, vx: pr.vx, vy: pr.vy,
        damage: pr.damage, life: pr.life, pierceLeft: pr.pierceLeft,
        element: pr.element.id
      })),
      pickups: this.pickups.map((pk) => ({
        x: pk.x, y: pk.y, kind: pk.payload.kind,
        ref: pk.payload.kind === 'element' ? pk.payload.element.id : pk.payload.value
      }))
    };
  }
}
