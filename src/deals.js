/**
 * deals.json feed writer for the public website.
 *
 * Appends every deal actually posted to the channel, deduplicated by product id,
 * written atomically (temp file + rename) exactly as src/store.js does.
 *
 * Called from publishNext() in bot.js, after deliver() resolves. Nothing in the
 * ingest / approval / dedupe / drip path depends on this succeeding — a feed
 * write failure is logged and swallowed by the caller so a broken disk or a bad
 * record can never stop the channel posting.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { detectTheme } from './themes.js';

/* Resolved on every call, NOT once at module load.
   bot.js calls loadEnv() on line 2, but imports this module on line 8 — and ESM
   evaluates every imported module body BEFORE the first statement of the module
   importing it. A module-level constant here would therefore be computed before
   .env had been read, silently falling back to data/deals.json while
   process.env.DEALS_PATH said /var/www/brickdeal/deals.json. The bot would then
   write a perfectly good feed somewhere the web server never looks, with no
   error anywhere — verified by reproducing it before this was changed. */
export const dealsPath = () =>
  process.env.DEALS_PATH || path.join(process.cwd(), 'data', 'deals.json');

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
};

const str = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? undefined : s;
};

/* -------------------------------------------------------------------------- */
/* Legacy candidates                                                          */
/* -------------------------------------------------------------------------- */
/* Candidates queued before this module existed carry only
   { productId, message, image, link, setId?, pieces?, stars? } — the name and
   price live solely inside the rendered Hebrew message. There were 11 staged and
   3 queued such items when this shipped, and they will drip out over the days
   after deploy, so they have to be recoverable rather than dropped.

   Mirrors scripts/rebuild-deals.js's parser: anchor on the emoji, treat the
   `מחיר` label as optional, since src/format.js gained it partway through. */

const RE_PRICE_LINE = /💳\s*(?:מחיר)?\s*([\d.,]+)\s*₪/u;
const RE_FIELD_LINE = /^\s*(?:🆔|🧱|💳|🌟|🛍️?|🛒|💰|🚚|🔗|\[|_)/u;

/* A third, older shape predates the Hebrew card entirely — English title, price
   in USD:  `💰 *$17.38*  ~$34.77~  (−50%)`. Two such candidates were still in
   staging when this shipped. Their price must NEVER be read as shekels: $17.38
   recorded as ₪17.38 is a ~4x understatement on a public page. Detected here
   only so the refusal names the reason; the record is then left to
   scripts/rebuild-deals.js, which re-fetches a real ILS price from the API. */
const RE_FOREIGN_PRICE = /💰\s*\*?\s*[$€£]/u;

export function fromMessage(message) {
  const text = String(message || '');
  if (!text.trim()) return {};

  const lines = text.split('\n').map((l) => l.trim());
  const nameLine = lines.find((l) => l && !RE_FIELD_LINE.test(l));
  const priceM = text.match(RE_PRICE_LINE);

  return {
    name: nameLine ? nameLine.replace(/^\*+|\*+$/g, '').trim() : undefined,
    price: priceM ? num(priceM[1].replace(/,/g, '')) : undefined,
    foreignCurrency: !priceM && RE_FOREIGN_PRICE.test(text),
  };
}

/* -------------------------------------------------------------------------- */

/**
 * Build a feed record from a candidate (src/candidate.js) or an engine product.
 *
 * Field names are taken from what those objects actually expose — the engine
 * product uses `id` / `title` / `salePrice`, not `productId` / `name` / `price`.
 */
export function toRecord(cand, now = new Date()) {
  const fallback = cand.name && cand.price !== undefined ? {} : fromMessage(cand.message);

  const productId = str(cand.productId ?? cand.id);
  const name = str(cand.name ?? cand.title ?? fallback.name);
  const link = str(cand.link ?? cand.promotionLink);

  if (!productId || !name || !link) {
    throw new Error(
      `deals: incomplete candidate (id=${productId} name=${Boolean(name)} link=${Boolean(link)})`
    );
  }

  /* Price, in order of trust:
       1. targetPrice      — engine.js, currency-verified against TARGET_CURRENCY
       2. price/salePrice  — already-normalised callers
       3. the posted message — legacy candidates only
     salePrice is NOT currency-verified (see parseProduct in engine.js), but by
     the time it reaches here it is the number that was already published to the
     channel, so the feed showing the same figure is the correct behaviour. */
  const price = num(cand.targetPrice) ?? num(cand.price) ?? num(cand.salePrice) ?? fallback.price;
  if (price === undefined) {
    throw new Error(
      fallback.foreignCurrency
        ? `deals: ${productId} is a pre-Hebrew post priced in a foreign currency — ` +
          `refusing to record it as ${process.env.TARGET_CURRENCY || 'ILS'}. ` +
          `Run scripts/rebuild-deals.js to recover it with a live price.`
        : `deals: missing price for ${productId}`
    );
  }

  const currency =
    str(cand.targetCurrency) || str(cand.currency) || process.env.TARGET_CURRENCY || 'ILS';

  const iso = now.toISOString();

  // Absent fields are omitted, never written as null — the site treats a missing
  // key and a null the same way, but null bloats the feed and reads as a bug.
  const rec = {
    productId,
    name,
    price,
    currency,
    link,
    postedAt: iso,
    priceCheckedAt: iso,
  };

  /* Struck-through "original" price on the website. Only ever from the
     currency-verified target_original_price, and only when it is genuinely above
     the sale price. Never reconstructed from the `discount` string: that would
     turn a rounded "52%" back into a fabricated shekel figure. */
  const was = num(cand.targetOriginalPrice);
  if (was !== undefined && was > price) rec.originalPrice = was;

  const setId = str(cand.setId);
  const pieces = num(cand.pieces);
  const stars = num(cand.stars ?? cand.rating);
  const image = str(cand.image ?? cand.imageUrl);
  const theme = detectTheme(name);

  if (setId) rec.setId = setId;
  if (pieces !== undefined && pieces > 0) rec.pieces = Math.round(pieces);
  if (stars !== undefined && stars > 0) rec.stars = Math.round(stars * 10) / 10;
  if (image) rec.image = image;
  if (theme) rec.theme = theme;

  return rec;
}

export function readDeals() {
  const file = dealsPath();
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    // A corrupt feed is rebuildable (scripts/rebuild-deals.js), but silently
    // restarting from [] would quietly discard the archive. Fail loudly.
    throw new Error(`deals: cannot read ${file}: ${err.message}`);
  }
}

/** Atomic write: temp file alongside the target, then rename — as src/store.js. */
export function writeDeals(deals) {
  const file = dealsPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(deals, null, 2) + '\n');
  renameSync(tmp, file);
}

/**
 * Append a posted deal, or update the existing record for the same product id.
 * postedAt is preserved on update — it marks first publication, not last touch.
 *
 * Synchronous throughout, matching src/store.js: the read-modify-write cannot
 * interleave with another call, so no locking is needed.
 *
 * @returns {{created: boolean, total: number}}
 */
export function recordDeal(cand, now = new Date()) {
  const rec = toRecord(cand, now);
  const deals = readDeals();
  const i = deals.findIndex((d) => String(d.productId) === rec.productId);

  if (i === -1) {
    deals.push(rec);
    writeDeals(deals);
    return { created: true, total: deals.length };
  }

  deals[i] = { ...deals[i], ...rec, postedAt: deals[i].postedAt || rec.postedAt };
  delete deals[i].dead; // it posted again, so it is alive
  delete deals[i].missStrikes;
  if (rec.originalPrice === undefined) delete deals[i].originalPrice; // sale ended
  writeDeals(deals);
  return { created: false, total: deals.length };
}

/* No DEALS_PATH constant is exported on purpose: any such constant would be
   evaluated at import time and reintroduce the hoisting bug above. Callers that
   need the location must call dealsPath() at the point of use. */
