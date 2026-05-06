import { Telegraf, Context } from 'telegraf'
import { chat, chatWithSearch, fileToGenerativePart, getUserProvider, setUserProvider, getFreeModelList } from './ai'

const bot = new Telegraf(process.env.BOT_TOKEN!)

const ALLOWED_USERS = process.env.ALLOWED_USERS
  ? process.env.ALLOWED_USERS.split(',').map(Number)
  : []

function isAllowed(ctx: Context) {
  if (ALLOWED_USERS.length === 0) return true
  return ALLOWED_USERS.includes(ctx.from?.id ?? 0)
}

// Track users waiting to pick a model: userId → model list
const pendingModelSelection = new Map<number, string[]>()

async function fetchFile(fileId: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const file = await bot.telegram.getFile(fileId)
  const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`
  const res = await fetch(url)
  const buffer = Buffer.from(await res.arrayBuffer())
  const ext = file.file_path?.split('.').pop()?.toLowerCase() ?? ''
  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
    txt: 'text/plain', mp4: 'video/mp4'
  }
  return { buffer, mimeType: mimeMap[ext] ?? 'application/octet-stream' }
}

async function fetchUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TGBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
               .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
               .replace(/<[^>]+>/g, ' ')
               .replace(/\s+/g, ' ')
               .trim()
               .slice(0, 4000)
  } catch {
    return `[Could not fetch URL directly. Using AI knowledge for: ${url}]`
  }
}

bot.start((ctx) => {
  ctx.reply(
    `👋 *Hey! I'm your multipurpose AI assistant.*\n\n` +
    `*AI Commands:*\n` +
    `• /search <query> — AI-powered search\n` +
    `• /weather <city> — current weather\n` +
    `• /translate <lang> <text> — translate text\n` +
    `• /summarize <url> — summarize a webpage\n` +
    `• /explain <topic> — explain anything simply\n` +
    `• /roast <topic> — roast anything 🔥\n` +
    `• /quote — motivational quote\n` +
    `• /model — switch AI provider\n` +
    `• /models — list all free OpenRouter models\n\n` +
    `*Image Commands:*\n` +
    `• /imagine <prompt> — generate an image\n` +
    `• /sticker <prompt> — generate a sticker\n\n` +
    `*Utility Commands:*\n` +
    `• /qr <text> — generate QR code\n` +
    `• /calc <expression> — calculator\n\n` +
    `*Auto:*\n` +
    `• Send any text → AI chat\n` +
    `• Send image → analyze\n` +
    `• Send file → read & summarize\n\n` +
    `Type /help to see this again!`,
    { parse_mode: 'Markdown' }
  )
})

bot.help((ctx) => {
  ctx.reply(
    `*Available Commands:*\n\n` +
    `*AI:*\n` +
    `/search <query> — AI-powered search\n` +
    `/weather <city> — current weather\n` +
    `/translate <lang> <text> — e.g. /translate ms hello\n` +
    `/summarize <url> — summarize a webpage\n` +
    `/explain <topic> — explain anything simply\n` +
    `/roast <topic> — roast anything 🔥\n` +
    `/quote — motivational quote\n` +
    `/model — switch AI provider\n` +
    `/models — list all free OpenRouter models\n\n` +
    `*Image:*\n` +
    `/imagine <prompt> — generate image\n` +
    `/sticker <prompt> — generate sticker\n\n` +
    `*Utility:*\n` +
    `/qr <text> — generate QR code\n` +
    `/calc <expression> — calculator\n\n` +
    `/help — show this menu`,
    { parse_mode: 'Markdown' }
  )
})

bot.command('search', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('⛔ Unauthorized.')
  const query = ctx.message.text.replace(/^\/search(@\w+)?\s*/, '').trim()
  if (!query) return ctx.reply('Usage: /search <query>')
  const msg = await ctx.reply('🔍 Searching...')
  try {
    const result = await chatWithSearch(query, ctx.from?.id)
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, result, { parse_mode: 'Markdown' })
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `❌ Search failed: ${String(err)}`)
  }
})

bot.command('weather', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('⛔ Unauthorized.')
  const city = ctx.message.text.replace(/^\/weather(@\w+)?\s*/, '').trim()
  if (!city) return ctx.reply('Usage: /weather <city>')
  const msg = await ctx.reply('🌤️ Checking weather...')
  try {
    const result = await chat(`What is the typical/current weather in ${city}? Provide temperature range (Celsius), humidity, wind, and general conditions. Format nicely with emojis. Note if data may not be real-time.`, [], ctx.from?.id)
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, result, { parse_mode: 'Markdown' })
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `❌ Failed: ${String(err)}`)
  }
})

bot.command('translate', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('⛔ Unauthorized.')
  const args = ctx.message.text.replace(/^\/translate(@\w+)?\s*/, '').trim()
  if (!args) return ctx.reply('Usage: /translate <lang> <text>\nExample: /translate ms Hello world\nLanguage codes: ms, zh, ja, ko, fr, de, ar, etc.')

  const spaceIdx = args.indexOf(' ')
  let lang: string, text: string
  if (spaceIdx === -1 || args.split(' ')[0].length > 5) {
    lang = 'English'
    text = args
  } else {
    lang = args.slice(0, spaceIdx)
    text = args.slice(spaceIdx + 1).trim()
  }

  const langNames: Record<string, string> = {
    ms: 'Malay', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
    fr: 'French', de: 'German', ar: 'Arabic', es: 'Spanish',
    it: 'Italian', pt: 'Portuguese', ru: 'Russian', th: 'Thai',
    vi: 'Vietnamese', id: 'Indonesian', en: 'English'
  }
  const targetLang = langNames[lang.toLowerCase()] ?? lang

  const msg = await ctx.reply('🌐 Translating...')
  try {
    const result = await chat(`Translate the following text to ${targetLang}. Reply with only the translation, nothing else:\n\n${text}`, [], ctx.from?.id)
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `🌐 *${targetLang}:*\n${result}`, { parse_mode: 'Markdown' })
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `❌ Failed: ${String(err)}`)
  }
})

bot.command('summarize', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('⛔ Unauthorized.')
  const url = ctx.message.text.replace(/^\/summarize(@\w+)?\s*/, '').trim()
  if (!url) return ctx.reply('Usage: /summarize <url>')
  const msg = await ctx.reply('📄 Fetching and summarizing...')
  try {
    const content = await fetchUrl(url)
    const result = await chat(`Summarize the following content in clear bullet points. Be concise:\n\n${content}`, [], ctx.from?.id)
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `📄 *Summary:*\n${result}`, { parse_mode: 'Markdown' })
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `❌ Failed: ${String(err)}`)
  }
})

bot.command('explain', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('⛔ Unauthorized.')
  const topic = ctx.message.text.replace(/^\/explain(@\w+)?\s*/, '').trim()
  if (!topic) return ctx.reply('Usage: /explain <topic>')
  const msg = await ctx.reply('🧠 Thinking...')
  try {
    const result = await chat(`Explain "${topic}" in simple terms that anyone can understand. Be concise and use examples.`, [], ctx.from?.id)
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, result, { parse_mode: 'Markdown' })
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `❌ Failed: ${String(err)}`)
  }
})

bot.command('roast', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('⛔ Unauthorized.')
  const topic = ctx.message.text.replace(/^\/roast(@\w+)?\s*/, '').trim()
  if (!topic) return ctx.reply('Usage: /roast <topic or name>')
  const msg = await ctx.reply('🔥 Roasting...')
  try {
    const result = await chat(`Give a funny, savage but lighthearted roast about: "${topic}". Keep it humorous, not mean-spirited. 3-5 sentences.`, [], ctx.from?.id)
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `🔥 ${result}`, { parse_mode: 'Markdown' })
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `❌ Failed: ${String(err)}`)
  }
})

bot.command('quote', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('⛔ Unauthorized.')
  const msg = await ctx.reply('✨ Generating quote...')
  try {
    const result = await chat('Generate one unique, powerful motivational quote. Format: "quote" — Author (or "Unknown"). Just the quote, nothing else.', [], ctx.from?.id)
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `✨ ${result}`, { parse_mode: 'Markdown' })
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `❌ Failed: ${String(err)}`)
  }
})

bot.command('model', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('⛔ Unauthorized.')
  const arg = ctx.message.text.replace(/^\/model(@\w+)?\s*/, '').trim().toLowerCase()
  const userId = ctx.from?.id!

  if (!arg) {
    const pref = await getUserProvider(userId)
    const current = pref.model ? `openrouter → \`${pref.model}\`` : `\`${pref.provider}\``
    const models = await getFreeModelList()
    return ctx.reply(
      `🤖 *AI Provider Settings*\n\n` +
      `Current: ${current}\n\n` +
      `*Options:*\n` +
      `• /model auto — smart fallback (Groq → OpenRouter → Pollinations)\n` +
      `• /model groq — force Groq only\n` +
      `• /model openrouter — pick from ${models.length} free models\n` +
      `• /model pollinations — force Pollinations only`,
      { parse_mode: 'Markdown' }
    )
  }

  if (arg === 'openrouter') {
    const models = await getFreeModelList()
    pendingModelSelection.set(userId, models)
    const list = models.map((m, i) => `${i + 1}. \`${m}\``).join('\n')
    return ctx.reply(
      `🔀 *OpenRouter Free Models (${models.length}):*\n\n${list}\n\n` +
      `Reply with the *number* to select.\nType /model auto to cancel.`,
      { parse_mode: 'Markdown' }
    )
  }

  const valid = ['auto', 'groq', 'pollinations']
  if (!valid.includes(arg)) {
    return ctx.reply(`❌ Invalid option. Choose: auto, groq, openrouter, pollinations`)
  }

  pendingModelSelection.delete(userId)
  await setUserProvider(userId, arg)
  const labels: Record<string, string> = {
    auto: '🔄 Auto fallback (recommended)',
    groq: '⚡ Groq (fastest)',
    pollinations: '🌸 Pollinations (no key needed)'
  }
  ctx.reply(`✅ Provider set to *${arg}*\n${labels[arg]}`, { parse_mode: 'Markdown' })
})

bot.command('models', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('⛔ Unauthorized.')
  const msg = await ctx.reply('⏳ Fetching models...')
  try {
    const models = await getFreeModelList()
    const list = models.map((m, i) => `${i + 1}. \`${m}\``).join('\n')
    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, undefined,
      `🔀 *OpenRouter Free Models (${models.length}):*\n\n${list}`,
      { parse_mode: 'Markdown' }
    )
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `❌ Failed: ${String(err)}`)
  }
})

bot.command('imagine', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('⛔ Unauthorized.')
  const prompt = ctx.message.text.replace(/^\/imagine(@\w+)?\s*/, '').trim()
  if (!prompt) return ctx.reply('Usage: /imagine <prompt>')
  const msg = await ctx.reply('🎨 Generating image...')
  try {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${Date.now()}`
    const res = await fetch(url)
    if (!res.ok) throw new Error('Failed to fetch image')
    const buffer = Buffer.from(await res.arrayBuffer())
    await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id)
    await ctx.replyWithPhoto({ source: buffer }, { caption: `🎨 *${prompt}*`, parse_mode: 'Markdown' })
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `❌ Failed: ${String(err)}`)
  }
})

bot.command('sticker', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('⛔ Unauthorized.')
  const prompt = ctx.message.text.replace(/^\/sticker(@\w+)?\s*/, '').trim()
  if (!prompt) return ctx.reply('Usage: /sticker <prompt>')
  const msg = await ctx.reply('🎭 Generating sticker...')
  try {
    const stickerPrompt = `${prompt}, sticker art style, bold outlines, vibrant colors, white background, cute kawaii style`
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(stickerPrompt)}?width=512&height=512&nologo=true&seed=${Date.now()}`
    const res = await fetch(url)
    if (!res.ok) throw new Error('Failed to generate sticker')
    const buffer = Buffer.from(await res.arrayBuffer())
    await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id)
    await ctx.replyWithPhoto({ source: buffer }, { caption: `🎭 *${prompt}*`, parse_mode: 'Markdown' })
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `❌ Failed: ${String(err)}`)
  }
})

bot.command('qr', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('⛔ Unauthorized.')
  const text = ctx.message.text.replace(/^\/qr(@\w+)?\s*/, '').trim()
  if (!text) return ctx.reply('Usage: /qr <text or url>')
  const msg = await ctx.reply('📱 Generating QR code...')
  try {
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encodeURIComponent(text)}`
    const res = await fetch(url)
    if (!res.ok) throw new Error('Failed to generate QR')
    const buffer = Buffer.from(await res.arrayBuffer())
    await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id)
    await ctx.replyWithPhoto({ source: buffer }, { caption: `📱 QR Code for: \`${text}\``, parse_mode: 'Markdown' })
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `❌ Failed: ${String(err)}`)
  }
})

bot.command('calc', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('⛔ Unauthorized.')
  const expr = ctx.message.text.replace(/^\/calc(@\w+)?\s*/, '').trim()
  if (!expr) return ctx.reply('Usage: /calc <expression>\nExample: /calc 2 + 2 * 10')
  try {
    const sanitized = expr.replace(/[^0-9+\-*/.() %]/g, '')
    if (!sanitized) throw new Error('Invalid expression')
    const result = Function(`"use strict"; return (${sanitized})`)()
    ctx.reply(`🧮 \`${expr}\` = *${result}*`, { parse_mode: 'Markdown' })
  } catch {
    ctx.reply('❌ Invalid expression. Example: /calc 100 * 1.06')
  }
})

bot.on('photo', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('⛔ Unauthorized.')
  const msg = await ctx.reply('🖼️ Analyzing image...')
  try {
    const photo = ctx.message.photo.at(-1)!
    const { buffer, mimeType } = await fetchFile(photo.file_id)
    const part = fileToGenerativePart(buffer, mimeType)
    const caption = ctx.message.caption ?? 'Describe this image in detail.'
    const result = await chat(caption, [part], ctx.from?.id)
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, result, { parse_mode: 'Markdown' })
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `❌ Failed: ${String(err)}`)
  }
})

bot.on('document', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('⛔ Unauthorized.')
  const msg = await ctx.reply('📄 Reading file...')
  try {
    const doc = ctx.message.document
    const { buffer, mimeType } = await fetchFile(doc.file_id)
    const part = fileToGenerativePart(buffer, mimeType)
    const caption = ctx.message.caption ?? 'Summarize the contents of this file.'
    const result = await chat(caption, [part], ctx.from?.id)
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, result, { parse_mode: 'Markdown' })
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `❌ Failed: ${String(err)}`)
  }
})

bot.on('text', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('⛔ Unauthorized.')
  const userId = ctx.from?.id!
  const text = ctx.message.text

  // Check if user is in model selection mode
  if (pendingModelSelection.has(userId)) {
    const models = pendingModelSelection.get(userId)!
    const num = parseInt(text.trim())
    if (isNaN(num) || num < 1 || num > models.length) {
      return ctx.reply(`❌ Invalid. Pick 1–${models.length}, or /model auto to cancel.`)
    }
    const selected = models[num - 1]
    pendingModelSelection.delete(userId)
    await setUserProvider(userId, 'openrouter', selected)
    return ctx.reply(
      `✅ *Model selected!*\n\n\`${selected}\`\n\nAll messages will use this model now.`,
      { parse_mode: 'Markdown' }
    )
  }

  // Normal AI chat
  const msg = await ctx.reply('💭 Thinking...')
  try {
    const result = await chat(text, [], userId)
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, result, { parse_mode: 'Markdown' })
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `❌ Error: ${String(err)}`)
  }
})

export default bot
