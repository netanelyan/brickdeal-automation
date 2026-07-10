# AliExpress Deal Bot

A small Telegram bot that watches LEGO-deal channels, regenerates every link
under my AliExpress affiliate ID, and drips curated deals into my own channel
(`@BrickDealIL`) a few at a time — with a one-tap approve/reject/edit gate so
nothing goes out that I haven't actually looked at.

I built this because I didn't want to manually copy-paste links and rewrite
titles every day. It's not a SaaS, it's not trying to be generic — it's a
personal deal-flow pipeline that happens to be a decent example of a small,
real, end-to-end system: ingestion, dedupe, an external paid API, an
optional AI step, a human-in-the-loop approval UI, and a scheduler, in
~600 lines total and one JSON file for storage.

```
source channels ──(reader, optional)──┐
                                       ▼
        forwarded/pasted link ──▶ resolve + dedupe ──▶ candidate build
                                                        (live AliExpress API,
                                                         or MOCK without keys)
                                                                │
                                                     AI title polish (optional)
                                                                │
                                                        Hebrew card format
                                                                ▼
                                        Telegram staging card: ✅ ✏️ ❌ ⏭️
                                                                │
                                              approved ──▶ publish queue
                                                                │
                                            drip 1 deal every N minutes
                                                                ▼
                                                          your channel
```

## How it works

1. **Ingestion.** A link reaches the bot either by you forwarding/pasting it
   in a DM, or — if you've wired up the optional reader — by the bot's own
   userbot account watching source channels and picking up AliExpress links
   automatically, including a one-time backfill of each channel's recent
   history on startup.
2. **Resolve + dedupe.** Every link (full URL, `s.click` short link, bare
   product ID) gets resolved down to a canonical numeric product ID, which is
   claimed in the dedupe store *before* the slow AliExpress calls run — that
   ordering matters (see "things I learned" below).
3. **Candidate build.** With AliExpress affiliate keys configured, this hits
   the real `productdetail.get` + `link.generate` endpoints for a real title,
   price, image, and short affiliate link. Without keys, it builds a MOCK
   candidate instead, so the entire Telegram pipeline — staging, edit,
   approve, queue, drip — can be tested before an AliExpress API app is even
   approved.
4. **AI polish (optional).** If `ANTHROPIC_API_KEY` is set, the scraped title
   gets rewritten by Claude into a proper Hebrew LEGO-store name — the
   official set name when it recognizes the set, otherwise an evocative
   shelf-style name instead of a literal listing description.
5. **Staging.** The formatted card goes to your staging chat with four
   buttons: ✅ approve, ❌ reject, ✏️ edit, ⏭️ skip. Edit sends you a
   force-reply prompt; whatever you type back replaces just the title line —
   image and affiliate link are left untouched — and the card re-renders with
   fresh buttons for a final approve/reject.
6. **Queue + drip.** Approved deals sit in a queue and get published to the
   channel one at a time on a timer, instead of dumping everything at once.

## Stack

- **Node 18+, plain ESM** — no bundler, no build step, no framework beyond the two libraries below.
- **[telegraf](https://github.com/telegraf/telegraf)** — the bot side (staging UI, commands, publishing).
- **[telegram](https://github.com/gram-js/gramjs) (GramJS)** — the optional userbot reader, since watching channels your *bot account* hasn't joined requires a real logged-in account.
- **Anthropic API** — optional, only for the title-polish step.
- **Storage** — a single JSON file (`data/store.json`), written atomically (tmp file + rename). No database, on purpose, at this scale.

## File map

| File | What it does |
|---|---|
| `bot.js` | The Telegraf bot: staging cards and their approve/reject/edit/skip buttons, `/queue` `/next` `/pending` `/clear_pending`, the drip-publish timer, and startup wiring. |
| `src/candidate.js` | Turns a raw URL into a stageable candidate — real via `engine.js` when AliExpress keys exist, otherwise a MOCK candidate. |
| `src/engine.js` | The real pipeline: resolve product ID → `productdetail.get` → generate/shorten affiliate link → AI polish → format the card. |
| `src/aliClient.js` | Hand-rolled AliExpress affiliate API client — HMAC-SHA256 request signing, automatic retry on rate limits. |
| `src/resolve.js` | Turns any AliExpress URL shape (or a bare ID) into a canonical product ID; pulls AliExpress URLs out of free-form message text. |
| `src/format.js` | The Hebrew Telegram card template (title, set id, pieces, price, link, brand/disclosure line). |
| `src/polish.js` | Optional Claude-powered Hebrew title rewrite. No-ops silently without `ANTHROPIC_API_KEY`. |
| `src/sourceText.js` | Regex fallback that pulls a set number / piece count out of the surrounding channel message, for when AliExpress's own title doesn't have one. |
| `src/shorten.js` | Last-resort URL shortener chain (v.gd → is.gd → tinyurl) for the rare affiliate link too long for a caption. |
| `src/store.js` | The whole persistence layer — dedupe (TTL'd), publish queue, staging map, and pending-edit state — as one JSON file. |
| `src/notify.js` | The Hebrew status DMs (startup ping, heartbeat, quality-skip visibility, quiet/reader alerts) — pure formatters plus one thin `send`. |
| `src/reader.js` | Optional GramJS userbot: live-watches source channels and does a throttled backfill of recent history on startup. |
| `src/env.js` | A ~10-line `.env` loader, so the project doesn't need a `dotenv` dependency. |
| `login.js` | One-time interactive script that generates the `TG_SESSION` string the reader needs. |
| `test.js` | CLI: run one URL through the real engine and print the resulting card, without touching Telegram at all. |

## Try it now (no AliExpress keys needed)

1. `npm install`
2. Message @BotFather → `/newbot` → copy the token.
3. Add that bot as an ADMIN of your channel (permission: Post Messages).
4. Start a DM with your bot (send it `/start`) so it can send you approvals.
5. `cp .env.example .env` and fill in:
   - `TG_BOT_TOKEN` — from BotFather
   - `CHANNEL_ID` — `@YourChannel` (or the `-100...` numeric id)
   - `STAGING_CHAT_ID` — your Telegram user id (message @userinfobot to get it)
   - set `POST_INTERVAL_MINUTES` low (e.g. `2`) while testing
6. `npm start`
7. Paste or forward any AliExpress link to your bot → tap ✅ → watch it post
   to the channel within your interval. MOCK mode posts a placeholder card;
   the plumbing is identical to live.

## Going live

- **AliExpress keys** (once your API app is approved): fill `ALI_APP_KEY`,
  `ALI_APP_SECRET`, `ALI_TRACKING_ID`. The bot switches from MOCK to real
  titles/prices/links automatically. Sanity-check one link first:
  `npm run test-link "<url>"`.
- **Hands-free reader** (optional): auto-ingest from source channels instead
  of forwarding by hand.
  1. Get `TG_API_ID` / `TG_API_HASH` at https://my.telegram.org — use a
     **secondary** account (see the security note below).
  2. `npm run login` → follow the prompts → paste the printed `TG_SESSION`
     into `.env`.
  3. Set `SOURCE_CHANNELS=@chan1,@chan2` (channels that account has joined).
  4. `npm start` — the reader now feeds candidates into your approval flow,
     including a one-time backfill of `BACKFILL_COUNT` past messages per
     channel.
- **AI title polish** (optional): set `ANTHROPIC_API_KEY`. Costs a tiny bit
  per candidate, off entirely without a key.

## Deployment (pm2)

```
npm install -g pm2
pm2 start bot.js --name deal-bot
pm2 save
pm2 startup        # follow the printed command so it survives a reboot
pm2 logs deal-bot
```

- **Run exactly one instance.** `data/store.json` isn't safe for concurrent
  writers — don't use `pm2 start bot.js -i max` or cluster mode.
- `.env` is read once at process start (`src/env.js`), so run
  `pm2 restart deal-bot` after changing it.
- `data/store.json` lives on disk next to the code — back it up if you care
  about dedupe history / queue state surviving a redeploy.

## Monitoring

The bot DMs `STAGING_CHAT_ID` in Hebrew so I always know what it's doing
without tailing logs on a server:

- **Startup ping** — one line on boot: reader status, current queue size,
  number of source channels.
- **Heartbeat** — every `HEARTBEAT_HOURS` (default 6), one line: deals seen /
  staged / skipped for quality / skipped as duplicates since the last
  heartbeat, current queue size. Only sent while the reader is actually
  connected — no news isn't news if there's nothing watching for news.
- **Quality-skip visibility** — the low-quality filter used to drop things
  silently, which meant I couldn't tell if it was too aggressive. Now every
  skip is reported with its name/id and affiliate link so I can judge for
  myself. `QUALITY_SKIP_NOTIFY` controls how: `off`, `each` (one DM per
  skip), or `digest` (default — batched every `SKIP_DIGEST_HOURS`, so a
  noisy source channel doesn't turn into a wall of messages).
- **Quiet alert** — if the reader is connected but hasn't ingested anything
  in `QUIET_ALERT_HOURS` (default 3), one alert, once — not repeated for as
  long as the silence continues.
- **Reader drop + reconnect** — if the GramJS connection drops (or never
  connects), an immediate alert, then automatic reconnect attempts with
  backoff (30s → 1m → 2m → 4m → 5m, then holding at 5m). A second alert
  fires if it's still down after 5 attempts; reconnecting successfully sends
  its own "back up" DM.

## Config reference (`.env`)

Names only — see `.env.example` for the full file with inline comments.

**Telegram bot (required)**
`TG_BOT_TOKEN`, `CHANNEL_ID`, `STAGING_CHAT_ID`, `OWNER_ID`

**Behaviour**
`POST_INTERVAL_MINUTES`, `AUTO_APPROVE`, `SEEN_TTL_DAYS`

**Monitoring** (status DMs to `STAGING_CHAT_ID`, in Hebrew — see below)
`HEARTBEAT_HOURS`, `SKIP_DIGEST_HOURS`, `QUALITY_SKIP_NOTIFY`, `QUIET_ALERT_HOURS`

**Localisation** (passed straight to AliExpress's `productdetail.get`)
`TARGET_CURRENCY`, `TARGET_LANGUAGE`, `TARGET_COUNTRY`

**AI title polish (optional)**
`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`

**Auto-reader (optional)**
`TG_API_ID`, `TG_API_HASH`, `TG_SESSION`, `SOURCE_CHANNELS`, `BACKFILL_COUNT`

**AliExpress**
`ALI_APP_KEY`, `ALI_APP_SECRET`, `ALI_TRACKING_ID`, `ALI_APP_SIGNATURE`,
`BRAND_NAME`, `DISCLOSURE`

## Honest notes & caveats

A few things worth knowing before you lean on this for real money or a real audience.

The datastore is one JSON file, and honestly that's fine for what this is — one person, one process. It writes to a temp file and renames it into place, so a crash mid-write won't leave you with a corrupted file, just possibly a slightly stale one. What it won't survive is two copies of the bot pointed at the same `data/` folder at once, so don't do that.

The low-quality filter (`lowQualityReason` in `bot.js`) only actually rejects anything when `AUTO_APPROVE=true`. With manual approval on — the default, and the whole point of having a staging chat — junk listings still land in front of you. You're the real filter in that mode, not the code.

`SEEN_TTL_DAYS` defaults to 10, so a product you already posted can come back around after ten days. That's intentional, since prices move, but it means "already posted" is more of a cooldown than a real guarantee.

`src/reader.js` logs into an actual Telegram account, not a bot account, so it can watch channels your bot could never join on its own. That puts it in a gray area of Telegram's rules around automation. I run it on a throwaway secondary account and wouldn't point it at a main one.

Two small things I noticed while writing this that I haven't gone back and fixed: there's a leftover `src/.env.example` that nothing actually reads (the real loader always reads the root `.env`), and `test.js` has its own little copy-pasted `.env` parser instead of just importing `loadEnv` from `src/env.js`. Neither is breaking anything, they're just untidy.

And it's Hebrew only — `src/format.js` hardcodes the store copy directly (מק״ט, חלקים, תואם מקור, and so on), so there's no language switch. Supporting another language means editing that one file by hand.

## Things I learned building this

`bot.launch()` doesn't resolve during normal operation — it *is* the poll loop. I originally awaited it before doing anything else, which silently queued the startup logs, the drip timer, and the reader behind a promise that only fires on shutdown. For a while I genuinely thought the bot was hanging on startup, when it was actually working fine and I was just waiting on the wrong thing. Fixed it by calling `getMe()` to confirm the connection instead, then firing `launch()` without awaiting it.

AliExpress's signing scheme for the `/sync` endpoint doesn't seem to be documented anywhere I could find, so I reverse-engineered it against the live API: sort the params by key, glue each one together as `key` then `value` with nothing in between, HMAC-SHA256 the result with the app secret, hex-encode it, uppercase it. Get any single step slightly wrong and all you get back is "invalid signature," with no hint about what actually broke.

I also learned to claim a product ID in the dedupe store *before* the slow AliExpress calls, not after. Two source channels sometimes post the exact same deal within seconds of each other, and if the dedupe check only runs after the API round-trip, both can sneak past it and get staged twice.

The edit-before-approve flow taught me something similar. My first version tracked "the deal currently being edited" as a single value per chat, and it broke the moment two deals were mid-edit at the same time — whichever one you edited second would quietly steal the reply meant for the first. Matching Telegram's `reply_to_message` id back to each specific staged item fixed that properly instead of just making it less likely.

And Telegram photo captions cap out around 1000 characters, which a real scraped title plus a full affiliate link blows past more often than you'd expect. `deliver()` checks the length up front and falls back to a plain text message (up to 4096 characters) instead of just failing to send — the same fallback also catches titles with a stray `*`, `_`, or backtick that would otherwise break Telegram's Markdown parser.

## Security

- Every credential lives only in `.env`, which is gitignored — I checked
  this repo's full git history before making it public and `.env` has never
  been committed.
- `data/` (dedupe history, queue, staging) is gitignored too, so
  cloning/forking this repo doesn't leak what's already been posted.
- The AliExpress app secret never goes over the wire — it's used locally to
  HMAC-sign each request; only the resulting signature is sent.
- `TG_SESSION` (used by the optional reader) is effectively a password for a
  real Telegram account — anyone who gets it can read/send as that account
  without needing 2FA again. Treat it like a credential, never log it, and
  regenerate it with `npm run login` if it's ever exposed.
- **Fixed:** `bot.js` now checks `ctx.from.id` against `OWNER_ID` in a single
  Telegraf middleware registered before any other handler — every message,
  forward, `/command`, and button tap from anyone else gets a curt
  "not authorized" and goes nowhere. The bot refuses to start at all if
  `OWNER_ID` isn't set, so a missing config value fails closed instead of
  quietly opening the bot up to whoever finds the username. This only covers
  this Telegraf bot's own chat surface — the GramJS reader in `src/reader.js`
  ingests straight from source channels through a separate client and was
  never reachable by a stranger to begin with.
- No `eval`, no shell-outs, no HTML rendering of scraped content anywhere —
  URLs are only ever fetched (`GET`) or regex-matched. The only "rendering"
  is Telegram's own Markdown parser, which can't execute anything even on
  adversarial input; worst case it fails to parse and the code falls back to
  stripped plain text (see above).
