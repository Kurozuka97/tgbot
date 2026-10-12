# TG Bot — Multipurpose AI Telegram Bot

Next.js 14 (App Router, route handlers only) + [grammY](https://grammy.dev) +
Google Firestore + Groq / Mistral / OpenRouter AI providers. Deploys to Vercel.

## Features

- 💬 Free-form AI chat with per-user history, personas, and provider switching
- 🔍 Live web search (`/search`) — DuckDuckGo HTML, no API key needed
- 📄 Page summarization, image generation, code/story/debate generators
- 🖼️ Photo/document analysis (vision), `/roastme` via caption
- 🎮 Fun & utility: jokes, QR, calculator, URL shortener, currency, time,
  Base64/URL encode, MD5/SHA256 hash, GitHub search
- 🔀 Inline mode: `@bot <query>` and `@bot imagine <prompt>` anywhere
- 🔒 Admin approval queue, bans, maintenance mode, audit log
- 📊 Per-user daily AI quota (Firestore counter), `/stats`, `/broadcast`

## Setup

### 1. Clone & install

```bash
git clone <your-repo>
cd tgbot
npm install
```

### 2. Environment variables

Copy `.env.example` to `.env.local` and fill in the values. Minimum viable
config: `BOT_TOKEN`, `ADMIN_ID`, `WEBHOOK_SECRET`, one AI provider key, and
Firestore credentials.

| Variable | Required | Purpose |
| --- | --- | --- |
| `BOT_TOKEN` | yes | Telegram bot token from @BotFather |
| `ADMIN_ID` | yes | Your numeric Telegram user ID |
| `WEBHOOK_SECRET` | yes | Random secret (`openssl rand -hex 32`) validated per request |
| `GROQ_API_KEY` / `MISTRAL_API_KEY` / `OPENROUTER_API_KEY` | one of | AI providers |
| `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` | yes | Firestore service account |
| `GITHUB_TOKEN` | no | Higher GitHub search rate limits |
| `DAILY_AI_LIMIT` | no | Per-user AI calls/day (default `50`) |
| `LOSSLESS_FETCH_TIMEOUT` | no | Timeout ms for lossless file fetch (default `20000`) |

### 3. Deploy to Vercel

```bash
npx vercel deploy
```

Add every env var in Vercel Dashboard → Settings → Environment Variables.

### 4. Set the Telegram webhook

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<your-app>.vercel.app/api/webhook&secret_token=<WEBHOOK_SECRET>"
```

`/api/webhook` verifies the `X-Telegram-Bot-Api-Secret-Token` header against
`WEBHOOK_SECRET` using a constant-time comparison before doing anything else.

## Local dev

```bash
npm run dev
ngrok http 3000
# then set the webhook to the ngrok URL, as above
```

## Scripts

```bash
npm run build      # production build (works without env vars set)
npm run lint       # ESLint (next/core-web-vitals)
npm run typecheck  # tsc --noEmit
```

## Project layout

```
app/api/webhook/route.ts   webhook entry: secret check → bot.handleUpdate
lib/bot.ts                 getBot(): builds the grammY Bot, wires handlers
lib/handlers/              helpers, commands, admin, media, chat (catch-alls)
lib/ai.ts                  provider clients, model list, history, personas
lib/firebase.ts            Firestore: users, approvals, bans, stats, logs
lib/access.ts              access gate (approval / ban / maintenance)
lib/ratelimit.ts           daily AI quota
lib/search.ts              DuckDuckGo web search
lib/html.ts                AI-output HTML sanitizer for Telegram
lib/util.ts                fetch helpers, URL/SSRF validation, formatting
```

### Handler registration order matters

grammY runs middleware in registration order and stops at the first handler
that does not call `next()`. The catch-alls in `lib/handlers/chat.ts` and
`lib/handlers/media.ts` accept everything, so they **must be registered last**:
in `lib/bot.ts` the order is catch → lossless → admin → commands → media →
chat. Registering a new command after the catch-alls will silently shadow it.

## Access control

- Users start unapproved; `/start` puts them in an admin approval queue.
- `/allow <id>` approves (and un-bans), `/revoke <id>` removes access,
  `/ban <id>` / `/unban <id>` control permanent bans.
- `/maintenance on|off` locks the bot for everyone except the admin.
- Admin sees an extra `/admin` section in `/help`.
