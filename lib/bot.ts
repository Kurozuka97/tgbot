process.emitWarning = () => {}
import { Bot, InputFile } from 'grammy'
import {
  chat, chatWithSearch, fileToGenerativePart,
  getUserProvider, setUserProvider, getFreeModelList, MISTRAL_MODELS,
  getHistory, appendHistory, clearHistory,
  getPersona, setPersona, PERSONA_LIST
} from './ai'
import { db } from './firebase'

const bot = new Bot(process.env.BOT_TOKEN!)

const ADMIN_ID = Number(process.env.ADMIN_ID)

// ─── User Access (Firestore) ───────────────────────────────────────────────

async function isAllowed(userId: number): Promise<boolean> {
  if (userId === ADMIN_ID) return true
  const doc = await db.collection('tgbot_users').doc(String(userId)).get()
  return doc.exists && doc.data()?.allowed === true
}

async function allowUser(userId: number, username?: string) {
  await db.collection('tgbot_users').doc(String(userId)).set({
    allowed: true,
    username: username ?? null,
    allowedAt: new Date().toISOString()
  }, { merge: true })
}

async function blockUser(userId: number) {
  await db.collection('tgbot_users').doc(String(userId)).set({
    allowed: false,
    blockedAt: new Date().toISOString()
  }, { merge: true })
}

async function addPendingRequest(userId: number, username?: string, firstName?: string) {
  await db.collection('tgbot_pending').doc(String(userId)).set({
    userId,
    username: username ?? null,
    firstName: firstName ?? null,
    requestedAt: new Date().toISOString()
  })
}

async function removePending(userId: number) {
  await db.collection('tgbot_pending').doc(String(userId)).delete()
}

async function getPendingRequests() {
  const snap = await db.collection('tgbot_pending').get()
  return snap.docs.map(d => d.data())
}

async function getAllowedUsers() {
  const snap = await db.collection('tgbot_users').where('allowed', '==', true).get()
  return snap.docs.map(d => d.data())
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const pendingModelSelection = new Map<number, string[]>()
const pendingMistralSelection = new Map<number, boolean>()

async function fetchFile(fileId: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const file = await bot.api.getFile(fileId)
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

// ─── Admin Commands ────────────────────────────────────────────────────────

bot.command('admin', async (ctx) => {
  if (ctx.from?.id !== ADMIN_ID) return
  const pending = await getPendingRequests()
  const allowed = await getAllowedUsers()

  const pendingList = pending.length
    ? pending.map(u => `• ${u.firstName ?? 'Unknown'} (@${u.username ?? 'no username'}) — \`${u.userId}\``).join('\n')
    : '_None_'

  const allowedList = allowed.length
    ? allowed.map(u => `• @${u.username ?? 'no username'} — \`${u.userId}\``).join('\n')
    : '_None_'

  ctx.reply(
    `🔐 *Admin Panel*\n\n` +
    `*Pending Requests (${pending.length}):*\n${pendingList}\n\n` +
    `*Allowed Users (${allowed.length}):*\n${allowedList}\n\n` +
    `*Commands:*\n` +
    `/allow <user_id> — approve user\n` +
    `/block <user_id> — remove user\n` +
    `/admin — refresh this panel`,
    { parse_mode: 'Markdown' }
  )
})

bot.command('allow', async (ctx) => {
  if (ctx.from?.id !== ADMIN_ID) return
  const targetId = Number(ctx.match.trim())
  if (!targetId) return ctx.reply('Usage: /allow <user_id>')

  const pendingDoc = await db.collection('tgbot_pending').doc(String(targetId)).get()
  const username = pendingDoc.exists ? pendingDoc.data()?.username : undefined

  await allowUser(targetId, username)
  await removePending(targetId)

  try {
    await bot.api.sendMessage(targetId, '✅ Your access has been approved! You can now use the bot.')
  } catch {}

  ctx.reply(`✅ User \`${targetId}\` approved.`, { parse_mode: 'Markdown' })
})

bot.command('block', async (ctx) => {
  if (ctx.from?.id !== ADMIN_ID) return
  const targetId = Number(ctx.match.trim())
  if (!targetId) return ctx.reply('Usage: /block <user_id>')

  await blockUser(targetId)
  await removePending(targetId)

  try {
    await bot.api.sendMessage(targetId, '⛔ Your access has been revoked.')
  } catch {}

  ctx.reply(`⛔ User \`${targetId}\` blocked.`, { parse_mode: 'Markdown' })
})

// ─── Start / Help ──────────────────────────────────────────────────────────

bot.command('start', async (ctx) => {
  const userId = ctx.from?.id!
  const allowed = await isAllowed(userId)

  if (!allowed) {
    await addPendingRequest(userId, ctx.from?.username, ctx.from?.first_name)
    try {
      await bot.api.sendMessage(
        ADMIN_ID,
        `🔔 *New Access Request*\n\nName: ${ctx.from?.first_name ?? 'Unknown'}\nUsername: @${ctx.from?.username ?? 'none'}\nID: \`${userId}\`\n\nReply: /allow ${userId} or /block ${userId}`,
        { parse_mode: 'Markdown' }
      )
    } catch {}
    return ctx.reply('👋 Hi! Your access request has been sent to the admin. Please wait for approval.')
  }

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
    `• /persona — switch AI personality\n` +
    `• /continue — continue last response\n` +
    `• /clear — clear conversation memory\n\n` +
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
    `*Inline Mode:*\n` +
    `• @botname <query> — AI anywhere\n` +
    `• @botname imagine <prompt> — generate image anywhere\n\n` +
    `Type /help to see this again!`,
    { parse_mode: 'Markdown' }
  )
})

bot.command('help', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
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
    `/persona — switch AI personality\n` +
    `/continue — continue last response\n` +
    `/clear — clear conversation memory\n\n` +
    `*Image:*\n` +
    `/imagine <prompt> — generate image\n` +
    `/sticker <prompt> — generate sticker\n\n` +
    `*Utility:*\n` +
    `/qr <text> — generate QR code\n` +
    `/calc <expression> — calculator\n\n` +
    `*Inline:*\n` +
    `@botname <query> — AI anywhere\n` +
    `@botname imagine <prompt> — image anywhere\n\n` +
    `/help — show this menu`,
    { parse_mode: 'Markdown' }
  )
})

// ─── AI Commands ──────────────────────────────────────────────────────────

bot.command('search', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const query = ctx.match.trim()
  if (!query) return ctx.reply('Usage: /search <query>')
  const msg = await ctx.reply('🔍 Searching...')
  try {
    const result = await chatWithSearch(query, ctx.from?.id)
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, result)
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Search failed: ${String(err)}`)
  }
})

bot.command('weather', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const city = ctx.match.trim()
  if (!city) return ctx.reply('Usage: /weather <city>')
  const msg = await ctx.reply('🌤️ Checking weather...')
  try {
    const result = await chat(`What is the typical/current weather in ${city}? Provide temperature range (Celsius), humidity, wind, and general conditions. Format nicely with emojis. Note if data may not be real-time.`, [], ctx.from?.id)
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, result)
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

bot.command('translate', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const args = ctx.match.trim()
  if (!args) return ctx.reply('Usage: /translate <lang> <text>\nExample: /translate ms Hello world')

  const spaceIdx = args.indexOf(' ')
  let lang: string, text: string
  if (spaceIdx === -1 || args.split(' ')[0].length > 5) {
    lang = 'English'; text = args
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
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `🌐 ${targetLang}:\n${result}`)
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

bot.command('summarize', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const url = ctx.match.trim()
  if (!url) return ctx.reply('Usage: /summarize <url>')
  const msg = await ctx.reply('📄 Fetching and summarizing...')
  try {
    const content = await fetchUrl(url)
    const result = await chat(`Summarize the following content in clear bullet points. Be concise:\n\n${content}`, [], ctx.from?.id)
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `📄 Summary:\n${result}`)
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

bot.command('explain', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const topic = ctx.match.trim()
  if (!topic) return ctx.reply('Usage: /explain <topic>')
  const msg = await ctx.reply('🧠 Thinking...')
  try {
    const result = await chat(`Explain "${topic}" in simple terms that anyone can understand. Be concise and use examples.`, [], ctx.from?.id)
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, result)
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

bot.command('roast', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const topic = ctx.match.trim()
  if (!topic) return ctx.reply('Usage: /roast <topic or name>')
  const msg = await ctx.reply('🔥 Roasting...')
  try {
    const result = await chat(`Give a funny, savage but lighthearted roast about: "${topic}". Keep it humorous, not mean-spirited. 3-5 sentences.`, [], ctx.from?.id)
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `🔥 ${result}`)
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

bot.command('quote', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const msg = await ctx.reply('✨ Generating quote...')
  try {
    const result = await chat('Generate one unique, powerful motivational quote. Format: "quote" — Author (or "Unknown"). Just the quote, nothing else.', [], ctx.from?.id)
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `✨ ${result}`)
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

bot.command('persona', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const arg = ctx.match.trim().toLowerCase()
  const userId = ctx.from?.id!

  if (!arg) {
    const current = await getPersona(userId)
    const list = PERSONA_LIST.map(p => `• \`${p}\``).join('\n')
    return ctx.reply(
      `🎭 *Persona Settings*\n\nCurrent: \`${current}\`\n\n*Available:*\n${list}\n\nUsage: /persona <name>`,
      { parse_mode: 'Markdown' }
    )
  }

  if (!PERSONA_LIST.includes(arg)) {
    return ctx.reply(`❌ Unknown persona. Available: ${PERSONA_LIST.map(p => `\`${p}\``).join(', ')}`, { parse_mode: 'Markdown' })
  }

  await setPersona(userId, arg)
  ctx.reply(`🎭 Persona set to *${arg}*`, { parse_mode: 'Markdown' })
})

bot.command('continue', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const userId = ctx.from?.id!
  const history = await getHistory(userId)
  if (history.length === 0) return ctx.reply('💭 No conversation history to continue.')
  const msg = await ctx.reply('💭 Continuing...')
  try {
    const result = await chat('Continue from where you left off.', [], userId, history)
    await appendHistory(userId, 'user', 'Continue from where you left off.')
    await appendHistory(userId, 'assistant', result)
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, result)
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

bot.command('clear', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  await clearHistory(ctx.from?.id!)
  ctx.reply('🗑️ Conversation memory cleared.')
})

bot.command('model', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const arg = ctx.match.trim().toLowerCase()
  const userId = ctx.from?.id!

  if (!arg) {
    const pref = await getUserProvider(userId)
    const current = pref.model ? `${pref.provider} → \`${pref.model}\`` : `\`${pref.provider}\``
    return ctx.reply(
      `🤖 *AI Provider Settings*\n\nCurrent: ${current}\n\n*Options:*\n` +
      `• /model auto — smart fallback\n` +
      `• /model groq — force Groq only\n` +
      `• /model mistral — pick from list of models\n` +
      `• /model openrouter — pick from list of free models\n` +
      `• /model pollinations — force Pollinations only`,
      { parse_mode: 'Markdown' }
    )
  }

  if (arg === 'mistral') {
    const modelList = Object.keys(MISTRAL_MODELS)
    pendingMistralSelection.set(userId, true)
    const list = modelList.map((m, i) => `${i + 1}. \`${m}\``).join('\n')
    return ctx.reply(
      `🇫🇷 *Mistral Models:*\n\n${list}\n\nReply with the *number* to select.\nType /model auto to cancel.`,
      { parse_mode: 'Markdown' }
    )
  }

  if (arg === 'openrouter') {
    const models = await getFreeModelList()
    pendingModelSelection.set(userId, models)
    const list = models.map((m, i) => `${i + 1}. \`${m}\``).join('\n')
    return ctx.reply(
      `🔀 *OpenRouter Free Models (${models.length}):*\n\n${list}\n\nReply with the *number* to select.\nType /model auto to cancel.`,
      { parse_mode: 'Markdown' }
    )
  }

  const valid = ['auto', 'groq', 'pollinations']
  if (!valid.includes(arg)) return ctx.reply(`❌ Invalid option. Choose: auto, groq, mistral, openrouter, pollinations`)

  pendingModelSelection.delete(userId)
  pendingMistralSelection.delete(userId)
  await setUserProvider(userId, arg)
  const labels: Record<string, string> = {
    auto: '🔄 Auto fallback (recommended)',
    groq: '⚡ Groq (fastest)',
    pollinations: '🌸 Pollinations (no key needed)'
  }
  ctx.reply(`✅ Provider set to *${arg}*\n${labels[arg]}`, { parse_mode: 'Markdown' })
})

// ─── Image Commands ────────────────────────────────────────────────────────

bot.command('imagine', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const prompt = ctx.match.trim()
  if (!prompt) return ctx.reply('Usage: /imagine <prompt>')
  const msg = await ctx.reply('🎨 Generating image...')
  try {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${Date.now()}`
    await ctx.api.deleteMessage(ctx.chat.id, msg.message_id)
    await ctx.replyWithPhoto(url, { caption: `🎨 *${prompt}*`, parse_mode: 'Markdown' })
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

bot.command('sticker', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const prompt = ctx.match.trim()
  if (!prompt) return ctx.reply('Usage: /sticker <prompt>')
  const msg = await ctx.reply('🎭 Generating sticker...')
  try {
    const stickerPrompt = `${prompt}, sticker art style, bold outlines, vibrant colors, white background, cute kawaii style`
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(stickerPrompt)}?width=512&height=512&nologo=true&seed=${Date.now()}`
    await ctx.api.deleteMessage(ctx.chat.id, msg.message_id)
    await ctx.replyWithPhoto(url, { caption: `🎭 *${prompt}*`, parse_mode: 'Markdown' })
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

// ─── Utility Commands ──────────────────────────────────────────────────────

bot.command('qr', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const text = ctx.match.trim()
  if (!text) return ctx.reply('Usage: /qr <text or url>')
  const msg = await ctx.reply('📱 Generating QR code...')
  try {
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encodeURIComponent(text)}`
    const res = await fetch(url)
    if (!res.ok) throw new Error('Failed to generate QR')
    const buffer = Buffer.from(await res.arrayBuffer())
    await ctx.api.deleteMessage(ctx.chat.id, msg.message_id)
    await ctx.replyWithPhoto(new InputFile(buffer, 'qr.png'), { caption: `📱 QR Code for: \`${text}\``, parse_mode: 'Markdown' })
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

bot.command('calc', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const expr = ctx.match.trim()
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

// ─── Media Handlers ────────────────────────────────────────────────────────

bot.on('message:photo', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const msg = await ctx.reply('🖼️ Analyzing image...')
  try {
    const photo = ctx.message.photo.at(-1)!
    const { buffer, mimeType } = await fetchFile(photo.file_id)
    const part = fileToGenerativePart(buffer, mimeType)
    const caption = ctx.message.caption ?? 'Describe this image in detail.'
    const result = await chat(caption, [part], ctx.from?.id)
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, result)
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

bot.on('message:document', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const msg = await ctx.reply('📄 Reading file...')
  try {
    const doc = ctx.message.document
    const { buffer, mimeType } = await fetchFile(doc.file_id)
    const part = fileToGenerativePart(buffer, mimeType)
    const caption = ctx.message.caption ?? 'Summarize the contents of this file.'
    const result = await chat(caption, [part], ctx.from?.id)
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, result)
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

// ─── Text Handler ──────────────────────────────────────────────────────────

bot.on('message:text', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const userId = ctx.from?.id!
  const text = ctx.message.text

  if (pendingMistralSelection.has(userId)) {
    const modelList = Object.keys(MISTRAL_MODELS)
    const num = parseInt(text.trim())
    if (isNaN(num) || num < 1 || num > modelList.length) {
      return ctx.reply(`❌ Invalid. Pick 1–${modelList.length}, or /model auto to cancel.`)
    }
    const selected = modelList[num - 1]
    pendingMistralSelection.delete(userId)
    await setUserProvider(userId, 'mistral', selected)
    return ctx.reply(`✅ *Mistral model selected!*\n\n\`${selected}\`\n\nAll messages will use this model now.`, { parse_mode: 'Markdown' })
  }

  if (pendingModelSelection.has(userId)) {
    const models = pendingModelSelection.get(userId)!
    const num = parseInt(text.trim())
    if (isNaN(num) || num < 1 || num > models.length) {
      return ctx.reply(`❌ Invalid. Pick 1–${models.length}, or /model auto to cancel.`)
    }
    const selected = models[num - 1]
    pendingModelSelection.delete(userId)
    await setUserProvider(userId, 'openrouter', selected)
    return ctx.reply(`✅ *Model selected!*\n\n\`${selected}\`\n\nAll messages will use this model now.`, { parse_mode: 'Markdown' })
  }

  const msg = await ctx.reply('💭 Thinking...')
  try {
    const history = await getHistory(userId)
    const result = await chat(text, [], userId, history)
    await appendHistory(userId, 'user', text)
    await appendHistory(userId, 'assistant', result)
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, result)
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Error: ${String(err)}`)
  }
})

// ─── Inline Query ──────────────────────────────────────────────────────────

bot.on('inline_query', async (ctx) => {
  const query = ctx.inlineQuery.query.trim()
  if (!query) {
    return ctx.answerInlineQuery([{
      type: 'article',
      id: '0',
      title: 'Ask me anything!',
      input_message_content: { message_text: '💬 Type something after @botname' },
      description: 'e.g. @botname explain black holes'
    }])
  }

  const isImage = query.startsWith('imagine ') || query.startsWith('img ')
  const prompt = isImage ? query.split(' ').slice(1).join(' ') : query

  try {
    if (isImage) {
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${Date.now()}`
      return ctx.answerInlineQuery([{
        type: 'photo',
        id: '1',
        photo_url: url,
        thumbnail_url: url,
        caption: `🎨 ${prompt}`
      }], { cache_time: 0 })
    }

    const result = await chat(prompt, [], ctx.from.id)
    return ctx.answerInlineQuery([{
      type: 'article',
      id: '1',
      title: query.slice(0, 60),
      input_message_content: { message_text: result },
      description: result.slice(0, 100)
    }], { cache_time: 0 })
  } catch {
    return ctx.answerInlineQuery([{
      type: 'article',
      id: 'err',
      title: '❌ Error',
      input_message_content: { message_text: '❌ Failed to process query.' },
      description: 'Try again'
    }])
  }
})

export default bot
