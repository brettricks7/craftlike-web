/**
 * systems/anim.js — deterministic sprite-sheet frame picks (presentation).
 *
 * Frame index is a pure function of sim time (or any scalar clock the caller
 * passes). Never use Date.now / performance.now here.
 *
 * Sheet convention (Day 006):
 *   Horizontal strip PNG: frames left→right, equal cell size.
 *   Optional sidecar JSON next to the PNG:
 *     {
 *       "frameCount": 2,
 *       "fps": 8,
 *       "anims": { "idle": [0], "move": [0, 1] }
 *     }
 *   If no JSON, treat the whole image as a 1-frame stamp.
 */

/**
 * @param {number} timeSec sim or presentation clock (seconds)
 * @param {number} fps frames per second
 * @param {number} frameCount length of the anim cycle (≥1)
 * @returns {number} index in [0, frameCount)
 */
export function frameIndex(timeSec, fps, frameCount) {
  const n = Math.max(1, Math.floor(frameCount) || 1);
  if (n === 1) return 0;
  const rate = Math.max(0, fps) || 8;
  const t = Math.max(0, timeSec) || 0;
  return Math.floor(t * rate) % n;
}

/**
 * Resolve which absolute frame to draw for an anim name.
 * @param {object|null} meta sheet JSON
 * @param {string} animName e.g. 'idle' | 'move'
 * @param {number} timeSec
 * @returns {{ frame: number, frameCount: number, cols: number }}
 */
export function pickSheetFrame(meta, animName, timeSec) {
  const cols = Math.max(1, meta?.frameCount ?? 1);
  const anims = meta?.anims ?? {};
  const seq = anims[animName] ?? anims.idle ?? [...Array(cols).keys()];
  const frames = Array.isArray(seq) && seq.length ? seq : [0];
  const local = frameIndex(timeSec, meta?.fps ?? 8, frames.length);
  const frame = frames[local] % cols;
  return { frame, frameCount: cols, cols };
}
