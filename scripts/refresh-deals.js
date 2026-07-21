#!/usr/bin/env node
/**
 * Nightly price refresh for the website feed.
 *
 * Re-checks the deals whose prices were checked longest ago, updates price /
 * originalPrice / image / priceCheckedAt, and marks vanished listings dead so
 * the site drops them.
 *
 * Batched on purpose: re-checking the whole catalog every night hammers the API
 * for no benefit. REFRESH_BATCH oldest-first per run rotates the catalog through
 * on a predictable cycle (200/night clears ~1400 deals a week).
 *
 * This replaces the bot/refresh-deals.js drop-in from the website repo, which
 * was written against the brief rather than the real source and could not run:
 * it imported a getProductDetail() that src/aliClient.js does not export, read a
 * `detail.price` field the API never returns (which would have given every deal
 * a strike and marked the entire catalog dead after two nights), and never
 * called loadEnv(), so it had neither credentials nor DEALS_PATH.
 *
 *   node scripts/refresh-deals.js              refresh the oldest REFRESH_BATCH
 *   node scripts/refresh-deals.js --dry        report only, write nothing
 *   node scripts/refresh-deals.js --batch 25   override the batch size
 */

import { loadEnv } from '../src/env.js';
loadEnv();

import { readDeals, writeDeals } from '../src/deals.js';
import { makeClient } from '../src/engine.js';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};

const DRY = flag('dry');
const BATCH = Number(opt('batch', process.env.REFRESH_BATCH || '200'));
const THROTTLE_MS = Number(process.env.REFRESH_THROTTLE_MS || '1200');
const DEAD_STRIKES = Number(process.env.REFRESH_DEAD_STRIKES || '2');
const CURRENCY = (process.env.TARGET_CURRENCY || 'ILS').toUpperCase();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const time = (v) => {
  const t = Date.parse(v || '');
  return Number.isNaN(t) ? 0 : t;
};
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
const dig = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

/* Response reading, mirroring src/engine.js's parseProduct — engine.js is the
   source of truth; if the API shape changes, fix it there first. Duplicated
   rather than exported from it because engine.js is loaded by the running bot
   and this is standalone maintenance tooling.

   Prices come ONLY from the currency-verified target_* pair. Verified against a
   live response: target_sale_price/target_original_price are ILS while
   sale_price/original_price are CNY for the same product (141.49/329.04 ILS vs
   306.71/713.28 CNY). Falling back to the untagged pair would publish a CNY
   figure as shekels and invent a ~57% discount out of an exchange rate. */
function readProduct(resp) {
  const result =
    dig(resp, 'aliexpress_affiliate_productdetail_get_response.resp_result.result') ||
    dig(resp, 'resp_result.result');
  const arr = dig(result, 'products.product') || dig(result, 'products') || [];
  const p = Array.isArray(arr) ? arr[0] : arr;
  if (!p || (!p.product_title && !p.product_id)) return null;

  const okCur = (c) => String(c || '').toUpperCase() === CURRENCY;
  const price = okCur(p.target_sale_price_currency) ? num(p.target_sale_price) : null;
  const original = okCur(p.target_original_price_currency) ? num(p.target_original_price) : null;

  const c =
    p.product_main_image_url ||
    dig(p, 'product_small_image_urls.string.0') ||
    dig(p, 'product_small_image_urls.0') ||
    null;
  const m = c && String(c).match(/^(https?:\/\/[^\s]+?\.(?:jpg|jpeg|png|webp))/i);

  return { price, original, image: m ? m[1] : c ? String(c) : null, title: p.product_title };
}

async function main() {
  const before = readDeals();
  if (!before.length) {
    console.log('refresh: empty feed, nothing to do');
    return;
  }

  const batch = before
    .filter((d) => !d.dead)
    .sort((a, b) => time(a.priceCheckedAt) - time(b.priceCheckedAt))
    .slice(0, BATCH);

  console.log(
    `refresh: ${before.length} in feed, checking ${batch.length} oldest` + (DRY ? ' (DRY RUN)' : '')
  );

  const client = makeClient();
  // Keyed by productId so the result can be merged onto a re-read of the feed
  // rather than onto the stale array this run started from — see below.
  const updates = new Map();
  let changed = 0,
    same = 0,
    died = 0,
    striked = 0,
    failed = 0;

  for (const d of batch) {
    const now = new Date().toISOString();
    try {
      const resp = await client.productDetail([d.productId], {
        targetCurrency: CURRENCY,
        targetLanguage: process.env.TARGET_LANGUAGE || 'he',
        country: process.env.TARGET_COUNTRY || 'IL',
      });
      const fresh = readProduct(resp);

      if (!fresh || fresh.price == null) {
        // One bad response is usually a transient API hiccup, not a delisting.
        // Require consecutive strikes before hiding a deal from the site.
        const strikes = (d.missStrikes || 0) + 1;
        if (strikes >= DEAD_STRIKES) {
          updates.set(d.productId, { dead: true, priceCheckedAt: now, missStrikes: undefined });
          died++;
          console.log(`  × ${d.productId} dead after ${strikes} strikes — ${d.name}`);
        } else {
          updates.set(d.productId, { missStrikes: strikes, priceCheckedAt: now });
          striked++;
          console.log(`  ? ${d.productId} strike ${strikes}/${DEAD_STRIKES} — ${d.name}`);
        }
      } else {
        const u = {
          price: fresh.price,
          currency: CURRENCY,
          priceCheckedAt: now,
          missStrikes: undefined,
          dead: undefined,
        };
        if (fresh.image) u.image = fresh.image;

        /* originalPrice is a price claim, so it is only ever written from the
           currency-verified list price and only while genuinely above the sale
           price. When the sale ends the API stops reporting one, and leaving the
           old value in place would keep advertising a discount that no longer
           exists — so it is explicitly removed, not merely left alone. */
        u.originalPrice = fresh.original !== null && fresh.original > fresh.price ? fresh.original : undefined;

        if (Number(fresh.price) !== Number(d.price)) {
          changed++;
          console.log(`  ₪ ${d.productId} ${d.price} → ${fresh.price} — ${d.name}`);
        } else {
          same++;
        }
        updates.set(d.productId, u);
      }
    } catch (err) {
      // aliClient already retries rate limits internally; anything reaching here
      // is a real error. Do NOT strike on it — a 500 is not evidence of delisting.
      failed++;
      console.warn(`  ! ${d.productId}: ${err.message}`);
    }
    await sleep(THROTTLE_MS);
  }

  if (DRY) {
    console.log(`refresh (DRY): ${changed} would change, ${same} unchanged, ${died} would die, ${striked} strikes, ${failed} errors`);
    return;
  }

  /* Re-read immediately before writing, and merge by productId.
     This run takes minutes; the bot writes the same file whenever a deal posts.
     Writing back the array we loaded at startup would silently delete any deal
     published in the meantime. Merging onto a fresh read keeps both. */
  const current = readDeals();
  let applied = 0;
  for (const rec of current) {
    const u = updates.get(rec.productId);
    if (!u) continue;
    for (const [k, v] of Object.entries(u)) {
      if (v === undefined) delete rec[k];
      else rec[k] = v;
    }
    applied++;
  }
  writeDeals(current);

  const addedDuringRun = current.length - before.length;
  console.log(
    `refresh: ${changed} price changes, ${same} unchanged, ${died} dead, ${striked} strikes, ${failed} errors` +
      ` — ${applied}/${updates.size} applied to ${current.length} records` +
      (addedDuringRun > 0 ? ` (+${addedDuringRun} posted during the run, preserved)` : '')
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
