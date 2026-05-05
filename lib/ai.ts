// Multi-AI provider with automatic fallback
// Priority: Groq → OpenRouter (rotate all free models) → Pollinations (text)

import { db } from './firebase'

const SYSTEM_PROMPT = `You are a helpful multipurpose AI assistant in Telegram.
Be concise, friendly, and useful. Support markdown formatting.
For images and files, analyze thoroughly and describe what you see.`

interface Message {
  role: 'system' | 'user' | 'assistant'
  content: any
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
    })
  })
  if (!res.ok) throw new Error(`Groq: ${res.status}`)
  const data = await res.json()
  return data.choices[0].message.content
}

async function groqVision(prompt: string, imageData: string, mimeType: string): Promise<string> {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: 'llama-3.2-11b-vision-preview',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageData}` } },
            { type: 'text', text: prompt }
          ]
        }
      ],
      max_tokens: 1024
    })
  })
  if (!res.ok) throw new Error(`Groq Vision: ${res.status}`)
  const data = await res.json()
  return data.choices[0].message.content
}

// ─── OpenRouter (auto-fetch & rotate all free models) ────────────────────────
let freeModels: string[] = []
let modelIndex = 0
let lastFetched = 0

async function fetchFreeModels(): Promise<string[]> {
  const now = Date.now()
  if (freeModels.length > 0 && now - lastFetched < 3600000) return freeModels

  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` }
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
  console.log(`Loaded ${freeModels.length} free OpenRouter models`)
  return freeModels
}

async function openrouterChat(messages: Message[]): Promise<string> {
  const models = await fetchFreeModels()
  if (models.length === 0) throw new Error('No free models available')

  const model = models[modelIndex % models.length]
  modelIndex++

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://kurotgbot.vercel.app',
      'X-Title': 'KuroTGBot'
    },
    body: JSON.stringify({ model, messages, max_tokens: 1024 })
  })
  if (!res.ok) throw new Error(`OpenRouter: ${res.status}`)
  const data = await res.json()
  return data.choices[0].message.content
}

// ─── Pollinations text (no key, last resort) ──────────────────────────────────
async function pollinationsChat(prompt: string): Promise<string> {
  const res = await fetch(`https://text.pollinations.ai/${encodeURIComponent(prompt)}`)
  if (!res.ok) throw new Error(`Pollinations: ${res.status}`)
  return await res.text()
}

// ─── User model preference (Firestore) ───────────────────────────────────────
export async function getUserProvider(userId: number): Promise<string> {
  try {
    const doc = await db.collection('tgbot_prefs').doc(String(userId)).get()
    return doc.exists ? (doc.data()?.provider ?? 'auto') : 'auto'
  } catch {
    return 'auto'
  }
}

export async function setUserProvider(userId: number, provider: string): Promise<void> {
  await db.collection('tgbot_prefs').doc(String(userId)).set({ provider })
}

export async function getFreeModelList(): Promise<string[]> {
  return await fetchFreeModels()
}

// ─── Public API ──────────────────────────────────────────────────────────────
export async function chat(
  prompt: string,
  imageParts: { data: string; mimeType: string }[] = [],
  userId?: number
): Promise<string> {
  const provider = userId ? await getUserProvider(userId) : 'auto'

  // Vision request
  if (imageParts.length > 0) {
    const visionMessages: Message[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${imageParts[0].mimeType};base64,${imageParts[0].data}` } },
          { type: 'text', text: prompt }
        ]
      }
    ]
    try { return await groqVision(prompt, imageParts[0].data, imageParts[0].mimeType) } catch {}
    try { return await openrouterChat(visionMessages) } catch {}
    return '❌ Image analysis unavailable right now.'
  }

  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt }
  ]

  // User-selected provider
  if (provider === 'groq') {
    try { return await groqChat(messages) } catch {}
    return '❌ Groq unavailable. Try /model auto to use fallback.'
  }
  if (provider === 'openrouter') {
    try { return await openrouterChat(messages) } catch {}
    return '❌ OpenRouter unavailable. Try /model auto to use fallback.'
  }
  if (provider === 'pollinations') {
    try { return await pollinationsChat(prompt) } catch {}
    return '❌ Pollinations unavailable. Try /model auto to use fallback.'
  }

  // Auto fallback chain
  try { return await groqChat(messages) } catch {}
  try { return await openrouterChat(messages) } catch {}
  try { return await pollinationsChat(prompt) } catch {}
  return '❌ All AI providers unavailable. Try again later.'
}

export async function chatWithSearch(prompt: string, userId?: number): Promise<string> {
  return await chat(
    `You are a web search assistant. Answer the following query with up-to-date knowledge, structured clearly with key points. Query: ${prompt}`,
    [],
    userId
  )
}

export function fileToGenerativePart(data: Buffer, mimeType: string) {
  return { data: data.toString('base64'), mimeType }
}
