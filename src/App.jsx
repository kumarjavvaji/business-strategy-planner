import React, { useState, useRef } from 'react'
import './App.css'
import { useWorkspace }              from './hooks/useWorkspace'
import { DEMO_STRATEGY_BASIS_PACKAGE } from './data/demoPackage'
import Stage1View                    from './components/Stage1View'
import Stage2View                    from './components/Stage2View'
import Stage3View                    from './components/Stage3View'

// ── Stage definitions ─────────────────────────────────────────────────────────
const STAGES = [
  { id: 1, label: 'Stage 1', sub: 'Strategy Basis'       },
  { id: 2, label: 'Stage 2', sub: 'Business Unit Mapping' },
  { id: 3, label: 'Stage 3', sub: 'Execution Planning'    },
  { id: 4, label: 'Stage 4', sub: 'Deliverables'          },
  { id: 5, label: 'Stage 5', sub: 'Synthesis'             },
]

// ── Stage placeholder ─────────────────────────────────────────────────────────
const STAGE_PLACEHOLDER_COPY = {
  4: 'Stage 4 will translate Stage 3 execution plans into PDLC strategy, epic-level requirements, acceptance criteria, non-functional requirements, delivery sequencing, implementation governance, and product-delivery learning signals.',
  5: 'Stage 5 will synthesize learning signals across Stages 1-4 into reusable strategy patterns, prompt improvements, stage-boundary rules, decision-quality heuristics, refinement heuristics, cross-stage failure modes, and execution-planning patterns.',
}

function StagePlaceholder({ stage }) {
  const copy = STAGE_PLACEHOLDER_COPY[stage.id] || 'Not yet implemented.'
  return (
    <div style={{ padding: '70px 20px', textAlign: 'center' }}>
      <div style={{ fontSize: 26, marginBottom: 14, opacity: .2, lineHeight: 1 }}>◯</div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: 'var(--muted2)' }}>
        {stage.label} — {stage.sub}
      </div>
      <div style={{ fontSize: 10, fontFamily: 'var(--fm)', color: 'var(--muted)', maxWidth: 420, margin: '0 auto', lineHeight: 1.7 }}>
        {copy}
      </div>
    </div>
  )
}

// ── Import panel ──────────────────────────────────────────────────────────────
function ImportPanel({ onImport }) {
  const [json,       setJson]       = useState('')
  const [error,      setError]      = useState(null)
  const [fileStatus, setFileStatus] = useState(null)  // null | 'reading' | filename string
  const fileInputRef = useRef(null)

  // ── 1. Primary: file picker via FileReader ─────────────────────────────────
  function handleFileChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    setFileStatus('reading')

    const reader = new FileReader()
    reader.onload = (evt) => {
      let parsed
      try {
        parsed = JSON.parse(evt.target.result)
      } catch {
        setFileStatus(null)
        setError(`Could not parse "${file.name}" — file does not contain valid JSON.`)
        if (fileInputRef.current) fileInputRef.current.value = ''
        return
      }
      const result = onImport(parsed)
      if (result.error) {
        setFileStatus(null)
        setError(result.error)
        if (fileInputRef.current) fileInputRef.current.value = ''
      } else {
        setFileStatus(file.name)
      }
    }
    reader.onerror = () => {
      setFileStatus(null)
      setError(`Could not read "${file.name}". Please try again.`)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
    reader.readAsText(file)
  }

  // ── 2. Secondary: paste JSON ───────────────────────────────────────────────
  function handleImportJson() {
    setError(null)
    let parsed
    try {
      parsed = JSON.parse(json.trim())
    } catch {
      setError('Invalid JSON — check the pasted content and try again.')
      return
    }
    const result = onImport(parsed)
    if (result.error) setError(result.error)
  }

  // ── 3. Tertiary: demo fixture ──────────────────────────────────────────────
  function handleLoadDemo() {
    setError(null)
    const result = onImport(DEMO_STRATEGY_BASIS_PACKAGE)
    if (result.error) setError(result.error)
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: 'calc(100vh - 44px)', padding: 24,
    }}>
      <div style={{ width: '100%', maxWidth: 540 }}>

        {/* Title */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>
            Business Strategy Planner
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted2)', fontFamily: 'var(--fm)', lineHeight: 1.6 }}>
            Import a Strategy Basis Package exported from DomainIQ to begin.
          </div>
        </div>

        {/* ── 1. File import (primary) ─────────────────────────────────────── */}
        <div style={{
          background: 'var(--surface)', border: '1px solid rgba(59,130,246,.35)',
          borderRadius: 'var(--r)', padding: '16px 18px', marginBottom: 10,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
            Import JSON file
            <span style={{ marginLeft: 8, fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--accent)', padding: '1px 6px', borderRadius: 3, background: 'rgba(59,130,246,.12)', border: '1px solid rgba(59,130,246,.3)' }}>
              Primary
            </span>
          </div>
          <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', marginBottom: 12, lineHeight: 1.6 }}>
            Select a <code style={{ background: 'var(--s2)', padding: '1px 4px', borderRadius: 3, fontSize: 9 }}>.json</code> file exported from DomainIQ Stage 4 "Export Strategy Basis Package."
          </div>

          {/* Hidden real file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={fileStatus === 'reading'}
              style={{
                fontSize: 10, fontFamily: 'var(--fm)', fontWeight: 600,
                padding: '7px 18px', borderRadius: 5,
                cursor: fileStatus === 'reading' ? 'wait' : 'pointer',
                background: 'var(--accent)', border: 'none', color: '#000',
                opacity: fileStatus === 'reading' ? 0.65 : 1,
              }}
            >
              {fileStatus === 'reading' ? 'Reading…' : 'Choose file'}
            </button>
            {fileStatus && fileStatus !== 'reading' && (
              <span style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 4 }}>
                ✓ {fileStatus}
              </span>
            )}
            {!fileStatus && (
              <span style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
                No file selected
              </span>
            )}
          </div>
        </div>

        {/* Error display — shared across all three paths */}
        {error && (
          <div style={{
            fontSize: 10, color: '#f87171', marginBottom: 10, padding: '8px 12px',
            background: 'rgba(248,113,113,.06)', border: '1px solid rgba(248,113,113,.25)',
            borderRadius: 5, fontFamily: 'var(--fm)',
            display: 'flex', alignItems: 'flex-start', gap: 6, lineHeight: 1.6,
          }}>
            <span style={{ flexShrink: 0 }}>⚠</span> {error}
          </div>
        )}

        {/* ── 2. Paste JSON (secondary) ────────────────────────────────────── */}
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--r)', padding: '14px 16px', marginBottom: 10,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8 }}>
            Paste JSON
            <span style={{ marginLeft: 8, fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', padding: '1px 6px', borderRadius: 3, background: 'var(--s2)', border: '1px solid var(--border)' }}>
              Secondary
            </span>
          </div>
          <textarea
            value={json}
            onChange={e => { setJson(e.target.value); setError(null) }}
            rows={7}
            placeholder={'{\n  "packageType": "domainiq_strategy_basis_package",\n  "packageVersion": "1.0",\n  ...\n}'}
            style={{
              width: '100%', boxSizing: 'border-box',
              fontSize: 10, fontFamily: 'var(--fm)',
              color: 'var(--text)', background: 'var(--s2)',
              border: '1px solid var(--border)', borderRadius: 5,
              padding: '8px 10px', resize: 'vertical', outline: 'none',
              lineHeight: 1.6, marginBottom: 10,
            }}
          />
          <button
            onClick={handleImportJson}
            disabled={!json.trim()}
            style={{
              fontSize: 10, fontFamily: 'var(--fm)', fontWeight: 600,
              padding: '6px 16px', borderRadius: 5,
              cursor: json.trim() ? 'pointer' : 'not-allowed',
              background: json.trim() ? 'var(--a2)' : 'var(--s2)',
              border: `1px solid ${json.trim() ? 'var(--a2)' : 'var(--border)'}`,
              color: json.trim() ? '#fff' : 'var(--muted)',
              opacity: json.trim() ? 1 : 0.65,
            }}
          >
            Import pasted JSON
          </button>
        </div>

        {/* ── 3. Demo fixture (tertiary) ───────────────────────────────────── */}
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--r)', padding: '12px 16px',
          display: 'flex', alignItems: 'center', gap: 12,
          opacity: 0.8,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10, fontWeight: 600, marginBottom: 2 }}>
              Load demo package
              <span style={{ marginLeft: 8, fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', padding: '1px 6px', borderRadius: 3, background: 'var(--s2)', border: '1px solid var(--border)' }}>
                Demo only
              </span>
            </div>
            <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.5 }}>
              Finlytica · Banking-Domain LLM as Regulatory Moat · v2
            </div>
          </div>
          <button
            onClick={handleLoadDemo}
            style={{
              fontSize: 9, fontFamily: 'var(--fm)', fontWeight: 600,
              padding: '5px 14px', borderRadius: 5, cursor: 'pointer',
              background: 'var(--s2)', border: '1px solid var(--border)',
              color: 'var(--muted2)', flexShrink: 0,
            }}
          >
            Load demo
          </button>
        </div>

      </div>
    </div>
  )
}

// ── App shell ─────────────────────────────────────────────────────────────────
export default function App() {
  const {
    fullWorkspace,
    workspace,
    importedAt,
    importPackage,
    saveStageRevision,
    saveRawRevision,
    saveStage1AIRevision,
    clearWorkspace,
  } = useWorkspace()
  const [activeStage,           setActiveStage]           = useState(1)
  const [stage2PendingGenerate, setStage2PendingGenerate] = useState(false)
  const [stage3PendingGenerate, setStage3PendingGenerate] = useState(false)

  function handleRegenerateAndGoToStage2() {
    setStage2PendingGenerate(true)
    setActiveStage(2)
  }

  function handleRegenerateAndGoToStage3() {
    setStage3PendingGenerate(true)
    setActiveStage(3)
  }

  // No workspace — show import screen
  if (!workspace) {
    return (
      <div className="app">
        <header className="app-header">
          <span className="app-header-title">Business Strategy Planner</span>
          <span className="app-header-sub">v1 · Strategy Basis Import</span>
        </header>
        <ImportPanel onImport={importPackage} />
      </div>
    )
  }

  const entityLabel =
    workspace.entity.company  ||
    workspace.entity.industry ||
    workspace.entity.domain   ||
    workspace.entity.name     || ''

  // Stage 1 revision data
  const stage1Revisions = fullWorkspace?.stageRevisions?.stage1 ?? []
  const stage1ActiveId  = fullWorkspace?.activeStageRevisionIds?.stage1 ?? null

  // Manual correction note — snapshot of existing workspace
  function handleSaveStage1Revision({ prompt, impactSummary, learningSignals }) {
    saveStageRevision('stage1', { prompt, impactSummary, learningSignals })
  }

  // AI-generated revision — updates normalizedWorkspace + appends revision atomically
  function handleSaveStage1RawRevision(revisionRecord, patchedWorkspace) {
    saveStage1AIRevision(revisionRecord, patchedWorkspace)
  }

  // Stage 2 revision data
  const stage2Revisions = fullWorkspace?.stageRevisions?.stage2 ?? []
  const stage2ActiveId  = fullWorkspace?.activeStageRevisionIds?.stage2 ?? null

  const latestStage2Rev = stage2Revisions.length > 0
    ? [...stage2Revisions].sort((a, b) => b.revisionNumber - a.revisionNumber)[0]
    : null
  const stage2IsStale = !!(latestStage2Rev && latestStage2Rev.sourceBasisRevisionId !== stage1ActiveId)

  function handleSaveStage2Revision(revisionRecord) {
    saveRawRevision('stage2', revisionRecord)
  }

  // Stage 3 revision data
  const stage3Revisions = fullWorkspace?.stageRevisions?.stage3 ?? []
  const stage3ActiveId  = fullWorkspace?.activeStageRevisionIds?.stage3 ?? null

  const latestStage3Rev = stage3Revisions.length > 0
    ? [...stage3Revisions].sort((a, b) => b.revisionNumber - a.revisionNumber)[0]
    : null
  // Stage 3 is stale when Stage 1 OR Stage 2 has changed since it was generated
  const stage3IsStale = !!(latestStage3Rev && (
    latestStage3Rev.sourceBasisRevisionId  !== stage1ActiveId ||
    latestStage3Rev.sourceStage2RevisionId !== stage2ActiveId
  ))

  function handleSaveStage3Revision(revisionRecord) {
    saveRawRevision('stage3', revisionRecord)
  }

  return (
    <div className="app">

      {/* Header */}
      <header className="app-header">
        <span className="app-header-title">Business Strategy Planner</span>
        {entityLabel && (
          <>
            <span className="app-header-divider" />
            <span className="app-header-entity">{entityLabel}</span>
            {workspace.artifact?.title && (
              <span className="app-header-artifact">· {workspace.artifact.title}</span>
            )}
          </>
        )}
        <div className="app-header-actions">
          {importedAt && (
            <span className="app-header-imported">
              Imported {new Date(importedAt).toLocaleDateString()}
            </span>
          )}
          <button className="btn-clear" onClick={clearWorkspace}>
            Clear
          </button>
        </div>
      </header>

      {/* Stage tab nav — all tabs clickable */}
      <nav className="stage-nav">
        {STAGES.map(s => {
          const isStale2 = s.id === 2 && stage2IsStale && stage2Revisions.length > 0
          const isStale3 = s.id === 3 && stage3IsStale && stage3Revisions.length > 0
          return (
            <button
              key={s.id}
              onClick={() => setActiveStage(s.id)}
              className={[
                'stage-tab',
                activeStage === s.id ? 'active' : '',
              ].filter(Boolean).join(' ')}
            >
              <span className="stage-tab-label" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {s.label}
                {isStale2 && (
                  <span
                    title="Stage 2 is stale — regenerate from the updated Stage 1"
                    style={{
                      display: 'inline-block', width: 6, height: 6,
                      borderRadius: '50%', background: '#fb923c',
                      flexShrink: 0, marginTop: 1,
                    }}
                  />
                )}
                {isStale3 && (
                  <span
                    title="Stage 3 is stale — regenerate from the updated upstream stages"
                    style={{
                      display: 'inline-block', width: 6, height: 6,
                      borderRadius: '50%', background: '#fb923c',
                      flexShrink: 0, marginTop: 1,
                    }}
                  />
                )}
              </span>
              <span className="stage-tab-sub">{s.sub}</span>
            </button>
          )
        })}
      </nav>

      {/* Content */}
      <main className="app-content">
        {activeStage === 1 && (
          <Stage1View
            workspace={workspace}
            stageRevisions={stage1Revisions}
            activeRevisionId={stage1ActiveId}
            onSaveRevision={handleSaveStage1Revision}
            onSaveRawRevision={handleSaveStage1RawRevision}
            stage2IsStale={stage2IsStale}
            stage2HasRevisions={stage2Revisions.length > 0}
            onNavigateToStage2={() => setActiveStage(2)}
            onRegenerateAndGoToStage2={handleRegenerateAndGoToStage2}
          />
        )}
        {activeStage === 2 && (
          <Stage2View
            workspace={workspace}
            workspaceId={fullWorkspace?.id}
            stage1Revisions={stage1Revisions}
            stage1ActiveId={stage1ActiveId}
            stage2Revisions={stage2Revisions}
            stage2ActiveId={stage2ActiveId}
            onSaveRevision={handleSaveStage2Revision}
            onNavigateToStage3={() => setActiveStage(3)}
            onRegenerateAndGoToStage3={handleRegenerateAndGoToStage3}
            stage3IsStale={stage3IsStale}
            stage3HasRevisions={stage3Revisions.length > 0}
            shouldAutoGenerate={stage2PendingGenerate}
            onAutoGenerateComplete={() => setStage2PendingGenerate(false)}
          />
        )}
        {activeStage === 3 && (
          <Stage3View
            workspace={workspace}
            workspaceId={fullWorkspace?.id}
            stage1Revisions={stage1Revisions}
            stage1ActiveId={stage1ActiveId}
            stage2Revisions={stage2Revisions}
            stage2ActiveId={stage2ActiveId}
            stage3Revisions={stage3Revisions}
            stage3ActiveId={stage3ActiveId}
            onSaveRevision={handleSaveStage3Revision}
            onNavigateToStage4={() => setActiveStage(4)}
            shouldAutoGenerate={stage3PendingGenerate}
            onAutoGenerateComplete={() => setStage3PendingGenerate(false)}
          />
        )}
        {activeStage > 3 && <StagePlaceholder stage={STAGES[activeStage - 1]} />}
      </main>

    </div>
  )
}
