// Multi-AI provider with automatic fallback
// Priority: Groq → Mistral → OpenRouter (rotate free models) → Pollinations

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

// ─── Mistral ──────────────────────────────────────────────────────────────────
async function mistralChat(messages: Message[], model = 'mistral-small-latest'): Promise<string> {
  const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`
    },
    body: JSON.stringify({ model, messages, max_tokens: 1024 })
  })
  if (!res.ok) throw new Error(`Mistral: ${res.status}`)
  const data = await res.json()
  return data.choices[0].message.content
}

async function mistralVision(prompt: string, imageData: string, mimeType: string): Promise<string> {
  const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`
    },
    body: JSON.stringify({
      model: 'pixtral-large-latest',
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
export async function getUserProvider(userId: number): Promise<{ provider: string; model?: string }> {
  try {
    const doc = await db.collection('tgbot_prefs').doc(String(userId)).get()
    if (!doc.exists) return { provider: 'auto' }
    const data = doc.data()!
    return { provider: data.provider ?? 'auto', model: data.model }
  } catch {
    return { provider: 'auto' }
  }
}

export async function setUserProvider(userId: number, provider: string, model?: string): Promise<void> {
  const data: any = { provider }
  if (model) data.model = model
  else data.model = null
  await db.collection('tgbot_prefs').doc(String(userId)).set(data)
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
  const pref = userId ? await getUserProvider(userId) : { provider: 'auto' }
  const { provider, model: specificModel } = pref

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
    try { return await mistralVision(prompt, imageParts[0].data, imageParts[0].mimeType) } catch {}
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
  if (provider === 'mistral') {
    const mistralModel = specificModel ? MISTRAL_MODELS[specificModel] ?? specificModel : 'mistral-small-latest'
    try { return await mistralChat(messages, mistralModel) } catch {}
    return '❌ Mistral unavailable. Try /model auto to use fallback.'
  }
  if (provider === 'openrouter') {
    try { return await openrouterChat(messages, specificModel) } catch {}
    return '❌ OpenRouter unavailable. Try /model auto to use fallback.'
  }
  if (provider === 'pollinations') {
    try { return await pollinationsChat(prompt) } catch {}
    return '❌ Pollinations unavailable. Try /model auto to use fallback.'
  }

  // Auto fallback chain: Groq → Mistral → OpenRouter → Pollinations
  try { return await groqChat(messages) } catch {}
  try { return await mistralChat(messages) } catch {}
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
