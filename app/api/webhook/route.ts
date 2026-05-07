import { webhookCallback } from 'grammy'
import bot from '@/lib/bot'

export const maxDuration = 60

const processed = new Set<number>()

export async function POST(req: Request) {
  const secret = req.headers.get('x-telegram-bot-api-secret-token')

  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401 })
  }

  // Deduplicate — Telegram retries the same update_id on timeout
  const body = await req.json()
  const updateId: number = body?.update_id
  if (updateId && processed.has(updateId)) {
    return new Response('OK', { status: 200 })
  }
  if (updateId) {
    processed.add(updateId)
    // Keep set small — only last 100 update IDs
    if (processed.size > 100) {
      const first = processed.values().next().value
      processed.delete(first)
    }
  }

  return webhookCallback(bot, 'std/http')(new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: JSON.stringify(body)
  }))
}
