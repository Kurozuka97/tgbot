import { Bot, GrammyError } from 'grammy'

// Exactly the fields this handler uses, shared by grammY's Audio and Document
// message types (grammy doesn't export those types at its root — same reason
// we avoid importing `Chat` elsewhere).
interface LosslessMedia {
  file_id: string
  mime_type?: string
  file_name?: string
  file_size?: number
}

// Configurable constants
const LOSSLESS_EXT  = new Set(['flac','wav','aiff','aif','alac','ape','wv','tak','tta'])
const LOSSY_EXT     = new Set(['mp3','aac','ogg','opus','m4a','wma'])
const LOSSLESS_MIME = new Set([
  'audio/flac','audio/x-flac',
  'audio/wav','audio/x-wav',
  'audio/aiff','audio/x-aiff',
  'audio/alac','audio/x-alac',
])

// ALAC-in-container heuristic: real ALAC lives in .m4a/.mp4/.caf with mime
// audio/mp4 (which looks lossy by extension). Detect via "alac" in the
// filename — common audiophile naming. Deep container inspection (ftyp/moov
// atoms) is out of scope; false negatives just get the usual "#Lossy" tag.
const ALAC_EXT = new Set(['m4a','mp4','caf'])
const ALAC_NAME_RE = /alac/i

const FORMAT_TAG: Record<string, string> = {
  ape:  '#APE',
  wv:   '#WavPack',
  tak:  '#TAK',
  tta:  '#TTA',
}

// Strips previous quality tags so re-tagging is idempotent. Includes the
// #96kHz-style sample-rate tags we now generate (a missed variant would
// accumulate on every reprocess).
const QUALITY_TAG_RE = /#(lossless|lossy|flac\d*|wav\d*|aiff\d*|alac\d*|ape\d*|wavpack\d*|tak\d*|tta\d*|wv\d*|mp3|aac|ogg|opus|m4a|wma|\d+(?:\.\d+)?k?hz|\d+kbps?)\b/gi

const TG_MAX_DOWNLOAD = 20 * 1024 * 1024
const TG_CAPTION_LIMIT = 1024
const HEADER_BYTES = 512
const DEFAULT_FETCH_TIMEOUT_MS = 8000

// Parse garbage-tolerant: `?? '8000'` only covers unset, not invalid — a
// non-numeric value would make setTimeout fire immediately (NaN delay) and
// every header fetch would abort.
function parseTimeoutEnv(): number {
  const raw = parseInt(process.env.LOSSLESS_FETCH_TIMEOUT ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FETCH_TIMEOUT_MS
}
const FETCH_TIMEOUT_MS = parseTimeoutEnv()

const HEADER_CACHE_TTL = 5 * 60 * 1000
const NEGATIVE_CACHE_TTL = 60 * 1000

interface AudioHeader {
  bps: number | null
  rateHz: number | null
}

interface CacheEntry {
  header: AudioHeader | null
  timestamp: number
}
const headerCache = new Map<string, CacheEntry>()

// Parse bit depth from filename — works for any file size, no API call needed.
// Handles common audiophile naming: [24-96]  (24-192)  24bit  24-bit  24/96
function parseFilenameBps(fileName: string | undefined): number | null {
  if (!fileName) return null
  const f = fileName.toLowerCase()
  const m = f.match(/\b(16|24|32)[- ]?bit\b/)
          || f.match(/[([](16|24|32)[_\-\s]?\d+(?:\.1)?[)\]]/)
          || f.match(/\b(16|24|32)\/\d{2,3}\b/)
  return m ? parseInt(m[1], 10) : null
}

// Recover quality from a caption written by a previous run of this handler
// (cheaper than re-fetching headers, and the only source for >20MB re-edits).
function parseCaptionQuality(caption: string | undefined): { bps: number | null; rateHz: number | null } {
  if (!caption) return { bps: null, rateHz: null }
  const bpsM = caption.match(/#(?:flac|wav|aiff|alac|ape|wv|tak|tta)(\d{2})\b/i)
  const rateM = caption.match(/#(\d+(?:\.\d+)?)(k?)hz\b/i)
  return {
    bps: bpsM ? parseInt(bpsM[1], 10) : null,
    rateHz: rateM ? Math.round(parseFloat(rateM[1]) * (rateM[2] ? 1000 : 1)) : null,
  }
}

function buildTag(format: string, bps: number | null, rateHz: number | null): string {
  const parts = [`#${format}${bps !== null ? bps : ''}`]
  if (rateHz !== null) {
    // 96000 → #96kHz, 44100/88200 → #44.1kHz/#88.2kHz (the standard
    // audiophile spellings), anything odd → raw Hz.
    if (rateHz >= 1000 && rateHz % 1000 === 0) parts.push(`#${rateHz / 1000}kHz`)
    else if (rateHz >= 1000 && rateHz % 100 === 0) parts.push(`#${(rateHz / 1000).toFixed(1)}kHz`)
    else parts.push(`#${rateHz}Hz`)
  }
  parts.push('#Lossless')
  return parts.join(' ')
}

// --- Header parsers (pure, offline-testable) --------------------------------

// FLAC layout:
//   [0-3]  'fLaC' magic
//   [4]    metadata block header (bit7=last, bits6-0=type; 0=STREAMINFO)
//   [5-7]  block length (24-bit BE, always 34)
//   [8-41] STREAMINFO:
//            [18-21] packed: sample_rate(20b) | channels-1(3b) | bps-1(5b) | ...
function parseFlacHeader(b: Uint8Array): AudioHeader | null {
  if (b.length < 22) return null
  if (b[0] !== 0x66 || b[1] !== 0x4C || b[2] !== 0x61 || b[3] !== 0x43) return null
  if ((b[4] & 0x7F) !== 0) return null // first block must be STREAMINFO
  const rateHz = ((b[18] << 12) | (b[19] << 4) | (b[20] >> 4)) || null
  const bps = (((b[20] & 0x01) << 4) | ((b[21] >> 4) & 0x0F)) + 1
  return { bps, rateHz }
}

// RIFF/WAVE: 'RIFF'[4] size[4] 'WAVE'[4] then chunks: id[4] size[4] data.
// Standard files have 'fmt ' at offset 12; some put JUNK/LIST first, so walk.
// fmt data: format(2) channels(2) sampleRate(4) byteRate(4) blockAlign(2) bits(2)
function parseRiffWave(b: Uint8Array): AudioHeader | null {
  if (b.length < 12) return null
  if (b[8] !== 0x57 || b[9] !== 0x41 || b[10] !== 0x56 || b[11] !== 0x45) return null // 'WAVE'
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let off = 12
  while (off + 8 <= b.length) {
    const id = String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3])
    const size = view.getUint32(off + 4, true)
    if (id === 'fmt ') {
      if (off + 8 + 16 > b.length) return null
      const rateHz = view.getUint32(off + 8 + 4, true) || null
      const bps = view.getUint16(off + 8 + 14, true) || null
      return { bps, rateHz }
    }
    off += 8 + size + (size % 2) // chunks are word-aligned
  }
  return null
}

// AIFF: 'FORM'[4] size[4] 'AIFF'|'AIFC'[4] then big-endian chunks.
// COMM data: channels(2) frames(4) sampleSize(2) sampleRate(10, 80-bit
// extended — skipped, not worth the parser).
function parseAiffHeader(b: Uint8Array): AudioHeader | null {
  if (b.length < 12) return null
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let off = 12
  while (off + 8 <= b.length) {
    const id = String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3])
    const size = view.getUint32(off + 4, false)
    if (id === 'COMM') {
      if (off + 8 + 8 > b.length) return null
      const bps = view.getUint16(off + 8 + 6, false) || null
      return { bps, rateHz: null }
    }
    off += 8 + size + (size % 2)
  }
  return null
}

function parseAudioHeader(b: Uint8Array): AudioHeader | null {
  if (b.length >= 4 && b[0] === 0x66 && b[1] === 0x4C && b[2] === 0x61 && b[3] === 0x43) {
    return parseFlacHeader(b)
  }
  if (b.length >= 4 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) {
    return parseRiffWave(b)
  }
  if (b.length >= 4 && b[0] === 0x46 && b[1] === 0x4F && b[2] === 0x52 && b[3] === 0x4D) {
    return parseAiffHeader(b)
  }
  return null
}

// --- Network fetch ----------------------------------------------------------

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeoutId)
  }
}

function concatChunks(chunks: Uint8Array[], limit: number): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(Math.min(limit, total))
  let o = 0
  for (const c of chunks) {
    const take = Math.min(c.length, out.length - o)
    out.set(c.subarray(0, take), o)
    o += take
    if (o >= out.length) break
  }
  return out
}

// Fetch the first 512 bytes (Range request) and parse the audio header.
// Only viable for files ≤ 20 MB — larger files fail at the download URL.
async function fetchAudioHeader(fileId: string): Promise<AudioHeader | null> {
  cleanupHeaderCache()
  const cached = headerCache.get(fileId)
  if (cached && Date.now() - cached.timestamp < HEADER_CACHE_TTL) {
    return cached.header
  }

  let header: AudioHeader | null = null
  try {
    const token = process.env.BOT_TOKEN
    if (!token) return null

    const infoRes = await fetchWithTimeout(
      `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
      {},
      FETCH_TIMEOUT_MS,
    )
    const info = await infoRes.json() as {
      ok: boolean
      result?: { file_path?: string }
    }
    if (!info.ok || !info.result?.file_path) return null

    const fileUrl = `https://api.telegram.org/file/bot${token}/${info.result.file_path}`
    const fileRes = await fetchWithTimeout(
      fileUrl,
      { headers: { Range: `bytes=0-${HEADER_BYTES - 1}` } },
      FETCH_TIMEOUT_MS,
    )
    if (!fileRes.ok || !fileRes.body) return null

    const reader = fileRes.body.getReader()
    const chunks: Uint8Array[] = []
    try {
      let total = 0
      while (total < HEADER_BYTES) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          chunks.push(value)
          total += value.length
        }
      }
    } finally {
      await reader.cancel()
    }

    header = parseAudioHeader(concatChunks(chunks, HEADER_BYTES))
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.warn(`[lossless] header fetch timeout for ${fileId}`)
    } else {
      console.warn(`[lossless] header fetch failed for ${fileId}:`, error)
    }
    return null
  }

  // Cache positive results at full TTL; negative for a minute so a transient
  // failure doesn't re-hit the API on every reprocess of the same file.
  headerCache.set(fileId, {
    header,
    timestamp: Date.now(),
  })
  return header
}

function patchCaption(caption: string | undefined, tag: string): string {
  const stripped = (caption ?? '')
    .replace(QUALITY_TAG_RE, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!stripped) return tag
  let result = `${stripped}\n\n${tag}`
  // Telegram rejects captions > 1024 chars (400 "caption is too long") — the
  // edit would fail and the file would never get tagged at all.
  if (result.length > TG_CAPTION_LIMIT) {
    const maxCut = TG_CAPTION_LIMIT - tag.length - 3 // '…\n\n'
    let cut = stripped.slice(0, Math.max(0, maxCut))
    const lastSpace = cut.lastIndexOf(' ')
    if (lastSpace > maxCut * 0.7) cut = cut.slice(0, lastSpace)
    result = `${cut.trimEnd()}…\n\n${tag}`
  }
  return result
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

// Does this document/audio actually look like an audio file we'd tag?
// (as opposed to, say, a PDF sent as a document, which should fall through
// to the AI file-reading handler instead of being swallowed here.)
function looksLikeAudio(media: LosslessMedia): boolean {
  const mimeType: string | undefined = 'mime_type' in media ? media.mime_type : undefined
  const fileName: string | undefined = 'file_name' in media ? media.file_name : undefined
  const ext = fileName?.split('.').pop()?.toLowerCase()
  if (mimeType?.toLowerCase().startsWith('audio/')) return true
  // .m4a is usually lossy audio, but plain .mp4 must NOT match — that would
  // swallow video documents before the AI handler sees them. Only pull in
  // container formats when the ALAC-name heuristic fires.
  if (ext && (LOSSLESS_EXT.has(ext) || LOSSY_EXT.has(ext))) return true
  if (ext && isAlacByHeuristic(ext, fileName)) return true
  return false
}

function isAlacByHeuristic(ext: string | undefined, fileName: string | undefined): boolean {
  if (!ext || !ALAC_EXT.has(ext)) return false
  return ALAC_NAME_RE.test(fileName ?? '')
}

// Resolve the quality tag for a media item, or null when it isn't audio we
// tag (PDFs etc. → caller should fall through to the AI handlers).
async function resolveTag(
  mimeType: string | undefined,
  fileName: string | undefined,
  fileId: string,
  fileSize: number | undefined,
  caption: string | undefined,
): Promise<string | null> {
  const ext  = fileName?.split('.').pop()?.toLowerCase()
  const mime = mimeType?.toLowerCase()

  const isFlac = ext === 'flac' || mime === 'audio/flac' || mime === 'audio/x-flac'
  const isWav  = ext === 'wav'  || mime === 'audio/wav'  || mime === 'audio/x-wav'
  const isAiff = ext === 'aiff' || ext === 'aif' || mime === 'audio/aiff' || mime === 'audio/x-aiff'
  const isAlac = ext === 'alac' || mime === 'audio/alac' || mime === 'audio/x-alac'
              || isAlacByHeuristic(ext, fileName)

  if (isFlac || isWav || isAiff) {
    const format = isFlac ? 'FLAC' : isWav ? 'WAV' : 'AIFF'

    // 1) Filename — zero cost, works regardless of file size
    let bps = parseFilenameBps(fileName)
    // 2) Existing caption (from a previous run) — also the only source for
    //    files too large to fetch
    const fromCaption = parseCaptionQuality(caption)
    let rateHz = fromCaption.rateHz
    if (bps === null) bps = fromCaption.bps

    // 3) Header fetch — only if Telegram can actually serve the bytes, and
    //    only for what we still don't know (AIFF has no rate; skip when bps
    //    is already known)
    const needsRate = !isAiff
    const needsHeader = bps === null || (needsRate && rateHz === null)
    if (needsHeader && (!fileSize || fileSize <= TG_MAX_DOWNLOAD)) {
      const header = await fetchAudioHeader(fileId)
      if (header) {
        if (bps === null) bps = header.bps
        if (rateHz === null) rateHz = header.rateHz
      }
    }
    return buildTag(format, bps, isAiff ? null : rateHz)
  }

  if (isAlac) {
    const bps = parseFilenameBps(fileName) ?? parseCaptionQuality(caption).bps
    return buildTag('ALAC', bps, null)
  }

  if (ext && LOSSLESS_EXT.has(ext)) {
    const f = FORMAT_TAG[ext]
    return f ? `${f} #Lossless` : '#Lossless'
  }
  if (mime && LOSSLESS_MIME.has(mime)) return '#Lossless'

  if (ext && LOSSY_EXT.has(ext)) return '#Lossy'

  return null
}

export function registerLosslessHandler(bot: Bot): void {
  // Handle channel posts — same audio gate as messages so non-audio channel
  // documents fall through instead of being swallowed.
  bot.on('channel_post', async (ctx, next) => {
    const msg = ctx.channelPost
    const media = msg.audio ?? msg.document
    if (!media || !looksLikeAudio(media)) return next()

    await processMedia(ctx.api, msg.chat.id, msg.message_id, media, msg.caption)
  })

  // FIX: this used to be registered LAST (registerLosslessHandler(bot) was called
  // at the very bottom of lib/bot.ts), after bot.on('message:document', ...) and
  // bot.on('message:text', ...) were already registered. grammY runs middleware
  // in registration order and stops at the first handler that doesn't call next(),
  // so any FLAC/audio file sent as a Telegram "document" (very common for
  // audiophiles) was always caught by the AI document handler first — which tried
  // to feed a multi-MB binary audio blob to an LLM as if it were a readable file —
  // and this tagging handler never ran. Fix: register this FIRST (bot.ts now calls
  // registerLosslessHandler right after bot.catch()), and only consume the message
  // when it's actually audio; anything else (PDFs, real documents, plain text)
  // calls next() so the existing AI handlers still get a chance to run.
  bot.on('message', async (ctx, next) => {
    const msg = ctx.message
    const media = msg.audio ?? msg.document
    if (!media || !looksLikeAudio(media)) return next()

    await processMedia(ctx.api, msg.chat.id, msg.message_id, media, msg.caption)
  })
}

async function processMedia(
  api: Bot['api'],
  chatId: number,
  messageId: number,
  media: LosslessMedia,
  caption: string | undefined,
): Promise<void> {
  const mimeType = 'mime_type' in media ? media.mime_type : undefined
  const fileName = 'file_name' in media ? media.file_name : undefined
  const fileId   = media.file_id
  const fileSize = 'file_size' in media ? media.file_size : undefined

  const tag = await resolveTag(mimeType, fileName, fileId, fileSize, caption)
  if (tag === null) return

  const newCaption = patchCaption(caption, tag)
  if (newCaption === (caption ?? '')) return

  // Stagger first — spread concurrent edits (including the >20MB FLAC path,
  // which used to edit immediately and hammer the rate limit) to stay under
  // ~1 edit/sec per chat.
  const delay = staggerDelay(messageId)
  if (delay > 0) await new Promise(r => setTimeout(r, delay))

  await editWithRetry(api, chatId, messageId, newCaption)
}

// Lazy cache cleanup. A module-level setInterval keeps the event loop alive
// and is a poor fit for serverless — clean up on access instead, like the
// webhook dedupe map does.
let lastCacheCleanup = 0
const CACHE_CLEANUP_INTERVAL = 10 * 60 * 1000

function cleanupHeaderCache(): void {
  const now = Date.now()
  if (now - lastCacheCleanup < CACHE_CLEANUP_INTERVAL) return
  lastCacheCleanup = now
  for (const [key, entry] of headerCache.entries()) {
    const ttl = entry.header ? HEADER_CACHE_TTL : NEGATIVE_CACHE_TTL
    if (now - entry.timestamp > ttl) {
      headerCache.delete(key)
    }
  }
}

// Exported for offline smoke tests only — not part of the public API.
export const _internals = {
  parseFilenameBps,
  parseCaptionQuality,
  parseAudioHeader,
  parseFlacHeader,
  parseRiffWave,
  parseAiffHeader,
  buildTag,
  patchCaption,
  staggerDelay,
  isAlacByHeuristic,
  looksLikeAudio,
  parseTimeoutEnv,
}
