/**
 * Art atlas — loads PNGs under art/ with emoji / circle fallbacks in callers.
 *
 * Paths:
 *   art/fragments/{id}.png
 *   art/player/nanobot.png  (+ optional nanobot.json sheet meta)
 *   art/enemies/{archetypeId}.png (+ optional .json)
 *   art/projectiles/{id}.png (+ optional .json)
 *   art/props/{id}.png
 *   art/affixes/{id}.png
 *   art/fx/{id}.png
 *   art/abilities/{id}.png
 *   art/ui/{id}.png
 *
 * Sheet format: horizontal strip; see src/systems/anim.js.
 */
const cache = new Map(); // path -> HTMLImageElement | null
const metaCache = new Map(); // path -> object | null
let preloadPromise = null;

export function fragmentSrc(id) {
  return `art/fragments/${id}.png`;
}

export function playerSrc(id = 'nanobot') {
  return `art/player/${id}.png`;
}

export function enemySrc(id) {
  return `art/enemies/${id}.png`;
}

export function projectileSrc(id) {
  return `art/projectiles/${id}.png`;
}

export function propSrc(id) {
  return `art/props/${id}.png`;
}

export function affixSrc(id) {
  return `art/affixes/${id}.png`;
}

export function fxSrc(id) {
  return `art/fx/${id}.png`;
}

export function abilitySrc(id) {
  return `art/abilities/${id}.png`;
}

export function uiSrc(id) {
  return `art/ui/${id}.png`;
}

/** Map element tags → projectile stamp id (Day 021). */
export function projectileArtId(element, hostile = false) {
  if (hostile) return 'hostile';
  if (element?.form === 'beam') return 'beam';
  if (element?.form === 'spray') return 'spray';
  if (element?.form === 'rocket') return 'rocket';
  // Arrangement / adjacency may set shotTag on Attack
  if (element?.shotTag) {
    const tag = element.shotTag;
    const map = {
      heat: 'heat', chill: 'chill', cold: 'chill', shock: 'shock',
      pierce: 'pierce', toxic: 'toxic', mass: 'mass', flow: 'flow',
      gravity: 'gravity', air: 'air', vitality: 'vitality'
    };
    if (map[tag]) return map[tag];
  }
  const tags = element?.tags ?? [];
  // Day 103 — top tags get distinct shot stamps
  const order = [
    ['heat', 'heat'], ['cold', 'chill'], ['chill', 'chill'],
    ['shock', 'shock'], ['pierce', 'pierce'], ['toxic', 'toxic'],
    ['mass', 'mass'], ['flow', 'flow'], ['gravity', 'gravity'],
    ['air', 'air'], ['vitality', 'vitality']
  ];
  for (const [tag, art] of order) {
    if (tags.includes(tag)) return art;
  }
  return 'default';
}

function metaSrc(pngPath) {
  return pngPath.replace(/\.png$/i, '.json');
}

function loadOne(path) {
  return new Promise((resolve) => {
    if (cache.has(path)) {
      resolve(cache.get(path));
      return;
    }
    const img = new Image();
    img.onload = () => {
      cache.set(path, img);
      resolve(img);
    };
    img.onerror = () => {
      cache.set(path, null);
      resolve(null);
    };
    img.src = path;
  });
}

function loadMeta(pngPath) {
  const mpath = metaSrc(pngPath);
  if (metaCache.has(mpath)) return Promise.resolve(metaCache.get(mpath));
  return fetch(mpath)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      metaCache.set(mpath, j);
      return j;
    })
    .catch(() => {
      metaCache.set(mpath, null);
      return null;
    });
}

/**
 * @param {{
 *   fragments?: string[], player?: string, enemies?: string[],
 *   projectiles?: string[], props?: string[], affixes?: string[], fx?: string[],
 *   abilities?: string[], ui?: string[]
 * }} opts
 */
export function preloadArt(opts = {}) {
  const paths = [];
  for (const id of opts.fragments ?? []) paths.push(fragmentSrc(id));
  if (opts.player) paths.push(playerSrc(opts.player));
  for (const id of opts.enemies ?? []) paths.push(enemySrc(id));
  for (const id of opts.projectiles ?? []) paths.push(projectileSrc(id));
  for (const id of opts.props ?? []) paths.push(propSrc(id));
  for (const id of opts.affixes ?? []) paths.push(affixSrc(id));
  for (const id of opts.fx ?? []) paths.push(fxSrc(id));
  for (const id of opts.abilities ?? []) paths.push(abilitySrc(id));
  for (const id of opts.ui ?? []) paths.push(uiSrc(id));

  const unique = [...new Set(paths)];
  preloadPromise = Promise.all([
    ...unique.map(loadOne),
    ...unique.filter((p) => p.endsWith('.png')).map(loadMeta)
  ]).then(() => undefined);
  return preloadPromise;
}

/** @returns {HTMLImageElement | null} */
export function sprite(path) {
  return cache.get(path) || null;
}

export function sheetMeta(pngPath) {
  return metaCache.get(metaSrc(pngPath)) || null;
}

export function fragmentSprite(id) {
  return sprite(fragmentSrc(id));
}

export function playerSprite(id = 'nanobot') {
  return sprite(playerSrc(id));
}

export function enemySprite(id) {
  return sprite(enemySrc(id));
}

export function projectileSprite(id) {
  return sprite(projectileSrc(id));
}

export function propSprite(id) {
  return sprite(propSrc(id));
}

export function affixSprite(id) {
  return sprite(affixSrc(id));
}

export function fxSprite(id) {
  return sprite(fxSrc(id));
}

export function abilitySprite(id) {
  return sprite(abilitySrc(id));
}

export function uiSprite(id) {
  return sprite(uiSrc(id));
}

/**
 * Draw an ability module icon: PNG if loaded, else emoji / letter fallback.
 */
export function drawAbilityIcon(c, mod, cx, cy, size = 32) {
  const id = typeof mod === 'string' ? mod : mod?.id;
  const img = id ? abilitySprite(id) : null;
  if (img) {
    c.save();
    c.imageSmoothingEnabled = false;
    c.drawImage(img, cx - size / 2, cy - size / 2, size, size);
    c.restore();
    return;
  }
  const icon = typeof mod === 'object' ? mod?.icon : null;
  c.save();
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  if (icon) {
    c.font = `${Math.floor(size * 0.7)}px sans-serif`;
    c.fillText(icon, cx, cy);
  } else {
    c.fillStyle = '#80ffdb';
    c.font = `bold ${Math.floor(size * 0.45)}px monospace`;
    c.fillText(String(id ?? '?').slice(0, 2).toUpperCase(), cx, cy);
  }
  c.restore();
}

/**
 * Draw a fragment icon: PNG if loaded, else emoji fallback.
 */
export function drawFragmentIcon(c, el, cx, cy, size = 48) {
  const img = el?.id ? fragmentSprite(el.id) : null;
  if (img) {
    c.save();
    c.imageSmoothingEnabled = false;
    c.drawImage(img, cx - size / 2, cy - size / 2, size, size);
    c.restore();
    return;
  }
  c.fillText(el?.icon ?? '?', cx, cy);
}

/**
 * Draw a world sprite centered at (cx,cy). Optional rotation (radians).
 * Returns true if the PNG was drawn. Uses nearest-neighbor for pixel lean.
 */
export function drawWorldSprite(c, img, cx, cy, size, rotation = 0) {
  if (!img) return false;
  c.save();
  c.translate(cx, cy);
  if (rotation) c.rotate(rotation);
  c.imageSmoothingEnabled = false;
  c.drawImage(img, -size / 2, -size / 2, size, size);
  c.restore();
  return true;
}

/**
 * Draw frame `frame` from a horizontal strip sheet.
 * @returns {boolean} true if drawn
 */
export function drawWorldSheet(c, img, cx, cy, size, frame = 0, cols = 1, rotation = 0) {
  if (!img) return false;
  const n = Math.max(1, cols | 0);
  const fw = img.width / n;
  const fh = img.height;
  const i = ((frame % n) + n) % n;
  c.save();
  c.translate(cx, cy);
  if (rotation) c.rotate(rotation);
  c.imageSmoothingEnabled = false;
  c.drawImage(img, i * fw, 0, fw, fh, -size / 2, -size / 2, size, size);
  c.restore();
  return true;
}

/**
 * Draw a sheet frame stretched along local X (rotation aims the lance).
 * Used by beam Attack form so silhouette reads vs round bolt stamps.
 * @returns {boolean} true if drawn
 */
export function drawWorldElongatedSheet(
  c, img, cx, cy, length, thickness, frame = 0, cols = 1, rotation = 0
) {
  if (!img) return false;
  const n = Math.max(1, cols | 0);
  const fw = img.width / n;
  const fh = img.height;
  const i = ((frame % n) + n) % n;
  c.save();
  c.translate(cx, cy);
  if (rotation) c.rotate(rotation);
  c.imageSmoothingEnabled = false;
  c.drawImage(img, i * fw, 0, fw, fh, -length / 2, -thickness / 2, length, thickness);
  c.restore();
  return true;
}
