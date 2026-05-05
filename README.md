# TG Bot — Multipurpose AI Telegram Bot

Powered by Gemini 2.0 Flash + Next.js + Vercel.

## Features
- 💬 General AI chat
- 🔍 Web search (`/search <query>`)
- 🖼️ Image analysis (send any photo)
- 📄 File reading (PDF, txt, etc.)
- 🔒 Webhook secret validation
- 👤 Optional user whitelist

## Setup

### 1. Clone & install
```bash
git clone <your-repo>
cd tgbot
npm install
```

### 2. Environment variables
Copy `.env.example` to `.env.local` and fill in:
```
BOT_TOKEN=        # from @BotFather
GEMINI_API_KEY=   # from aistudio.google.com
WEBHOOK_SECRET=   # run: openssl rand -hex 32
ALLOWED_USERS=    # optional, comma-separated Telegram user IDs e.g. 123456,789012
```

### 3. Deploy to Vercel
```bash
npx vercel deploy
```
Add all env vars in Vercel Dashboard → Settings → Environment Variables.

### 4. Set Telegram Webhook
```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<your-app>.vercel.app/api/webhook&secret_token=<WEBHOOK_SECRET>
```

## Local dev
Use [ngrok](https://ngrok.com) to expose local port then set webhook to ngrok URL.
```bash
npm run dev
ngrok http 3000
```
