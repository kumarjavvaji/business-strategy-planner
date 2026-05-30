import { useState, useEffect, useCallback, useRef } from 'react'
import {
  compileStage4Handoff,
  persistStage4Handoff,
  loadStage4Handoff,
  BU_HANDOFF_STATUS,
  HANDOFF_STATUS,
} from '../utils/stage4Handoff'
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
                No Stage 4 handoff compiled yet
              </div>
              <div style={{ fontSize: 10, fontFamily: fm, color: 'var(--muted2)', lineHeight: 1.6, marginBottom: 12 }}>
                Compiling reads each BU's durable Stage 3 execution-plan record from storage.
                Only records with a confirmed <code>persistedAt</code> timestamp and completed
                execution atoms are forwarded. Blocked BUs are identified explicitly.
              </div>
              <div style={{ fontSize: 9, fontFamily: fm, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.5 }}>
                {buNames.length} BU{buNames.length !== 1 ? 's' : ''} in scope: {buNames.join(', ')}
              </div>
              <button
                onClick={handleCompileAndPersist}
                disabled={!idbReady}
                style={{ ...btnPrimary, opacity: idbReady ? 1 : 0.5 }}
              >
                Compile Stage 4 handoff
              </button>
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
                Recompile handoff
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
