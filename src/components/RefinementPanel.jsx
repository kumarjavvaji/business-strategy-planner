// RefinementPanel - stage-agnostic correction/refinement input.
// Supports synchronous manual note saves and async AI regeneration callbacks.

import React, { useState } from 'react'

const DEFAULT_SUBTITLE = (
  'Describe a correction, context addition, or clarification you want to record against the current stage. ' +
  'This creates a revision snapshot you can compare with earlier versions.'
)

const DEFAULT_PLACEHOLDER = (
  'e.g. The target customer should also include VP of Finance, not just CFO. ' +
  'The readiness level needs updating because internal tooling inventory was just completed.'
)

export default function RefinementPanel({
  onSaveRevision,
  title             = 'Refinement & Corrections',
  subtitle          = DEFAULT_SUBTITLE,
  saveLabel         = 'Save Stage 1 revision',
  promptLabel       = 'Refinement prompt',
  promptPlaceholder = DEFAULT_PLACEHOLDER,
  aiNotice,
  isSaving = false,
}) {
  const [prompt,        setPrompt]        = useState('')
  const [impactSummary, setImpactSummary] = useState('')
  const [saved,         setSaved]         = useState(false)
  const [error,         setError]         = useState(null)

  async function handleSave() {
    if (!prompt.trim() || isSaving) return
    setError(null)

    const result = await onSaveRevision({
      prompt:        prompt.trim(),
      impactSummary: impactSummary.trim(),
    })

    if (result?.error) {
      setError(result.error)
      return
    }

    setSaved(true)
    setTimeout(() => {
      setPrompt('')
      setImpactSummary('')
      setSaved(false)
    }, 1800)
  }

  const canSave = prompt.trim().length > 0 && !isSaving

  const showDefaultNotice = aiNotice === undefined
  const noticeText        = showDefaultNotice ? 'AI regeneration not enabled' : (typeof aiNotice === 'string' ? aiNotice : null)

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--r)', overflow: 'hidden', marginBottom: 10,
    }}>
      <div style={{
        padding: '10px 15px',
        display: 'flex', alignItems: 'center', gap: 8,
        borderBottom: '1px solid var(--border)',
      }}>
        <span style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--accent)', flexShrink: 0 }}>
          {'->'}
        </span>
        <span style={{ fontSize: 11, fontWeight: 600, flex: 1 }}>
          {title}
        </span>
        {noticeText && (
          <span style={{
            fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)',
            padding: '1px 6px', borderRadius: 3,
            background: 'var(--s2)', border: '1px solid var(--border)',
          }}>
            {noticeText}
          </span>
        )}
      </div>

      <div style={{ padding: '13px 15px' }}>
        <div style={{ fontSize: 10, color: 'var(--muted2)', lineHeight: 1.65, marginBottom: 14, fontFamily: 'var(--fm)' }}>
          {subtitle}
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{
            fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5,
          }}>
            {promptLabel} <span style={{ color: '#f87171' }}>*</span>
          </div>
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            rows={4}
            placeholder={promptPlaceholder}
            disabled={isSaving}
            style={{
              width: '100%', boxSizing: 'border-box',
              fontSize: 10, fontFamily: 'var(--fm)',
              color: 'var(--text)', background: 'var(--s2)',
              border: '1px solid var(--border)', borderRadius: 5,
              padding: '8px 10px', resize: 'vertical', outline: 'none',
              lineHeight: 1.65, opacity: isSaving ? 0.65 : 1,
            }}
          />
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={{
            fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5,
          }}>
            Impact summary <span style={{ opacity: .5 }}>(optional)</span>
          </div>
          <textarea
            value={impactSummary}
            onChange={e => setImpactSummary(e.target.value)}
            rows={2}
            placeholder="e.g. Widens persona scope; downstream stages should reflect the new owner."
            disabled={isSaving}
            style={{
              width: '100%', boxSizing: 'border-box',
              fontSize: 10, fontFamily: 'var(--fm)',
              color: 'var(--text)', background: 'var(--s2)',
              border: '1px solid var(--border)', borderRadius: 5,
              padding: '8px 10px', resize: 'vertical', outline: 'none',
              lineHeight: 1.65, opacity: isSaving ? 0.65 : 1,
            }}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={handleSave}
            disabled={!canSave || saved}
            style={{
              fontSize: 10, fontFamily: 'var(--fm)', fontWeight: 600,
              padding: '6px 18px', borderRadius: 5,
              cursor: canSave && !saved ? 'pointer' : 'not-allowed',
              background: canSave && !saved ? 'var(--accent)' : 'var(--s2)',
              border: `1px solid ${canSave && !saved ? 'var(--accent)' : 'var(--border)'}`,
              color: canSave && !saved ? '#000' : 'var(--muted)',
              opacity: canSave || saved || isSaving ? 1 : 0.55,
              transition: 'background .15s, color .15s, border-color .15s',
            }}
          >
            {isSaving ? 'Regenerating...' : saved ? 'Saved' : saveLabel}
          </button>
          {!canSave && !saved && !isSaving && (
            <span style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
              Enter a prompt to save.
            </span>
          )}
          {isSaving && (
            <span style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
              Updating the stage snapshot.
            </span>
          )}
        </div>

        {error && (
          <div style={{
            marginTop: 8, fontSize: 9, fontFamily: 'var(--fm)',
            color: '#f87171', lineHeight: 1.6,
            padding: '6px 9px', borderRadius: 4,
            background: 'rgba(248,113,113,.07)',
            border: '1px solid rgba(248,113,113,.25)',
          }}>
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
