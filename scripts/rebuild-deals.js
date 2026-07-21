#!/usr/bin/env node
// One-off archive reconstruction: rebuild deals.json from the channel's own
// message history.
//
// Why from Telegram and not data/store.json: store.json only keeps product IDs
// in `seen`. The curated Hebrew names — hand-approved through the staging gate —
// exist nowhere but the posted messages. Those are the asset being recovered
// here; price/image/availability are re-fetched live because archived prices
// are stale and Telegram photos are file IDs, not public URLs.
//
// Standalone by design. It imports from src/ read-only and touches neither
// data/store.json nor the running pm2 process. Safe to run while the bot is up.
//
//   node scripts/rebuild-deals.js --inspect        parse only, no AliExpress calls
//   node scripts/rebuild-deals.js --inspect --limit 40   NOTE: --limit takes the
//       NEWEST n messages, so it will not reach the old-format posts. Run
//       --inspect with no limit to actually verify old-format coverage.
//   node scripts/rebuild-deals.js                  full run
//   node scripts/rebuild-deals.js --resume         skip productIds already in deals.json
//
// Env (beyond the bot's usual .env):
//   SITE_TRACKING_ID   AliExpress Portals tracking id for website traffic,
//                      default 'brickdeal-site'. MUST already exist in your
//                      Portals account — see preflight() below.

import { writeFileSync, readFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { ConnectionTCPObfuscated } from 'telegram/network/index.js';

import { loadEnv } from '../src/env.js';
import { resolveToProductId, extractUrls } from '../src/resolve.js';
import { makeClient } from '../src/engine.js';
// Same keyword->theme detection src/deals.js applies on the live posting path.
// Without it the whole backfilled archive lands with no theme, which silently
// empties the site's theme chips and disables theme filtering entirely.
import { detectTheme } from '../src/themes.js';

loadEnv();

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const INSPECT = flag('inspect');
const RESUME = flag('resume');
const MSG_LIMIT = Number(opt('limit', '0')) || undefined; // messages scanned, 0 = all
const OUT_PATH = path.resolve(opt('out', 'deals.json'));
const ITEM_DELAY_MS = Number(opt('delay', '1500'));
const SITE_TRACKING_ID = process.env.SITE_TRACKING_ID || 'brickdeal-site';
const CURRENCY = process.env.TARGET_CURRENCY || 'ILS';
const CHECKPOINT_EVERY = 10;

// ---------------------------------------------------------------------------
// Message parsing
// ---------------------------------------------------------------------------
// The format in src/format.js changed over time. Two known shapes:
//
//   old                          new (current)
//   ─────────────────────────    ─────────────────────────
//   *name*                       *name*
//   🆔 מק״ט 76470                🆔 מק״ט 76470
//   🧱 868 חלקים                 🧱 868 חלקים
//   💳 129.40₪                   💳 מחיר 129.40₪
//   🌟 4.7 כוכבים                🛍️ תואם מקור
//                                🌟 4.7 כוכבים
//
// Every field regex below therefore treats its label word as optional and
// anchors on the emoji, which is the one thing that never moved. `מחיר` and the
// whole `תואם מקור` line are optional; a strict match on either would silently
// drop the earliest deals, which is exactly the failure this must avoid.
//
// Gershayim: format.js writes מק״ט with U+05F4, but a hand-edited title (the ✏️
// edit path) can carry a plain ASCII quote instead — accept both, plus none.

const RE_SET_ID = /🆔\s*(?:מק["״׳']{0,2}ט)?\s*[:\-]?\s*([A-Za-z0-9\-]{2,12})/u;
const RE_PIECES = /🧱\s*([\d,]{1,9})\s*(?:חלקים|חלקי|pcs)?/u;
const RE_PRICE = /💳\s*(?:מחיר)?\s*([\d.,]+)\s*₪/u;
const RE_STARS = /🌟\s*([\d.]+)/u;
// Any line that is a field row rather than a title.
const RE_FIELD_LINE = /^\s*(?:🆔|🧱|💳|🌟|🛍️?|🛒|\[)/u;

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);

// The URL lives in a MessageEntityTextUrl, not in the text: format.js emits a
// Markdown inline link and bot.js sends with parse_mode:'Markdown', so Telegram
// consumes the `[label](url)` syntax at send time and stores the target as an
// entity. Scanning `msg.message` finds nothing on a well-formed post. The text
// fallback exists only for posts that went out via deliver()'s plain-text catch
// path, where the markdown was never parsed and the brackets survive literally.
function extractLink(msg) {
  const entities = msg.entities || [];
  for (const e of entities) {
    const url = e?.url; // MessageEntityTextUrl
    if (url && /aliexpress/i.test(url)) return url;
  }
  // MessageEntityUrl (bare URL in text) + the plain-text fallback path.
  const found = extractUrls(msg.message || '');
  if (found.length) {
    return found.find((u) => /s\.click\.aliexpress/i.test(u)) || found[0];
  }
  return null;
}

export function parseMessage(msg) {
  const text = msg.message || '';
  if (!text.trim()) return null;

  const lines = text.split('\n').map((l) => l.trim());
  const link = extractLink(msg);

  const setIdM = text.match(RE_SET_ID);
  const piecesM = text.match(RE_PIECES);
  const starsM = text.match(RE_STARS);
  const priceM = text.match(RE_PRICE);

  // Is this even a deal post? The channel also carries announcements. A post
  // counts as deal-shaped if it has an AliExpress link, OR carries at least two
  // of the card's field rows (which catches a deal whose link we failed to pull
  // — that's a parse failure worth reporting, not a message to skip silently).
  const fieldCount = [setIdM, piecesM, starsM, priceM].filter(Boolean).length;
  const dealShaped = Boolean(link) || fieldCount >= 2;
  if (!dealShaped) return null;

  // Title is the first non-empty line that isn't a field row. Markdown bold was
  // stripped by Telegram at send time (or by deliver()'s fallback), but strip
  // stray asterisks anyway for the plain-text path.
  const nameLine = lines.find((l) => l && !RE_FIELD_LINE.test(l));
  const name = nameLine ? nameLine.replace(/^\*+|\*+$/g, '').trim() : '';

  return {
    ok: Boolean(name && link),
    reason: !name ? 'no_name' : !link ? 'no_link' : null,
    name,
    link,
    setId: setIdM ? setIdM[1] : null,
    pieces: piecesM ? num(piecesM[1].replace(/,/g, '')) : null,
    archivedStars: starsM ? num(starsM[1]) : null,
    archivedPrice: priceM ? num(priceM[1].replace(/,/g, '')) : null,
    postedAt: msg.date ? new Date(msg.date * 1000).toISOString() : null,
    messageId: msg.id,
  };
}

// ---------------------------------------------------------------------------
// AliExpress response reading
// ---------------------------------------------------------------------------
// Deliberately duplicated from src/engine.js rather than exported from it:
// engine.js is loaded by the running bot, and this is a one-off script that
// must not touch that file. engine.js's parseProduct/pickImage/toStars are the
// source of truth — if the API shape changes, fix it there first.

const dig = (obj, p) => p.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

function pickImage(p) {
  const c =
    p.product_main_image_url ||
    dig(p, 'product_small_image_urls.string.0') ||
    dig(p, 'product_small_image_urls.0') ||
    p.image_url ||
    null;
  if (!c) return null;
  const m = String(c).match(/^(https?:\/\/[^\s]+?\.(?:jpg|jpeg|png|webp))/i);
  return m ? m[1] : String(c);
}

function toStars(p) {
  const direct =
    num(p.avg_evaluation_rating) ??
    num(p.evaluation_rating) ??
    num(p.evaluation) ??
    num(p.product_evaluation_rating) ??
    num(p.avg_rating) ??
    num(p.rating);
  if (direct && direct > 0 && direct <= 5) return Number(direct.toFixed(1));
  const pctRaw =
    p.evaluate_rate ?? p.product_evaluation_rate ?? p.positive_feedback_rate ?? p.evaluation_rate ?? '';
  const rate = String(pctRaw).match(/([\d.]+)\s*%?/);
  if (rate && Number(rate[1]) > 5) return Number((Number(rate[1]) / 20).toFixed(1));
  return null;
}

function readProduct(resp) {
  const result =
    dig(resp, 'aliexpress_affiliate_productdetail_get_response.resp_result.result') ||
    dig(resp, 'resp_result.result');
  const arr = dig(result, 'products.product') || dig(result, 'products') || [];
  const p = Array.isArray(arr) ? arr[0] : arr;
  if (!p || (!p.product_title && !p.product_id)) return null;

  // Prices are read ONLY from the target_* pair, which the API returns in
  // TARGET_CURRENCY. A live response confirms sale_price/original_price are
  // quoted in CNY on the same product (117.83/147.29 CNY beside 54.35/67.94
  // ILS), so falling back to them would pair a CNY "original" with an ILS sale
  // price and invent a discount out of an exchange rate. The struck-through
  // price is a public price claim — absent beats wrong.
  const okCurrency = (c) => String(c || '').toUpperCase() === CURRENCY.toUpperCase();
  const price = okCurrency(p.target_sale_price_currency) ? num(p.target_sale_price) : null;
  const originalPrice = okCurrency(p.target_original_price_currency)
    ? num(p.target_original_price)
    : null;

  return {
    id: p.product_id,
    title: p.product_title,
    price,
    originalPrice: originalPrice !== null && price !== null && originalPrice > price ? originalPrice : null,
    image: pickImage(p),
    stars: toStars(p),
    promotionLink: p.promotion_link || null,
  };
}

function readLink(resp) {
  const result =
    dig(resp, 'aliexpress_affiliate_link_generate_response.resp_result.result') ||
    dig(resp, 'resp_result.result');
  const arr = dig(result, 'promotion_links.promotion_link') || [];
  const first = Array.isArray(arr) ? arr[0] : arr;
  return first?.promotion_link || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Telegram history
// ---------------------------------------------------------------------------

async function readChannelHistory() {
  const apiId = Number(process.env.TG_API_ID);
  const apiHash = process.env.TG_API_HASH;
  const channel = process.env.CHANNEL_ID;
  // The reader's TG_SESSION belongs to the secondary worker account, which is a
  // member of the SOURCE channels but not necessarily of your own channel — and
  // reading your channel's history is the entire point of this script.
  // BACKFILL_TG_SESSION lets you supply a session for the account that actually
  // owns/administers the channel (generate one with `npm run login`) without
  // touching TG_SESSION and disturbing the running reader.
  const session = process.env.BACKFILL_TG_SESSION || process.env.TG_SESSION;
  if (!apiId || !apiHash || !session) {
    throw new Error('TG_API_ID / TG_API_HASH / TG_SESSION must be set in .env');
  }
  if (process.env.BACKFILL_TG_SESSION) console.log('Using BACKFILL_TG_SESSION.');
  if (!channel) throw new Error('CHANNEL_ID must be set in .env');

  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 5,
    connection: ConnectionTCPObfuscated, // same rationale as src/reader.js
  });
  client.setLogLevel('none');

  console.log(`Connecting to Telegram...`);
  await client.connect();
  if (!(await client.isUserAuthorized())) {
    await client.destroy().catch(() => {});
    throw new Error('session is not authorized — regenerate with `npm run login`');
  }

  // Warm the entity cache before resolving. A StringSession that has not
  // fetched its dialog list this connection cannot resolve a bare -100…
  // channel id — getEntity() fails with "Could not find the input entity".
  // src/reader.js calls getDialogs() at startup for the same reason.
  try {
    await client.getDialogs({ limit: 200 });
  } catch (e) {
    console.log(`  (getDialogs warm-up failed: ${e.message})`);
  }

  let entity;
  try {
    entity = await client.getEntity(channel);
  } catch (e) {
    // GramJS's raw "Could not find the input entity" says nothing about the
    // actual cause, which is almost always that this account is not a member of
    // the channel. Translate it, since it is the single most likely way this
    // script fails and the fix is not guessable from the original message.
    const me = await client.getMe().catch(() => null);
    await client.destroy().catch(() => {});
    throw new Error(
      `cannot access channel ${channel} as account ${me?.id ?? '(unknown)'}.\n` +
        `  This account is almost certainly not a member of that channel — a private\n` +
        `  channel cannot be resolved, let alone read, by a non-member.\n` +
        `  Fix either way:\n` +
        `    a) invite user id ${me?.id ?? '<this account>'} to the channel, then re-run; or\n` +
        `    b) run \`npm run login\` as the account that owns the channel and put the\n` +
        `       printed session in BACKFILL_TG_SESSION (leaves TG_SESSION alone).\n` +
        `  Original error: ${e.message}`
    );
  }
  console.log(`Reading history of ${entity?.title || channel}...`);

  const messages = [];
  for await (const msg of client.iterMessages(entity, MSG_LIMIT ? { limit: MSG_LIMIT } : {})) {
    messages.push(msg);
    if (messages.length % 200 === 0) console.log(`  ...${messages.length} messages`);
  }
  await client.destroy().catch(() => {});
  console.log(`Read ${messages.length} messages.\n`);

  messages.sort((a, b) => a.id - b.id); // oldest first
  return messages;
}

// ---------------------------------------------------------------------------
// Preflight: prove SITE_TRACKING_ID exists before spending the whole archive
// ---------------------------------------------------------------------------
// A tracking id that isn't in your Portals account does not reliably produce an
// API error — link.generate can hand back a link that simply never attributes.
// That fails silently and costs real commission, so verify it on ONE product
// and abort the run if it doesn't come back clean.

async function preflight(siteClient, canonicalUrl) {
  console.log(`Preflight: generating one link under tracking id "${SITE_TRACKING_ID}"...`);
  let resp;
  try {
    resp = await siteClient.generateLinks([canonicalUrl], { promotionLinkType: '2' });
  } catch (e) {
    throw new Error(
      `link.generate failed under "${SITE_TRACKING_ID}": ${e.message}\n` +
        `  If this says the tracking id is unknown, create it in AliExpress Portals\n` +
        `  (Ad Center → Tracking ID) and re-run, or pass SITE_TRACKING_ID=<existing id>.`
    );
  }
  const link = readLink(resp);
  if (!link) {
    throw new Error(
      `link.generate returned no promotion_link under "${SITE_TRACKING_ID}".\n` +
        `  The tracking id most likely does not exist in your Portals account.\n` +
        `  Create it there, or re-run with SITE_TRACKING_ID=${process.env.ALI_TRACKING_ID}\n` +
        `  to fall back to your channel id (site revenue will not be separable).\n` +
        `  Raw response: ${JSON.stringify(resp).slice(0, 400)}`
    );
  }
  console.log(`Preflight OK — ${link}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const messages = await readChannelHistory();

  const parsed = [];
  const parseFailures = [];
  for (const msg of messages) {
    const r = parseMessage(msg);
    if (!r) continue; // not a deal post (announcement, etc.)
    if (r.ok) parsed.push(r);
    else parseFailures.push(r);
  }

  console.log(`Deal-shaped messages: ${parsed.length + parseFailures.length}`);
  console.log(`  parsed OK:      ${parsed.length}`);
  console.log(`  failed to parse:${parseFailures.length}\n`);

  if (parseFailures.length) {
    console.log('Failed to parse:');
    for (const f of parseFailures.slice(0, 40)) {
      console.log(`  msg ${f.messageId} [${f.reason}] ${(f.name || '(no name)').slice(0, 60)}`);
    }
    if (parseFailures.length > 40) console.log(`  ...and ${parseFailures.length - 40} more`);
    console.log('');
  }

  if (INSPECT) {
    console.log('--- INSPECT (no AliExpress calls) ---');
    for (const p of parsed) {
      console.log(
        `  ${p.postedAt?.slice(0, 10)} | ${p.name.slice(0, 45).padEnd(45)} | ` +
          `set=${p.setId ?? '-'} pieces=${p.pieces ?? '-'} price=${p.archivedPrice ?? '-'} | ${p.link?.slice(0, 45)}`
      );
    }
    console.log(`\n${parsed.length} deals parsed. Re-run without --inspect to fetch live data.`);
    return;
  }

  // Existing output, for --resume.
  const existing = new Map();
  if (RESUME) {
    try {
      for (const d of JSON.parse(readFileSync(OUT_PATH, 'utf8'))) existing.set(d.productId, d);
      console.log(`Resuming — ${existing.size} products already in ${OUT_PATH}\n`);
    } catch {
      console.log(`Resume requested but ${OUT_PATH} unreadable — starting fresh\n`);
    }
  }

  const detailClient = makeClient(); // ALI_TRACKING_ID, for productdetail.get
  const siteClient = makeClient({ ...process.env, ALI_TRACKING_ID: SITE_TRACKING_ID });

  const stats = {
    recovered: 0,
    skippedDelisted: 0,
    failedToParse: parseFailures.length,
    failedApi: 0,
    failedResolve: 0,
    duplicates: 0,
    resumedSkipped: 0,
  };

  const byProductId = new Map(existing);
  let preflightDone = false;

  const save = () => {
    // Newest first; absent fields omitted, never written as null.
    const out = [...byProductId.values()].sort((a, b) =>
      String(b.postedAt || '').localeCompare(String(a.postedAt || ''))
    );
    mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    // Atomic, matching src/store.js and src/deals.js. This matters more here
    // than it looks: OUT_PATH is the LIVE web root feed, and this runs every
    // CHECKPOINT_EVERY records for tens of minutes, so a plain writeFileSync
    // would give visitors a real chance of fetching a half-written array.
    const tmp = OUT_PATH + '.tmp';
    writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8');
    renameSync(tmp, OUT_PATH);
    return out.length;
  };

  for (const [i, deal] of parsed.entries()) {
    const tag = `[${i + 1}/${parsed.length}]`;

    // 1. Resolve the archived s.click link to a product id.
    let productId;
    let canonicalUrl;
    try {
      const r = await resolveToProductId(deal.link);
      productId = r.productId;
      canonicalUrl = r.canonicalUrl;
    } catch (e) {
      console.log(`${tag} resolve threw — ${e.message}`);
    }
    if (!productId) {
      stats.failedResolve++;
      console.log(`${tag} ✗ could not resolve link — ${deal.name.slice(0, 40)}`);
      await sleep(ITEM_DELAY_MS);
      continue;
    }

    if (byProductId.has(productId)) {
      // SEEN_TTL_DAYS is a 10-day cooldown, not a permanent guarantee, so the
      // same product legitimately appears more than once in the archive.
      // Messages are processed oldest-first, so `postedAt` already holds the
      // first time it ran — keep that, but take the name from the *newest* post,
      // since a later repost reflects the most recent curation (possibly an ✏️
      // edit). No API call either way.
      if (RESUME && existing.has(productId)) {
        stats.resumedSkipped++;
      } else {
        const prev = byProductId.get(productId);
        prev.name = deal.name;
        if (deal.setId && !prev.setId) prev.setId = String(deal.setId);
        if (deal.pieces && !prev.pieces) prev.pieces = deal.pieces;
        stats.duplicates++;
      }
      await sleep(ITEM_DELAY_MS);
      continue;
    }

    // 2. Preflight the site tracking id once, on the first real product.
    if (!preflightDone) {
      await preflight(siteClient, canonicalUrl);
      preflightDone = true;
    }

    // 3. Fresh price / image / availability. aliClient handles rate-limit retry.
    let product;
    try {
      const resp = await detailClient.productDetail([productId], {
        targetCurrency: CURRENCY,
        targetLanguage: process.env.TARGET_LANGUAGE || 'he',
        country: process.env.TARGET_COUNTRY || 'IL',
      });
      product = readProduct(resp);
    } catch (e) {
      stats.failedApi++;
      console.log(`${tag} ✗ API error ${productId} — ${e.message}`);
      await sleep(ITEM_DELAY_MS);
      continue;
    }

    // Delisted / unavailable: no record returned, no title, or no sale price.
    if (!product || !product.title || !product.price) {
      stats.skippedDelisted++;
      console.log(`${tag} ⊘ delisted/unavailable ${productId} — ${deal.name.slice(0, 40)}`);
      await sleep(ITEM_DELAY_MS);
      continue;
    }

    // 4. Regenerate the link under the site tracking id.
    let link = null;
    try {
      link = readLink(await siteClient.generateLinks([canonicalUrl], { promotionLinkType: '2' }));
    } catch (e) {
      console.log(`${tag} link.generate failed — ${e.message}`);
    }
    if (!link) link = product.promotionLink;
    if (!link) {
      stats.failedApi++;
      console.log(`${tag} ✗ no affiliate link for ${productId}`);
      await sleep(ITEM_DELAY_MS);
      continue;
    }

    // 5. Archived curation + fresh commerce data. Omit absent fields.
    const stars = product.stars ?? deal.archivedStars;
    const record = {
      productId: String(productId),
      name: deal.name,
      ...(deal.setId ? { setId: String(deal.setId) } : {}),
      ...(deal.pieces ? { pieces: deal.pieces } : {}),
      price: product.price,
      ...(product.originalPrice ? { originalPrice: product.originalPrice } : {}),
      currency: CURRENCY,
      ...(stars ? { stars } : {}),
      ...(product.image ? { image: product.image } : {}),
      ...(detectTheme(deal.name) ? { theme: detectTheme(deal.name) } : {}),
      link,
      ...(deal.postedAt ? { postedAt: deal.postedAt } : {}),
      priceCheckedAt: new Date().toISOString(),
    };
    byProductId.set(String(productId), record);
    stats.recovered++;
    console.log(`${tag} ✓ ${productId} ${deal.name.slice(0, 40)} — ${product.price} ${CURRENCY}`);

    if (stats.recovered % CHECKPOINT_EVERY === 0) save();
    await sleep(ITEM_DELAY_MS);
  }

  const written = save();

  console.log('\n─── summary ─────────────────────────────');
  console.log(`  recovered:          ${stats.recovered}`);
  console.log(`  skipped (delisted): ${stats.skippedDelisted}`);
  console.log(`  failed to parse:    ${stats.failedToParse}`);
  console.log(`  failed (API):       ${stats.failedApi}`);
  console.log(`  failed (resolve):   ${stats.failedResolve}`);
  console.log(`  duplicate products: ${stats.duplicates}`);
  if (RESUME) console.log(`  skipped (resume):   ${stats.resumedSkipped}`);
  console.log(`  ─────────────────────────────────────`);
  console.log(`  written to ${OUT_PATH}: ${written} deals`);
  console.log(`  tracking id: ${SITE_TRACKING_ID}`);
}

// Only run when invoked directly, so the parser above can be imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`\nFATAL: ${e.message}`);
    process.exit(1);
  });
}
