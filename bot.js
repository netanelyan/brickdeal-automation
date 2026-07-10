import { loadEnv } from './src/env.js';
loadEnv();

import { Telegraf, Markup } from 'telegraf';
import { extractUrls, resolveToProductId } from './src/resolve.js';
import { toCandidate, hasAliKeys } from './src/candidate.js';
import * as store from './src/store.js';
import { readerConfigured, startReader } from './src/reader.js';

const {
  TG_BOT_TOKEN,
  CHANNEL_ID,
  STAGING_CHAT_ID,
  POST_INTERVAL_MINUTES = '180',
  AUTO_APPROVE = 'false',
} = process.env;

if (!TG_BOT_TOKEN || !CHANNEL_ID) {
  console.error('Set TG_BOT_TOKEN and CHANNEL_ID in .env');
  process.exit(1);
}

const bot = new Telegraf(TG_BOT_TOKEN);
const staging = STAGING_CHAT_ID || null;
const autoApprove = AUTO_APPROVE === 'true';
const intervalMs = Math.max(1, Number(POST_INTERVAL_MINUTES)) * 60_000;

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
  // Claim the product ID up front (before the slow AliExpress calls) so two
  // source channels posting the same deal seconds apart can't both slip past
  // the hasSeen check and get staged twice.
  const { productId: preId } = await resolveToProductId(url);
  if (preId) {
    if (store.hasSeen(preId)) {
      if (ctx) ctx.reply('already posted this one');
      return 'duplicate';
    }
    store.markSeen(preId);
  }

  const cand = await toCandidate(url, sourceText);
  if (!cand.ok) {
    if (preId) store.forgetSeen(preId); // build failed — don't permanently block a retry
    if (ctx) ctx.reply(`skipped: ${cand.reason}`);
    return 'failed';
  }
  const reason = lowQualityReason(cand);
  if (reason) {
    if (preId) store.forgetSeen(preId); // a future post of the same product may carry better info
    console.log(`ingest: skipped low-quality deal ${cand.productId} — ${reason}`);
    if (ctx) ctx.reply(`skipped (low quality): ${reason}`);
    return 'skipped';
  }
  if (!preId && store.hasSeen(cand.productId)) {
    if (ctx) ctx.reply('already posted this one');
    return 'duplicate';
  }
  if (!preId) store.markSeen(cand.productId);
  if (autoApprove || !staging) {
    store.enqueue(cand);
    if (ctx) ctx.reply(`queued (position ${store.queueSize()})`);
    return 'queued';
  }
  const key = store.addStaging(cand);
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback('✅ אשר', `ok:${key}`), Markup.button.callback('❌ דחה', `no:${key}`)],
    [Markup.button.callback('⏭️ דלג', `skip:${key}`)],
  ]);
  await deliver(staging, cand.message, cand.image, buttons);
  return 'staged';
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
  const cand = store.takeStaging(ctx.match[1]);
  if (!cand) {
    await ctx.answerCbQuery('כבר טופל');
    return;
  }
  store.enqueue(cand);
  const pos = store.queueSize();
  await ctx.answerCbQuery(`✅ אושר — ${pos} בתור`);
  await markDecided(ctx, `✅ אושר — ${pos} בתור`, cand);
});
bot.action(/^no:(.+)$/, async (ctx) => {
  const cand = store.takeStaging(ctx.match[1]);
  if (!cand) {
    await ctx.answerCbQuery('כבר טופל');
    return;
  }
  await ctx.answerCbQuery('❌ נדחה');
  await markDecided(ctx, '❌ נדחה', cand);
});
bot.action(/^skip:(.+)$/, async (ctx) => {
  // Leaves the item in staging, untouched — buttons stay live so you can come
  // back and decide later (handy while bulk-seeding from a backfill).
  const pending = store.hasStaging(ctx.match[1]);
  await ctx.answerCbQuery(pending ? '⏭️ דולג — עדיין ממתין לאישור' : 'כבר טופל');
});

bot.on('message', async (ctx, next) => {
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

async function publishNext() {
  const cand = store.dequeue();
  if (!cand) return false;
  await deliver(CHANNEL_ID, cand.message, cand.image);
  store.markSeen(cand.productId);
  return true;
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
  console.log(`   drip: 1 deal every ${POST_INTERVAL_MINUTES} min`);

  setInterval(() => {
    publishNext().catch((e) => console.error('publish error:', e.message));
  }, intervalMs);

  if (readerConfigured()) {
    console.log('   reader: connecting...');
    // Never let a stuck/failed reader block the rest of the bot — manual
    // forwarding must keep working even if the userbot can't connect.
    startReader((url, sourceText) => ingest(url, undefined, sourceText))
      .then(() => console.log('   reader: ON'))
      .catch((e) => {
        console.error(`   reader: FAILED — ${e.message}`);
        console.error('   bot continues without it; forward links to the bot manually.');
      });
  } else {
    console.log('   reader: OFF (forward links to the bot)');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));