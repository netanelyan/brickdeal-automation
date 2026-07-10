import { loadEnv } from './src/env.js';
loadEnv();

import { Telegraf, Markup } from 'telegraf';
import { extractUrls, resolveToProductId } from './src/resolve.js';
import { toCandidate, hasAliKeys } from './src/candidate.js';
import * as store from './src/store.js';
import { readerConfigured, startReader, sourceChannels } from './src/reader.js';
import * as notify from './src/notify.js';

// Last-resort safety net. Root cause of the crash loop: GramJS's own
// MTProtoSender.reconnect() (network/MTProtoSender.js) does
// `sleep(1000).then(() => this._reconnect())` with no `.catch()` anywhere in
// that chain, and _reconnect()'s own `await this.connect(newConnection, true)`
// isn't wrapped in try/catch either. On a network flaky enough that a
// reconnect attempt itself fails — exactly what we've been seeing — that
// rejection is never caught by GramJS, and Node's default behavior since v15
// is to crash the process on an unhandled rejection. pm2 then restarts a
// fresh process, which reruns main() — including a full backfill — from
// scratch, every time. This isn't a gap in our code that can be closed by
// wrapping our own calls; the throw happens entirely inside a third-party
// promise chain we never get a reference to. Catching it here, at the
// process boundary, is what actually stops the crash loop.
process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection (kept process alive):', reason?.stack || reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaught exception (kept process alive):', err?.stack || err);
});

const {
  TG_BOT_TOKEN,
  CHANNEL_ID,
  STAGING_CHAT_ID,
  OWNER_ID,
  POST_INTERVAL_MINUTES = '180',
  AUTO_APPROVE = 'false',
  HEARTBEAT_HOURS = '6',
  SKIP_DIGEST_HOURS = '3',
  QUALITY_SKIP_NOTIFY = 'digest', // off | each | digest
  QUIET_ALERT_HOURS = '3',
} = process.env;

if (!TG_BOT_TOKEN || !CHANNEL_ID) {
  console.error('Set TG_BOT_TOKEN and CHANNEL_ID in .env');
  process.exit(1);
}
// Fail closed, not open: without a known owner id there's no one left to
// lock the bot to, so refuse to start rather than quietly accepting DMs
// from anyone who finds the username.
if (!OWNER_ID) {
  console.error('Set OWNER_ID in .env (your Telegram user id) so the bot only responds to you.');
  process.exit(1);
}

const bot = new Telegraf(TG_BOT_TOKEN);
const staging = STAGING_CHAT_ID || null;
const autoApprove = AUTO_APPROVE === 'true';
const intervalMs = Math.max(1, Number(POST_INTERVAL_MINUTES)) * 60_000;

// String comparison sidesteps any float-precision edge case with large
// Telegram user ids — safer than coercing both sides to Number.
const isOwner = (ctx) => String(ctx.from?.id) === String(OWNER_ID);

// Registered before any other handler, so nothing below it — messages,
// forwards, /commands, or button taps — ever runs for anyone but the owner.
// Only covers this Telegraf bot; the GramJS reader (src/reader.js) ingests
// straight from source channels via its own client and never passes through
// here, so it's untouched by this gate.
bot.use(async (ctx, next) => {
  if (isOwner(ctx)) return next();
  console.log(`blocked non-owner update from ${ctx.from?.id ?? 'unknown'} (${ctx.from?.username || 'no username'})`);
  if (ctx.callbackQuery) {
    // Also clears Telegram's loading spinner on the tapped button — a bare
    // `return` without answering would leave it spinning on their end.
    await ctx.answerCbQuery('⛔ not authorized').catch(() => {});
    return;
  }
  await ctx.reply('⛔ not authorized').catch(() => {});
});

const CAPTION_MAX = 1000;

// Send text or photo. Photos only when the caption fits Telegram's limit;
// otherwise fall back to a plain text message (allows 4096 chars).
async function deliver(chatId, text, image, extra = {}) {
  const canPhoto = image && text.length <= CAPTION_MAX;
  try {
    if (canPhoto) {
      return await bot.telegram.sendPhoto(chatId, image, { caption: text, parse_mode: 'Markdown', ...extra });
    }
    return await bot.telegram.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  } catch {
    // A product title can break Markdown — retry as plain text.
    const plain = text.replace(/[*_~`]/g, '');
    return bot.telegram.sendMessage(chatId, plain, { link_preview_options: { is_disabled: true }, ...extra });
  }
}

// With AUTO_APPROVE on, nothing gets a human look before it's posted — this
// is the only thing standing between a junk listing and the channel. Stays
// conservative on purpose: only drops candidates with literally nothing to
// show (no set number, no piece count, no rating) or no product image.
// Skipped for mock candidates, which never carry a real image.
function lowQualityReason(cand) {
  if (cand.mock) return null;
  if (!cand.image) return 'no product image';
  if (!cand.setId && !cand.pieces && !cand.stars) return 'no set number, piece count, or rating';
  return null;
}

// Returns a status string so callers (reader backfill in particular) can
// tally outcomes: 'duplicate' | 'failed' | 'queued' | 'staged' | 'skipped'.
// sourceText is the surrounding message text when the URL came from a
// watched source channel — it's undefined for manual forwards, which keeps
// working exactly as before.
async function ingest(url, ctx, sourceText) {
  stats.seen++;
  // Claim the product ID up front (before the slow AliExpress calls) so two
  // source channels posting the same deal seconds apart can't both slip past
  // the hasSeen check and get staged twice.
  const { productId: preId } = await resolveToProductId(url);
  if (preId) {
    if (store.hasSeen(preId)) {
      stats.skippedDedup++;
      logActivity('skipped_dedup', { productId: preId, url });
      if (ctx) ctx.reply('already posted this one');
      return 'duplicate';
    }
    store.markSeen(preId);
  }

  const cand = await toCandidate(url, sourceText);
  if (!cand.ok) {
    if (preId) store.forgetSeen(preId); // build failed — don't permanently block a retry
    logActivity('skipped_failed', { url, productId: cand.productId, reason: cand.reason });
    if (ctx) ctx.reply(`skipped: ${cand.reason}`);
    return 'failed';
  }
  const reason = lowQualityReason(cand);
  if (reason) {
    if (preId) store.forgetSeen(preId); // a future post of the same product may carry better info
    console.log(`ingest: skipped low-quality deal ${cand.productId} — ${reason}`);
    stats.skippedQuality++;
    logActivity('skipped_quality', { cand, reason });
    await notifyQualitySkip(cand, reason);
    if (ctx) ctx.reply(`skipped (low quality): ${reason}`);
    return 'skipped';
  }
  if (!preId && store.hasSeen(cand.productId)) {
    stats.skippedDedup++;
    logActivity('skipped_dedup', { cand });
    if (ctx) ctx.reply('already posted this one');
    return 'duplicate';
  }
  if (!preId) store.markSeen(cand.productId);
  if (autoApprove || !staging) {
    store.enqueue(cand);
    stats.staged++;
    logActivity('staged', { cand });
    if (ctx) ctx.reply(`queued (position ${store.queueSize()})`);
    return 'queued';
  }
  const key = store.addStaging(cand);
  stats.staged++;
  logActivity('staged', { cand });
  await deliver(staging, cand.message, cand.image, stagingButtons(key));
  return 'staged';
}

function stagingButtons(key) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ אשר', `ok:${key}`), Markup.button.callback('❌ דחה', `no:${key}`)],
    [Markup.button.callback('✏️ ערוך', `edit:${key}`), Markup.button.callback('⏭️ דלג', `skip:${key}`)],
  ]);
}

// Swap out only the headline (the card's first line, always `*title*` per
// formatMessage) so price/pieces/link/image survive an edit untouched.
function applyTitleEdit(message, newTitle) {
  const cleaned = String(newTitle).replace(/\s+/g, ' ').trim();
  const lines = message.split('\n');
  lines[0] = `*${cleaned}*`;
  return lines.join('\n');
}

// Re-render a staging card from outside a callback ctx (the edit reply
// arrives as a plain message, not a button tap) — same Markdown-then-plain
// fallback as deliver()/markDecided(), addressed by chatId+messageId instead.
async function editCardRaw(chatId, messageId, isPhoto, text, extra = {}) {
  const method = isPhoto ? 'editMessageCaption' : 'editMessageText';
  try {
    await bot.telegram[method](chatId, messageId, undefined, text, { parse_mode: 'Markdown', ...extra });
  } catch {
    await bot.telegram[method](chatId, messageId, undefined, text.replace(/[*_~`]/g, ''), extra).catch((e) =>
      console.error('edit UX: card edit failed:', e.message)
    );
  }
}

// Rewrite the staging card in place so a decision is visible at a glance and
// can't be double-tapped — mirrors deliver()'s Markdown-then-plain fallback,
// and edits whichever of caption/text the card was actually sent as.
async function markDecided(ctx, statusLine, cand) {
  const isPhoto = Boolean(ctx.callbackQuery?.message?.photo);
  const edit = isPhoto ? ctx.editMessageCaption.bind(ctx) : ctx.editMessageText.bind(ctx);
  const text = `${statusLine}\n\n${cand.message}`;
  try {
    await edit(text, { parse_mode: 'Markdown' });
  } catch {
    await edit(text.replace(/[*_~`]/g, '')).catch((e) =>
      console.error('approval UX: edit failed:', e.message)
    );
  }
  // A dedicated call — folding reply_markup into the text/caption edit above
  // isn't reliable for actually clearing the keyboard.
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
}

bot.action(/^ok:(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  const cand = store.takeStaging(key);
  if (!cand) {
    await ctx.answerCbQuery('כבר טופל');
    return;
  }
  store.clearPendingEdit(key);
  store.enqueue(cand);
  const pos = store.queueSize();
  await ctx.answerCbQuery(`✅ אושר — ${pos} בתור`);
  await markDecided(ctx, `✅ אושר — ${pos} בתור`, cand);
});
bot.action(/^no:(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  const cand = store.takeStaging(key);
  if (!cand) {
    await ctx.answerCbQuery('כבר טופל');
    return;
  }
  store.clearPendingEdit(key);
  await ctx.answerCbQuery('❌ נדחה');
  await markDecided(ctx, '❌ נדחה', cand);
});
bot.action(/^skip:(.+)$/, async (ctx) => {
  // Leaves the item in staging, untouched — buttons stay live so you can come
  // back and decide later (handy while bulk-seeding from a backfill).
  const pending = store.hasStaging(ctx.match[1]);
  await ctx.answerCbQuery(pending ? '⏭️ דולג — עדיין ממתין לאישור' : 'כבר טופל');
});
bot.action(/^edit:(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  const cand = store.getStaging(key);
  if (!cand) {
    await ctx.answerCbQuery('כבר טופל');
    return;
  }
  const chatId = ctx.chat.id;
  const cardMessageId = ctx.callbackQuery.message.message_id;
  const cardIsPhoto = Boolean(ctx.callbackQuery.message.photo);

  await ctx.answerCbQuery('✏️ שלח את הטקסט המתוקן');
  // Freeze the card mid-edit (no buttons) so it can't be approved/rejected
  // against text that's about to change out from under it. The item itself
  // stays in staging the whole time, so /pending and a backfill run are unaffected.
  await markDecided(ctx, '✏️ ממתין לטקסט המתוקן שלך...', cand);

  const prompt = await ctx.reply(
    '✏️ שלח כותרת/טקסט מתוקן לעסקה שלמעלה (בתשובה להודעה הזו)',
    { reply_parameters: { message_id: cardMessageId }, ...Markup.forceReply() }
  );
  // Keyed by the staged item itself (not by chat) — several deals can be
  // mid-edit at once without one tap clobbering another's pending state.
  store.setPendingEdit(key, { chatId, promptMessageId: prompt.message_id, cardMessageId, cardIsPhoto });
});

// Routes a reply to an edit prompt back to the deal it belongs to (matched by
// the prompt's own message id, never by "whatever text came in next") —
// applies the new title, restores the card's image/link/buttons, and stops
// the message from also being tried as a URL submission.
async function handleEditReply(ctx, key) {
  const pending = store.getPendingEdit(key);
  store.clearPendingEdit(key);
  const cand = store.getStaging(key);
  if (!pending || !cand) {
    await ctx.reply('העסקה הזו כבר לא ממתינה לעריכה');
    return;
  }
  const newTitle = (ctx.message.text || ctx.message.caption || '').trim();
  if (!newTitle) {
    await ctx.reply('שלח טקסט (לא תמונה/מדבקה)');
    store.setPendingEdit(key, pending); // nothing consumed — leave the edit pending
    return;
  }
  store.updateStagingMessage(key, applyTitleEdit(cand.message, newTitle));
  const updated = store.getStaging(key);
  await editCardRaw(pending.chatId, pending.cardMessageId, pending.cardIsPhoto, updated.message, stagingButtons(key));
  await ctx.reply('✏️ עודכן — אשר/דחה למעלה');
}

bot.on('message', async (ctx, next) => {
  const replyToId = ctx.message?.reply_to_message?.message_id;
  const editKey = replyToId ? store.findPendingEditByPrompt(replyToId) : null;
  if (editKey) return handleEditReply(ctx, editKey);

  const text = ctx.message?.text || ctx.message?.caption || '';
  const urls = extractUrls(text);
  if (!urls.length) return next?.();
  for (const url of urls) await ingest(url, ctx);
});

bot.command('queue', (ctx) => ctx.reply(`${store.queueSize()} deal(s) queued`));
bot.command('next', async (ctx) => {
  const n = await publishNext();
  ctx.reply(n ? 'posted the next deal' : 'queue empty');
});
bot.command('pending', (ctx) => ctx.reply(`⏳ ${store.stagingSize()} deal(s) awaiting approval`));
bot.command('clear_pending', (ctx) => {
  const n = store.clearStaging();
  ctx.reply(`🧹 נוקו ${n} פריט(ים) ממתינים`);
});

// On-demand version of the heartbeat, for "why haven't I gotten deals" —
// fixed last-24h window rather than "since the last heartbeat", so it
// doesn't depend on HEARTBEAT_HOURS to be a useful answer.
bot.command('status', async (ctx) => {
  const now = Date.now();
  const dayAgo = now - 24 * 3_600_000;
  const recent = activityLog.filter((e) => e.ts >= dayAgo);
  const tally = { seen: recent.length, staged: 0, skippedDedup: 0, skippedQuality: 0, skippedFailed: 0 };
  for (const e of recent) {
    if (e.type === 'staged') tally.staged++;
    else if (e.type === 'skipped_dedup') tally.skippedDedup++;
    else if (e.type === 'skipped_quality') tally.skippedQuality++;
    else if (e.type === 'skipped_failed') tally.skippedFailed++;
  }
  await ctx.reply(
    notify.statusReport({
      readerOn: readerHealthy,
      readerSinceMs: readerHealthy && readerConnectedSince ? now - readerConnectedSince : null,
      queueSize: store.queueSize(),
      ...tally,
      lastReaderIngestAgoMs: lastReaderIngestAt ? now - lastReaderIngestAt : null,
      autoApprove,
      postIntervalMinutes: POST_INTERVAL_MINUTES,
      sourceChannelCount: sourceChannels().length,
    })
  );
});

// Companion to /status: the actual skipped deals, not just counts.
// `/why 20` for more than the default 10; capped so it can't turn into a wall of text.
bot.command('why', async (ctx) => {
  const arg = Number((ctx.message.text || '').split(' ')[1]);
  const n = Number.isFinite(arg) && arg > 0 ? Math.min(Math.floor(arg), 25) : 10;
  const items = activityLog
    .filter((e) => e.type.startsWith('skipped_'))
    .slice(-n)
    .reverse();
  await ctx.reply(notify.whyReport(items));
});

async function publishNext() {
  const cand = store.dequeue();
  if (!cand) return false;
  await deliver(CHANNEL_ID, cand.message, cand.image);
  store.markSeen(cand.productId);
  return true;
}

// ---------------------------------------------------------------------------
// Monitoring: startup ping, periodic heartbeat, quality-skip visibility, a
// quiet-reader alert, and reader drop/reconnect. Everything here DMs
// STAGING_CHAT_ID in Hebrew via src/notify.js. All in-memory — a restart just
// starts a fresh counting window, which is fine for a status report.
// ---------------------------------------------------------------------------

let stats = { seen: 0, staged: 0, skippedQuality: 0, skippedDedup: 0 };
let qualitySkipQueue = []; // [{ cand, reason }] — drained by the digest timer

// Ring buffer of recent ingest outcomes — powers /status (tallied over the
// last 24h) and /why (the actual items, not just counts). Kept separate from
// `stats` above (which tracks "since the last heartbeat") since /status
// deliberately wants a fixed window regardless of HEARTBEAT_HOURS.
let activityLog = [];
const ACTIVITY_LOG_MAX = 500;
function logActivity(type, { cand, productId, url, reason } = {}) {
  activityLog.push({
    ts: Date.now(),
    type, // 'staged' | 'skipped_dedup' | 'skipped_quality' | 'skipped_failed'
    label: cand ? notify.dealLabel(cand) : productId || 'מוצר',
    link: cand?.link || url || null,
    reason: reason || null,
  });
  if (activityLog.length > ACTIVITY_LOG_MAX) activityLog.shift();
}

async function notifyQualitySkip(cand, reason) {
  if (QUALITY_SKIP_NOTIFY === 'each') {
    await notify.send(bot.telegram, staging, notify.qualitySkipSingle(cand, reason));
  } else if (QUALITY_SKIP_NOTIFY === 'digest') {
    qualitySkipQueue.push({ cand, reason });
  }
  // 'off' — filter still runs (bot.js console.log above still fires), just no DM.
}

function sendHeartbeat() {
  if (!readerHealthy) return; // spec: only report while the reader is actually up
  const text = notify.heartbeat({ ...stats, queueSize: store.queueSize(), readerOn: readerHealthy });
  stats = { seen: 0, staged: 0, skippedQuality: 0, skippedDedup: 0 };
  return notify.send(bot.telegram, staging, text);
}

function sendQualityDigest() {
  if (QUALITY_SKIP_NOTIFY !== 'digest' || !qualitySkipQueue.length) return; // nothing to say, stay quiet
  const items = qualitySkipQueue;
  qualitySkipQueue = [];
  return notify.send(bot.telegram, staging, notify.qualitySkipDigest(items, SKIP_DIGEST_HOURS));
}

// --- reader supervision ---
let readerClient = null;
let readerHealthy = false;
let readerConnectedSince = null; // for /status's "connected for how long"
let reconnecting = false;
let reconnectFails = 0;
let outageAlerted = false; // "reader is down" DM sent for the *current* outage
let outageStillDownAlerted = false; // "still down after N tries" DM sent for the current outage
let lastReaderIngestAt = null;
let quietAlertSent = false; // one quiet-alert per quiet period, not one per check

const RECONNECT_DELAYS_MS = [30_000, 60_000, 120_000, 240_000, 300_000]; // holds at 5 min
const RECONNECT_ALERT_THRESHOLD = 5;

// Every URL the reader hands us marks it "alive" for the quiet-alert check —
// deliberately separate from ingest()'s own stats, which also count manual
// DM forwards and shouldn't reset the reader-specific silence timer.
function onReaderUrl(url, sourceText) {
  lastReaderIngestAt = Date.now();
  quietAlertSent = false;
  return ingest(url, undefined, sourceText);
}

// The one path for "(re)establish the reader connection" — used for the
// initial connect failing AND for a later drop. Re-running startReader() in
// full (including its backfill) rather than trying to resume the half-dead
// GramJS client is deliberate: ingest()'s dedupe already makes re-seeing
// recent messages a no-op, so a full reconnect is simple *and* safe, instead
// of hand-rolling a resume path against undocumented client internals.
async function reconnectReader() {
  if (reconnecting) return;
  reconnecting = true;
  await readerClient?.disconnect().catch(() => {});
  try {
    readerClient = await startReader(onReaderUrl);
    readerHealthy = true;
    readerConnectedSince = Date.now();
    if (outageAlerted) await notify.send(bot.telegram, staging, notify.readerReconnected());
    reconnectFails = 0;
    outageAlerted = false;
    outageStillDownAlerted = false;
  } catch (e) {
    readerHealthy = false;
    reconnectFails++;
    console.error(`   reader: reconnect attempt ${reconnectFails} failed — ${e.message}`);
    if (!outageAlerted) {
      outageAlerted = true;
      await notify.send(bot.telegram, staging, notify.readerNotConnected());
    }
    if (reconnectFails >= RECONNECT_ALERT_THRESHOLD && !outageStillDownAlerted) {
      outageStillDownAlerted = true;
      await notify.send(bot.telegram, staging, notify.readerStillDown(reconnectFails));
    }
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectFails - 1, RECONNECT_DELAYS_MS.length - 1)];
    setTimeout(reconnectReader, delay);
  } finally {
    reconnecting = false;
  }
}

// GramJS retries transient network/update-loop timeouts internally on its
// own (that's what connectionRetries is for) — `client.disconnected` flips
// true during those normal blips too, not just on a real, lasting drop.
// Require it to stay true for several consecutive ticks before we treat it
// as one; otherwise we'd tear down and rebuild (full backfill included) a
// connection GramJS was already in the middle of recovering on its own.
const DISCONNECT_TICKS_BEFORE_ACTION = 3;
let disconnectedTicks = 0;

// Runs every minute: notices a dropped GramJS connection (`client.disconnected`
// is a plain property GramJS exposes — no event to subscribe to) and kicks
// off reconnectReader(), and separately checks the quiet-reader alert.
function monitorTick() {
  if (readerHealthy && readerClient?.disconnected) {
    disconnectedTicks++;
    if (disconnectedTicks >= DISCONNECT_TICKS_BEFORE_ACTION) {
      readerHealthy = false;
      disconnectedTicks = 0;
      reconnectReader();
    }
  } else {
    disconnectedTicks = 0;
  }
  if (readerHealthy && lastReaderIngestAt) {
    const quietHours = (Date.now() - lastReaderIngestAt) / 3_600_000;
    if (quietHours > Math.max(1, Number(QUIET_ALERT_HOURS)) && !quietAlertSent) {
      quietAlertSent = true;
      notify.send(bot.telegram, staging, notify.quietAlert(Math.floor(quietHours))).catch(() => {});
    }
  }
}

async function main() {
  console.log('starting bot...');

  // NOTE: bot.launch() intentionally never resolves during normal operation —
  // it *is* the long-poll loop, and only settles once bot.stop() is called.
  // Awaiting it (as this used to) silently queues everything after it —
  // startup logs, the drip interval, the reader — behind a promise that only
  // fires at shutdown, which looked exactly like a startup hang that only
  // "unfroze" on Ctrl+C. Confirm connectivity ourselves with getMe() instead,
  // then fire launch() without awaiting it.
  const me = await bot.telegram.getMe();
  bot.botInfo = me; // lets launch() skip its own redundant getMe() call
  bot.launch().catch((e) => {
    console.error('bot polling stopped with an error:', e.message);
    process.exit(1);
  });

  console.log(`bot live (@${me.username})`);
  console.log(`   mode: ${hasAliKeys() ? 'LIVE (real links)' : 'MOCK (no AliExpress keys)'}`);
  console.log(`   approval: ${autoApprove || !staging ? 'OFF (auto-queue)' : 'ON (tap to approve)'}`);
  console.log(`   owner lock: ON (only ${OWNER_ID} can use this bot)`);
  console.log(`   drip: 1 deal every ${POST_INTERVAL_MINUTES} min`);

  setInterval(() => {
    publishNext().catch((e) => console.error('publish error:', e.message));
  }, intervalMs);

  // bot.launch() and the drip interval above are already running and don't
  // wait on any of this — only the startup ping (which needs to know the
  // reader's real status) and the monitoring timers are sequenced after it.
  // reader.js bounds its own connect/auth calls with timeouts, so this can't
  // hang forever; a failed connect here just hands off to reconnectReader().
  if (readerConfigured()) {
    console.log('   reader: connecting...');
    try {
      readerClient = await startReader(onReaderUrl);
      readerHealthy = true;
      readerConnectedSince = Date.now();
      console.log('   reader: ON');
    } catch (e) {
      console.error(`   reader: FAILED — ${e.message}`);
      console.error('   bot continues without it; retrying in the background.');
      readerHealthy = false;
    }
  } else {
    console.log('   reader: OFF (forward links to the bot)');
  }

  await notify.send(
    bot.telegram,
    staging,
    notify.startupPing({ readerOn: readerHealthy, queueSize: store.queueSize(), channelCount: sourceChannels().length })
  );

  setInterval(monitorTick, 60_000);
  setInterval(() => {
    sendHeartbeat()?.catch?.((e) => console.error('heartbeat error:', e.message));
  }, Math.max(1, Number(HEARTBEAT_HOURS)) * 3_600_000);
  if (QUALITY_SKIP_NOTIFY === 'digest') {
    setInterval(() => {
      sendQualityDigest()?.catch?.((e) => console.error('quality digest error:', e.message));
    }, Math.max(1, Number(SKIP_DIGEST_HOURS)) * 3_600_000);
  }
  if (readerConfigured() && !readerHealthy) {
    reconnectReader(); // initial connect failed above — start the backoff loop
  }
  console.log(
    `   monitoring: heartbeat every ${HEARTBEAT_HOURS}h · quality-skip notify: ${QUALITY_SKIP_NOTIFY} · quiet alert after ${QUIET_ALERT_HOURS}h`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));