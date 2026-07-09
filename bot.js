import { loadEnv } from './src/env.js';
loadEnv();

import { Telegraf, Markup } from 'telegraf';
import { extractUrls } from './src/resolve.js';
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

async function ingest(url, ctx) {
  const cand = await toCandidate(url);
  if (!cand.ok) {
    if (ctx) ctx.reply(`skipped: ${cand.reason}`);
    return;
  }
  if (store.hasSeen(cand.productId)) {
    if (ctx) ctx.reply('already posted this one');
    return;
  }
  if (autoApprove || !staging) {
    store.enqueue(cand);
    if (ctx) ctx.reply(`queued (position ${store.queueSize()})`);
    return;
  }
  const key = store.addStaging(cand);
  const buttons = Markup.inlineKeyboard([
    Markup.button.callback('approve', `ok:${key}`),
    Markup.button.callback('reject', `no:${key}`),
  ]);
  const preview = cand.message + '\n\n— approve to queue —';
  await deliver(staging, preview, cand.image, buttons);
}

bot.action(/^ok:(.+)$/, async (ctx) => {
  const cand = store.takeStaging(ctx.match[1]);
  await ctx.answerCbQuery(cand ? 'queued' : 'expired');
  if (cand) {
    store.enqueue(cand);
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    await ctx.reply(`queued (position ${store.queueSize()})`);
  }
});
bot.action(/^no:(.+)$/, async (ctx) => {
  store.takeStaging(ctx.match[1]);
  await ctx.answerCbQuery('rejected');
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
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

async function publishNext() {
  const cand = store.dequeue();
  if (!cand) return false;
  await deliver(CHANNEL_ID, cand.message, cand.image);
  store.markSeen(cand.productId);
  return true;
}

async function main() {
  await bot.launch();
  console.log('bot live');
  console.log(`   mode: ${hasAliKeys() ? 'LIVE (real links)' : 'MOCK (no AliExpress keys)'}`);
  console.log(`   approval: ${autoApprove || !staging ? 'OFF (auto-queue)' : 'ON (tap to approve)'}`);
  console.log(`   drip: 1 deal every ${POST_INTERVAL_MINUTES} min`);

  setInterval(() => {
    publishNext().catch((e) => console.error('publish error:', e.message));
  }, intervalMs);

  if (readerConfigured()) {
    await startReader((url) => ingest(url));
    console.log('   reader: ON');
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