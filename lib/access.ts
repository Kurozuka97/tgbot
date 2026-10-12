// Access control: admin check, ban list, maintenance mode, whitelist.

import type { Context } from 'grammy'
import { isUserAllowed, isUserBanned, isMaintenance } from './firebase'

// Read ADMIN_ID at call time (not module load) so it works even if the module
// was imported before env was available, and treat a missing/invalid value as
// "no admin configured" instead of NaN.
export function getAdminId(): number {
  const id = Number(process.env.ADMIN_ID)
  return Number.isFinite(id) ? id : NaN
}

export function isAdmin(userId: number): boolean {
  const adminId = getAdminId()
  return Number.isFinite(adminId) && userId === adminId
}

export type AccessStatus = 'ok' | 'banned' | 'maintenance' | 'denied'

export async function checkAccess(userId: number): Promise<AccessStatus> {
  if (isAdmin(userId)) return 'ok'
  if (await isUserBanned(userId)) return 'banned'
  // Maintenance must be checked BEFORE the whitelist: otherwise every user
  // who messages during maintenance falls through into the access-request
  // flow and spams the admin with pending requests.
  if (await isMaintenance()) return 'maintenance'
  return (await isUserAllowed(userId)) ? 'ok' : 'denied'
}

export function accessMessage(status: AccessStatus): string | null {
  switch (status) {
    case 'banned': return '🚫 You have been banned from using this bot.'
    case 'maintenance': return '🔧 Under maintenance — please check back later.'
    case 'denied': return '⛔ Unauthorized. Send /start to request access.'
    default: return null
  }
}

// Gate a handler: returns the userId when access is OK, otherwise replies with
// the appropriate message and returns null.
export async function requireAccess(ctx: Context): Promise<number | null> {
  const userId = ctx.from?.id ?? 0
  const msg = accessMessage(await checkAccess(userId))
  if (msg) {
    await ctx.reply(msg).catch(() => {})
    return null
  }
  return userId
}
