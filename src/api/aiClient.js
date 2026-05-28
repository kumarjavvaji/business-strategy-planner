// Reusable AI client — Anthropic Messages API via browser fetch.
// No backend proxy. API key from Vite env var: VITE_ANTHROPIC_API_KEY in .env.local
//
// Usage:
//   import { hasApiKey, callAI, getApiMode } from '../api/aiClient'
//   const { result, error } = await callAI(messages, options)
//
// Messages format: [{ role: 'system'|'user'|'assistant', content: string }]
//   system-role messages are extracted and passed as Anthropic's top-level `system` param.
//
// Always returns { result: string|null, error: string|null } — never throws.

const ANTHROPIC_BASE    = 'https://api.anthropic.com/v1'
const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MODEL     = 'claude-sonnet-4-6'
const TIMEOUT_MS        = 120_000

// ── Key detection ─────────────────────────────────────────────────────────────

/**
 * Returns true if an Anthropic API key is present in the Vite env.
 * Use this to decide between AI mode and mock mode before calling callAI().
 */
export function hasApiKey() {
  return !!(import.meta.env.VITE_ANTHROPIC_API_KEY)
}

/**
 * Returns a human-readable mode string for UI display.
 *   'ai'   — key present, AI calls enabled
 *   'mock' — key missing, mock mode only
 */
export function getApiMode() {
  return hasApiKey() ? 'ai' : 'mock'
}

// ── Main client ───────────────────────────────────────────────────────────────

/**
 * Calls the Anthropic Messages endpoint.
 *
 * Accepts OpenAI-style messages array for convenience.
 * Any message with role 'system' is extracted and sent as the top-level
 * `system` parameter; remaining messages are sent in the `messages` array.
 *
 * @param {Array<{ role: 'system'|'user'|'assistant', content: string }>} messages
 * @param {{ model?: string, temperature?: number, maxTokens?: number, timeoutMs?: number }} options
 * @returns {Promise<{ result: string|null, error: string|null, status?: number, rateLimited?: boolean, stopReason?: string, usage?: object, model?: string }>}
 */
export async function callAI(messages, options = {}) {
  const key = import.meta.env.VITE_ANTHROPIC_API_KEY
  if (!key) {
    return {
      result: null,
      error:  'No API key found. Add VITE_ANTHROPIC_API_KEY to .env.local and restart the dev server.',
    }
  }

  const {
    model       = DEFAULT_MODEL,
    temperature = 0.3,
    maxTokens   = 2500,
    timeoutMs   = TIMEOUT_MS,
  } = options

  // Extract system prompt; Anthropic requires it at the top level, not in messages[]
  const systemContent  = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  const chatMessages   = messages.filter(m => m.role !== 'system')

  if (chatMessages.length === 0) {
    return { result: null, error: 'No user messages provided.' }
  }

  const controller = new AbortController()
  const timer      = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const body = {
      model,
      max_tokens:  maxTokens,
      temperature,
      messages:    chatMessages,
      ...(systemContent ? { system: systemContent } : {}),
    }

    const response = await fetch(`${ANTHROPIC_BASE}/messages`, {
      method:  'POST',
      signal:  controller.signal,
      headers: {
        'Content-Type':                          'application/json',
        'x-api-key':                             key,
        'anthropic-version':                     ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    })

    clearTimeout(timer)

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      let msg = `Anthropic API error ${response.status}`
      try {
        const parsed = JSON.parse(bodyText)
        if (parsed?.error?.message) msg = parsed.error.message
      } catch { /* ignore */ }
      return {
        result: null,
        error: msg,
        status: response.status,
        rateLimited: response.status === 429,
        model,
      }
    }

    const data = await response.json()

    // Anthropic response shape: { content: [{ type: 'text', text: '...' }] }
    const text = data?.content?.find?.(c => c.type === 'text')?.text ?? null
    if (!text) {
      return {
        result: null,
        error: 'Anthropic API returned an empty response.',
        stopReason: data?.stop_reason,
        usage: data?.usage || null,
        model: data?.model || model,
      }
    }
    return {
      result: text,
      error: null,
      stopReason: data?.stop_reason,
      usage: data?.usage || null,
      model: data?.model || model,
    }

  } catch (err) {
    clearTimeout(timer)
    if (err.name === 'AbortError') {
      return { result: null, error: `Request timed out after ${timeoutMs / 1000} seconds.` }
    }
    return { result: null, error: err?.message || 'Network error — check your connection.' }
  }
}

// ── Named model constant for display ─────────────────────────────────────────
export const AI_MODEL_LABEL = 'Claude (claude-sonnet-4-6)'
