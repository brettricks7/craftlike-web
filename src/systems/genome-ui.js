/**
 * genome-ui.js — pure Lab Genome expand-panel layout.
 *
 * Canvas-free so Node can assert Attack Shot / Inventory / Bonuses never
 * share pixels. Render code must consume these regions; do not freestyle
 * coordinates in the draw path.
 */

export const GENOME_PANEL_DEFAULT = Object.freeze({
  x: 200,
  y: 60,
  w: 880,
  h: 600
});

/** Monospace width estimate (no canvas). ~0.6em is typical for monospace. */
export function monoWidth(text, fontPx) {
  return String(text ?? '').length * fontPx * 0.6;
}

export function aabbFromCircle(cx, cy, r) {
  return { x: cx - r, y: cy - r, w: r * 2, h: r * 2 };
}

export function aabbsOverlap(a, b, pad = 0) {
  if (!a || !b) return false;
  return (
    a.x - pad < b.x + b.w
    && a.x + a.w + pad > b.x
    && a.y - pad < b.y + b.h
    && a.y + a.h + pad > b.y
  );
}

/** Ellipsis-trim a monospace string to maxW. */
export function fitMonoLine(text, fontPx, maxW) {
  const s = String(text ?? '');
  if (maxW <= 0) return '';
  if (monoWidth(s, fontPx) <= maxW) return s;
  const ell = '…';
  if (monoWidth(ell, fontPx) > maxW) return '';
  let n = s.length;
  while (n > 0 && monoWidth(s.slice(0, n) + ell, fontPx) > maxW) n -= 1;
  return n <= 0 ? ell : `${s.slice(0, n)}${ell}`;
}

export function formatAttackDmgLine(dmg, cd) {
  if (dmg == null || !(cd > 0)) return 'dmg —';
  const dps = dmg / cd;
  return `dmg ${Number(dmg).toFixed(1)} · ${(1 / cd).toFixed(1)}/s · ${dps.toFixed(0)} dps`;
}

const FORM_LABELS = Object.freeze({
  beam: 'BEAM',
  spray: 'SPRAY',
  rocket: 'ROCKET'
});

const TAG_LABELS = Object.freeze({
  heat: 'HEAT',
  chill: 'CHILL',
  cold: 'CHILL',
  mass: 'MASS',
  shock: 'SHOCK',
  toxic: 'TOXIC',
  flow: 'FLOW',
  air: 'AIR',
  gravity: 'GRAVITY',
  vitality: 'VITALITY',
  pierce: 'PIERCE'
});

/**
 * Identity-only fingerprint — form / shotTag / bonds, not damage ticks.
 * @param {object|null|undefined} atk
 */
export function attackEngineFingerprint(atk) {
  if (!atk) return '';
  return [
    atk.shotTag ?? '',
    atk.form ?? '',
    atk.name ?? atk.id ?? '',
    (atk.hexPatterns ?? []).join(','),
    JSON.stringify(atk.hexBonds ?? {})
  ].join('|');
}

/**
 * Readable run-engine label for this Attack (fantasy beat, not +stat).
 * @param {object|null|undefined} atk
 */
export function describeRunEngine(atk) {
  if (!atk) return 'PROTOCOL';
  const form = atk.form ? (FORM_LABELS[atk.form] ?? String(atk.form).toUpperCase()) : null;
  const tag = atk.shotTag ? (TAG_LABELS[atk.shotTag] ?? String(atk.shotTag).toUpperCase()) : null;
  if (form && tag) return `${tag} ${form}`;
  if (form) return form;
  if (tag) return `${tag} SHOT`;
  const name = atk.name ?? atk.dnaChipName;
  if (name) return String(name).toUpperCase();
  return 'PROTOCOL';
}

/**
 * Genome / toast flash when the run engine identity shifts.
 * @param {object|null|undefined} prevAtk
 * @param {object|null|undefined} nextAtk
 */
export function formatAttackPivotFlash(prevAtk, nextAtk) {
  const next = describeRunEngine(nextAtk);
  const prev = describeRunEngine(prevAtk);
  if (!prevAtk || prev === next) return `RUN ENGINE · ${next}`;
  return `RUN ENGINE → ${next}`;
}

/**
 * Attack delivery form key — null means default bolt/protocol shot.
 * @param {object|null|undefined} atk
 */
export function attackFormKey(atk) {
  return atk?.form ?? null;
}

/**
 * True when Lab fuse/seat rewrote Attack delivery form (not bond-only / dmg ticks).
 * @param {object|null|undefined} prevAtk
 * @param {object|null|undefined} nextAtk
 */
export function attackFormChanged(prevAtk, nextAtk) {
  return attackFormKey(prevAtk) !== attackFormKey(nextAtk);
}

/**
 * Short silhouette label for form-change identity beat (Day 239).
 * @param {object|null|undefined} atk
 */
export function describeAttackFormSilhouette(atk) {
  const form = attackFormKey(atk);
  if (form === 'beam') return 'BEAM';
  if (form === 'spray') return 'SPRAY';
  if (form === 'rocket') return 'ROCKET';
  return 'BOLT';
}

/**
 * Lab take toast — stow chip / arm ability (attack may not change yet).
 * @param {'dna'|'ability'} kind
 * @param {object} opts
 * @param {string} [opts.chipName]
 * @param {string} [opts.abilityName]
 */
export function formatLabTakeToast(kind, { chipName, abilityName } = {}) {
  if (kind === 'ability' && abilityName) return `RUN ENGINE · ${abilityName} armed`;
  if (kind === 'dna' && chipName) return `RUN ENGINE · stow ${chipName}`;
  return 'RUN ENGINE · chip stowed';
}

export function formatBondLine(bonds) {
  const entries = Object.entries(bonds ?? {});
  if (!entries.length) return 'no bonds yet — seat neighbors';
  return entries.map(([t, n]) => `${n}×${t}`).join('  ');
}

/**
 * Layout regions for the expanded Genome modal.
 * Inventory owns an exclusive right column; shot stats stay left of it.
 *
 * @param {object} [opts]
 * @param {number} [opts.panelX]
 * @param {number} [opts.panelY]
 * @param {number} [opts.panelW]
 * @param {number} [opts.panelH]
 * @param {number} [opts.bagCount]
 * @param {string} [opts.dmgLine]
 * @param {string} [opts.bondLine]
 * @param {string} [opts.kbLine]
 * @param {number} [opts.bonusCount]
 * @param {boolean} [opts.showBurn]
 */
export function layoutGenomePanel(opts = {}) {
  const panelX = opts.panelX ?? GENOME_PANEL_DEFAULT.x;
  const panelY = opts.panelY ?? GENOME_PANEL_DEFAULT.y;
  const panelW = opts.panelW ?? GENOME_PANEL_DEFAULT.w;
  const panelH = opts.panelH ?? GENOME_PANEL_DEFAULT.h;
  const bagCount = Math.max(0, Number(opts.bagCount) || 0);
  const bonusCount = Math.max(0, Number(opts.bonusCount) || 0);
  const showBurn = Boolean(opts.showBurn);

  const invColW = 168;
  const invColLeft = panelX + panelW - invColW;
  const colGap = 12;
  const shotColRight = invColLeft - colGap;

  const invLabelX = invColLeft + 8;
  const invChipX = panelX + panelW - 120;
  const invChipR = 14;
  const show = Math.min(bagCount, 10);
  const bagChips = [];
  for (let i = 0; i < show; i++) {
    const x = invChipX;
    const y = panelY + 100 + i * 36;
    bagChips.push({
      role: 'bag',
      idx: i,
      x,
      y,
      r: invChipR,
      aabb: aabbFromCircle(x, y, invChipR)
    });
  }

  // Shot column: art on top, stats stacked beneath (never beside into inventory).
  const shotX = panelX + 520;
  const shotY = panelY + 100;
  const art = { x: shotX, y: shotY + 10, w: 72, h: 72 };
  const statsMaxW = Math.max(0, shotColRight - shotX);

  const dmgFont = 13;
  const bondFont = 11;
  const kbFont = 10;
  const dmgText = fitMonoLine(opts.dmgLine ?? 'dmg —', dmgFont, statsMaxW);
  const bondText = fitMonoLine(opts.bondLine ?? '', bondFont, statsMaxW);
  const kbText = opts.kbLine ? fitMonoLine(opts.kbLine, kbFont, statsMaxW) : '';

  const statsTop = art.y + art.h + 14;
  const lines = [
    { key: 'dmg', text: dmgText, font: dmgFont, x: shotX, y: statsTop },
    { key: 'bond', text: bondText, font: bondFont, x: shotX, y: statsTop + 18 }
  ];
  if (kbText) {
    lines.push({ key: 'kb', text: kbText, font: kbFont, x: shotX, y: statsTop + 34 });
  }
  const shotStats = lines
    .filter((L) => L.text)
    .map((L) => ({
      ...L,
      aabb: {
        x: L.x,
        y: L.y - L.font,
        w: monoWidth(L.text, L.font),
        h: L.font + 2
      }
    }));

  const lastStatY = shotStats.length
    ? shotStats[shotStats.length - 1].y
    : statsTop;
  const bonusesTitleY = lastStatY + 28;
  const bonuses = {
    title: { x: shotX, y: bonusesTitleY, text: 'ACTIVE BONUSES' },
    rows: []
  };
  if (bonusCount <= 0) {
    bonuses.rows.push({
      key: 'empty',
      x: shotX,
      y: bonusesTitleY + 18,
      aabb: {
        x: shotX,
        y: bonusesTitleY + 8,
        w: monoWidth('seat a symmetry / motif…', 10),
        h: 12
      }
    });
  } else {
    for (let i = 0; i < Math.min(bonusCount, 6); i++) {
      const y = bonusesTitleY + 18 + i * 28;
      bonuses.rows.push({
        key: `bonus-${i}`,
        x: shotX,
        y,
        aabb: { x: shotX, y: y - 12, w: Math.min(statsMaxW, 200), h: 26 }
      });
    }
  }

  let burn = null;
  if (showBurn) {
    const bx = invChipX;
    const by = panelY + panelH - 70;
    burn = { role: 'burn', x: bx, y: by, r: 28, aabb: aabbFromCircle(bx, by, 26) };
  }

  const invColumn = {
    x: invColLeft,
    y: panelY + 48,
    w: invColW,
    h: panelH - 96
  };

  return {
    panel: { x: panelX, y: panelY, w: panelW, h: panelH },
    invColLeft,
    shotColRight,
    shotX,
    shotY,
    art,
    shotStats,
    dmgText,
    bondText,
    kbText,
    bonuses,
    invLabel: { x: invLabelX, y: panelY + 60 },
    invHint: { x: invLabelX, y: panelY + 74 },
    bagChips,
    burn,
    invColumn,
    close: { x: panelX + panelW - 28, y: panelY + 24, r: 16 }
  };
}

/**
 * Pairs of named AABBs that collide (pad=0). Used by regression tests.
 * @param {ReturnType<typeof layoutGenomePanel>} layout
 */
export function genomePanelOverlaps(layout) {
  const labeled = [];
  for (const s of layout.shotStats) {
    labeled.push({ name: `shot:${s.key}`, aabb: s.aabb });
  }
  for (const row of layout.bonuses.rows) {
    labeled.push({ name: `bonus:${row.key}`, aabb: row.aabb });
  }
  for (const chip of layout.bagChips) {
    labeled.push({ name: `bag:${chip.idx}`, aabb: chip.aabb });
  }
  if (layout.burn) labeled.push({ name: 'burn', aabb: layout.burn.aabb });
  labeled.push({ name: 'art', aabb: layout.art });

  const hits = [];
  for (let i = 0; i < labeled.length; i++) {
    for (let j = i + 1; j < labeled.length; j++) {
      const a = labeled[i];
      const b = labeled[j];
      // Same-column shot lines may sit close; only flag cross-family collisions.
      const family = (n) => n.split(':')[0];
      if (family(a.name) === family(b.name)) continue;
      if (aabbsOverlap(a.aabb, b.aabb)) {
        hits.push([a.name, b.name]);
      }
    }
  }
  return hits;
}
