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

// ─── Allowed Users ───────────────────────────────────────────────────────────

export async function getAllowedUsers(): Promise<number[]> {
  const doc = await db.collection('config').doc('allowed_users').get()
  if (!doc.exists) return []
  return (doc.data()?.ids as number[]) ?? []
}

export async function addAllowedUser(userId: number): Promise<void> {
  const ref = db.collection('config').doc('allowed_users')
  await ref.set({ ids: admin.firestore.FieldValue.arrayUnion(userId) }, { merge: true })
}

export async function removeAllowedUser(userId: number): Promise<void> {
  const ref = db.collection('config').doc('allowed_users')
  await ref.set({ ids: admin.firestore.FieldValue.arrayRemove(userId) }, { merge: true })
}

export async function isUserAllowed(userId: number): Promise<boolean> {
  const allowed = await getAllowedUsers()
  return allowed.includes(userId)
}

// ─── Pending Users ────────────────────────────────────────────────────────────

export interface PendingUser {
  userId: number
  username?: string
  firstName?: string
  requestedAt: number
}

export async function addPendingUser(user: PendingUser): Promise<void> {
  await db.collection('pending_users').doc(String(user.userId)).set(user)
}

export async function removePendingUser(userId: number): Promise<void> {
  await db.collection('pending_users').doc(String(userId)).delete()
}

export async function getPendingUsers(): Promise<PendingUser[]> {
  const snap = await db.collection('pending_users').orderBy('requestedAt').get()
  return snap.docs.map(d => d.data() as PendingUser)
}
