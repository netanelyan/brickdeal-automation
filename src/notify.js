// All the Hebrew status DMs the bot sends to STAGING_CHAT_ID — startup ping,
// heartbeat, quality-skip visibility, quiet/reader alerts. Kept as pure
// formatters (no Telegram calls) plus one thin `send`, so the messages can be
// built and eyeballed in a plain script without booting the whole bot.
//
// No parse_mode here on purpose: these strings can embed a scraped product
// title, and titles routinely contain stray `*`/`_`/backticks that break
// Telegram's Markdown parser. Everywhere else in the bot that's worth a
// try-Markdown-then-plain-text fallback; here it's simpler to just never ask
// for Markdown in the first place.
export async function send(telegram, chatId, text) {
  if (!chatId) return null;
  return telegram
    .sendMessage(chatId, text, { link_preview_options: { is_disabled: true } })
    .catch((e) => {
      console.error('notify: send failed:', e.message);
      return null;
    });
}

export function startupPing({ readerOn, queueSize, channelCount }) {
  return `🟢 הבוט עלה · reader ${readerOn ? 'ON' : 'OFF'} · ${queueSize} בתור · ${channelCount} ערוצים`;
}

export function heartbeat({ seen, staged, skippedQuality, skippedDedup, queueSize, readerOn }) {
  return (
    `💓 ${seen} נקלטו · ${staged} עלו לתור · ${skippedQuality} דולגו (איכות) · ` +
    `${skippedDedup} כפולים · ${queueSize} בתור כרגע · reader ${readerOn ? 'ON' : 'OFF'}`
  );
}

// lowQualityReason() in bot.js speaks English (it's a log/debug string too);
// this is the one place that needs the Hebrew a human actually reads.
const QUALITY_REASON_HE = {
  'no product image': 'אין תמונת מוצר',
  'no set number, piece count, or rating': 'חסר מק״ט/חלקים/דירוג',
};
export const reasonHe = (reason) => QUALITY_REASON_HE[reason] || reason;

// Candidate messages always open with `*title*` (see format.js) — pull that
// back out rather than threading a separate "title" field through everywhere
// just for notifications.
export function dealLabel(cand) {
  const m = String(cand?.message || '').match(/^\*(.+?)\*/);
  return (m && m[1]) || cand?.productId || 'מוצר';
}

export function qualitySkipSingle(cand, reason) {
  return `🗑️ דולג (איכות): ${dealLabel(cand)} — ${reasonHe(reason)} · ${cand.link}`;
}

// items: [{ cand, reason }]
export function qualitySkipDigest(items, hours) {
  const lines = items.map(
    (it, i) => `${i + 1}. ${dealLabel(it.cand)} — ${reasonHe(it.reason)} · ${it.cand.link}`
  );
  return `🗑️ ${items.length} דילים דולגו (איכות) ב-${hours} השעות האחרונות:\n${lines.join('\n')}`;
}

export function quietAlert(hours) {
  return `⚠️ שקט: לא נקלטו דילים חדשים כבר ${hours} שעות`;
}

export function readerNotConnected() {
  return '🔴 ה-reader לא מחובר — מנסה להתחבר מחדש...';
}
export function readerReconnected() {
  return '🟢 ה-reader התחבר מחדש';
}
export function readerStillDown(attempts) {
  return `🔴 ה-reader עדיין לא מצליח להתחבר אחרי ${attempts} ניסיונות — ממשיך לנסות ברקע`;
}
