/**
 * Reusable generation/refinement lifecycle for durable planning units.
 *
 * A unit may be a Stage 2 handoff item, a Stage 3 BU panel, or a later
 * Stage 4 artifact output. Generation may produce drafts, but only accepted
 * units are considered downstream-ready.
 */

export const UNIT_LIFECYCLE_STATES = {
  NOT_STARTED:      'not_started',
  GENERATING:       'generating',
  DRAFT_READY:      'draft_ready',
  NEEDS_REFINEMENT: 'needs_refinement',
  ACCEPTED:         'accepted',
  FAILED:           'failed',
}

export const UNIT_REFINEMENT_STATUSES = {
  PROPOSED: 'proposed',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  FAILED:   'failed',
}

const LEGACY_STATUS_MAP = {
  not_started:       UNIT_LIFECYCLE_STATES.NOT_STARTED,
  pending:           UNIT_LIFECYCLE_STATES.NOT_STARTED,
  generating:        UNIT_LIFECYCLE_STATES.GENERATING,
  running:           UNIT_LIFECYCLE_STATES.GENERATING,
  complete:          UNIT_LIFECYCLE_STATES.DRAFT_READY,
  draft_generated:   UNIT_LIFECYCLE_STATES.DRAFT_READY,
  partial:           UNIT_LIFECYCLE_STATES.NEEDS_REFINEMENT,
  partial_draft:     UNIT_LIFECYCLE_STATES.NEEDS_REFINEMENT,
  stale:             UNIT_LIFECYCLE_STATES.NEEDS_REFINEMENT,
  needs_refinement:  UNIT_LIFECYCLE_STATES.NEEDS_REFINEMENT,
  accepted:          UNIT_LIFECYCLE_STATES.ACCEPTED,
  failed:            UNIT_LIFECYCLE_STATES.FAILED,
  generation_failed: UNIT_LIFECYCLE_STATES.FAILED,
  api_rate_limited:  UNIT_LIFECYCLE_STATES.FAILED,
}

const BLOCKING_AUDIT_STATUSES = new Set([
  'failed',
  'truncated',
  'incomplete',
  'missing',
  'parse_failure',
  'empty_response',
  'needs_refinement',
])

export function normalizeUnitLifecycleStatus(status) {
  const value = typeof status === 'object' ? status?.status : status
  return LEGACY_STATUS_MAP[value] || value || UNIT_LIFECYCLE_STATES.NOT_STARTED
}

export function getUnitLifecycleStatus(unit) {
  return normalizeUnitLifecycleStatus(unit?.lifecycle?.status || unit?.lifecycle || unit?.status)
}

export function createUnitLifecycle({
  status = UNIT_LIFECYCLE_STATES.NOT_STARTED,
  audit = null,
  acceptedAt = null,
  failureReason = null,
  updatedAt = null,
} = {}) {
  return {
    status: normalizeUnitLifecycleStatus(status),
    audit,
    acceptedAt,
    failureReason,
    updatedAt: updatedAt || new Date().toISOString(),
  }
}

export function unitAuditHasBlockingIssues(audit) {
  if (!audit) return true
  if (audit.blocking === true) return true
  if (BLOCKING_AUDIT_STATUSES.has(audit.status)) return true
  return [
    audit.missingFields,
    audit.truncatedFields,
    audit.duplicateFieldFindings,
    audit.alignmentFindings,
    audit.failedFields,
    audit.failedChildren,
    audit.missingChildren,
    audit.blockingFindings,
  ].some(items => Array.isArray(items) && items.length > 0)
}

export function deriveUnitLifecycleFromAudit({ hasContent = false, audit = null } = {}) {
  if (!hasContent) return UNIT_LIFECYCLE_STATES.NOT_STARTED
  return unitAuditHasBlockingIssues(audit)
    ? UNIT_LIFECYCLE_STATES.NEEDS_REFINEMENT
    : UNIT_LIFECYCLE_STATES.DRAFT_READY
}

export function canAcceptUnit(unit, { audit = unit?.audit || unit?.completenessAudit || unit?.lifecycle?.audit } = {}) {
  return getUnitLifecycleStatus(unit) === UNIT_LIFECYCLE_STATES.DRAFT_READY &&
    !unitAuditHasBlockingIssues(audit)
}

export function transitionUnitToGenerating(unit) {
  return {
    ...unit,
    lifecycle: UNIT_LIFECYCLE_STATES.GENERATING,
    lifecycleMeta: createUnitLifecycle({ status: UNIT_LIFECYCLE_STATES.GENERATING }),
    lifecycleError: null,
  }
}

export function transitionUnitToDraftReady(unit, { contentPatch = {}, audit = null } = {}) {
  const status = deriveUnitLifecycleFromAudit({
    hasContent: true,
    audit,
  })
  return {
    ...unit,
    ...contentPatch,
    lifecycle: status,
    lifecycleMeta: createUnitLifecycle({ status, audit }),
    lifecycleError: null,
    lastGeneratedAt: new Date().toISOString(),
  }
}

export function transitionUnitToFailed(unit, failureReason, { attemptedContent = null, auditAfter = null } = {}) {
  return {
    ...unit,
    lifecycle: UNIT_LIFECYCLE_STATES.FAILED,
    lifecycleMeta: createUnitLifecycle({
      status: UNIT_LIFECYCLE_STATES.FAILED,
      audit: auditAfter,
      failureReason: failureReason || 'Generation failed.',
    }),
    lifecycleError: String(failureReason || 'Generation failed.'),
    failedDraft: attemptedContent,
  }
}

export function transitionUnitToAccepted(unit, { audit = unit?.audit || unit?.completenessAudit || unit?.lifecycle?.audit } = {}) {
  if (!canAcceptUnit(unit, { audit })) {
    throw new Error(`Cannot accept unit: lifecycle=${getUnitLifecycleStatus(unit)}, auditStatus=${audit?.status || 'missing'}`)
  }
  return {
    ...unit,
    lifecycle: UNIT_LIFECYCLE_STATES.ACCEPTED,
    lifecycleMeta: createUnitLifecycle({
      status: UNIT_LIFECYCLE_STATES.ACCEPTED,
      audit,
      acceptedAt: new Date().toISOString(),
    }),
    acceptedAt: new Date().toISOString(),
  }
}

export function transitionUnitToNeedsRefinement(unit, reason) {
  return {
    ...unit,
    lifecycle: UNIT_LIFECYCLE_STATES.NEEDS_REFINEMENT,
    lifecycleMeta: createUnitLifecycle({
      status: UNIT_LIFECYCLE_STATES.NEEDS_REFINEMENT,
      audit: unit?.audit || unit?.completenessAudit || unit?.lifecycle?.audit || null,
      failureReason: reason || null,
    }),
    needsRefinementReason: reason || null,
    acceptedAt: null,
  }
}

export function createUnitRefinementRecord({
  refinementId = null,
  unitId = null,
  prompt = '',
  previousSnapshot = null,
  proposedSnapshot = null,
  auditBefore = null,
  auditAfter = null,
  status = UNIT_REFINEMENT_STATUSES.PROPOSED,
  failureReason = null,
  createdAt = null,
} = {}) {
  return {
    refinementId: refinementId || `ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    unitId,
    prompt,
    previousSnapshot,
    proposedSnapshot,
    auditBefore,
    auditAfter,
    status,
    failureReason,
    createdAt: createdAt || new Date().toISOString(),
  }
}

export function appendUnitRefinementHistory(unit, record, historyKey = 'refinementHistory') {
  return {
    ...unit,
    [historyKey]: [
      ...(unit?.[historyKey] || []),
      record,
    ],
  }
}

export function computeUnitsReadiness(units = [], {
  getLabel = unit => unit?.unitId || unit?.panelId || unit?.id || 'Unit',
  getAudit = unit => unit?.audit || unit?.completenessAudit || unit?.lifecycle?.audit || null,
  extraBlockingReasons = [],
} = {}) {
  const blockingUnits = []
  const blockingReasons = []

  units.forEach(unit => {
    const status = getUnitLifecycleStatus(unit)
    const audit = getAudit(unit)
    const label = getLabel(unit)

    if (status !== UNIT_LIFECYCLE_STATES.ACCEPTED) {
      blockingUnits.push(unit?.unitId || unit?.panelId || unit?.id || label)
      blockingReasons.push(`${label}: not accepted (status: ${status})`)
      return
    }

    if (unitAuditHasBlockingIssues(audit)) {
      blockingUnits.push(unit?.unitId || unit?.panelId || unit?.id || label)
      blockingReasons.push(`${label}: blocking audit issue (${audit?.status || 'missing audit'})`)
    }
  })

  return {
    isReady: blockingUnits.length === 0 && extraBlockingReasons.length === 0,
    blockingUnits,
    blockingReasons: [...blockingReasons, ...extraBlockingReasons],
    lastCheckedAt: new Date().toISOString(),
  }
}

