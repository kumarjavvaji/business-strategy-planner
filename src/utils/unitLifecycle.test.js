import { describe, expect, it } from 'vitest'
import {
  UNIT_LIFECYCLE_STATES,
  canAcceptUnit,
  computeUnitsReadiness,
  createUnitRefinementRecord,
  deriveUnitLifecycleFromAudit,
  transitionUnitToAccepted,
  transitionUnitToFailed,
  unitAuditHasBlockingIssues,
} from './unitLifecycle'

describe('unitLifecycle', () => {
  it('derives draft_ready only when content exists and audit passes', () => {
    expect(deriveUnitLifecycleFromAudit({
      hasContent: true,
      audit: { status: 'complete', blocking: false },
    })).toBe(UNIT_LIFECYCLE_STATES.DRAFT_READY)
  })

  it('derives needs_refinement for blocking audits', () => {
    expect(deriveUnitLifecycleFromAudit({
      hasContent: true,
      audit: { status: 'truncated', blocking: true },
    })).toBe(UNIT_LIFECYCLE_STATES.NEEDS_REFINEMENT)
  })

  it('allows acceptance only from draft_ready with a passing audit', () => {
    const unit = {
      id: 'dependencies',
      lifecycle: UNIT_LIFECYCLE_STATES.DRAFT_READY,
      audit: { status: 'complete', blocking: false },
    }

    expect(canAcceptUnit(unit)).toBe(true)
    expect(transitionUnitToAccepted(unit).lifecycle).toBe(UNIT_LIFECYCLE_STATES.ACCEPTED)
  })

  it('blocks acceptance when audit has truncation or missing fields', () => {
    const unit = {
      id: 'dependencies',
      lifecycle: UNIT_LIFECYCLE_STATES.DRAFT_READY,
      audit: { status: 'truncated', truncatedFields: ['requiredInput'] },
    }

    expect(unitAuditHasBlockingIssues(unit.audit)).toBe(true)
    expect(canAcceptUnit(unit)).toBe(false)
  })

  it('keeps failed attempted content separate from accepted output', () => {
    const accepted = {
      id: 'dependencies',
      lifecycle: UNIT_LIFECYCLE_STATES.ACCEPTED,
      acceptedOutput: { text: 'previous accepted content' },
    }

    const failed = transitionUnitToFailed(accepted, 'Truncated model output', {
      attemptedContent: { text: 'cut off con' },
      auditAfter: { status: 'truncated', blocking: true },
    })

    expect(failed.acceptedOutput).toEqual(accepted.acceptedOutput)
    expect(failed.failedDraft).toEqual({ text: 'cut off con' })
    expect(failed.lifecycle).toBe(UNIT_LIFECYCLE_STATES.FAILED)
  })

  it('logs refinement history records with failure reasons', () => {
    const record = createUnitRefinementRecord({
      unitId: 'dependencies',
      prompt: 'tighten dependencies',
      previousSnapshot: { text: 'previous' },
      proposedSnapshot: { text: 'cut off con' },
      status: 'failed',
      failureReason: 'Truncated model output',
    })

    expect(record.unitId).toBe('dependencies')
    expect(record.status).toBe('failed')
    expect(record.failureReason).toBe('Truncated model output')
    expect(record.refinementId).toBeTruthy()
  })

  it('requires every unit to be accepted and passing for downstream readiness', () => {
    const readiness = computeUnitsReadiness([
      { id: 'one', lifecycle: UNIT_LIFECYCLE_STATES.ACCEPTED, audit: { status: 'complete', blocking: false } },
      { id: 'two', lifecycle: UNIT_LIFECYCLE_STATES.DRAFT_READY, audit: { status: 'complete', blocking: false } },
    ])

    expect(readiness.isReady).toBe(false)
    expect(readiness.blockingUnits).toContain('two')
  })
})

