// Bot construction + handler registration order.
//
// grammY runs middleware strictly in registration order and STOPS at the first
// handler that doesn't call next(). The order below is therefore load-bearing:
//
//   1. bot.catch          — global error logging
//   2. lossless           — audio tagging must see audio documents BEFORE the
//                          AI document handler can swallow them
//   3. admin callbacks + commands
//   4. media catch-alls   — photos/documents (incl. /roastme by caption)
//   5. chat catch-alls    — text + inline queries — MUST be last, otherwise
//                          every command registered after them is swallowed
//
// The bot is constructed lazily: `new Bot('')` throws, so building it at module
// scope broke `next build` (and any cold start) whenever BOT_TOKEN wasn't set
// in that environment.

import { Bot } from 'grammy'
import { registerLosslessHandler } from './lossless'
import { registerAdminHandlers } from './handlers/admin'
import { registerCommands } from './handlers/commands'
import { registerMediaHandlers } from './handlers/media'
import { registerChatHandlers } from './handlers/chat'

let instance: Bot | null = null

export function getBot(): Bot {
  if (instance) return instance

  const token = process.env.BOT_TOKEN
  if (!token) {
    console.error('[bot] BOT_TOKEN is not configured')
    throw new Error('BOT_TOKEN is not configured')
  }

  const bot = new Bot(token)

  bot.catch((err) => {
    console.error(`[bot] error while handling update ${err.ctx.update.update_id}:`, err.error)
  })

  registerLosslessHandler(bot)
  registerAdminHandlers(bot)
  registerCommands(bot)
  registerMediaHandlers(bot)
  registerChatHandlers(bot) // keep last

  instance = bot
  return bot
}

export default getBot
