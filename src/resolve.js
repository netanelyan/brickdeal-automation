// Turns anything a source group might post (full item URL, s.click short link,
// a.aliexpress link, or a bare product ID) into a clean numeric product ID.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// Standard product page: aliexpress.com/item/[slug_]1005012345678.html
const ITEM_RE = /\/item\/(?:[^/]*?_)?(\d{6,})\.html/i;
// Some app/share links carry the id as a query param instead of in the path.
const QUERY_ID_RE = /[?&](?:productId|product_id|itemId)=(\d{6,})/i;
// Some s.click short links land on a JS interstitial with no real URL — the
// id still shows up embedded in the page's own script/markup, so this scans
// raw HTML/JS text for the same shapes as ITEM_RE, plus a bare productId key.
const BODY_RE = /(?:\/item\/(?:[^/"']*?_)?|productId["':=\s]+)(\d{6,})/i;

const canonical = (id) => `https://www.aliexpress.com/item/${id}.html`;

export function extractIdFromUrl(url) {
  const s = String(url).trim();
  if (/^\d{6,}$/.test(s)) return s; // bare ID
  const m = s.match(ITEM_RE) || s.match(QUERY_ID_RE);
  return m ? m[1] : null;
}

// Pull every AliExpress-looking URL out of a chunk of message text.
export function extractUrls(text) {
  const re = /https?:\/\/[^\s<>"')]+aliexpress[^\s<>"')]*/gi;
  return [...new Set(String(text).match(re) || [])];
}

export async function resolveToProductId(input) {
  const raw = String(input).trim();

  // 1. Already contains an ID — no network needed.
  let id = extractIdFromUrl(raw);
  if (id) return { productId: id, canonicalUrl: canonical(id), resolvedFrom: 'direct' };

  // 2. Short link — follow redirects and re-check the final URL.
  let res;
  try {
    res = await fetch(raw, { redirect: 'follow', headers: { 'User-Agent': UA } });
  } catch (e) {
    return { productId: null, canonicalUrl: null, resolvedFrom: null, error: e.message };
  }
  id = extractIdFromUrl(res.url);
  if (id) return { productId: id, canonicalUrl: canonical(id), resolvedFrom: 'redirect' };

  // 3. Some short links land on a JS interstitial — scan the body as a fallback.
  try {
    const body = await res.text();
    const m = body.match(BODY_RE);
    if (m) return { productId: m[1], canonicalUrl: canonical(m[1]), resolvedFrom: 'body' };
  } catch {
    /* ignore */
  }

  return { productId: null, canonicalUrl: null, resolvedFrom: null };
}
