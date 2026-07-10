const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Post format (Hebrew). Clean clickable order link keeps the long affiliate
// URL out of the visible text so the product photo attaches. Empty lines skip.
export function formatMessage(product, link, opts = {}) {
  const disclosure = opts.disclosure ?? process.env.DISCLOSURE ?? '';
  const brand = opts.brandName ?? process.env.BRAND_NAME ?? '';

  const lines = [`*${clean(product.title)}*`, ''];

  if (product.setId) lines.push(`🆔 מק״ט ${product.setId}`);
  if (product.pieces) lines.push(`🧱 ${product.pieces} חלקים`);
  if (product.salePrice) lines.push(`💳 מחיר ${product.salePrice}₪`);
  lines.push('🛍️ תואם מקור');
  if (product.stars) lines.push(`🌟 ${product.stars} כוכבים`);

  lines.push('', `[קישור להזמנה 🛒](${link})`);

  if (brand) lines.push('', brand);
  if (disclosure) lines.push(`_${disclosure}_`);

  return lines.join('\n');
}
