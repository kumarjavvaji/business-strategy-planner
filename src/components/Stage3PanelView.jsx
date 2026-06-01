/**
 * Stage3PanelView — expandable, audited, refinable panel UI for Stage 3 compiled plans.
 *
 * Default collapsed view shows: panel title · audit status badge · short summary · last refined.
 * Expanded view shows: full content · completeness audit · cross-panel findings · refinement form · history.
 *
 * Relies on stage3PanelModel.js for all audit logic (no duplication here).
 */

import { useState, useCallback } from 'react'
import {
  PANEL_IDS, PANEL_LABELS, PANEL_ACCENTS, PANEL_AUDIT_STATUSES,
  CROSS_PANEL_QUALITY_STATUSES, REFINEMENT_STATUSES,
  resolvePanelDisplayStatus,
  synthesizePanelSummary,
} from '../utils/stage3PanelModel'
import {
  PANEL_LIFECYCLE,
  LIFECYCLE_DISPLAY,
  canAccept,
  canGenerate,
  canRefine,
  countPanelIssues,
} from '../utils/stage3PanelLifecycle'

// ── Shared primitives ─────────────────────────────────────────────────────────

function Badge({ children, color = '#00e5b4', small = false }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: small ? '1px 5px' : '2px 7px',
      borderRadius: 3,
      border: `1px solid ${color}55`,
      background: `${color}18`,
      color,
      fontSize: small ? 7 : 8,
      fontFamily: 'var(--fm)',
      fontWeight: 700,
      letterSpacing: '.04em',
      textTransform: 'uppercase',
      flexShrink: 0,
    }}>
      {children}
    </span>
  )
}

function LabeledText({ label, value }) {
  if (!value && value !== 0) return null
  const display = Array.isArray(value)
    ? value.filter(Boolean).join('\n')
    : typeof value === 'object'
      ? Object.values(value).filter(Boolean).join(' ')
      : String(value)
  if (!display.trim()) return null
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 7, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 9, color: 'var(--muted2)', lineHeight: 1.65, fontFamily: 'var(--fm)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{display}</div>
    </div>
  )
}

function SectionDivider() {
  return <div style={{ height: 1, background: 'var(--border)', margin: '8px 0' }} />
}

// ── Audit status badge ────────────────────────────────────────────────────────

const STATUS_COLORS = {
  failed:                                  '#f87171',
  draft_ready:                             '#fb923c',
  accepted:                                '#00e5b4',
  not_started:                             '#6b7280',
  [PANEL_AUDIT_STATUSES.COMPLETE]:         '#00e5b4',
  [PANEL_AUDIT_STATUSES.INCOMPLETE]:       '#f87171',
  [PANEL_AUDIT_STATUSES.TRUNCATED]:        '#f87171',
  [PANEL_AUDIT_STATUSES.REDUNDANT]:        '#fb923c',
  [PANEL_AUDIT_STATUSES.MISALIGNED]:       '#fb923c',
  [PANEL_AUDIT_STATUSES.NEEDS_REFINEMENT]: '#fb923c',
}

function PanelStatusBadge({ status }) {
  const color = STATUS_COLORS[status] || '#6b7280'
  const label = status ? status.replace(/_/g, ' ').toUpperCase() : 'UNKNOWN'
  return <Badge color={color} small>{label}</Badge>
}

function LifecycleBadge({ lifecycle }) {
  const meta = LIFECYCLE_DISPLAY[lifecycle || PANEL_LIFECYCLE.NOT_STARTED] || LIFECYCLE_DISPLAY[PANEL_LIFECYCLE.NOT_STARTED]
  return <Badge color={meta.color} small>{meta.label}</Badge>
}

// ── Completeness audit detail ─────────────────────────────────────────────────

function PanelAuditDetail({ audit, crossPanelAudit, panelId }) {
  if (!audit) return null
  const hasCrossFindings = crossPanelAudit
    ? [
        ...(crossPanelAudit.repeatedPhrases   || []).filter(r => r.panelA === panelId || r.panelB === panelId),
        ...(crossPanelAudit.misplacedContentFindings || []).filter(f => f.includes(PANEL_LABELS[panelId] || '')),
        ...(crossPanelAudit.duplicatedFieldPairs     || []).filter(p => p.source?.includes(panelId) || p.target?.includes(panelId)),
        ...(crossPanelAudit.planAlignmentFindings    || []).filter(f => f.includes(PANEL_LABELS[panelId] || '')),
      ]
    : []

  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
      {/* Recommended action */}
      {audit.recommendedAction && (
        <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: STATUS_COLORS[audit.status] || 'var(--muted2)', padding: '4px 7px', background: `${STATUS_COLORS[audit.status] || '#888'}11`, borderRadius: 3 }}>
          {audit.recommendedAction}
        </div>
      )}

      {/* Missing fields */}
      {audit.missingFields?.length > 0 && (
        <div>
          <div style={{ fontSize: 7, fontFamily: 'var(--fm)', color: '#f87171', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>Missing Fields</div>
          {audit.missingFields.map((f, i) => (
            <div key={i} style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', marginBottom: 2 }}>— {f}</div>
          ))}
        </div>
      )}

      {/* Truncated fields */}
      {audit.truncatedFields?.length > 0 && (
        <div>
          <div style={{ fontSize: 7, fontFamily: 'var(--fm)', color: '#f87171', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>Truncated Fields</div>
          {audit.truncatedFields.map((f, i) => (
            <div key={i} style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#f87171', marginBottom: 2 }}>⚠ {f}</div>
          ))}
        </div>
      )}

      {/* Weak / placeholder fields */}
      {audit.weakFields?.length > 0 && (
        <div>
          <div style={{ fontSize: 7, fontFamily: 'var(--fm)', color: '#fb923c', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>Weak / Placeholder Fields</div>
          {audit.weakFields.map((f, i) => (
            <div key={i} style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', marginBottom: 2 }}>— {f}</div>
          ))}
        </div>
      )}

      {/* Duplicate field findings */}
      {audit.duplicateFieldFindings?.length > 0 && (
        <div>
          <div style={{ fontSize: 7, fontFamily: 'var(--fm)', color: '#fb923c', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>Duplicate Field Violations</div>
          {audit.duplicateFieldFindings.map((f, i) => (
            <div key={i} style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', marginBottom: 2 }}>— {f}</div>
          ))}
        </div>
      )}

      {/* Cross-panel findings */}
      {hasCrossFindings.length > 0 && (
        <div>
          <div style={{ fontSize: 7, fontFamily: 'var(--fm)', color: '#fb923c', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>Cross-Panel Findings</div>
          {hasCrossFindings.map((f, i) => {
            const text = typeof f === 'string' ? f : f.note || JSON.stringify(f)
            return <div key={i} style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', marginBottom: 2 }}>— {text}</div>
          })}
        </div>
      )}
    </div>
  )
}

// ── Per-panel content renderers ───────────────────────────────────────────────

function StrategicObjectiveContent({ content }) {
  if (!content) return <div style={{ fontSize: 9, color: 'var(--muted)', fontStyle: 'italic' }}>Not yet generated.</div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <LabeledText label="summary"              value={content.summary} />
      <LabeledText label="outcome focus"        value={content.outcomeFocus} />
      <LabeledText label="non-goals / boundaries" value={content.nonGoalsOrBoundaries} />
    </div>
  )
}

function CriticalDecisionItem({ d }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '8px 9px', background: 'var(--s2)', marginBottom: 6 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#3b82f6', marginBottom: 6 }}>{d.decisionName}</div>
      <LabeledText label="question"        value={d.decisionQuestion} />
      <LabeledText label="why it matters"  value={d.whyItMatters} />
      <LabeledText label="options"         value={d.decisionOptions} />
      <LabeledText label="evidence needed" value={d.decisionEvidenceNeeded} />
      <LabeledText label="timing"          value={d.decisionTiming} />
    </div>
  )
}

function ExecutionPhaseItem({ p }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '8px 9px', background: 'var(--s2)', marginBottom: 6 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#00e5b4', marginBottom: 5 }}>{p.phaseName}</div>
      <LabeledText label="phase objective"       value={p.phaseObjective} />
      <LabeledText label="recommended how"       value={p.recommendedHow} />
      <LabeledText label="why this fits"         value={p.whyThisFitsThePhase} />
      <LabeledText label="exit criteria"         value={p.exitCriteria} />
      {p.howOptions?.length > 0 && (
        <div style={{ marginTop: 5 }}>
          <div style={{ fontSize: 7, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 4 }}>how options</div>
          {p.howOptions.map((opt, i) => (
            <div key={i} style={{ paddingLeft: 7, borderLeft: '2px solid rgba(0,229,180,.35)', marginBottom: 5 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>{opt.optionName}</div>
              <LabeledText label="when to use"  value={opt.whenToUse} />
              <LabeledText label="why it fits"  value={opt.whyItFitsThePhaseOutcome} />
              <LabeledText label="evidence"     value={opt.evidenceProduced} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DependencyItem({ d }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '8px 9px', background: 'var(--s2)', marginBottom: 6 }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: '#fb923c', marginBottom: 5 }}>{d.dependencyName}</div>
      <LabeledText label="description"          value={d.dependencyDescription} />
      <LabeledText label="required input"       value={d.requiredInput} />
      <LabeledText label="consequence if missing" value={d.consequenceIfMissing} />
    </div>
  )
}

function RiskItem({ r }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '8px 9px', background: 'var(--s2)', marginBottom: 6 }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: '#f87171', marginBottom: 5 }}>{r.riskName}</div>
      <LabeledText label="failure mode"           value={r.riskDescription} />
      <LabeledText label="why it matters"         value={r.whyItMatters} />
      <LabeledText label="mitigation options"     value={r.mitigationOptions} />
      <LabeledText label="early warning signals"  value={r.earlyWarningSignals} />
      <LabeledText label="evidence risk reduced"  value={r.evidenceThatRiskIsReduced} />
    </div>
  )
}

function ValidationItem({ v }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '8px 9px', background: 'var(--s2)', marginBottom: 6 }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: '#a3e635', marginBottom: 5 }}>{v.validationQuestion}</div>
      <LabeledText label="completion criteria"         value={v.completionCriteria} />
      <LabeledText label="how to determine completion" value={v.howToDetermineCompletion} />
      <LabeledText label="evidence examples"           value={v.evidenceExamples} />
      <LabeledText label="veracity checks"             value={v.veracityChecks} />
      <LabeledText label="failure / rework triggers"   value={v.failureOrReworkTriggers} />
    </div>
  )
}

function PanelContent({ panelId, content }) {
  if (!content) return <div style={{ fontSize: 9, color: 'var(--muted)', fontStyle: 'italic', padding: '8px 0' }}>No content available for this panel.</div>

  switch (panelId) {
    case 'strategicObjective':
      return <StrategicObjectiveContent content={content} />
    case 'criticalDecisions':
      return <div>{Array.isArray(content) ? content.map((d, i) => <CriticalDecisionItem key={i} d={d} />) : null}</div>
    case 'executionSequence':
      return <div>{Array.isArray(content) ? content.map((p, i) => <ExecutionPhaseItem key={i} p={p} />) : null}</div>
    case 'dependencies':
      return <div>{Array.isArray(content) ? content.map((d, i) => <DependencyItem key={i} d={d} />) : null}</div>
    case 'risks':
      return <div>{Array.isArray(content) ? content.map((r, i) => <RiskItem key={i} r={r} />) : null}</div>
    case 'validationFramework':
      return <div>{Array.isArray(content) ? content.map((v, i) => <ValidationItem key={i} v={v} />) : null}</div>
    default:
      return <div style={{ fontSize: 9, color: 'var(--muted)' }}>Unknown panel type.</div>
  }
}

// ── Refinement form ───────────────────────────────────────────────────────────

function PanelRefinementForm({ panelId, isRunning, onSubmit, onCancel }) {
  const [prompt, setPrompt]               = useState('')
  const [impactSummary, setImpactSummary] = useState('')

  const handleSubmit = useCallback(() => {
    if (!prompt.trim() || isRunning) return
    onSubmit({ prompt: prompt.trim(), impactSummary: impactSummary.trim() })
  }, [prompt, impactSummary, isRunning, onSubmit])

  return (
    <div style={{ border: '1px solid rgba(59,130,246,.35)', borderRadius: 5, padding: '10px 11px', background: 'rgba(59,130,246,.05)', marginTop: 8 }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: '#3b82f6', marginBottom: 8 }}>Refine {PANEL_LABELS[panelId]}</div>
      <div style={{ marginBottom: 7 }}>
        <div style={{ fontSize: 7, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>Refinement instruction</div>
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder={`Describe what to change in this panel. Be specific — e.g. "The dependency description for API Engineering is the same as the required input. Separate them so each field serves a distinct role."`}
          style={{ width: '100%', minHeight: 64, fontSize: 9, fontFamily: 'var(--fm)', padding: '5px 7px', borderRadius: 3, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', resize: 'vertical', boxSizing: 'border-box' }}
          disabled={isRunning}
        />
      </div>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 7, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>Impact summary (optional)</div>
        <input
          type="text"
          value={impactSummary}
          onChange={e => setImpactSummary(e.target.value)}
          placeholder="e.g. Separates required input from description to fix the field duplication finding."
          style={{ width: '100%', fontSize: 9, fontFamily: 'var(--fm)', padding: '4px 7px', borderRadius: 3, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', boxSizing: 'border-box' }}
          disabled={isRunning}
        />
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button
          onClick={onCancel}
          disabled={isRunning}
          style={{ fontSize: 8, fontFamily: 'var(--fm)', padding: '4px 10px', borderRadius: 3, border: '1px solid var(--border)', background: 'transparent', color: 'var(--muted)', cursor: isRunning ? 'not-allowed' : 'pointer' }}
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!prompt.trim() || isRunning}
          style={{ fontSize: 8, fontFamily: 'var(--fm)', padding: '4px 10px', borderRadius: 3, border: '1px solid #3b82f688', background: !prompt.trim() || isRunning ? '#3b82f618' : '#3b82f633', color: !prompt.trim() || isRunning ? '#3b82f666' : '#3b82f6', cursor: !prompt.trim() || isRunning ? 'not-allowed' : 'pointer', fontWeight: 700 }}
        >
          {isRunning ? 'Refining…' : 'Submit Refinement'}
        </button>
      </div>
    </div>
  )
}

// ── Refinement history entry ──────────────────────────────────────────────────

function RefinementHistoryEntry({ entry }) {
  const [open, setOpen] = useState(false)
  const statusColor = entry.status === REFINEMENT_STATUSES.ACCEPTED ? '#00e5b4'
    : entry.status === REFINEMENT_STATUSES.REJECTED ? '#f87171'
    : entry.status === REFINEMENT_STATUSES.FAILED ? '#f87171'
    : '#fb923c'
  const auditImproved = entry.auditBefore && entry.auditAfter
    ? entry.auditBefore.status !== PANEL_AUDIT_STATUSES.COMPLETE && entry.auditAfter.status === PANEL_AUDIT_STATUSES.COMPLETE
    : null
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 4, marginBottom: 5, overflow: 'hidden' }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 9px', background: 'var(--s2)', cursor: 'pointer' }}
      >
        <Badge color={statusColor} small>{entry.status}</Badge>
        {auditImproved === true  && <Badge color="#00e5b4" small>audit improved</Badge>}
        {auditImproved === false && <Badge color="#fb923c" small>audit unchanged</Badge>}
        <div style={{ flex: 1, fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {entry.prompt.slice(0, 100)}
        </div>
        <div style={{ fontSize: 7, fontFamily: 'var(--fm)', color: 'var(--muted2)', flexShrink: 0 }}>
          {entry.createdAt ? new Date(entry.createdAt).toLocaleDateString() : ''}
        </div>
        <span style={{ fontSize: 7, color: 'var(--muted)' }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div style={{ padding: '8px 9px', display: 'flex', flexDirection: 'column', gap: 5 }}>
          <LabeledText label="prompt"         value={entry.prompt} />
          {entry.impactSummary && <LabeledText label="impact summary" value={entry.impactSummary} />}
          {entry.changedFields?.length > 0 && <LabeledText label="changed fields" value={entry.changedFields.join(', ')} />}
          {entry.auditBefore && <LabeledText label="audit before" value={`Status: ${entry.auditBefore.status}`} />}
          {entry.auditAfter  && <LabeledText label="audit after"  value={`Status: ${entry.auditAfter.status}${entry.auditAfter.recommendedAction ? ' — ' + entry.auditAfter.recommendedAction : ''}`} />}
          {entry.failureReason && <LabeledText label="failure reason" value={entry.failureReason} />}
          {entry.error       && !entry.failureReason && <LabeledText label="error" value={entry.error} />}
          {entry.acceptedAt  && <LabeledText label="accepted at"  value={new Date(entry.acceptedAt).toLocaleString()} />}
          {entry.rejectedAt  && <LabeledText label="rejected at"  value={new Date(entry.rejectedAt).toLocaleString()} />}
          {entry.failedAt    && <LabeledText label="failed at"    value={new Date(entry.failedAt).toLocaleString()} />}
        </div>
      )}
    </div>
  )
}

// ── Panel card ────────────────────────────────────────────────────────────────

function PanelCard({ panelId, panel, crossPanelAudit, runningRefinementId, onRefine, onGenerate, onAccept, onReject, hasApiKey }) {
  const [expanded,        setExpanded]        = useState(false)
  const [showAudit,       setShowAudit]       = useState(false)
  const [showRefinement,  setShowRefinement]  = useState(false)
  const [showHistory,     setShowHistory]     = useState(false)

  const label   = PANEL_LABELS[panelId]
  const accent  = PANEL_ACCENTS[panelId] || '#00e5b4'
  const audit   = panel?.completenessAudit
  const content = panel?.content
  const history = panel?.refinementHistory || []
  const isRunning = runningRefinementId === panelId
  const lifecycle = isRunning ? PANEL_LIFECYCLE.GENERATING : (panel?.lifecycle || PANEL_LIFECYCLE.NOT_STARTED)
  const displayedAuditStatus = resolvePanelDisplayStatus({ ...panel, lifecycle })
  const issueCount = countPanelIssues(panel, crossPanelAudit)
  const actionDisabled = lifecycle === PANEL_LIFECYCLE.GENERATING

  const summary     = synthesizePanelSummary(panelId, content)
  const lastTouched = panel?.lastRefinedAt || panel?.lastGeneratedAt
  const lastTouchedLabel = lastTouched ? new Date(lastTouched).toLocaleDateString() : null

  const handleSubmitRefinement = useCallback(({ prompt, impactSummary }) => {
    if (onRefine) onRefine({ panelId, prompt, impactSummary })
    setShowRefinement(false)
  }, [panelId, onRefine])

  return (
    <div style={{ border: `1px solid ${accent}33`, borderRadius: 5, overflow: 'hidden', background: 'var(--surface)', marginBottom: 6 }}>
      {/* Collapsed header — always visible */}
      <div
        onClick={() => setExpanded(e => !e)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 11px', background: `${accent}0d`, borderBottom: expanded ? `1px solid ${accent}22` : 'none', cursor: 'pointer' }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: accent }}>{label}</span>
            <LifecycleBadge lifecycle={lifecycle} />
            {displayedAuditStatus && <PanelStatusBadge status={displayedAuditStatus} />}
            {isRunning && <Badge color="#3b82f6" small>refining…</Badge>}
            {issueCount > 0 && <Badge color="#f87171" small>{issueCount} issue{issueCount === 1 ? '' : 's'}</Badge>}
          </div>
          <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
          {lastTouchedLabel && <span style={{ fontSize: 7, fontFamily: 'var(--fm)', color: 'var(--muted2)' }}>updated {lastTouchedLabel}</span>}
          <span style={{ fontSize: 8, color: 'var(--muted)' }}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={{ padding: '10px 11px' }}>
          {/* Full panel content */}
          <PanelContent panelId={panelId} content={content} />

          {panel?.sourceAtomIds?.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <LabeledText label="source traceability" value={panel.sourceAtomIds.slice(0, 8).join(', ')} />
            </div>
          )}

          <SectionDivider />

          {/* Audit toggle */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
            {hasApiKey && onGenerate && canGenerate(panel) && (
              <button
                onClick={() => onGenerate({ panelId })}
                disabled={actionDisabled}
                style={{ fontSize: 7, fontFamily: 'var(--fm)', padding: '3px 8px', borderRadius: 3, border: '1px solid #00e5b488', background: 'transparent', color: '#00e5b4', cursor: actionDisabled ? 'not-allowed' : 'pointer' }}
              >
                {content ? 'regenerate panel' : 'generate panel'}
              </button>
            )}

            <button
              onClick={() => setShowAudit(a => !a)}
              style={{ fontSize: 7, fontFamily: 'var(--fm)', padding: '3px 8px', borderRadius: 3, border: `1px solid ${audit?.status === PANEL_AUDIT_STATUSES.COMPLETE ? '#00e5b488' : '#fb923c88'}`, background: 'transparent', color: audit?.status === PANEL_AUDIT_STATUSES.COMPLETE ? '#00e5b4' : '#fb923c', cursor: 'pointer' }}
            >
              {showAudit ? '▲ hide audit' : `▼ audit · ${audit?.status || 'pending'}`}
            </button>

            {hasApiKey && canRefine(panel) && (
              <button
                onClick={() => { setShowRefinement(r => !r); setShowHistory(false) }}
                disabled={actionDisabled}
                style={{ fontSize: 7, fontFamily: 'var(--fm)', padding: '3px 8px', borderRadius: 3, border: '1px solid #3b82f688', background: 'transparent', color: '#3b82f6', cursor: isRunning ? 'not-allowed' : 'pointer' }}
              >
                ✏ refine this panel
              </button>
            )}

            {onAccept && canAccept(panel) && (
              <button
                onClick={() => onAccept({ panelId })}
                disabled={actionDisabled}
                style={{ fontSize: 7, fontFamily: 'var(--fm)', padding: '3px 8px', borderRadius: 3, border: '1px solid #00e5b488', background: 'rgba(0,229,180,.08)', color: '#00e5b4', cursor: actionDisabled ? 'not-allowed' : 'pointer', fontWeight: 700 }}
              >
                accept panel
              </button>
            )}

            {onReject && content && lifecycle !== PANEL_LIFECYCLE.NOT_STARTED && (
              <button
                onClick={() => onReject({ panelId })}
                disabled={actionDisabled}
                style={{ fontSize: 7, fontFamily: 'var(--fm)', padding: '3px 8px', borderRadius: 3, border: '1px solid #f8717188', background: 'transparent', color: '#f87171', cursor: actionDisabled ? 'not-allowed' : 'pointer' }}
              >
                reject draft
              </button>
            )}

            {history.length > 0 && (
              <button
                onClick={() => { setShowHistory(h => !h); setShowRefinement(false) }}
                style={{ fontSize: 7, fontFamily: 'var(--fm)', padding: '3px 8px', borderRadius: 3, border: '1px solid var(--border)', background: 'transparent', color: 'var(--muted)', cursor: 'pointer' }}
              >
                {showHistory ? '▲ hide history' : `▼ history · ${history.length}`}
              </button>
            )}
          </div>

          {/* Completeness audit detail */}
          {showAudit && (
            <PanelAuditDetail audit={audit} crossPanelAudit={crossPanelAudit} panelId={panelId} />
          )}

          {/* Per-panel refinement form */}
          {showRefinement && !isRunning && (
            <PanelRefinementForm
              panelId={panelId}
              isRunning={isRunning}
              onSubmit={handleSubmitRefinement}
              onCancel={() => setShowRefinement(false)}
            />
          )}

          {isRunning && (
            <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: '#3b82f6', padding: '8px 0', fontStyle: 'italic' }}>
              Refining {label}…
            </div>
          )}

          {/* Refinement history */}
          {showHistory && history.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>Refinement History</div>
              {history.slice().reverse().map(entry => (
                <RefinementHistoryEntry key={entry.refinementId} entry={entry} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Cross-panel audit summary ─────────────────────────────────────────────────

function CrossPanelAuditSummary({ crossPanelAudit }) {
  const [open, setOpen] = useState(false)
  if (!crossPanelAudit) return null
  const { qualityStatus, repeatedPhrases, duplicatedFieldPairs, misplacedContentFindings, planAlignmentFindings } = crossPanelAudit
  const totalIssues = (repeatedPhrases?.length || 0) + (duplicatedFieldPairs?.length || 0) + (misplacedContentFindings?.length || 0) + (planAlignmentFindings?.length || 0)
  const color = qualityStatus === CROSS_PANEL_QUALITY_STATUSES.PASS ? '#00e5b4'
    : qualityStatus === CROSS_PANEL_QUALITY_STATUSES.NEEDS_REVIEW ? '#fb923c'
    : '#f87171'

  return (
    <div style={{ border: `1px solid ${color}33`, borderRadius: 5, overflow: 'hidden', background: 'var(--surface)', marginBottom: 6 }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 11px', background: `${color}0d`, cursor: 'pointer' }}
      >
        <Badge color={color} small>cross-panel · {qualityStatus}</Badge>
        <span style={{ flex: 1, fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
          {totalIssues === 0 ? 'No cross-panel issues detected.' : `${totalIssues} cross-panel finding${totalIssues === 1 ? '' : 's'}`}
        </span>
        <span style={{ fontSize: 7, color: 'var(--muted)' }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div style={{ padding: '8px 11px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {repeatedPhrases?.length > 0 && (
            <div>
              <div style={{ fontSize: 7, fontFamily: 'var(--fm)', color: '#f87171', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>Repeated Content Across Panels</div>
              {repeatedPhrases.map((r, i) => (
                <div key={i} style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', marginBottom: 2 }}>— {PANEL_LABELS[r.panelA]} ↔ {PANEL_LABELS[r.panelB]}: {r.note}</div>
              ))}
            </div>
          )}
          {duplicatedFieldPairs?.length > 0 && (
            <div>
              <div style={{ fontSize: 7, fontFamily: 'var(--fm)', color: '#f87171', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>Duplicated Field Pairs</div>
              {duplicatedFieldPairs.map((p, i) => (
                <div key={i} style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', marginBottom: 2 }}>— {p.source} → {p.target}: {p.note}</div>
              ))}
            </div>
          )}
          {misplacedContentFindings?.length > 0 && (
            <div>
              <div style={{ fontSize: 7, fontFamily: 'var(--fm)', color: '#fb923c', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>Misplaced Content</div>
              {misplacedContentFindings.map((f, i) => (
                <div key={i} style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', marginBottom: 2 }}>— {f}</div>
              ))}
            </div>
          )}
          {planAlignmentFindings?.length > 0 && (
            <div>
              <div style={{ fontSize: 7, fontFamily: 'var(--fm)', color: '#fb923c', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>Alignment Findings</div>
              {planAlignmentFindings.map((f, i) => (
                <div key={i} style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', marginBottom: 2 }}>— {f}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Readiness banner ──────────────────────────────────────────────────────────

function ReadinessBanner({ readinessStatus }) {
  if (!readinessStatus) return null
  const { isReady, blockingPanels, blockingReasons } = readinessStatus
  if (isReady) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 11px', borderRadius: 4, background: 'rgba(0,229,180,.08)', border: '1px solid rgba(0,229,180,.3)', marginBottom: 8 }}>
        <Badge color="#00e5b4" small>stage 4 ready</Badge>
        <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#00e5b4' }}>All panels pass. This BU plan can feed Stage 4.</span>
      </div>
    )
  }
  return (
    <div style={{ padding: '7px 11px', borderRadius: 4, background: 'rgba(248,113,113,.06)', border: '1px solid rgba(248,113,113,.28)', marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: blockingReasons?.length ? 5 : 0 }}>
        <Badge color="#f87171" small>needs refinement</Badge>
        <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#f87171' }}>
          Stage 4 blocked: {blockingPanels?.length} panel{blockingPanels?.length === 1 ? '' : 's'} need attention.
        </span>
      </div>
      {blockingReasons?.length > 0 && (
        <div>
          {blockingReasons.slice(0, 4).map((r, i) => (
            <div key={i} style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', marginBottom: 2 }}>— {r}</div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main exported component ───────────────────────────────────────────────────

/**
 * Stage3PanelView
 *
 * Props:
 *   panelModel          — { panels, crossPanelAudit, readinessStatus }
 *   runningRefinementId — panelId currently being refined (or null)
 *   onRefinePanel       — ({ panelId, prompt, impactSummary }) => void
 *   hasApiKey           — boolean — whether to show refinement controls
 */
export function Stage3PanelView({ panelModel, runningRefinementId = null, onRefinePanel, onGeneratePanel, onAcceptPanel, onRejectPanel, hasApiKey = false }) {
  if (!panelModel?.panels) {
    return (
      <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', fontStyle: 'italic', padding: '8px 0' }}>
        No panel model available — generate or rebuild the plan to see panel audits.
      </div>
    )
  }

  const { panels, crossPanelAudit, readinessStatus } = panelModel

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <ReadinessBanner readinessStatus={readinessStatus} />
      <CrossPanelAuditSummary crossPanelAudit={crossPanelAudit} />
      {PANEL_IDS.map(panelId => (
        <PanelCard
          key={panelId}
          panelId={panelId}
          panel={panels[panelId]}
          crossPanelAudit={crossPanelAudit}
          runningRefinementId={runningRefinementId}
          onRefine={onRefinePanel}
          onGenerate={onGeneratePanel}
          onAccept={onAcceptPanel}
          onReject={onRejectPanel}
          hasApiKey={hasApiKey}
        />
      ))}
    </div>
  )
}

export default Stage3PanelView
