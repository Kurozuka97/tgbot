// Per-user daily AI quota, stored in Firestore so it survives serverless
// cold starts and is shared across instances.

import { db } from './firebase'
import { isAdmin } from './access'

const DEFAULT_DAILY_LIMIT = 50

function dailyLimit(): number {
  const n = Number(process.env.DAILY_AI_LIMIT)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_LIMIT
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Atomically check + increment the user's AI quota for today.
 * Admins are exempt. Fails open on storage errors (better a loose limit than
 * a fully bricked bot) — errors are logged.
 */
export async function consumeAiQuota(userId: number): Promise<{ ok: boolean; limit: number }> {
  const limit = dailyLimit()
  if (isAdmin(userId)) return { ok: true, limit }
  if (!db) return { ok: true, limit }

  const ref = db.collection('usage_quotas').doc(String(userId))
  const day = today()
  try {
    let ok = true
    await db.runTransaction(async (t) => {
      const snap = await t.get(ref)
      const data = snap.exists ? snap.data() : null
      const count = data && data.day === day ? (data.count ?? 0) : 0
      if (count >= limit) {
        ok = false
        return
      }
      t.set(ref, { day, count: count + 1 }, { merge: true })
    })
    return { ok, limit }
  } catch (error) {
    console.error('[ratelimit] quota check failed:', error)
    return { ok: true, limit }
  }
}

// Gate an AI-consuming handler. Replies with the limit message and returns
// null when the user is out of quota (admin is exempt inside consumeAiQuota).
export async function requireAiQuota(ctx: { reply: (text: string) => Promise<unknown> }, userId: number): Promise<boolean> {
  const { ok, limit } = await consumeAiQuota(userId)
  if (!ok) {
    await ctx.reply(`⛔ Daily AI limit reached (${limit}/day). Try again after midnight UTC.`).catch(() => {})
    return false
  }
  return true
}
