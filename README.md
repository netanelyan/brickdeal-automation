# AliExpress Deal Bot

A small Telegram bot that watches LEGO-deal channels, regenerates every link
under my AliExpress affiliate ID, and drips curated deals into my own channel
(`@BrickDealIL`) a few at a time — with a one-tap approve/reject/edit gate so
nothing goes out that I haven't actually looked at.

I built this because I didn't want to manually copy-paste links and rewrite
titles every day. It's not a SaaS, it's not trying to be generic — it's a
personal deal-flow pipeline that happens to be a decent example of a small,
real, end-to-end system: ingestion, dedupe, an external paid API, an
optional AI step, a human-in-the-loop approval UI, a scheduler, and its own
monitoring, in about 1,400 lines total and one JSON file for storage.

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
                                        Telegram staging card: ✅ ❌ ✏️ ⏭️
                                                                │
                                              approved ──▶ publish queue
                                                                │
                                            drip 1 deal every N minutes
                                                                ▼
                                                          your channel
```

## How it works

A link reaches the bot one of two ways: I forward or paste it in myself, or —
if I've wired up the optional reader — my own userbot account is already
sitting in the source channels and picks up AliExpress links as they're
posted, including a one-time backfill of each channel's recent history when
the reader starts up.

However it arrives, the URL gets resolved down to a canonical numeric
product ID first, and that ID gets claimed in the dedupe store *before* any
of the slow AliExpress calls run — that ordering matters, more on why in
"things I learned" below. Then the candidate itself gets built: with
AliExpress affiliate keys configured, that's a real hit against
`productdetail.get` and `link.generate` for the actual title, price, image,
and a short affiliate link. Without keys, it builds a MOCK candidate
instead, so I could test the whole Telegram pipeline — staging, edit,
approve, queue, drip — before my AliExpress API app was even approved.

If `ANTHROPIC_API_KEY` is set, the scraped title then gets rewritten by
Claude into a proper Hebrew LEGO-store name: the actual official set name
when it recognizes the set, or an evocative shelf-style name instead of a
literal listing description when it doesn't.

From there the formatted card lands in my staging chat with four buttons:
✅ approve, ❌ reject, ✏️ edit, ⏭️ skip. Edit sends a force-reply prompt, and
whatever I type back replaces just the title line — image and affiliate
link are left completely alone — then the card re-renders with fresh
buttons so I can give it a final approve or reject. Approved deals sit in a
queue and get published to the channel one at a time on a timer, instead of
dumping everything at once.

## Stack

Deliberately boring: Node 18+, plain ESM, no bundler, no build step, no
framework beyond the two libraries below.

- **[telegraf](https://github.com/telegraf/telegraf)** for the bot side — staging UI, commands, publishing.
- **[telegram](https://github.com/gram-js/gramjs)** (GramJS) for the optional userbot reader, since watching channels your *bot account* hasn't joined requires a real logged-in account.
- The Anthropic API, optional, only for the title-polish step.
- Storage is a single JSON file (`data/store.json`), written atomically (tmp file + rename). No database, on purpose, at this scale.

## File map

| File | What it does |
|---|---|
| `bot.js` | The Telegraf bot: the `OWNER_ID` lock, staging cards and their approve/reject/edit/skip buttons, `/queue` `/next` `/pending` `/clear_pending` `/status` `/why` `/debug`, the drip-publish timer, reader supervision/reconnect, and startup wiring. |
| `src/candidate.js` | Turns a raw URL into a stageable candidate — real via `engine.js` when AliExpress keys exist, otherwise a MOCK candidate. |
| `src/engine.js` | The real pipeline: resolve product ID → `productdetail.get` → generate/shorten affiliate link → AI polish → format the card. |
| `src/aliClient.js` | Hand-rolled AliExpress affiliate API client — HMAC-SHA256 request signing, automatic retry on rate limits. |
| `src/resolve.js` | Turns any AliExpress URL shape (or a bare ID) into a canonical product ID; pulls AliExpress URLs out of free-form message text. |
| `src/format.js` | The Hebrew Telegram card template (title, set id, pieces, price, rating, link, brand/disclosure line). |
| `src/polish.js` | Optional Claude-powered Hebrew title rewrite. No-ops silently without `ANTHROPIC_API_KEY`. |
| `src/sourceText.js` | Regex fallback that pulls a set number / piece count out of the surrounding channel message, for when AliExpress's own title doesn't have one. |
| `src/shorten.js` | Last-resort URL shortener chain (v.gd → is.gd → tinyurl) for the rare affiliate link too long for a caption. |
| `src/store.js` | The whole persistence layer — dedupe (TTL'd), publish queue, staging map, and pending-edit state — as one JSON file. |
| `src/notify.js` | The Hebrew status DMs (startup ping, heartbeat, quality-skip visibility, quiet/reader alerts) — pure formatters plus one thin `send`. |
| `src/reader.js` | Optional GramJS userbot: watches source channels (live push where Telegram delivers it, otherwise a `CHANNEL_POLL_MINUTES` poll of each channel's latest messages — broadcast channels don't reliably push to a plain user client) and does a throttled backfill of recent history on startup. |
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
   - `OWNER_ID` — same id as above; the bot refuses to start without it, and
     ignores anyone whose id doesn't match
   - set `POST_INTERVAL_MINUTES` low (e.g. `2`) while testing
6. `npm start`
7. Paste or forward any AliExpress link to your bot → tap ✅ → watch it post
   to the channel within your interval. MOCK mode posts a placeholder card;
   the plumbing is identical to live.

## Going live

Once your AliExpress API app is approved, fill in `ALI_APP_KEY`,
`ALI_APP_SECRET`, and `ALI_TRACKING_ID` — the bot switches from MOCK to real
titles, prices, and links automatically. Worth sanity-checking one link
first: `npm run test-link "<url>"`.

The reader is optional but nice once you're past testing — it auto-ingests
from source channels instead of you forwarding links by hand:

1. Get `TG_API_ID` / `TG_API_HASH` at https://my.telegram.org — use a
   **secondary** account (see the security note below on why).
2. `npm run login` → follow the prompts → paste the printed `TG_SESSION`
   into `.env`.
3. Set `SOURCE_CHANNELS=@chan1,@chan2` (channels that account has joined).
4. `npm start` — the reader now feeds candidates into your approval flow,
   including a one-time backfill of `BACKFILL_COUNT` past messages per
   channel.

AI title polish is optional too — just set `ANTHROPIC_API_KEY`. Costs a
tiny bit per candidate, and is skipped entirely without a key.

## Deployment (pm2)

```
npm install -g pm2
pm2 start bot.js --name deal-bot
pm2 save
pm2 startup        # follow the printed command so it survives a reboot
pm2 logs deal-bot
```

- Run exactly one instance — `data/store.json` isn't safe for concurrent
  writers, so don't use `pm2 start bot.js -i max` or cluster mode.
- `.env` is read once at process start (`src/env.js`), so run
  `pm2 restart deal-bot` after changing it.
- `data/store.json` lives on disk next to the code — back it up if you care
  about dedupe history / queue state surviving a redeploy.

## Monitoring

The bot DMs `STAGING_CHAT_ID` in Hebrew so I always know what it's doing
without tailing logs on a server. On boot it sends a one-line startup ping
— reader status, current queue size, number of source channels — and then
every `HEARTBEAT_HOURS` (default 6) a heartbeat: deals seen, staged,
skipped for quality, and skipped as duplicates since the last one, plus the
current queue size. That only goes out while the reader is actually
connected, since there's not much point reporting on nothing.

The quality-skip visibility is the one I actually built this for. The
low-quality filter used to drop things silently, which meant I had no way
to tell if it was too aggressive — was it saving me from junk, or quietly
throwing away good deals? Now every skip gets reported with its name/id and
affiliate link so I can judge for myself. `QUALITY_SKIP_NOTIFY` controls how
loud that is: `off`, `each` (one DM per skip), or `digest` (the default —
batched every `SKIP_DIGEST_HOURS`, so a noisy source channel doesn't turn
into a wall of messages).

Two more safety nets on top of that: a quiet alert fires once, not
repeatedly, if the reader's connected but hasn't ingested anything in
`QUIET_ALERT_HOURS` (default 3); and if the GramJS connection actually drops
— or never connects in the first place — I get an immediate alert followed
by automatic reconnect attempts with backoff (30s → 1m → 2m → 4m → 5m, then
holding at 5m). A second alert fires if it's still down after 5 attempts,
and reconnecting successfully sends its own "back up" DM.

`/status` is the pull version of all that — reader connection state and how
long it's been up, current queue size, and a last-24h breakdown (seen /
staged / duplicates / low-quality / failed-to-resolve, and the
failed-to-resolve bucket broken down by its exact reason — `not_promotable`,
`no_product_id`, `no_link`, `api_error`, `timeout`), so "why haven't I gotten
any deals" has an answer on demand instead of waiting for the next
heartbeat. `/why [n]` is the companion — the actual last `n` skipped deals
(default 10, capped at 25) with their reason and link, not just the count.

`/debug [n]` (default 5, capped 20) traces the next `n` links end to end as
they happen — source, resolved product ID, the raw API result, and the
final outcome, one DM per link. `DEBUG=true` arms the same trace for the
first 10 links on boot, no command needed.

## Config reference (`.env`)

Names only — see `.env.example` for the full file with inline comments.

**Telegram bot (required)**
`TG_BOT_TOKEN`, `CHANNEL_ID`, `STAGING_CHAT_ID`, `OWNER_ID`

**Behaviour**
`POST_INTERVAL_MINUTES`, `AUTO_APPROVE`, `SEEN_TTL_DAYS`

**Monitoring** (status DMs to `STAGING_CHAT_ID`, in Hebrew — see below)
`HEARTBEAT_HOURS`, `SKIP_DIGEST_HOURS`, `QUALITY_SKIP_NOTIFY`, `QUIET_ALERT_HOURS`, `DEBUG`

**Localisation** (passed straight to AliExpress's `productdetail.get`)
`TARGET_CURRENCY`, `TARGET_LANGUAGE`, `TARGET_COUNTRY`

**AI title polish (optional)**
`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`

**Auto-reader (optional)**
`TG_API_ID`, `TG_API_HASH`, `TG_SESSION`, `SOURCE_CHANNELS`, `BACKFILL_COUNT`, `CHANNEL_POLL_MINUTES`, `READER_VERBOSE`

**AliExpress**
`ALI_APP_KEY`, `ALI_APP_SECRET`, `ALI_TRACKING_ID`, `ALI_APP_SIGNATURE`,
`BRAND_NAME`, `DISCLOSURE`

## Honest notes & caveats

A few things worth knowing before you lean on this for real money or a real audience.

The datastore is one JSON file, and honestly that's fine for what this is — one person, one process. It writes to a temp file and renames it into place, so a crash mid-write won't leave you with a corrupted file, just possibly a slightly stale one. What it won't survive is two copies of the bot pointed at the same `data/` folder at once, so don't do that.

The low-quality filter (`lowQualityReason` in `bot.js`) runs before a candidate ever reaches the queue *or* the staging chat, regardless of `AUTO_APPROVE`. That surprised me when I first read my own code back — I'd assumed manual approval meant I was the filter, but really the filter decides first and I only ever see what survives it. That's exactly why the quality-skip notifications above exist: without them, a too-aggressive filter would fail silently and I'd never know what I was missing.

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

- Every credential lives only in `.env`, which is gitignored.
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
