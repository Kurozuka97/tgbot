import admin from 'firebase-admin'

// FIX: Safe Firebase initialization with proper error handling
let initialized = false

export function initializeFirebase() {
  if (initialized) return true
  
  // Validate required env vars
  const requiredEnvVars = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY']
  const missing = requiredEnvVars.filter(key => !process.env[key])
  
  if (missing.length > 0) {
    console.error(`Missing Firebase env vars: ${missing.join(', ')}`)
    return false
  }
  
  try {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
        })
      })
    }
    initialized = true
    return true
  } catch (error) {
    console.error('Firebase initialization failed:', error)
    return false
  }
}

// Initialize on module load but don't fail silently
const firebaseReady = initializeFirebase()

export const db = firebaseReady ? admin.firestore() : null

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UserRecord {
  userId: number
  username?: string
  firstName?: string
  status: 'approved' | 'banned' | 'revoked' | 'unbanned'
  approvedAt?: number
  approvedBy?: number
  bannedAt?: number
  bannedBy?: number
  revokedAt?: number
  revokedBy?: number
  unbannedAt?: number
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
  if (!db) return []
  try {
    const doc = await db.collection('config').doc('allowed_users').get()
    if (!doc.exists) return []
    return (doc.data()?.ids as number[]) ?? []
  } catch (error) {
    console.error('Error getting allowed user IDs:', error)
    return []
  }
}

export async function isUserAllowed(userId: number): Promise<boolean> {
  if (!db) return false
  try {
    const ids = await getAllowedUserIds()
    return ids.includes(userId)
  } catch (error) {
    console.error('Error checking user allowance:', error)
    return false
  }
}

// ─── User Registry ────────────────────────────────────────────────────────────

export async function getApprovedUsers(): Promise<UserRecord[]> {
  if (!db) return []
  try {
    const snap = await db.collection('users')
      .where('status', '==', 'approved')
      .orderBy('approvedAt', 'desc')
      .get()
    return snap.docs.map(d => d.data() as UserRecord)
  } catch (error) {
    console.error('Error getting approved users:', error)
    return []
  }
}

export async function getUserRecord(userId: number): Promise<UserRecord | null> {
  if (!db) return null
  try {
    const doc = await db.collection('users').doc(String(userId)).get()
    return doc.exists ? (doc.data() as UserRecord) : null
  } catch (error) {
    console.error('Error getting user record:', error)
    return null
  }
}

export async function approveUser(
  userId: number,
  adminId: number,
  info: { username?: string; firstName?: string; languageCode?: string }
): Promise<void> {
  if (!db) throw new Error('Firebase not initialized')
  const now = Date.now()
  const userUpdate: Record<string, any> = {
    userId,
    status: 'approved',
    approvedAt: now,
    approvedBy: adminId
  }
  if (info.username) userUpdate.username = info.username
  if (info.firstName) userUpdate.firstName = info.firstName
  if (info.languageCode) userUpdate.languageCode = info.languageCode

  const batch = db.batch()
  batch.set(db.collection('users').doc(String(userId)), userUpdate, { merge: true })
  batch.set(db.collection('config').doc('allowed_users'), {
    ids: admin.firestore.FieldValue.arrayUnion(userId)
  }, { merge: true })
  await batch.commit()
}

export async function revokeUser(userId: number, adminId: number): Promise<void> {
  if (!db) throw new Error('Firebase not initialized')
  const batch = db.batch()
  batch.set(db.collection('users').doc(String(userId)), {
    status: 'revoked', revokedAt: Date.now(), revokedBy: adminId
  }, { merge: true })
  batch.set(db.collection('config').doc('allowed_users'), {
    ids: admin.firestore.FieldValue.arrayRemove(userId)
  }, { merge: true })
  await batch.commit()
}

// ─── Ban System ───────────────────────────────────────────────────────────────

export async function banUser(
  userId: number,
  adminId: number,
  info: { username?: string; firstName?: string }
): Promise<void> {
  if (!db) throw new Error('Firebase not initialized')
  const now = Date.now()
  const userUpdate: Record<string, any> = {
    userId,
    status: 'banned',
    bannedAt: now,
    bannedBy: adminId
  }
  if (info.username) userUpdate.username = info.username
  if (info.firstName) userUpdate.firstName = info.firstName

  const batch = db.batch()
  batch.set(db.collection('users').doc(String(userId)), userUpdate, { merge: true })
  batch.set(db.collection('config').doc('banned_users'), {
    ids: admin.firestore.FieldValue.arrayUnion(userId)
  }, { merge: true })
  batch.set(db.collection('config').doc('allowed_users'), {
    ids: admin.firestore.FieldValue.arrayRemove(userId)
  }, { merge: true })
  batch.delete(db.collection('pending_users').doc(String(userId)))
  await batch.commit()
}

export async function unbanUser(userId: number): Promise<void> {
  if (!db) throw new Error('Firebase not initialized')
  const batch = db.batch()
  batch.set(db.collection('users').doc(String(userId)), {
    status: 'unbanned', unbannedAt: Date.now()
  }, { merge: true })
  batch.set(db.collection('config').doc('banned_users'), {
    ids: admin.firestore.FieldValue.arrayRemove(userId)
  }, { merge: true })
  await batch.commit()
}

export async function isUserBanned(userId: number): Promise<boolean> {
  if (!db) return false
  try {
    const doc = await db.collection('config').doc('banned_users').get()
    if (!doc.exists) return false
    return ((doc.data()?.ids as number[]) ?? []).includes(userId)
  } catch (error) {
    console.error('Error checking ban status:', error)
    return false
  }
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
  if (!db) return { ok: false }
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
  } catch (error) {
    console.error('Error adding pending user:', error)
    return { ok: false }
  }
}

export async function removePendingUser(userId: number): Promise<void> {
  if (!db) return
  await db.collection('pending_users').doc(String(userId)).delete()
}

export async function getPendingUsers(): Promise<PendingUser[]> {
  if (!db) return []
  try {
    const snap = await db.collection('pending_users').orderBy('requestedAt').get()
    return snap.docs.map(d => d.data() as PendingUser)
  } catch (error) {
    console.error('Error getting pending users:', error)
    return []
  }
}

// ─── Usage Tracking ───────────────────────────────────────────────────────────

export async function trackUsage(userId: number): Promise<boolean> {
  if (!db) return false
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
  } catch (error) {
    console.error('Error tracking usage:', error)
    return false
  }
}

// ─── Maintenance Mode ─────────────────────────────────────────────────────────

export async function setMaintenance(enabled: boolean): Promise<void> {
  if (!db) throw new Error('Firebase not initialized')
  await db.collection('config').doc('maintenance').set({ enabled })
}

export async function isMaintenance(): Promise<boolean> {
  if (!db) return false
  try {
    const doc = await db.collection('config').doc('maintenance').get()
    return doc.exists ? (doc.data()?.enabled ?? false) : false
  } catch (error) {
    console.error('Error checking maintenance mode:', error)
    return false
  }
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export async function getStats(): Promise<{ totalUsers: number; totalMessages: number; topUsers: { tag: string; count: number }[] }> {
  if (!db) return { totalUsers: 0, totalMessages: 0, topUsers: [] }
  try {
    const users = await getApprovedUsers()
    const totalUsers = users.length
    const totalMessages = users.reduce((sum, u) => sum + (u.messageCount ?? 0), 0)
    const topUsers = users
      .sort((a, b) => (b.messageCount ?? 0) - (a.messageCount ?? 0))
      .slice(0, 5)
      .map(u => ({ tag: u.username ? `@${u.username}` : u.firstName ?? String(u.userId), count: u.messageCount ?? 0 }))
    return { totalUsers, totalMessages, topUsers }
  } catch (error) {
    console.error('Error getting stats:', error)
    return { totalUsers: 0, totalMessages: 0, topUsers: [] }
  }
}

// ─── Mood Log ─────────────────────────────────────────────────────────────────

export async function logMood(userId: number, mood: string): Promise<void> {
  if (!db) return
  await db.collection('mood_log').add({ userId, mood, timestamp: Date.now() })
}

export async function getMoodLog(userId: number, limit = 10): Promise<{ mood: string; timestamp: number }[]> {
  if (!db) return []
  try {
    const snap = await db.collection('mood_log')
      .where('userId', '==', userId)
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get()
    return snap.docs.map(d => ({ mood: d.data().mood, timestamp: d.data().timestamp }))
  } catch (error) {
    console.error('Error getting mood log:', error)
    return []
  }
}


export async function logAudit(entry: AuditEntry): Promise<void> {
  if (!db) return
  await db.collection('audit_logs').add({
    ...entry,
    timestamp: entry.timestamp ?? Date.now()
  })
}

export async function getRecentAuditLog(limit = 10): Promise<AuditEntry[]> {
  if (!db) return []
  try {
    const snap = await db.collection('audit_logs')
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get()
    return snap.docs.map(d => d.data() as AuditEntry)
  } catch (error) {
    console.error('Error getting audit logs:', error)
    return []
  }
}
