// User-facing commands. All of these MUST be registered before the catch-all
// handlers in media.ts / chat.ts — see helpers.ts for why.

import type { Bot } from 'grammy'
import { InlineKeyboard, InputFile } from 'grammy'
import { userCommand, editOrReply } from './helpers'
import { checkAccess, isAdmin } from '../access'
import { escapeHTML } from '../html'
import { errMsg, fetchUrl, formatDuration } from '../util'
import { evaluate } from 'mathjs'
import { searchRepos, formatRepo } from '../github'
import { searchWeb, formatSearchResults, fallbackPrompt } from '../search'
import {
  chat,
  getUserProvider, setUserProvider, getFreeModelList, MISTRAL_MODELS,
  getHistory, appendExchange, clearHistory,
  getPersona, setPersona, PERSONA_LIST,
  setPendingModelSelection, clearPendingModelSelection,
  generateImage,
} from '../ai'
import { addPendingUser } from '../firebase'

function helpText(isAdminUser: boolean): string {
  const adminSection = isAdminUser
    ? `\n\n<b>👑 Admin:</b>\n` +
      `/admin — pending requests\n` +
      `/users — list approved users\n` +
      `/allow &lt;id&gt; — approve user\n` +
      `/revoke &lt;id&gt; — remove access\n` +
      `/ban &lt;id&gt; — permanent ban\n` +
      `/unban &lt;id&gt; — unban user\n` +
      `/logs — audit log\n` +
      `/broadcast &lt;message&gt; — message all users\n` +
      `/stats — usage statistics\n` +
      `/maintenance on|off — lock/unlock bot\n`
    : ''

  return (
    `<b>Available Commands:</b>\n\n` +
    `<b>AI:</b>\n` +
    `/search &lt;query&gt; — live web search + AI answer\n` +
    `/weather &lt;city&gt; — weather summary\n` +
    `/translate &lt;lang&gt; &lt;text&gt; — e.g. /translate ms hello\n` +
    `/summarize &lt;url&gt; — summarize a webpage\n` +
    `/explain &lt;topic&gt; — explain anything simply\n` +
    `/roast &lt;topic&gt; — roast anything 🔥\n` +
    `/roastme — send a photo with /roastme as the caption\n` +
    `/debate &lt;topic&gt; — AI argues both sides\n` +
    `/story &lt;prompt&gt; — generate a short story\n` +
    `/code &lt;description&gt; — generate code\n` +
    `/quote — motivational quote\n` +
    `/model — switch AI provider\n` +
    `/persona — switch AI personality\n` +
    `/continue — continue last response\n` +
    `/clear — clear conversation memory\n\n` +
    `<b>Humor:</b>\n` +
    `/joke — random joke 😄\n` +
    `/darkjoke — dark humour 😈\n` +
    `/dadjoke — corny dad joke 👨\n\n` +
    `<b>Image:</b>\n` +
    `/imagine &lt;prompt&gt; [--anime|--realistic|--pixel|--painting|--sketch]\n` +
    `/sticker &lt;prompt&gt; — generate sticker\n\n` +
    `<b>Utility:</b>\n` +
    `/qr &lt;text&gt; — generate QR code\n` +
    `/calc &lt;expression&gt; — calculator\n` +
    `/shorten &lt;url&gt; — shorten a URL\n` +
    `/currency &lt;amount&gt; &lt;from&gt; &lt;to&gt; — convert currency\n` +
    `/time &lt;city&gt; — current time anywhere\n` +
    `/encode &lt;text&gt; — Base64 & URL encode\n` +
    `/hash &lt;text&gt; — MD5 & SHA256 hash\n` +
    `/github &lt;query&gt; [count] — search GitHub repos (default 10, max 30)\n\n` +
    `<b>Inline:</b>\n` +
    `@botname &lt;query&gt; — AI anywhere\n` +
    `@botname imagine — image generation hint` +
    adminSection
  )
}

export function registerCommands(bot: Bot): void {
  // ─── /start — special: also the access-request entry point ─────────────────
  bot.command('start', async (ctx) => {
    const userId = ctx.from?.id ?? 0
    const username = ctx.from?.username
    const firstName = ctx.from?.first_name ?? 'Unknown'
    const languageCode = ctx.from?.language_code
    const admin = isAdmin(userId)

    if (!admin && await checkAccess(userId) === 'banned') {
      return ctx.reply('🚫 You have been banned from using this bot.')
    }

    const status = admin ? 'ok' : await checkAccess(userId)
    if (status === 'ok') {
      return ctx.reply(helpText(admin), { parse_mode: 'HTML' })
    }
    if (status === 'maintenance') {
      // Previously maintenance made isAllowed() false, which dropped every
      // /start into the access-request flow and pinged the admin per user.
      return ctx.reply('🔧 Under maintenance — please check back later.')
    }

    const result = await addPendingUser({ userId, username, firstName, languageCode })

    if (!result.ok) {
      const wait = formatDuration(result.cooldownMs ?? 0)
      return ctx.reply(
        `⏳ You already have a pending request.\n\nPlease wait ${wait} before requesting again.`
      )
    }

    await ctx.reply(
      `👋 Hey <b>${escapeHTML(firstName)}</b>!\n\n` +
      `Your access request has been sent to the admin. ` +
      `You'll be notified once approved. ⏳`,
      { parse_mode: 'HTML' }
    )

    const userTag = username ? `@${username}` : firstName
    const keyboard = new InlineKeyboard()
      .text('✅ Approve', `approve:${userId}`)
      .text('❌ Reject', `reject:${userId}`)
      .row()
      .text('🚫 Ban', `ban:${userId}`)

    const adminId = Number(process.env.ADMIN_ID)
    if (Number.isFinite(adminId)) {
      try {
        await bot.api.sendMessage(
          adminId,
          `🔔 <b>New Access Request</b>\n\n` +
          `👤 Name: ${escapeHTML(userTag)}\n` +
          `🆔 ID: <code>${userId}</code>\n` +
          `🌐 Language: ${escapeHTML(languageCode ?? 'unknown')}`,
          { parse_mode: 'HTML', reply_markup: keyboard }
        )
      } catch (err) {
        console.error('[bot] failed to notify admin of access request:', err)
      }
    }
  })

  // /help stays unguarded — denied users need to see how to get access.
  bot.command('help', async (ctx) => {
    return ctx.reply(helpText(isAdmin(ctx.from?.id ?? 0)), { parse_mode: 'HTML' })
  })

  // ─── AI commands ───────────────────────────────────────────────────────────

  userCommand(bot, 'search', { ai: true }, async (ctx, userId) => {
    const query = ctx.match.trim()
    if (!query) return ctx.reply('Usage: /search <query>')
    const msg = await ctx.reply('🔍 Searching the web...')
    let prompt: string
    try {
      const hits = await searchWeb(query)
      prompt = hits.length > 0 ? formatSearchResults(query, hits) : fallbackPrompt(query)
    } catch {
      prompt = fallbackPrompt(query)
    }
    const result = await chat(prompt, [], userId)
    await editOrReply(ctx, msg.message_id, result)
  })

  userCommand(bot, 'weather', { ai: true }, async (ctx, userId) => {
    const city = ctx.match.trim()
    if (!city) return ctx.reply('Usage: /weather <city>')
    const msg = await ctx.reply('🌤️ Checking weather...')
    const result = await chat(
      `What is the typical/current weather in ${city}? Provide temperature range (Celsius), humidity, wind, and general conditions. Format nicely with emojis. Note if data may not be real-time.`,
      [], userId
    )
    await editOrReply(ctx, msg.message_id, result)
  })

  userCommand(bot, 'translate', { ai: true }, async (ctx, userId) => {
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
    const result = await chat(
      `Translate the following text to ${targetLang}. Reply with only the translation, nothing else:\n\n${text}`,
      [], userId
    )
    await editOrReply(ctx, msg.message_id, `🌐 <b>${escapeHTML(targetLang)}:</b>\n${result}`)
  })

  userCommand(bot, 'summarize', { ai: true }, async (ctx, userId) => {
    const url = ctx.match.trim()
    if (!url) return ctx.reply('Usage: /summarize <url>')
    const msg = await ctx.reply('📄 Fetching and summarizing...')
    try {
      // fetchUrl validates the URL first (SSRF guard) and fetches with a timeout.
      const content = await fetchUrl(url)
      const result = await chat(
        `Summarize the following content in clear bullet points. Be concise:\n\n${content}`,
        [], userId
      )
      await editOrReply(ctx, msg.message_id, `📄 <b>Summary:</b>\n${result}`)
    } catch (err) {
      await editOrReply(ctx, msg.message_id, `❌ Failed: ${errMsg(err)}`)
    }
  })

  userCommand(bot, 'explain', { ai: true }, async (ctx, userId) => {
    const topic = ctx.match.trim()
    if (!topic) return ctx.reply('Usage: /explain <topic>')
    const msg = await ctx.reply('🧠 Thinking...')
    const result = await chat(
      `Explain "${topic}" in simple terms that anyone can understand. Be concise and use examples.`,
      [], userId
    )
    await editOrReply(ctx, msg.message_id, result)
  })

  userCommand(bot, 'roast', { ai: true }, async (ctx, userId) => {
    const topic = ctx.match.trim()
    if (!topic) return ctx.reply('Usage: /roast <topic or name>')
    const msg = await ctx.reply('🔥 Roasting...')
    const result = await chat(
      `Give a funny, savage but lighthearted roast about: "${topic}". Keep it humorous, not mean-spirited. 3-5 sentences.`,
      [], userId
    )
    await editOrReply(ctx, msg.message_id, `🔥 ${result}`)
  })

  userCommand(bot, 'quote', { ai: true }, async (ctx, userId) => {
    const msg = await ctx.reply('✨ Generating quote...')
    const result = await chat(
      'Generate one unique, powerful motivational quote. Format: "quote" — Author (or "Unknown"). Just the quote, nothing else.',
      [], userId
    )
    await editOrReply(ctx, msg.message_id, `✨ ${result}`)
  })

  userCommand(bot, 'debate', { ai: true }, async (ctx, userId) => {
    const topic = ctx.match.trim()
    if (!topic) return ctx.reply('Usage: /debate <topic>')
    const msg = await ctx.reply('⚖️ Preparing both sides...')
    const result = await chat(
      `Debate the topic: "${topic}". Present strong arguments FOR and AGAINST in a structured format. Label them clearly. Be balanced and thorough.`,
      [], userId
    )
    await editOrReply(ctx, msg.message_id, result)
  })

  userCommand(bot, 'story', { ai: true }, async (ctx, userId) => {
    const prompt = ctx.match.trim()
    if (!prompt) return ctx.reply('Usage: /story <prompt>')
    const msg = await ctx.reply('📖 Writing story...')
    const result = await chat(
      `Write a short, engaging story based on this prompt: "${prompt}". Keep it under 300 words. Make it interesting with a clear beginning, middle, and end.`,
      [], userId
    )
    await editOrReply(ctx, msg.message_id, result)
  })

  userCommand(bot, 'code', { ai: true }, async (ctx, userId) => {
    const desc = ctx.match.trim()
    if (!desc) return ctx.reply('Usage: /code <description>\nExample: /code fizzbuzz in python')
    const msg = await ctx.reply('💻 Generating code...')
    const result = await chat(
      `Generate clean, well-commented code for: "${desc}". Include a brief explanation of how it works.`,
      [], userId
    )
    await editOrReply(ctx, msg.message_id, result)
  })

  userCommand(bot, 'continue', { ai: true }, async (ctx, userId) => {
    const history = await getHistory(userId)
    if (history.length === 0) return ctx.reply('💭 No conversation history to continue.')
    const msg = await ctx.reply('💭 Continuing...')
    const result = await chat('Continue from where you left off.', [], userId, history)
    await appendExchange(userId, 'Continue from where you left off.', result)
    await editOrReply(ctx, msg.message_id, result)
  })

  // ─── Humor ─────────────────────────────────────────────────────────────────

  userCommand(bot, 'joke', { ai: true }, async (ctx, userId) => {
    const msg = await ctx.reply('😄 Generating joke...')
    const result = await chat(
      'Tell me one funny, clean, original joke. Just the joke, no intro or explanation.',
      [], userId
    )
    await editOrReply(ctx, msg.message_id, `😄 ${result}`)
  })

  userCommand(bot, 'darkjoke', { ai: true }, async (ctx, userId) => {
    const msg = await ctx.reply('😈 Generating dark joke...')
    const result = await chat(
      'Tell me one dark humour joke. Keep it edgy but not targeting real tragedies or specific groups. Just the joke, no intro.',
      [], userId
    )
    await editOrReply(ctx, msg.message_id, `😈 ${result}`)
  })

  userCommand(bot, 'dadjoke', { ai: true }, async (ctx, userId) => {
    const msg = await ctx.reply('👨 Generating dad joke...')
    const result = await chat(
      'Tell me one classic corny dad joke with a punchline. Just the joke, no intro or explanation.',
      [], userId
    )
    await editOrReply(ctx, msg.message_id, `👨 ${result}`)
  })

  // ─── Settings ──────────────────────────────────────────────────────────────

  userCommand(bot, 'persona', { ai: false }, async (ctx, userId) => {
    const arg = ctx.match.trim().toLowerCase()

    if (!arg) {
      const current = await getPersona(userId)
      const list = PERSONA_LIST.map(p => `• <code>${p}</code>`).join('\n')
      return ctx.reply(
        `🎭 <b>Persona Settings</b>\n\nCurrent: <code>${escapeHTML(current)}</code>\n\n<b>Available:</b>\n${list}\n\nUsage: /persona &lt;name&gt;`,
        { parse_mode: 'HTML' }
      )
    }

    if (!PERSONA_LIST.includes(arg)) {
      return ctx.reply(
        `❌ Unknown persona. Available: ${PERSONA_LIST.map(p => `<code>${p}</code>`).join(', ')}`,
        { parse_mode: 'HTML' }
      )
    }

    await setPersona(userId, arg)
    await ctx.reply(
      `🎭 Persona set to <b>${escapeHTML(arg)}</b>\n<i>Conversation memory was cleared so the new persona starts fresh.</i>`,
      { parse_mode: 'HTML' }
    )
  })

  userCommand(bot, 'clear', { ai: false }, async (ctx, userId) => {
    await clearHistory(userId)
    await ctx.reply('🗑️ Conversation memory cleared.')
  })

  userCommand(bot, 'model', { ai: false }, async (ctx, userId) => {
    const arg = ctx.match.trim().toLowerCase()

    if (!arg) {
      const pref = await getUserProvider(userId)
      const current = pref.model
        ? `${escapeHTML(pref.provider)} → <code>${escapeHTML(pref.model)}</code>`
        : `<code>${escapeHTML(pref.provider)}</code>`
      return ctx.reply(
        `🤖 <b>AI Provider Settings</b>\n\nCurrent: ${current}\n\n<b>Options:</b>\n` +
        `• /model auto — smart fallback (Groq → Mistral → OpenRouter)\n` +
        `• /model groq — force Groq only\n` +
        `• /model mistral — pick from list of models\n` +
        `• /model openrouter — pick from list of free models`,
        { parse_mode: 'HTML' }
      )
    }

    if (arg === 'mistral') {
      const modelList = Object.keys(MISTRAL_MODELS)
      // Stored in Firestore, not an in-memory Map — on serverless the reply
      // that picks a number often lands on a different instance.
      await setPendingModelSelection(userId, 'mistral', modelList)
      const list = modelList.map((m, i) => `${i + 1}. <code>${m}</code>`).join('\n')
      return ctx.reply(
        `🇫🇷 <b>Mistral Models:</b>\n\n${list}\n\nReply with the <b>number</b> to select.\nType /model auto to cancel.`,
        { parse_mode: 'HTML' }
      )
    }

    if (arg === 'openrouter') {
      try {
        const models = await getFreeModelList()
        await setPendingModelSelection(userId, 'openrouter', models)
        const list = models.map((m, i) => `${i + 1}. <code>${escapeHTML(m)}</code>`).join('\n')
        return ctx.reply(
          `🔀 <b>OpenRouter Free Models (${models.length}):</b>\n\n${list}\n\nReply with the <b>number</b> to select.\nType /model auto to cancel.`,
          { parse_mode: 'HTML' }
        )
      } catch (err) {
        return ctx.reply(`❌ Failed to load model list: ${errMsg(err)}`, { parse_mode: 'HTML' })
      }
    }

    const valid = ['auto', 'groq']
    if (!valid.includes(arg)) return ctx.reply('❌ Invalid option. Choose: auto, groq, mistral, openrouter')

    await clearPendingModelSelection(userId)
    await setUserProvider(userId, arg)
    const labels: Record<string, string> = {
      auto: '🔄 Auto fallback (recommended)',
      groq: '⚡ Groq (fastest)',
    }
    await ctx.reply(`✅ Provider set to <b>${escapeHTML(arg)}</b>\n${labels[arg]}`, { parse_mode: 'HTML' })
  })

  // ─── Image generation ──────────────────────────────────────────────────────

  userCommand(bot, 'sticker', { ai: false }, async (ctx) => {
    const prompt = ctx.match.trim()
    if (!prompt) return ctx.reply('Usage: /sticker <prompt>')
    try {
      const stickerPrompt = `${prompt}, sticker art style, bold outlines, vibrant colors, white background, cute kawaii style`
      const { buffer } = await generateImage(stickerPrompt, { resolution: '512' })
      await ctx.replyWithPhoto(new InputFile(buffer, 'sticker.jpg'), { caption: `🎭 ${prompt}` })
    } catch (err) {
      await ctx.reply(`❌ Failed: ${errMsg(err)}`, { parse_mode: 'HTML' })
    }
  })

  userCommand(bot, 'imagine', { ai: false }, async (ctx) => {
    let prompt = ctx.match.trim()
    if (!prompt) return ctx.reply('Usage: /imagine <prompt> [--anime|--realistic|--pixel|--painting|--sketch]')

    const styleMap: Record<string, string> = {
      '--anime': 'anime art style, cel shaded, vibrant',
      '--realistic': 'photorealistic, 8k, hyperdetailed, cinematic lighting',
      '--pixel': 'pixel art, 16-bit retro game style',
      '--painting': 'oil painting, classical art style, brushstrokes visible',
      '--sketch': 'pencil sketch, hand drawn, black and white'
    }

    let styleLabel = ''
    let style = ''
    for (const [flag, s] of Object.entries(styleMap)) {
      if (prompt.includes(flag)) {
        prompt = prompt.replace(flag, '')
        style = s
        styleLabel = ` (${flag.replace('--', '')})`
        break
      }
    }
    // Flag removal can leave stray commas/spacing — "/imagine --anime" would
    // otherwise become ", anime art style…". Keep legitimate internal commas
    // ("/imagine cat, wearing hat") intact.
    prompt = prompt
      .replace(/^[\s,]+/, '')
      .replace(/[\s,]+$/, '')
      .replace(/,{2,}/g, ',')
      .replace(/\s{2,}/g, ' ')
      .trim()
    const displayPrompt = prompt
    if (style) prompt = prompt ? `${prompt}, ${style}` : style

    const msg = await ctx.reply('🎨 Generating image...')
    try {
      const { buffer } = await generateImage(prompt)
      await ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {})
      await ctx.replyWithPhoto(new InputFile(buffer, 'image.jpg'), {
        caption: `🎨 ${displayPrompt || style}${styleLabel}`
      })
    } catch (err) {
      // The loading message may already be deleted — nested catch so the
      // failure to edit it doesn't swallow the real error message.
      try {
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${errMsg(err)}`, { parse_mode: 'HTML' })
      } catch {
        await ctx.reply(`❌ Failed: ${errMsg(err)}`, { parse_mode: 'HTML' })
      }
    }
  })

  // /roastme as a text command can't carry a photo (and grammY doesn't match
  // commands in captions), so it just points at the working flow — the actual
  // roast happens in the photo handler when the caption is "/roastme".
  userCommand(bot, 'roastme', { ai: false }, async (ctx) => {
    return ctx.reply('📸 Send a photo with the caption /roastme to get roasted!')
  })

  // ─── Utility ───────────────────────────────────────────────────────────────

  userCommand(bot, 'qr', { ai: false }, async (ctx) => {
    const text = ctx.match.trim()
    if (!text) return ctx.reply('Usage: /qr <text or url>')
    const msg = await ctx.reply('📱 Generating QR code...')
    try {
      const url = `https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encodeURIComponent(text)}`
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new Error('Failed to generate QR')
      const buffer = Buffer.from(await res.arrayBuffer())
      await ctx.api.deleteMessage(ctx.chat.id, msg.message_id)
      await ctx.replyWithPhoto(new InputFile(buffer, 'qr.png'), { caption: `📱 QR Code for: ${text}` })
    } catch (err) {
      try {
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${errMsg(err)}`, { parse_mode: 'HTML' })
      } catch {
        await ctx.reply(`❌ Failed: ${errMsg(err)}`, { parse_mode: 'HTML' })
      }
    }
  })

  userCommand(bot, 'calc', { ai: false }, async (ctx) => {
    const expr = ctx.match.trim()
    if (!expr) return ctx.reply('Usage: /calc <expression>\nExample: /calc 2 + 2 * 10')
    try {
      const result = evaluate(expr)
      await ctx.reply(
        `🧮 <code>${escapeHTML(expr)}</code> = <b>${escapeHTML(result)}</b>`,
        { parse_mode: 'HTML' }
      )
    } catch {
      await ctx.reply('❌ Invalid expression. Example: /calc 100 * 1.06')
    }
  })

  userCommand(bot, 'shorten', { ai: false }, async (ctx) => {
    const url = ctx.match.trim()
    if (!url) return ctx.reply('Usage: /shorten <url>')
    const msg = await ctx.reply('🔗 Shortening...')
    try {
      const res = await fetch(
        `https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`,
        { signal: AbortSignal.timeout(10_000) }
      )
      if (!res.ok) throw new Error('TinyURL failed')
      const short = (await res.text()).trim()
      await editOrReply(ctx, msg.message_id, `🔗 ${escapeHTML(short)}`)
    } catch (err) {
      await editOrReply(ctx, msg.message_id, `❌ Failed: ${errMsg(err)}`)
    }
  })

  userCommand(bot, 'currency', { ai: false }, async (ctx) => {
    const args = ctx.match.trim().split(/\s+/)
    if (args.length < 3) return ctx.reply('Usage: /currency <amount> <from> <to>\nExample: /currency 100 USD MYR')
    const [amountRaw, from, to] = args
    const amount = Number.parseFloat(amountRaw)
    if (!Number.isFinite(amount)) return ctx.reply('❌ Invalid amount. Example: /currency 100 USD MYR')

    const msg = await ctx.reply('💱 Converting...')
    try {
      const res = await fetch(
        `https://open.er-api.com/v6/latest/${encodeURIComponent(from.toUpperCase())}`,
        { signal: AbortSignal.timeout(10_000) }
      )
      if (!res.ok) throw new Error('API failed')
      const data = await res.json()
      const rate = data.rates?.[to.toUpperCase()]
      if (!rate) throw new Error(`Unknown currency: ${to.toUpperCase()}`)
      const result = (amount * rate).toFixed(2)
      await editOrReply(ctx, msg.message_id,
        `💱 <b>${escapeHTML(amountRaw)} ${escapeHTML(from.toUpperCase())}</b> = <b>${result} ${escapeHTML(to.toUpperCase())}</b>\n` +
        `<i>Rate: 1 ${escapeHTML(from.toUpperCase())} = ${rate} ${escapeHTML(to.toUpperCase())}</i>`
      )
    } catch (err) {
      await editOrReply(ctx, msg.message_id, `❌ Failed: ${errMsg(err)}`)
    }
  })

  // No external API: IANA timezone data ships with Node via Intl.
  userCommand(bot, 'time', { ai: false }, async (ctx) => {
    const city = ctx.match.trim()
    if (!city) return ctx.reply('Usage: /time <city>\nExample: /time Tokyo')
    try {
      const zones: string[] = (Intl as any).supportedValuesOf('timeZone')
      const needle = city.toLowerCase().replace(/\s+/g, '_')
      const match =
        zones.find(z => z.split('/').pop()?.toLowerCase() === needle) ??
        zones.find(z => z.toLowerCase().includes(needle))
      if (!match) return ctx.reply(`❌ Unknown city/timezone: ${escapeHTML(city)}`, { parse_mode: 'HTML' })
      const now = new Date()
      const formatted = now.toLocaleString('en-MY', { timeZone: match, dateStyle: 'full', timeStyle: 'short' })
      await ctx.reply(`🕐 <b>${escapeHTML(match)}</b>\n${escapeHTML(formatted)}`, { parse_mode: 'HTML' })
    } catch (err) {
      await ctx.reply(`❌ Failed: ${errMsg(err)}`, { parse_mode: 'HTML' })
    }
  })

  userCommand(bot, 'encode', { ai: false }, async (ctx) => {
    const input = ctx.match.trim()
    if (!input) return ctx.reply('Usage: /encode <text>')
    const b64 = Buffer.from(input).toString('base64')
    const url = encodeURIComponent(input)
    await ctx.reply(
      `🔐 <b>Encoded:</b>\n\n<b>Base64:</b>\n<code>${escapeHTML(b64)}</code>\n\n<b>URL:</b>\n<code>${escapeHTML(url)}</code>`,
      { parse_mode: 'HTML' }
    )
  })

  userCommand(bot, 'hash', { ai: false }, async (ctx) => {
    const input = ctx.match.trim()
    if (!input) return ctx.reply('Usage: /hash <text>')
    const { createHash } = await import('crypto')
    const md5 = createHash('md5').update(input).digest('hex')
    const sha256 = createHash('sha256').update(input).digest('hex')
    await ctx.reply(
      `#️⃣ <b>Hashes:</b>\n\n<b>MD5:</b>\n<code>${md5}</code>\n\n<b>SHA256:</b>\n<code>${sha256}</code>`,
      { parse_mode: 'HTML' }
    )
  })

  userCommand(bot, 'github', { ai: false }, async (ctx) => {
    const raw = ctx.match.trim()
    if (!raw) return ctx.reply(
      'Usage: /github <query> [count]\nExample: /github music player cli 15\n' +
      '(count defaults to 10, max 30 — the search itself always covers all of GitHub, this just controls how many results get shown)'
    )

    // Optional trailing number sets how many results to show, e.g. "music player 15".
    const tokens = raw.split(/\s+/)
    const last = tokens[tokens.length - 1]
    let count = 10
    let query = raw
    if (/^\d+$/.test(last) && tokens.length > 1) {
      count = Math.min(30, Math.max(1, parseInt(last, 10)))
      query = tokens.slice(0, -1).join(' ')
    }

    const msg = await ctx.reply('🔍 Searching GitHub...')
    try {
      const repos = await searchRepos(query, count)
      if (repos.length === 0) {
        return editOrReply(ctx, msg.message_id, `❌ No repos found for: ${escapeHTML(query)}`)
      }
      const body = repos.map(formatRepo).join('\n\n')
      await editOrReply(ctx, msg.message_id,
        `🐙 <b>GitHub results for "${escapeHTML(query)}" (${repos.length}):</b>\n\n${body}`
      )
    } catch (err) {
      await editOrReply(ctx, msg.message_id, `❌ Failed: ${errMsg(err)}`)
    }
  })
}
