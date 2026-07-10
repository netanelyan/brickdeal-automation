// Source channels (@clonesylego, @brickclones etc.) often post the official
// LEGO set number and piece count right in the message text, alongside the
// AliExpress link. This is a fallback source for those fields — used only
// when the AliExpress title (the primary source, see engine.js) doesn't
// yield one.

const MOC_RE = /\bMOC[-\s]?(\d{4,6})\b/i;
const HASH_RE = /#(\d{3,6})\b/;
const DASH_RE = /[-–—]\s*(\d{3,6})\b/;
const STANDALONE_RE = /(?<![\d.,])(\d{4,5})(?![\d.,])/g;

// Skip a standalone number if it's actually a piece count in disguise
// (e.g. "1994 pcs" / "1994 חלקים").
const PIECE_UNIT_AFTER_RE = /^\s*(pcs\.?|pieces?|חלקים)/i;

export function extractSetIdFromText(text) {
  const s = String(text || '');

  let m = s.match(MOC_RE);
  if (m) return `MOC-${m[1]}`;

  m = s.match(HASH_RE);
  if (m) return m[1];

  m = s.match(DASH_RE);
  if (m) return m[1];

  STANDALONE_RE.lastIndex = 0;
  let match;
  while ((match = STANDALONE_RE.exec(s))) {
    const after = s.slice(match.index + match[0].length, match.index + match[0].length + 12);
    if (PIECE_UNIT_AFTER_RE.test(after)) continue;
    return match[1];
  }

  return null;
}

export function extractPiecesFromText(text) {
  const s = String(text || '');
  const m = s.match(/(\d[\d,]{2,6})\s*(?:pcs\.?|pieces?|חלקים)/i);
  return m ? m[1].replace(/,/g, '') : null;
}
