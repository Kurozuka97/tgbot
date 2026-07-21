
import { Bot, GrammyError } from 'grammy'

// Configurable constants
const LOSSLESS_EXT  = new Set(['flac','wav','aiff','aif','alac','ape','wv','tak','tta'])
const LOSSY_EXT     = new Set(['mp3','aac','ogg','opus','m4a','wma'])
const LOSSLESS_MIME = new Set([
  'audio/flac','audio/x-flac',
  'audio/wav','audio/x-wav',
  'audio/aiff','audio/x-aiff',
])

const FORMAT_TAG: Record<string, string> = {
  wav:  '#WAV #Lossless',
  aiff: '#AIFF #Lossless',
  aif:  '#AIFF #Lossless',
  alac: '#ALAC #Lossless',
  ape:  '#APE #Lossless',
  wv:   '#WavPack #Lossless',
  tak:  '#TAK #Lossless',
  tta:  '#TTA #Lossless',
}

const QUALITY_TAG_RE = /#(lossless|lossy|flac\d*|wav|aiff|alac|ape|wavpack|tak|tta|mp3|aac|ogg|opus|m4a|wma|\d+kbps?)\b/gi

const TG_MAX_DOWNLOAD = 20 * 1024 * 1024
const FETCH_TIMEOUT_MS = parseInt(process.env.LOSSLESS_FETCH_TIMEOUT ?? '8000', 10)
const BITDEPTH_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

// In-memory cache for bit depth results (prevents redundant API calls)
interface CacheEntry {
  bps: number | null
  timestamp: number
}
const bitDepthCache = new Map<string, CacheEntry>()

// Parse bit depth from filename — works for any file size, no API call needed.
// Handles common audiophile naming: [24-96]  [24-192]  24bit  24-bit  24/96
function parseFilenameBps(fileName: string | undefined): number | null {
  if (!fileName) return null
  const f = fileName.toLowerCase()
  const m = f.match(/\b(16|24|32)[- ]?bit\b/)
          || f.match(/\[(16|24|32)[_\-\s]?\d+\]/)
          || f.match(/\b(16|24|32)\/\d{2,3}\b/)
  return m ? parseInt(m[1], 10) : null
}

// Fetch first 64 bytes and parse STREAMINFO for bit depth.
// Only viable for files ≤ 20 MB — larger files fail at getFile stage.
//
// FLAC layout:
//   [0-3]  'fLaC' magic
//   [4]    metadata block header (bit7=last, bits6-0=type; 0=STREAMINFO)
//   [5-7]  block length (24-bit BE, always 34)
//   [8-41] STREAMINFO:
//            [18-21] packed: sample_rate(20b) | channels-1(3b) | bps-1(5b) | ...
//            bps-1 → bit0 of byte[20] (MSB) + bits7-4 of byte[21]
async function fetchFlacBitDepth(fileId: string): Promise<number | null> {
  // Check cache first
  const cached = bitDepthCache.get(fileId)
  if (cached && Date.now() - cached.timestamp < BITDEPTH_CACHE_TTL) {
    return cached.bps
  }

  try {
    const token = process.env.BOT_TOKEN
    if (!token) return null

    // Add timeout to prevent hanging
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    const infoRes = await fetch(
      `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`,
      { signal: controller.signal }
    )
    clearTimeout(timeoutId)

    const info = await infoRes.json() as {
      ok: boolean
      result?: { file_path?: string }
    }
    if (!info.ok || !info.result?.file_path) return null

    const fileUrl = `https://api.telegram.org/file/bot${token}/${info.result.file_path}`
    
    const fileController = new AbortController()
    const fileTimeoutId = setTimeout(() => fileController.abort(), FETCH_TIMEOUT_MS)
    
    const fileRes = await fetch(fileUrl, { 
      headers: { Range: 'bytes=0-63' },
      signal: fileController.signal 
    })
    clearTimeout(fileTimeoutId)
    
    const reader  = fileRes.body!.getReader()
    const { value: b } = await reader.read()
    await reader.cancel()

    if (!b || b.length < 22) return null
    if (b[0] !== 0x66 || b[1] !== 0x4C || b[2] !== 0x61 || b[3] !== 0x43) return null
    if ((b[4] & 0x7F) !== 0) return null

    const bpsMinusOne = ((b[20] & 0x01) << 4) | ((b[21] >> 4) & 0x0F)
    const bps = bpsMinusOne + 1
    
    // Cache the result
    bitDepthCache.set(fileId, { bps, timestamp: Date.now() })
    
    return bps
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.warn(`[lossless] fetchFlacBitDepth timeout for ${fileId}`)
    }
    return null
  }
}

function buildFlacTag(bps: number | null): string {
  if (bps === 16) return '#FLAC16 #Lossless'
  if (bps === 24) return '#FLAC24 #Lossless'
  if (bps != null) return `#FLAC${bps} #Lossless`
  return '#FLAC #Lossless'
}

async function resolveQuality(
  mimeType: string | undefined,
  fileName: string | undefined,
  fileId: string,
  fileSize: number | undefined,
): Promise<{ lossless: boolean | null; tag: string }> {
  const ext  = fileName?.split('.').pop()?.toLowerCase()
  const mime = mimeType?.toLowerCase()

  if ((ext && LOSSLESS_EXT.has(ext)) || (mime && LOSSLESS_MIME.has(mime))) {
    if (ext === 'flac' || mime === 'audio/flac' || mime === 'audio/x-flac') {
      // 1) Filename parse — zero cost, works regardless of file size
      const fnameBps = parseFilenameBps(fileName)
      if (fnameBps !== null) return { lossless: true, tag: buildFlacTag(fnameBps) }

      // 2) Header parse — only if Telegram can actually serve the file
      if (!fileSize || fileSize <= TG_MAX_DOWNLOAD) {
        const bps = await fetchFlacBitDepth(fileId)
        return { lossless: true, tag: buildFlacTag(bps) }
      }

      // 3) File too large and no bit depth in filename
      return { lossless: true, tag: '#FLAC #Lossless' }
    }
    return { lossless: true, tag: (ext && FORMAT_TAG[ext]) || '#Lossless' }
  }

  if (ext && LOSSY_EXT.has(ext)) {
    return { lossless: false, tag: '#Lossy' }
  }

  return { lossless: null, tag: '' }
}

function patchCaption(caption: string | undefined, tag: string): string {
  const stripped = (caption ?? '')
    .replace(QUALITY_TAG_RE, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return stripped ? `${stripped}\n\n${tag}` : tag
}

// Stagger concurrent edits using the last digit of message_id.
// Consecutive posts in a batch have consecutive IDs, so they naturally
// spread across time: id%10 × 1100ms → max ~9.9s spread for 10 messages.
// This prevents hitting the ~1 edit/sec per-chat rate limit in the first place.
function staggerDelay(messageId: number): number {
  return (messageId % 10) * 1100
}

// Retry on 429 up to 3 times as a safety net for any that still clash.
async function editWithRetry(
  api: Bot['api'],
  chatId: number,
  messageId: number,
  caption: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await api.editMessageCaption(chatId, messageId, { caption })
      return
    } catch (e) {
      if (e instanceof GrammyError && e.error_code === 429) {
        const wait = ((e.parameters as { retry_after?: number })?.retry_after ?? 5) * 1000 + 300
        await new Promise(r => setTimeout(r, wait))
        continue
      }
      console.error(`[lossless] edit failed for msg ${messageId}:`, e)
      return
    }
  }
  console.error(`[lossless] gave up on msg ${messageId} after retries`)
}

// Extract media from either a Message or ChannelPost
function extractMedia(ctx: any) {
  const msg = ctx.message || ctx.channelPost
  if (!msg) return null
  
  // Check for audio first (songs typically come as audio)
  if (msg.audio) return { media: msg.audio, msg }
  // Then check document (some users send audio as documents)
  if (msg.document) return { media: msg.document, msg }
  
  return null
}

export function registerLosslessHandler(bot: Bot): void {
  // Handle channel posts
  bot.on('channel_post', async (ctx) => {
    const msg = ctx.channelPost
    const media = msg.audio ?? msg.document
    if (!media) return

    await processMedia(ctx.api, msg.chat.id, msg.message_id, media, msg.caption)
  })

  // Handle regular messages (private chats, groups, supergroups)
  bot.on('message', async (ctx) => {
    const msg = ctx.message
    const media = msg.audio ?? msg.document
    if (!media) return

    await processMedia(ctx.api, msg.chat.id, msg.message_id, media, msg.caption)
  })
}

async function processMedia(
  api: Bot['api'],
  chatId: number,
  messageId: number,
  media: any,
  caption: string | undefined
): Promise<void> {
  const mimeType = 'mime_type' in media ? media.mime_type : undefined
  const fileName = 'file_name' in media ? media.file_name : undefined
  const fileId   = media.file_id
  const fileSize = 'file_size' in media ? media.file_size : undefined

  // Quick check for large FLAC files to avoid Vercel timeout on getFile/fetch
  const ext = fileName?.split('.').pop()?.toLowerCase()
  if ((ext === 'flac' || mimeType === 'audio/flac') && fileSize && fileSize > TG_MAX_DOWNLOAD) {
    const fnameBps = parseFilenameBps(fileName)
    if (fnameBps !== null) {
      const tag = buildFlacTag(fnameBps)
      const newCaption = patchCaption(caption, tag)
      if (newCaption !== (caption ?? '')) {
        await editWithRetry(api, chatId, messageId, newCaption)
      }
      return
    }
    // If no bit depth in filename and file is too large, skip header parsing
    // to ensure we at least tag it as generic lossless without timing out
    const tag = '#FLAC #Lossless'
    const newCaption = patchCaption(caption, tag)
    if (newCaption !== (caption ?? '')) {
      await editWithRetry(api, chatId, messageId, newCaption)
    }
    return
  }

  const { lossless, tag } = await resolveQuality(mimeType, fileName, fileId, fileSize)
  if (lossless === null) return

  const newCaption = patchCaption(caption, tag)
  if (newCaption === (caption ?? '')) return

  // Stagger first — spread concurrent edits to stay under rate limit
  const delay = staggerDelay(messageId)
  if (delay > 0) await new Promise(r => setTimeout(r, delay))

  await editWithRetry(api, chatId, messageId, newCaption)
}

// Periodic cache cleanup (remove expired entries every 10 minutes)
if (typeof global !== 'undefined' && !(global as any).__losslessCacheCleanup) {
  (global as any).__losslessCacheCleanup = true
  setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of bitDepthCache.entries()) {
      if (now - entry.timestamp > BITDEPTH_CACHE_TTL) {
        bitDepthCache.delete(key)
      }
    }
  }, 10 * 60 * 1000)
}
