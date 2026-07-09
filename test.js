import { readFileSync } from 'node:fs';
import { urlToMessage } from './src/engine.js';

try {
  const env = readFileSync(new URL('./.env', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const input = process.argv[2];
const debug = process.argv.includes('--debug');

if (!input) {
  console.error('Usage: node test.js <aliexpress-url> [--debug]');
  process.exit(1);
}

urlToMessage(input, { debug })
  .then((r) => {
    if (!r.ok) {
      console.error(`X dropped: ${r.reason}${r.productId ? ` (id ${r.productId})` : ''}`);
      process.exit(2);
    }
    console.log('\n' + r.message + '\n');
    console.error(`OK id=${r.productId} commission=${r.product.commissionRate ?? '?'}% via=${r.resolvedFrom}`);
  })
  .catch((e) => {
    console.error('Error:', e.message);
    process.exit(1);
  });