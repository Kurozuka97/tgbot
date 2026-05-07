import { webhookCallback } from 'grammy'
import bot from '@/lib/bot'

export const maxDuration = 10

export async function POST(req: Request) {
  const secret = req.headers.get('x-telegram-bot-api-secret-token')

  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401 })
  }

  return webhookCallback(bot, 'std/http')(req)
}
