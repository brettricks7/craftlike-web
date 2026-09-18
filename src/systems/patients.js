/**
 * systems/patients.js — seed-picked patient identity for a run.
 *
 * Named stream: rng.stream('patient') — independent of map/rooms/loot.
 * Missing data ⇒ null (tests that omit patients.json keep old room pools).
 */

import { Rng } from '../core/rng.js';

/**
 * @param {object} patientsData data/patients.json
 * @param {import('../core/rng.js').RandomStream} stream
 * @returns {object|null}
 */
export function pickPatient(patientsData, stream) {
  const list = patientsData?.patients;
  if (!list?.length || !stream) return null;
  const total = list.reduce((sum, p) => sum + (p.weight ?? 1), 0);
  if (total <= 0) return list[0];
  let roll = stream.float(0, total);
  for (const p of list) {
    roll -= (p.weight ?? 1);
    if (roll <= 0) return p;
  }
  return list[list.length - 1];
}

/** Menu preview — same stream World will use for this seed. */
export function previewPatient(patientsData, seed) {
  return pickPatient(patientsData, new Rng(String(seed)).stream('patient'));
}

/** Room template ids this patient allows, or null to use the global pickPool. */
export function patientRoomPool(patient) {
  const pool = patient?.roomPool;
  return Array.isArray(pool) && pool.length ? pool : null;
}
