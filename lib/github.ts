// GitHub repo search — used by /github <query>.
//
// No auth is required to use the GitHub Search API, but unauthenticated
// requests are capped at 10 req/min and 60 req/hour. Set GITHUB_TOKEN (a
// classic PAT with no scopes, or a fine-grained token with no permissions,
// is enough for public search) to raise that to 30 req/min / 5000 req/hour.
// A token is strongly recommended: it also raises GitHub's "secondary" abuse
// rate limit, which the existence check below can otherwise trip.

export interface GithubRepo {
  id: number
  fullName: string
  description: string | null
  url: string
  stars: number
  language: string | null
  createdAt: string
  topics: string[]
}

function escapeHTML(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'tgbot-github-search',
  }
  if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`
  return headers
}

function mapRepo(r: any): GithubRepo {
  return {
    id: r.id,
    fullName: r.full_name,
    description: r.description ?? null,
    url: r.html_url,
    stars: r.stargazers_count ?? 0,
    language: r.language ?? null,
    createdAt: r.created_at,
    topics: r.topics ?? [],
  }
}

// GitHub's search index lags behind reality — it can keep serving repos
// that were since deleted, renamed, or made private, so a result can 404
// when you actually open it.
//
// FIX: this used to check all candidates concurrently via Promise.all and
// treat any non-200 as "doesn't exist" — but firing that many requests at
// once trips GitHub's secondary/abuse rate limiter, which returns 403 for
// perfectly real repos too. That was silently deleting valid, even
// high-star results (including exact top matches) from the results.
// Now: only an explicit 404 counts as "gone" (403/5xx/network errors are
// treated as "can't confirm, so keep it" — fail open, not closed), and
// checks run sequentially, stopping as soon as we have enough, instead of
// firing a burst of concurrent requests.
async function repoExists(fullName: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.github.com/repos/${fullName}`, { headers: authHeaders() })
    if (res.status === 404) return false
    return true
  } catch {
    return true
  }
}

// e.g. /github music player, or /github music player 20 for more results
export async function searchRepos(query: string, perPage = 5): Promise<GithubRepo[]> {
  // Fetch a modest buffer beyond what's needed, in case a few get filtered
  // out as confirmed-gone. Kept small (not perPage*N) because each extra
  // candidate costs one more sequential existence-check request — with
  // large perPage values that adds up and risks the function timeout.
  const fetchCount = Math.min(100, perPage + 10)
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${fetchCount}`
  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub search failed (${res.status}): ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  const candidates: GithubRepo[] = (data.items ?? []).map(mapRepo)

  const results: GithubRepo[] = []
  for (const repo of candidates) {
    if (results.length >= perPage) break
    if (await repoExists(repo.fullName)) results.push(repo)
  }
  return results
}

export function formatRepo(repo: GithubRepo): string {
  const desc = repo.description ? escapeHTML(repo.description) : '<i>no description</i>'
  const lang = repo.language ? ` · ${escapeHTML(repo.language)}` : ''
  return `⭐ ${repo.stars} — <a href="${repo.url}">${escapeHTML(repo.fullName)}</a>${lang}\n${desc}`
}
