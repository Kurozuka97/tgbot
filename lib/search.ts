// Live web search via DuckDuckGo's HTML endpoint (no API key required).
//
// This scrapes https://html.duckduckgo.com/html/ — a stable, ad-light endpoint
// DDG offers for non-JS clients. If it ever breaks or starts rate-limiting,
// callers fall back to answering from model knowledge with a clear disclaimer,
// so a scraper failure degrades gracefully instead of failing the command.

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

const SEARCH_TIMEOUT_MS = 10_000
const MAX_RESULTS = 5
const MAX_HITS_FETCHED = 10

// Strip tags/entities from a small HTML fragment (snippets only).
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

// DDG wraps result URLs in a redirect: //duckduckgo.com/l/?uddg=<encoded-url>&rut=...
function resolveRedirect(href: string): string {
  if (href.startsWith('//')) href = 'https:' + href
  try {
    const url = new URL(href, 'https://duckduckgo.com')
    const target = url.searchParams.get('uddg')
    if (target) return decodeURIComponent(target)
    return url.toString()
  } catch {
    return href
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => {
      const code = Number(n)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _
    })
    .replace(/&amp;/g, '&')
}

export async function searchWeb(query: string): Promise<SearchHit[]> {
  const url = new URL('https://html.duckduckgo.com/html/')
  url.searchParams.set('q', query)
  url.searchParams.set('kl', 'us-en')

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; TGBot/1.0)',
      'Accept': 'text/html,application/xhtml+xml'
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`)

  const html = await res.text()
  const hits: SearchHit[] = []

  // Result anchors: <a rel="nofollow" class="result__a" href="...">Title</a>
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  // Matching snippets: <a class="result__snippet" ...>Snippet</a>
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi

  const links = [...html.matchAll(linkRe)]
  const snippets = [...html.matchAll(snippetRe)]

  for (let i = 0; i < links.length && hits.length < MAX_RESULTS; i++) {
    const [, href, titleHtml] = links[i]
    const title = decodeEntities(stripTags(titleHtml))
    if (!title) continue
    // Prefer the first MAX_HITS_FETCHED candidates; later ones are low quality.
    if (i >= MAX_HITS_FETCHED) break
    const snippet = snippets[i] ? decodeEntities(stripTags(snippets[i][1])) : ''
    hits.push({ title, url: resolveRedirect(href), snippet })
  }
  return hits
}

export function formatSearchResults(query: string, hits: SearchHit[]): string {
  const list = hits
    .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`)
    .join('\n\n')
  return (
    `Live web search results for "${query}":\n\n${list}\n\n` +
    `Use these results to answer. Cite sources inline as <a href="url">title</a>. ` +
    `If they are irrelevant or outdated, say so briefly and answer from your own knowledge.`
  )
}

export function fallbackPrompt(query: string): string {
  return (
    `Live web search is unavailable right now, so you have no fresh web results. ` +
    `Say so in one short sentence at the start of your answer, then answer this from your own knowledge: ${query}`
  )
}
