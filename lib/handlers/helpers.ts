// Registration helpers. grammY runs middleware strictly in registration order
// and stops at the first handler that does not call next() — so the ORDER in
// which handlers are registered is load-bearing:
//
//   1. lossless audio tagging (registerLosslessHandler)
//   2. admin callbacks + ALL commands
//   3. catch-alls: message:photo, message:document, message:text, inline_query
//
// Catch-alls must come last or they swallow commands registered after them
// (that bug made 14 commands dead — they were fed to the AI as plain text).

import type { Bot, CallbackQueryContext, CommandContext, Context } from 'grammy'
import { getAdminId, isAdmin, requireAccess } from '../access'
import { requireAiQuota } from '../ratelimit'

type CommandHandler = (ctx: CommandContext<Context>, userId: number) => Promise<unknown>

// User command: access-gated, optionally consumes the daily AI quota.
export function userCommand(
  bot: Bot,
  name: string,
  opts: { ai?: boolean },
  handler: CommandHandler,
): void {
  bot.command(name, async (ctx) => {
    const userId = await requireAccess(ctx)
    if (userId === null) return
    if (opts.ai && !(await requireAiQuota(ctx, userId))) return
    return handler(ctx, userId)
  })
}

// Admin command: admin-only, no AI quota (admin is exempt anyway).
export function adminCommand(
  bot: Bot,
  name: string,
  handler: (ctx: CommandContext<Context>, adminId: number) => Promise<unknown>,
): void {
  bot.command(name, async (ctx) => {
    const adminId = ctx.from?.id ?? 0
    if (!isAdmin(adminId)) return ctx.reply('⛔ Unauthorized.')
    return handler(ctx, adminId)
  })
}

// Admin inline-button callback. The handler returns an optional toast string;
// answerCallbackQuery is ALWAYS called (in a finally) so the button never
// leaves Telegram's spinner spinning when editMessageText throws. Handlers
// read capture groups from ctx.match as usual.
export function adminCallback(
  bot: Bot,
  trigger: string | RegExp,
  handler: (ctx: CallbackQueryContext<Context>) => Promise<string | void>,
): void {
  bot.callbackQuery(trigger, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery('⛔ Unauthorized').catch(() => {})
      return
    }
    let toast: string | void
    try {
      toast = await handler(ctx)
    } catch (err) {
      console.error('[bot] callback handler failed:', err)
      toast = '⚠️ Action failed.'
    }
    await ctx.answerCallbackQuery(toast ?? '').catch(() => {})
  })
}

// Replace the "Thinking..." placeholder with the result. If the edit fails
// (message deleted, too old, etc.) fall back to a fresh reply so the user
// still gets an answer instead of a permanently stuck placeholder.
// Callers come from message handlers, so chat is always present.
export async function editOrReply(ctx: Context, messageId: number, text: string): Promise<void> {
  try {
    await ctx.api.editMessageText(ctx.chat!.id, messageId, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    })
  } catch {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    }).catch(() => {})
  }
}

// Ping the admin the first time an approved user actually does something.
export async function notifyFirstActive(bot: Bot, userId: number, what: string): Promise<void> {
  if (isAdmin(userId)) return
  const adminId = getAdminId()
  if (!Number.isFinite(adminId)) return
  try {
    await bot.api.sendMessage(adminId, `🟢 User <code>${userId}</code> ${what}!`, { parse_mode: 'HTML' })
  } catch (err) {
    console.error('[bot] failed to send first-active notification:', err)
  }
}
