import { webhookCallback } from 'grammy'
import { timingSafeEqual } from 'crypto'
import { getBot } from '@/lib/bot'

export const maxDuration = 60
// firebase-admin + Buffer require the Node runtime (not Edge).
export const runtime = 'nodejs'

// Best-effort dedupe: Telegram retries the same update_id when we time out.
// NOTE: this Map is per serverless instance — it is a safety net, not a
// distributed lock. Entries are recorded only AFTER successful handling so a
// failed update stays retryable instead of being swallowed.
const processed = new Map<number, number>()
const PROCESSED_TTL = 5 * 60 * 1000 // 5 minutes

// Memoized webhook adapter (constructed once per warm instance, not per request).
let webhookHandler: ((req: Request) => Promise<Response>) | null = null

function cleanupProcessed() {
  const now = Date.now()
  for (const [id, timestamp] of processed.entries()) {
    if (now - timestamp > PROCESSED_TTL) {
      processed.delete(id)
    }
  }
}

// Constant-time comparison — a plain === on the secret leaks timing info.
function secretMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function POST(req: Request) {
  const secret = req.headers.get('x-telegram-bot-api-secret-token')

  if (!process.env.WEBHOOK_SECRET) {
    console.error('[webhook] WEBHOOK_SECRET not configured')
    return new Response('Server configuration error', { status: 500 })
  }

  if (!secretMatches(secret, process.env.WEBHOOK_SECRET)) {
    console.warn(`[webhook] invalid secret attempt: ${secret ? 'mismatch' : 'missing'}`)
    return new Response('Unauthorized', { status: 401 })
  }

  const body = await req.json()
  const updateId: number | undefined = body?.update_id

  // Cleanup old entries periodically
  if (processed.size > 100 || Math.random() < 0.1) {
    cleanupProcessed()
  }

  if (updateId && processed.has(updateId)) {
    return new Response('OK', { status: 200 })
  }

  if (!webhookHandler) {
    try {
      webhookHandler = webhookCallback(getBot(), 'std/http')
    } catch (err) {
      // Missing BOT_TOKEN etc. — fail loudly instead of 500-ing obscurely.
      console.error('[webhook] failed to initialize bot:', err)
      return new Response('Server configuration error', { status: 500 })
    }
  }

  const res = await webhookHandler(new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: JSON.stringify(body)
  }))

  // Record the update only after it was handled successfully — Telegram will
  // retry non-2xx responses, and the dedupe map must not eat that retry.
  if (res.ok && updateId) {
    processed.set(updateId, Date.now())
    // Keep map small — only last 100 update IDs
    if (processed.size > 100) {
      const firstKey = processed.keys().next().value!
      processed.delete(firstKey)
    }
  }

  return res
}
