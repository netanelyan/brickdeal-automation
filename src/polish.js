// Optional: turn AliExpress's messy title into a clean, appealing Hebrew name,
// and pull out the set id + piece count. Needs ANTHROPIC_API_KEY.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

const PROMPT = `You are naming products for a Hebrew LEGO store. You're given (a) a possible set number and (b) the raw AliExpress title for the same item.

Follow these steps, in order:
1. If you recognize the set number, or recognize the item itself as a real, official LEGO set, use its OFFICIAL set name — rendered the natural Hebrew way a LEGO fan would actually say it. Examples: "זר הפרחים", "הפורד אנגליה המעופפת - הארי פוטר", "מגדל אורבן".
2. If you don't recognize it, invent a clean, LEGO-store-style name based on its theme — evocative and product-like, like something printed on a shelf label. NOT a literal description of what it's made of, and NOT a summary of the listing. Never use "סט ... לבנייה" as filler. Never describe it as a generic craft/botanical/collection item.

Think "what would this set be called on a shelf," not "what does this listing say."

Rules for the name itself:
- Native, fluent Hebrew — never a literal/machine translation.
- Short: 2-5 words.
- Include the franchise/character/theme if identifiable (Harry Potter, Star Wars, Marvel, Technic, city, etc.), transliterated the way Israelis actually say it.
- No emojis, no quotes, no English unless Israelis genuinely use that word, no piece counts or model numbers in the name.
- Never clickbait, never "!!!", never "מבצע/חם/איכותי".

Return ONLY a JSON object, no markdown:
{"title": "<name>", "set_id": <number or null>, "pieces": <number or null>}

`;

export async function polish(title, setId = null) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return {};
  try {
    const input = `Possible set number: ${setId || '(none found)'}\nRaw AliExpress title: ${title}`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        messages: [{ role: 'user', content: PROMPT + input }],
      }),
    });
    if (!res.ok) return {};
    const data = await res.json();
    let text = (data.content || []).map((b) => b.text || '').join('').trim();
    text = text.replace(/^```json/i, '').replace(/```$/, '').trim();
    const j = JSON.parse(text);
    return {
      title: j.title || null,
      setId: j.set_id != null ? String(j.set_id) : null,
      pieces: j.pieces != null ? String(j.pieces) : null,
    };
  } catch {
    return {};
  }
}
