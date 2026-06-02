/**
 * Stage 4 artifact section lifecycle adapter.
 *
 * Thin wrapper over the shared unit lifecycle. Artifact sections are units;
 * artifact status is derived from those section units.
 */

import {
  UNIT_LIFECYCLE_STATES,
  createUnitLifecycle,
  transitionUnitToGenerating,
  transitionUnitToDraftReady,
  transitionUnitToFailed,
  transitionUnitToAccepted,
  transitionUnitToNeedsRefinement,
  unitAuditHasBlockingIssues,
  canAcceptUnit,
  computeUnitsReadiness,
  createUnitRefinementRecord,
  appendUnitRefinementHistory,
} from './unitLifecycle'

export {
  UNIT_LIFECYCLE_STATES,
  createUnitLifecycle,
  transitionUnitToGenerating,
  transitionUnitToDraftReady,
  transitionUnitToFailed,
  transitionUnitToAccepted,
  transitionUnitToNeedsRefinement,
  unitAuditHasBlockingIssues,
  canAcceptUnit,
  computeUnitsReadiness,
  createUnitRefinementRecord,
  appendUnitRefinementHistory,
}

export const ARTIFACT_SECTION_LIFECYCLE = UNIT_LIFECYCLE_STATES

export const ARTIFACT_GENERATION_STATUS = {
  NOT_STARTED:    'not_started',
  GENERATING:     'generating',
  PARTIAL:        'partial',
  GENERATED:      'generated',
  NEEDS_REVISION: 'needs_revision',
  FAILED:         'failed',
}

export function createArtifactSectionUnit(sectionDef, patch = {}) {
  const sectionId = sectionDef?.id || sectionDef?.sectionId || patch.sectionId
  return {
    unitId: sectionId,
    sectionId,
    heading: sectionDef?.heading || patch.heading || sectionId,
    purpose: sectionDef?.purpose || patch.purpose || '',
    lifecycle: UNIT_LIFECYCLE_STATES.NOT_STARTED,
    lifecycleMeta: createUnitLifecycle({ status: UNIT_LIFECYCLE_STATES.NOT_STARTED }),
    generationMode: sectionDef?.generationMode || patch.generationMode || 'single',
    childUnits: patch.childUnits || [],
    assembledContent: patch.assembledContent || null,
    section: null,
    audit: null,
    generationAttempts: [],
    ...patch,
  }
}

export function createArtifactChildUnit(childDef, patch = {}) {
  const childId = childDef?.childId || childDef?.id || patch.childId
  return {
    unitId: childId,
    childId,
    parentSectionId: childDef?.parentSectionId || patch.parentSectionId,
    sourceItemId: childDef?.sourceItemId || patch.sourceItemId || childId,
    label: childDef?.label || patch.label || childId,
    sourceItem: childDef?.sourceItem || patch.sourceItem || null,
    lifecycle: UNIT_LIFECYCLE_STATES.NOT_STARTED,
    lifecycleMeta: createUnitLifecycle({ status: UNIT_LIFECYCLE_STATES.NOT_STARTED }),
    content: null,
    audit: null,
    failureReason: null,
    lastGeneratedAt: null,
    ...patch,
  }
}

export function transitionSectionToGenerating(unit) {
  return transitionUnitToGenerating(unit)
}

export function transitionSectionToFailed(unit, failureReason, options = {}) {
  return transitionUnitToFailed(unit, failureReason, options)
}

export function transitionSectionToDraft(unit, section, audit) {
  return transitionUnitToDraftReady(unit, {
    contentPatch: { section, audit },
    audit,
  })
}

export function transitionSectionToAccepted(unit, audit = unit?.audit) {
  return transitionUnitToAccepted(unit, { audit })
}

export function transitionSectionToNeedsRevision(unit, reason) {
  return transitionUnitToNeedsRefinement(unit, reason)
}

export function sectionIsValid(unit) {
  const childrenValid = !unit?.childUnits?.length || unit.childUnits.every(child =>
    [UNIT_LIFECYCLE_STATES.DRAFT_READY, UNIT_LIFECYCLE_STATES.ACCEPTED].includes(child?.lifecycle) &&
    !unitAuditHasBlockingIssues(child?.audit)
  )
  return childrenValid &&
    [UNIT_LIFECYCLE_STATES.DRAFT_READY, UNIT_LIFECYCLE_STATES.ACCEPTED].includes(unit?.lifecycle) &&
    !unitAuditHasBlockingIssues(unit?.audit)
}

export function deriveArtifactGenerationStatus(sectionUnits = []) {
  if (!sectionUnits.length) return ARTIFACT_GENERATION_STATUS.NOT_STARTED
  const states = sectionUnits.flatMap(unit => [
    unit?.lifecycle || UNIT_LIFECYCLE_STATES.NOT_STARTED,
    ...(unit?.childUnits || []).map(child => child?.lifecycle || UNIT_LIFECYCLE_STATES.NOT_STARTED),
  ])
  if (states.some(state => state === UNIT_LIFECYCLE_STATES.GENERATING)) return ARTIFACT_GENERATION_STATUS.GENERATING
  if (states.every(state => state === UNIT_LIFECYCLE_STATES.NOT_STARTED)) return ARTIFACT_GENERATION_STATUS.NOT_STARTED
  if (states.every(state => state === UNIT_LIFECYCLE_STATES.FAILED)) return ARTIFACT_GENERATION_STATUS.FAILED
  if (states.some(state => state === UNIT_LIFECYCLE_STATES.FAILED)) return ARTIFACT_GENERATION_STATUS.PARTIAL
  if (states.some(state => state === UNIT_LIFECYCLE_STATES.NEEDS_REFINEMENT)) return ARTIFACT_GENERATION_STATUS.NEEDS_REVISION
  if (states.every(state => state === UNIT_LIFECYCLE_STATES.ACCEPTED || state === UNIT_LIFECYCLE_STATES.DRAFT_READY)) {
    return ARTIFACT_GENERATION_STATUS.GENERATED
  }
  return ARTIFACT_GENERATION_STATUS.PARTIAL
}

export function computeArtifactSectionReadiness(sectionUnits = []) {
  return computeUnitsReadiness(sectionUnits, {
    getLabel: unit => unit?.heading || unit?.sectionId || unit?.unitId || 'Artifact section',
    getAudit: unit => unit?.audit,
  })
}

export function appendSectionGenerationAttempt(unit, attempt) {
  const record = createUnitRefinementRecord({
    unitId: unit?.sectionId || unit?.unitId,
    prompt: attempt?.prompt || '',
    previousSnapshot: attempt?.previousSnapshot || unit?.section || null,
    proposedSnapshot: attempt?.proposedSnapshot || null,
    auditBefore: unit?.audit || null,
    auditAfter: attempt?.auditAfter || null,
    status: attempt?.status || 'proposed',
    failureReason: attempt?.failureReason || null,
  })
  return appendUnitRefinementHistory(unit, record, 'generationAttempts')
}
