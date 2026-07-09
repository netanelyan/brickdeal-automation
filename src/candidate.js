import { urlToMessage } from './engine.js';
import { resolveToProductId } from './resolve.js';
import { formatMessage } from './format.js';

export const hasAliKeys = () =>
  Boolean(process.env.ALI_APP_KEY && process.env.ALI_APP_SECRET && process.env.ALI_TRACKING_ID);

// Turn a raw URL into a ready-to-stage candidate.
// With AliExpress keys: real title/price/affiliate link.
// Without keys: a MOCK so you can wire up and test the whole Telegram
// pipeline (approve -> queue -> drip -> publish) today.
export async function toCandidate(url) {
  if (hasAliKeys()) {
    const r = await urlToMessage(url);
    if (!r.ok) return { ok: false, reason: r.reason, productId: r.productId };
    return {
      ok: true,
      productId: r.productId,
      message: r.message,
      image: r.product.image || null,
      link: r.link,
    };
  }

  const { productId } = await resolveToProductId(url);
  if (!productId) return { ok: false, reason: 'no_product_id' };
  const message =
    formatMessage(
      { title: `[MOCK] product ${productId}`, salePrice: '00.00', originalPrice: null, discountPct: null },
      url
    ) + '\n\n_(mock — add AliExpress keys for real links)_';
  return { ok: true, productId, message, image: null, link: url, mock: true };
}
