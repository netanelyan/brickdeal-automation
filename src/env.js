import { readFileSync } from 'node:fs';

// Hand-rolled on purpose — the whole thing is ~10 lines, not worth pulling in
// the `dotenv` package just for this.
export function loadEnv() {
  try {
    const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let value = m[2];
      if (!/^["']/.test(value)) value = value.replace(/\s+#.*$/, ''); // strip inline comment (not inside quotes)
      value = value.trim().replace(/^["']|["']$/g, '');
      if (!process.env[m[1]]) process.env[m[1]] = value;
    }
  } catch {
    /* no .env file — env may be provided another way */
  }
}
