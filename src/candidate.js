import { urlToMessage } from './engine.js';
import { resolveToProductId } from './resolve.js';
import { formatMessage } from './format.js';
import { extractSetIdFromText, extractPiecesFromText } from './sourceText.js';

export const hasAliKeys = () =>
  Boolean(process.env.ALI_APP_KEY && process.env.ALI_APP_SECRET && process.env.ALI_TRACKING_ID);

// Turn a raw URL into a ready-to-stage candidate.
// With AliExpress keys: real title/price/affiliate link.
// Without keys: a MOCK so you can wire up and test the whole Telegram
// pipeline (approve -> queue -> drip -> publish) today.
// sourceText is the surrounding message text when the URL came from a
// watched source channel (empty for manual forwards) — used to fill in the
// set number / piece count when the AliExpress title doesn't have them.
// `resolved` — see urlToMessage()'s doc comment in engine.js — is the
// caller's already-computed resolveToProductId(url) result, so it doesn't
// get resolved a second time here.
export async function toCandidate(url, sourceText = '', resolved = null) {
  if (hasAliKeys()) {
    const r = await urlToMessage(url, { sourceText, resolved });
    if (!r.ok) return { ok: false, reason: r.reason, productId: r.productId };
    return {
      ok: true,
      productId: r.productId,
      message: r.message,
      image: r.product.image || null,
      link: r.link,
      setId: r.product.setId || null,
      pieces: r.product.pieces || null,
      stars: r.product.stars || null,
      // Carried purely so src/deals.js can build the website record after the
      // deal posts. Nothing in staging/approval/dedupe/drip reads these — the
      // Telegram message is still rendered from the engine product, upstream.
      // Without them the name and price would exist only inside `message`, and
      // the feed would have to re-parse its own output to recover them.
      name: r.product.title || null,
      targetPrice: r.product.targetPrice ?? null,
      targetOriginalPrice: r.product.targetOriginalPrice ?? null,
      targetCurrency: r.product.targetCurrency ?? null,
    };
  }

  const { productId } = resolved || (await resolveToProductId(url));
  if (!productId) return { ok: false, reason: 'no_product_id' };
  const setId = extractSetIdFromText(sourceText);
  const pieces = extractPiecesFromText(sourceText);
  const message =
    formatMessage(
      {
        title: `[MOCK] product ${productId}`,
        salePrice: '00.00',
        originalPrice: null,
        discountPct: null,
        setId,
        pieces,
      },
      url
    ) + '\n\n_(mock — add AliExpress keys for real links)_';
  return { ok: true, productId, message, image: null, link: url, mock: true, setId, pieces, stars: null };
}
