// Turn AliExpress's messy title into a clean, appealing Hebrew name, and pull
// out the set id + piece count. Needs ANTHROPIC_API_KEY.
//
// Every name follows one template: "תמה | שם הדגם" — franchise/category first,
// model name second. Two reasons it's a template and not free-form prose:
//  - A feed of same-shaped titles scans; the old free-form names each had a
//    different shape ("דאנק מוקצה אישי", "דוב שמנמן - בית החג") and read as noise.
//  - src/themes.js keyword-matches the polished name to file the deal on the
//    website. Leading with the theme means the keyword is reliably present
//    instead of only showing up when the model happened to mention it.
//
// The model returns `theme` and `name` as separate fields and WE join them —
// asking for a pre-joined string invites format drift (missing separator, a
// dash instead of a pipe, the parts swapped), and there'd be no way to tell a
// drifted title from an intentional one.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

const PROMPT = `You are naming products for a Hebrew LEGO store. You're given the raw AliExpress title, a possible set number, and usually the product photo.

THE PHOTO IS THE SOURCE OF TRUTH. The set number is scraped out of the seller's title and is frequently wrong or belongs to a different set entirely; the raw title is machine-translated keyword spam. When the photo and the number disagree, believe the photo and ignore the number. Never name the item something the photo does not show — an alien figure named "מערכת השמש" loses the sale and the trust.

Only use an official LEGO set name if you actually recognize the item IN THE PHOTO as that set. If you don't recognize it, name what you can see. Never guess an official name from the number alone.

Return two parts:

THEME — the franchise, license or category, in Hebrew, 1-3 words. Prefer a franchise Israelis name out loud when there is one ("הארי פוטר", "מלחמת הכוכבים", "מארוול", "באטמן", "פוקימון", "מיינקראפט", "נינג׳גו", "דיסני", "הורייזן"). Otherwise a real category: "טכניק", "ארכיטקטורה", "חללית", "דינוזאורים", "רכבת", "ספינה", "פרחים", "מכוניות", "טירה", "דרקונים", "דמויות אספנות", "מוק מותאם אישית". Never "לגו", never "סט", never "מבצע", never a made-up franchise.

NAME — what the thing is, in Hebrew, 2-4 words. Evocative and product-like, the way it'd read on a shelf label. Not a description of the materials, not a summary of the listing, not the theme repeated.

Rules for both parts:
- Native, fluent Hebrew — never a literal or machine translation.
- No emojis, no quotes, no brackets, no "|", no piece counts, no model numbers, no prices.
- No clickbait, no "!", no "חם/איכותי/מבצע/מומלץ".
- English only where Israelis genuinely use the word.

Good: {"theme":"הורייזן","name":"הנחש ארוך הצוואר"} · {"theme":"סרטי קאלט","name":"אי.טי החייזר"} · {"theme":"הארי פוטר","name":"הפורד אנגליה המעופפת"} · {"theme":"פרחים","name":"זר הפרחים"}

set_id: the official set number ONLY if it's stated in the raw title or you're certain of it from the photo — otherwise null. pieces: only if stated in the raw title — otherwise null.

Return ONLY a JSON object, no markdown:
{"theme": "<theme>", "name": "<name>", "set_id": <number or null>, "pieces": <number or null>}

`;

// Emoji, quote marks, brackets, the separator itself, and stray leading or
// trailing punctuation — anything that would break the template's shape if the
// model slipped it into a part.
const STRIP_RE = /[\p{Extended_Pictographic}←-⇿☀-➿️"'״׳“”‘’`()[\]{}|<>*_~#]/gu;
const EDGE_PUNCT_RE = /^[\s\p{P}]+|[\s\p{P}]+$/gu;

const MAX_WORDS = { theme: 3, name: 5 };

// A part is usable only if it survives cleaning as real Hebrew. Latin-only
// output means the model echoed the English listing instead of naming it.
function cleanPart(raw, kind) {
  const s = String(raw || '')
    .replace(STRIP_RE, ' ')
    .replace(EDGE_PUNCT_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || !/[֐-׿]/.test(s)) return null;
  const words = s.split(' ');
  return words.length > MAX_WORDS[kind] ? words.slice(0, MAX_WORDS[kind]).join(' ') : s;
}

function buildTitle(j) {
  const theme = cleanPart(j.theme, 'theme');
  const name = cleanPart(j.name, 'name');
  // Name carries the sale; theme is the qualifier. A missing theme still gives
  // a usable title, a missing name doesn't — better to fall back than to post
  // a bare category as the headline.
  if (!name) return null;
  if (!theme || theme === name) return name;
  return `${theme} | ${name}`;
}

async function call(key, content) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      messages: [{ role: 'user', content }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const data = await res.json();
  let text = (data.content || []).map((b) => b.text || '').join('').trim();
  text = text.replace(/^```json/i, '').replace(/```$/, '').trim();
  return JSON.parse(text);
}

// `image` is product.image — the AliExpress photo, passed so the model names
// what the item actually IS. Without it the model sees only keyword-spam text
// plus an unreliable set number, which is how an E.T. figure ended up posted as
// "מערכת השמש הנעה". Fetched by Anthropic from the URL, so a dead/unsupported
// image fails the whole request — hence the text-only retry below.
export async function polish(title, setId = null, image = null) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return {};

  const text = `${PROMPT}Possible set number: ${setId || '(none found)'}\nRaw AliExpress title: ${title}`;
  const usable = typeof image === 'string' && /^https?:\/\/.+\.(jpe?g|png|gif|webp)$/i.test(image);
  const withImage = [{ type: 'image', source: { type: 'url', url: image } }, { type: 'text', text }];

  let j;
  try {
    j = await call(key, usable ? withImage : text);
  } catch {
    if (!usable) return {};
    try {
      j = await call(key, text); // image unreachable — a text-only name beats none
    } catch {
      return {};
    }
  }

  return {
    title: buildTitle(j),
    setId: j.set_id != null ? String(j.set_id) : null,
    pieces: j.pieces != null ? String(j.pieces) : null,
  };
}
