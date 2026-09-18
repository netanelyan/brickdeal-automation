// Swap the seller's AliExpress photo for the official LEGO render of the set,
// so the channel and the website show every set in the same clean style
// instead of a random mix of studio shots, phone photos and watermarks.
//
// Two guards, because a wrong official image is worse than an ugly one:
//  - The render only exists for real set numbers (Brickset/BrickLink 404
//    otherwise), which already filters out most scraped garbage.
//  - The set number itself comes from seller titles and is often wrong (see
//    polish.js), so before swapping, a cheap vision call compares the seller
//    photo against the render and has to say they're the same model. No
//    ANTHROPIC_API_KEY means no verification means no swap.
//
// OFFICIAL_IMAGES=false turns the whole thing off.

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

// Public, stable, no API key. Brickset first: ~600px and ~100KB, which suits a
// Telegram photo; BrickLink as a fallback for sets Brickset hasn't pictured.
const SOURCES = [
  (id) => `https://images.brickset.com/sets/images/${id}-1.jpg`,
  (id) => `https://img.bricklink.com/ItemImage/SN/0/${id}-1.png`,
];

const enabled = () => String(process.env.OFFICIAL_IMAGES ?? 'true').toLowerCase() !== 'false';

async function exists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    return res.ok && /^image\//i.test(res.headers.get('content-type') || '');
  } catch {
    return false;
  }
}

// First source that actually has a render for this set number, or null.
export async function findOfficialImage(setId) {
  const id = String(setId || '').trim();
  if (!/^\d{3,6}$/.test(id)) return null;
  for (const src of SOURCES) {
    const url = src(id);
    if (await exists(url)) return url;
  }
  return null;
}

const VERIFY_PROMPT = `Image 1 is a marketplace seller's photo of a brick-building set. Image 2 is the official product render of LEGO set {id}.

Is the model in image 1 the same build as image 2? Judge by the built model itself: shape, colours, main features, figures. Ignore brand, packaging, background, angle and photo quality. A different set from the same franchise, a different scale, or a different vehicle/building of the same kind is NOT a match. If image 1 doesn't show a built model at all, it is NOT a match.

Return ONLY a JSON object, no markdown: {"match": true or false}`;

// Both images are fetched by Anthropic from their URLs. Any failure — dead
// image, API error, unparseable answer — is a "no", never a swap.
export async function verifySameSet(sellerImage, officialImage, setId) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return false;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 30,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'url', url: sellerImage } },
              { type: 'image', source: { type: 'url', url: officialImage } },
              { type: 'text', text: VERIFY_PROMPT.replace('{id}', String(setId)) },
            ],
          },
        ],
      }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    let text = (data.content || []).map((b) => b.text || '').join('').trim();
    text = text.replace(/^```json/i, '').replace(/```$/, '').trim();
    return JSON.parse(text).match === true;
  } catch {
    return false;
  }
}

// The official render URL to use in place of `sellerImage` for `setId`, or
// null to keep the seller photo. `debug` logs why to stderr.
export async function officialImageFor(setId, sellerImage, debug = false) {
  if (!enabled() || !setId || !sellerImage) return null;
  const official = await findOfficialImage(setId);
  if (!official) {
    if (debug) console.error(`setImage: no official render for ${setId}`);
    return null;
  }
  const ok = await verifySameSet(sellerImage, official, setId);
  if (debug) console.error(`setImage: ${setId} ${ok ? 'verified' : 'REJECTED'} ${official}`);
  return ok ? official : null;
}
