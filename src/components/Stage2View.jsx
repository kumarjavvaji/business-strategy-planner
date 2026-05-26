// Stage 2 — Business Unit Mapping
// Generates an inferred BU structure from the active Stage 1 revision.
// Supports: AI generation (VITE_OPENAI_API_KEY) + mock mode (no key required).

import React, { useState, useCallback } from 'react'
import { hasApiKey, callAI }                  from '../api/aiClient'
import { buildStage2Messages, parseStage2Response, generateMockStage2 } from '../utils/stage2Prompts'
import { buildStage2RevisionRecord, stage2SnapshotToText }              from '../utils/stageSnapshots'
import RevisionHistory    from './RevisionHistory'
import RevisionDiffViewer from './RevisionDiffViewer'
import RefinementPanel    from './RefinementPanel'

// ── Involvement level styles ──────────────────────────────────────────────────
const LEVEL_COLORS = {
  primary:    { color: '#3b82f6', label: 'Primary driver'  },
  supporting: { color: '#fb923c', label: 'Supporting'       },
  informed:   { color: 'rgba(255,255,255,.38)', label: 'Informed' },
}
function levelStyle(lvl) {
  return LEVEL_COLORS[lvl] || LEVEL_COLORS.supporting
}

// ── Small shared primitives ───────────────────────────────────────────────────

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

function SubList({ label, items, borderColor }) {
  if (!items?.length) return null
  const bc = borderColor || 'var(--border2)'
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5 }}>
        {label}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {items.map((item, i) => (
          <div key={i} style={{
            fontSize: 10, color: 'var(--muted2)', lineHeight: 1.65,
            paddingLeft: 10, borderLeft: `2px solid ${bc}`,
          }}>
            {item}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Business unit card ────────────────────────────────────────────────────────

function BUCard({ bu, index }) {
  const [open, setOpen] = useState(true)
  const ls = levelStyle(bu.involvementLevel)

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--r)', marginBottom: 8, overflow: 'hidden',
    }}>
      {/* Card header */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          padding: '10px 14px', cursor: 'pointer', userSelect: 'none',
          display: 'flex', alignItems: 'center', gap: 10,
          borderBottom: open ? '1px solid var(--border)' : 'none',
          background: open ? 'transparent' : 'rgba(255,255,255,.01)',
        }}
      >
        <span style={{
          flexShrink: 0,
          width: 22, height: 22, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 9, fontFamily: 'var(--fm)', fontWeight: 700,
          background: `${ls.color}18`, border: `1px solid ${ls.color}30`,
          color: ls.color,
        }}>
          {index + 1}
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, flex: 1, color: 'var(--text)' }}>
          {bu.name}
        </span>
        <Badge color={ls.color}>{bu.involvementLevel}</Badge>
        {bu.strategicInvolvement && (
          <span style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {bu.strategicInvolvement}
          </span>
        )}
        <span style={{ fontSize: 9, color: 'var(--muted)', flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </div>

      {/* Card body */}
      {open && (
        <div style={{ padding: '13px 14px' }}>
          {bu.purpose && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 3 }}>
                Purpose
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted2)', lineHeight: 1.7 }}>{bu.purpose}</div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
            <SubList label="Key Responsibilities" items={bu.keyResponsibilities} borderColor="rgba(59,130,246,.4)"  />
            <SubList label="Dependencies"         items={bu.dependencies}        borderColor="rgba(139,92,246,.4)"  />
            <SubList label="Risks & Unknowns"     items={bu.risksAndUnknowns}    borderColor="rgba(248,113,113,.45)" />
            <SubList label="Key Success Metrics"  items={bu.keySuccessMetrics}   borderColor="rgba(0,229,180,.4)"   />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main Stage 2 view ─────────────────────────────────────────────────────────

export default function Stage2View({
  workspace,
  stage1Revisions,
  stage1ActiveId,
  stage2Revisions,
  stage2ActiveId,
  onSaveRevision,       // (revisionRecord) => void   — receives pre-built record
  onNavigateToStage3,
}) {
  const [isGenerating,   setIsGenerating]   = useState(false)
  const [genError,       setGenError]       = useState(null)
  const [rawResponse,    setRawResponse]    = useState(null)  // shown on parse fail
  const [showRaw,        setShowRaw]        = useState(false)
  const [compareRevId,   setCompareRevId]   = useState(null)

  // ── Derived state ───────────────────────────────────────────────────────────
  const activeRev = stage2Revisions.find(r => r.id === stage2ActiveId) ?? null
  const businessUnits = activeRev?.contentSnapshot?.businessUnits || []
  const summaryNote   = activeRev?.contentSnapshot?.summaryNote   || ''

  // Staleness: latest Stage 2 rev was generated from a different Stage 1 rev
  const latestStage2  = [...stage2Revisions].sort((a, b) => b.revisionNumber - a.revisionNumber)[0]
  const isStale       = !!(latestStage2 && latestStage2.sourceBasisRevisionId !== stage1ActiveId)

  // Active Stage 1 revision object (for snapshot access)
  const activeStage1Rev = stage1Revisions.find(r => r.id === stage1ActiveId) ?? null

  // Compare revision objects for diff viewer
  const compareRevision = compareRevId ? stage2Revisions.find(r => r.id === compareRevId) ?? null : null
  const apiMode = hasApiKey() ? 'ai' : 'mock'

  // ── Generation ──────────────────────────────────────────────────────────────
  const handleGenerate = useCallback(async () => {
    if (!activeStage1Rev) return
    setIsGenerating(true)
    setGenError(null)
    setRawResponse(null)
    setShowRaw(false)

    const snapshot = activeStage1Rev.contentSnapshot
    let businessUnits, summaryNote, source

    if (hasApiKey()) {
      // ── AI path ──────────────────────────────────────────────────────────
      const { messages } = buildStage2Messages(snapshot)
      const { result, error } = await callAI(messages, { temperature: 0.3, maxTokens: 2500 })

      if (error) {
        setGenError(error)
        setIsGenerating(false)
        return
      }

      const parsed = parseStage2Response(result)
      setRawResponse(result)

      if (parsed.error || !parsed.businessUnits) {
        setGenError(parsed.error || 'Response parse failed.')
        setIsGenerating(false)
        return
      }

      businessUnits = parsed.businessUnits
      summaryNote   = parsed.summaryNote
      source        = 'ai'

    } else {
      // ── Mock path ─────────────────────────────────────────────────────────
      const mock = generateMockStage2(snapshot)
      businessUnits = mock.businessUnits
      summaryNote   = mock.summaryNote
      source        = 'mock'
    }

    const nextNum = stage2Revisions.length + 1
    const record  = buildStage2RevisionRecord({
      businessUnits,
      summaryNote,
      revisionNumber:       nextNum,
      sourceBasisRevisionId: stage1ActiveId,
      source,
      prompt:        '',
      impactSummary: `Generated from Stage 1 revision v${activeStage1Rev.revisionNumber} via ${source === 'ai' ? 'AI (gpt-4o)' : 'mock generator'}.`,
    })

    onSaveRevision(record)
    setIsGenerating(false)
  }, [activeStage1Rev, stage1ActiveId, stage2Revisions.length, onSaveRevision])

  // ── Correction note (RefinementPanel handler) ────────────────────────────────
  function handleSaveCorrectionNote({ prompt, impactSummary }) {
    if (!activeRev) return
    const nextNum = stage2Revisions.length + 1
    const record  = buildStage2RevisionRecord({
      businessUnits: activeRev.contentSnapshot.businessUnits,
      summaryNote:   activeRev.contentSnapshot.summaryNote,
      revisionNumber:       nextNum,
      sourceBasisRevisionId: activeRev.sourceBasisRevisionId,
      source:        'manual',
      prompt,
      impactSummary,
    })
    onSaveRevision(record)
  }

  // ── Source label for the current revision ───────────────────────────────────
  function sourceLabel(src) {
    if (src === 'ai')     return { text: 'AI-generated',    color: '#3b82f6'  }
    if (src === 'mock')   return { text: 'Mock-generated',  color: '#fb923c'  }
    if (src === 'manual') return { text: 'Manual note',     color: 'rgba(255,255,255,.38)' }
    return { text: src,   color: 'var(--muted)' }
  }

  // ── Empty state ─────────────────────────────────────────────────────────────
  if (stage2Revisions.length === 0) {
    return (
      <div style={{ maxWidth: 840, padding: '0 16px 40px' }}>
        <EmptyState
          apiMode={apiMode}
          isGenerating={isGenerating}
          genError={genError}
          rawResponse={rawResponse}
          showRaw={showRaw}
          onShowRaw={() => setShowRaw(s => !s)}
          onGenerate={handleGenerate}
          activeStage1Rev={activeStage1Rev}
        />
      </div>
    )
  }

  // ── Main view (has revisions) ───────────────────────────────────────────────
  const srcLbl = sourceLabel(activeRev?.source)

  return (
    <div style={{ maxWidth: 840, padding: '0 16px 40px' }}>

      {/* ── Status header ──────────────────────────────────────────────── */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--r)', padding: '14px 16px', marginBottom: 12,
        display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
            Business Unit Mapping
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Badge color={srcLbl.color}>{srcLbl.text}</Badge>
            {activeRev && (
              <span style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
                v{activeRev.revisionNumber} · {new Date(activeRev.createdAt).toLocaleDateString()}
              </span>
            )}
            {activeRev?.sourceBasisRevisionId && (
              <span style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
                from Stage 1 v{stage1Revisions.find(r => r.id === activeRev.sourceBasisRevisionId)?.revisionNumber ?? '?'}
              </span>
            )}
          </div>
          {summaryNote && (
            <div style={{ fontSize: 10, color: 'var(--muted2)', lineHeight: 1.65, marginTop: 8, fontFamily: 'var(--fm)' }}>
              {summaryNote}
            </div>
          )}
        </div>
        <GenerateButton
          apiMode={apiMode}
          isGenerating={isGenerating}
          isRegenerate={true}
          onGenerate={handleGenerate}
          disabled={!activeStage1Rev}
        />
      </div>

      {/* ── Staleness banner ───────────────────────────────────────────── */}
      {isStale && (
        <div style={{
          background: 'rgba(251,146,60,.06)', border: '1px solid rgba(251,146,60,.35)',
          borderRadius: 'var(--r)', padding: '12px 16px', marginBottom: 12,
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 10, fontFamily: 'var(--fm)' }}>⚠</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#fb923c', marginBottom: 2 }}>
              Stage 2 is stale
            </div>
            <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.6 }}>
              The active Stage 1 revision has changed since this Stage 2 was generated.
              Regenerate to re-align, or keep the existing mapping.
            </div>
          </div>
          <button
            onClick={handleGenerate}
            disabled={isGenerating || !activeStage1Rev}
            style={{
              flexShrink: 0,
              fontSize: 9, fontFamily: 'var(--fm)', fontWeight: 600,
              padding: '5px 14px', borderRadius: 5, cursor: 'pointer',
              background: 'rgba(251,146,60,.15)', border: '1px solid rgba(251,146,60,.4)',
              color: '#fb923c',
            }}
          >
            {isGenerating ? 'Generating…' : 'Regenerate Stage 2'}
          </button>
        </div>
      )}

      {/* ── Generation error ───────────────────────────────────────────── */}
      {genError && (
        <div style={{
          fontSize: 10, color: '#f87171', marginBottom: 12, padding: '10px 14px',
          background: 'rgba(248,113,113,.06)', border: '1px solid rgba(248,113,113,.25)',
          borderRadius: 'var(--r)', fontFamily: 'var(--fm)',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <span style={{ flexShrink: 0 }}>⚠</span>
            <span>{genError}</span>
          </div>
          {rawResponse && (
            <div>
              <button
                onClick={() => setShowRaw(s => !s)}
                style={{
                  fontSize: 8, fontFamily: 'var(--fm)', padding: '2px 8px', borderRadius: 3,
                  cursor: 'pointer', background: 'var(--s2)',
                  border: '1px solid var(--border)', color: 'var(--muted)',
                }}
              >
                {showRaw ? 'Hide raw response' : 'Show raw response'}
              </button>
            </div>
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

      {/* ── Business units ─────────────────────────────────────────────── */}
      {businessUnits.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{
            fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            Business Units
            <span style={{
              padding: '1px 6px', borderRadius: 3,
              background: 'var(--s2)', border: '1px solid var(--border)',
              fontSize: 8, color: 'var(--muted)',
            }}>
              {businessUnits.length}
            </span>
          </div>
          {businessUnits.map((bu, i) => (
            <BUCard key={i} bu={bu} index={i} />
          ))}
        </div>
      )}

      {/* ── Diff viewer ────────────────────────────────────────────────── */}
      {compareRevision && activeRev && (
        <RevisionDiffViewer
          revA={compareRevision}
          revB={activeRev}
          toText={stage2SnapshotToText}
          onClose={() => setCompareRevId(null)}
        />
      )}

      {/* ── Revision history ───────────────────────────────────────────── */}
      <RevisionHistory
        revisions={stage2Revisions}
        activeRevisionId={stage2ActiveId}
        onCompare={id => setCompareRevId(id)}
        compareRevId={compareRevId}
      />

      {/* ── Correction note ────────────────────────────────────────────── */}
      <RefinementPanel onSaveRevision={handleSaveCorrectionNote} />

      {/* ── Stage 3 CTA ────────────────────────────────────────────────── */}
      <div style={{
        background: 'var(--surface)', border: '1px solid rgba(59,130,246,.3)',
        borderRadius: 'var(--r)', padding: '16px 18px',
        display: 'flex', alignItems: 'center', gap: 16,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
            Continue to Stage 3 — Execution Planning
          </div>
          <div style={{ fontSize: 10, color: 'var(--muted2)', fontFamily: 'var(--fm)', lineHeight: 1.65 }}>
            Stage 3 will map responsibilities into execution plans per business unit.
            Business unit mapping is ready.
          </div>
        </div>
        <button
          onClick={onNavigateToStage3}
          style={{
            flexShrink: 0,
            fontSize: 10, fontFamily: 'var(--fm)', fontWeight: 600,
            padding: '7px 20px', borderRadius: 5, cursor: 'pointer',
            background: 'var(--accent)', border: 'none', color: '#000',
          }}
        >
          Stage 3 →
        </button>
      </div>

    </div>
  )
}

// ── Empty state component ─────────────────────────────────────────────────────

function EmptyState({
  apiMode, isGenerating, genError, rawResponse, showRaw, onShowRaw,
  onGenerate, activeStage1Rev,
}) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--r)', padding: '40px 32px', textAlign: 'center',
      marginBottom: 12,
    }}>
      <div style={{ fontSize: 24, opacity: .18, marginBottom: 16, lineHeight: 1 }}>⬡</div>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
        Business Unit Mapping
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted2)', fontFamily: 'var(--fm)', lineHeight: 1.7, maxWidth: 420, margin: '0 auto 24px' }}>
        {apiMode === 'ai'
          ? 'Generate an AI-inferred business-unit structure from the active Stage 1 strategy basis.'
          : 'Generate a mock business-unit structure from the active Stage 1 strategy basis. Add VITE_OPENAI_API_KEY to .env.local for AI generation.'}
      </div>

      {!activeStage1Rev && (
        <div style={{
          fontSize: 10, color: '#f87171', marginBottom: 16, padding: '8px 14px',
          background: 'rgba(248,113,113,.06)', border: '1px solid rgba(248,113,113,.25)',
          borderRadius: 5, fontFamily: 'var(--fm)', display: 'inline-block',
        }}>
          No active Stage 1 revision found. Go back to Stage 1 first.
        </div>
      )}

      <GenerateButton
        apiMode={apiMode}
        isGenerating={isGenerating}
        isRegenerate={false}
        onGenerate={onGenerate}
        disabled={!activeStage1Rev}
        large
      />

      {genError && (
        <div style={{
          fontSize: 10, color: '#f87171', marginTop: 16, padding: '8px 14px',
          background: 'rgba(248,113,113,.06)', border: '1px solid rgba(248,113,113,.25)',
          borderRadius: 5, fontFamily: 'var(--fm)', textAlign: 'left',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <span style={{ flexShrink: 0 }}>⚠</span> {genError}
          </div>
          {rawResponse && (
            <button
              onClick={onShowRaw}
              style={{
                fontSize: 8, fontFamily: 'var(--fm)', padding: '2px 8px', borderRadius: 3,
                cursor: 'pointer', background: 'var(--s2)',
                border: '1px solid var(--border)', color: 'var(--muted)', alignSelf: 'flex-start',
              }}
            >
              {showRaw ? 'Hide raw' : 'Show raw response'}
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

      {/* API key notice */}
      {apiMode === 'mock' && (
        <div style={{
          marginTop: 20, fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)',
          padding: '8px 14px', borderRadius: 5,
          background: 'var(--s2)', border: '1px solid var(--border)',
          display: 'inline-block', textAlign: 'left', lineHeight: 1.6,
        }}>
          Mock mode active. To enable AI generation, create{' '}
          <code style={{ background: 'var(--bg)', padding: '0 4px', borderRadius: 3 }}>.env.local</code>{' '}
          with <code style={{ background: 'var(--bg)', padding: '0 4px', borderRadius: 3 }}>VITE_OPENAI_API_KEY=sk-…</code>
          {' '}and restart the dev server.
        </div>
      )}
    </div>
  )
}

// ── Generate/Regenerate button ────────────────────────────────────────────────

function GenerateButton({ apiMode, isGenerating, isRegenerate, onGenerate, disabled, large }) {
  const label = isGenerating
    ? 'Generating…'
    : isRegenerate
      ? `Regenerate (${apiMode === 'ai' ? 'AI' : 'mock'})`
      : `Generate Business Unit Map${apiMode === 'ai' ? ' (AI)' : ' (mock)'}`

  return (
    <button
      onClick={onGenerate}
      disabled={isGenerating || disabled}
      style={{
        fontSize: large ? 11 : 10,
        fontFamily: 'var(--fm)', fontWeight: 600,
        padding: large ? '9px 24px' : '6px 16px',
        borderRadius: 5, cursor: (isGenerating || disabled) ? 'not-allowed' : 'pointer',
        background: (isGenerating || disabled) ? 'var(--s2)' : 'var(--accent)',
        border: `1px solid ${(isGenerating || disabled) ? 'var(--border)' : 'var(--accent)'}`,
        color: (isGenerating || disabled) ? 'var(--muted)' : '#000',
        opacity: (isGenerating || disabled) ? 0.65 : 1,
        flexShrink: 0,
        transition: 'background .15s, color .15s',
      }}
    >
      {label}
    </button>
  )
}
