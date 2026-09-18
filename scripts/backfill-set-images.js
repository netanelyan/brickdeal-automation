#!/usr/bin/env node
/**
 * One-off: swap already-published deals over to official set renders.
 *
 * New deals get this in the engine (src/setImage.js); this runs the same
 * lookup + vision check over the existing website feed, so the catalog stops
 * being a mix of seller photos. Records that already carry `sourceImage` were
 * done and are skipped, so re-running is safe. Rejections are not remembered:
 * a wrong set number stays a seller photo and gets re-checked on the next run,
 * which costs one small Haiku call each.
 *
 *   node scripts/backfill-set-images.js            do it
 *   node scripts/backfill-set-images.js --dry      report only, write nothing
 *   node scripts/backfill-set-images.js --batch 50 stop after N candidates
 */

import { loadEnv } from '../src/env.js';
loadEnv();

import { readDeals, writeDeals } from '../src/deals.js';
import { officialImageFor } from '../src/setImage.js';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};

const DRY = flag('dry');
const BATCH = Number(opt('batch', '0')) || Infinity;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('backfill: ANTHROPIC_API_KEY is required — no photo check means no swap');
    process.exit(1);
  }
  const before = readDeals();
  const todo = before.filter((d) => !d.dead && d.setId && d.image && !d.sourceImage).slice(0, BATCH);
  console.log(`backfill: ${before.length} in feed, ${todo.length} to check` + (DRY ? ' (DRY RUN)' : ''));

  const updates = new Map();
  let none = 0,
    rejected = 0;
  for (const d of todo) {
    const official = await officialImageFor(d.setId, d.image, false);
    if (official) {
      updates.set(d.productId, { image: official, sourceImage: d.image });
      console.log(`  ✓ ${d.setId} ${d.name}`);
    } else {
      // Can't tell "no render exists" from "render rejected" without a second
      // lookup, and the distinction only matters for the summary line.
      const res = await fetch(`https://images.brickset.com/sets/images/${d.setId}-1.jpg`, { method: 'HEAD' }).catch(() => null);
      if (res?.ok) {
        rejected++;
        console.log(`  ✗ ${d.setId} render rejected as a different model — ${d.name}`);
      } else {
        none++;
      }
    }
    await sleep(300);
  }

  if (DRY) {
    console.log(`backfill (DRY): ${updates.size} would swap, ${rejected} rejected, ${none} no render`);
    return;
  }

  // Re-read and merge by productId — the bot may have posted while this ran.
  const current = readDeals();
  let applied = 0;
  for (const rec of current) {
    const u = updates.get(rec.productId);
    if (!u) continue;
    Object.assign(rec, u);
    applied++;
  }
  writeDeals(current);
  console.log(`backfill: ${applied} swapped, ${rejected} rejected, ${none} no render — ${current.length} records`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
