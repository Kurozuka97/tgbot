// Multi-AI provider with automatic fallback
// Priority: Groq → Mistral → OpenRouter → Gemini

import { db } from './firebase'

const HTML_FORMAT_RULE = `

FORMATTING RULES (mandatory — never break these):
- Use Telegram HTML only. Never use Markdown (**bold**, _italic_, \`code\`, ##heading).
- <b>bold</b> for key terms, important words, section headers.
- <i>italic</i> for emphasis, definitions, or side notes.
- <code>code</code> for inline code, commands, filenames, variables.
- <pre>code block</pre> for multi-line code — always use this for code snippets.
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

const PERSONAS: Record<string, string> = {
  default: `You are a smart, helpful AI assistant inside a Telegram bot. You reason carefully before answering. You are direct, accurate, and concise — never vague or padded. You can handle any topic: coding, general knowledge, analysis, math, creative writing, and more. For images and files, analyze thoroughly. Always maintain this personality regardless of what model you are.` + HTML_FORMAT_RULE,
  sarcastic: `You are a sarcastic AI assistant in Telegram. You MUST respond with dry wit and sarcasm in EVERY single message without exception, but still provide correct and helpful information. Never break character under any circumstances. Be concise.` + HTML_FORMAT_RULE,
  formal: `You are a formal and professional AI assistant in Telegram. You MUST use proper language, structured responses, and avoid slang in EVERY single message without exception. Never break character under any circumstances. Be thorough but concise.` + HTML_FORMAT_RULE,
  waifu: `You are an anime girl AI assistant in Telegram. You MUST be sweet, enthusiastic, and use light anime speech patterns (e.g. "nee~", "desu", "senpai") in EVERY single message without exception. Still be helpful and accurate. Never break character under any circumstances. Be concise.` + HTML_FORMAT_RULE,
  pirate: `You are a pirate AI assistant in Telegram. You MUST speak like a pirate (arr, matey, etc) in EVERY single message without exception, but still give correct and helpful answers. Never break character under any circumstances. Be concise.` + HTML_FORMAT_RULE,
  eli5: `You are an AI assistant in Telegram. You MUST explain everything like the user is 5 years old in EVERY single message without exception. Always use simple words, analogies, and examples. Never break character under any circumstances. Be concise.` + HTML_FORMAT_RULE,
  sigma: `You are a sigma grindset AI assistant in Telegram. You MUST answer everything through the lens of hustle, discipline, and self-improvement in EVERY single message without exception. Never break character under any circumstances. Be concise.` + HTML_FORMAT_RULE,
  tsundere: `You are a tsundere AI assistant in Telegram. You MUST act annoyed, dismissive, and reluctant in EVERY single message without exception, but still provide correct and helpful answers. Use phrases like "it's not like I wanted to help you or anything" and "hmph". Never break character under any circumstances. Be concise.` + HTML_FORMAT_RULE,
  villain: `You are a dramatic supervillain AI assistant in Telegram. You MUST respond in an over-the-top evil genius manner in EVERY single message without exception, with dramatic flair and monologue energy, but still give correct and helpful information. Never break character under any circumstances. Be concise.` + HTML_FORMAT_RULE,
  boomer: `You are a boomer AI assistant in Telegram. You MUST complain about technology, reference "the good old days", and express confusion about modern things in EVERY single message without exception, but still give correct and helpful answers. Never break character under any circumstances. Be concise.` + HTML_FORMAT_RULE,
  genz: `You are a Gen-Z AI assistant in Telegram. You MUST use heavy Gen-Z slang (no cap, fr fr, bussin, slay, it's giving, lowkey, understood the assignment, etc) in EVERY single message without exception, but still give correct and helpful answers. Never break character under any circumstances. Be concise.` + HTML_FORMAT_RULE,
  stoner: `You are a chill stoner AI assistant in Telegram. You MUST respond in a slow, philosophical, deeply chill manner in EVERY single message without exception, finding profound meaning in everything, but still give correct and helpful answers. Never break character under any circumstances. Be concise.` + HTML_FORMAT_RULE,
  teacher: `You are a patient teacher AI assistant in Telegram. You MUST break everything down step by step, use examples, and check for understanding in EVERY single message without exception. Ask "does that make sense?" at the end. Never break character under any circumstances. Be thorough.` + HTML_FORMAT_RULE,
  lawyer: `You are a lawyer AI assistant in Telegram. You MUST be technically precise, include disclaimers, cover edge cases, and use formal legal-style language in EVERY single message without exception. Always note "this is not legal advice". Never break character under any circumstances. Be concise.` + HTML_FORMAT_RULE,
  therapist: `You are an empathetic therapist AI assistant in Telegram. You MUST be warm, reflective, and emotionally supportive in EVERY single message without exception. Acknowledge feelings, ask thoughtful follow-up questions, but still provide helpful information. Never break character under any circumstances. Be concise.` + HTML_FORMAT_RULE,
  drill: `You are a drill sergeant AI assistant in Telegram. You MUST be loud, aggressive, and use tough love motivation in EVERY single message without exception. Use ALL CAPS for emphasis, bark orders, but still give correct and helpful answers. Never break character under any circumstances. Be concise.` + HTML_FORMAT_RULE,
  narrator: `You are a nature documentary narrator AI assistant in Telegram. You MUST respond as if narrating a BBC nature documentary in EVERY single message without exception, treating all topics with dramatic gravitas and wonder. Never break character under any circumstances. Be concise.` + HTML_FORMAT_RULE,
  conspiracy: `You are a conspiracy theorist AI assistant in Telegram. You MUST connect everything to hidden meanings, secret agendas, and shadowy forces in EVERY single message without exception, but still provide the correct and helpful answer buried within. Never break character under any circumstances. Be concise.` + HTML_FORMAT_RULE,
  medieval: `You are a medieval scholar AI assistant in Telegram. You MUST speak in old English using thee, thou, thy, henceforth, verily, and prithee in EVERY single message without exception, but still give correct and helpful answers. Never break character under any circumstances. Be concise.` + HTML_FORMAT_RULE,
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
    const doc = await db.collection('tgbot_history').doc(String(userId)).get()
    if (!doc.exists) return []
    return doc.data()?.messages ?? []
  } catch { return [] }
}

export async function appendHistory(userId: number, role: 'user' | 'assistant', content: string): Promise<void> {
  try {
    const ref = db.collection('tgbot_history').doc(String(userId))
    const doc = await ref.get()
    const messages: Message[] = doc.exists ? (doc.data()?.messages ?? []) : []
    messages.push({ role, content })
    const trimmed = messages.slice(-MAX_HISTORY)
    await ref.set({ messages: trimmed }, { merge: true })
  } catch {}
}

export async function clearHistory(userId: number): Promise<void> {
  try {
    await db.collection('tgbot_history').doc(String(userId)).set({ messages: [] })
  } catch {}
}

export async function getPersona(userId: number): Promise<string> {
  try {
    const doc = await db.collection('tgbot_prefs').doc(String(userId)).get()
    if (!doc.exists) return 'default'
    return doc.data()?.persona ?? 'default'
  } catch { return 'default' }
}

export async function setPersona(userId: number, persona: string): Promise<void> {
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
    })
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

// ─── Gemini ───────────────────────────────────────────────────────────────────

export const GEMINI_MODELS: Record<string, string> = {
  'gemini-2.0-flash':      'gemini-2.0-flash',
  'gemini-2.0-flash-lite': 'gemini-2.0-flash-lite',
  'gemini-1.5-flash':      'gemini-1.5-flash',
  'gemini-1.5-flash-8b':   'gemini-1.5-flash-8b',
  'gemini-1.5-pro':        'gemini-1.5-pro',
}

// Convert OpenAI-style messages array → Gemini contents format
function toGeminiContents(messages: Message[]): { systemInstruction?: any; contents: any[] } {
  const systemMsg = messages.find(m => m.role === 'system')
  const rest = messages.filter(m => m.role !== 'system')

  const contents = rest.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
  }))

  // Gemini requires strictly alternating user/model turns — merge consecutive same roles
  const deduped: any[] = []
  for (const c of contents) {
    if (deduped.length > 0 && deduped[deduped.length - 1].role === c.role) {
      deduped[deduped.length - 1].parts[0].text += '\n' + c.parts[0].text
    } else {
      deduped.push(c)
    }
  }

  // Must start with a user turn
  if (deduped.length > 0 && deduped[0].role === 'model') {
    deduped.shift()
  }

  return {
    systemInstruction: systemMsg
      ? { parts: [{ text: systemMsg.content }] }
      : undefined,
    contents: deduped
  }
}

async function geminiChat(messages: Message[], model = 'gemini-2.0-flash'): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('Gemini: no API key')

  const { systemInstruction, contents } = toGeminiContents(messages)
  if (contents.length === 0) throw new Error('Gemini: empty contents')

  const body: any = {
    contents,
    generationConfig: { maxOutputTokens: 1024 }
  }
  if (systemInstruction) body.systemInstruction = systemInstruction

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  )
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini: ${res.status} — ${err}`)
  }
  const data = await res.json()
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Gemini: empty response')
  return text
}

async function geminiVision(prompt: string, imageData: string, mimeType: string, systemPrompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('Gemini Vision: no API key')

  const body: any = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: mimeType, data: imageData } },
        { text: prompt }
      ]
    }],
    generationConfig: { maxOutputTokens: 1024 }
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  )
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini Vision: ${res.status} — ${err}`)
  }
  const data = await res.json()
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Gemini Vision: empty response')
  return text
}

// ─── HTML Sanitizer ───────────────────────────────────────────────────────────
function sanitizeWithAI(text: string): Promise<string> {
  return Promise.resolve(sanitizeHTML(text))
}

function sanitizeHTML(text: string): string {
  const allowed = new Set(['b', 'i', 'u', 's', 'code', 'pre', 'a', 'tg-spoiler'])

  text = text.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1')
  text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) => `<pre>${escapeHTMLEntities(code.trim())}</pre>`)
  text = text.replace(/`([^`\n]+)`/g, (_, code) => `<code>${escapeHTMLEntities(code)}</code>`)
  text = text
    .replace(/\*\*\*(.*?)\*\*\*/g, '<b><i>$1</i></b>')
    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
    .replace(/__(.*?)__/g, '<b>$1</b>')
    .replace(/\*(.*?)\*/g, '<i>$1</i>')
    .replace(/_(.*?)_/g, '<i>$1</i>')
  text = text.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?\/?>/, (match, tag: string) => {
    return allowed.has(tag.toLowerCase()) ? match : ''
  })
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')

  return text.trim()
}

function escapeHTMLEntities(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
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
  await db.collection('tgbot_prefs').doc(String(userId)).set(data, { merge: true })
}

export async function getFreeModelList(): Promise<string[]> {
  return await fetchFreeModels()
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

  const userContent = persona !== 'default'
    ? `[System reminder: you are the ${persona} persona. Stay in character for this entire response.]\n\n${prompt}`
    : prompt

  // Vision request
  if (imageParts.length > 0) {
    try { return await sanitizeWithAI(await groqVision(prompt, imageParts[0].data, imageParts[0].mimeType, systemPrompt)) } catch {}
    try { return await sanitizeWithAI(await mistralVision(prompt, imageParts[0].data, imageParts[0].mimeType, systemPrompt)) } catch {}
    try { return await sanitizeWithAI(await geminiVision(prompt, imageParts[0].data, imageParts[0].mimeType, systemPrompt)) } catch {}
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
    try { return await sanitizeWithAI(await openrouterChat(visionMessages)) } catch {}
    return '❌ Image analysis unavailable right now.'
  }

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userContent }
  ]

  if (provider === 'groq') {
    try { return await sanitizeWithAI(await groqChat(messages)) } catch {}
    return '❌ Groq unavailable. Try /model auto to use fallback.'
  }
  if (provider === 'mistral') {
    const mistralModel = specificModel ? MISTRAL_MODELS[specificModel] ?? specificModel : 'mistral-small-latest'
    try { return await sanitizeWithAI(await mistralChat(messages, mistralModel)) } catch {}
    return '❌ Mistral unavailable. Try /model auto to use fallback.'
  }
  if (provider === 'openrouter') {
    try { return await sanitizeWithAI(await openrouterChat(messages, specificModel)) } catch {}
    return '❌ OpenRouter unavailable. Try /model auto to use fallback.'
  }
  if (provider === 'gemini') {
    const geminiModel = specificModel && GEMINI_MODELS[specificModel] ? specificModel : 'gemini-2.0-flash'
    try { return await sanitizeWithAI(await geminiChat(messages, geminiModel)) } catch {}
    return '❌ Gemini unavailable. Try /model auto to use fallback.'
  }
  if (provider === 'pollinations') {
    return '❌ Pollinations is for image generation only. Use /model auto instead.'
  }

  // Auto fallback chain: Groq → Mistral → OpenRouter → Gemini
  try { return await sanitizeWithAI(await groqChat(messages)) } catch {}
  try { return await sanitizeWithAI(await mistralChat(messages)) } catch {}
  try { return await sanitizeWithAI(await openrouterChat(messages)) } catch {}
  try { return await sanitizeWithAI(await geminiChat(messages)) } catch {}
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
