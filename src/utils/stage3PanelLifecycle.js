import {
  UNIT_LIFECYCLE_STATES,
  canAcceptUnit,
  computeUnitsReadiness,
  deriveUnitLifecycleFromAudit,
  transitionUnitToAccepted,
  transitionUnitToDraftReady,
  transitionUnitToFailed,
  transitionUnitToGenerating,
  transitionUnitToNeedsRefinement,
} from './unitLifecycle'

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
  return canAcceptUnit(panel, { audit: panel?.completenessAudit })
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
  const blockingReasons = []

  PANEL_IDS.forEach(panelId => {
    const panel = panels[panelId]
    const lifecycle = panel?.lifecycle || PANEL_LIFECYCLE.NOT_STARTED
    const audit = panel?.completenessAudit

    if (!readiness.blockingUnits.includes(panelId)) return

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
    if (lifecycle !== PANEL_LIFECYCLE.ACCEPTED) {
      blockingReasons.push(`${PANEL_LABELS[panelId]}: not yet accepted (status: ${lifecycle})`)
      return
    }
    blockingReasons.push(`${PANEL_LABELS[panelId]}: blocking audit issue (${audit?.status || 'missing audit'})`)
  })

  return {
    isReady: readiness.isReady,
    blockingPanels: readiness.blockingUnits,
    blockingReasons: [...blockingReasons, ...crossPanelBlockingReasons],
    crossPanelQuality: crossPanelAudit?.qualityStatus || null,
    lastCheckedAt: new Date().toISOString(),
  }
}

export const LIFECYCLE_DISPLAY = {
  [PANEL_LIFECYCLE.NOT_STARTED]:      { label: 'not started',      color: '#6b7280' },
  [PANEL_LIFECYCLE.GENERATING]:       { label: 'generating',       color: '#3b82f6' },
  [PANEL_LIFECYCLE.DRAFT_READY]:      { label: 'draft ready',      color: '#fb923c' },
  [PANEL_LIFECYCLE.NEEDS_REFINEMENT]: { label: 'needs refinement', color: '#f59e0b' },
  [PANEL_LIFECYCLE.ACCEPTED]:         { label: 'accepted',         color: '#00e5b4' },
  [PANEL_LIFECYCLE.FAILED]:           { label: 'failed',           color: '#f87171' },
}
