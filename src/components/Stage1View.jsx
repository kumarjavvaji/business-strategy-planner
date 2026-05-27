// Stage 1 — Strategy Basis Review
// Reads from the normalized workspace model. Never accesses the raw package.
//
// AI regeneration:
//   When VITE_ANTHROPIC_API_KEY is configured, the refinement panel offers
//   "Regenerate with AI" — applies a refinement prompt to the current document,
//   updates the normalized workspace, and saves a new Stage 1 revision.
//   This invalidates any existing Stage 2 revisions (they track sourceBasisRevisionId).
//
// Manual correction notes:
//   Preserved in full when API key is absent. Creates a revision snapshot for
//   diff/history purposes but does not modify the displayed content.

import React, { useState, useCallback } from 'react'
import RevisionHistory    from './RevisionHistory'
import RevisionDiffViewer from './RevisionDiffViewer'
import LearningSignals    from './LearningSignals'
import { hasApiKey, callAI, getApiMode, AI_MODEL_LABEL } from '../api/aiClient'
import { buildStage1Messages, parseStage1Response, applyStage1PatchToWorkspace } from '../utils/stage1Prompts'
import { buildStage1Snapshot, buildStage1AIRevision } from '../utils/stageSnapshots'
import { deriveLearningSignals, buildLearningSignalMessages, parseLearningSignalResponse, normalizeLearningSignals } from '../utils/learningSignals'

// ── Posture colour map ────────────────────────────────────────────────────────
const POSTURE_COLORS = {
  'double down':          '#00e5b4',
  'selective investment': '#3b82f6',
  'maintain':             '#fb923c',
  'deprioritize':         'rgba(255,255,255,.38)',
  'divest/reallocate':    '#f87171',
}
function postureColor(type) {
  return POSTURE_COLORS[(type || '').toLowerCase()] || '#3b82f6'
}

// ── Small reusable primitives ─────────────────────────────────────────────────

function Badge({ children, color }) {
  const c = color || 'rgba(255,255,255,.38)'
  return (
    <span style={{
      fontSize: 8, fontFamily: 'var(--fm)', padding: '2px 7px', borderRadius: 3,
      color: c, background: `${c}18`, border: `1px solid ${c}30`,
      display: 'inline-block', lineHeight: 1.6,
    }}>
      {children}
    </span>
  )
}

function Field({ label, value }) {
  if (!value) return null
  return (
    <div style={{ marginBottom: 11 }}>
      <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted2)', lineHeight: 1.75 }}>{value}</div>
    </div>
  )
}

function ItemList({ items, borderColor }) {
  const bc = borderColor || 'var(--border2)'
  if (!items?.length) {
    return <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--fm)' }}>None recorded.</div>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {items.map((item, i) => (
        <div key={i} style={{
          fontSize: 10, color: 'var(--muted2)', lineHeight: 1.7,
          paddingLeft: 10, borderLeft: `2px solid ${bc}`,
        }}>
          {item}
        </div>
      ))}
    </div>
  )
}

function Section({ title, label, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--r)', marginBottom: 10, overflow: 'hidden',
    }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          padding: '10px 15px', cursor: 'pointer', userSelect: 'none',
          display: 'flex', alignItems: 'center', gap: 8,
          borderBottom: open ? '1px solid var(--border)' : 'none',
        }}
      >
        {label && (
          <span style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--accent)', flexShrink: 0 }}>
            {label}
          </span>
        )}
        <span style={{ fontSize: 11, fontWeight: 600, flex: 1 }}>{title}</span>
        <span style={{ fontSize: 9, color: 'var(--muted)' }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && <div style={{ padding: '13px 15px' }}>{children}</div>}
    </div>
  )
}

async function collectStage1LearningSignals(context, useAI) {
  const heuristic = deriveLearningSignals({ stage: 'Stage 1', ...context })
  if (!useAI) return heuristic
  const { messages } = buildLearningSignalMessages({ stage: 'Stage 1', ...context })
  const { result } = await callAI(messages, { temperature: 0.2, maxTokens: 900, timeoutMs: 15000 })
  return normalizeLearningSignals([...heuristic, ...parseLearningSignalResponse(result, 'Stage 1')], 'Stage 1')
}

// ── Stage 1 Refinement Panel ──────────────────────────────────────────────────
// Handles both AI-assisted regeneration (when key is present) and manual
// correction notes (when no key). Owned by Stage1View to keep AI state local.

function Stage1RefinementPanel({
  apiMode,
  workspace,
  currentSnapshot,
  stageRevisions,
  onSaveRevision,      // ({ prompt, impactSummary }) => void  — manual path
  onSaveRawRevision,   // (record, patchedWorkspace) => void   — AI path
}) {
  const [prompt,      setPrompt]      = useState('')
  const [impact,      setImpact]      = useState('')
  const [isRegen,     setIsRegen]     = useState(false)
  const [regenError,  setRegenError]  = useState(null)
  const [rawResponse, setRawResponse] = useState(null)
  const [showRaw,     setShowRaw]     = useState(false)
  const [savedCount,  setSavedCount]  = useState(0)   // bump to show "✓" briefly

  const isAI    = apiMode === 'ai'
  const canSave = prompt.trim().length > 0 && !isRegen

  async function handleSubmit() {
    if (!canSave) return
    const p = prompt.trim()
    const i = impact.trim()

    if (isAI) {
      setIsRegen(true)
      setRegenError(null)
      setRawResponse(null)
      setShowRaw(false)

      const snapshot = currentSnapshot
      if (!snapshot) {
        setRegenError('No active Stage 1 revision snapshot found.')
        setIsRegen(false)
        return
      }

      const { messages } = buildStage1Messages(snapshot, p)
      const { result, error } = await callAI(messages, { temperature: 0.2, maxTokens: 5000 })

      if (error) {
        setRegenError(error)
        setIsRegen(false)
        return
      }

      setRawResponse(result)
      const { patch, error: parseError } = parseStage1Response(result)

      if (parseError || !patch) {
        setRegenError(parseError || 'Failed to parse AI response.')
        setIsRegen(false)
        return
      }

      const patchedWorkspace = applyStage1PatchToWorkspace(workspace, patch)
      const newSnapshot      = buildStage1Snapshot(patchedWorkspace)
      const nextRevNum       = (stageRevisions?.length || 0) + 1
      const autoImpact       = i || `AI refinement: ${p.slice(0, 100)}${p.length > 100 ? '…' : ''}`
      const learningSignals  = await collectStage1LearningSignals({
        source: 'ai',
        prompt: p,
        impactSummary: autoImpact,
        refinementType: 'stage',
        beforeAfterSummary: 'Stage 1 strategy basis refined with AI; Stage 2 becomes stale through source revision lineage.',
        stalenessEvents: ['Stage 2'],
      }, true)
      const record           = buildStage1AIRevision(newSnapshot, nextRevNum, p, autoImpact, learningSignals)

      onSaveRawRevision(record, patchedWorkspace)

      setPrompt('')
      setImpact('')
      setIsRegen(false)
      setSavedCount(c => c + 1)
      setTimeout(() => setSavedCount(c => Math.max(0, c - 1)), 2500)

    } else {
      // Manual correction note — saves snapshot of current workspace
      const learningSignals = deriveLearningSignals({
        stage: 'Stage 1',
        source: 'manual',
        prompt: p,
        impactSummary: i,
        refinementType: 'stage',
        stalenessEvents: ['Stage 2'],
      })
      onSaveRevision({ prompt: p, impactSummary: i, learningSignals })
      setPrompt('')
      setImpact('')
      setSavedCount(c => c + 1)
      setTimeout(() => setSavedCount(c => Math.max(0, c - 1)), 1800)
    }
  }

  const justSaved = savedCount > 0

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
          {isAI ? 'Refine with AI' : 'Correction Note'}
        </span>
        {isAI ? (
          <span style={{
            fontSize: 8, fontFamily: 'var(--fm)',
            display: 'flex', alignItems: 'center', gap: 4, color: '#00e5b4',
          }}>
            <span style={{
              display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
              background: '#00e5b4', flexShrink: 0,
            }} />
            {AI_MODEL_LABEL}
          </span>
        ) : (
          <span style={{
            fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)',
            padding: '1px 6px', borderRadius: 3,
            background: 'var(--s2)', border: '1px solid var(--border)',
          }}>
            manual note
          </span>
        )}
      </div>

      <div style={{ padding: '13px 15px' }}>
        <div style={{ fontSize: 10, color: 'var(--muted2)', lineHeight: 1.65, marginBottom: 14, fontFamily: 'var(--fm)' }}>
          {isAI
            ? `Describe what to refine — the model will update only the impacted fields while preserving unchanged content. Creates a new Stage 1 revision and marks Stage 2 as stale.`
            : `Record a correction or context note against the current document. Creates a revision snapshot for diff/compare without modifying the displayed content.`
          }
        </div>

        {/* Prompt textarea */}
        <div style={{ marginBottom: 12 }}>
          <div style={{
            fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5,
          }}>
            {isAI ? 'Refinement instruction' : 'Correction / context note'}{' '}
            <span style={{ color: '#f87171' }}>*</span>
          </div>
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            rows={4}
            disabled={isRegen}
            placeholder={isAI
              ? 'e.g. Update the strategic thesis to reflect the new OCC effective date (May 2026). Add a readiness warning about the missing gap audit. Elevate confidence to High given the validation evidence gathered in Sprint 1.'
              : 'e.g. The target customer should also include VP of Finance, not just CFO. The readiness level needs updating — internal tooling inventory was just completed.'
            }
            style={{
              width: '100%', boxSizing: 'border-box',
              fontSize: 10, fontFamily: 'var(--fm)',
              color: 'var(--text)', background: 'var(--s2)',
              border: '1px solid var(--border)', borderRadius: 5,
              padding: '8px 10px', resize: 'vertical', outline: 'none',
              lineHeight: 1.65, opacity: isRegen ? 0.6 : 1,
            }}
          />
        </div>

        {/* Impact summary */}
        <div style={{ marginBottom: 14 }}>
          <div style={{
            fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5,
          }}>
            Impact summary <span style={{ opacity: .5 }}>(optional)</span>
          </div>
          <textarea
            value={impact}
            onChange={e => setImpact(e.target.value)}
            rows={2}
            disabled={isRegen}
            placeholder="e.g. Widens the compliance timeline — Stage 2 BU mapping for Legal & Compliance should be regenerated."
            style={{
              width: '100%', boxSizing: 'border-box',
              fontSize: 10, fontFamily: 'var(--fm)',
              color: 'var(--text)', background: 'var(--s2)',
              border: '1px solid var(--border)', borderRadius: 5,
              padding: '8px 10px', resize: 'vertical', outline: 'none',
              lineHeight: 1.65, opacity: isRegen ? 0.6 : 1,
            }}
          />
        </div>

        {/* CTA row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button
            onClick={handleSubmit}
            disabled={!canSave || justSaved}
            style={{
              fontSize: 10, fontFamily: 'var(--fm)', fontWeight: 600,
              padding: '6px 18px', borderRadius: 5,
              cursor: canSave && !justSaved ? 'pointer' : 'not-allowed',
              background: canSave && !justSaved ? 'var(--accent)' : 'var(--s2)',
              border: `1px solid ${canSave && !justSaved ? 'var(--accent)' : 'var(--border)'}`,
              color: canSave && !justSaved ? '#000' : 'var(--muted)',
              opacity: (canSave || justSaved) ? 1 : 0.55,
              transition: 'background .15s, color .15s',
            }}
          >
            {justSaved
              ? '✓ Saved'
              : isRegen
              ? 'Regenerating…'
              : isAI
              ? 'Regenerate with AI'
              : 'Save correction note'
            }
          </button>
          {!canSave && !isRegen && !justSaved && (
            <span style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
              Enter {isAI ? 'a refinement instruction' : 'a note'} to continue.
            </span>
          )}
          {isRegen && (
            <span style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
              Applying refinement — preserving unchanged fields…
            </span>
          )}
        </div>

        {/* Error */}
        {regenError && (
          <div style={{
            marginTop: 10, fontSize: 9, fontFamily: 'var(--fm)',
            color: '#f87171', lineHeight: 1.6,
            padding: '8px 10px', borderRadius: 4,
            background: 'rgba(248,113,113,.07)', border: '1px solid rgba(248,113,113,.25)',
            display: 'flex', flexDirection: 'column', gap: 5,
          }}>
            <div style={{ display: 'flex', gap: 5 }}>
              <span style={{ flexShrink: 0 }}>⚠</span>
              <span>{regenError}</span>
            </div>
            {rawResponse && (
              <button
                onClick={() => setShowRaw(s => !s)}
                style={{
                  alignSelf: 'flex-start',
                  fontSize: 8, fontFamily: 'var(--fm)', padding: '2px 8px', borderRadius: 3,
                  cursor: 'pointer', background: 'var(--s2)',
                  border: '1px solid var(--border)', color: 'var(--muted)',
                }}
              >
                {showRaw ? 'Hide raw response' : 'Show raw response'}
              </button>
            )}
            {showRaw && rawResponse && (
              <pre style={{
                fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted2)',
                background: 'var(--s2)', borderRadius: 4, padding: '8px 10px',
                overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                maxHeight: 200, overflowY: 'auto', margin: 0,
              }}>
                {rawResponse}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main Stage 1 view ─────────────────────────────────────────────────────────

export default function Stage1View({
  workspace,
  stageRevisions,
  activeRevisionId,
  onSaveRevision,              // ({ prompt, impactSummary }) => void — manual correction
  onSaveRawRevision,           // (record, patchedWorkspace) => void  — AI revision
  stage2IsStale,               // boolean — Stage 2 lags behind the active Stage 1 rev
  stage2HasRevisions,          // boolean — at least one Stage 2 revision exists
  onNavigateToStage2,          // () => void — navigate only
  onRegenerateAndGoToStage2,   // () => void — trigger Stage 2 regen + navigate
}) {
  const [compareRevId, setCompareRevId] = useState(null)

  const apiMode = getApiMode()   // 'ai' | 'mock'

  const { entity, artifact, strategy, evidence, lineage } = workspace
  const data     = artifact?.data    || {}
  const sections = data.sections     || []
  const posColor = postureColor(artifact?.type)
  const confColor = strategy.confidenceLevel === 'High'   ? '#00e5b4'
                  : strategy.confidenceLevel === 'Medium' ? '#fb923c'
                  : strategy.confidenceLevel === 'Low'    ? '#f87171'
                  : 'var(--muted)'

  // Derive current and compare-target revisions for diff viewer
  const currentRevision = stageRevisions?.find(r => r.id === activeRevisionId) ?? null
  const compareRevision = compareRevId ? stageRevisions?.find(r => r.id === compareRevId) ?? null : null
  const currentSnapshot = currentRevision?.contentSnapshot ?? null

  return (
    <div style={{ maxWidth: 840, padding: '0 16px 40px' }}>

      {/* ── Downstream staleness notice ──────────────────────────────────── */}
      {stage2IsStale && stage2HasRevisions && (
        <div style={{
          background: 'rgba(251,146,60,.06)', border: '1px solid rgba(251,146,60,.35)',
          borderRadius: 'var(--r)', padding: '10px 16px', marginBottom: 12,
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 10, color: '#fb923c', flexShrink: 0 }}>⚠</span>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#fb923c', marginBottom: 2 }}>
              Stage 2 is stale
            </div>
            <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.6 }}>
              Stage 2 was generated from an earlier Stage 1 revision. Regenerate to realign the business unit mapping with the current strategy.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button
              onClick={onNavigateToStage2}
              style={{
                fontSize: 9, fontFamily: 'var(--fm)', fontWeight: 600,
                padding: '5px 12px', borderRadius: 5, cursor: 'pointer',
                background: 'transparent', border: '1px solid rgba(251,146,60,.4)',
                color: '#fb923c',
              }}
            >
              View Stage 2
            </button>
            <button
              onClick={onRegenerateAndGoToStage2}
              style={{
                fontSize: 9, fontFamily: 'var(--fm)', fontWeight: 600,
                padding: '5px 12px', borderRadius: 5, cursor: 'pointer',
                background: 'rgba(251,146,60,.2)', border: '1px solid rgba(251,146,60,.5)',
                color: '#fb923c',
              }}
            >
              ↻ Regenerate Stage 2
            </button>
          </div>
        </div>
      )}

      {/* ── Artifact identity header ─────────────────────────────────────── */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--r)', padding: '16px 18px', marginBottom: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.3, marginBottom: 4 }}>
              {artifact.title || 'Untitled artifact'}
            </div>
            {data.subtitle && (
              <div style={{ fontSize: 10, color: 'var(--muted2)', fontFamily: 'var(--fm)', lineHeight: 1.5 }}>
                {data.subtitle}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 }}>
            {artifact.versionNumber != null && (
              <Badge color="rgba(255,255,255,.3)">v{artifact.versionNumber}</Badge>
            )}
            {artifact.type && <Badge color={posColor}>{artifact.type}</Badge>}
            {entity.company && <Badge color="var(--accent)">{entity.company}</Badge>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {data.personaSummary && (
            <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
              For: {data.personaSummary}
            </div>
          )}
          {strategy.targetCustomer && (
            <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--a3)' }}>
              Target: {strategy.targetCustomer}
            </div>
          )}
          {entity.analysisType && (
            <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
              {entity.analysisType}
            </div>
          )}
        </div>
      </div>

      {/* ── Strategy Basis ────────────────────────────────────────────────── */}
      <Section title="Strategy Basis" label="01" defaultOpen={true}>
        <Field label="Strategic Thesis" value={strategy.thesis} />
        <Field label="Business Problem" value={strategy.businessProblem} />
        <Field label="Opportunity" value={strategy.opportunity} />
        <Field label="Recommended Direction" value={strategy.recommendedDirection} />
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 4 }}>
          {strategy.confidenceLevel && (
            <div>
              <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5 }}>
                Confidence
              </div>
              <Badge color={confColor}>{strategy.confidenceLevel}</Badge>
            </div>
          )}
          {strategy.readinessLevel && (
            <div>
              <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5 }}>
                Readiness
              </div>
              <Badge color="var(--a4)">{strategy.readinessLevel}</Badge>
            </div>
          )}
        </div>
      </Section>

      {/* ── Artifact Content (sections) ──────────────────────────────────── */}
      {sections.length > 0 && (
        <Section title="Artifact Content" label="02" defaultOpen={true}>
          {sections.map((sec, i) => (
            <div key={i} style={{ marginBottom: i < sections.length - 1 ? 16 : 0 }}>
              <div style={{
                fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '.07em', color: 'var(--text)',
                marginBottom: 5, paddingBottom: 4,
                borderBottom: '1px solid var(--border)',
              }}>
                {sec.heading}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted2)', lineHeight: 1.8 }}>
                {sec.body}
              </div>
            </div>
          ))}
        </Section>
      )}

      {/* ── Key Decisions ────────────────────────────────────────────────── */}
      {data.keyDecisions?.length > 0 && (
        <Section title="Key Decisions" label="03" defaultOpen={true}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {data.keyDecisions.map((d, i) => (
              <div key={i} style={{ display: 'flex', gap: 9, fontSize: 10, color: 'var(--text)', lineHeight: 1.7 }}>
                <span style={{ color: 'var(--accent)', fontFamily: 'var(--fm)', fontWeight: 700, flexShrink: 0 }}>
                  {i + 1}.
                </span>
                {d}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ── Call to Action ───────────────────────────────────────────────── */}
      {data.callToAction && (
        <Section title="Call to Action" label="04" defaultOpen={true}>
          <div style={{
            fontSize: 11, color: 'var(--text)', lineHeight: 1.75, fontWeight: 500,
            padding: '8px 12px', borderRadius: 5,
            background: 'rgba(59,130,246,.06)', border: '1px solid rgba(59,130,246,.2)',
          }}>
            {data.callToAction}
          </div>
        </Section>
      )}

      {/* ── Validation Checkpoints ───────────────────────────────────────── */}
      {data.validationCheckpoints?.length > 0 && (
        <Section title="Validation Checkpoints" label="05" defaultOpen={true}>
          <ItemList items={data.validationCheckpoints} borderColor="rgba(0,229,180,.4)" />
        </Section>
      )}

      {/* ── Readiness Warnings ──────────────────────────────────────────── */}
      {data.readinessWarnings?.length > 0 && (
        <Section title="Readiness Warnings" label="06" defaultOpen={true}>
          <ItemList items={data.readinessWarnings} borderColor="rgba(248,113,113,.5)" />
        </Section>
      )}

      {/* ── Risk Posture & Risks ─────────────────────────────────────────── */}
      <Section title="Risk Posture & Identified Risks" label="07" defaultOpen={true}>
        <div style={{ marginBottom: evidence.risks.length > 0 ? 12 : 0 }}>
          <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5 }}>
            Investment Posture
          </div>
          {artifact.type
            ? <Badge color={posColor}>{artifact.type}</Badge>
            : <span style={{ fontSize: 10, color: 'var(--muted)' }}>Not specified</span>
          }
        </div>
        {evidence.risks.length > 0 && (
          <>
            <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 7, marginTop: 12 }}>
              Identified Risks
            </div>
            <ItemList items={evidence.risks} borderColor="rgba(248,113,113,.5)" />
          </>
        )}
      </Section>

      {/* ── Key Insights ─────────────────────────────────────────────────── */}
      <Section title="Key Insights" label="08" defaultOpen={false}>
        <ItemList items={evidence.keyInsights} borderColor="rgba(59,130,246,.45)" />
      </Section>

      {/* ── Supporting Claims ────────────────────────────────────────────── */}
      <Section title="Supporting Claims" label="09" defaultOpen={false}>
        <ItemList items={evidence.supportingClaims} borderColor="rgba(99,102,241,.45)" />
      </Section>

      {/* ── Unresolved Questions ─────────────────────────────────────────── */}
      {evidence.unresolvedQuestions.length > 0 && (
        <Section title="Unresolved Questions" label="10" defaultOpen={false}>
          <ItemList items={evidence.unresolvedQuestions} borderColor="rgba(251,146,60,.45)" />
        </Section>
      )}

      {/* ── Upstream Evidence Chain ──────────────────────────────────────── */}
      <Section title="Upstream Evidence Chain" label="11" defaultOpen={false}>
        <Field label="Stage 1 — Initial orientation" value={evidence.stage1Intent} />
        <Field label="Stage 2 — Evidence retrieval"  value={evidence.stage2Summary} />
        <Field label="Stage 3 — Strategic synthesis" value={evidence.stage3Synthesis} />
        {evidence.userContextAdditions.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
              User Context Additions (Stage 4)
            </div>
            <ItemList items={evidence.userContextAdditions} borderColor="rgba(139,92,246,.45)" />
          </div>
        )}
      </Section>

      {/* ── Lineage & Traceability ───────────────────────────────────────── */}
      <Section title="Lineage & Traceability" label="12" defaultOpen={false}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 20px', marginBottom: 10 }}>
          <Field label="Source Stage"        value={lineage.sourceStage} />
          <Field label="Artifact Version"    value={lineage.sourceArtifactVersion} />
          <Field label="User Edited"         value={lineage.userEdited ? 'Yes' : 'No'} />
          <Field label="Citations Preserved" value={lineage.citationsPreserved ? 'Yes' : 'No'} />
        </div>
        {lineage.basedOnStages?.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
              Based On
            </div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {lineage.basedOnStages.map(s => <Badge key={s} color="var(--accent)">{s}</Badge>)}
            </div>
          </div>
        )}
        {lineage.notes && <Field label="Notes" value={lineage.notes} />}
      </Section>

      {/* ── Diff viewer (shown when a prior revision is selected for compare) */}
      <LearningSignals signals={currentRevision?.contentSnapshot?.learningSignals || currentRevision?.learningSignals} />

      {compareRevision && currentRevision && (
        <RevisionDiffViewer
          revA={compareRevision}
          revB={currentRevision}
          onClose={() => setCompareRevId(null)}
        />
      )}

      {/* ── Revision History ─────────────────────────────────────────────── */}
      <RevisionHistory
        revisions={stageRevisions}
        activeRevisionId={activeRevisionId}
        onCompare={id => setCompareRevId(id)}
        compareRevId={compareRevId}
      />

      {/* ── Refinement Panel ─────────────────────────────────────────────── */}
      <Stage1RefinementPanel
        apiMode={apiMode}
        workspace={workspace}
        currentSnapshot={currentSnapshot}
        stageRevisions={stageRevisions}
        onSaveRevision={onSaveRevision}
        onSaveRawRevision={onSaveRawRevision}
      />

      {/* ── Stage 2 CTA ──────────────────────────────────────────────────── */}
      <div style={{
        background: 'var(--surface)',
        border: `1px solid ${stage2IsStale && stage2HasRevisions ? 'rgba(251,146,60,.35)' : 'rgba(59,130,246,.3)'}`,
        borderRadius: 'var(--r)', padding: '16px 18px', marginBottom: 10,
        display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
            {stage2IsStale && stage2HasRevisions
              ? 'Stage 2 needs regeneration'
              : 'Continue to Stage 2 — Business Unit Mapping'
            }
          </div>
          <div style={{ fontSize: 10, color: 'var(--muted2)', fontFamily: 'var(--fm)', lineHeight: 1.65 }}>
            {stage2IsStale && stage2HasRevisions
              ? 'The existing business unit mapping was generated from an earlier Stage 1 revision. Regenerate to realign it with the current strategy, or view the existing mapping first.'
              : 'Stage 2 will map this strategy into business-unit responsibilities. Stage 1 import and refinement history are now ready.'
            }
          </div>
        </div>

        {stage2IsStale && stage2HasRevisions ? (
          /* Stale — two actions */
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button
              onClick={onNavigateToStage2}
              style={{
                fontSize: 10, fontFamily: 'var(--fm)', fontWeight: 600,
                padding: '7px 16px', borderRadius: 5, cursor: 'pointer',
                background: 'var(--s2)', border: '1px solid var(--border)',
                color: 'var(--muted2)',
              }}
            >
              View Stage 2
            </button>
            <button
              onClick={onRegenerateAndGoToStage2}
              style={{
                fontSize: 10, fontFamily: 'var(--fm)', fontWeight: 600,
                padding: '7px 18px', borderRadius: 5, cursor: 'pointer',
                background: '#fb923c', border: 'none', color: '#000',
              }}
            >
              ↻ Regenerate & View →
            </button>
          </div>
        ) : (
          /* Not stale — single action */
          <button
            onClick={onNavigateToStage2}
            style={{
              flexShrink: 0,
              fontSize: 10, fontFamily: 'var(--fm)', fontWeight: 600,
              padding: '7px 20px', borderRadius: 5, cursor: 'pointer',
              background: 'var(--accent)', border: 'none', color: '#000',
            }}
          >
            Stage 2 →
          </button>
        )}
      </div>

    </div>
  )
}
