import { webhookCallback } from 'grammy'
import bot from '@/lib/bot'

export const maxDuration = 60

// FIX: Time-expiring cache to prevent memory leak
const processed = new Map<number, number>()
const PROCESSED_TTL = 5 * 60 * 1000 // 5 minutes

function cleanupProcessed() {
  const now = Date.now()
  for (const [id, timestamp] of processed.entries()) {
    if (now - timestamp > PROCESSED_TTL) {
      processed.delete(id)
    }
  }
}

export async function POST(req: Request) {
  const secret = req.headers.get('x-telegram-bot-api-secret-token')
  
  // FIX: Validate env vars exist
  if (!process.env.WEBHOOK_SECRET) {
    console.error('WEBHOOK_SECRET not configured')
    return new Response('Server configuration error', { status: 500 })
  }
  
  if (secret !== process.env.WEBHOOK_SECRET) {
    console.warn(`Invalid webhook secret attempt: ${secret ? 'mismatch' : 'missing'}`)
    return new Response('Unauthorized', { status: 401 })
  }

  // Deduplicate — Telegram retries the same update_id on timeout
  const body = await req.json()
  const updateId: number = body?.update_id
  
  // Cleanup old entries periodically
  if (processed.size > 100 || Math.random() < 0.1) {
    cleanupProcessed()
  }
  
  if (updateId && processed.has(updateId)) {
    return new Response('OK', { status: 200 })
  }
  if (updateId) {
    processed.set(updateId, Date.now())
    // Keep map small — only last 100 update IDs
    if (processed.size > 100) {
      const firstKey = processed.keys().next().value!
      processed.delete(firstKey)
    }
  }

  return webhookCallback(bot, 'std/http')(new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: JSON.stringify(body)
  }))
}
