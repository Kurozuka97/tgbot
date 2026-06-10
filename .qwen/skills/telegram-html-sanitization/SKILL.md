---
name: telegram-html-sanitization
description: Multi-layer approach to sanitizing AI-generated HTML for Telegram messages — handling decorative tag overuse, parse_mode mismatches, Markdown-in-code-blocks, href preservation, deleted-message catch blocks, and Firestore atomicity
source: auto-skill
extracted_at: '2026-06-10T04:51:16.811Z'
---

# Telegram HTML Sanitization for AI Bot Responses

## The Problem

AI models generating Telegram messages suffer from multiple interacting issues:
- Overuse `<i>`, `<u>`, `<s>`, `<em>` tags on random words → messy italic/underline/strikethrough
- Mix Markdown (`**bold**`) with HTML (`<b>bold</b>`) in the same response
- Convert `#` comments inside `<pre>` blocks to `<b>` headings, breaking code rendering and causing Telegram parse errors
- Strip `href` from `<a>` tags, making links useless
- Regex for stripping single-letter tags (`<i>`, `<u>`, `<s>`) over-matches tags like `<span>`, `<strong>`, `<img>`, `<svg>` if word boundaries aren't used
- Missing `parse_mode` on replies → raw HTML tags shown as literal text
- Catch blocks try to `editMessageText` on already-deleted "loading..." messages → unhandled API errors
- Broadcast/admin messages bypass the chat sanitizer entirely

## The Fix (Multi-Layer Belt-and-Suspenders)

### Layer 1: System Prompt Instruction
Tell the model explicitly which tags are allowed AND forbidden:
```
- Do NOT use <i>, <u>, <s>, <em> tags — they will be stripped.
- Only use: <b>, <code>, <pre>, <a href="...">, <tg-spoiler>
```
Include `<em>` in the forbidden list — models may use `<em>` as a synonym for `<i>` since only `<i>` was forbidden.

### Layer 2: Word-Boundary Regex for Decorative Tag Stripping
**Critical:** Use `\b` (word boundary) in the tag-stripping regex to prevent over-matching:
```js
// CORRECT — \b prevents <img>, <span>, <strong>, <svg> from being matched
text = text.replace(/<\/?(i|u|s|em)\b[^>]*>/gi, '');

// WRONG — strips <span>, <strong>, <img>, <svg>, <sup>, etc.
text = text.replace(/<\/?(i|u|s|em)[^>]*>/gi, '');
```
Without `\b`, `(i|u|s)` matches just the first letter, so `<span>` matches because `s` is in the alternation and `[^>]*` greedily consumes `pan...`.

**Must run BEFORE code block conversion** (step 0.5 before step 1) so tags inside Markdown code blocks (`````html<span>Hello</span>`````) are stripped before being wrapped in `<pre>`. But with `\b`, `<span>` won't be matched, so it's safe. Without `\b`, code examples containing HTML are destroyed.

### Layer 3: Code Block Conversion First (Escape Inside)
Convert code blocks before any Markdown formatting runs:
```js
text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) =>
  `<pre>${escapeHTMLEntities(code.trim())}</pre>`
);
text = text.replace(/`([^`\n]+)`/g, (_, code) =>
  `<code>${escapeHTMLEntities(code)}</code>`
);
```
**Must escape HTML entities inside `<pre>/<code>`** (`&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`) so Telegram doesn't parse them as real tags.

### Layer 4: Markdown Conversion ONLY Outside Pre/Code Blocks
**Critical bug:** If Markdown conversion (`**bold**` → `<b>bold</b>`, `### heading` → `<b>heading</b>`) runs on the entire text including inside `<pre>` blocks:
- `# This is a comment` inside `<pre>` becomes `<b>This is a comment</b>` inside `<pre>` — invalid Telegram HTML, message fails to send
- `**important** variable` inside `<pre>` becomes `<b>important</b> variable` — invalid nesting

**Fix:** Split the text on `<pre>/<code>` boundaries and only convert Markdown in the outside segments:
```js
const parts = text.split(/(<\/?(?:pre|code)>)/gi)
text = parts.map((part, idx) => {
  if (idx % 2 === 1) return part // tag boundary, skip
  return part
    .replace(/\*\*\*(.*?)\*\*\*/g, '<b>$1</b>')
    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
    .replace(/__(.*?)__/g, '<b>$1</b>')
}).join('')
```
**Do NOT convert** `*italic*` or `_italic_` to `<i>` — leave as plain text. Converting reintroduces the problem you're trying to solve.

### Layer 5: General Allowed-Tag Filter + href Preservation
Strip disallowed tags, then strip attributes from allowed tags **except `href` on `<a>`**:
```js
const allowed = new Set(['b', 'code', 'pre', 'a', 'tg-spoiler']);

// Strip disallowed tags (keep content)
text = text.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?\/?\>/g, (match, tag) =>
  allowed.has(tag.toLowerCase()) ? match : ''
);

// Strip attributes from all allowed tags EXCEPT <a href>
text = text.replace(/<(b|code|pre|tg-spoiler)(\s[^>]*)?>/gi, '<$1>');
text = text.replace(/<a\s+href="([^"]*)"[^>]*>/gi, '<a href="$1">');
```
Telegram requires `href` on `<a>` tags. Without it, `<a>link</a>` is useless or rejected.

### Layer 6: Parse Mode Consistency (Every Output Path)
Every `sendMessage`, `editMessageText`, or `answerInlineQuery` that sends formatted text MUST include `parse_mode`:
- AI responses (HTML output): `{ parse_mode: 'HTML' }`
- Inline queries: `input_message_content: { message_text: result, parse_mode: 'HTML' }`
- Admin replies (Markdown): `{ parse_mode: 'Markdown' }`
- Broadcasts: sanitize and match format to `parse_mode`

**Common mistake:** Using Markdown `*bold*` / `` `code` `` syntax in a message template wrapping HTML AI output, then forgetting `parse_mode`. This shows raw `<b>` tags AND literal asterisks.

### Layer 7: Deleted-Message Catch Blocks
Commands that send a "Generating..." message, then delete it before sending the result (e.g. `/imagine`, `/sticker`, `/qr`), have a bug: if the result-sending fails, the catch block tries to `editMessageText` the already-deleted message, causing a second unhandled error.

**Fix:** Either remove the "loading" message entirely (Pollinations images are direct URLs), or use a nested catch:
```js
try {
  await ctx.api.deleteMessage(ctx.chat.id, msg.message_id)
  await ctx.replyWithPhoto(url, { caption })
} catch (err) {
  try { await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Failed`) } 
  catch { await ctx.reply(`❌ Failed: ${String(err)}`) }
}
```

### Layer 8: Broadcast / Admin Messages Need Separate Sanitizer
Broadcast messages bypass `sanitizeHTML()` entirely. They need their own function:
```js
function sanitizeBroadcastMessage(text: string): string {
  return text
    .replace(/<\/?(i|u|s|em|span|div|p|br|hr|table|tr|td|th|ul|ol|li|h[1-6])[^>]*>/gi, '')
    .replace(/<b>/gi, '*').replace(/<\/b>/gi, '*')      // for Markdown
    .replace(/<code>/gi, '`').replace(/<\/code>/gi, '`')  // for Markdown
}
```
If broadcast uses `parse_mode: 'Markdown'`, convert HTML to Markdown equivalents. **Note:** this function does NOT handle `<pre>` or escape Markdown-special characters in converted content — a known limitation.

## Key Lessons

1. **Don't trust the model** — even with explicit instructions, weaker models (especially free-tier OpenRouter ones) will still output `<i>/<em>` tags. The sanitizer must be the enforcement layer.
2. **First fix is never complete** — removing `<i>` from allowed set fixed most cases, but some still slipped through. Adding explicit pre-processing caught the rest. Adding `\b` to regex caught edge cases.
3. **Check ALL output paths** — direct messages, inline queries, broadcasts, admin DMs. Missing any path leaves raw tags visible.
4. **Code blocks are fragile** — `#` comments and `**bold**` inside `<pre>` blocks are extremely common and MUST NOT be converted to HTML. Split on `<pre>/<code>` boundaries before Markdown conversion.
5. **`href` on `<a>` must survive** — Telegram links break without it. Strip attributes from `<b>/<code>/<pre>` but preserve `href` on `<a>`.
6. **Regex word boundaries matter** — `<i>` regex without `\b` also matches `<img>`, `<input>`, `<ins>`. Use `\b` after tag name alternations.
7. **Deleted-message catch blocks** — if a command deletes a "loading" message before sending the result, the catch block can't edit that deleted message. Use nested try/catch or skip the loading message.
8. **Firestore batch writes for atomicity** — approveUser/banUser/revokeUser/unbanUser write to multiple documents (user record + allowed list + banned list). Sequential writes risk partial failures leaving inconsistent state. Use `db.batch()` for atomic multi-document writes.

## Reduced Allowed Tag Set

For Telegram AI bots, the practical allowed set:
- `<b>` — bold for key terms, headers
- `<code>` — inline code, filenames, commands
- `<pre>` — multi-line code blocks
- `<a href="...">` — clickable links (href MUST be preserved)
- `<tg-spoiler>` — spoiler text

Everything else (`<i>`, `<u>`, `<s>`, `<em>`, `<strong>`, `<span>`) gets stripped.