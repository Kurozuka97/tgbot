import admin from 'firebase-admin'

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
    })
  })
}

export const db = admin.firestore()

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UserRecord {
  userId: number
  username?: string
  firstName?: string
  status: 'approved' | 'banned'
  approvedAt?: number
  approvedBy?: number
  bannedAt?: number
  bannedBy?: number
  messageCount: number
  lastActive?: number
  firstActiveAt?: number
  languageCode?: string
}

export interface PendingUser {
  userId: number
  username?: string
  firstName?: string
  languageCode?: string
  requestedAt: number
  lastRequestedAt: number
  requestCount: number
}

export type AuditAction =
  | 'approve'
  | 'reject'
  | 'ban'
  | 'unban'
  | 'revoke'

export interface AuditEntry {
  action: AuditAction
  adminId: number
  targetId: number
  targetUsername?: string
  timestamp: number
}

// ─── Allowed Users (fast lookup) ─────────────────────────────────────────────

export async function getAllowedUserIds(): Promise<number[]> {
  const doc = await db.collection('config').doc('allowed_users').get()
  if (!doc.exists) return []
  return (doc.data()?.ids as number[]) ?? []
}

export async function isUserAllowed(userId: number): Promise<boolean> {
  const ids = await getAllowedUserIds()
  return ids.includes(userId)
}

async function addToAllowedList(userId: number) {
  await db.collection('config').doc('allowed_users').set(
    { ids: admin.firestore.FieldValue.arrayUnion(userId) },
    { merge: true }
  )
}

async function removeFromAllowedList(userId: number) {
  await db.collection('config').doc('allowed_users').set(
    { ids: admin.firestore.FieldValue.arrayRemove(userId) },
    { merge: true }
  )
}

// ─── User Registry ────────────────────────────────────────────────────────────

export async function getApprovedUsers(): Promise<UserRecord[]> {
  const snap = await db.collection('users')
    .where('status', '==', 'approved')
    .orderBy('approvedAt', 'desc')
    .get()
  return snap.docs.map(d => d.data() as UserRecord)
}

export async function getUserRecord(userId: number): Promise<UserRecord | null> {
  const doc = await db.collection('users').doc(String(userId)).get()
  return doc.exists ? (doc.data() as UserRecord) : null
}

export async function approveUser(
  userId: number,
  adminId: number,
  info: { username?: string; firstName?: string; languageCode?: string }
): Promise<void> {
  const now = Date.now()
  await db.collection('users').doc(String(userId)).set({
    userId,
    username: info.username ?? null,
    firstName: info.firstName ?? null,
    languageCode: info.languageCode ?? null,
    status: 'approved',
    approvedAt: now,
    approvedBy: adminId,
    messageCount: 0,
    lastActive: null,
    firstActiveAt: null
  }, { merge: true })

  await addToAllowedList(userId)
}

export async function revokeUser(userId: number, adminId: number): Promise<void> {
  await db.collection('users').doc(String(userId)).set(
    { status: 'revoked', revokedAt: Date.now(), revokedBy: adminId },
    { merge: true }
  )
  await removeFromAllowedList(userId)
}

// ─── Ban System ───────────────────────────────────────────────────────────────

export async function banUser(
  userId: number,
  adminId: number,
  info: { username?: string; firstName?: string }
): Promise<void> {
  const now = Date.now()
  await db.collection('users').doc(String(userId)).set({
    userId,
    username: info.username ?? null,
    firstName: info.firstName ?? null,
    status: 'banned',
    bannedAt: now,
    bannedBy: adminId,
    messageCount: 0
  }, { merge: true })

  await db.collection('config').doc('banned_users').set(
    { ids: admin.firestore.FieldValue.arrayUnion(userId) },
    { merge: true }
  )
  await removeFromAllowedList(userId)
  await removePendingUser(userId)
}

export async function unbanUser(userId: number): Promise<void> {
  await db.collection('users').doc(String(userId)).set(
    { status: 'unbanned', unbannedAt: Date.now() },
    { merge: true }
  )
  await db.collection('config').doc('banned_users').set(
    { ids: admin.firestore.FieldValue.arrayRemove(userId) },
    { merge: true }
  )
}

export async function isUserBanned(userId: number): Promise<boolean> {
  const doc = await db.collection('config').doc('banned_users').get()
  if (!doc.exists) return false
  return ((doc.data()?.ids as number[]) ?? []).includes(userId)
}

// ─── Pending Users ────────────────────────────────────────────────────────────

const REQUEST_COOLDOWN_MS = 24 * 60 * 60 * 1000 // 24 hours

/** Returns false if user is on cooldown (spamming requests) */
export async function addPendingUser(user: {
  userId: number
  username?: string
  firstName?: string
  languageCode?: string
}): Promise<{ ok: boolean; cooldownMs?: number }> {
  const ref = db.collection('pending_users').doc(String(user.userId))
  const now = Date.now()

  try {
    let result: { ok: boolean; cooldownMs?: number } = { ok: true }
    await db.runTransaction(async (t) => {
      const doc = await t.get(ref)

      if (doc.exists) {
        const data = doc.data() as PendingUser
        const elapsed = now - data.lastRequestedAt
        if (elapsed < REQUEST_COOLDOWN_MS) {
          result = { ok: false, cooldownMs: REQUEST_COOLDOWN_MS - elapsed }
          return
        }
        t.update(ref, {
          lastRequestedAt: now,
          requestCount: admin.firestore.FieldValue.increment(1)
        })
      } else {
        t.set(ref, {
          ...user,
          username: user.username ?? null,
          firstName: user.firstName ?? null,
          languageCode: user.languageCode ?? null,
          requestedAt: now,
          lastRequestedAt: now,
          requestCount: 1
        })
      }
    })
    return result
  } catch {
    return { ok: false }
  }
}

export async function removePendingUser(userId: number): Promise<void> {
  await db.collection('pending_users').doc(String(userId)).delete()
}

export async function getPendingUsers(): Promise<PendingUser[]> {
  const snap = await db.collection('pending_users').orderBy('requestedAt').get()
  return snap.docs.map(d => d.data() as PendingUser)
}

// ─── Usage Tracking ───────────────────────────────────────────────────────────

export async function trackUsage(userId: number): Promise<boolean> {
  const ref = db.collection('users').doc(String(userId))
  const now = Date.now()

  try {
    let isFirstActive = false
    await db.runTransaction(async (t) => {
      const doc = await t.get(ref)
      if (!doc.exists) return

      const data = doc.data() as UserRecord
      isFirstActive = !data.firstActiveAt

      t.update(ref, {
        messageCount: admin.firestore.FieldValue.increment(1),
        lastActive: now,
        ...(isFirstActive ? { firstActiveAt: now } : {})
      })
    })
    return isFirstActive
  } catch {
    return false
  }
}

// ─── Maintenance Mode ─────────────────────────────────────────────────────────

export async function setMaintenance(enabled: boolean): Promise<void> {
  await db.collection('config').doc('maintenance').set({ enabled })
}

export async function isMaintenance(): Promise<boolean> {
  const doc = await db.collection('config').doc('maintenance').get()
  return doc.exists ? (doc.data()?.enabled ?? false) : false
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export async function getStats(): Promise<{ totalUsers: number; totalMessages: number; topUsers: { tag: string; count: number }[] }> {
  const users = await getApprovedUsers()
  const totalUsers = users.length
  const totalMessages = users.reduce((sum, u) => sum + (u.messageCount ?? 0), 0)
  const topUsers = users
    .sort((a, b) => (b.messageCount ?? 0) - (a.messageCount ?? 0))
    .slice(0, 5)
    .map(u => ({ tag: u.username ? `@${u.username}` : u.firstName ?? String(u.userId), count: u.messageCount ?? 0 }))
  return { totalUsers, totalMessages, topUsers }
}

// ─── Mood Log ─────────────────────────────────────────────────────────────────

export async function logMood(userId: number, mood: string): Promise<void> {
  await db.collection('mood_log').add({ userId, mood, timestamp: Date.now() })
}

export async function getMoodLog(userId: number, limit = 10): Promise<{ mood: string; timestamp: number }[]> {
  const snap = await db.collection('mood_log')
    .where('userId', '==', userId)
    .orderBy('timestamp', 'desc')
    .limit(limit)
    .get()
  return snap.docs.map(d => ({ mood: d.data().mood, timestamp: d.data().timestamp }))
}


export async function logAudit(entry: AuditEntry): Promise<void> {
  await db.collection('audit_logs').add({
    ...entry,
    timestamp: entry.timestamp ?? Date.now()
  })
}

export async function getRecentAuditLog(limit = 10): Promise<AuditEntry[]> {
  const snap = await db.collection('audit_logs')
    .orderBy('timestamp', 'desc')
    .limit(limit)
    .get()
  return snap.docs.map(d => d.data() as AuditEntry)
}
