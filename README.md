# AliExpress deal bot

Watches your source channels, regenerates each link under your affiliate ID,
and drips curated deals to your Telegram channel every few hours — with a
one-tap approval gate so you stay in control of what goes out.

```
source channels -(reader)-> resolve+dedupe -> productdetail.get / link.generate
   -> approve/reject tap -> queue -> drip 1 every few hours -> your channel
```

## Run it today (no AliExpress keys needed)

Test the entire Telegram pipeline now, in MOCK mode, with just a bot token.

1. `npm install`
2. In Telegram, message @BotFather -> `/newbot` -> copy the token.
3. Add that bot as an ADMIN of your channel (permission: Post Messages).
4. Start a DM with your bot (send it `/start`) so it can send you approvals.
5. `cp .env.example .env` and fill:
   - `TG_BOT_TOKEN` - from BotFather
   - `CHANNEL_ID` - `@BrickDealIL` (or the `-100...` id)
   - `STAGING_CHAT_ID` - your Telegram user id (message @userinfobot to get it)
   - set `POST_INTERVAL_MINUTES` low (e.g. `2`) while testing
6. `npm start`
7. Paste or forward any AliExpress link to your bot -> tap approve -> watch it
   post to the channel within your interval. Mock mode posts a placeholder; the
   plumbing is identical to live.

## Go live

- AliExpress keys (when your API app is approved): fill `ALI_APP_KEY`,
  `ALI_APP_SECRET`, `ALI_TRACKING_ID`. The bot auto-switches from MOCK to real
  titles, prices, and affiliate links. Test one first: `npm run test-link "<url>"`.
- Hands-free reader (optional): auto-ingest from source channels instead of
  forwarding by hand.
  1. Get `TG_API_ID` / `TG_API_HASH` at https://my.telegram.org (use a SECONDARY
     account - automating a personal account is a Telegram grey area; don't risk
     your main).
  2. `npm run login` -> follow prompts -> paste the printed `TG_SESSION` into `.env`.
  3. Set `SOURCE_CHANNELS=@chan1,@chan2` (channels that account has joined).
  4. `npm start` - the reader now feeds candidates into your approval flow.

## Modes

- `STAGING_CHAT_ID` set + `AUTO_APPROVE=false`: you approve/reject each deal (recommended).
  Each staged deal also gets a ✏️ edit button — tap it, reply with corrected
  title/text, and the card re-shows with your edit applied (image and
  affiliate link untouched) for a fresh approve/reject.
- `AUTO_APPROVE=true`: no tap, everything queues automatically.
- `POST_INTERVAL_MINUTES`: how often one queued deal drips out.

Chat commands: `/queue` (how many waiting), `/next` (post one now).

## Files

- `bot.js` - approval gate, scheduler, ingest, publishing.
- `src/reader.js` - optional GramJS source-channel watcher.
- `src/candidate.js` - URL -> stageable deal (mock fallback pre-keys).
- `src/engine.js` / `aliClient.js` / `resolve.js` / `format.js` - the link engine.
- `src/store.js` - dedupe + queue (JSON, no native deps).
- `login.js` - one-time reader session generator.
