import React, { useState } from 'react'
import './App.css'
import { useWorkspace }              from './hooks/useWorkspace'
import { DEMO_STRATEGY_BASIS_PACKAGE } from './data/demoPackage'
import Stage1View                    from './components/Stage1View'

// ── Stage definitions ─────────────────────────────────────────────────────────
const STAGES = [
  { id: 1, label: 'Stage 1', sub: 'Strategy Basis'       },
  { id: 2, label: 'Stage 2', sub: 'Business Unit Mapping' },
  { id: 3, label: 'Stage 3', sub: 'Execution Planning'    },
  { id: 4, label: 'Stage 4', sub: 'Deliverables'          },
  { id: 5, label: 'Stage 5', sub: 'Synthesis'             },
]

// ── Stage placeholder ─────────────────────────────────────────────────────────
function StagePlaceholder({ stage }) {
  return (
    <div style={{ padding: '70px 20px', textAlign: 'center' }}>
      <div style={{ fontSize: 26, marginBottom: 14, opacity: .2, lineHeight: 1 }}>◯</div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: 'var(--muted2)' }}>
        {stage.label} — {stage.sub}
      </div>
      <div style={{ fontSize: 10, fontFamily: 'var(--fm)', color: 'var(--muted)', maxWidth: 320, margin: '0 auto', lineHeight: 1.7 }}>
        Not yet implemented. Review and approve Stage 1 before this stage is unlocked.
      </div>
    </div>
  )
}

// ── Import panel ──────────────────────────────────────────────────────────────
function ImportPanel({ onImport }) {
  const [json,  setJson]  = useState('')
  const [error, setError] = useState(null)

  function handleLoadDemo() {
    setError(null)
    const result = onImport(DEMO_STRATEGY_BASIS_PACKAGE)
    if (result.error) setError(result.error)
  }

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

        {/* Demo card */}
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--r)', padding: '14px 16px', marginBottom: 10,
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 3 }}>Load demo package</div>
            <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.6 }}>
              Finlytica · Banking-Domain LLM as Regulatory Moat · v2
            </div>
          </div>
          <button
            onClick={handleLoadDemo}
            style={{
              fontSize: 10, fontFamily: 'var(--fm)', fontWeight: 600,
              padding: '6px 16px', borderRadius: 5, cursor: 'pointer',
              background: 'var(--accent)', border: 'none', color: '#000',
              flexShrink: 0,
            }}
          >
            Load demo
          </button>
        </div>

        {/* JSON paste card */}
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--r)', padding: '14px 16px',
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8 }}>
            Paste package JSON
          </div>
          <textarea
            value={json}
            onChange={e => { setJson(e.target.value); setError(null) }}
            rows={9}
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
          {error && (
            <div style={{
              fontSize: 10, color: '#f87171', marginBottom: 10,
              fontFamily: 'var(--fm)', display: 'flex', alignItems: 'flex-start', gap: 5,
              lineHeight: 1.5,
            }}>
              <span style={{ flexShrink: 0, marginTop: 1 }}>⚠</span> {error}
            </div>
          )}
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
            Import package
          </button>
        </div>

      </div>
    </div>
  )
}

// ── App shell ─────────────────────────────────────────────────────────────────
export default function App() {
  const { workspace, importPackage, clearWorkspace } = useWorkspace()
  const [activeStage, setActiveStage] = useState(1)

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
          <span className="app-header-imported">
            Imported {new Date(workspace.importedAt).toLocaleDateString()}
          </span>
          <button className="btn-clear" onClick={clearWorkspace}>
            Clear
          </button>
        </div>
      </header>

      {/* Stage tab nav */}
      <nav className="stage-nav">
        {STAGES.map(s => (
          <button
            key={s.id}
            onClick={() => s.id === 1 && setActiveStage(1)}
            className={[
              'stage-tab',
              activeStage === s.id ? 'active' : '',
              s.id > 1 ? 'locked' : '',
            ].filter(Boolean).join(' ')}
            title={s.id > 1 ? 'Not yet implemented' : undefined}
          >
            <span className="stage-tab-label">{s.label}</span>
            <span className="stage-tab-sub">{s.sub}</span>
          </button>
        ))}
      </nav>

      {/* Content */}
      <main className="app-content">
        {activeStage === 1 && <Stage1View workspace={workspace} />}
        {activeStage > 1  && <StagePlaceholder stage={STAGES[activeStage - 1]} />}
      </main>

    </div>
  )
}
