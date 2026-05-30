// RevisionHistory — lists stage revisions newest-first.
// Props:
//   revisions        — revision[] for this stage
//   activeRevisionId — string | null
//   onCompare        — (revId) => void  — triggers diff vs current
//   compareRevId     — string | null    — currently-compared revision id

import React from 'react'

function sourceLabel(source) {
  if (source === 'import') return { text: 'Import',    color: 'var(--accent)' }
  if (source === 'manual') return { text: 'Manual',    color: '#fb923c'       }
  if (source === 'ai')     return { text: 'AI',        color: '#3b82f6'       }
  if (source === 'mock')   return { text: 'Mock',      color: '#fb923c'       }
  return { text: source,             color: 'var(--muted)'  }
}

function refinementLabel(refinementType) {
  if (refinementType === 'unit')  return { text: '↻ unit',  color: '#a78bfa' }
  if (refinementType === 'stage') return { text: '⊞ stage', color: '#38bdf8' }
  return null
}

const SCOPE_LABELS = {
  'wording':   { text: 'wording',   color: '#94a3b8' },
  'ownership': { text: 'ownership', color: '#f59e0b' },
  'cross-fn':  { text: 'cross-fn',  color: '#8b5cf6' },
  'execution': { text: 'execution', color: '#ec4899' },
  'kpi':       { text: 'KPIs',      color: '#00e5b4' },
}

function scopeLabel(scope) {
  return SCOPE_LABELS[scope] || null
}

const STRUCTURAL_LABELS = {
  none:                 { text: 'no structure', color: '#94a3b8' },
  unit_added:           { text: 'unit added',   color: '#00e5b4' },
  unit_removed:         { text: 'unit removed', color: '#f87171' },
  unit_merged:          { text: 'unit merged',  color: '#a78bfa' },
  ownership_changed:    { text: 'ownership',    color: '#f59e0b' },
  dependencies_changed: { text: 'dependencies', color: '#8b5cf6' },
}

function structuralLabel(impact) {
  return STRUCTURAL_LABELS[impact] || null
}

export default function RevisionHistory({ revisions, activeRevisionId, onCompare, compareRevId }) {
  if (!revisions?.length) {
    return (
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--r)', padding: '13px 15px', marginBottom: 10,
      }}>
        <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--fm)' }}>
          No revisions recorded.
        </div>
      </div>
    )
  }

  // Newest-first
  const sorted = [...revisions].sort((a, b) => b.revisionNumber - a.revisionNumber)

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
          ⊙
        </span>
        <span style={{ fontSize: 11, fontWeight: 600, flex: 1 }}>Revision History</span>
        <span style={{
          fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)',
          padding: '1px 6px', borderRadius: 3,
          background: 'var(--s2)', border: '1px solid var(--border)',
        }}>
          {revisions.length} revision{revisions.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* List */}
      <div>
        {sorted.map((rev, idx) => {
          const isActive    = rev.id === activeRevisionId
          const isComparing = rev.id === compareRevId
          const sl          = sourceLabel(rev.source)
          const rl          = refinementLabel(rev.refinementType)
          const scl         = scopeLabel(rev.refinementScope)
          const stl         = structuralLabel(rev.structuralImpact)
          const isFirst     = idx === 0  // newest

          return (
            <div
              key={rev.id}
              style={{
                padding: '10px 15px',
                borderBottom: idx < sorted.length - 1 ? '1px solid var(--border)' : 'none',
                background: isActive ? 'rgba(59,130,246,.04)' : 'transparent',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                {/* Left: version badge */}
                <div style={{
                  flexShrink: 0,
                  width: 28, height: 28,
                  borderRadius: '50%',
                  background: isActive ? 'rgba(59,130,246,.15)' : 'var(--s2)',
                  border: `1px solid ${isActive ? 'rgba(59,130,246,.4)' : 'var(--border)'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 9, fontFamily: 'var(--fm)', fontWeight: 700,
                  color: isActive ? 'var(--accent)' : 'var(--muted)',
                }}>
                  v{rev.revisionNumber}
                </div>

                {/* Right: content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>
                      {rev.label}
                    </span>
                    {isActive && (
                      <span style={{
                        fontSize: 7, fontFamily: 'var(--fm)', padding: '1px 5px', borderRadius: 2,
                        background: 'rgba(59,130,246,.15)', border: '1px solid rgba(59,130,246,.3)',
                        color: 'var(--accent)',
                      }}>
                        current
                      </span>
                    )}
                    <span style={{
                      fontSize: 7, fontFamily: 'var(--fm)', padding: '1px 5px', borderRadius: 2,
                      background: `${sl.color}18`, border: `1px solid ${sl.color}30`,
                      color: sl.color,
                    }}>
                      {sl.text}
                    </span>
                    {rl && (
                      <span style={{
                        fontSize: 7, fontFamily: 'var(--fm)', padding: '1px 5px', borderRadius: 2,
                        background: `${rl.color}18`, border: `1px solid ${rl.color}30`,
                        color: rl.color,
                      }}>
                        {rl.text}
                      </span>
                    )}
                    {rev.affectedUnit && (
                      <span style={{
                        fontSize: 7, fontFamily: 'var(--fm)', padding: '1px 5px', borderRadius: 2,
                        background: 'rgba(167,139,250,.12)', border: '1px solid rgba(167,139,250,.25)',
                        color: '#a78bfa', maxWidth: 180,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                        title={rev.affectedUnit}
                      >
                        {rev.affectedUnit}
                      </span>
                    )}
                    {scl && (
                      <span style={{
                        fontSize: 7, fontFamily: 'var(--fm)', padding: '1px 5px', borderRadius: 2,
                        background: `${scl.color}14`, border: `1px solid ${scl.color}30`,
                        color: scl.color, whiteSpace: 'nowrap',
                      }}>
                        {scl.text}
                      </span>
                    )}
                    {stl && (
                      <span style={{
                        fontSize: 7, fontFamily: 'var(--fm)', padding: '1px 5px', borderRadius: 2,
                        background: `${stl.color}14`, border: `1px solid ${stl.color}30`,
                        color: stl.color, whiteSpace: 'nowrap',
                      }}>
                        {stl.text}
                      </span>
                    )}
                  </div>

                  <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', marginBottom: 4 }}>
                    {new Date(rev.createdAt).toLocaleDateString(undefined, {
                      year: 'numeric', month: 'short', day: 'numeric',
                      hour: '2-digit', minute: '2-digit',
                    })}
                  </div>

                  {rev.prompt && (
                    <div style={{
                      fontSize: 10, color: 'var(--muted2)', lineHeight: 1.6,
                      marginBottom: rev.impactSummary ? 4 : 0,
                    }}>
                      "{rev.prompt}"
                    </div>
                  )}
                  {rev.impactSummary && (
                    <div style={{
                      fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)',
                      lineHeight: 1.6, paddingLeft: 8, borderLeft: '2px solid var(--border2)',
                    }}>
                      {rev.impactSummary}
                    </div>
                  )}
                </div>

                {/* Compare button — only for non-active revisions */}
                {!isActive && (
                  <button
                    onClick={() => onCompare(isComparing ? null : rev.id)}
                    style={{
                      flexShrink: 0,
                      fontSize: 8, fontFamily: 'var(--fm)', padding: '3px 9px', borderRadius: 3,
                      cursor: 'pointer',
                      background: isComparing ? 'rgba(59,130,246,.15)' : 'var(--s2)',
                      border: `1px solid ${isComparing ? 'rgba(59,130,246,.35)' : 'var(--border)'}`,
                      color: isComparing ? 'var(--accent)' : 'var(--muted)',
                      marginTop: 2,
                    }}
                  >
                    {isComparing ? 'Close diff' : 'Compare to current'}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
