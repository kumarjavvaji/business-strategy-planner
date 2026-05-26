// Reusable AI client — OpenAI-compatible chat completions via browser fetch.
// No backend proxy. API key from Vite env var: VITE_OPENAI_API_KEY in .env.local
//
// Usage:
//   import { hasApiKey, callAI } from '../api/aiClient'
//   const { result, error } = await callAI(messages, options)
//
// Always returns { result: string|null, error: string|null }.
// Caller decides what to do with a null result — never throws.

const API_BASE      = 'https://api.openai.com/v1'
const DEFAULT_MODEL = 'gpt-4o'
const TIMEOUT_MS    = 45_000

/**
 * Returns true if a VITE_OPENAI_API_KEY is present in the Vite env.
 * Use this to decide between AI mode and mock mode before calling callAI().
 */
export function hasApiKey() {
  return !!(import.meta.env.VITE_OPENAI_API_KEY)
}

/**
 * Calls the OpenAI chat completions endpoint.
 *
 * @param {Array<{ role: 'system'|'user'|'assistant', content: string }>} messages
 * @param {{ model?: string, temperature?: number, maxTokens?: number }} options
 * @returns {Promise<{ result: string|null, error: string|null }>}
 */
export async function callAI(messages, options = {}) {
  const key = import.meta.env.VITE_OPENAI_API_KEY
  if (!key) {
    return {
      result: null,
      error:  'No API key found. Add VITE_OPENAI_API_KEY to .env.local and restart the dev server.',
    }
  }

  const {
    model       = DEFAULT_MODEL,
    temperature = 0.3,
    maxTokens   = 2500,
  } = options

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch(`${API_BASE}/chat/completions`, {
      method:  'POST',
      signal:  controller.signal,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        messages,
      }),
    })

    clearTimeout(timer)

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      let msg = `API error ${response.status}`
      try {
        const parsed = JSON.parse(body)
        if (parsed?.error?.message) msg = parsed.error.message
      } catch { /* ignore */ }
      return { result: null, error: msg }
    }

    const data = await response.json()
    const text = data?.choices?.[0]?.message?.content ?? null
    if (!text) return { result: null, error: 'API returned an empty response.' }
    return { result: text, error: null }

  } catch (err) {
    clearTimeout(timer)
    if (err.name === 'AbortError') {
      return { result: null, error: `Request timed out after ${TIMEOUT_MS / 1000} seconds.` }
    }
    return { result: null, error: err?.message || 'Network error — check your connection.' }
  }
}
