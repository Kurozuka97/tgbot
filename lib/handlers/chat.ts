// Catch-ALL handlers: plain text chat + inline queries.
//
// THIS MODULE MUST BE REGISTERED LAST. grammY stops at the first middleware
// that doesn't call next(), so anything registered after these catch-alls
// would never run — that exact bug previously made 14 commands dead.

import type { Bot, Context } from 'grammy'
import { checkAccess, accessMessage } from '../access'
import { consumeAiQuota } from '../ratelimit'
import { editOrReply, notifyFirstActive } from './helpers'
import { errMsg } from '../util'
import { escapeHTML } from '../html'
import {
  chat,
  getHistory, appendExchange,
  setUserProvider,
  getPendingModelSelection, clearPendingModelSelection,
} from '../ai'
import { trackUsage } from '../firebase'

export function registerChatHandlers(bot: Bot): void {
  bot.on('message:text', async (ctx) => {
    const userId = ctx.from?.id ?? 0
    const status = await checkAccess(userId)
    const denied = accessMessage(status)
    if (denied) {
      await ctx.reply(denied).catch(() => {})
      return
    }

    const text = ctx.message.text

    // Number reply for /model mistral|openrouter — the pending list lives in
    // Firestore (tgbot_prefs.pendingModel), not in memory, so it survives
    // serverless cold starts and instance switches.
    const pending = await getPendingModelSelection(userId)
    if (pending) {
      const num = parseInt(text.trim(), 10)
      if (Number.isNaN(num) || num < 1 || num > pending.models.length) {
        await ctx.reply(`❌ Invalid. Pick 1–${pending.models.length}, or /model auto to cancel.`)
        return
      }
      const selected = pending.models[num - 1]
      await clearPendingModelSelection(userId)
      await setUserProvider(userId, pending.provider, selected)
      const label = pending.provider === 'mistral' ? 'Mistral model' : 'Model'
      await ctx.reply(
        `✅ <b>${label} selected!</b>\n\n<code>${escapeHTML(selected)}</code>\n\nAll messages will use this model now.`,
        { parse_mode: 'HTML' }
      )
      return
    }

    // Unknown commands fall through to here (they aren't registered anywhere).
    // Don't feed them to the AI — tell the user instead.
    if (text.startsWith('/')) {
      await ctx.reply('❌ Unknown command — see /help.').catch(() => {})
      return
    }

    const { ok } = await consumeAiQuota(userId)
    if (!ok) {
      await ctx.reply('⛔ Daily AI limit reached. Try again after midnight UTC.').catch(() => {})
      return
    }

    const msg = await ctx.reply('💭 Thinking...')
    try {
      const history = await getHistory(userId)
      const result = await chat(text, [], userId, history)
      await appendExchange(userId, text, result)

      const isFirst = await trackUsage(userId)
      if (isFirst) await notifyFirstActive(bot, userId, 'sent their first message')

      await editOrReply(ctx, msg.message_id, result)
    } catch (err) {
      await editOrReply(ctx, msg.message_id, `❌ Failed: ${errMsg(err)}`)
    }
  })

  bot.on('inline_query', async (ctx) => {
    const userId = ctx.from?.id ?? 0
    const status = await checkAccess(userId)

    if (status !== 'ok') {
      return ctx.answerInlineQuery([{
        type: 'article',
        id: 'lock',
        title: status === 'banned' ? '🚫 Banned' : '⛔ Access Required',
        input_message_content: {
          message_text: status === 'banned'
            ? '🚫 You have been banned from using this bot.'
            : '⛔ You need access to use this bot. Send /start to request access.'
        },
        description: 'Access denied'
      }], { cache_time: 0 }).catch(() => {})
    }

    const query = ctx.inlineQuery.query.trim()
    if (!query) {
      return ctx.answerInlineQuery([{
        type: 'article',
        id: '0',
        title: 'Ask me anything!',
        input_message_content: { message_text: '💬 Type something after @botname' },
        description: 'e.g. @botname explain black holes'
      }], { cache_time: 0 }).catch(() => {})
    }

    const { ok } = await consumeAiQuota(userId)
    if (!ok) {
      return ctx.answerInlineQuery([{
        type: 'article',
        id: 'quota',
        title: '⛔ Daily limit reached',
        input_message_content: { message_text: '⛔ Daily AI limit reached. Try again after midnight UTC.' },
        description: 'Rate limited'
      }], { cache_time: 0 }).catch(() => {})
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
        }], { cache_time: 0 }).catch(() => {})
      }

      const history = await getHistory(userId)
      const result = await chat(prompt, [], userId, history)
      return ctx.answerInlineQuery([{
        type: 'article',
        id: '1',
        title: query.slice(0, 60),
        input_message_content: { message_text: result, parse_mode: 'HTML' },
        description: result.slice(0, 100)
      }], { cache_time: 0 }).catch(() => {})
    } catch {
      return ctx.answerInlineQuery([{
        type: 'article',
        id: 'err',
        title: '❌ Error',
        input_message_content: { message_text: '❌ Failed to process query.' },
        description: 'Try again'
      }], { cache_time: 0 }).catch(() => {})
    }
  })
}
