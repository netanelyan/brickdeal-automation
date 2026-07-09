// Optional: turn AliExpress's messy title into a clean, appealing Hebrew name,
// and pull out the set id + piece count. Needs ANTHROPIC_API_KEY.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

const PROMPT = `You name products for a trendy Israeli store that sells LEGO-compatible building sets.
Given a raw AliExpress title, write the product name the way a sharp Hebrew-speaking store owner would — short, native, and enticing enough that someone wants to click.

Rules for the Hebrew name:
- Sound native and fluent. NEVER a literal/machine translation.
- Short and punchy: theme + what it is (e.g. "מטוס קרב מתקפל", "טירת אבירים ענקית", "מכונית מירוץ פורמולה 1").
- You MAY add ONE tasteful, appealing descriptor if it fits the product (e.g. ענק, מפואר, מתקפל, נשלט, מדליק). Keep it classy — never clickbait, never "!!!", never "מבצע/חם/איכותי".
- Drop all junk: "compatible with lego", "for gifts", "hot sale", "high quality", "DIY", piece counts, model numbers.
- Keep a known franchise/character name if present, transliterated the way Israelis actually say it.
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
