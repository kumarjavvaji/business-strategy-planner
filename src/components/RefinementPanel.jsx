// RefinementPanel — Stage-agnostic correction-intent logger.
// No AI calls. Prompts the user to describe what changed and why, then
// saves a new revision snapshot via onSaveRevision().
//
// Props:
//   onSaveRevision    (required) — ({ prompt, impactSummary }) => void
//   title             (optional) — panel header title. Default: "Refinement & Corrections"
//   subtitle          (optional) — description below the header. Default: generic Stage 1 text.
//   saveLabel         (optional) — save button text. Default: "Save Stage 1 revision"
//   promptLabel       (optional) — label for the prompt field. Default: "Refinement prompt"
//   promptPlaceholder (optional) — placeholder text for the prompt textarea.
//   aiNotice          (optional) — string | null | false
//                                   string → show custom notice badge
//                                   null/false → hide the notice entirely
//                                   undefined (not passed) → show default "AI regeneration not enabled"

import React, { useState } from 'react'

const DEFAULT_SUBTITLE = (
  'Describe a correction, context addition, or clarification you want to record against the current stage. ' +
  'This creates a revision snapshot you can compare with earlier versions.'
)

const DEFAULT_PLACEHOLDER = (
  'e.g. The target customer should also include VP of Finance, not just CFO. ' +
  'The readiness level needs updating — internal tooling inventory was just completed.'
)

export default function RefinementPanel({
  onSaveRevision,
  title             = 'Refinement & Corrections',
  subtitle          = DEFAULT_SUBTITLE,
  saveLabel         = 'Save Stage 1 revision',
  promptLabel       = 'Refinement prompt',
  promptPlaceholder = DEFAULT_PLACEHOLDER,
  aiNotice,           // undefined → default badge | null/false → hidden | string → custom
}) {
  const [prompt,        setPrompt]        = useState('')
  const [impactSummary, setImpactSummary] = useState('')
  const [saved,         setSaved]         = useState(false)

  function handleSave() {
    if (!prompt.trim()) return
    onSaveRevision({ prompt: prompt.trim(), impactSummary: impactSummary.trim() })
    setSaved(true)
    setTimeout(() => {
      setPrompt('')
      setImpactSummary('')
      setSaved(false)
    }, 1800)
  }

  const canSave = prompt.trim().length > 0

  // Determine what notice badge (if any) to show
  const showDefaultNotice = aiNotice === undefined
  const noticeText        = showDefaultNotice ? 'AI regeneration not enabled' : (typeof aiNotice === 'string' ? aiNotice : null)

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--r)', overflow: 'hidden', marginBottom: 10,
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 15px',
        display: 'flex', alignItems: 'center', gap: 8,
        borderBottom: '1px solid var(--border)',
      }}>
        <span style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--accent)', flexShrink: 0 }}>
          ↻
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

        {/* Prompt field */}
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
            style={{
              width: '100%', boxSizing: 'border-box',
              fontSize: 10, fontFamily: 'var(--fm)',
              color: 'var(--text)', background: 'var(--s2)',
              border: '1px solid var(--border)', borderRadius: 5,
              padding: '8px 10px', resize: 'vertical', outline: 'none',
              lineHeight: 1.65,
            }}
          />
        </div>

        {/* Impact summary field */}
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
            placeholder="e.g. Widens persona scope; Stage 2 BU mapping should now include Finance org."
            style={{
              width: '100%', boxSizing: 'border-box',
              fontSize: 10, fontFamily: 'var(--fm)',
              color: 'var(--text)', background: 'var(--s2)',
              border: '1px solid var(--border)', borderRadius: 5,
              padding: '8px 10px', resize: 'vertical', outline: 'none',
              lineHeight: 1.65,
            }}
          />
        </div>

        {/* Save button */}
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
              opacity: canSave || saved ? 1 : 0.55,
              transition: 'background .15s, color .15s, border-color .15s',
            }}
          >
            {saved ? '✓ Saved' : saveLabel}
          </button>
          {!canSave && !saved && (
            <span style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
              Enter a prompt to save.
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
