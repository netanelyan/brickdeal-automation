// Shrinks the long affiliate link to a short URL so it fits a photo caption.
// Falls back to the original link if the shortener is unreachable.
export async function shorten(url) {
  try {
    const r = await fetch('https://is.gd/create.php?format=simple&url=' + encodeURIComponent(url));
    if (!r.ok) return url;
    const s = (await r.text()).trim();
    return s.startsWith('http') ? s : url;
  } catch {
    return url;
  }
}
