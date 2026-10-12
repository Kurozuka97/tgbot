// Admin callbacks + admin commands: access requests, bans, broadcast, stats,
// maintenance, audit log.

import type { Bot } from 'grammy'
import { InlineKeyboard } from 'grammy'
import { adminCallback, adminCommand } from './helpers'
import { getAdminId } from '../access'
import { escapeHTML } from '../html'
import { formatDate, errMsg, sleep } from '../util'
import {
  approveUser, revokeUser, banUser, unbanUser,
  removePendingUser, getPendingUsers,
  getApprovedUsers, getUserRecord, isUserBanned,
  logAudit, getRecentAuditLog,
  setMaintenance, getStats,
} from '../firebase'

async function notifyUser(bot: Bot, userId: number, text: string): Promise<void> {
  try {
    await bot.api.sendMessage(userId, text, { parse_mode: 'HTML' })
  } catch {
    // User may have blocked the bot or never started it — that's fine.
  }
}

function displayName(info: { username?: string | null; firstName?: string | null } | undefined, fallback: number): string {
  if (info?.username) return `@${info.username}`
  if (info?.firstName) return info.firstName
  return String(fallback)
}

export function registerAdminHandlers(bot: Bot): void {
  // ─── Inline button callbacks ────────────────────────────────────────────────

  adminCallback(bot, /^approve:(\d+)$/, async (ctx) => {
    const targetId = Number(ctx.match[1])
    const pending = (await getPendingUsers()).find(u => u.userId === targetId)

    await approveUser(targetId, getAdminId(), {
      username: pending?.username ?? undefined,
      firstName: pending?.firstName ?? undefined,
      languageCode: pending?.languageCode ?? undefined
    })
    await removePendingUser(targetId)
    await logAudit({
      action: 'approve', adminId: getAdminId(), targetId,
      targetUsername: pending?.username, timestamp: Date.now()
    })

    await notifyUser(bot, targetId, `✅ Your access has been <b>approved!</b>\n\nSend /start to begin.`)
    await ctx.editMessageText(
      `✅ <b>Approved:</b> ${escapeHTML(displayName(pending, targetId))} (<code>${targetId}</code>)`,
      { parse_mode: 'HTML' }
    )
    return '✅ User approved'
  })

  adminCallback(bot, /^reject:(\d+)$/, async (ctx) => {
    const targetId = Number(ctx.match[1])
    const pending = (await getPendingUsers()).find(u => u.userId === targetId)

    await removePendingUser(targetId)
    await logAudit({
      action: 'reject', adminId: getAdminId(), targetId,
      targetUsername: pending?.username, timestamp: Date.now()
    })

    await notifyUser(bot, targetId, `❌ Your access request has been <b>rejected.</b>\n\nContact the admin if you think this is a mistake.`)
    await ctx.editMessageText(
      `❌ <b>Rejected:</b> ${escapeHTML(displayName(pending, targetId))} (<code>${targetId}</code>)`,
      { parse_mode: 'HTML' }
    )
    return '❌ User rejected'
  })

  adminCallback(bot, /^ban:(\d+)$/, async (ctx) => {
    const targetId = Number(ctx.match[1])
    const pending = (await getPendingUsers()).find(u => u.userId === targetId)

    await banUser(targetId, getAdminId(), {
      username: pending?.username ?? undefined,
      firstName: pending?.firstName ?? undefined
    })
    await logAudit({
      action: 'ban', adminId: getAdminId(), targetId,
      targetUsername: pending?.username, timestamp: Date.now()
    })

    await notifyUser(bot, targetId, `🚫 You have been <b>banned</b> from this bot.`)
    await ctx.editMessageText(
      `🚫 <b>Banned:</b> ${escapeHTML(displayName(pending, targetId))} (<code>${targetId}</code>)`,
      { parse_mode: 'HTML' }
    )
    return '🚫 User banned'
  })

  // ─── Admin commands ─────────────────────────────────────────────────────────

  adminCommand(bot, 'admin', async (ctx) => {
    const pending = await getPendingUsers()
    if (pending.length === 0) {
      return ctx.reply('✅ No pending access requests.')
    }

    const list = pending.map(u => {
      const tag = escapeHTML(u.username ? `@${u.username}` : u.firstName ?? 'Unknown')
      const count = u.requestCount > 1 ? ` <i>(${u.requestCount}x requests)</i>` : ''
      return `• ${tag}${count}\n  ID: <code>${u.userId}</code>\n  Requested: ${escapeHTML(formatDate(u.requestedAt))}`
    }).join('\n\n')

    // Telegram rejects button labels > 64 chars — keep them short.
    const keyboard = new InlineKeyboard()
    pending.forEach(u => {
      const label = (u.username ? `@${u.username}` : u.firstName ?? String(u.userId)).slice(0, 40)
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

  adminCommand(bot, 'users', async (ctx) => {
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

  adminCommand(bot, 'allow', async (ctx) => {
    const arg = ctx.match.trim()
    if (!arg) return ctx.reply('Usage: /allow <user_id>')

    const targetId = Number(arg)
    if (Number.isNaN(targetId)) return ctx.reply('❌ Invalid user ID.')

    const wasBanned = await isUserBanned(targetId)
    const pending = (await getPendingUsers()).find(u => u.userId === targetId)
    await approveUser(targetId, getAdminId(), {
      username: pending?.username,
      firstName: pending?.firstName,
      languageCode: pending?.languageCode
    })
    // Approving a banned user used to leave them in banned_users, so they
    // stayed blocked despite being "approved". Clear the ban too.
    if (wasBanned) await unbanUser(targetId)
    await removePendingUser(targetId)
    await logAudit({
      action: 'approve', adminId: getAdminId(), targetId,
      targetUsername: pending?.username, timestamp: Date.now()
    })

    await notifyUser(bot, targetId, `✅ Your access has been <b>approved!</b>\n\nSend /start to begin.`)
    return ctx.reply(
      `✅ User <code>${targetId}</code> approved.${wasBanned ? ' (was banned — ban lifted)' : ''}`,
      { parse_mode: 'HTML' }
    )
  })

  adminCommand(bot, 'revoke', async (ctx) => {
    const arg = ctx.match.trim()
    if (!arg) return ctx.reply('Usage: /revoke <user_id>')

    const targetId = Number(arg)
    if (Number.isNaN(targetId)) return ctx.reply('❌ Invalid user ID.')

    await revokeUser(targetId, getAdminId())
    await logAudit({ action: 'revoke', adminId: getAdminId(), targetId, timestamp: Date.now() })

    await notifyUser(bot, targetId, `⚠️ Your bot access has been <b>revoked.</b>`)
    return ctx.reply(`🔒 User <code>${targetId}</code> revoked.`, { parse_mode: 'HTML' })
  })

  adminCommand(bot, 'ban', async (ctx) => {
    const arg = ctx.match.trim()
    if (!arg) return ctx.reply('Usage: /ban <user_id>')

    const targetId = Number(arg)
    if (Number.isNaN(targetId)) return ctx.reply('❌ Invalid user ID.')

    const record = await getUserRecord(targetId)
    await banUser(targetId, getAdminId(), { username: record?.username, firstName: record?.firstName })
    await logAudit({ action: 'ban', adminId: getAdminId(), targetId, targetUsername: record?.username, timestamp: Date.now() })

    await notifyUser(bot, targetId, `🚫 You have been <b>banned</b> from this bot.`)
    return ctx.reply(`🚫 User <code>${targetId}</code> banned permanently.`, { parse_mode: 'HTML' })
  })

  adminCommand(bot, 'unban', async (ctx) => {
    const arg = ctx.match.trim()
    if (!arg) return ctx.reply('Usage: /unban <user_id>')

    const targetId = Number(arg)
    if (Number.isNaN(targetId)) return ctx.reply('❌ Invalid user ID.')

    await unbanUser(targetId)
    await logAudit({ action: 'unban', adminId: getAdminId(), targetId, timestamp: Date.now() })

    return ctx.reply(`✅ User <code>${targetId}</code> unbanned. They can request access again.`, { parse_mode: 'HTML' })
  })

  adminCommand(bot, 'logs', async (ctx) => {
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

  adminCommand(bot, 'broadcast', async (ctx) => {
    const message = ctx.match.trim()
    if (!message) return ctx.reply('Usage: /broadcast <message>')

    const users = await getApprovedUsers()
    if (users.length === 0) return ctx.reply('No approved users to broadcast to.')

    const msg = await ctx.reply(`📡 Broadcasting to ${users.length} users...`)
    let success = 0
    let failed = 0
    const sanitized = escapeHTML(message).replace(/\*(.+?)\*/g, '<b>$1</b>')

    for (const user of users) {
      try {
        await bot.api.sendMessage(user.userId, `📢 <b>Broadcast:</b>\n\n${sanitized}`, { parse_mode: 'HTML' })
        success++
      } catch {
        failed++
      }
      // Telegram allows ~30 msgs/sec overall — an unpaced loop 429'd and
      // silently dropped most of the broadcast.
      await sleep(40)
    }

    await ctx.api.editMessageText(ctx.chat.id, msg.message_id,
      `📡 <b>Broadcast complete</b>\n\n✅ Sent: ${success}\n❌ Failed: ${failed}`,
      { parse_mode: 'HTML' }
    )
  })

  adminCommand(bot, 'stats', async (ctx) => {
    const msg = await ctx.reply('📊 Fetching stats...')
    try {
      const { totalUsers, totalMessages, topUsers } = await getStats()
      const topList = topUsers.map((u, i) => `${i + 1}. ${escapeHTML(u.tag)} — ${u.count} msgs`).join('\n')
      await ctx.api.editMessageText(ctx.chat.id, msg.message_id,
        `📊 <b>Bot Stats</b>\n\n👥 Total Users: <b>${totalUsers}</b>\n💬 Total Messages: <b>${totalMessages}</b>\n\n<b>🏆 Top 5 Users:</b>\n${topList}`,
        { parse_mode: 'HTML' }
      )
    } catch (err) {
      await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed: ${errMsg(err)}`, { parse_mode: 'HTML' })
    }
  })

  adminCommand(bot, 'maintenance', async (ctx) => {
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
}
