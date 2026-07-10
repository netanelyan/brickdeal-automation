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

// "3 שעות ו-14 דק'" / "14 דק'" — good enough precision for a status readout,
// no need for seconds.
export function humanDuration(ms) {
  if (ms == null) return null;
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} שעות ו-${m} דק'` : `${m} דק'`;
}

// /status — an on-demand snapshot, same numbers the heartbeat would show but
// for a fixed last-24h window instead of "since the last heartbeat fired"
// (which drifts with HEARTBEAT_HOURS and wouldn't answer "why nothing today").
export function statusReport({
  readerOn,
  readerSinceMs,
  queueSize,
  seen,
  staged,
  skippedDedup,
  skippedQuality,
  skippedFailed,
  lastReaderIngestAgoMs,
  autoApprove,
  postIntervalMinutes,
  sourceChannelCount,
}) {
  const readerLine = readerOn
    ? `🟢 reader מחובר (${humanDuration(readerSinceMs)})`
    : '🔴 reader מנותק';
  const lastIngestLine =
    lastReaderIngestAgoMs == null ? 'עדיין לא נקלט כלום מה-reader' : `לפני ${humanDuration(lastReaderIngestAgoMs)}`;
  return [
    '🔎 סטטוס',
    readerLine,
    `📦 בתור: ${queueSize}`,
    '',
    'ב-24 השעות האחרונות:',
    `👀 נקלטו: ${seen}`,
    `✅ עלו לתור/לאישור: ${staged}`,
    `🔁 כפולים: ${skippedDedup}`,
    `🗑️ איכות נמוכה: ${skippedQuality}`,
    `❓ לא זוהו כמוצר תקין: ${skippedFailed}`,
    '',
    `⏱️ דיל אחרון מה-reader: ${lastIngestLine}`,
    '',
    `⚙️ AUTO_APPROVE=${autoApprove} · דריפ כל ${postIntervalMinutes} דק' · ${sourceChannelCount} ערוצי מקור`,
  ].join('\n');
}

// toCandidate()/engine.js speak in these short English codes when the build
// fails outright (before the low-quality filter even runs) — this is the
// Hebrew a human reads for /why.
const FAILED_REASON_HE = {
  no_product_id: 'לא הצליח לזהות מזהה מוצר',
  not_promotable: 'המוצר לא ניתן לקידום/שיווק',
  no_link: 'לא הופק קישור שותפים',
};
export const failedReasonHe = (reason) => FAILED_REASON_HE[reason] || reason || 'סיבה לא ידועה';

const SKIP_TYPE_LABEL_HE = {
  skipped_dedup: 'כפול',
  skipped_quality: 'איכות',
  skipped_failed: 'לא זוהה',
};

function skipReasonText(entry) {
  if (entry.type === 'skipped_dedup') return 'כבר פורסם בעבר';
  if (entry.type === 'skipped_quality') return reasonHe(entry.reason);
  if (entry.type === 'skipped_failed') return failedReasonHe(entry.reason);
  return entry.reason || '';
}

// /why — items: [{ type, label, link, reason }], most recent first.
export function whyReport(items) {
  if (!items.length) return '✅ שום דבר לא דולג לאחרונה';
  const lines = items.map((e, i) => {
    const tag = SKIP_TYPE_LABEL_HE[e.type] || e.type;
    const link = e.link ? ` · ${e.link}` : '';
    return `${i + 1}. [${tag}] ${e.label} — ${skipReasonText(e)}${link}`;
  });
  return `🔍 ${items.length} הדילים האחרונים שדולגו:\n${lines.join('\n')}`;
}
