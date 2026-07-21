import { AliClient } from './aliClient.js';
import { resolveToProductId } from './resolve.js';
import { formatMessage } from './format.js';
import { polish } from './polish.js';
import { shorten } from './shorten.js';
import { extractSetIdFromText, extractPiecesFromText } from './sourceText.js';

export function makeClient(env = process.env) {
  return new AliClient({
    appKey: env.ALI_APP_KEY,
    appSecret: env.ALI_APP_SECRET,
    trackingId: env.ALI_TRACKING_ID,
    appSignature: env.ALI_APP_SIGNATURE || '',
  });
}

const dig = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);

function pickImage(p) {
  const c =
    p.product_main_image_url ||
    dig(p, 'product_small_image_urls.string.0') ||
    dig(p, 'product_small_image_urls.0') ||
    p.image_url ||
    null;
  if (!c) return null;
  // AliExpress image URLs sometimes trail off into resize/tracking params
  // after the real extension — trim to the base file so Telegram gets a
  // clean, direct image URL instead of whatever was tacked on after it.
  const m = String(c).match(/^(https?:\/\/[^\s]+?\.(?:jpg|jpeg|png|webp))/i);
  return m ? m[1] : String(c);
}

// AliExpress's API has no structured "LEGO set number" or "piece count"
// field — these are just best-effort scrapes of whatever the seller wrote
// in the title. src/sourceText.js covers the same ground for the channel
// message text, used as a second fallback when this comes up empty.
function extractPieces(title) {
  const m = String(title).match(/(\d[\d,]{1,6})\s*(?:pcs|pieces|piece|חלקים)/i);
  return m ? m[1].replace(/,/g, '') : null;
}
function extractSetId(title) {
  const m = String(title).match(/(?:model|set|no\.?|#)\s*[:#]?\s*(\d{3,6})/i);
  return m ? m[1] : null;
}
function toStars(p) {
  // 5-scale rating fields
  const direct =
    num(p.avg_evaluation_rating) ??
    num(p.evaluation_rating) ??
    num(p.evaluation) ??
    num(p.product_evaluation_rating) ??
    num(p.avg_rating) ??
    num(p.rating);
  if (direct && direct > 0 && direct <= 5) return direct.toFixed(1);
  // percentage-style fields (positive feedback) -> convert to 5-scale
  const pctRaw =
    p.evaluate_rate ??
    p.product_evaluation_rate ??
    p.positive_feedback_rate ??
    p.evaluation_rate ??
    '';
  const rate = String(pctRaw).match(/([\d.]+)\s*%?/);
  if (rate && Number(rate[1]) > 5) return (Number(rate[1]) / 20).toFixed(1);
  return null;
}

function parseProduct(resp) {
  const result =
    dig(resp, 'aliexpress_affiliate_productdetail_get_response.resp_result.result') ||
    dig(resp, 'resp_result.result');
  const arr = dig(result, 'products.product') || dig(result, 'products') || [];
  const p = Array.isArray(arr) ? arr[0] : arr;
  if (!p || (!p.product_title && !p.product_id)) return null;

  const sale = p.target_sale_price ?? p.sale_price;
  const orig = p.target_original_price ?? p.original_price;
  let discountPct = p.discount ? String(p.discount).replace('%', '') : null;
  if (!discountPct && Number(orig) > Number(sale) && Number(orig) > 0) {
    discountPct = Math.round((1 - Number(sale) / Number(orig)) * 100).toString();
  }

  // Currency-verified pair, for anything that publishes a price claim outside
  // Telegram (src/deals.js -> the website's deals.json).
  //
  // `salePrice`/`originalPrice` above fall back to `sale_price`/`original_price`,
  // which a live response shows are quoted in CNY while the target_* pair is in
  // ILS — a verified example returned target 54.35/67.94 ILS alongside
  // 117.83/147.29 CNY. If target_original_price were ever absent, that fallback
  // would pair a CNY "original" with an ILS sale price and manufacture a ~63%
  // discount out of an exchange rate. Struck-through prices on the site are a
  // price claim, so these fields are taken ONLY from target_* and only when the
  // response states the currency it promised. Absent beats wrong.
  const wantCurrency = (process.env.TARGET_CURRENCY || 'ILS').toUpperCase();
  const okCurrency = (c) => String(c || '').toUpperCase() === wantCurrency;

  const targetPrice = okCurrency(p.target_sale_price_currency) ? num(p.target_sale_price) : null;
  const targetOriginalPrice =
    okCurrency(p.target_original_price_currency) ? num(p.target_original_price) : null;

  return {
    id: p.product_id,
    title: p.product_title,
    salePrice: sale,
    originalPrice: orig,
    discountPct,
    targetPrice,
    targetOriginalPrice,
    targetCurrency: targetPrice === null ? null : wantCurrency,
    image: pickImage(p),
    commissionRate: p.commission_rate ?? p.hot_product_commission_rate,
    promotionLink: p.promotion_link,
    pieces: extractPieces(p.product_title),
    setId: extractSetId(p.product_title),
    stars: toStars(p),
    raw: p,
  };
}

async function genShortLink(client, url, debug) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await client.generateLinks([url], { promotionLinkType: '2' });
      if (debug) console.error('--- link.generate ---\n', JSON.stringify(r, null, 2));
      const l = parseLink(r);
      if (l) return l;
    } catch (err) {
      if (debug) console.error(`generate attempt ${i + 1} failed:`, err.message);
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  return null;
}

function parseLink(resp) {
  const result =
    dig(resp, 'aliexpress_affiliate_link_generate_response.resp_result.result') ||
    dig(resp, 'resp_result.result');
  const arr = dig(result, 'promotion_links.promotion_link') || [];
  const first = Array.isArray(arr) ? arr[0] : arr;
  return first?.promotion_link || null;
}

// `resolved` lets a caller that already ran resolveToProductId() (ingest()'s
// pre-dedupe-check resolution, in bot.js) pass that result straight through
// instead of resolving the same URL a second time — resolveToProductId()
// hits the network to follow short-link redirects, so skipping the repeat
// avoids doubling that request on every single ingest.
export async function urlToMessage(input, { client = makeClient(), debug = false, sourceText = '', resolved = null } = {}) {
  const { productId, canonicalUrl, resolvedFrom } = resolved || (await resolveToProductId(input));
  if (!productId) return { ok: false, reason: 'no_product_id', input };

  // Previously uncaught: a thrown error here (network blip, AliExpress
  // rate-limit/5xx, or aliClient's own new request timeout) unwound straight
  // out of this function. Callers did catch it eventually (reader.js's
  // per-event try/catch), but it never became a countable candidate result —
  // it just vanished from /status's numbers while `stats.seen` had already
  // been incremented, which was part of why "seen" and the tracked skip
  // reasons never added up.
  let detailResp;
  try {
    detailResp = await client.productDetail([productId], {
      targetCurrency: process.env.TARGET_CURRENCY || 'ILS',
      targetLanguage: process.env.TARGET_LANGUAGE || 'he',
      country: process.env.TARGET_COUNTRY || 'IL',
    });
  } catch (e) {
    if (debug) console.error('--- productdetail.get failed ---\n', e.message);
    return { ok: false, reason: e.code === 'TIMEOUT' ? 'timeout' : 'api_error', productId };
  }
  if (debug) console.error('--- productdetail.get ---\n', JSON.stringify(detailResp, null, 2));

  const product = parseProduct(detailResp);
  if (!product || !product.title) return { ok: false, reason: 'not_promotable', productId };

  // Ask AliExpress for its SHORT link (type 2): native s.click/e/_ URL — no
  // third party, no preview page. Retry so a transient rate-limit doesn't drop
  // us to the long link.
  let link = await genShortLink(client, canonicalUrl, debug);
  if (!link) link = product.promotionLink; // last-resort fallback
  if (!link) return { ok: false, reason: 'no_link', productId, product };
  if (link.length > 150) link = await shorten(link); // only fires on the fallback

  // AI-polish the Hebrew name + pull set id / pieces (no-op without a key)
  const p = await polish(product.title, product.setId);
  if (p.title) product.title = p.title;
  if (p.setId) product.setId = p.setId;
  if (p.pieces) product.pieces = p.pieces;

  // Source channels often post the official set number / piece count right
  // in the message text — fall back to that when the AliExpress title didn't
  // give us one (manual forwards have no sourceText, so this is a no-op then).
  if (!product.setId) {
    const setId = extractSetIdFromText(sourceText);
    if (setId) product.setId = setId;
  }
  if (!product.pieces) {
    const pieces = extractPiecesFromText(sourceText);
    if (pieces) product.pieces = pieces;
  }

  return {
    ok: true,
    message: formatMessage(product, link),
    product,
    link,
    productId,
    resolvedFrom,
  };
}
