// GitHub repo search — used by /github <query>.
//
// No auth is required to use the GitHub Search API, but unauthenticated
// requests are capped at 10 req/min and 60 req/hour. Set GITHUB_TOKEN (a
// classic PAT with no scopes, or a fine-grained token with no permissions,
// is enough for public search) to raise that to 30 req/min / 5000 req/hour.
// A token is also strongly recommended because of the existence check below,
// which burns extra requests against that same rate limit.

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
// when you actually open it. This confirms a repo is still really there
// before it's shown.
async function repoExists(fullName: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.github.com/repos/${fullName}`, { headers: authHeaders() })
    return res.ok
  } catch {
    return false
  }
}

// e.g. /github music player
export async function searchRepos(query: string, perPage = 5): Promise<GithubRepo[]> {
  // Fetch extra candidates since some will get filtered out by the existence
  // check below (stale search-index entries).
  const fetchCount = perPage * 3
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${fetchCount}`
  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub search failed (${res.status}): ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  const candidates: GithubRepo[] = (data.items ?? []).map(mapRepo)

  const checked = await Promise.all(candidates.map(async (r) => ({ r, ok: await repoExists(r.fullName) })))
  return checked.filter(c => c.ok).map(c => c.r).slice(0, perPage)
}

export function formatRepo(repo: GithubRepo): string {
  const desc = repo.description ? escapeHTML(repo.description) : '<i>no description</i>'
  const lang = repo.language ? ` · ${escapeHTML(repo.language)}` : ''
  return `⭐ ${repo.stars} — <a href="${repo.url}">${escapeHTML(repo.fullName)}</a>${lang}\n${desc}`
}
