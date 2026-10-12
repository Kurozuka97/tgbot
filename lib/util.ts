// Small shared helpers used across the bot handlers.

import type { Api } from 'grammy'
import { escapeHTML } from './html'

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'a while'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return 'under a minute'
}

export function formatDate(ts?: number): string {
  if (!ts) return 'never'
  return new Date(ts).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' })
}

// Format an error for a Telegram reply: escaped (so stray < > & can't break
// the HTML parse), truncated (Telegram rejects > 4096 chars), and capped so we
// don't dump a giant stack into chat. Full details stay in the server logs.
export function errMsg(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  return escapeHTML(raw.length > 300 ? raw.slice(0, 300) + '…' : raw)
}

// ─── Telegram file download ───────────────────────────────────────────────────

// Cap for files fed to the AI: Telegram's own getFile limit is 20 MB, but a
// base64-encoded 20 MB blob will blow the provider payload and the function
// timeout long before then.
export const MAX_AI_FILE_SIZE = 8 * 1024 * 1024

const FILE_FETCH_TIMEOUT_MS = 15_000

export async function fetchFile(
  api: Api,
  botToken: string,
  fileId: string,
  fileSize?: number,
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (fileSize && fileSize > MAX_AI_FILE_SIZE) {
    throw new Error(`File is too large for AI analysis (max ${Math.floor(MAX_AI_FILE_SIZE / 1024 / 1024)} MB).`)
  }
  const file = await api.getFile(fileId)
  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`
  const res = await fetch(url, { signal: AbortSignal.timeout(FILE_FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`Telegram file download failed (HTTP ${res.status})`)
  const buffer = Buffer.from(await res.arrayBuffer())
  const ext = file.file_path?.split('.').pop()?.toLowerCase() ?? ''
  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
    txt: 'text/plain', mp4: 'video/mp4'
  }
  return { buffer, mimeType: mimeMap[ext] ?? 'application/octet-stream' }
}

// ─── URL fetching (SSRF-guarded) ──────────────────────────────────────────────

const URL_FETCH_TIMEOUT_MS = 20_000
const MAX_FETCHED_CHARS = 4000

function isPrivateHost(hostname: string): boolean {
  // WHATWG URL keeps IPv6 literals bracketed (url.hostname === "[::1]"), which
  // silently defeated every IPv6 check below — strip brackets first.
  const host = hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[/, '')
    .replace(/\]$/, '')
  if (
    host === 'localhost' ||
    host === 'metadata.google.internal' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true
  }
  // IPv4: loopback, private, link-local (cloud metadata lives in 169.254/16).
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    return false
  }
  // IPv6: loopback, unique-local, link-local, IPv4-mapped private.
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true
    if (/^f[cd]/.test(host)) return true // fc00::/7
    if (/^fe[89ab]/.test(host)) return true // fe80::/10
    if (/^::ffff:/.test(host)) {
      const rest = host.slice(7)
      // ::ffff:127.0.0.1 — dotted-quad form, re-run the IPv4 checks.
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return isPrivateHost(rest)
      // ::ffff:7f00:1 — hex-pair form, decode to dotted quad first.
      const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
      if (hex) {
        const hi = parseInt(hex[1], 16)
        const lo = parseInt(hex[2], 16)
        return isPrivateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
      }
      return false
    }
    return false
  }
  return false
}

// Validate a user-supplied URL before fetching it server-side. Blocks
// non-http(s) schemes and hosts that resolve into private networks.
//
// Known limitation: this checks the hostname string, not the post-DNS address,
// so a public hostname that resolves to 127.0.0.1 (DNS rebinding) can still
// slip through. A full fix requires resolving and pinning the IP, which is
// overkill for this bot — but worth knowing about.
export function validatePublicHttpUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('Invalid URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are supported.')
  }
  if (isPrivateHost(url.hostname)) {
    throw new Error('That host is not allowed.')
  }
  return url
}

export async function fetchUrl(rawUrl: string): Promise<string> {
  const url = validatePublicHttpUrl(rawUrl)
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; TGBot/1.0)',
      'Accept': 'text/html,application/xhtml+xml'
    },
    signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
    redirect: 'follow'
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const html = await res.text()
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FETCHED_CHARS)
}
