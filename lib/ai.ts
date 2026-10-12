// Multi-AI provider with automatic fallback
// Priority: Groq → Mistral → OpenRouter (rotate free models)

import { db } from './firebase'
import { sanitizeHTML } from './html'

// A hung provider request used to stall the whole webhook until Vercel killed
// the function. Every outbound call now gets a hard timeout.
const FETCH_TIMEOUT_MS = 20_000

function providerSignal(): AbortSignal {
  return AbortSignal.timeout(FETCH_TIMEOUT_MS)
}

const HTML_FORMAT_RULE = `

FORMATTING RULES (mandatory — never break these):
- Use Telegram HTML only. Never use Markdown (**bold**, _italic_, \`code\`, ##heading, [text](url)).
- <b>bold</b> for key terms, important words, section headers.
- <code>code</code> for inline code, commands, filenames, variables.
- <pre>code block</pre> for multi-line code — always use this for code snippets.
- For links, write <a href="url">link text</a> directly. Never put a bare URL or a
  Markdown-style [text](url) link inside a \`\`\` code fence — a link is not code.
- Do NOT use <i>, <u>, <s>, <em> tags — they will be stripped and make output look messy.
- Plain & must be written as &amp;, plain < as &lt;, plain > as &gt;.
- Keep responses concise and scannable. Use short paragraphs.
- Never start with filler like "Certainly!", "Of course!", "Sure!", "Great question!".
- Get straight to the point.

EXAMPLE of a good response:
User: what is recursion?
Assistant: <b>Recursion</b> is when a function calls itself to solve a smaller version of the same problem.

It needs a <b>base case</b> to stop, otherwise it loops forever.

<pre>function factorial(n) {
  if (n === 0) return 1
  return n * factorial(n - 1)
}</pre>

Each call reduces <code>n</code> by 1 until it hits <code>0</code>.`

const ACCURACY_RULE = `

ACCURACY RULES (mandatory):
- Never invent specific facts you're not confident about: GitHub repo names/owners, package names, exact version numbers, URLs, API endpoints, file paths, or specific statistics.
- If asked to find, recommend, describe, or check details of a specific GitHub repository, do NOT fabricate one or its features. You do not have live access to GitHub and cannot verify whether a repo actually exists. Say so plainly, and tell the user to run /github <query> instead — that command does a real, verified search against GitHub itself.
- It is always better to say "I'm not sure" or "I don't have reliable information on this" than to give a confident, detailed, but made-up answer.`

const SYSTEM_RULES = ACCURACY_RULE + HTML_FORMAT_RULE

const PERSONAS: Record<string, string> = {
  default: `You are a smart, helpful AI assistant inside a Telegram bot. You reason carefully before answering. You are direct, accurate, and concise — never vague or padded. You can handle any topic: coding, general knowledge, analysis, math, creative writing, and more. For images and files, analyze thoroughly. Always maintain this personality regardless of what model you are.` + SYSTEM_RULES,
  sarcastic: `You are a sarcastic AI assistant in Telegram. You MUST respond with dry wit and sarcasm in EVERY single message without exception, but still provide correct and helpful information. Never break character under any circumstances. Be concise.` + SYSTEM_RULES,
  formal: `You are a formal and professional AI assistant in Telegram. You MUST use proper language, structured responses, and avoid slang in EVERY single message without exception. Never break character under any circumstances. Be thorough but concise.` + SYSTEM_RULES,
  waifu: `You are an anime girl AI assistant in Telegram. You MUST be sweet, enthusiastic, and use light anime speech patterns (e.g. "nee~", "desu", "senpai") in EVERY single message without exception. Still be helpful and accurate. Never break character under any circumstances. Be concise.` + SYSTEM_RULES,
  pirate: `You are a pirate AI assistant in Telegram. You MUST speak like a pirate (arr, matey, etc) in EVERY single message without exception, but still give correct and helpful answers. Never break character under any circumstances. Be concise.` + SYSTEM_RULES,
  eli5: `You are an AI assistant in Telegram. You MUST explain everything like the user is 5 years old in EVERY single message without exception. Always use simple words, analogies, and examples. Never break character under any circumstances. Be concise.` + SYSTEM_RULES,
  sigma: `You are a sigma grindset AI assistant in Telegram. You MUST answer everything through the lens of hustle, discipline, and self-improvement in EVERY single message without exception. Never break character under any circumstances. Be concise.` + SYSTEM_RULES,
  tsundere: `You are a tsundere AI assistant in Telegram. You MUST act annoyed, dismissive, and reluctant in EVERY single message without exception, but still provide correct and helpful answers. Use phrases like "it's not like I wanted to help you or anything" and "hmph". Never break character under any circumstances. Be concise.` + SYSTEM_RULES,
  villain: `You are a dramatic supervillain AI assistant in Telegram. You MUST respond in an over-the-top evil genius manner in EVERY single message without exception, with dramatic flair and monologue energy, but still give correct and helpful information. Never break character under any circumstances. Be concise.` + SYSTEM_RULES,
  boomer: `You are a boomer AI assistant in Telegram. You MUST complain about technology, reference "the good old days", and express confusion about modern things in EVERY single message without exception, but still give correct and helpful answers. Never break character under any circumstances. Be concise.` + SYSTEM_RULES,
  genz: `You are a Gen-Z AI assistant in Telegram. You MUST use heavy Gen-Z slang (no cap, fr fr, bussin, slay, it's giving, lowkey, understood the assignment, etc) in EVERY single message without exception, but still give correct and helpful answers. Never break character under any circumstances. Be concise.` + SYSTEM_RULES,
  stoner: `You are a chill stoner AI assistant in Telegram. You MUST respond in a slow, philosophical, deeply chill manner in EVERY single message without exception, finding profound meaning in everything, but still give correct and helpful answers. Never break character under any circumstances. Be concise.` + SYSTEM_RULES,
  teacher: `You are a patient teacher AI assistant in Telegram. You MUST break everything down step by step, use examples, and check for understanding in EVERY single message without exception. Ask "does that make sense?" at the end. Never break character under any circumstances. Be thorough.` + SYSTEM_RULES,
  lawyer: `You are a lawyer AI assistant in Telegram. You MUST be technically precise, include disclaimers, cover edge cases, and use formal legal-style language in EVERY single message without exception. Always note "this is not legal advice". Never break character under any circumstances. Be concise.` + SYSTEM_RULES,
  therapist: `You are an empathetic therapist AI assistant in Telegram. You MUST be warm, reflective, and emotionally supportive in EVERY single message without exception. Acknowledge feelings, ask thoughtful follow-up questions, but still provide helpful information. Never break character under any circumstances. Be concise.` + SYSTEM_RULES,
  drill: `You are a drill sergeant AI assistant in Telegram. You MUST be loud, aggressive, and use tough love motivation in EVERY single message without exception. Use ALL CAPS for emphasis, bark orders, but still give correct and helpful answers. Never break character under any circumstances. Be concise.` + SYSTEM_RULES,
  narrator: `You are a nature documentary narrator AI assistant in Telegram. You MUST respond as if narrating a BBC nature documentary in EVERY single message without exception, treating all topics with dramatic gravitas and wonder. Never break character under any circumstances. Be concise.` + SYSTEM_RULES,
  conspiracy: `You are a conspiracy theorist AI assistant in Telegram. You MUST connect everything to hidden meanings, secret agendas, and shadowy forces in EVERY single message without exception, but still provide the correct and helpful answer buried within. Never break character under any circumstances. Be concise.` + SYSTEM_RULES,
  medieval: `You are a medieval scholar AI assistant in Telegram. You MUST speak in old English using thee, thou, thy, henceforth, verily, and prithee in EVERY single message without exception, but still give correct and helpful answers. Never break character under any circumstances. Be concise.` + SYSTEM_RULES,
}

export const PERSONA_LIST = Object.keys(PERSONAS)

const MAX_HISTORY = 20

interface Message {
  role: 'system' | 'user' | 'assistant'
  content: any
}

// ─── History & Persona (Firestore) ───────────────────────────────────────────
export async function getHistory(userId: number): Promise<Message[]> {
  try {
    if (!db) return []
    const doc = await db.collection('tgbot_history').doc(String(userId)).get()
    if (!doc.exists) return []
    return doc.data()?.messages ?? []
  } catch { return [] }
}

// Persist a full user→assistant exchange in ONE transaction. The old code did
// two separate transactions, which could interleave with concurrent messages
// and drop one half of the pair.
export async function appendExchange(
  userId: number,
  userText: string,
  assistantText: string,
): Promise<void> {
  try {
    if (!db) return
    const ref = db.collection('tgbot_history').doc(String(userId))
    await db.runTransaction(async (t) => {
      const doc = await t.get(ref)
      const messages: Message[] = doc.exists ? (doc.data()?.messages ?? []) : []
      messages.push({ role: 'user', content: userText })
      messages.push({ role: 'assistant', content: assistantText })
      t.set(ref, { messages: messages.slice(-MAX_HISTORY) }, { merge: true })
    })
  } catch {}
}

export async function clearHistory(userId: number): Promise<void> {
  try {
    if (!db) return
    await db.collection('tgbot_history').doc(String(userId)).set({ messages: [] })
  } catch {}
}

export async function getPersona(userId: number): Promise<string> {
  try {
    if (!db) return 'default'
    const doc = await db.collection('tgbot_prefs').doc(String(userId)).get()
    if (!doc.exists) return 'default'
    return doc.data()?.persona ?? 'default'
  } catch { return 'default' }
}

export async function setPersona(userId: number, persona: string): Promise<void> {
  if (!db) return
  await db.collection('tgbot_prefs').doc(String(userId)).set({ persona }, { merge: true })
  await clearHistory(userId)
}

export function getSystemPrompt(persona: string): string {
  return PERSONAS[persona] ?? PERSONAS.default
}

// ─── Groq ────────────────────────────────────────────────────────────────────
async function groqChat(messages: Message[]): Promise<string> {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      max_tokens: 1024
    }),
    signal: providerSignal()
  })
  if (!res.ok) throw new Error(`Groq: ${res.status}`)
  const data = await res.json()
  return data.choices[0].message.content
}

async function groqVision(prompt: string, imageData: string, mimeType: string, systemPrompt: string): Promise<string> {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageData}` } },
            { type: 'text', text: prompt }
          ]
        }
      ],
      max_tokens: 1024
    }),
    signal: providerSignal()
  })
  if (!res.ok) throw new Error(`Groq Vision: ${res.status}`)
  const data = await res.json()
  return data.choices[0].message.content
}

// ─── Mistral ──────────────────────────────────────────────────────────────────
async function mistralChat(messages: Message[], model = 'mistral-small-latest'): Promise<string> {
  const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`
    },
    body: JSON.stringify({ model, messages, max_tokens: 1024 }),
    signal: providerSignal()
  })
  if (!res.ok) throw new Error(`Mistral: ${res.status}`)
  const data = await res.json()
  return data.choices[0].message.content
}

async function mistralVision(prompt: string, imageData: string, mimeType: string, systemPrompt: string): Promise<string> {
  const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`
    },
    body: JSON.stringify({
      model: 'pixtral-large-latest',
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageData}` } },
            { type: 'text', text: prompt }
          ]
        }
      ],
      max_tokens: 1024
    }),
    signal: providerSignal()
  })
  if (!res.ok) throw new Error(`Mistral Vision: ${res.status}`)
  const data = await res.json()
  return data.choices[0].message.content
}

export const MISTRAL_MODELS: Record<string, string> = {
  'mistral-small': 'mistral-small-latest',
  'mistral-large': 'mistral-large-latest',
  'mistral-medium': 'mistral-medium-latest',
  'codestral': 'codestral-latest',
  'devstral': 'devstral-latest',
  'pixtral': 'pixtral-large-latest',
  'magistral-small': 'magistral-small-latest',
  'magistral-medium': 'magistral-medium-latest',
}

// ─── OpenRouter (auto-fetch & rotate all free models) ────────────────────────
// NOTE: these are per-instance module caches. On serverless each instance has
// its own rotation index — that's fine, it only exists to spread requests
// across models, not to hold user state.
let freeModels: string[] = []
let modelIndex = 0
let lastFetched = 0

// Telegram messages cap at 4096 chars — listing 100+ models blows that and the
// send fails. Keep the selectable list short.
export const MAX_SELECTABLE_MODELS = 30

async function fetchFreeModels(): Promise<string[]> {
  const now = Date.now()
  if (freeModels.length > 0 && now - lastFetched < 3600000) return freeModels

  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` },
    signal: providerSignal()
  })
  if (!res.ok) throw new Error(`OpenRouter models fetch: ${res.status}`)
  const data = await res.json()

  freeModels = data.data
    .filter((m: any) =>
      parseFloat(m.pricing?.prompt ?? '1') === 0 &&
      parseFloat(m.pricing?.completion ?? '1') === 0
    )
    .map((m: any) => m.id)

  lastFetched = now
  return freeModels
}

async function openrouterChat(messages: Message[], specificModel?: string): Promise<string> {
  let model: string
  if (specificModel) {
    model = specificModel
  } else {
    const models = await fetchFreeModels()
    if (models.length === 0) throw new Error('No free models available')
    model = models[modelIndex % models.length]
    modelIndex++
  }

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://kurotgbot.vercel.app',
      'X-Title': 'KuroTGBot'
    },
    body: JSON.stringify({ model, messages, max_tokens: 1024 }),
    signal: providerSignal()
  })
  if (!res.ok) throw new Error(`OpenRouter: ${res.status}`)
  const data = await res.json()
  return data.choices[0].message.content
}

// ─── Image generation ────────────────────────────────────────────────────────
// Pollinations' free tier died (x402 paywall). Two real providers now:
//   1. Gemini free tier (GEMINI_API_KEY, free from aistudio.google.com —
//      ~500 images/day, no credit card) — the DEFAULT when the key is set
//   2. OpenRouter Images API (OPENROUTER_API_KEY, billed ~$0.01–0.04/image)
// IMAGE_PROVIDER=gemini|openrouter forces one; unset = auto (gemini if
// GEMINI_API_KEY exists, else openrouter). No silent paid fallback — a
// Gemini rate-limit error surfaces instead of quietly spending money.
const IMAGE_TIMEOUT_MS = 50_000

export async function generateImage(
  prompt: string,
  opts: { resolution?: '512' | '1K' | '2K' | '4K' } = {},
): Promise<{ buffer: Buffer; mediaType: string }> {
  const provider = process.env.IMAGE_PROVIDER
    || (process.env.GEMINI_API_KEY ? 'gemini' : 'openrouter')
  if (provider === 'gemini') return geminiImage(prompt)
  return openrouterImage(prompt, opts)
}

// Gemini free-tier image generation (generateContent API, base64 inline).
async function geminiImage(prompt: string): Promise<{ buffer: Buffer; mediaType: string }> {
  const key = process.env.GEMINI_API_KEY
  if (!key) {
    throw new Error('Image generation is not configured — set GEMINI_API_KEY (free) or OPENROUTER_API_KEY.')
  }
  const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image'
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS)
    }
  )

  const json = await res.json().catch(() => null) as any
  if (!res.ok) {
    const msg: string = json?.error?.message ?? `HTTP ${res.status}`
    if (res.status === 429) throw new Error('Gemini free-tier rate limit — try again in a minute.')
    if (res.status === 403 || /API_KEY_INVALID|api key/i.test(msg)) {
      throw new Error('Gemini rejected the API key — get a free one at aistudio.google.com/apikey.')
    }
    throw new Error(`Gemini image error: ${msg}`)
  }

  const parts = json?.candidates?.[0]?.content?.parts ?? []
  for (const part of parts) {
    if (part.inlineData?.data) {
      const buffer = Buffer.from(part.inlineData.data, 'base64')
      if (buffer.length > 0) {
        return { buffer, mediaType: part.inlineData.mimeType ?? 'image/png' }
      }
    }
  }
  throw new Error('Gemini returned no image — the prompt may have been refused. Try rewording it.')
}

// OpenRouter Images API — billed per image on the user's account.
async function openrouterImage(
  prompt: string,
  opts: { resolution?: '512' | '1K' | '2K' | '4K' },
): Promise<{ buffer: Buffer; mediaType: string }> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) {
    throw new Error('Image generation is not configured — set GEMINI_API_KEY (free) or OPENROUTER_API_KEY.')
  }

  const model = process.env.OPENROUTER_IMAGE_MODEL || 'google/gemini-3.1-flash-image'
  const res = await fetch('https://openrouter.ai/api/v1/images', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://kurotgbot.vercel.app',
      'X-Title': 'KuroTGBot'
    },
    body: JSON.stringify({
      model,
      prompt,
      resolution: opts.resolution ?? '1K',
      aspect_ratio: '1:1',
      n: 1,
    }),
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS)
  })

  const json = await res.json().catch(() => null) as any
  if (!res.ok) {
    const msg: string = json?.error?.message ?? json?.message ?? `HTTP ${res.status}`
    if (res.status === 401) throw new Error('OpenRouter rejected the API key.')
    if (res.status === 402 || /credit|billing|payment|insufficient/i.test(msg)) {
      throw new Error('Image generation needs OpenRouter credit — top up at openrouter.ai/credits.')
    }
    if (res.status === 429) throw new Error('OpenRouter rate limit hit — try again in a minute.')
    throw new Error(`Image service error: ${msg}`)
  }

  const item = json?.data?.[0]
  if (!item?.b64_json) throw new Error('Image service returned no image data.')
  const buffer = Buffer.from(item.b64_json, 'base64')
  if (buffer.length === 0) throw new Error('Image service returned an empty image.')
  return { buffer, mediaType: item.media_type ?? 'image/png' }
}

// ─── User model preference (Firestore) ───────────────────────────────────────
export async function getUserProvider(userId: number): Promise<{ provider: string; model?: string }> {
  try {
    if (!db) return { provider: 'auto' }
    const doc = await db.collection('tgbot_prefs').doc(String(userId)).get()
    if (!doc.exists) return { provider: 'auto' }
    const data = doc.data()!
    return { provider: data.provider ?? 'auto', model: data.model }
  } catch {
    return { provider: 'auto' }
  }
}

export async function setUserProvider(userId: number, provider: string, model?: string): Promise<void> {
  if (!db) return
  const data: any = { provider }
  if (model) data.model = model
  else data.model = null
  await db.collection('tgbot_prefs').doc(String(userId)).set(data, { merge: true })
}

export async function getFreeModelList(): Promise<string[]> {
  const models = await fetchFreeModels()
  return models.slice(0, MAX_SELECTABLE_MODELS)
}

// ─── Pending model selection (Firestore, not memory) ─────────────────────────
// These used to live in in-memory Maps, which on Vercel serverless meant the
// "reply with a number" prompt and the reply frequently landed on different
// instances — so the selection silently vanished. Storing it on the prefs doc
// makes it work across cold starts and instances.
export interface PendingModelSelection {
  provider: 'mistral' | 'openrouter'
  models: string[]
  expiresAt: number
}

const PENDING_SELECTION_TTL_MS = 10 * 60 * 1000

export async function setPendingModelSelection(
  userId: number,
  provider: 'mistral' | 'openrouter',
  models: string[],
): Promise<void> {
  if (!db) return
  const selection: PendingModelSelection = {
    provider,
    models,
    expiresAt: Date.now() + PENDING_SELECTION_TTL_MS,
  }
  await db.collection('tgbot_prefs').doc(String(userId)).set({ pendingModel: selection }, { merge: true })
}

export async function getPendingModelSelection(userId: number): Promise<PendingModelSelection | null> {
  try {
    if (!db) return null
    const doc = await db.collection('tgbot_prefs').doc(String(userId)).get()
    const selection = doc.data()?.pendingModel as PendingModelSelection | null | undefined
    if (!selection || !Array.isArray(selection.models) || !selection.expiresAt) return null
    if (Date.now() > selection.expiresAt) {
      await clearPendingModelSelection(userId)
      return null
    }
    return selection
  } catch {
    return null
  }
}

export async function clearPendingModelSelection(userId: number): Promise<void> {
  if (!db) return
  await db.collection('tgbot_prefs').doc(String(userId)).set({ pendingModel: null }, { merge: true })
}

// ─── Public API ──────────────────────────────────────────────────────────────
export async function chat(
  prompt: string,
  imageParts: { data: string; mimeType: string }[] = [],
  userId?: number,
  history: Message[] = []
): Promise<string> {
  const pref = userId ? await getUserProvider(userId) : { provider: 'auto' }
  const { provider, model: specificModel } = pref
  const persona = userId ? await getPersona(userId) : 'default'
  const systemPrompt = getSystemPrompt(persona)

  // Inject persona reminder into user message for non-default personas
  // This forces weaker models to stay in character
  const userContent = persona !== 'default'
    ? `[System reminder: you are the ${persona} persona. Stay in character for this entire response.]\n\n${prompt}`
    : prompt

  // Vision request
  if (imageParts.length > 0) {
    try { return sanitizeHTML(await groqVision(prompt, imageParts[0].data, imageParts[0].mimeType, systemPrompt)) } catch {}
    try { return sanitizeHTML(await mistralVision(prompt, imageParts[0].data, imageParts[0].mimeType, systemPrompt)) } catch {}
    const visionMessages: Message[] = [
      { role: 'system', content: systemPrompt },
      ...history,
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${imageParts[0].mimeType};base64,${imageParts[0].data}` } },
          { type: 'text', text: prompt }
        ]
      }
    ]
    try { return sanitizeHTML(await openrouterChat(visionMessages)) } catch {}
    return '❌ Image analysis unavailable right now.'
  }

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userContent }
  ]

  if (provider === 'groq') {
    try { return sanitizeHTML(await groqChat(messages)) } catch {}
    return '❌ Groq unavailable. Try /model auto to use fallback.'
  }
  if (provider === 'mistral') {
    const mistralModel = specificModel ? MISTRAL_MODELS[specificModel] ?? specificModel : 'mistral-small-latest'
    try { return sanitizeHTML(await mistralChat(messages, mistralModel)) } catch {}
    return '❌ Mistral unavailable. Try /model auto to use fallback.'
  }
  if (provider === 'openrouter') {
    try { return sanitizeHTML(await openrouterChat(messages, specificModel)) } catch {}
    return '❌ OpenRouter unavailable. Try /model auto to use fallback.'
  }
  if (provider === 'pollinations') {
    return '❌ Pollinations is for image generation only. Use /model auto instead.'
  }

  // Auto fallback chain — text only, no pollinations
  try { return sanitizeHTML(await groqChat(messages)) } catch {}
  try { return sanitizeHTML(await mistralChat(messages)) } catch {}
  try { return sanitizeHTML(await openrouterChat(messages)) } catch {}
  return '❌ All AI providers unavailable. Try again later.'
}

export function fileToGenerativePart(data: Buffer, mimeType: string) {
  return { data: data.toString('base64'), mimeType }
}
