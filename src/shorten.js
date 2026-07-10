// Fallback only — used when a link is still too long. v.gd/is.gd redirect
// straight through (no preview page); tinyurl is the last resort.
async function tryGet(url) {
  const r = await fetch(url);
  if (!r.ok) return null;
  const s = (await r.text()).trim();
  return s.startsWith('http') ? s : null;
}
export async function shorten(url) {
  const e = encodeURIComponent(url);
  const providers = [
    'https://v.gd/create.php?format=simple&url=' + e,
    'https://is.gd/create.php?format=simple&url=' + e,
    'https://tinyurl.com/api-create.php?url=' + e,
  ];
  for (const p of providers) {
    try {
      const s = await tryGet(p);
      if (s) return s;
    } catch {}
  }
  return url;
}
