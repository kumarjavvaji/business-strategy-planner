import {
  UNIT_LIFECYCLE_STATES,
  computeUnitsReadiness,
  deriveUnitLifecycleFromAudit,
  transitionUnitToAccepted,
  transitionUnitToDraftReady,
  transitionUnitToFailed,
  transitionUnitToGenerating,
  transitionUnitToNeedsRefinement,
} from './unitLifecycle'
import { strengthAuditBlocks, STRENGTH_STATUSES } from './stage3PanelStrengthAudit'

const PANEL_AUDIT_STATUSES = {
  COMPLETE:          'complete',
  INCOMPLETE:        'incomplete',
  TRUNCATED:         'truncated',
  REDUNDANT:         'redundant',
  MISALIGNED:        'misaligned',
  NEEDS_REFINEMENT:  'needs_refinement',
}

const CROSS_PANEL_QUALITY_STATUSES = {
  PASS:         'pass',
  FAIL:         'fail',
  NEEDS_REVIEW: 'needs_review',
}

const PANEL_IDS = [
  'strategicObjective',
  'criticalDecisions',
  'executionSequence',
  'dependencies',
  'risks',
  'validationFramework',
]

const PANEL_LABELS = {
  strategicObjective:  'Strategic Objective',
  criticalDecisions:   'Critical Decisions',
  executionSequence:   'Execution Sequence',
  dependencies:        'Dependencies',
  risks:               'Risk & Mitigation',
  validationFramework: 'Validation Framework',
}

export const PANEL_LIFECYCLE = UNIT_LIFECYCLE_STATES

const CONTENT_STATES = new Set([
  PANEL_LIFECYCLE.DRAFT_READY,
  PANEL_LIFECYCLE.NEEDS_REFINEMENT,
  PANEL_LIFECYCLE.ACCEPTED,
])

const ACTIONABLE_STATES = new Set([
  PANEL_LIFECYCLE.NOT_STARTED,
  PANEL_LIFECYCLE.DRAFT_READY,
  PANEL_LIFECYCLE.NEEDS_REFINEMENT,
  PANEL_LIFECYCLE.FAILED,
])

export function panelHasContent(panel) {
  return CONTENT_STATES.has(panel?.lifecycle)
}

export function canGenerate(panel) {
  const lifecycle = panel?.lifecycle || PANEL_LIFECYCLE.NOT_STARTED
  return ACTIONABLE_STATES.has(lifecycle) && lifecycle !== PANEL_LIFECYCLE.GENERATING
}

export function canRefine(panel) {
  return CONTENT_STATES.has(panel?.lifecycle)
}

export function canAccept(panel) {
  const lifecycle = panel?.lifecycle || PANEL_LIFECYCLE.NOT_STARTED
  // Allow acceptance from draft_ready OR needs_refinement (user's informed choice to accept despite warnings).
  // Hard-block only on truncated / incomplete audit — content is too damaged to accept.
  if (lifecycle !== PANEL_LIFECYCLE.DRAFT_READY && lifecycle !== PANEL_LIFECYCLE.NEEDS_REFINEMENT) return false
  const auditStatus = panel?.completenessAudit?.status
  return auditStatus !== PANEL_AUDIT_STATUSES.TRUNCATED && auditStatus !== PANEL_AUDIT_STATUSES.INCOMPLETE
}

export function canReject(panel) {
  const lifecycle = panel?.lifecycle
  return lifecycle === PANEL_LIFECYCLE.DRAFT_READY ||
    lifecycle === PANEL_LIFECYCLE.NEEDS_REFINEMENT ||
    lifecycle === PANEL_LIFECYCLE.ACCEPTED
}

export function derivePanelLifecycle(content, audit) {
  const hasContent = Array.isArray(content)
    ? content.length > 0
    : content != null
  return deriveUnitLifecycleFromAudit({ hasContent, audit })
}

export function transitionToGenerating(panel) {
  return transitionUnitToGenerating(panel)
}

export function transitionToDraftReady(panel, newContent, newAudit) {
  return transitionUnitToDraftReady(panel, {
    contentPatch: {
      content: newContent,
      completenessAudit: newAudit,
    },
    audit: newAudit,
  })
}

export function transitionToFailed(panel, errorMessage) {
  return transitionUnitToFailed(panel, errorMessage)
}

export function transitionToAccepted(panel) {
  try {
    return transitionUnitToAccepted(panel, { audit: panel?.completenessAudit })
  } catch {
    throw new Error(
      `Cannot accept panel "${panel?.panelId || 'unknown'}": ` +
      `lifecycle=${panel?.lifecycle}, auditStatus=${panel?.completenessAudit?.status}`
    )
  }
}

export function transitionToNeedsRefinement(panel, reason) {
  return transitionUnitToNeedsRefinement(panel, reason)
}

export function countPanelIssues(panel, crossPanelAudit) {
  let count = 0
  const audit = panel?.completenessAudit
  if (audit) {
    count += (audit.missingFields?.length || 0)
    count += (audit.truncatedFields?.length || 0)
    count += (audit.duplicateFieldFindings?.length || 0)
    count += Math.ceil((audit.weakFields?.length || 0) / 2)
  }
  if (panel?.lifecycle === PANEL_LIFECYCLE.FAILED) count += 1
  if (panel?.lifecycle === PANEL_LIFECYCLE.NEEDS_REFINEMENT && !audit?.missingFields?.length && !audit?.truncatedFields?.length) {
    count += 1
  }

  // Strength audit issues — count top-level findings (capped at 3 to avoid overwhelming the counter)
  const strengthAudit = panel?.panelStrengthAudit
  if (strengthAuditBlocks(strengthAudit)) {
    count += Math.min(3, strengthAudit.findings?.length || 1)
  }

  const panelId = panel?.panelId
  if (crossPanelAudit && panelId) {
    count += (crossPanelAudit.repeatedPhrases || []).filter(r => r.panelA === panelId || r.panelB === panelId).length
    count += (crossPanelAudit.duplicatedFieldPairs || []).filter(p => String(p.source).includes(panelId) || String(p.target).includes(panelId)).length
  }
  return count
}

export function computeLifecycleReadiness(panels, crossPanelAudit) {
  const crossPanelBlockingReasons = []
  if (crossPanelAudit?.qualityStatus === CROSS_PANEL_QUALITY_STATUSES.FAIL) {
    crossPanelBlockingReasons.push(
      `Cross-panel audit failed: ` +
      `${crossPanelAudit.duplicatedFieldPairs?.length || 0} duplicated field pair(s), ` +
      `${crossPanelAudit.misplacedContentFindings?.length || 0} misplaced content finding(s)`
    )
  }

  const readiness = computeUnitsReadiness(PANEL_IDS.map(panelId => panels[panelId]), {
    getLabel: panel => PANEL_LABELS[panel?.panelId] || panel?.panelId || 'Panel',
    getAudit: panel => panel?.completenessAudit,
    extraBlockingReasons: crossPanelBlockingReasons,
  })

  // Collect panels that are blocked by strength audit.
  // Only accepted panels are strength-gated — lifecycle already blocks unaccepted panels.
  const strengthBlockingPanels = []
  const strengthBlockingReasons = []
  PANEL_IDS.forEach(panelId => {
    const panel = panels[panelId]
    const strengthAudit = panel?.panelStrengthAudit
    // Only gate accepted panels on strength — an unaccepted panel is already lifecycle-blocked.
    if (panel?.lifecycle !== PANEL_LIFECYCLE.ACCEPTED) return
    if (strengthAuditBlocks(strengthAudit)) {
      strengthBlockingPanels.push(panelId)
      const firstFinding = strengthAudit.findings?.[0] || strengthAudit.recommendedAction || 'needs strengthening'
      const label = PANEL_LABELS[panelId] || panelId
      if (panelId === 'executionSequence') {
        strengthBlockingReasons.push(
          `Stage 4 blocked: ${label} needs strengthening before BU Execution Plan generation. ` +
          firstFinding.slice(0, 120)
        )
      } else {
        strengthBlockingReasons.push(`${label}: NEEDS_STRENGTHENING — ${firstFinding.slice(0, 100)}`)
      }
    }
  })

  const blockingReasons = []
  const allBlockingPanels = [...new Set([...readiness.blockingUnits, ...strengthBlockingPanels])]
  if (strengthBlockingPanels.length > 0 && readiness.blockingUnits.length === 0) {
    blockingReasons.push('Panels accepted, strength audit failed.')
  }

  PANEL_IDS.forEach(panelId => {
    if (!allBlockingPanels.includes(panelId)) return

    const panel = panels[panelId]
    const lifecycle = panel?.lifecycle || PANEL_LIFECYCLE.NOT_STARTED
    const audit = panel?.completenessAudit

    // Structural/lifecycle blocks take precedence
    if (audit?.status === PANEL_AUDIT_STATUSES.TRUNCATED) {
      blockingReasons.push(`${PANEL_LABELS[panelId]}: TRUNCATED - ${(audit.truncatedFields || []).slice(0, 2).join(', ')}`)
      return
    }
    if (audit?.status === PANEL_AUDIT_STATUSES.INCOMPLETE) {
      blockingReasons.push(`${PANEL_LABELS[panelId]}: INCOMPLETE - ${(audit.missingFields || []).slice(0, 2).join(', ')}`)
      return
    }
    if (lifecycle === PANEL_LIFECYCLE.FAILED) {
      blockingReasons.push(`${PANEL_LABELS[panelId]}: generation failed - ${panel.lifecycleError || 'unknown error'}`)
      return
    }
    if (lifecycle !== PANEL_LIFECYCLE.ACCEPTED && readiness.blockingUnits.includes(panelId)) {
      blockingReasons.push(`${PANEL_LABELS[panelId]}: not yet accepted (status: ${lifecycle})`)
      return
    }
    // Strength block (structural passed, strength did not)
    if (strengthBlockingPanels.includes(panelId)) return  // already in strengthBlockingReasons
    blockingReasons.push(`${PANEL_LABELS[panelId]}: blocking audit issue (${audit?.status || 'missing audit'})`)
  })

  const isReady = allBlockingPanels.length === 0 && crossPanelAudit?.qualityStatus !== CROSS_PANEL_QUALITY_STATUSES.FAIL

  // ── Mapping readiness (separate from content readiness) ────────────────────
  // Only warn when executionSequence is accepted — unaccepted panels are not mapped yet.
  // For phases with howOptions, mapping is complete when at least one how-option has deliverables.
  // For phases without howOptions, falls back to the legacy phase-level check.
  const mappingWarnings = []
  const execPanel = panels?.executionSequence
  if (execPanel?.lifecycle === PANEL_LIFECYCLE.ACCEPTED) {
    const execContent  = execPanel.content
    const execMappings = execPanel.executionDeliverableMappings
    const selectedDeliverables = Array.isArray(execPanel.selectedStage4Deliverables) ? execPanel.selectedStage4Deliverables : []
    const selectedIds = selectedDeliverables.map(record => record?.deliverableType).filter(Boolean)
    const selectedCounts = Object.fromEntries(selectedIds.map(id => [id, 0]))
    if (Array.isArray(execContent) && execContent.length > 0) {
      let unmappedCount = 0
      execContent.forEach(phase => {
        const id       = String(phase?.phaseName || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'phase'
        const mapping  = execMappings?.[id]
        const howOpts  = Array.isArray(phase?.howOptions) ? phase.howOptions : []

        if (howOpts.length > 0) {
          // New model: phase is mapped if any how-option has at least one deliverable
          const howOptMaps = mapping?.howOptionMappings
          const hasMapped  = howOpts.some(opt => {
            const optId = String(opt?.optionName || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'option'
            const mappedDeliverables = howOptMaps?.[optId]?.mappedDeliverables || []
            mappedDeliverables.forEach(did => {
              if (did in selectedCounts) selectedCounts[did] += 1
            })
            return mappedDeliverables.length > 0
          })
          if (!hasMapped) unmappedCount++
        } else {
          // Legacy / no how-options: check phase-level deliverables
          const deliverables = mapping?.phaseMappedDeliverables || mapping?.mappedDeliverables
          ;(deliverables || []).forEach(did => {
            if (did in selectedCounts) selectedCounts[did] += 1
          })
          if (!deliverables?.length) unmappedCount++
        }
      })
      if (execPanel?.mappingWarningsEnabled && unmappedCount > 0) {
        mappingWarnings.push(
          `Stage 4 mapping incomplete: ${unmappedCount} execution phase${unmappedCount === 1 ? '' : 's'} not mapped to deliverables.`
        )
      }
      const incompleteSelected = Object.entries(selectedCounts).filter(([, count]) => count === 0)
      if (incompleteSelected.length > 0) {
        mappingWarnings.push(
          `Stage 4 mapping incomplete: ${incompleteSelected.length} selected deliverable${incompleteSelected.length === 1 ? '' : 's'} have no mapped how options.`
        )
      }
    }
  }

  return {
    isReady,
    blockingPanels: allBlockingPanels,
    blockingReasons: [...blockingReasons, ...strengthBlockingReasons, ...crossPanelBlockingReasons],
    crossPanelQuality: crossPanelAudit?.qualityStatus || null,
    // Deliverable mapping readiness — separate from content readiness
    mappingReady:    mappingWarnings.length === 0,
    mappingWarnings,
    lastCheckedAt: new Date().toISOString(),
  }
}

export const LIFECYCLE_DISPLAY = {
  [PANEL_LIFECYCLE.NOT_STARTED]:      { label: 'not started',         color: '#6b7280' },
  [PANEL_LIFECYCLE.GENERATING]:       { label: 'generating',          color: '#3b82f6' },
  [PANEL_LIFECYCLE.DRAFT_READY]:      { label: 'draft ready',         color: '#fb923c' },
  [PANEL_LIFECYCLE.NEEDS_REFINEMENT]: { label: 'needs refinement',    color: '#f59e0b' },
  [PANEL_LIFECYCLE.ACCEPTED]:         { label: 'accepted',            color: '#00e5b4' },
  [PANEL_LIFECYCLE.FAILED]:           { label: 'failed',              color: '#f87171' },
  // Virtual display state — not a lifecycle value, used by UI when strength audit blocks
  needs_strengthening:                { label: 'needs strengthening', color: '#f97316' },
}

/** Strength status display metadata (used in UI alongside lifecycle badge). */
export const STRENGTH_DISPLAY = {
  [STRENGTH_STATUSES.STRONG]:   { label: 'strong',             color: '#00e5b4' },
  [STRENGTH_STATUSES.ADEQUATE]: { label: 'adequate',           color: '#a3e635' },
  [STRENGTH_STATUSES.WEAK]:     { label: 'needs strengthening', color: '#f97316' },
  [STRENGTH_STATUSES.FAILED]:   { label: 'too generic',        color: '#f87171' },
}
