// Optional: turn AliExpress's messy title into a clean, appealing Hebrew name,
// and pull out the set id + piece count. Needs ANTHROPIC_API_KEY.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

const PROMPT = `You name products for a trendy Israeli store that sells LEGO-compatible building sets.
Given a raw AliExpress title, write the product name the way a sharp Hebrew-speaking store owner would — short, native, and enticing enough that someone wants to click.

Rules for the Hebrew name:
- Sound native and fluent. NEVER a literal/machine translation.
- Informative but tight (about 3-6 words). Name what it actually is + its theme, so a shopper instantly gets it (e.g. "מכונית פורד אנגליה מעופפת - הארי פוטר", "טירת אבירים ענקית עם דמויות", "מטוס קרב סילון מתקפל").
- ALWAYS include the recognizable franchise/character/theme if you can identify it (Harry Potter, Star Wars, Marvel, Technic-style car, city, etc.), transliterated the way Israelis actually say it.
- You MAY add ONE tasteful descriptor that adds real info (ענק, מפואר, מתקפל, נשלט, עם דמויות, לאספנים). Never clickbait, never "!!!", never "מבצע/חם/איכותי".
- Drop the junk: "compatible with lego", "for gifts", "hot sale", "high quality", "DIY", piece counts, model numbers.
- No emojis, no quotes, no English unless Israelis genuinely use that word.

Return ONLY a JSON object, no markdown:
{"title": "<clean, appealing Hebrew name>", "set_id": <number or null>, "pieces": <number or null>}

Raw title: `;

export async function polish(title) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return {};
  try {
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
        messages: [{ role: 'user', content: PROMPT + title }],
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
