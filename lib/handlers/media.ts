// Catch-all media handlers. MUST be registered after all commands and before
// the chat catch-all — see helpers.ts for the ordering rules.

import type { Bot, Context } from 'grammy'
import { requireAccess } from '../access'
import { requireAiQuota } from '../ratelimit'
import { editOrReply, notifyFirstActive } from './helpers'
import { errMsg, fetchFile } from '../util'
import { chat, fileToGenerativePart } from '../ai'
import { trackUsage } from '../firebase'

// Analyze an image (or a document fed to the AI as a generative part).
async function analyzeMedia(
  bot: Bot,
  ctx: Context,
  userId: number,
  fileId: string,
  fileSize: number | undefined,
  caption: string,
  defaultPrompt: string,
  emoji: string,
): Promise<void> {
  const msg = await ctx.reply(`${emoji} Analyzing...`)
  try {
    const { buffer, mimeType } = await fetchFile(ctx.api, process.env.BOT_TOKEN!, fileId, fileSize)
    const part = fileToGenerativePart(buffer, mimeType)
    const result = await chat(caption || defaultPrompt, [part], userId)
    const isFirst = await trackUsage(userId)
    if (isFirst) await notifyFirstActive(bot, userId, 'is active for the first time')
    // Vision replies aren't part of text history (the model can't "continue"
    // an image analysis sensibly), matching the previous behavior.
    await editOrReply(ctx, msg.message_id, result)
  } catch (err) {
    await editOrReply(ctx, msg.message_id, `❌ Failed: ${errMsg(err)}`)
  }
}

export function registerMediaHandlers(bot: Bot): void {
  bot.on('message:photo', async (ctx) => {
    const userId = await requireAccess(ctx)
    if (userId === null) return
    if (!(await requireAiQuota(ctx, userId))) return

    const caption = ctx.message.caption ?? ''

    // /roastme can't be a real command on a photo: grammY does not match
    // commands in captions, and this catch-all swallows photos anyway. So the
    // documented flow (send a photo with caption "/roastme") is handled here.
    if (/^\/roastme(@\w+)?(\s|$)/.test(caption.trim())) {
      const photo = ctx.message.photo.at(-1)
      if (!photo) return
      const msg = await ctx.reply('🔥 Analyzing...')
      try {
        const { buffer, mimeType } = await fetchFile(ctx.api, process.env.BOT_TOKEN!, photo.file_id, photo.file_size)
        const part = fileToGenerativePart(buffer, mimeType)
        const result = await chat(
          'Give a funny, savage but lighthearted roast based on what you see in this photo. Be creative and humorous, not cruel. Keep it to 3-5 sentences.',
          [part], userId
        )
        await editOrReply(ctx, msg.message_id, `🔥 ${result}`)
      } catch (err) {
        await editOrReply(ctx, msg.message_id, `❌ Failed: ${errMsg(err)}`)
      }
      return
    }

    const photo = ctx.message.photo.at(-1)
    if (!photo) return
    await analyzeMedia(
      bot, ctx, userId, photo.file_id, photo.file_size,
      caption, 'Describe this image in detail.', '🖼️'
    )
  })

  bot.on('message:document', async (ctx) => {
    const userId = await requireAccess(ctx)
    if (userId === null) return
    if (!(await requireAiQuota(ctx, userId))) return

    const doc = ctx.message.document
    await analyzeMedia(
      bot, ctx, userId, doc.file_id, doc.file_size,
      ctx.message.caption ?? '', 'Summarize the contents of this file.', '📄'
    )
  })
}
