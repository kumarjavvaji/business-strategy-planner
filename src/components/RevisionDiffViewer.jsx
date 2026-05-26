// RevisionDiffViewer — compares two revision snapshots word-by-word.
// Props:
//   revA  — older revision object (with .contentSnapshot)
//   revB  — newer revision object (with .contentSnapshot)
//   onClose — () => void

import React, { useMemo, useState } from 'react'
import { stageSnapshotToText }      from '../utils/stageSnapshots'
import { diffWords, diffSummary }   from '../utils/diffText'

export default function RevisionDiffViewer({ revA, revB, onClose }) {
  const [highlights, setHighlights] = useState(true)

  const { ops, summary } = useMemo(() => {
    const textA = stageSnapshotToText(revA.contentSnapshot)
    const textB = stageSnapshotToText(revB.contentSnapshot)
    const ops     = diffWords(textA, textB)
    const summary = diffSummary(ops)
    return { ops, summary }
  }, [revA, revB])

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
        <span style={{ fontSize: 11, fontWeight: 600, flex: 1 }}>
          Revision comparison
        </span>

        {/* Summary chips */}
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
                −{summary.removed}
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

        {/* Highlight toggle */}
        <button
          onClick={() => setHighlights(h => !h)}
          style={{
            fontSize: 8, fontFamily: 'var(--fm)', padding: '2px 8px', borderRadius: 3,
            cursor: 'pointer',
            background: highlights ? 'rgba(59,130,246,.15)' : 'var(--s2)',
            border: `1px solid ${highlights ? 'rgba(59,130,246,.4)' : 'var(--border)'}`,
            color: highlights ? 'var(--accent)' : 'var(--muted)',
          }}
        >
          {highlights ? 'Highlights on' : 'Highlights off'}
        </button>

        {/* Close */}
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

      {/* Version labels */}
      <div style={{
        display: 'flex', gap: 12, padding: '8px 15px',
        borderBottom: '1px solid var(--border)',
        fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)',
      }}>
        <span>
          <span style={{ color: '#f87171', marginRight: 4 }}>−</span>
          v{revA.revisionNumber} — {revA.label}
          <span style={{ marginLeft: 8, opacity: .55 }}>
            {new Date(revA.createdAt).toLocaleDateString()}
          </span>
        </span>
        <span style={{ opacity: .4 }}>→</span>
        <span>
          <span style={{ color: '#00e5b4', marginRight: 4 }}>+</span>
          v{revB.revisionNumber} — {revB.label}
          <span style={{ marginLeft: 8, opacity: .55 }}>
            {new Date(revB.createdAt).toLocaleDateString()}
          </span>
        </span>
      </div>

      {/* Diff body */}
      <div style={{
        padding: '12px 15px',
        fontFamily: 'var(--fm)', fontSize: 10, lineHeight: 2,
        color: 'var(--muted2)',
        maxHeight: 340, overflowY: 'auto',
        wordBreak: 'break-word', whiteSpace: 'pre-wrap',
      }}>
        {!summary.hasChanges && (
          <div style={{
            fontSize: 10, color: 'var(--muted)', fontStyle: 'italic',
            padding: '20px 0', textAlign: 'center',
          }}>
            No content changes detected between these two revisions.
            The refinement prompt and impact summary were recorded, but the underlying package data is identical.
          </div>
        )}
        {summary.hasChanges && ops.map((op, i) => {
          if (!highlights) {
            // Plain text — show current (B) only
            if (op.type === 'remove') return null
            return <span key={i}>{op.text}</span>
          }
          if (op.type === 'keep') {
            return <span key={i}>{op.text}</span>
          }
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
          // remove
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
      </div>
    </div>
  )
}
