import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tiny persistent store. Plenty for a single-process, low-volume deal bot;
// no native compilation, no external service.
const FILE = fileURLToPath(new URL('../data/store.json', import.meta.url));

const empty = { seen: {}, queue: [], staging: {} };
let state = load();

function load() {
  try {
    return { ...empty, ...JSON.parse(readFileSync(FILE, 'utf8')) };
  } catch {
    return structuredClone(empty);
  }
}

function save() {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
  } catch {}
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, FILE);
}

// --- dedupe (product IDs we've already published) ---
export const hasSeen = (id) => Boolean(state.seen[id]);
export function markSeen(id) {
  state.seen[id] = Date.now();
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
