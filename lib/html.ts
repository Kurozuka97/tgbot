// Shared Telegram HTML escaping + AI-output sanitization.
// Telegram HTML only allows: <b>, <code>, <pre>, <a href="...">, <tg-spoiler>.
// Everything else must be escaped or stripped or Telegram rejects the message
// with "can't parse entities".

// Telegram hard limit is 4096 characters per message. AI responses (1024
// output tokens + markup) can exceed it, which would fail the send/edit and
// leave the "Thinking..." placeholder stuck forever. Leave a little headroom
// for prefixes that callers prepend (e.g. "🔥 ").
const MAX_MESSAGE_LEN = 4000

export function escapeHTML(text: unknown): string {
  if (text === null || text === undefined) return ''
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function escapeHTMLEntities(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// Escape & that is not already part of a recognized entity. Only the four
// entities Telegram actually supports are protected — anything else gets
// double-escaped so Telegram never sees a bare &.
function escapeBareAmpersands(text: string): string {
  return text.replace(/&(?!(amp|lt|gt|quot);)/g, '&amp;')
}

// Telegram only supports &lt; &gt; &amp; &quot; — numeric entities like &#8212;
// would be rejected, so decode them to the real character up front.
function decodeNumericEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (m, n: string) => {
      const code = Number(n)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m
      try { return String.fromCodePoint(code) } catch { return m }
    })
    .replace(/&#x([0-9a-f]+);/gi, (m, n: string) => {
      const code = parseInt(n, 16)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m
      try { return String.fromCodePoint(code) } catch { return m }
    })
}

// Escape < that is not the start of an allowed Telegram tag.
function escapeBareAngles(text: string): string {
  return text.replace(/<(?!\/?(b|code|pre|a|tg-spoiler)(\s[^>]*)?>)/g, '&lt;')
}

// Broadcast messages come from the admin, typed as plain text with optional
// *bold* markers for emphasis. Escape everything first (so stray < > & can't
// break the HTML parse), then turn *bold* into <b>bold</b>.
export function sanitizeBroadcastMessage(text: string): string {
  const escaped = escapeHTML(text)
  return escaped.replace(/\*(.+?)\*/g, '<b>$1</b>')
}

// Strip any leaked XML/tool-call tags from AI output, convert leftover Markdown
// to Telegram HTML, then escape bare & < > that are NOT part of allowed tags.
export function sanitizeHTML(input: string): string {
  let text = input
  const allowed = new Set(['b', 'code', 'pre', 'a', 'tg-spoiler'])

  // 0. Decode numeric entities Telegram would reject, then strip MarkdownV2
  //    backslash escapes that models sometimes output. The full reserved set
  //    must live inside ONE character class — a bare alternation like |
  //    outside the class turns the whole group into an alternation.
  text = decodeNumericEntities(text)
  text = text.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1')

  // 0.5 Some models wrap a plain link in a fenced code block with a bogus
  // "```undefined" language tag instead of following the "links use <a href>,
  // not code fences" rule. Unwrap THOSE (and only those — a deliberate ``` or
  // ```python block containing a link must stay literal code) before the real
  // code-block handling so the link gets converted properly.
  text = text.replace(/```undefined\n?\s*(\[[^\]]+\]\([^)]+\)|https?:\/\/\S+)\s*\n?```/g, '$1')

  // 1. Convert Markdown code blocks FIRST, and escape their content.
  text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) => `<pre>${escapeHTMLEntities(code.trim())}</pre>`)

  // 2. Convert inline code — escape content inside.
  text = text.replace(/`([^`\n]+)`/g, (_, code) => `<code>${escapeHTMLEntities(code)}</code>`)

  // 3. Strip decorative tags, keeping inner content. \b is required so <i>
  //    doesn't also match <img>, <span>, <strong>, etc.
  text = text.replace(/<\/?(i|u|s|em|strong|span|div|p)\b[^>]*>/gi, '')

  // 4. Convert Markdown formatting ONLY outside <pre>/<code> blocks — track
  //    open/close state instead of naive even/odd splitting (content between
  //    <pre> and </pre> lands on an even index and would otherwise be mangled).
  text = convertOutsideCode(text, (segment) =>
    segment
      .replace(/\*\*\*(.*?)\*\*\*/g, '<b>$1</b>')
      .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
      .replace(/__(.*?)__/g, '<b>$1</b>')
      // Bare Markdown links [text](url] were never converted → literal text.
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        (_, label, href) => `<a href="${escapeBareAmpersands(href)}">${label}</a>`
      )
      // Bare URLs: Telegram does NOT auto-link under HTML parse mode, so make
      // them real <a> tags. The lookbehind skips URLs already inside href="..."
      // (from the conversion just above) so they aren't nested.
      .replace(/(?<!["'>])https?:\/\/[^\s<>\])]+/g, (m) => {
        const url = m.replace(/[.,;:!?)\]]+$/, '')
        const trailing = m.slice(url.length)
        return `<a href="${escapeBareAmpersands(url)}">${url}</a>${trailing}`
      })
  )

  // 5. Strip disallowed HTML tags but keep their content.
  text = text.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?\/?\>/g, (match, tag: string) =>
    allowed.has(tag.toLowerCase()) ? match : ''
  )

  // 6. <a> without an href is useless and Telegram rejects it — unwrap it,
  //    keeping the inner text. Then normalize every remaining anchor to exactly
  //    <a href="..."> (double quotes, escaped &), dropping extra attributes.
  text = text.replace(/<a(?![^>]*\bhref)[^>]*>([\s\S]*?)<\/a>/gi, '$1')
  text = text.replace(
    /<a\s+href\s*=\s*(["'])(.*?)\1[^>]*>/gi,
    (_, __, href: string) => `<a href="${escapeBareAmpersands(href)}">`
  )
  // Strip attributes from the other allowed tags (e.g. <b class="x">).
  text = text.replace(/<(b|code|pre|tg-spoiler)(\s[^>]*)?>/gi, '<$1>')

  // 7. Convert Markdown headers to bold — only outside <pre>/<code>.
  text = convertOutsideCode(text, (segment) => segment.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>'))

  // 8. Escape bare & < > that are not part of allowed tags.
  text = escapeBareAmpersands(text)
  text = escapeBareAngles(text)

  // 9. Enforce the 4096-char limit, then repair what truncation may have cut
  //    in half (a partial tag or entity), then verify tag balance. If tags are
  //    still unbalanced, drop them all — a plain message always sends, a
  //    malformed one never does.
  if (text.length > MAX_MESSAGE_LEN) {
    text = text.slice(0, MAX_MESSAGE_LEN - 1)
    // Don't end mid-entity or mid-tag.
    text = text.replace(/&[a-z#0-9x]*$/i, '').replace(/<[^>]*$/, '').replace(/\uFFFD$/, '')
    text = escapeBareAmpersands(text) + '…'
  }
  if (!tagsBalanced(text)) text = stripAllowedTags(text)

  return text.trim()
}

// Split on <pre>/<code> boundaries and transform only the segments outside them.
function convertOutsideCode(text: string, transform: (segment: string) => string): string {
  const segments = text.split(/(<\/?(?:pre|code)>)/gi)
  let inCodeBlock = false
  let out = ''
  for (const segment of segments) {
    if (/^<\/?(pre|code)>$/i.test(segment)) {
      // An OPEN tag (<pre>) means we are now INSIDE the block; a CLOSE tag
      // means we are outside again. The old code had this inverted
      // (inCodeBlock = segment.startsWith('</')), so markdown and # headers
      // inside code blocks were converted and broke the block.
      inCodeBlock = !segment.startsWith('</')
      out += segment
    } else if (inCodeBlock) {
      out += segment
    } else {
      out += transform(segment)
    }
  }
  return out
}

// Walk the allowed tags and make sure every open has a matching close in the
// right order. Nested mixed tags are fine (Telegram allows it); a dangling
// close, an unclosed open, or reordered closes are not.
function tagsBalanced(text: string): boolean {
  const stack: string[] = []
  const re = /<\/?(b|code|pre|a|tg-spoiler)(?:\s[^>]*)?>/gi
  for (const match of text.matchAll(re)) {
    const raw = match[0]
    const tag = match[1].toLowerCase()
    if (raw.startsWith('</')) {
      if (stack.pop() !== tag) return false
    } else {
      stack.push(tag)
    }
  }
  return stack.length === 0
}

function stripAllowedTags(text: string): string {
  return text.replace(/<\/?(b|code|pre|a|tg-spoiler)(\s[^>]*)?>/gi, '')
}
