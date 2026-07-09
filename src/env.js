import { readFileSync } from 'node:fs';

export function loadEnv() {
  try {
    const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env file — env may be provided another way */
  }
}
