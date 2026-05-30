// RevisionDiffViewer - compares two revision snapshots.
// Supports inline word diff and side-by-side comparison for large regenerations.

import React, { useMemo, useState } from 'react'
import { stageSnapshotToText }      from '../utils/stageSnapshots'
import { diffWords, diffSummary }   from '../utils/diffText'

function VersionLabel({ rev, tone }) {
  const color = tone === 'old' ? '#f87171' : '#00e5b4'
  return (
    <span>
      <span style={{ color, marginRight: 4 }}>{tone === 'old' ? '-' : '+'}</span>
      v{rev.revisionNumber} - {rev.label}
      <span style={{ marginLeft: 8, opacity: .55 }}>
        {new Date(rev.createdAt).toLocaleDateString()}
      </span>
    </span>
  )
}

function InlineOps({ ops, highlights }) {
  return (
    <>
      {ops.map((op, i) => {
        if (!highlights) {
          if (op.type === 'remove') return null
          return <span key={i}>{op.text}</span>
        }
        if (op.type === 'keep') return <span key={i}>{op.text}</span>
        if (op.type === 'add') {
          return (
            <span key={i} style={{
              background: 'rgba(0,229,180,.18)',
              color: '#00e5b4',
              borderRadius: 2,
              padding: '0 1px',
            }}>
              {op.text}
            </span>
          )
        }
        return (
          <span key={i} style={{
            background: 'rgba(248,113,113,.15)',
            color: '#f87171',
            textDecoration: 'line-through',
            borderRadius: 2,
            padding: '0 1px',
          }}>
            {op.text}
          </span>
        )
      })}
    </>
  )
}

function SideOps({ ops, side, highlights, fallbackText }) {
  if (!highlights) return <>{fallbackText}</>

  return (
    <>
      {ops.map((op, i) => {
        if (side === 'old') {
          if (op.type === 'add') return null
          if (op.type === 'remove') {
            return (
              <span key={i} style={{
                background: 'rgba(248,113,113,.15)',
                color: '#f87171',
                borderRadius: 2,
                padding: '0 1px',
              }}>
                {op.text}
              </span>
            )
          }
          return <span key={i}>{op.text}</span>
        }

        if (op.type === 'remove') return null
        if (op.type === 'add') {
          return (
            <span key={i} style={{
              background: 'rgba(0,229,180,.18)',
              color: '#00e5b4',
              borderRadius: 2,
              padding: '0 1px',
            }}>
              {op.text}
            </span>
          )
        }
        return <span key={i}>{op.text}</span>
      })}
    </>
  )
}

export default function RevisionDiffViewer({ revA, revB, onClose, toText }) {
  const [highlights, setHighlights] = useState(true)
  const [mode,       setMode]       = useState('inline')
  const textFn = toText || stageSnapshotToText

  const { textA, textB, ops, summary } = useMemo(() => {
    const textA = textFn(revA.contentSnapshot)
    const textB = textFn(revB.contentSnapshot)
    const ops     = diffWords(textA, textB)
    const summary = diffSummary(ops)
    return { textA, textB, ops, summary }
  }, [revA, revB, textFn])

  const controlButton = (active) => ({
    fontSize: 8,
    fontFamily: 'var(--fm)',
    padding: '2px 8px',
    borderRadius: 3,
    cursor: 'pointer',
    background: active ? 'rgba(59,130,246,.15)' : 'var(--s2)',
    border: `1px solid ${active ? 'rgba(59,130,246,.4)' : 'var(--border)'}`,
    color: active ? 'var(--accent)' : 'var(--muted)',
  })

  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r)',
      overflow: 'hidden',
      marginBottom: 10,
      maxHeight: 'min(78vh, 860px)',
      display: 'flex',
      flexDirection: 'column',
    }}>
      <div style={{
        padding: '10px 15px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        borderBottom: '1px solid var(--border)',
        position: 'sticky',
        top: 0,
        zIndex: 2,
        background: 'var(--surface)',
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 11, fontWeight: 600, flex: 1 }}>
          Revision comparison
        </span>

        {summary.hasChanges ? (
          <div style={{ display: 'flex', gap: 5 }}>
            {summary.added > 0 && (
              <span style={{
                fontSize: 8, fontFamily: 'var(--fm)', padding: '1px 7px', borderRadius: 3,
                background: 'rgba(0,229,180,.12)', border: '1px solid rgba(0,229,180,.3)',
                color: '#00e5b4',
              }}>
                +{summary.added}
              </span>
            )}
            {summary.removed > 0 && (
              <span style={{
                fontSize: 8, fontFamily: 'var(--fm)', padding: '1px 7px', borderRadius: 3,
                background: 'rgba(248,113,113,.12)', border: '1px solid rgba(248,113,113,.3)',
                color: '#f87171',
              }}>
                -{summary.removed}
              </span>
            )}
          </div>
        ) : (
          <span style={{
            fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)',
            padding: '1px 7px', borderRadius: 3,
            background: 'var(--s2)', border: '1px solid var(--border)',
          }}>
            no content changes
          </span>
        )}

        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={() => setMode('inline')} style={controlButton(mode === 'inline')}>
            Inline
          </button>
          <button onClick={() => setMode('side')} style={controlButton(mode === 'side')}>
            Side by side
          </button>
        </div>

        <button onClick={() => setHighlights(h => !h)} style={controlButton(highlights)}>
          {highlights ? 'Highlights on' : 'Highlights off'}
        </button>

        <button
          onClick={onClose}
          style={{
            fontSize: 9, fontFamily: 'var(--fm)', padding: '2px 9px', borderRadius: 3,
            cursor: 'pointer', background: 'var(--s2)',
            border: '1px solid var(--border)', color: 'var(--muted)',
          }}
        >
          Close
        </button>
      </div>

      <div style={{
        display: 'flex',
        gap: 12,
        padding: '8px 15px',
        borderBottom: '1px solid var(--border)',
        fontSize: 9,
        fontFamily: 'var(--fm)',
        color: 'var(--muted)',
        flexShrink: 0,
        background: 'var(--surface)',
      }}>
        <VersionLabel rev={revA} tone="old" />
        <span style={{ opacity: .4 }}>{'->'}</span>
        <VersionLabel rev={revB} tone="new" />
      </div>

      <div style={{
        overflow: 'auto',
        minHeight: 180,
      }}>
        {!summary.hasChanges && (
          <div style={{
            fontSize: 10,
            color: 'var(--muted)',
            fontStyle: 'italic',
            padding: '28px 15px',
            textAlign: 'center',
          }}>
            No content changes detected between these two revisions.
            The refinement prompt and impact summary were recorded, but the underlying package data is identical.
          </div>
        )}

        {summary.hasChanges && mode === 'inline' && (
          <div style={{
            padding: '12px 15px',
            fontFamily: 'var(--fm)',
            fontSize: 10,
            lineHeight: 2,
            color: 'var(--muted2)',
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
          }}>
            <InlineOps ops={ops} highlights={highlights} />
          </div>
        )}

        {summary.hasChanges && mode === 'side' && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(260px, 1fr) minmax(260px, 1fr)',
            gap: 0,
            minWidth: 640,
          }}>
            <div style={{
              borderRight: '1px solid var(--border)',
              minWidth: 0,
            }}>
              <div style={{
                position: 'sticky',
                top: 0,
                zIndex: 1,
                background: 'var(--surface)',
                borderBottom: '1px solid var(--border)',
                padding: '7px 15px',
                fontSize: 9,
                fontFamily: 'var(--fm)',
                color: '#f87171',
              }}>
                Old revision
              </div>
              <div style={{
                padding: '12px 15px',
                fontFamily: 'var(--fm)',
                fontSize: 10,
                lineHeight: 2,
                color: 'var(--muted2)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                <SideOps ops={ops} side="old" highlights={highlights} fallbackText={textA} />
              </div>
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{
                position: 'sticky',
                top: 0,
                zIndex: 1,
                background: 'var(--surface)',
                borderBottom: '1px solid var(--border)',
                padding: '7px 15px',
                fontSize: 9,
                fontFamily: 'var(--fm)',
                color: '#00e5b4',
              }}>
                New revision
              </div>
              <div style={{
                padding: '12px 15px',
                fontFamily: 'var(--fm)',
                fontSize: 10,
                lineHeight: 2,
                color: 'var(--muted2)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                <SideOps ops={ops} side="new" highlights={highlights} fallbackText={textB} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
