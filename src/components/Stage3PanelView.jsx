/**
 * Stage3PanelView — expandable, audited, refinable panel UI for Stage 3 compiled plans.
 *
 * Default collapsed view shows: panel title · audit status badge · short summary · last refined.
 * Expanded view shows: full content · completeness audit · cross-panel findings · refinement form · history.
 *
 * Relies on stage3PanelModel.js for all audit logic (no duplication here).
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import {
  PANEL_IDS, PANEL_LABELS, PANEL_ACCENTS, PANEL_AUDIT_STATUSES,
  CROSS_PANEL_QUALITY_STATUSES, REFINEMENT_STATUSES,
  resolvePanelDisplayStatus,
  synthesizePanelSummary,
} from '../utils/stage3PanelModel'
import {
  PANEL_LIFECYCLE,
  LIFECYCLE_DISPLAY,
  STRENGTH_DISPLAY,
  canAccept,
  canGenerate,
  canRefine,
  countPanelIssues,
} from '../utils/stage3PanelLifecycle'
import { ATOMIC_GENERATION_PANELS } from '../utils/stage3ChildUnitGeneration'
import { STRENGTH_STATUSES, strengthAuditBlocks } from '../utils/stage3PanelStrengthAudit'
import {
  STAGE4_DELIVERABLES,
  MAPPING_STATUS,
  phaseSlug,
  optionSlug,
  computeMappingStatus,
  getDeliverableMappingSummary,
  getSelectedStage4Deliverables,
} from '../utils/stage3PanelModel'

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

/** Compact badge showing the document-strength status of a panel. */
function PanelStrengthBadge({ strengthAudit }) {
  if (!strengthAudit) return null
  const display = STRENGTH_DISPLAY?.[strengthAudit.status]
  if (!display) return null
  // Don't show a badge for STRONG — it's the default/expected state
  if (strengthAudit.status === STRENGTH_STATUSES.STRONG) return null
  return (
    <Badge color={display.color} small>
      {display.label}
    </Badge>
  )
}

/** Expandable detail panel for strength audit findings. */
function PanelStrengthDetail({ strengthAudit }) {
  if (!strengthAudit || strengthAudit.status === STRENGTH_STATUSES.STRONG) return null
  const display = STRENGTH_DISPLAY?.[strengthAudit.status]
  if (!display) return null

  const categories = [
    { key: 'parentAlignmentFindings',   label: 'Parent-Section Alignment' },
    { key: 'specificityFindings',       label: 'Specificity & Concreteness' },
    { key: 'downstreamUsefulnessFindings', label: 'Downstream Usefulness for Stage 4' },
    { key: 'mechanicalTextFindings',    label: 'Mechanical / Generic Language' },
  ]

  return (
    <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 4, background: `${display.color}0d`, border: `1px solid ${display.color}33` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 8, fontFamily: 'var(--fm)', fontWeight: 700, color: display.color, textTransform: 'uppercase', letterSpacing: '.04em' }}>
          Document Strength — {display.label}
        </span>
        <span style={{ fontSize: 7, fontFamily: 'var(--fm)', color: 'var(--muted2)' }}>
          score {strengthAudit.score ?? '—'}/100
        </span>
      </div>

      {categories.map(({ key, label }) => {
        const items = strengthAudit[key] || []
        if (!items.length) return null
        return (
          <div key={key} style={{ marginBottom: 5 }}>
            <div style={{ fontSize: 7, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2 }}>
              {label}
            </div>
            {items.map((finding, i) => (
              <div key={i} style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted2)', lineHeight: 1.6, marginBottom: 2, paddingLeft: 8, borderLeft: `2px solid ${display.color}44` }}>
                {finding}
              </div>
            ))}
          </div>
        )
      })}

      {strengthAudit.recommendedAction && (
        <div style={{ marginTop: 4, fontSize: 8, fontFamily: 'var(--fm)', color: display.color, fontStyle: 'italic' }}>
          → {strengthAudit.recommendedAction}
        </div>
      )}
    </div>
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

function ExecutionPhaseItem({ p, phaseMapping, activeDeliverable, onUpdateHowOptionMapping, disabled }) {
  const phaseId = phaseSlug(p?.phaseName)
  const howOptionMappings = phaseMapping?.howOptionMappings || {}

  function updateOption(opt, checked) {
    if (!activeDeliverable?.id || !onUpdateHowOptionMapping) return
    const optionId = optionSlug(opt?.optionName)
    const current = howOptionMappings?.[optionId]?.mappedDeliverables || []
    const next = checked
      ? Array.from(new Set([...current, activeDeliverable.id]))
      : current.filter(deliverableId => deliverableId !== activeDeliverable.id)
    onUpdateHowOptionMapping({ phaseId, optionId, mappedDeliverables: next })
  }

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
              {(() => {
                const optionMapping = howOptionMappings?.[optionSlug(opt?.optionName)]
                const mappedDeliverables = optionMapping?.mappedDeliverables || []
                const checked = Boolean(activeDeliverable?.id && mappedDeliverables.includes(activeDeliverable.id))
                const mappedElsewhere = !checked && mappedDeliverables.length > 0
                const statusLabel = checked ? 'selected' : mappedElsewhere ? 'mapped elsewhere' : 'unselected'
                const statusColor = checked ? '#00e5b4' : mappedElsewhere ? '#3b82f6' : 'var(--muted)'
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled || !activeDeliverable?.id}
                      onChange={event => updateOption(opt, event.target.checked)}
                      style={{ width: 12, height: 12, accentColor: '#00e5b4', cursor: disabled || !activeDeliverable?.id ? 'not-allowed' : 'pointer', flexShrink: 0 }}
                    />
                    <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text)', flex: 1 }}>{opt.optionName}</div>
                    <span style={{ fontSize: 7, fontFamily: 'var(--fm)', color: statusColor, textTransform: 'uppercase', letterSpacing: '.04em', flexShrink: 0 }}>{statusLabel}</span>
                  </div>
                )
              })()}
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

function PanelContent({ panelId, content, panel, activeDeliverable, onUpdateHowOptionMapping, disabled }) {
  if (!content) return <div style={{ fontSize: 9, color: 'var(--muted)', fontStyle: 'italic', padding: '8px 0' }}>No content available for this panel.</div>

  switch (panelId) {
    case 'strategicObjective':
      return <StrategicObjectiveContent content={content} />
    case 'criticalDecisions':
      return <div>{Array.isArray(content) ? content.map((d, i) => <CriticalDecisionItem key={i} d={d} />) : null}</div>
    case 'executionSequence':
      return (
        <div>
          {Array.isArray(content) ? content.map((p, i) => (
            <ExecutionPhaseItem
              key={i}
              p={p}
              phaseMapping={panel?.executionDeliverableMappings?.[phaseSlug(p?.phaseName)]}
              activeDeliverable={activeDeliverable}
              onUpdateHowOptionMapping={onUpdateHowOptionMapping}
              disabled={disabled}
            />
          )) : null}
        </div>
      )
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

// ── Execution Sequence — deliverable mapping UI ───────────────────────────────

/** Status chip for a mapping record. */
function MappingStatusChip({ status }) {
  const cfg = {
    [MAPPING_STATUS.USER_CONFIRMED]: { label: 'confirmed', color: '#00e5b4' },
    [MAPPING_STATUS.PARTIAL]:        { label: 'partial',   color: '#fb923c' },
    [MAPPING_STATUS.SUGGESTED]:      { label: 'suggested', color: '#f59e0b' },
    [MAPPING_STATUS.UNMAPPED]:       { label: 'unmapped',  color: '#f87171' },
  }[status] || { label: status, color: '#6b7280' }
  return (
    <span style={{ fontSize: 6, fontFamily: 'var(--fm)', fontWeight: 700, color: cfg.color, border: `1px solid ${cfg.color}55`, padding: '0 4px', borderRadius: 2, textTransform: 'uppercase', letterSpacing: '.04em' }}>
      {cfg.label}
    </span>
  )
}

/** Checkbox list of Stage 4 deliverables — shared by both per-how-option and legacy phase rows. */
/**
 * Row for a single how-option with its own deliverable checkbox list.
 * The primary mapping control — one how-option can map to multiple deliverables.
 */
function HowOptionMappingRow({ phaseId, opt, optMapping, activeDeliverableId, onUpdateHowOption, disabled }) {
  const optName  = opt?.optionName || 'Option'
  const optId    = optionSlug(optName)
  const selected = optMapping?.mappedDeliverables || []
  const status   = optMapping?.mappingStatus || MAPPING_STATUS.UNMAPPED
  const checked  = selected.includes(activeDeliverableId)
  const desc     = ''
  function toggle() {
    if (!activeDeliverableId) return
    const next = checked ? selected.filter(d => d !== activeDeliverableId) : [...selected, activeDeliverableId]
    onUpdateHowOption(phaseId, optId, next)
  }

  return (
    <div style={{ marginBottom: 7, paddingBottom: 7, paddingLeft: 10, borderLeft: '2px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled || !activeDeliverableId}
          onChange={toggle}
          style={{ width: 12, height: 12, accentColor: '#00e5b4', cursor: disabled ? 'not-allowed' : 'pointer', flexShrink: 0 }}
        />
        <span style={{ fontSize: 7.5, fontFamily: 'var(--fm)', fontWeight: 600, color: 'var(--fg)', flex: 1 }}>
          {optName}
        </span>
        <MappingStatusChip status={status} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginLeft: 17 }}>
        {opt?.whenToUse && <LabeledText label="use when" value={opt.whenToUse} />}
        {opt?.whyItFitsThePhaseOutcome && <LabeledText label="why it fits" value={opt.whyItFitsThePhaseOutcome} />}
        {opt?.evidenceProduced && <LabeledText label="evidence" value={opt.evidenceProduced} />}
      </div>
      {desc && (
        <div style={{ fontSize: 7, fontFamily: 'var(--fm)', color: 'var(--muted)', marginBottom: 4, lineHeight: 1.4 }}>
          {String(desc).slice(0, 120)}{String(desc).length > 120 ? '…' : ''}
        </div>
      )}
    </div>
  )
}

/**
 * Phase container for the deliverable mapping section.
 * - Phases WITH howOptions: shows how-option rows as the primary mapping control.
 *   Phase header shows derived mapping summary (union of selected how-option deliverables).
 * - Phases WITHOUT howOptions: legacy fallback — shows phase-level checkboxes.
 */
function PhaseDeliverableRow({ phase, mapping, activeDeliverableId, activeDeliverableLabel, onUpdate, onUpdateHowOption, disabled }) {
  const phaseName  = phase?.phaseName || 'Phase'
  const phaseId    = phaseSlug(phaseName)
  const howOptions = Array.isArray(phase?.howOptions) ? phase.howOptions : []
  const status     = mapping?.mappingStatus || MAPPING_STATUS.UNMAPPED

  if (howOptions.length > 0) {
    // New model: how-option level mapping
    const howOptMaps  = mapping?.howOptionMappings || {}
    const mappedCount = howOptions.filter(opt => (howOptMaps[optionSlug(opt?.optionName)]?.mappedDeliverables || []).includes(activeDeliverableId)).length

    return (
      <div style={{ marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
          <span style={{ fontSize: 8, fontFamily: 'var(--fm)', fontWeight: 700, color: 'var(--fg)', flex: 1 }}>
            {phaseName}
          </span>
          <MappingStatusChip status={status} />
          <span style={{ fontSize: 7, fontFamily: 'var(--fm)', color: 'var(--muted2)', flexShrink: 0 }}>
            {mappedCount}/{howOptions.length} selected for {activeDeliverableLabel}
          </span>
        </div>
        {howOptions.map((opt, i) => (
          <HowOptionMappingRow
            key={optionSlug(opt?.optionName) || i}
            phaseId={phaseId}
            opt={opt}
            optMapping={howOptMaps[optionSlug(opt?.optionName)]}
            activeDeliverableId={activeDeliverableId}
            onUpdateHowOption={onUpdateHowOption}
            disabled={disabled}
          />
        ))}
      </div>
    )
  }

  // Legacy / no how-options: phase-level checkboxes
  const selected = mapping?.phaseMappedDeliverables || mapping?.mappedDeliverables || []
  const checked = selected.includes(activeDeliverableId)
  function toggle() {
    const next = checked ? selected.filter(d => d !== activeDeliverableId) : [...selected, activeDeliverableId]
    onUpdate(phaseId, next)
  }
  return (
    <div style={{ marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
        <input type="checkbox" checked={checked} disabled={disabled} onChange={toggle} style={{ width: 12, height: 12, accentColor: '#00e5b4', cursor: disabled ? 'not-allowed' : 'pointer', flexShrink: 0 }} />
        <span style={{ fontSize: 8, fontFamily: 'var(--fm)', fontWeight: 700, color: 'var(--fg)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {phaseName}
        </span>
        <MappingStatusChip status={status} />
      </div>
    </div>
  )
}

void PhaseDeliverableRow

/**
 * Full deliverable mapping section for the Execution Sequence panel.
 * Shows phases as containers; each phase shows its how-options (or falls back to phase-level).
 */
function ExecutionMappingSection({ panel, activeDeliverableId, onActiveDeliverableChange, onUpdateSelectedDeliverables, disabled, focusArtifactId = null }) {
  const content  = panel?.content
  const selectedRecords = getSelectedStage4Deliverables(panel)
  const selectedIds = selectedRecords.map(record => record.deliverableType)
  const focusedRowRef = useRef(null)

  useEffect(() => {
    if (!focusArtifactId) return
    if (selectedIds.includes(focusArtifactId) && activeDeliverableId !== focusArtifactId) {
      onActiveDeliverableChange?.(focusArtifactId)
    }
    const el = focusedRowRef.current
    if (el) {
      requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }))
    }
  }, [focusArtifactId, selectedIds, activeDeliverableId, onActiveDeliverableChange])

  if (!Array.isArray(content) || content.length === 0) return null

  const activeId = selectedIds.includes(activeDeliverableId) ? activeDeliverableId : selectedIds[0]
  const activeDeliverable = STAGE4_DELIVERABLES.find(d => d.id === activeId) || null
  const summary = activeDeliverable
    ? getDeliverableMappingSummary(panel, activeDeliverable.id)
    : { selectedHowOptionCount: 0, selectedPhaseCount: 0 }
  const selectedSummaries = selectedRecords.map(record => {
    const deliverable = STAGE4_DELIVERABLES.find(d => d.id === record.deliverableType)
    const deliverableSummary = getDeliverableMappingSummary(panel, record.deliverableType)
    return {
      ...record,
      label: deliverable?.label || record.deliverableType,
      count: deliverableSummary.selectedHowOptionCount,
      phaseCount: deliverableSummary.selectedPhaseCount,
    }
  })

  function toggleSelectedDeliverable(deliverableId) {
    const next = selectedIds.includes(deliverableId)
      ? selectedIds.filter(id => id !== deliverableId)
      : [...selectedIds, deliverableId]
    if (!next.includes(activeDeliverableId)) onActiveDeliverableChange?.(next[0] || '')
    onUpdateSelectedDeliverables?.({ deliverableTypes: next })
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 7, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
        Stage 4 deliverables to prepare
      </div>
      <div style={{ display: 'none', fontSize: 7, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
        Deliverable Mapping — map how options to Stage 4 artifacts
      </div>
      <div style={{ display: 'grid', gap: 5, marginBottom: 8 }}>
        {STAGE4_DELIVERABLES.map(deliverable => {
          const selected = selectedIds.includes(deliverable.id)
          const isFocused = deliverable.id === focusArtifactId
          const deliverableSummary = getDeliverableMappingSummary(panel, deliverable.id)
          return (
            <label
              key={deliverable.id}
              ref={isFocused ? focusedRowRef : null}
              data-artifact-id={deliverable.id}
              data-anchor-id={`stage3-artifact-mapping-${deliverable.id}`}
              style={{
                display: 'grid', gridTemplateColumns: '14px minmax(0, 1fr) auto', gap: 6,
                alignItems: 'start', padding: '5px 6px', borderRadius: 4,
                border: `1px solid ${isFocused ? 'rgba(249,115,22,.6)' : selected ? 'rgba(0,229,180,.35)' : 'var(--border)'}`,
                background: isFocused ? 'rgba(249,115,22,.07)' : selected ? 'rgba(0,229,180,.05)' : 'transparent',
                boxShadow: isFocused ? '0 0 0 2px rgba(249,115,22,.18)' : 'none',
                cursor: disabled ? 'not-allowed' : 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={selected}
                disabled={disabled}
                onChange={() => toggleSelectedDeliverable(deliverable.id)}
                style={{ width: 12, height: 12, marginTop: 1, accentColor: '#00e5b4', cursor: disabled ? 'not-allowed' : 'pointer' }}
              />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 8, fontFamily: 'var(--fm)', fontWeight: 700, color: selected ? '#00e5b4' : 'var(--fg)' }}>{deliverable.label}</span>
                <span style={{ display: 'block', fontSize: 7, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.35 }}>{deliverable.intent}</span>
              </span>
              {selected && (
                <span style={{ fontSize: 7, fontFamily: 'var(--fm)', color: deliverableSummary.selectedHowOptionCount > 0 ? '#00e5b4' : '#f97316', whiteSpace: 'nowrap' }}>
                  {deliverableSummary.selectedHowOptionCount > 0 ? `${deliverableSummary.selectedHowOptionCount} mapped` : 'incomplete'}
                </span>
              )}
            </label>
          )
        })}
      </div>
      {selectedSummaries.length > 0 && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 8 }}>
          {selectedSummaries.map(item => (
            <span key={item.deliverableType} style={{ fontSize: 7, fontFamily: 'var(--fm)', color: item.count > 0 ? '#00e5b4' : '#f97316', border: '1px solid var(--border)', borderRadius: 3, padding: '2px 5px' }}>
              {item.label}: {item.count > 0 ? `${item.count} how option${item.count === 1 ? '' : 's'}` : 'incomplete'}
            </span>
          ))}
        </div>
      )}
      {!activeDeliverable && (
        <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', padding: '6px 0' }}>
          Content ready; no Stage 4 deliverables selected.
        </div>
      )}
      {activeDeliverable && (
        <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ fontSize: 7, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
            Selected deliverable
          </span>
          <select
            value={activeDeliverable.id}
            disabled={disabled}
            onChange={e => onActiveDeliverableChange?.(e.target.value)}
            style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--fg)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '3px 6px' }}
          >
            {selectedRecords.map(record => {
              const deliverable = STAGE4_DELIVERABLES.find(d => d.id === record.deliverableType)
              return <option key={record.deliverableType} value={record.deliverableType}>{deliverable?.label || record.deliverableType}</option>
            })}
          </select>
        </label>
      </div>
      <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#00e5b4', marginBottom: 8 }}>
        {activeDeliverable.label}: {summary.selectedHowOptionCount} how option{summary.selectedHowOptionCount === 1 ? '' : 's'} selected across {summary.selectedPhaseCount} phase{summary.selectedPhaseCount === 1 ? '' : 's'}.
      </div>
        </>
      )}
    </div>
  )
}

// ── Child unit progress tracker ───────────────────────────────────────────────

/**
 * Shows per-item generation status for atomic panels (risks, criticalDecisions, etc.).
 * Rendered when: generation is running OR there are failed units needing retry.
 */
function ChildUnitProgressTracker({ panelId, childUnits = [], isRunning, onGenerate }) {
  if (!childUnits.length) return null

  const hasFailed = childUnits.some(u => u.status === 'failed')
  if (!isRunning && !hasFailed) return null

  const doneCount = childUnits.filter(u => ['draft_ready', 'needs_refinement', 'accepted'].includes(u.status)).length
  const total     = childUnits.length

  return (
    <div style={{ marginTop: 8, padding: '7px 9px', borderRadius: 4, background: 'rgba(59,130,246,.06)', border: '1px solid rgba(59,130,246,.2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: hasFailed ? 5 : 0 }}>
        <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#3b82f6', fontWeight: 600 }}>
          {isRunning ? `generating items… ${doneCount}/${total} done` : `${hasFailed ? childUnits.filter(u => u.status === 'failed').length + ' item(s) failed' : ''}`}
        </span>
        <div style={{ display: 'flex', gap: 3 }}>
          {childUnits.map(u => {
            const color = u.status === 'draft_ready' || u.status === 'accepted' ? '#00e5b4'
              : u.status === 'needs_refinement' ? '#f59e0b'
              : u.status === 'failed'           ? '#f87171'
              : u.status === 'generating'       ? '#3b82f6'
              : '#6b7280'
            const pulse = u.status === 'generating'
            return (
              <span
                key={u.index}
                title={`Item ${u.index + 1}: ${u.status}${u.error ? ` — ${u.error}` : ''}`}
                style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: color,
                  opacity: pulse ? undefined : 1,
                  animation: pulse ? 'pulse 1.2s ease-in-out infinite' : 'none',
                  flexShrink: 0,
                }}
              />
            )
          })}
        </div>
      </div>

      {hasFailed && !isRunning && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {childUnits.filter(u => u.status === 'failed').map(u => (
            <button
              key={u.index}
              onClick={() => onGenerate?.({ panelId, retryIndex: u.index })}
              title={u.error || undefined}
              style={{ fontSize: 7, fontFamily: 'var(--fm)', padding: '2px 7px', borderRadius: 3, border: '1px solid #f8717188', background: 'transparent', color: '#f87171', cursor: 'pointer' }}
            >
              retry item {u.index + 1}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Panel card ────────────────────────────────────────────────────────────────

function PanelCard({ panelId, panel, crossPanelAudit, runningRefinementId, onRefine, onGenerate, onAccept, onReject, hasApiKey, onUpdateHowOptionMapping, onUpdateSelectedDeliverables, isFocused = false, focusArtifactId = null }) {
  const [expanded,        setExpanded]        = useState(false)
  const [showAudit,       setShowAudit]       = useState(false)
  const [showStrength,    setShowStrength]    = useState(false)
  const [showRefinement,  setShowRefinement]  = useState(false)
  const [showHistory,     setShowHistory]     = useState(false)
  const cardRef = useRef(null)

  useEffect(() => {
    if (!isFocused) return
    setExpanded(true)
    requestAnimationFrame(() => {
      cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [isFocused])

  const label   = PANEL_LABELS[panelId]
  const accent  = PANEL_ACCENTS[panelId] || '#00e5b4'
  const audit   = panel?.completenessAudit
  const content = panel?.content
  const history = panel?.refinementHistory || []
  const childUnits = panel?.childUnits || []
  const strengthAudit = panel?.panelStrengthAudit || null
  const isAtomic   = ATOMIC_GENERATION_PANELS.has(panelId)
  const isRunning  = runningRefinementId === panelId
  const isAtomicGenerating = isRunning && isAtomic && panel?.lifecycle === 'generating_units'
  const lifecycle = isRunning ? PANEL_LIFECYCLE.GENERATING : (panel?.lifecycle || PANEL_LIFECYCLE.NOT_STARTED)
  const displayedAuditStatus = resolvePanelDisplayStatus({ ...panel, lifecycle })
  const issueCount = countPanelIssues(panel, crossPanelAudit)
  const actionDisabled = lifecycle === PANEL_LIFECYCLE.GENERATING
  const hasFailedChildUnits = isAtomic && childUnits.some(u => u.status === 'failed')
  const strengthBlocks = strengthAuditBlocks(strengthAudit)

  // Execution Sequence mapping summary
  const isExecSeq     = panelId === 'executionSequence'
  const mappingSummary = isExecSeq ? computeMappingStatus(panel) : null
  const selectedDeliverableRecords = isExecSeq ? getSelectedStage4Deliverables(panel) : []
  const selectedDeliverableIds = selectedDeliverableRecords.map(record => record.deliverableType)
  const defaultActiveDeliverableId = selectedDeliverableIds.includes('bu_execution_plan') ? 'bu_execution_plan' : (selectedDeliverableIds[0] || '')
  const [activeDeliverableId, setActiveDeliverableId] = useState(defaultActiveDeliverableId)
  const resolvedActiveDeliverableId = selectedDeliverableIds.includes(activeDeliverableId) ? activeDeliverableId : selectedDeliverableIds[0]
  const activeDeliverable = STAGE4_DELIVERABLES.find(deliverable => deliverable.id === resolvedActiveDeliverableId) || null

  const summary     = synthesizePanelSummary(panelId, content)
  const lastTouched = panel?.lastRefinedAt || panel?.lastGeneratedAt
  const lastTouchedLabel = lastTouched ? new Date(lastTouched).toLocaleDateString() : null

  const handleSubmitRefinement = useCallback(({ prompt, impactSummary }) => {
    if (onRefine) onRefine({ panelId, prompt, impactSummary })
    setShowRefinement(false)
  }, [panelId, onRefine])

  return (
    <div
      ref={cardRef}
      data-panel-id={panelId}
      data-anchor-id={`stage3-panel-${panelId}`}
      style={{
        border: `1px solid ${isFocused ? 'rgba(249,115,22,.6)' : `${accent}33`}`,
        borderRadius: 5,
        overflow: 'hidden',
        background: 'var(--surface)',
        marginBottom: 6,
        boxShadow: isFocused ? '0 0 0 2px rgba(249,115,22,.14)' : 'none',
      }}
    >
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
            {isRunning && <Badge color="#3b82f6" small>{isAtomicGenerating ? 'generating…' : 'refining…'}</Badge>}
            {!isRunning && hasFailedChildUnits && <Badge color="#f87171" small>items failed</Badge>}
            {!isRunning && <PanelStrengthBadge strengthAudit={strengthAudit} />}
            {issueCount > 0 && <Badge color="#f87171" small>{issueCount} issue{issueCount === 1 ? '' : 's'}</Badge>}
          </div>
          <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</div>
          {/* Execution Sequence mapping summary */}
          {isExecSeq && mappingSummary && mappingSummary.total > 0 && (
            <div style={{ fontSize: 7, fontFamily: 'var(--fm)', marginTop: 2 }}>
              <span style={{ color: 'var(--muted2)' }}>{mappingSummary.total} phase{mappingSummary.total === 1 ? '' : 's'}</span>
              {' · '}
              <span style={{ color: mappingSummary.mapped > 0 ? '#00e5b4' : 'var(--muted2)' }}>{mappingSummary.mapped} mapped</span>
              {' · '}
              <span style={{ color: mappingSummary.unmapped > 0 ? '#f97316' : 'var(--muted2)' }}>{mappingSummary.unmapped} unmapped</span>
            </div>
          )}
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
          {isExecSeq && content && (
            <ExecutionMappingSection
              panel={panel}
              activeDeliverableId={resolvedActiveDeliverableId}
              onActiveDeliverableChange={setActiveDeliverableId}
              onUpdateSelectedDeliverables={onUpdateSelectedDeliverables}
              disabled={actionDisabled}
              focusArtifactId={focusArtifactId}
            />
          )}

          <PanelContent
            panelId={panelId}
            content={content}
            panel={panel}
            activeDeliverable={activeDeliverable}
            onUpdateHowOptionMapping={onUpdateHowOptionMapping}
            disabled={actionDisabled}
          />

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

            {strengthAudit && content && (
              <button
                onClick={() => setShowStrength(s => !s)}
                style={{ fontSize: 7, fontFamily: 'var(--fm)', padding: '3px 8px', borderRadius: 3, border: `1px solid ${strengthBlocks ? '#f9731688' : '#a3e63588'}`, background: 'transparent', color: strengthBlocks ? '#f97316' : '#a3e635', cursor: 'pointer' }}
              >
                {showStrength ? '▲ hide strength' : `▼ strength · ${strengthAudit.status || 'pending'}`}
              </button>
            )}

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

          {/* Document-strength audit detail — auto-shown when blocking, or toggled via button */}
          {content && (strengthBlocks || showStrength) && (
            <PanelStrengthDetail strengthAudit={strengthAudit} />
          )}

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

          {isRunning && !isAtomicGenerating && (
            <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: '#3b82f6', padding: '8px 0', fontStyle: 'italic' }}>
              Refining {label}…
            </div>
          )}

          {(isAtomicGenerating || hasFailedChildUnits) && (
            <ChildUnitProgressTracker
              panelId={panelId}
              childUnits={childUnits}
              isRunning={isRunning}
              onGenerate={onGenerate}
            />
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
  const { isReady, blockingPanels, blockingReasons, mappingReady, mappingWarnings } = readinessStatus

  if (isReady && mappingReady !== false) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 11px', borderRadius: 4, background: 'rgba(0,229,180,.08)', border: '1px solid rgba(0,229,180,.3)', marginBottom: 8 }}>
        <Badge color="#00e5b4" small>stage 4 ready</Badge>
        <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#00e5b4' }}>All panels pass. This BU plan can feed Stage 4.</span>
      </div>
    )
  }

  // Content ready but mapping incomplete
  if (isReady && mappingReady === false) {
    return (
      <div style={{ padding: '7px 11px', borderRadius: 4, background: 'rgba(249,115,22,.06)', border: '1px solid rgba(249,115,22,.3)', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: mappingWarnings?.length ? 4 : 0 }}>
          <Badge color="#f97316" small>mapping incomplete</Badge>
          <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#f97316' }}>
            Content ready; deliverable mapping incomplete.
          </span>
        </div>
        {mappingWarnings?.map((w, i) => (
          <div key={i} style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', marginBottom: 2 }}>— {w}</div>
        ))}
      </div>
    )
  }

  return (
    <div style={{ padding: '7px 11px', borderRadius: 4, background: 'rgba(248,113,113,.06)', border: '1px solid rgba(248,113,113,.28)', marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: blockingReasons?.length || mappingWarnings?.length ? 5 : 0 }}>
        <Badge color="#f87171" small>needs refinement</Badge>
        <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#f87171' }}>
          Stage 4 blocked: {blockingPanels?.length} panel{blockingPanels?.length === 1 ? '' : 's'} need attention.
        </span>
      </div>
      {blockingReasons?.length > 0 && (
        <div style={{ marginBottom: mappingWarnings?.length ? 4 : 0 }}>
          {blockingReasons.slice(0, 4).map((r, i) => (
            <div key={i} style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', marginBottom: 2 }}>— {r}</div>
          ))}
        </div>
      )}
      {mappingWarnings?.length > 0 && (
        <div>
          {mappingWarnings.map((w, i) => (
            <div key={i} style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#f97316', marginBottom: 2 }}>— {w}</div>
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
export function Stage3PanelView({ panelModel, runningRefinementId = null, onRefinePanel, onGeneratePanel, onAcceptPanel, onRejectPanel, onUpdateHowOptionMapping, onUpdateSelectedStage4Deliverables, hasApiKey = false, focusPanelId = null, focusArtifactId = null }) {
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
          onUpdateHowOptionMapping={onUpdateHowOptionMapping}
          onUpdateSelectedDeliverables={onUpdateSelectedStage4Deliverables}
          hasApiKey={hasApiKey}
          isFocused={panelId === focusPanelId}
          focusArtifactId={panelId === 'executionSequence' ? focusArtifactId : null}
        />
      ))}
    </div>
  )
}

export default Stage3PanelView
