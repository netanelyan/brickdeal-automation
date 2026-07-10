import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { extractUrls } from './resolve.js';

const CONNECT_TIMEOUT_MS = 20_000;
const BACKFILL_DELAY_MS = 1200; // throttle so we don't hammer AliExpress/Telegram

export const readerConfigured = () =>
  Boolean(process.env.TG_API_ID && process.env.TG_API_HASH && process.env.TG_SESSION);

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Watches your source channels (as your own logged-in account) and calls
// onUrl(url, sourceText) for every AliExpress link it sees — sourceText is the
// full message it was found in, which source channels often use to include
// the official set number / piece count alongside the link. This is a
// "userbot": automating a personal account is a Telegram grey area, so run it
// on a SECONDARY account, never your main. Generate TG_SESSION once with
// `npm run login`.
export async function startReader(onUrl) {
  const apiId = Number(process.env.TG_API_ID);
  const apiHash = process.env.TG_API_HASH;
  const sources = (process.env.SOURCE_CHANNELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const backfillCount = Number(process.env.BACKFILL_COUNT ?? '30');

  const client = new TelegramClient(new StringSession(process.env.TG_SESSION), apiId, apiHash, {
    connectionRetries: 5,
  });

  console.log('   reader: connecting to Telegram (as your worker account)...');
  try {
    await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, 'reader connect');
  } catch (e) {
    throw new Error(`could not connect — ${e.message}`);
  }

  // A connect() that "succeeds" with a dead/expired session still leaves you
  // unauthorized rather than throwing, so this is the real proof the session
  // is good. If Telegram is challenging the account (new device / suspicious
  // login), this call is what will surface it.
  let me;
  try {
    const authorized = await withTimeout(
      client.isUserAuthorized(),
      CONNECT_TIMEOUT_MS,
      'reader auth check'
    );
    if (!authorized) throw new Error('session is not authorized — regenerate it with `npm run login`');
    me = await withTimeout(client.getMe(), CONNECT_TIMEOUT_MS, 'reader getMe');
  } catch (e) {
    await client.disconnect().catch(() => {});
    throw new Error(`session invalid — ${e.message}`);
  }
  const who = me?.username ? `@${me.username}` : me?.id ? `id ${me.id}` : 'unknown account';
  console.log(`   reader: connected as ${who}`);

  client.addEventHandler(async (event) => {
    const text = event?.message?.message;
    if (!text) return;
    for (const url of extractUrls(text)) {
      try {
        await onUrl(url, text);
      } catch (e) {
        console.error('reader onUrl error:', e.message);
      }
    }
  }, new NewMessage({ chats: sources.length ? sources : undefined }));

  console.log(`   reader: watching ${sources.length || 'all joined'} source channel(s)${sources.length ? ` (${sources.join(', ')})` : ''}`);

  if (backfillCount > 0 && sources.length) {
    backfill(client, sources, onUrl, backfillCount).catch((e) =>
      console.error('reader: backfill error:', e.message)
    );
  }

  return client;
}

// One-time catch-up on startup: pull each source channel's last N messages
// and run any AliExpress links through the exact same ingest path as live
// messages (dedupe, mock/live candidate build, staging). Throttled so a
// backlog doesn't slam AliExpress's or Telegram's rate limits.
async function backfill(client, sources, onUrl, count) {
  console.log(`   reader: backfill starting (last ${count} message(s) per channel)...`);
  let staged = 0;
  let skipped = 0;

  for (const channel of sources) {
    let messages;
    try {
      messages = await client.getMessages(channel, { limit: count });
    } catch (e) {
      console.error(`   reader: backfill couldn't read ${channel} — ${e.message}`);
      continue;
    }

    const chronological = [...messages].reverse(); // oldest first, so staging order matches posting order
    for (const msg of chronological) {
      const text = msg?.message;
      if (!text) continue;
      for (const url of extractUrls(text)) {
        try {
          const status = await onUrl(url, text);
          if (status === 'queued' || status === 'staged') staged++;
          else skipped++;
        } catch (e) {
          console.error('reader: backfill ingest error:', e.message);
          skipped++;
        }
        await new Promise((r) => setTimeout(r, BACKFILL_DELAY_MS));
      }
    }
  }

  console.log(`   reader: backfill done — staged ${staged}, skipped ${skipped}`);
}
