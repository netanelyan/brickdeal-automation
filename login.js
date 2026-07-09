import { loadEnv } from './src/env.js';
loadEnv();

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

// Run once on a SECONDARY Telegram account:  npm run login
// Prints a TG_SESSION string to paste into your .env. Keep it secret.
const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;

if (!apiId || !apiHash) {
  console.error('Set TG_API_ID and TG_API_HASH in .env first (get them at https://my.telegram.org).');
  process.exit(1);
}

const rl = readline.createInterface({ input, output });

const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });

await client.start({
  phoneNumber: async () => rl.question('Phone number (with country code): '),
  password: async () => rl.question('2FA password (blank if none): '),
  phoneCode: async () => rl.question('Code Telegram sent you: '),
  onError: (err) => console.error(err),
});

console.log('\n✅ Logged in. Put this in your .env as TG_SESSION:\n');
console.log(client.session.save());
await client.disconnect();
rl.close();
process.exit(0);
