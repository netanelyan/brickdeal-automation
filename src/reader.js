import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { extractUrls } from './resolve.js';

export const readerConfigured = () =>
  Boolean(process.env.TG_API_ID && process.env.TG_API_HASH && process.env.TG_SESSION);

// Watches your source channels (as your own logged-in account) and calls
// onUrl(url) for every AliExpress link it sees. This is a "userbot": automating
// a personal account is a Telegram grey area, so run it on a SECONDARY account,
// never your main. Generate TG_SESSION once with `npm run login`.
export async function startReader(onUrl) {
  const apiId = Number(process.env.TG_API_ID);
  const apiHash = process.env.TG_API_HASH;
  const sources = (process.env.SOURCE_CHANNELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const client = new TelegramClient(new StringSession(process.env.TG_SESSION), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();

  client.addEventHandler(async (event) => {
    const text = event?.message?.message;
    if (!text) return;
    for (const url of extractUrls(text)) {
      try {
        await onUrl(url);
      } catch (e) {
        console.error('reader onUrl error:', e.message);
      }
    }
  }, new NewMessage({ chats: sources.length ? sources : undefined }));

  console.log(`👀 reader watching ${sources.length || 'all joined'} source channel(s)`);
  return client;
}
