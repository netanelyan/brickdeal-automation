import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tiny persistent store. Plenty for a single-process, low-volume deal bot;
// no native compilation, no external service.
const FILE = fileURLToPath(new URL('../data/store.json', import.meta.url));

const DAY_MS = 24 * 60 * 60 * 1000;
// Read lazily (not cached at module-load time) since store.js can be
// evaluated before .env has been loaded — see env.js/loadEnv().
const ttlMs = () => Math.max(0, Number(process.env.SEEN_TTL_DAYS ?? '10')) * DAY_MS;

const empty = { seen: {}, queue: [], staging: {} };
let state = load();

// Drop seen-entries older than the TTL, in place. Returns whether anything changed.
function pruneSeen(s) {
  const cutoff = Date.now() - ttlMs();
  let changed = false;
  for (const [id, ts] of Object.entries(s.seen)) {
    if (ts < cutoff) {
      delete s.seen[id];
      changed = true;
    }
  }
  return changed;
}

function load() {
  let s;
  try {
    s = { ...empty, ...JSON.parse(readFileSync(FILE, 'utf8')) };
  } catch {
    s = structuredClone(empty);
  }
  if (pruneSeen(s)) save(s); // keep the file from growing forever
  return s;
}

function save(s = state) {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
  } catch {}
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, FILE);
}

// --- dedupe (product IDs already claimed by the pipeline: staged, queued, or published) ---
// A claim expires after SEEN_TTL_DAYS (default 10) — after that the same
// product can be posted again instead of being blocked forever.
export const hasSeen = (id) => {
  const ts = state.seen[id];
  return Boolean(ts) && Date.now() - ts < ttlMs();
};
export function markSeen(id) {
  state.seen[id] = Date.now();
  pruneSeen(state); // opportunistic — also catches entries the cold-start prune missed
  save();
}
// Roll back a claim when candidate-building fails after markSeen — otherwise
// a transient error would permanently block that product from ever being retried.
export function forgetSeen(id) {
  delete state.seen[id];
  save();
}

// --- staging (items awaiting your approve/reject tap) ---
export function addStaging(item) {
  const key = Math.random().toString(36).slice(2, 9);
  state.staging[key] = item;
  save();
  return key;
}
export function takeStaging(key) {
  const item = state.staging[key];
  delete state.staging[key];
  save();
  return item || null;
}
export const hasStaging = (key) => Boolean(state.staging[key]);
export const stagingSize = () => Object.keys(state.staging).length;
// Discard everything still awaiting a decision (e.g. to reset after a big
// backfill). Returns how many were cleared.
export function clearStaging() {
  const n = Object.keys(state.staging).length;
  state.staging = {};
  save();
  return n;
}

// --- publish queue (approved, waiting to drip out) ---
export function enqueue(item) {
  state.queue.push(item);
  save();
}
export function dequeue() {
  const item = state.queue.shift() || null;
  if (item) save();
  return item;
}
export const queueSize = () => state.queue.length;

export { existsSync };
