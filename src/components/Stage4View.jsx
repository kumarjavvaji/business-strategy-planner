import { useState, useEffect, useCallback, useRef } from 'react'
import {
  compileStage4Handoff,
  persistStage4Handoff,
  loadStage4Handoff,
  BU_HANDOFF_STATUS,
  HANDOFF_STATUS,
} from '../utils/stage4Handoff'
import {
  buildArtifactPlan,
  persistArtifactPlan,
  loadArtifactPlan,
  isArtifactPlanStale,
  ARTIFACT_PLAN_STATUS,
  ARTIFACT_READINESS,
} from '../utils/stage4ArtifactPlan'
import { storageReady } from '../utils/storageRouter'

// ── Shared style tokens ────────────────────────────────────────────────────────

const fm = 'var(--fm, ui-monospace, monospace)'

const cardStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r, 6px)',
  padding: '14px 16px',
  marginBottom: 10,
}

const labelStyle = {
  fontSize: 9,
  fontFamily: fm,
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: '.06em',
  marginBottom: 6,
}

const errorBannerStyle = {
  padding: '10px 14px',
  background: 'rgba(248,113,113,.07)',
  border: '1px solid rgba(248,113,113,.3)',
  borderRadius: 5,
  fontSize: 10,
  fontFamily: fm,
  color: '#f87171',
  lineHeight: 1.55,
  marginBottom: 10,
}

const warnBannerStyle = {
  padding: '10px 14px',
  background: 'rgba(251,191,36,.07)',
  border: '1px solid rgba(251,191,36,.3)',
  borderRadius: 5,
  fontSize: 10,
  fontFamily: fm,
  color: '#fbbf24',
  lineHeight: 1.55,
  marginBottom: 10,
}

const successBannerStyle = {
  padding: '9px 13px',
  background: 'rgba(0,229,180,.06)',
  border: '1px solid rgba(0,229,180,.25)',
  borderRadius: 5,
  fontSize: 9,
  fontFamily: fm,
  color: '#00e5b4',
  lineHeight: 1.5,
  marginBottom: 8,
}

const btnPrimary = {
  fontSize: 10,
  fontFamily: fm,
  fontWeight: 600,
  padding: '7px 18px',
  borderRadius: 5,
  cursor: 'pointer',
  background: 'var(--accent, #3b82f6)',
  border: '1px solid var(--accent, #3b82f6)',
  color: '#000',
}

const btnSecondary = {
  fontSize: 9,
  fontFamily: fm,
  fontWeight: 600,
  padding: '5px 14px',
  borderRadius: 5,
  cursor: 'pointer',
  background: 'var(--s2)',
  border: '1px solid var(--border)',
  color: 'var(--muted2)',
}

// ── Status badge ───────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const cfg = {
    [BU_HANDOFF_STATUS.READY]:   { color: '#00e5b4', label: 'Ready' },
    [BU_HANDOFF_STATUS.PARTIAL]: { color: '#fb923c', label: 'Partial' },
    [BU_HANDOFF_STATUS.BLOCKED]: { color: '#f87171', label: 'Blocked' },
    [HANDOFF_STATUS.READY]:      { color: '#00e5b4', label: 'Ready' },
    [HANDOFF_STATUS.PARTIAL]:    { color: '#fb923c', label: 'Partial' },
    [HANDOFF_STATUS.BLOCKED]:    { color: '#f87171', label: 'Blocked' },
  }[status] || { color: 'var(--muted)', label: status || 'Unknown' }
  return (
    <span style={{
      fontSize: 8,
      fontFamily: fm,
      fontWeight: 700,
      color: cfg.color,
      background: `${cfg.color}18`,
      border: `1px solid ${cfg.color}44`,
      borderRadius: 4,
      padding: '2px 7px',
      letterSpacing: '.04em',
    }}>
      {cfg.label.toUpperCase()}
    </span>
  )
}

// ── Per-BU handoff row ─────────────────────────────────────────────────────────

function BuHandoffRow({ entry }) {
  const [open, setOpen] = useState(false)
  const isUsable = entry.status !== BU_HANDOFF_STATUS.BLOCKED

  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r, 6px)',
      marginBottom: 6,
      overflow: 'hidden',
    }}>
      {/* Header row */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          padding: '10px 13px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          borderBottom: open ? '1px solid var(--border)' : 'none',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 700 }}>{entry.buName}</span>
            <StatusBadge status={entry.status} />
            {entry.status === BU_HANDOFF_STATUS.BLOCKED && (
              <span style={{ fontSize: 9, fontFamily: fm, color: '#f87171' }}>
                {entry.blockedReason}
              </span>
            )}
            {isUsable && entry.completedAtomCount != null && (
              <span style={{ fontSize: 8, fontFamily: fm, color: 'var(--muted)' }}>
                {entry.completedAtomCount}/{entry.totalAtomCount} atoms
              </span>
            )}
          </div>
          {isUsable && entry.sourcePersistAt && (
            <div style={{ fontSize: 8, fontFamily: fm, color: 'var(--muted)', marginTop: 2 }}>
              Source persisted {new Date(entry.sourcePersistAt).toLocaleString()}
            </div>
          )}
        </div>
        <span style={{ fontSize: 9, color: 'var(--muted)', flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </div>

      {/* Expanded content — only shown for non-blocked entries */}
      {open && (
        <div style={{ padding: '12px 14px' }}>
          {entry.status === BU_HANDOFF_STATUS.BLOCKED ? (
            <div style={errorBannerStyle}>
              <strong>Blocked:</strong> {entry.blockedReason}
              <br />This BU's execution plan was not durably persisted and cannot be forwarded to Stage 4.
            </div>
          ) : (
            <>
              {entry.status === BU_HANDOFF_STATUS.PARTIAL && (
                <div style={warnBannerStyle}>
                  Partial handoff — some execution atoms failed or are incomplete.
                  Stage 4 will use only the sections that were durably generated.
                </div>
              )}

              {/* Plan summary */}
              {entry.plan && (
                <div style={{ marginBottom: 10 }}>
                  <div style={labelStyle}>BU summary</div>
                  {entry.plan.mission && (
                    <div style={{ fontSize: 10, fontFamily: fm, color: 'var(--muted2)', marginBottom: 4, lineHeight: 1.55 }}>
                      <strong>Mission:</strong> {entry.plan.mission}
                    </div>
                  )}
                  {entry.plan.strategicRole && (
                    <div style={{ fontSize: 10, fontFamily: fm, color: 'var(--muted2)', marginBottom: 4, lineHeight: 1.55 }}>
                      <strong>Strategic role:</strong> {entry.plan.strategicRole}
                    </div>
                  )}
                  {entry.plan.priorityOutcomes?.length > 0 && (
                    <div style={{ fontSize: 10, fontFamily: fm, color: 'var(--muted2)', lineHeight: 1.55 }}>
                      <strong>Priority outcomes:</strong>
                      <ul style={{ margin: '3px 0 0 16px', padding: 0 }}>
                        {entry.plan.priorityOutcomes.map((o, i) => <li key={i}>{o}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* Execution sections */}
              {entry.executionSections?.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={labelStyle}>Execution sections ({entry.executionSections.length})</div>
                  {entry.executionSections.map((s, i) => (
                    <div key={i} style={{
                      marginBottom: 6,
                      padding: '8px 10px',
                      background: 'var(--s2)',
                      borderRadius: 4,
                      border: '1px solid var(--border)',
                    }}>
                      <div style={{ fontSize: 10, fontWeight: 600, marginBottom: 3 }}>{s.sectionName}</div>
                      {s.objective && (
                        <div style={{ fontSize: 9, fontFamily: fm, color: 'var(--muted2)', lineHeight: 1.55 }}>
                          {s.objective}
                        </div>
                      )}
                      {s.decisionsRequired?.length > 0 && (
                        <div style={{ fontSize: 9, fontFamily: fm, color: 'var(--muted)', marginTop: 3, lineHeight: 1.45 }}>
                          Decisions required: {s.decisionsRequired.join(' · ')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Stage 4 delivery implications */}
              {entry.stage4DeliveryImplications?.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <div style={labelStyle}>Stage 4 delivery implications</div>
                  <ul style={{ margin: 0, paddingLeft: 16 }}>
                    {entry.stage4DeliveryImplications.map((impl, i) => (
                      <li key={i} style={{ fontSize: 9, fontFamily: fm, color: 'var(--muted2)', lineHeight: 1.55 }}>
                        {impl}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Source atom IDs — for audit */}
              {entry.sourceAtomIds?.length > 0 && (
                <div style={{ fontSize: 8, fontFamily: fm, color: 'var(--muted)', marginTop: 6 }}>
                  Source atom IDs: {entry.sourceAtomIds.length} · key: {entry.sourcePersistKey}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Artifact planning ──────────────────────────────────────────────────────────

const readinessCfg = {
  [ARTIFACT_READINESS.READY]:   { color: '#00e5b4', label: 'READY' },
  [ARTIFACT_READINESS.PARTIAL]: { color: '#fb923c', label: 'PARTIAL' },
  [ARTIFACT_READINESS.BLOCKED]: { color: '#f87171', label: 'BLOCKED' },
}

function ReadinessBadge({ status }) {
  const cfg = readinessCfg[status] || { color: 'var(--muted)', label: String(status).toUpperCase() }
  return (
    <span style={{
      fontSize: 8, fontFamily: fm, fontWeight: 700, letterSpacing: '.04em',
      color: cfg.color, background: `${cfg.color}18`,
      border: `1px solid ${cfg.color}44`,
      borderRadius: 4, padding: '2px 7px',
    }}>
      {cfg.label}
    </span>
  )
}

function ArtifactCard({ artifact, selected, onToggle, editing }) {
  const isBlocked = artifact.readinessStatus === ARTIFACT_READINESS.BLOCKED
  return (
    <div style={{
      background: 'var(--s2)',
      border: `1px solid ${selected && !isBlocked ? 'rgba(59,130,246,.35)' : 'var(--border)'}`,
      borderRadius: 5,
      padding: '9px 12px',
      opacity: isBlocked ? 0.6 : 1,
      display: 'flex',
      gap: 10,
      alignItems: 'flex-start',
    }}>
      {/* Checkbox — only shown in edit mode and when not blocked */}
      {editing && !isBlocked && (
        <input
          type="checkbox"
          checked={!!selected}
          onChange={() => onToggle(artifact.artifactId)}
          style={{ marginTop: 2, flexShrink: 0, cursor: 'pointer' }}
        />
      )}
      {editing && isBlocked && (
        <div style={{ width: 13, flexShrink: 0 }} />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 3 }}>
          <span style={{ fontSize: 10, fontWeight: 600 }}>{artifact.title}</span>
          <ReadinessBadge status={artifact.readinessStatus} />
          {artifact.businessUnitName && (
            <span style={{ fontSize: 8, fontFamily: fm, color: 'var(--muted)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 6px' }}>
              {artifact.businessUnitName}
            </span>
          )}
        </div>
        <div style={{ fontSize: 9, fontFamily: fm, color: 'var(--muted2)', lineHeight: 1.55 }}>
          {artifact.purpose}
        </div>
        {isBlocked && artifact.blockedReason && (
          <div style={{ fontSize: 8, fontFamily: fm, color: '#f87171', marginTop: 3, lineHeight: 1.4 }}>
            Blocked: {artifact.blockedReason}
          </div>
        )}
      </div>
      {/* Selection indicator when not in edit mode */}
      {!editing && !isBlocked && (
        <span style={{ fontSize: 8, fontFamily: fm, color: selected ? '#00e5b4' : 'var(--muted)', flexShrink: 0, marginTop: 2 }}>
          {selected ? '✓ Selected' : '—'}
        </span>
      )}
    </div>
  )
}

function ArtifactGroup({ label, artifacts, selectedIds, onToggle, editing }) {
  if (!artifacts.length) return null
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 8, fontFamily: fm, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 }}>
        {label} ({artifacts.length})
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {artifacts.map(a => (
          <ArtifactCard
            key={a.artifactId}
            artifact={a}
            selected={selectedIds.has(a.artifactId)}
            onToggle={onToggle}
            editing={editing}
          />
        ))}
      </div>
    </div>
  )
}

function ArtifactPlanningSection({ handoff, workspaceId, stage1ActiveId, stage2ActiveId, stage3ActiveId }) {
  // ap = artifact plan phase
  const [apPhase, setApPhase]       = useState('checking')  // checking | not_found | suggesting | saving | ready | stale | failed
  const [plan, setPlan]             = useState(null)         // verified from IDB
  const [editingPlan, setEditingPlan] = useState(null)       // in-memory plan being composed/edited
  const [selectedIds, setSelectedIds] = useState(new Set())  // selections during edit
  const [apError, setApError]       = useState(null)
  const savingRef                   = useRef(false)

  // On mount and when handoff changes: try to load existing plan from IDB
  useEffect(() => {
    if (!workspaceId || !stage1ActiveId || !stage2ActiveId || !stage3ActiveId || !handoff) {
      setApPhase('not_found')
      return
    }
    let cancelled = false
    setApPhase('checking')
    loadArtifactPlan(workspaceId, stage1ActiveId, stage2ActiveId, stage3ActiveId)
      .then(existing => {
        if (cancelled) return
        if (existing) {
          if (isArtifactPlanStale(existing, handoff)) {
            setPlan(existing)
            setApPhase('stale')
          } else {
            setPlan(existing)
            setApPhase('ready')
          }
        } else {
          setApPhase('not_found')
        }
      })
      .catch(() => { if (!cancelled) setApPhase('not_found') })
    return () => { cancelled = true }
  }, [workspaceId, stage1ActiveId, stage2ActiveId, stage3ActiveId, handoff?.persistedAt])

  function handleCreate() {
    const draft = buildArtifactPlan(handoff, workspaceId, stage1ActiveId, stage2ActiveId, stage3ActiveId)
    const initSelected = new Set(
      [...draft.globalArtifacts, ...draft.businessUnitArtifacts]
        .filter(a => a.selected)
        .map(a => a.artifactId)
    )
    setEditingPlan(draft)
    setSelectedIds(initSelected)
    setApPhase('suggesting')
  }

  function handleRebuild() {
    handleCreate()
  }

  function handleToggle(artifactId) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(artifactId) ? next.delete(artifactId) : next.add(artifactId)
      return next
    })
  }

  async function handleSave(status = ARTIFACT_PLAN_STATUS.DRAFT) {
    if (savingRef.current || !editingPlan) return
    savingRef.current = true
    setApError(null)
    setApPhase('saving')

    const applySelections = artifacts => artifacts.map(a => ({
      ...a,
      selected: a.readinessStatus !== ARTIFACT_READINESS.BLOCKED && selectedIds.has(a.artifactId),
      updatedAt: new Date().toISOString(),
    }))

    const planToSave = {
      ...editingPlan,
      globalArtifacts:      applySelections(editingPlan.globalArtifacts),
      businessUnitArtifacts: applySelections(editingPlan.businessUnitArtifacts),
      status,
    }

    try {
      const { ok, record } = await persistArtifactPlan(planToSave)
      if (!ok) {
        setApError('Artifact plan could not be written to storage. Retry to re-save.')
        setApPhase('failed')
        savingRef.current = false
        return
      }
      // Verify by reading back from IDB
      const verified = await loadArtifactPlan(workspaceId, stage1ActiveId, stage2ActiveId, stage3ActiveId)
      if (!verified) {
        setApError('Artifact plan was written but could not be read back from storage. Reload and retry.')
        setApPhase('failed')
        savingRef.current = false
        return
      }
      setPlan(verified)
      setEditingPlan(null)
      setApPhase('ready')
    } catch (err) {
      setApError(err?.message || String(err))
      setApPhase('failed')
    } finally {
      savingRef.current = false
    }
  }

  function handleEdit() {
    if (!plan) return
    const initSelected = new Set(
      [...plan.globalArtifacts, ...plan.businessUnitArtifacts]
        .filter(a => a.selected)
        .map(a => a.artifactId)
    )
    setEditingPlan(plan)
    setSelectedIds(initSelected)
    setApPhase('suggesting')
  }

  // Derive display data for ready/stale state
  const displayPlan   = apPhase === 'suggesting' ? editingPlan : plan
  const editing       = apPhase === 'suggesting'
  const selectedCount = apPhase === 'suggesting'
    ? selectedIds.size
    : [...(plan?.globalArtifacts || []), ...(plan?.businessUnitArtifacts || [])].filter(a => a.selected).length

  // Group BU artifacts by BU name for display
  function groupByBU(artifacts) {
    const map = new Map()
    for (const a of artifacts) {
      const k = a.businessUnitName || '(global)'
      if (!map.has(k)) map.set(k, [])
      map.get(k).push(a)
    }
    return map
  }

  return (
    <div>
      {/* Error banner */}
      {apError && (
        <div style={{
          padding: '10px 14px', marginBottom: 8,
          background: 'rgba(248,113,113,.07)', border: '1px solid rgba(248,113,113,.3)',
          borderRadius: 5, fontSize: 10, fontFamily: fm, color: '#f87171', lineHeight: 1.55,
        }}>
          <strong>Error:</strong> {apError}
        </div>
      )}

      {/* Stale warning */}
      {apPhase === 'stale' && (
        <div style={{
          padding: '10px 14px', marginBottom: 8,
          background: 'rgba(251,191,36,.07)', border: '1px solid rgba(251,191,36,.3)',
          borderRadius: 5, fontSize: 10, fontFamily: fm, color: '#fbbf24', lineHeight: 1.55,
        }}>
          <strong>Artifact plan is stale</strong> — the Stage 4 handoff was re-compiled after this plan was created.
          Rebuild to generate updated suggestions from the current handoff.
        </div>
      )}

      {/* Phase: checking */}
      {apPhase === 'checking' && (
        <div style={{ fontSize: 10, fontFamily: fm, color: 'var(--muted)', padding: '12px 0' }}>
          Loading artifact plan from storage…
        </div>
      )}

      {/* Phase: saving */}
      {apPhase === 'saving' && (
        <div style={{ fontSize: 10, fontFamily: fm, color: 'var(--muted)', padding: '12px 0' }}>
          Saving artifact plan to storage…
        </div>
      )}

      {/* Phase: not_found */}
      {apPhase === 'not_found' && (
        <div style={{
          ...cardStyle, padding: '16px 18px',
          border: '1px solid rgba(59,130,246,.25)',
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>No artifact plan yet</div>
          <div style={{ fontSize: 10, fontFamily: fm, color: 'var(--muted2)', lineHeight: 1.6, marginBottom: 12 }}>
            Create an artifact plan to decide which execution artifacts should be generated from the verified handoff.
            Suggestions are derived deterministically from BU readiness — no AI generation occurs during planning.
          </div>
          <button
            onClick={handleCreate}
            style={{
              fontSize: 10, fontFamily: fm, fontWeight: 600, padding: '7px 18px',
              borderRadius: 5, cursor: 'pointer',
              background: 'var(--accent, #3b82f6)', border: '1px solid var(--accent, #3b82f6)', color: '#000',
            }}
          >
            Create artifact plan from handoff
          </button>
        </div>
      )}

      {/* Phase: suggesting (edit mode) or ready/stale (view mode) */}
      {displayPlan && (apPhase === 'suggesting' || apPhase === 'ready' || apPhase === 'stale' || apPhase === 'failed') && (
        <div>
          {/* Verified banner — only in ready state */}
          {apPhase === 'ready' && plan?.persistedAt && (
            <div style={{
              padding: '8px 12px', marginBottom: 8,
              background: 'rgba(0,229,180,.06)', border: '1px solid rgba(0,229,180,.25)',
              borderRadius: 5, fontSize: 9, fontFamily: fm, color: '#00e5b4', lineHeight: 1.5,
            }}>
              ✓ Artifact plan saved to storage · {selectedCount} artifact{selectedCount !== 1 ? 's' : ''} selected
              {plan.status === ARTIFACT_PLAN_STATUS.READY_FOR_GENERATION && ' · Ready for generation'}
              {' · '}saved {new Date(plan.persistedAt).toLocaleString()}
            </div>
          )}

          {/* Selection summary bar */}
          <div style={{
            display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
            padding: '9px 12px', marginBottom: 8,
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 5,
          }}>
            <span style={{ fontSize: 10, fontFamily: fm, color: 'var(--muted2)' }}>
              {editing ? `${selectedIds.size} selected` : `${selectedCount} of ${(displayPlan.globalArtifacts?.length || 0) + (displayPlan.businessUnitArtifacts?.length || 0)} artifacts selected`}
            </span>
            {editing && (
              <>
                <button
                  onClick={() => handleSave(ARTIFACT_PLAN_STATUS.DRAFT)}
                  style={{
                    fontSize: 9, fontFamily: fm, fontWeight: 600, padding: '5px 14px',
                    borderRadius: 5, cursor: 'pointer',
                    background: 'var(--accent, #3b82f6)', border: '1px solid var(--accent, #3b82f6)', color: '#000',
                  }}
                >
                  Save artifact plan
                </button>
                <button
                  onClick={() => handleSave(ARTIFACT_PLAN_STATUS.READY_FOR_GENERATION)}
                  style={{
                    fontSize: 9, fontFamily: fm, fontWeight: 600, padding: '5px 14px',
                    borderRadius: 5, cursor: 'pointer',
                    background: 'var(--s2)', border: '1px solid var(--border)', color: 'var(--muted2)',
                  }}
                >
                  Save and mark ready for generation
                </button>
                <button
                  onClick={() => { setEditingPlan(null); setApPhase(plan ? (isArtifactPlanStale(plan, handoff) ? 'stale' : 'ready') : 'not_found') }}
                  style={{
                    fontSize: 9, fontFamily: fm, padding: '5px 10px',
                    borderRadius: 5, cursor: 'pointer',
                    background: 'none', border: 'none', color: 'var(--muted)',
                  }}
                >
                  Cancel
                </button>
              </>
            )}
            {!editing && apPhase === 'ready' && (
              <button
                onClick={handleEdit}
                style={{
                  fontSize: 9, fontFamily: fm, fontWeight: 600, padding: '5px 14px',
                  borderRadius: 5, cursor: 'pointer',
                  background: 'var(--s2)', border: '1px solid var(--border)', color: 'var(--muted2)',
                }}
              >
                Edit selections
              </button>
            )}
            {(apPhase === 'stale' || apPhase === 'failed') && (
              <button
                onClick={handleRebuild}
                style={{
                  fontSize: 9, fontFamily: fm, fontWeight: 600, padding: '5px 14px',
                  borderRadius: 5, cursor: 'pointer',
                  background: 'var(--accent, #3b82f6)', border: '1px solid var(--accent, #3b82f6)', color: '#000',
                }}
              >
                Rebuild from current handoff
              </button>
            )}
          </div>

          {/* Global artifacts */}
          <ArtifactGroup
            label="Global Artifacts"
            artifacts={displayPlan.globalArtifacts || []}
            selectedIds={editing ? selectedIds : new Set((displayPlan.globalArtifacts || []).filter(a => a.selected).map(a => a.artifactId))}
            onToggle={handleToggle}
            editing={editing}
          />

          {/* BU artifacts — grouped by BU */}
          {(() => {
            const buArtifacts = displayPlan.businessUnitArtifacts || []
            if (!buArtifacts.length) return null
            const groups = groupByBU(buArtifacts)
            const viewSelectedIds = new Set(buArtifacts.filter(a => a.selected).map(a => a.artifactId))
            return (
              <div>
                <div style={{ fontSize: 8, fontFamily: fm, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>
                  Business Unit Artifacts
                </div>
                {[...groups.entries()].map(([buName, artifacts]) => (
                  <div key={buName} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 9, fontFamily: fm, fontWeight: 600, color: 'var(--muted2)', marginBottom: 4 }}>
                      {buName}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {artifacts.map(a => (
                        <ArtifactCard
                          key={a.artifactId}
                          artifact={a}
                          selected={editing ? selectedIds.has(a.artifactId) : viewSelectedIds.has(a.artifactId)}
                          onToggle={handleToggle}
                          editing={editing}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )
          })()}
        </div>
      )}
    </div>
  )
}

// ── Main Stage 4 view ──────────────────────────────────────────────────────────

export default function Stage4View({
  workspaceId,
  stage1ActiveId,
  stage2ActiveId,
  stage3ActiveId,
  stage2BUs,           // ordered BU list from active Stage 2 revision
  onNavigateToStage3,
}) {
  // Phase 1: compile (in-memory, not shown as usable)
  // Phase 2: persist (write to IDB)
  // Phase 3: reload-verify (read back from IDB — this is the usable signal)
  const [phase, setPhase]         = useState('idle')   // idle | compiling | persisting | verifying | ready | error
  const [compileError, setCompileError] = useState(null)
  const [persistError, setPersistError] = useState(null)
  const [handoff, setHandoff]     = useState(null)      // only set once verified from storage
  const [idbReady, setIdbReady]   = useState(false)
  const compilingRef              = useRef(false)       // guard against double-invoke

  const hasRequiredIds = !!(workspaceId && stage1ActiveId && stage2ActiveId && stage3ActiveId)
  const buNames = (stage2BUs || []).map(bu => bu.name).filter(Boolean)

  // Resolve idbReady once the IDB cache initialises
  useEffect(() => {
    let active = true
    storageReady()
      .then(() => { if (active) setIdbReady(true) })
      .catch(() => { if (active) setIdbReady(false) })
    return () => { active = false }
  }, [])

  // On mount (or when IDs change), attempt to load an existing persisted handoff
  useEffect(() => {
    if (!hasRequiredIds || !idbReady) return
    let cancelled = false
    setPhase('verifying')
    loadStage4Handoff(workspaceId, stage1ActiveId, stage2ActiveId, stage3ActiveId)
      .then(record => {
        if (cancelled) return
        if (record) {
          setHandoff(record)
          setPhase('ready')
        } else {
          setPhase('idle')
        }
      })
      .catch(() => {
        if (!cancelled) setPhase('idle')
      })
    return () => { cancelled = true }
  }, [workspaceId, stage1ActiveId, stage2ActiveId, stage3ActiveId, idbReady])

  const handleCompileAndPersist = useCallback(async () => {
    if (compilingRef.current) return
    compilingRef.current = true
    setCompileError(null)
    setPersistError(null)
    setHandoff(null)

    try {
      // Phase 1 — compile from IDB sources only (never from React state)
      setPhase('compiling')
      const compiled = await compileStage4Handoff({
        workspaceId,
        stage1Id: stage1ActiveId,
        stage2Id: stage2ActiveId,
        stage3Id: stage3ActiveId,
        buNames,
      })

      // Phase 2 — persist to IDB; do not show content until this succeeds
      setPhase('persisting')
      const { ok, record } = await persistStage4Handoff(compiled)
      if (!ok) {
        setPersistError('Handoff could not be written to storage. Do not treat this as usable until it persists.')
        setPhase('error')
        compilingRef.current = false
        return
      }

      // Phase 3 — verify by reading back from storage (confirms durability)
      setPhase('verifying')
      const verified = await loadStage4Handoff(
        workspaceId, stage1ActiveId, stage2ActiveId, stage3ActiveId,
      )
      if (!verified) {
        setPersistError('Handoff was written but could not be read back from storage. Reload and retry.')
        setPhase('error')
        compilingRef.current = false
        return
      }

      // Only now is the handoff usable
      setHandoff(verified)
      setPhase('ready')
    } catch (err) {
      setCompileError(err?.message || String(err))
      setPhase('error')
    } finally {
      compilingRef.current = false
    }
  }, [workspaceId, stage1ActiveId, stage2ActiveId, stage3ActiveId, buNames])

  // ── Guard: missing upstream IDs ─────────────────────────────────────────────
  if (!hasRequiredIds) {
    return (
      <div style={{ maxWidth: 840, padding: '0 16px 40px' }}>
        <div style={{ ...cardStyle, textAlign: 'center', padding: '40px 32px' }}>
          <div style={{ fontSize: 22, opacity: .12, marginBottom: 14 }}>◯</div>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Stage 3 required</div>
          <div style={{ fontSize: 10, fontFamily: fm, color: 'var(--muted)', lineHeight: 1.7 }}>
            Stage 4 requires active Stage 1, 2, and 3 revisions. Complete Stage 3 first.
          </div>
          {onNavigateToStage3 && (
            <button
              onClick={onNavigateToStage3}
              style={{ ...btnSecondary, marginTop: 14 }}
            >
              ← Back to Stage 3
            </button>
          )}
        </div>
      </div>
    )
  }

  // ── Guard: IDB not yet ready ─────────────────────────────────────────────────
  if (!idbReady) {
    return (
      <div style={{ maxWidth: 840, padding: '0 16px 40px' }}>
        <div style={{ ...cardStyle, padding: '28px 24px', textAlign: 'center' }}>
          <div style={{ fontSize: 10, fontFamily: fm, color: 'var(--muted)' }}>
            Waiting for storage to initialise…
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 840, padding: '0 16px 40px' }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ ...cardStyle, display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
            Stage 4 — Product Delivery
          </div>
          <div style={{ fontSize: 10, fontFamily: fm, color: 'var(--muted2)', lineHeight: 1.6 }}>
            PDLC strategy, epic-level requirements, acceptance criteria, non-functional requirements,
            delivery sequencing, and implementation governance — compiled from durably persisted Stage 3
            BU execution plans.
          </div>
        </div>
        {onNavigateToStage3 && (
          <button onClick={onNavigateToStage3} style={{ ...btnSecondary, flexShrink: 0 }}>
            ← Stage 3
          </button>
        )}
      </div>

      {/* ── Compile / status section ────────────────────────────────────────── */}
      <div style={{ ...labelStyle, marginTop: 4 }}>
        A · Stage 3 → Stage 4 Handoff
      </div>

      {/* Error banners */}
      {compileError && (
        <div style={errorBannerStyle}>
          <strong>Compilation error:</strong> {compileError}
        </div>
      )}
      {persistError && (
        <div style={errorBannerStyle}>
          <strong>Persistence failed:</strong> {persistError}
          <br />Do not use this handoff. Retry to re-compile and re-persist.
        </div>
      )}

      {/* Phase status card — shown until the handoff is ready */}
      {phase !== 'ready' && (
        <div style={cardStyle}>
          {phase === 'idle' && (
            <>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6 }}>
                No Stage 4 handoff found
              </div>
              <div style={{ fontSize: 10, fontFamily: fm, color: 'var(--muted2)', lineHeight: 1.6, marginBottom: 12 }}>
                The Stage 4 handoff is prepared from Stage 3.
                Return to Stage 3, generate BU execution plans, then use the
                <strong> Prepare Stage 4 Handoff</strong> panel at the bottom of Stage 3.
              </div>
              {onNavigateToStage3 && (
                <button
                  onClick={onNavigateToStage3}
                  style={{ ...btnPrimary, marginBottom: 12 }}
                >
                  ← Go to Stage 3 to prepare handoff
                </button>
              )}
              <details style={{ marginTop: 4 }}>
                <summary style={{ fontSize: 9, fontFamily: fm, color: 'var(--muted)', cursor: 'pointer', userSelect: 'none' }}>
                  Recovery: rebuild handoff from durable Stage 3 records
                </summary>
                <div style={{ marginTop: 8, fontSize: 9, fontFamily: fm, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 8 }}>
                  Use this only if the Stage 3 handoff panel is unavailable.
                  Reads each BU's durable execution-plan record directly from IDB.
                  {buNames.length > 0 && ` ${buNames.length} BU${buNames.length !== 1 ? 's' : ''} in scope: ${buNames.join(', ')}`}
                </div>
                <button
                  onClick={handleCompileAndPersist}
                  disabled={!idbReady}
                  style={{ ...btnSecondary, opacity: idbReady ? 1 : 0.5 }}
                >
                  Rebuild handoff from durable Stage 3 records
                </button>
              </details>
            </>
          )}

          {phase === 'compiling' && (
            <div style={{ fontSize: 10, fontFamily: fm, color: 'var(--muted2)' }}>
              Reading Stage 3 BU plan records from storage…
            </div>
          )}

          {phase === 'persisting' && (
            <div style={{ fontSize: 10, fontFamily: fm, color: 'var(--muted2)' }}>
              Writing handoff to storage…
            </div>
          )}

          {phase === 'verifying' && (
            <div style={{ fontSize: 10, fontFamily: fm, color: 'var(--muted2)' }}>
              Verifying handoff from storage…
            </div>
          )}

          {phase === 'error' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 10, fontFamily: fm, color: '#f87171' }}>
                Handoff compilation or persistence failed. See error above.
              </div>
              <button onClick={handleCompileAndPersist} style={btnSecondary}>
                Retry
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Verified handoff — shown only after durable write + reload confirm ── */}
      {phase === 'ready' && handoff && (
        <>
          {/* Persistence confirmation */}
          <div style={successBannerStyle}>
            ✓ Handoff verified from storage · compiled {new Date(handoff.compiledAt).toLocaleString()}
            {' · '}persisted {new Date(handoff.persistedAt).toLocaleString()}
          </div>

          {/* Summary bar */}
          <div style={{ ...cardStyle, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', padding: '11px 14px' }}>
            <StatusBadge status={handoff.overallStatus} />
            <span style={{ fontSize: 10, fontFamily: fm, color: 'var(--muted2)' }}>
              {handoff.readyCount} ready · {handoff.partialCount} partial · {handoff.blockedCount} blocked
              {' / '}{handoff.totalCount} total BUs
            </span>
            <div style={{ marginLeft: 'auto' }}>
              <button
                onClick={handleCompileAndPersist}
                style={btnSecondary}
              >
                Rebuild handoff
              </button>
            </div>
          </div>

          {handoff.overallStatus === HANDOFF_STATUS.BLOCKED && (
            <div style={errorBannerStyle}>
              All BU handoffs are blocked — no usable Stage 3 execution plans were found in durable storage.
              Return to Stage 3 and ensure BU plans are successfully generated and persisted before recompiling.
            </div>
          )}

          {/* Per-BU handoff rows */}
          <div style={{ ...labelStyle, marginTop: 4 }}>
            B · BU Handoff Records ({handoff.buHandoffs.length})
          </div>
          {handoff.buHandoffs.map(entry => (
            <BuHandoffRow key={entry.buName} entry={entry} />
          ))}

          {/* Artifact planning */}
          <div style={{ ...labelStyle, marginTop: 8 }}>
            C · Artifact Planning
          </div>
          <ArtifactPlanningSection
            handoff={handoff}
            workspaceId={workspaceId}
            stage1ActiveId={stage1ActiveId}
            stage2ActiveId={stage2ActiveId}
            stage3ActiveId={stage3ActiveId}
          />

          {/* Stage 5 CTA */}
          <div style={{
            ...cardStyle,
            display: 'flex', alignItems: 'center', gap: 16,
            border: '1px solid rgba(59,130,246,.3)',
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
                Continue to Stage 5 — Synthesis
              </div>
              <div style={{ fontSize: 10, fontFamily: fm, color: 'var(--muted2)', lineHeight: 1.65 }}>
                Stage 5 will synthesize learning signals across Stages 1–4 into reusable strategy
                patterns, prompt improvements, and execution-planning heuristics.
              </div>
            </div>
            <button
              style={{ ...btnSecondary, flexShrink: 0, opacity: 0.5, cursor: 'default' }}
              disabled
            >
              Stage 5 →
            </button>
          </div>
        </>
      )}
    </div>
  )
}
