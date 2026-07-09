import { AliClient } from './aliClient.js';
import { resolveToProductId } from './resolve.js';
import { formatMessage } from './format.js';
import { polish } from './polish.js';
import { shorten } from './shorten.js';

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
  const m = String(c).match(/^(https?:\/\/[^\s]+?\.(?:jpg|jpeg|png|webp))/i);
  return m ? m[1] : String(c);
}

function extractPieces(title) {
  const m = String(title).match(/(\d[\d,]{1,6})\s*(?:pcs|pieces|piece|חלקים)/i);
  return m ? m[1].replace(/,/g, '') : null;
}
function extractSetId(title) {
  const m = String(title).match(/(?:model|set|no\.?|#)\s*[:#]?\s*(\d{3,6})/i);
  return m ? m[1] : null;
}
function toStars(p) {
  const direct = num(p.avg_evaluation_rating) ?? num(p.evaluation_rating);
  if (direct && direct <= 5) return direct.toFixed(1);
  const rate = String(p.evaluate_rate || '').match(/([\d.]+)\s*%/);
  if (rate) return (Number(rate[1]) / 20).toFixed(1);
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

  return {
    id: p.product_id,
    title: p.product_title,
    salePrice: sale,
    originalPrice: orig,
    discountPct,
    image: pickImage(p),
    commissionRate: p.commission_rate ?? p.hot_product_commission_rate,
    promotionLink: p.promotion_link,
    pieces: extractPieces(p.product_title),
    setId: extractSetId(p.product_title),
    stars: toStars(p),
    raw: p,
  };
}

function parseLink(resp) {
  const result =
    dig(resp, 'aliexpress_affiliate_link_generate_response.resp_result.result') ||
    dig(resp, 'resp_result.result');
  const arr = dig(result, 'promotion_links.promotion_link') || [];
  const first = Array.isArray(arr) ? arr[0] : arr;
  return first?.promotion_link || null;
}

export async function urlToMessage(input, { client = makeClient(), debug = false } = {}) {
  const { productId, canonicalUrl, resolvedFrom } = await resolveToProductId(input);
  if (!productId) return { ok: false, reason: 'no_product_id', input };

  const detailResp = await client.productDetail([productId], {
    targetCurrency: process.env.TARGET_CURRENCY || 'ILS',
    targetLanguage: process.env.TARGET_LANGUAGE || 'he',
    country: process.env.TARGET_COUNTRY || 'IL',
  });
  if (debug) console.error('--- productdetail.get ---\n', JSON.stringify(detailResp, null, 2));

  const product = parseProduct(detailResp);
  if (!product || !product.title) return { ok: false, reason: 'not_promotable', productId };

  let link = product.promotionLink;
  if (!link) {
    const linkResp = await client.generateLinks([canonicalUrl]);
    if (debug) console.error('--- link.generate ---\n', JSON.stringify(linkResp, null, 2));
    link = parseLink(linkResp);
  }
  if (!link) return { ok: false, reason: 'no_link', productId, product };

  // AI-polish the Hebrew name + pull set id / pieces (no-op without a key)
  const p = await polish(product.title);
  if (p.title) product.title = p.title;
  if (p.setId) product.setId = p.setId;
  if (p.pieces) product.pieces = p.pieces;

  const shortLink = await shorten(link);

  return {
    ok: true,
    message: formatMessage(product, shortLink),
    product,
    link: shortLink,
    productId,
    resolvedFrom,
  };
}
