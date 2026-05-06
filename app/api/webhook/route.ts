import { webhookCallback } from 'grammy'
import bot from '@/lib/bot'

export const maxDuration = 60

export const POST = webhookCallback(bot, 'std/http')
