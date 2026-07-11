import { TelegramClient, utils } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, Raw } from 'telegram/events/index.js';
import { ConnectionTCPObfuscated } from 'telegram/network/index.js';
import { extractUrls } from './resolve.js';

const CONNECT_TIMEOUT_MS = 20_000;
const BACKFILL_DELAY_MS = 1200; // throttle so we don't hammer AliExpress/Telegram

// TEMPORARY diagnostic logging for "live reader receives nothing" — set
// READER_VERBOSE=false to quiet it once the root cause is confirmed. Prints:
// (a) explicit per-source entity resolution at startup, (b) every single raw
// update the account receives (via a Raw/no-filter handler, registered
// before the NewMessage handler — see the comment above that registration
// for why the ordering matters), and (c) a periodic liveness heartbeat so a
// silently-dead update loop shows up as a flatlined counter instead of just
// "nothing happened."
const READER_VERBOSE = process.env.READER_VERBOSE !== 'false';
const HEARTBEAT_INTERVAL_MS = 5 * 60_000;

function peerIdOf(peer) {
  try {
    return utils.getPeerId(peer);
  } catch {
    return null;
  }
}

// Summarizes any raw Api.TypeUpdate for the verbose log: className, the
// chat it's about (if it carries a message), whether that chat matches one
// of our resolved source channels, and whether an AliExpress URL was found
// — everything needed to see whether @brickclones' posts even arrive at the
// transport level, independent of the NewMessage event filter.
function describeUpdate(update, knownSourceIds) {
  const className = update.className || update.constructor?.name || 'unknown update';
  // UpdateNewChannelMessage / UpdateNewMessage / UpdateEditChannelMessage etc.
  // carry a nested Api.Message at `.message`; UpdateShortMessage /
  // UpdateShortChatMessage carry the text directly as a string at `.message`.
  const nested = update.message;
  const text = typeof nested === 'string' ? nested : nested?.message;
  if (typeof text !== 'string') return className;
  const peerId = typeof nested === 'string' ? null : peerIdOf(nested.peerId);
  const known = peerId != null && knownSourceIds.has(peerId);
  const hasUrl = extractUrls(text).length > 0;
  const preview = text.slice(0, 60).replace(/\s+/g, ' ');
  return `${className} chat=${peerId ?? '(short/private)'} knownSource=${known} hasUrl=${hasUrl} text="${preview}"`;
}

// startReader() used to run backfill unconditionally on every call — fine
// the first time, but bot.js's reconnectReader() calls this same function on
// every reconnect too, and on a flaky connection that could be every few
// minutes. Each re-run re-scanned the *same* last BACKFILL_COUNT messages
// per channel and re-fed them through ingest(), which (combined with
// forgetSeen() rolling back the dedupe claim on most failure reasons) made
// the same handful of doomed URLs get "seen" and skipped over and over,
// forever, inflating /status's counters at a rate that had nothing to do
// with real channel activity. Backfill is a one-time catch-up by design
// (see its own doc comment below) — this flag makes that actually true for
// the lifetime of the process, not just the lifetime of one connection.
let hasBackfilled = false;

export const readerConfigured = () =>
  Boolean(process.env.TG_API_ID && process.env.TG_API_HASH && process.env.TG_SESSION);

// Shared with bot.js (startup ping / heartbeat channel count) so there's one
// place that parses SOURCE_CHANNELS instead of two copies drifting apart.
export const sourceChannels = () =>
  (process.env.SOURCE_CHANNELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

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
  const sources = sourceChannels();
  const backfillCount = Number(process.env.BACKFILL_COUNT ?? '30');

  // TCPObfuscated instead of GramJS's Node default (plain TCPFull): some
  // hosts/networks interfere with the unobfuscated MTProto framing specifically
  // — symptom is exactly what we saw in production, the persistent keep-alive
  // ping (updates.js's internal ~9s ping loop) timing out over and over while
  // one-off requests like backfill's getMessages still went through fine.
  // Wrapping the same bytes as generic-looking encrypted traffic routinely
  // fixes that class of problem without needing anything changed on the VPS.
  const client = new TelegramClient(new StringSession(process.env.TG_SESSION), apiId, apiHash, {
    connectionRetries: 5,
    connection: ConnectionTCPObfuscated,
  });

  // Routes GramJS's own internal error hook (the handful of spots in its
  // source that check `client._errorHandler` before falling through to a
  // bare console.error) through our logging instead. Defense in depth, not
  // a full fix — GramJS's reconnect() has at least one internal promise
  // chain that never checks this hook at all (see the process.on(...)
  // handlers in bot.js, which are what actually catches that one).
  client.onError = async (error) => {
    console.error('reader: GramJS internal error:', error?.message || error);
  };
  // GramJS's own logger otherwise dumps the full stack trace for every ping
  // timeout straight to stderr (that's the spam in the logs) — 'none' quiets
  // it entirely; onError above still gives us a one-line summary of the same
  // events, and none of our own console.log/console.error calls go through
  // this logger, so our actual operational logging is unaffected.
  client.setLogLevel('none');

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
    await client.destroy().catch(() => {});
    throw new Error(`session invalid — ${e.message}`);
  }
  const who = me?.username ? `@${me.username}` : me?.id ? `id ${me.id}` : 'unknown account';
  console.log(`   reader: connected as ${who}`);

  // Resolve each source channel explicitly, up front, instead of leaving it
  // to NewMessage's own lazy chats-filter resolution (which only runs on
  // the *first* dispatched update — see the comment on the Raw handler
  // below for why a failure there is easy to miss). This surfaces "account
  // isn't actually a member" / "handle doesn't resolve" immediately in the
  // logs, and warms the entity cache so the NewMessage filter's own
  // resolution moments later hits cache instead of a cold network lookup.
  const knownSourceIds = new Set();
  for (const src of sources) {
    try {
      const entity = await client.getEntity(src);
      const id = peerIdOf(entity) ?? String(entity?.id ?? '?');
      knownSourceIds.add(id);
      console.log(`   reader: resolved source ${src} -> ${id} (${entity?.title || entity?.username || 'no title'})`);
    } catch (e) {
      console.error(`   reader: FAILED to resolve source ${src} — ${e.message}`);
    }
  }

  // Registered BEFORE the NewMessage handler, and deliberately with no
  // `chats` filter (Raw's own resolve() is a synchronous no-op — see
  // events/Raw.js — so it can never throw here). This matters because
  // _dispatchUpdate (telegram/client/updates.js) calls `await
  // builder.resolve(client)` for each registered handler in a plain
  // for-loop with NO try/catch around that call — if an earlier handler's
  // resolve() throws (e.g. NewMessage's chats-filter resolution failing to
  // look up a source channel), the exception aborts the loop and every
  // handler registered *after* it never runs for that update, or any
  // update, until resolution succeeds. Putting the always-succeeds Raw
  // handler first guarantees it keeps logging even if the NewMessage
  // handler's own filter resolution is the thing silently broken.
  let rawUpdateCount = 0;
  let lastRawUpdateAt = null;
  if (READER_VERBOSE) {
    client.addEventHandler((update) => {
      rawUpdateCount++;
      lastRawUpdateAt = Date.now();
      console.log(`   reader[raw]: ${describeUpdate(update, knownSourceIds)}`);
    }, new Raw({}));
    setInterval(() => {
      const ago = lastRawUpdateAt ? `${Math.round((Date.now() - lastRawUpdateAt) / 1000)}s ago` : 'never';
      console.log(
        `   reader[heartbeat]: ${rawUpdateCount} raw update(s) total · last one ${ago} · client.connected=${client.connected}`
      );
    }, HEARTBEAT_INTERVAL_MS);
  }

  client.addEventHandler(async (event) => {
    const text = event?.message?.message;
    if (READER_VERBOSE) {
      const peerId = peerIdOf(event?.message?.peerId);
      console.log(`   reader[filtered]: chat=${peerId ?? '?'} hasText=${Boolean(text)}${text ? ` text="${text.slice(0, 60).replace(/\s+/g, ' ')}"` : ''}`);
    }
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

  if (!hasBackfilled && backfillCount > 0 && sources.length) {
    hasBackfilled = true;
    backfill(client, sources, onUrl, backfillCount).catch((e) =>
      console.error('reader: backfill error:', e.message)
    );
  } else if (hasBackfilled) {
    console.log('   reader: skipping backfill (already ran once this process)');
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
