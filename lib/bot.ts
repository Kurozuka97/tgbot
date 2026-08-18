import { Bot, InputFile, InlineKeyboard } from 'grammy'
import { registerLosslessHandler } from './lossless'
import { evaluate } from 'mathjs'
import { searchRepos, formatRepo } from './github'
import {
  chat, chatWithSearch, fileToGenerativePart,
  getUserProvider, setUserProvider, getFreeModelList, MISTRAL_MODELS,
  getHistory, appendHistory, clearHistory,
  getPersona, setPersona, PERSONA_LIST
} from './ai'
import {
  isUserAllowed, isUserBanned,
  approveUser, revokeUser, banUser, unbanUser,
  addPendingUser, removePendingUser, getPendingUsers,
  getApprovedUsers, getUserRecord,
  trackUsage, logAudit, getRecentAuditLog,
  setMaintenance, isMaintenance, getStats,
  logMood, getMoodLog
} from './firebase'

const bot = new Bot(process.env.BOT_TOKEN!)

// FIX: there was no global error handler at all. Without this, any thrown error
// (e.g. a Telegram API rejection) propagates out of webhookCallback unhandled —
// the request 500s, the "Thinking..."/"Generating..." placeholder message never
// gets edited, and nothing is logged, so the failure is invisible.
bot.catch((err) => {
  const ctx = err.ctx
  console.error(`[bot] error while handling update ${ctx.update.update_id}:`, err.error)
})

// FIX: registered here (early) instead of at the bottom of this file — see the
// comment in lib/lossless.ts for why registration order matters.
registerLosslessHandler(bot)

// ─── Admin Setup ──────────────────────────────────────────────────────────────

const ADMIN_ID = Number(process.env.ADMIN_ID)

function isAdmin(userId: number) {
  return userId === ADMIN_ID
}

// FIX: the bot previously used parse_mode: 'MarkdownV2' throughout with hand-written
// strings that were never actually escaped for MarkdownV2's reserved characters
// (. ! - ( ) etc all appear unescaped in plain sentences, error messages, usernames...).
// Telegram rejects those with "can't parse entities" and the whole reply silently fails
// (there was also no bot.catch(), so these errors just vanished). HTML mode only needs
// & < > escaped, which is far less fragile — so the whole bot now uses parse_mode: 'HTML'
// consistently (matching what lib/ai.ts already outputs) instead of MarkdownV2.
function escapeHTML(text: unknown): string {
  if (text === null || text === undefined) return ''
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Broadcast messages come from the admin, typed as plain text with optional
// *bold* markers for emphasis. Escape everything first (so stray < > & can't break
// the HTML parse), then turn *bold* into <b>bold</b>.
function sanitizeBroadcastMessage(text: string): string {
  const escaped = escapeHTML(text)
  return escaped.replace(/\*(.+?)\*/g, '<b>$1</b>')
}

// FIX: ban check now included in isAllowed so it's enforced everywhere
async function isAllowed(userId: number): Promise<boolean> {
  if (isAdmin(userId)) return true
  if (await isUserBanned(userId)) return false
  if (await isMaintenance()) return false
  return isUserAllowed(userId)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const pendingModelSelection = new Map<number, string[]>()
const pendingMistralSelection = new Map<number, boolean>()

function formatDuration(ms: number): string {
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function formatDate(ts?: number): string {
  if (!ts) return 'never'
  return new Date(ts).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' })
}

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

// ─── /start ───────────────────────────────────────────────────────────────────

bot.command('start', async (ctx) => {
  const userId = ctx.from?.id ?? 0
  const username = ctx.from?.username
  const firstName = ctx.from?.first_name ?? 'Unknown'
  const languageCode = ctx.from?.language_code

  if (!isAdmin(userId) && await isUserBanned(userId)) {
    return ctx.reply('🚫 You have been banned from using this bot.')
  }

  if (await isAllowed(userId)) {
    const helpText =
      `👋 <b>Hey! I'm your multipurpose AI assistant.</b>\n\n` +
      `<b>AI Commands:</b>\n` +
      `• /search &lt;query&gt; — AI-powered search\n` +
      `• /weather &lt;city&gt; — current weather\n` +
      `• /translate &lt;lang&gt; &lt;text&gt; — translate text\n` +
      `• /summarize &lt;url&gt; — summarize a webpage\n` +
      `• /explain &lt;topic&gt; — explain anything simply\n` +
      `• /roast &lt;topic&gt; — roast anything 🔥\n` +
      `• /roastme — send a photo to get roasted\n` +
      `• /debate &lt;topic&gt; — AI argues both sides\n` +
      `• /story &lt;prompt&gt; — generate a short story\n` +
      `• /code &lt;description&gt; — generate code\n` +
      `• /quote — motivational quote\n` +
      `• /model — switch AI provider\n` +
      `• /persona — switch AI personality\n` +
      `• /continue — continue last response\n` +
      `• /clear — clear conversation memory\n\n` +
      `<b>Humor Commands:</b>\n` +
      `• /joke — random joke 😄\n` +
      `• /darkjoke — dark humour 😈\n` +
      `• /dadjoke — corny dad joke 👨\n\n` +
      `<b>Image Commands:</b>\n` +
      `• /imagine &lt;prompt&gt; — generate an image\n` +
      `• /imagine &lt;prompt&gt; --anime|--realistic|--pixel|--painting|--sketch\n` +
      `• /sticker &lt;prompt&gt; — generate a sticker\n\n` +
      `<b>Utility Commands:</b>\n` +
      `• /qr &lt;text&gt; — generate QR code\n` +
      `• /calc &lt;expression&gt; — calculator\n` +
      `• /shorten &lt;url&gt; — shorten a URL\n` +
      `• /currency &lt;amount&gt; &lt;from&gt; &lt;to&gt; — convert currency\n` +
      `• /time &lt;city&gt; — current time anywhere\n` +
      `• /encode &lt;text&gt; — Base64 & URL encode\n` +
      `• /hash &lt;text&gt; — MD5 & SHA256 hash\n` +
      `• /github &lt;query&gt; — search GitHub repos\n\n` +
      `<b>Inline Mode:</b>\n` +
      `• @botname &lt;query&gt; — AI anywhere\n` +
      `• @botname imagine &lt;prompt&gt; — generate image anywhere`;

    return ctx.reply(helpText, { parse_mode: 'HTML' })
  }

  const result = await addPendingUser({ userId, username, firstName, languageCode })

  if (!result.ok) {
    const wait = formatDuration(result.cooldownMs!)
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

  await bot.api.sendMessage(
    ADMIN_ID,
    `🔔 <b>New Access Request</b>\n\n` +
    `👤 Name: ${escapeHTML(userTag)}\n` +
    `🆔 ID: <code>${userId}</code>\n` +
    `🌐 Language: ${escapeHTML(languageCode ?? 'unknown')}`,
    { parse_mode: 'HTML', reply_markup: keyboard }
  )
})

// ─── Inline Button Callbacks ──────────────────────────────────────────────────

bot.callbackQuery(/^approve:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery('⛔ Unauthorized')

  const targetId = Number(ctx.match[1])
  const pending = (await getPendingUsers()).find(u => u.userId === targetId)

  await approveUser(targetId, ADMIN_ID, {
    username: pending?.username ?? undefined,
    firstName: pending?.firstName ?? undefined,
    languageCode: pending?.languageCode ?? undefined
  })
  await removePendingUser(targetId)
  await logAudit({
    action: 'approve', adminId: ADMIN_ID, targetId,
    targetUsername: pending?.username, timestamp: Date.now()
  })

  try {
    await bot.api.sendMessage(
      targetId,
      `✅ Your access has been <b>approved!</b>\n\nSend /start to begin.`,
      { parse_mode: 'HTML' }
    )
  } catch {}

  const name = pending?.username ? `@${pending.username}` : pending?.firstName ?? String(targetId)
  await ctx.editMessageText(`✅ <b>Approved:</b> ${escapeHTML(name)} (<code>${targetId}</code>)`, { parse_mode: 'HTML' })
  await ctx.answerCallbackQuery('✅ User approved')
})

bot.callbackQuery(/^reject:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery('⛔ Unauthorized')

  const targetId = Number(ctx.match[1])
  const pending = (await getPendingUsers()).find(u => u.userId === targetId)

  await removePendingUser(targetId)
  await logAudit({
    action: 'reject', adminId: ADMIN_ID, targetId,
    targetUsername: pending?.username, timestamp: Date.now()
  })

  try {
    await bot.api.sendMessage(
      targetId,
      `❌ Your access request has been <b>rejected.</b>\n\nContact the admin if you think this is a mistake.`,
      { parse_mode: 'HTML' }
    )
  } catch {}

  const name = pending?.username ? `@${pending.username}` : pending?.firstName ?? String(targetId)
  await ctx.editMessageText(`❌ <b>Rejected:</b> ${escapeHTML(name)} (<code>${targetId}</code>)`, { parse_mode: 'HTML' })
  await ctx.answerCallbackQuery('❌ User rejected')
})

bot.callbackQuery(/^ban:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery('⛔ Unauthorized')

  const targetId = Number(ctx.match[1])
  const pending = (await getPendingUsers()).find(u => u.userId === targetId)

  await banUser(targetId, ADMIN_ID, {
    username: pending?.username ?? undefined,
    firstName: pending?.firstName ?? undefined
  })
  await logAudit({
    action: 'ban', adminId: ADMIN_ID, targetId,
    targetUsername: pending?.username, timestamp: Date.now()
  })

  try {
    await bot.api.sendMessage(
      targetId,
      `🚫 You have been <b>banned</b> from this bot.`,
      { parse_mode: 'HTML' }
    )
  } catch {}

  const name = pending?.username ? `@${pending.username}` : pending?.firstName ?? String(targetId)
  await ctx.editMessageText(`🚫 <b>Banned:</b> ${escapeHTML(name)} (<code>${targetId}</code>)`, { parse_mode: 'HTML' })
  await ctx.answerCallbackQuery('🚫 User banned')
})

// ─── Admin Commands ───────────────────────────────────────────────────────────

bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')

  const pending = await getPendingUsers()

  if (pending.length === 0) {
    return ctx.reply('✅ No pending access requests.')
  }

  const list = pending.map(u => {
    const tag = escapeHTML(u.username ? `@${u.username}` : u.firstName ?? 'Unknown')
    const count = u.requestCount > 1 ? ` <i>(${u.requestCount}x requests)</i>` : ''
    return `• ${tag}${count}\n  ID: <code>${u.userId}</code>\n  Requested: ${escapeHTML(formatDate(u.requestedAt))}`
  }).join('\n\n')

  const keyboard = new InlineKeyboard()

  pending.forEach(u => {
    const label = u.username ? `@${u.username}` : u.firstName ?? String(u.userId)
    keyboard
      .text(`✅ ${label}`, `approve:${u.userId}`)
      .text(`❌`, `reject:${u.userId}`)
      .text(`🚫`, `ban:${u.userId}`)
      .row()
  })

  return ctx.reply(
    `👥 <b>Pending Requests (${pending.length}):</b>\n\n${list}`,
    { parse_mode: 'HTML', reply_markup: keyboard }
  )
})

bot.command('users', async (ctx) => {
  if (!isAdmin(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')

  const users = await getApprovedUsers()

  if (users.length === 0) {
    return ctx.reply('No approved users yet.')
  }

  const list = users.map(u => {
    const tag = escapeHTML(u.username ? `@${u.username}` : u.firstName ?? 'Unknown')
    const lastSeen = u.lastActive ? formatDate(u.lastActive) : 'never'
    return `• ${tag} — <code>${u.userId}</code>\n  💬 ${u.messageCount} msgs · Last: ${escapeHTML(lastSeen)}`
  }).join('\n\n')

  return ctx.reply(
    `👥 <b>Approved Users (${users.length}):</b>\n\n${list}`,
    { parse_mode: 'HTML' }
  )
})

bot.command('allow', async (ctx) => {
  if (!isAdmin(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')

  const arg = ctx.match.trim()
  if (!arg) return ctx.reply('Usage: /allow <user_id>')

  const targetId = Number(arg)
  if (isNaN(targetId)) return ctx.reply('❌ Invalid user ID.')

  const pending = (await getPendingUsers()).find(u => u.userId === targetId)
  await approveUser(targetId, ADMIN_ID, {
    username: pending?.username,
    firstName: pending?.firstName,
    languageCode: pending?.languageCode
  })
  await removePendingUser(targetId)
  await logAudit({ action: 'approve', adminId: ADMIN_ID, targetId, targetUsername: pending?.username, timestamp: Date.now() })

  try {
    await bot.api.sendMessage(targetId, `✅ Your access has been <b>approved!</b>\n\nSend /start to begin.`, { parse_mode: 'HTML' })
  } catch {}

  return ctx.reply(`✅ User <code>${targetId}</code> approved.`, { parse_mode: 'HTML' })
})

bot.command('revoke', async (ctx) => {
  if (!isAdmin(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')

  const arg = ctx.match.trim()
  if (!arg) return ctx.reply('Usage: /revoke <user_id>')

  const targetId = Number(arg)
  if (isNaN(targetId)) return ctx.reply('❌ Invalid user ID.')

  await revokeUser(targetId, ADMIN_ID)
  await logAudit({ action: 'revoke', adminId: ADMIN_ID, targetId, timestamp: Date.now() })

  try {
    await bot.api.sendMessage(targetId, `⚠️ Your bot access has been <b>revoked.</b>`, { parse_mode: 'HTML' })
  } catch {}

  return ctx.reply(`🔒 User <code>${targetId}</code> revoked.`, { parse_mode: 'HTML' })
})

bot.command('ban', async (ctx) => {
  if (!isAdmin(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')

  const arg = ctx.match.trim()
  if (!arg) return ctx.reply('Usage: /ban <user_id>')

  const targetId = Number(arg)
  if (isNaN(targetId)) return ctx.reply('❌ Invalid user ID.')

  const record = await getUserRecord(targetId)
  await banUser(targetId, ADMIN_ID, { username: record?.username, firstName: record?.firstName })
  await logAudit({ action: 'ban', adminId: ADMIN_ID, targetId, targetUsername: record?.username, timestamp: Date.now() })

  try {
    await bot.api.sendMessage(targetId, `🚫 You have been <b>banned</b> from this bot.`, { parse_mode: 'HTML' })
  } catch {}

  return ctx.reply(`🚫 User <code>${targetId}</code> banned permanently.`, { parse_mode: 'HTML' })
})

bot.command('unban', async (ctx) => {
  if (!isAdmin(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')

  const arg = ctx.match.trim()
  if (!arg) return ctx.reply('Usage: /unban <user_id>')

  const targetId = Number(arg)
  if (isNaN(targetId)) return ctx.reply('❌ Invalid user ID.')

  await unbanUser(targetId)
  await logAudit({ action: 'unban', adminId: ADMIN_ID, targetId, timestamp: Date.now() })

  return ctx.reply(`✅ User <code>${targetId}</code> unbanned. They can request access again.`, { parse_mode: 'HTML' })
})

bot.command('logs', async (ctx) => {
  if (!isAdmin(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')

  const logs = await getRecentAuditLog(15)

  if (logs.length === 0) return ctx.reply('No audit logs yet.')

  const icons: Record<string, string> = {
    approve: '✅', reject: '❌', ban: '🚫', unban: '🔓', revoke: '🔒'
  }

  const list = logs.map(l => {
    const icon = icons[l.action] ?? '•'
    const target = l.targetUsername ? escapeHTML(`@${l.targetUsername}`) : `<code>${l.targetId}</code>`
    const time = escapeHTML(formatDate(l.timestamp))
    return `${icon} ${l.action} → ${target}\n  ${time}`
  }).join('\n\n')

  return ctx.reply(`📋 <b>Recent Actions:</b>\n\n${list}`, { parse_mode: 'HTML' })
})

// ─── Commands ─────────────────────────────────────────────────────────────────

bot.command('help', async (ctx) => {
  const userId = ctx.from?.id ?? 0
  const adminSection = isAdmin(userId)
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

  await ctx.reply(
    `<b>Available Commands:</b>\n\n` +
    `<b>AI:</b>\n` +
    `/search &lt;query&gt; — AI-powered search\n` +
    `/weather &lt;city&gt; — current weather\n` +
    `/translate &lt;lang&gt; &lt;text&gt; — e.g. /translate ms hello\n` +
    `/summarize &lt;url&gt; — summarize a webpage\n` +
    `/explain &lt;topic&gt; — explain anything simply\n` +
    `/roast &lt;topic&gt; — roast anything 🔥\n` +
    `/roastme — send photo to get roasted\n` +
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
    `/github &lt;query&gt; — search GitHub repos\n\n` +
    `<b>Inline:</b>\n` +
    `@botname &lt;query&gt; — AI anywhere\n` +
    `@botname imagine &lt;prompt&gt; — image anywhere` +
    adminSection,
    { parse_mode: 'HTML' }
  )
})

bot.command('search', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const query = ctx.match.trim()
  if (!query) return ctx.reply('Usage: /search <query>')
  const msg = await ctx.reply('🔍 Searching...')
  try {
    const result = await chatWithSearch(query, ctx.from?.id)
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, result, { parse_mode: 'HTML' })
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
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, result, { parse_mode: 'HTML' })
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
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `🌐 <b>${targetLang}:</b>\n${result}`, { parse_mode: 'HTML' })
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
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `📄 <b>Summary:</b>\n${result}`, { parse_mode: 'HTML' })
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
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, result, { parse_mode: 'HTML' })
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
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `🔥 ${result}`, { parse_mode: 'HTML' })
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

bot.command('quote', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const msg = await ctx.reply('✨ Generating quote...')
  try {
    const result = await chat('Generate one unique, powerful motivational quote. Format: "quote" — Author (or "Unknown"). Just the quote, nothing else.', [], ctx.from?.id)
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `✨ ${result}`, { parse_mode: 'HTML' })
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

bot.command('persona', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const arg = ctx.match.trim().toLowerCase()
  const userId = ctx.from?.id ?? 0 // FIX: was ctx.from?.id!

  if (!arg) {
    const current = await getPersona(userId)
    const list = PERSONA_LIST.map(p => `• <code>${p}</code>`).join('\n')
    return ctx.reply(
      `🎭 <b>Persona Settings</b>\n\nCurrent: <code>${escapeHTML(current)}</code>\n\n<b>Available:</b>\n${list}\n\nUsage: /persona &lt;name&gt;`,
      { parse_mode: 'HTML' }
    )
  }

  if (!PERSONA_LIST.includes(arg)) {
    return ctx.reply(`❌ Unknown persona. Available: ${PERSONA_LIST.map(p => `<code>${p}</code>`).join(', ')}`, { parse_mode: 'HTML' })
  }

  await setPersona(userId, arg)
  await ctx.reply(`🎭 Persona set to <b>${escapeHTML(arg)}</b>`, { parse_mode: 'HTML' })
})

bot.command('continue', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const userId = ctx.from?.id ?? 0 // FIX: was ctx.from?.id!
  const history = await getHistory(userId)
  if (history.length === 0) return ctx.reply('💭 No conversation history to continue.')
  const msg = await ctx.reply('💭 Continuing...')
  try {
    const result = await chat('Continue from where you left off.', [], userId, history)
    await appendHistory(userId, 'user', 'Continue from where you left off.')
    await appendHistory(userId, 'assistant', result)
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, result, { parse_mode: 'HTML' })
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

bot.command('clear', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  await clearHistory(ctx.from?.id ?? 0) // FIX: was ctx.from?.id!
  await ctx.reply('🗑️ Conversation memory cleared.') // FIX: added await
})

bot.command('model', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const arg = ctx.match.trim().toLowerCase()
  const userId = ctx.from?.id ?? 0 // FIX: was ctx.from?.id!

  if (!arg) {
    const pref = await getUserProvider(userId)
    const current = pref.model ? `${escapeHTML(pref.provider)} → <code>${escapeHTML(pref.model)}</code>` : `<code>${escapeHTML(pref.provider)}</code>`
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
    pendingMistralSelection.set(userId, true)
    const list = modelList.map((m, i) => `${i + 1}. <code>${m}</code>`).join('\n')
    return ctx.reply(
      `🇫🇷 <b>Mistral Models:</b>\n\n${list}\n\nReply with the <b>number</b> to select.\nType /model auto to cancel.`,
      { parse_mode: 'HTML' }
    )
  }

  if (arg === 'openrouter') {
    const models = await getFreeModelList()
    pendingModelSelection.set(userId, models)
    const list = models.map((m, i) => `${i + 1}. <code>${escapeHTML(m)}</code>`).join('\n')
    return ctx.reply(
      `🔀 <b>OpenRouter Free Models (${models.length}):</b>\n\n${list}\n\nReply with the <b>number</b> to select.\nType /model auto to cancel.`,
      { parse_mode: 'HTML' }
    )
  }

  const valid = ['auto', 'groq']
  if (!valid.includes(arg)) return ctx.reply(`❌ Invalid option. Choose: auto, groq, mistral, openrouter`)

  pendingModelSelection.delete(userId)
  pendingMistralSelection.delete(userId)
  await setUserProvider(userId, arg)
  const labels: Record<string, string> = {
    auto: '🔄 Auto fallback (recommended)',
    groq: '⚡ Groq (fastest)',
  }
  await ctx.reply(`✅ Provider set to <b>${escapeHTML(arg)}</b>\n${labels[arg]}`, { parse_mode: 'HTML' })
})

// ─── Humor Commands ───────────────────────────────────────────────────────────

bot.command('joke', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const msg = await ctx.reply('😄 Generating joke...')
  try {
    const result = await chat('Tell me one funny, clean, original joke. Just the joke, no intro or explanation.', [], ctx.from?.id ?? 0)
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `😄 ${result}`, { parse_mode: 'HTML' })
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

bot.command('darkjoke', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const msg = await ctx.reply('😈 Generating dark joke...')
  try {
    const result = await chat('Tell me one dark humour joke. Keep it edgy but not targeting real tragedies or specific groups. Just the joke, no intro.', [], ctx.from?.id ?? 0)
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `😈 ${result}`, { parse_mode: 'HTML' })
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

bot.command('dadjoke', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const msg = await ctx.reply('👨 Generating dad joke...')
  try {
    const result = await chat('Tell me one classic corny dad joke with a punchline. Just the joke, no intro or explanation.', [], ctx.from?.id ?? 0)
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `👨 ${result}`, { parse_mode: 'HTML' })
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

// ─── Image & Utility Commands ─────────────────────────────────────────────────

bot.command('sticker', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const prompt = ctx.match.trim()
  if (!prompt) return ctx.reply('Usage: /sticker <prompt>')
  try {
    const stickerPrompt = `${prompt}, sticker art style, bold outlines, vibrant colors, white background, cute kawaii style`
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(stickerPrompt)}?width=512&height=512&nologo=true&seed=${Date.now()}`
    await ctx.replyWithPhoto(url, { caption: `🎭 ${prompt}` })
  } catch (err) {
    await ctx.reply(`❌ Failed: ${String(err)}`)
  }
})

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
    await ctx.replyWithPhoto(new InputFile(buffer, 'qr.png'), { caption: `📱 QR Code for: ${text}` })
  } catch (err) {
    try { await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`) } catch { await ctx.reply(`❌ Failed: ${String(err)}`) }
  }
})

// FIX: replaced Function() eval with mathjs evaluate — safe math parser
bot.command('calc', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const expr = ctx.match.trim()
  if (!expr) return ctx.reply('Usage: /calc <expression>\nExample: /calc 2 + 2 * 10')
  try {
    const result = evaluate(expr)
    await ctx.reply(`🧮 <code>${escapeHTML(expr)}</code> = <b>${escapeHTML(result)}</b>`, { parse_mode: 'HTML' })
  } catch {
    await ctx.reply('❌ Invalid expression. Example: /calc 100 * 1.06') // FIX: added await
  }
})

// ─── Media Handlers ───────────────────────────────────────────────────────────

bot.on('message:photo', async (ctx) => {
  const userId = ctx.from?.id ?? 0
  if (!await isAllowed(userId)) return ctx.reply('⛔ Unauthorized.')
  const msg = await ctx.reply('🖼️ Analyzing image...')
  try {
    const photo = ctx.message.photo.at(-1)!
    const { buffer, mimeType } = await fetchFile(photo.file_id)
    const part = fileToGenerativePart(buffer, mimeType)
    const caption = ctx.message.caption ?? 'Describe this image in detail.'
    const result = await chat(caption, [part], userId)
    const isFirst = await trackUsage(userId)
    if (isFirst && !isAdmin(userId)) {
      await bot.api.sendMessage(ADMIN_ID, `🟢 User <code>${userId}</code> is active for the first time!`, { parse_mode: 'HTML' })
    }
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, result, { parse_mode: 'HTML' })
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

bot.on('message:document', async (ctx) => {
  const userId = ctx.from?.id ?? 0
  if (!await isAllowed(userId)) return ctx.reply('⛔ Unauthorized.')
  const msg = await ctx.reply('📄 Reading file...')
  try {
    const doc = ctx.message.document
    const { buffer, mimeType } = await fetchFile(doc.file_id)
    const part = fileToGenerativePart(buffer, mimeType)
    const caption = ctx.message.caption ?? 'Summarize the contents of this file.'
    const result = await chat(caption, [part], userId)
    const isFirst = await trackUsage(userId)
    if (isFirst && !isAdmin(userId)) {
      await bot.api.sendMessage(ADMIN_ID, `🟢 User <code>${userId}</code> is active for the first time!`, { parse_mode: 'HTML' })
    }
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, result, { parse_mode: 'HTML' })
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

bot.on('message:text', async (ctx) => {
  const userId = ctx.from?.id ?? 0
  if (!await isAllowed(userId)) return ctx.reply('⛔ Unauthorized.')
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
    return ctx.reply(`✅ <b>Mistral model selected!</b>\n\n<code>${escapeHTML(selected)}</code>\n\nAll messages will use this model now.`, { parse_mode: 'HTML' })
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
    return ctx.reply(`✅ <b>Model selected!</b>\n\n<code>${escapeHTML(selected)}</code>\n\nAll messages will use this model now.`, { parse_mode: 'HTML' })
  }

  const msg = await ctx.reply('💭 Thinking...')
  try {
    const history = await getHistory(userId)
    const result = await chat(text, [], userId, history)
    await appendHistory(userId, 'user', text)
    await appendHistory(userId, 'assistant', result)

    const isFirst = await trackUsage(userId)
    if (isFirst && !isAdmin(userId)) {
      await bot.api.sendMessage(ADMIN_ID, `🟢 User <code>${userId}</code> sent their first message!`, { parse_mode: 'HTML' })
    }

    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, result, { parse_mode: 'HTML' })
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Error: ${String(err)}`)
  }
})

// ─── Inline Query ─────────────────────────────────────────────────────────────

bot.on('inline_query', async (ctx) => {
  const userId = ctx.from?.id ?? 0

  if (!await isAllowed(userId)) {
    return ctx.answerInlineQuery([{
      type: 'article',
      id: 'lock',
      title: '⛔ Access Required',
      input_message_content: { message_text: '⛔ You need access to use this bot. Send /start to request access.' },
      description: 'Access denied'
    }])
  }

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

    const history = await getHistory(userId)
    const result = await chat(prompt, [], userId, history)
    return ctx.answerInlineQuery([{
      type: 'article',
      id: '1',
      title: query.slice(0, 60),
      input_message_content: { message_text: result, parse_mode: 'HTML' },
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

// ─── AI Upgrade Commands ──────────────────────────────────────────────────────

bot.command('debate', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const topic = ctx.match.trim()
  if (!topic) return ctx.reply('Usage: /debate <topic>')
  const msg = await ctx.reply('⚖️ Preparing both sides...')
  try {
    const result = await chat(`Debate the topic: "${topic}". Present strong arguments FOR and AGAINST in a structured format. Label them clearly. Be balanced and thorough.`, [], ctx.from?.id)
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, result, { parse_mode: 'HTML' })
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

bot.command('story', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const prompt = ctx.match.trim()
  if (!prompt) return ctx.reply('Usage: /story <prompt>')
  const msg = await ctx.reply('📖 Writing story...')
  try {
    const result = await chat(`Write a short, engaging story based on this prompt: "${prompt}". Keep it under 300 words. Make it interesting with a clear beginning, middle, and end.`, [], ctx.from?.id)
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, result, { parse_mode: 'HTML' })
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

bot.command('code', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const desc = ctx.match.trim()
  if (!desc) return ctx.reply('Usage: /code <description>\nExample: /code fizzbuzz in python')
  const msg = await ctx.reply('💻 Generating code...')
  try {
    const result = await chat(`Generate clean, well-commented code for: "${desc}". Include a brief explanation of how it works.`, [], ctx.from?.id)
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, result, { parse_mode: 'HTML' })
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

bot.command('roastme', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const photos = ctx.message?.photo
  if (!photos || photos.length === 0) return ctx.reply('📸 Send a photo with the caption /roastme to get roasted!')
  const msg = await ctx.reply('🔥 Analyzing...')
  try {
    const photo = photos.at(-1)!
    const { buffer, mimeType } = await fetchFile(photo.file_id)
    const part = fileToGenerativePart(buffer, mimeType)
    const result = await chat('Give a funny, savage but lighthearted roast based on what you see in this photo. Be creative and humorous, not cruel. Keep it to 3-5 sentences.', [part], ctx.from?.id)
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `🔥 ${result}`, { parse_mode: 'HTML' })
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

bot.command('imagine', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
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
  for (const [flag, style] of Object.entries(styleMap)) {
    if (prompt.includes(flag)) {
      prompt = prompt.replace(flag, '').trim() + ', ' + style
      styleLabel = ` (${flag.replace('--', '')})`
      break
    }
  }

  const msg = await ctx.reply('🎨 Generating image...')
  try {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${Date.now()}`
    await ctx.api.deleteMessage(ctx.chat.id, msg.message_id)
    await ctx.replyWithPhoto(url, { caption: `🎨 ${ctx.match.trim()}${styleLabel}` })
  } catch (err) {
    try { await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`) } catch { await ctx.reply(`❌ Failed: ${String(err)}`) }
  }
})

// ─── Utility Commands ─────────────────────────────────────────────────────────

bot.command('shorten', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const url = ctx.match.trim()
  if (!url) return ctx.reply('Usage: /shorten <url>')
  const msg = await ctx.reply('🔗 Shortening...')
  try {
    const res = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`)
    if (!res.ok) throw new Error('TinyURL failed')
    const short = await res.text()
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `🔗 ${short}`)
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

bot.command('currency', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const args = ctx.match.trim().split(' ')
  if (args.length < 3) return ctx.reply('Usage: /currency <amount> <from> <to>\nExample: /currency 100 USD MYR')
  const [amount, from, to] = args
  const msg = await ctx.reply('💱 Converting...')
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${from.toUpperCase()}`)
    if (!res.ok) throw new Error('API failed')
    const data = await res.json()
    const rate = data.rates?.[to.toUpperCase()]
    if (!rate) throw new Error(`Unknown currency: ${to.toUpperCase()}`)
    const result = (parseFloat(amount) * rate).toFixed(2)
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id,
      `💱 <b>${escapeHTML(amount)} ${escapeHTML(from.toUpperCase())}</b> = <b>${result} ${escapeHTML(to.toUpperCase())}</b>\n<i>Rate: 1 ${escapeHTML(from.toUpperCase())} = ${rate} ${escapeHTML(to.toUpperCase())}</i>`,
      { parse_mode: 'HTML' }
    )
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

// FIX: worldtimeapi.org has been permanently shut down (sunset by its maintainer),
// so this command was 100% broken — every call threw "City not found" or a fetch
// error. IANA timezone data ships with Node/V8 itself via Intl, so this no longer
// depends on any external API at all.
bot.command('time', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const city = ctx.match.trim()
  if (!city) return ctx.reply('Usage: /time <city>\nExample: /time Tokyo')
  try {
    const zones: string[] = (Intl as any).supportedValuesOf('timeZone')
    const needle = city.toLowerCase().replace(/\s+/g, '_')
    const match =
      zones.find(z => z.split('/').pop()?.toLowerCase() === needle) ??
      zones.find(z => z.toLowerCase().includes(needle))
    if (!match) return ctx.reply(`❌ Unknown city/timezone: ${city}`)
    const now = new Date()
    const formatted = now.toLocaleString('en-MY', { timeZone: match, dateStyle: 'full', timeStyle: 'short' })
    await ctx.reply(`🕐 <b>${escapeHTML(match)}</b>\n${escapeHTML(formatted)}`, { parse_mode: 'HTML' })
  } catch (err) {
    await ctx.reply(`❌ Failed: ${escapeHTML(String(err))}`)
  }
})

bot.command('encode', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const input = ctx.match.trim()
  if (!input) return ctx.reply('Usage: /encode <text>')
  const b64 = Buffer.from(input).toString('base64')
  const url = encodeURIComponent(input)
  await ctx.reply(
    `🔐 <b>Encoded:</b>\n\n<b>Base64:</b>\n<code>${escapeHTML(b64)}</code>\n\n<b>URL:</b>\n<code>${escapeHTML(url)}</code>`,
    { parse_mode: 'HTML' }
  )
})

bot.command('hash', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
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

bot.command('github', async (ctx) => {
  if (!await isAllowed(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const query = ctx.match.trim()
  if (!query) return ctx.reply('Usage: /github <query>\nExample: /github music player cli')
  const msg = await ctx.reply('🔍 Searching GitHub...')
  try {
    const repos = await searchRepos(query)
    if (repos.length === 0) {
      return ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ No repos found for: ${escapeHTML(query)}`, { parse_mode: 'HTML' })
    }
    const body = repos.map(formatRepo).join('\n\n')
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id,
      `🐙 <b>GitHub results for "${escapeHTML(query)}":</b>\n\n${body}`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    )
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${escapeHTML(String(err))}`)
  }
})

// ─── Admin Upgrade Commands ───────────────────────────────────────────────────

bot.command('broadcast', async (ctx) => {
  if (!isAdmin(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const message = ctx.match.trim()
  if (!message) return ctx.reply('Usage: /broadcast <message>')
  const users = await getApprovedUsers()
  const msg = await ctx.reply(`📡 Broadcasting to ${users.length} users...`)
  let success = 0, failed = 0
  const sanitized = sanitizeBroadcastMessage(message)
  for (const user of users) {
    try {
      await bot.api.sendMessage(user.userId, `📢 <b>Broadcast:</b>\n\n${sanitized}`, { parse_mode: 'HTML' })
      success++
    } catch { failed++ }
  }
  await ctx.api.editMessageText(ctx.chat.id, msg.message_id,
    `📡 <b>Broadcast complete</b>\n\n✅ Sent: ${success}\n❌ Failed: ${failed}`,
    { parse_mode: 'HTML' }
  )
})

bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const msg = await ctx.reply('📊 Fetching stats...')
  try {
    const { totalUsers, totalMessages, topUsers } = await getStats()
    const topList = topUsers.map((u, i) => `${i + 1}. ${escapeHTML(u.tag)} — ${u.count} msgs`).join('\n')
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id,
      `📊 <b>Bot Stats</b>\n\n👥 Total Users: <b>${totalUsers}</b>\n💬 Total Messages: <b>${totalMessages}</b>\n\n<b>🏆 Top 5 Users:</b>\n${topList}`,
      { parse_mode: 'HTML' }
    )
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${String(err)}`)
  }
})

bot.command('maintenance', async (ctx) => {
  if (!isAdmin(ctx.from?.id ?? 0)) return ctx.reply('⛔ Unauthorized.')
  const arg = ctx.match.trim().toLowerCase()
  if (!arg || !['on', 'off'].includes(arg)) return ctx.reply('Usage: /maintenance on|off')
  await setMaintenance(arg === 'on')
  await ctx.reply(
    arg === 'on'
      ? '🔧 <b>Maintenance mode ON</b> — all non-admin users are blocked.'
      : '✅ <b>Maintenance mode OFF</b> — bot is back online.',
    { parse_mode: 'HTML' }
  )
})

export default bot
