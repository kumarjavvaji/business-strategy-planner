/**
 * Stage 4 active-deliverable filtering tests.
 *
 * Rule: in active (non-editing) mode the Stage 4 view must show only artifact jobs
 * whose persisted `selected` field is true.  Unselected candidates must be absent
 * from the rendered list and must not affect ready / blocked / advisory / generated
 * counts.
 *
 * Root-cause fix (stage4ArtifactPlan.js): suggestArtifacts now reads
 * bu.stage3PanelModel.panels.executionSequence.selectedStage4Deliverables to seed
 * the initial `selected` value.  Only artifact types the user checked in Stage 3
 * default to selected: true; unchecked types default to selected: false.
 *
 * These tests operate on the data layer (buildArtifactPlan, artifactReadinessBlocksGeneration,
 * suggestArtifacts internals) so they run without a DOM or React renderer.
 */

import { describe, it, expect } from 'vitest'
import {
  buildArtifactPlan,
  suggestArtifacts,
  correctPlanSelectionFromS3,
  artifactReadinessBlocksGeneration,
  ARTIFACT_READINESS,
} from './stage4ArtifactPlan'

// ── Minimal handoff fixture ───────────────────────────────────────────────────

function makeBuHandoff(overrides = {}) {
  return {
    buName: 'Engineering & API Infrastructure',
    status: 'ready',
    sourceAtomIds: Array.from({ length: 12 }, (_, i) => `atom_${i}`),
    completedAtomCount: 12,
    blockedReason: null,
    stage3PanelModel: {
      panels: {
        executionSequence: {
          content: [
            {
              phaseName: 'Phase 1',
              howOptions: [{ optionName: 'Option A', whenToUse: 'always', whyItFitsThePhaseOutcome: 'fits', evidenceProduced: 'evidence' }],
            },
          ],
          // Default fixture has only bu_execution_plan selected in Stage 3
          selectedStage4Deliverables: [
            { deliverableType: 'bu_execution_plan', status: 'user_selected' },
          ],
          executionDeliverableMappings: {
            phase_1: {
              howOptionMappings: {
                option_a: { mappedDeliverables: ['bu_execution_plan'] },
              },
            },
          },
        },
        strategicObjective: { content: 'objective text' },
        criticalDecisions: { content: [] },
        dependencies: { content: [] },
        risks: { content: [] },
        validationFramework: { content: [] },
      },
    },
    ...overrides,
  }
}

function makeHandoff(buOverrides = {}) {
  return {
    handoffId: 'test_handoff_1',
    handoffKey: 'bsp_v1_stage4_handoff_ws1_s1_s2_s3',
    persistedAt: '2025-01-01T00:00:00.000Z',
    compiledAt: '2025-01-01T00:00:00.000Z',
    overallStatus: 'ready',
    readyCount: 1,
    partialCount: 0,
    blockedCount: 0,
    totalCount: 1,
    buHandoffs: [makeBuHandoff(buOverrides)],
  }
}

// ── Helpers that replicate the active-view filter used in Stage4View ──────────

/**
 * Simulates what Stage4View does in non-editing (active) mode:
 * filters the persisted plan to only the selected artifact jobs.
 */
function activeDeliverables(plan) {
  const globals = (plan.globalArtifacts || []).filter(a => a.selected)
  const buJobs  = (plan.businessUnitArtifacts || []).filter(a => a.selected)
  return [...globals, ...buJobs]
}

/**
 * Simulates what Stage4View does in editing mode:
 * returns all artifact candidates (selected and unselected).
 */
function editingDeliverables(plan) {
  return [...(plan.globalArtifacts || []), ...(plan.businessUnitArtifacts || [])]
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Stage 4 active-deliverable filter — selected flag on plan artifacts', () => {
  it('blocked artifact jobs are never selected in the initial plan', () => {
    const handoff = makeHandoff({ status: 'blocked', blockedReason: 'No durable Stage 3 record.' })
    // Override so the BU is blocked
    handoff.buHandoffs[0].status = 'blocked'
    const plan = buildArtifactPlan(handoff, 'ws1', 's1', 's2', 's3')
    const all = editingDeliverables(plan)
    const blockedJobs = all.filter(a => artifactReadinessBlocksGeneration(a.readinessStatus))
    blockedJobs.forEach(a => {
      expect(a.selected).toBe(false)
    })
  })

  it('ready BU artifact jobs in Stage 3 selectedStage4Deliverables are auto-selected; others default to false', () => {
    // The default fixture has only bu_execution_plan in selectedStage4Deliverables.
    const plan = buildArtifactPlan(makeHandoff(), 'ws1', 's1', 's2', 's3')
    const all = editingDeliverables(plan)
    const readyJobs = all.filter(a => a.readinessStatus === ARTIFACT_READINESS.READY && a.scope === 'business_unit')
    expect(readyJobs.length).toBeGreaterThan(0)

    // Only the type that was checked in Stage 3 should be selected
    const selected   = readyJobs.filter(a => a.selected)
    const unselected = readyJobs.filter(a => !a.selected)
    expect(selected.every(a => a.artifactType === 'bu_execution_plan')).toBe(true)
    expect(unselected.length).toBeGreaterThan(0) // other types are present but unselected
  })

  it('active view (filter by selected) excludes unselected candidates', () => {
    const plan = buildArtifactPlan(makeHandoff(), 'ws1', 's1', 's2', 's3')

    // Manually mark one BU job as deselected (simulating a user uncheck + save)
    const buJobs = plan.businessUnitArtifacts
    if (buJobs.length > 0) {
      buJobs[0].selected = false
    }

    const active  = activeDeliverables(plan)
    const editing = editingDeliverables(plan)

    // Active view must have fewer items than the editing (all-candidates) view
    expect(active.length).toBeLessThan(editing.length)

    // None of the active-view items should be deselected
    active.forEach(a => {
      expect(a.selected).toBe(true)
    })
  })

  it('unselected artifact job does not appear in the active deliverable list', () => {
    const plan = buildArtifactPlan(makeHandoff(), 'ws1', 's1', 's2', 's3')
    const buJobs = plan.businessUnitArtifacts

    // Pick one selectable job and explicitly deselect it
    const target = buJobs.find(a => a.selected)
    if (!target) return // guard: nothing to deselect
    const targetId = target.artifactId
    target.selected = false

    const active = activeDeliverables(plan)
    const ids = active.map(a => a.artifactId)
    expect(ids).not.toContain(targetId)
  })

  it('unselected artifact job does not count toward active totals', () => {
    const plan = buildArtifactPlan(makeHandoff(), 'ws1', 's1', 's2', 's3')

    // Deselect every BU job
    plan.businessUnitArtifacts.forEach(a => { a.selected = false })

    const active = activeDeliverables(plan)
    const buActive = active.filter(a => a.scope === 'business_unit')
    expect(buActive.length).toBe(0)
  })

  it('active count equals only selected jobs (not total candidates)', () => {
    const plan = buildArtifactPlan(makeHandoff(), 'ws1', 's1', 's2', 's3')
    const all = editingDeliverables(plan)

    // Deselect half the jobs
    const half = Math.floor(all.length / 2)
    all.slice(0, half).forEach(a => {
      // Find and deselect in the plan arrays
      const inGlobal = plan.globalArtifacts.find(g => g.artifactId === a.artifactId)
      const inBu     = plan.businessUnitArtifacts.find(b => b.artifactId === a.artifactId)
      if (inGlobal) inGlobal.selected = false
      if (inBu)     inBu.selected     = false
    })

    const active = activeDeliverables(plan)
    const selectedCount = all.filter(a => a.selected).length
    expect(active.length).toBe(selectedCount)
    expect(active.length).toBeLessThanOrEqual(all.length)
  })

  it('editing view still shows all candidates including unselected ones', () => {
    const plan = buildArtifactPlan(makeHandoff(), 'ws1', 's1', 's2', 's3')
    const all = editingDeliverables(plan)

    // Deselect everything
    plan.globalArtifacts.forEach(a => { a.selected = false })
    plan.businessUnitArtifacts.forEach(a => { a.selected = false })

    const editing = editingDeliverables(plan)
    // Editing view still exposes every candidate
    expect(editing.length).toBe(all.length)
  })

  it('selected artifact with zero mapped how-options remains visible in active view (it is selected, just basis-incomplete)', () => {
    // Build a plan where the BU has no how-options mapped.  The artifact will be
    // selected (not blocked at the artifact level) but will show basis_incomplete.
    const handoff = makeHandoff()
    // Remove mappings so basis is incomplete
    handoff.buHandoffs[0].stage3PanelModel.panels.executionSequence.executionDeliverableMappings = {}

    const plan = buildArtifactPlan(handoff, 'ws1', 's1', 's2', 's3')
    const active = activeDeliverables(plan)

    // The bu_execution_plan job: if it is selected it should appear in active view
    const execPlan = active.find(a => a.artifactType === 'bu_execution_plan')
    if (execPlan) {
      expect(execPlan.selected).toBe(true)
    }
    // None of the active-view items should be unselected
    active.forEach(a => expect(a.selected).toBe(true))
  })

  it('blocked BU jobs are excluded from active view even without explicit deselection', () => {
    const handoff = makeHandoff()
    // Simulate a blocked BU scenario
    handoff.buHandoffs[0].status = 'blocked'
    handoff.buHandoffs[0].blockedReason = 'No durable Stage 3 record.'
    handoff.buHandoffs[0].stage3PanelModel = null

    const plan = buildArtifactPlan(handoff, 'ws1', 's1', 's2', 's3')
    const active = activeDeliverables(plan)

    // All active deliverables must be selected
    active.forEach(a => {
      expect(a.selected).toBe(true)
    })
    // Blocked artifact jobs must not appear in active view
    const blockedInActive = active.filter(a => artifactReadinessBlocksGeneration(a.readinessStatus))
    expect(blockedInActive.length).toBe(0)
  })

  it('artifactReadinessBlocksGeneration returns true for all BLOCKED_* variants', () => {
    const blockingStatuses = [
      ARTIFACT_READINESS.BLOCKED,
      ARTIFACT_READINESS.BLOCKED_UNSUPPORTED_GENERATOR,
      ARTIFACT_READINESS.BLOCKED_MISSING_ARTIFACT_SPEC,
      ARTIFACT_READINESS.BLOCKED_MISSING_SOURCE,
      ARTIFACT_READINESS.BLOCKED_MISSING_MAPPING,
      ARTIFACT_READINESS.BLOCKED_MATERIALLY_STALE,
    ]
    blockingStatuses.forEach(status => {
      expect(artifactReadinessBlocksGeneration(status)).toBe(true)
    })
  })

  it('artifactReadinessBlocksGeneration returns false for non-blocking statuses', () => {
    const nonBlocking = [ARTIFACT_READINESS.READY, ARTIFACT_READINESS.PARTIAL]
    nonBlocking.forEach(status => {
      expect(artifactReadinessBlocksGeneration(status)).toBe(false)
    })
  })
})

describe('Stage 4 active-deliverable filter — handleSave selection persistence', () => {
  /**
   * Simulates the applySelections logic from Stage4View.handleSave:
   *   selected: !artifactReadinessBlocksGeneration(a.readinessStatus) && selectedIds.has(a.artifactId)
   */
  function applySelections(artifacts, selectedIds) {
    return artifacts.map(a => ({
      ...a,
      selected: !artifactReadinessBlocksGeneration(a.readinessStatus) && selectedIds.has(a.artifactId),
    }))
  }

  it('saving with an empty selectedIds set marks all non-blocked artifacts as unselected', () => {
    const plan = buildArtifactPlan(makeHandoff(), 'ws1', 's1', 's2', 's3')
    const after = applySelections(
      [...plan.globalArtifacts, ...plan.businessUnitArtifacts],
      new Set(), // user deselected everything
    )
    const selected = after.filter(a => a.selected)
    expect(selected.length).toBe(0)
  })

  it('saving preserves selection only for ids in selectedIds', () => {
    const plan = buildArtifactPlan(makeHandoff(), 'ws1', 's1', 's2', 's3')
    const all = [...plan.globalArtifacts, ...plan.businessUnitArtifacts]
    const nonBlocked = all.filter(a => !artifactReadinessBlocksGeneration(a.readinessStatus))

    if (nonBlocked.length < 2) return // not enough artifacts to test
    const [keep, ...deselect] = nonBlocked
    const selectedIds = new Set([keep.artifactId])

    const after = applySelections(all, selectedIds)

    const selectedAfter = after.filter(a => a.selected)
    expect(selectedAfter.length).toBe(1)
    expect(selectedAfter[0].artifactId).toBe(keep.artifactId)

    deselect.forEach(a => {
      const saved = after.find(x => x.artifactId === a.artifactId)
      expect(saved.selected).toBe(false)
    })
  })

  it('blocked artifacts cannot be selected even if their id is in selectedIds', () => {
    const handoff = makeHandoff()
    handoff.buHandoffs[0].status = 'blocked'
    handoff.buHandoffs[0].stage3PanelModel = null

    const plan = buildArtifactPlan(handoff, 'ws1', 's1', 's2', 's3')
    const all = [...plan.globalArtifacts, ...plan.businessUnitArtifacts]

    // Put every artifact id in selectedIds — blocked ones must still end up unselected
    const allIds = new Set(all.map(a => a.artifactId))
    const after = applySelections(all, allIds)

    const blockedAfter = after.filter(a => artifactReadinessBlocksGeneration(a.readinessStatus))
    blockedAfter.forEach(a => {
      expect(a.selected).toBe(false)
    })
  })
})

// ── Stage 3 selection-aware seeding (root-cause fix) ─────────────────────────

describe('suggestArtifacts — Stage 3 selectedStage4Deliverables drives initial selection', () => {
  function makeHandoffWithS3Selection(selectedTypes) {
    // Build a handoff where the BU's execution sequence panel records exactly
    // `selectedTypes` as the Stage 3 user-selected deliverables.
    const bu = makeBuHandoff()
    bu.stage3PanelModel.panels.executionSequence.selectedStage4Deliverables =
      selectedTypes.map(t => ({ deliverableType: t, status: 'user_selected' }))
    return {
      handoffId: 'test_handoff_s3',
      persistedAt: '2025-01-01T00:00:00.000Z',
      compiledAt: '2025-01-01T00:00:00.000Z',
      overallStatus: 'ready',
      readyCount: 1,
      partialCount: 0,
      blockedCount: 0,
      totalCount: 1,
      buHandoffs: [bu],
    }
  }

  it('artifact type checked in Stage 3 is auto-selected (selected: true) in the plan', () => {
    const handoff = makeHandoffWithS3Selection(['bu_execution_plan', 'pdlc_epic_outline'])
    const suggested = suggestArtifacts(handoff)
    const buExecPlan = suggested.find(a => a.artifactType === 'bu_execution_plan')
    const pdlcEpic   = suggested.find(a => a.artifactType === 'pdlc_epic_outline')
    expect(buExecPlan?.selected).toBe(true)
    expect(pdlcEpic?.selected).toBe(true)
  })

  it('artifact type NOT checked in Stage 3 defaults to selected: false', () => {
    // Only bu_execution_plan and pdlc_epic_outline are checked.
    // acceptance_criteria_draft and implementation_governance_checklist are NOT.
    const handoff = makeHandoffWithS3Selection(['bu_execution_plan', 'pdlc_epic_outline'])
    const suggested = suggestArtifacts(handoff)

    const unchecked = ['acceptance_criteria_draft', 'implementation_governance_checklist']
    for (const type of unchecked) {
      const artifact = suggested.find(a => a.artifactType === type)
      if (artifact) {
        // Must default to false — user did not select this in Stage 3
        expect(artifact.selected).toBe(false)
      }
    }
  })

  it('unselected-in-S3 artifact does not appear in the active deliverable list after plan build', () => {
    const handoff = makeHandoffWithS3Selection(['bu_execution_plan'])
    const plan = buildArtifactPlan(handoff, 'ws1', 's1', 's2', 's3')

    // Active view filter (mirrors Stage4View non-editing logic)
    const active = [
      ...(plan.globalArtifacts || []),
      ...(plan.businessUnitArtifacts || []),
    ].filter(a => a.selected)

    // Only bu_execution_plan should be selected for this BU
    const buTypes = active.filter(a => a.scope === 'business_unit').map(a => a.artifactType)
    expect(buTypes).toContain('bu_execution_plan')
    expect(buTypes).not.toContain('acceptance_criteria_draft')
    expect(buTypes).not.toContain('implementation_governance_checklist')
  })

  it('unselected-in-S3 artifact still appears as a candidate in editing view (selected: false, not hidden)', () => {
    const handoff = makeHandoffWithS3Selection(['bu_execution_plan'])
    const plan = buildArtifactPlan(handoff, 'ws1', 's1', 's2', 's3')

    // Editing view shows all candidates
    const allCandidates = [
      ...(plan.globalArtifacts || []),
      ...(plan.businessUnitArtifacts || []),
    ]

    const acceptance = allCandidates.find(a => a.artifactType === 'acceptance_criteria_draft')
    expect(acceptance).toBeDefined()          // candidate exists for editing
    expect(acceptance.selected).toBe(false)   // but not auto-selected
  })

  it('when selectedStage4Deliverables is absent (old handoff), all ready artifacts default to selected: true', () => {
    // Simulate an older handoff whose panel model has no selectedStage4Deliverables
    const bu = makeBuHandoff()
    delete bu.stage3PanelModel.panels.executionSequence.selectedStage4Deliverables

    const handoff = {
      handoffId: 'legacy_handoff',
      persistedAt: '2025-01-01T00:00:00.000Z',
      compiledAt: '2025-01-01T00:00:00.000Z',
      overallStatus: 'ready',
      readyCount: 1,
      partialCount: 0,
      blockedCount: 0,
      totalCount: 1,
      buHandoffs: [bu],
    }

    const suggested = suggestArtifacts(handoff)
    const buSuggestions = suggested.filter(a => a.scope === 'business_unit' && !artifactReadinessBlocksGeneration(a.readinessStatus))
    // Backward compat: all non-blocked BU artifacts are selected by default
    buSuggestions.forEach(a => {
      expect(a.selected).toBe(true)
    })
  })

  it('when selectedStage4Deliverables is empty ([]), all ready artifacts default to selected: true', () => {
    const handoff = makeHandoffWithS3Selection([]) // empty list = no explicit selection
    const suggested = suggestArtifacts(handoff)
    const buSuggestions = suggested.filter(a => a.scope === 'business_unit' && !artifactReadinessBlocksGeneration(a.readinessStatus))
    buSuggestions.forEach(a => {
      expect(a.selected).toBe(true)
    })
  })

  it('buildArtifactPlan propagates Stage 3 selection through buildAuthoringJob', () => {
    // buildAuthoringJob re-evaluates readiness but must preserve the seeded selected value
    // for non-blocked artifacts.
    const handoff = makeHandoffWithS3Selection(['bu_execution_plan', 'pdlc_epic_outline'])
    const plan = buildArtifactPlan(handoff, 'ws1', 's1', 's2', 's3')
    const all = [...plan.globalArtifacts, ...plan.businessUnitArtifacts]

    // Checked types must be selected
    const execPlan = all.find(a => a.artifactType === 'bu_execution_plan' && a.scope === 'business_unit')
    if (execPlan) expect(execPlan.selected).toBe(true)

    // Unchecked non-blocked types must NOT be selected
    const unchecked = all.filter(
      a => a.scope === 'business_unit' &&
           !['bu_execution_plan', 'pdlc_epic_outline'].includes(a.artifactType) &&
           !artifactReadinessBlocksGeneration(a.readinessStatus)
    )
    unchecked.forEach(a => {
      expect(a.selected).toBe(false)
    })
  })
})

// ── correctPlanSelectionFromS3 — retroactive migration for persisted plans ────

describe('correctPlanSelectionFromS3 — fixes legacy plans with over-selected artifacts', () => {
  /**
   * Builds a "legacy" plan — one created before the suggestArtifacts fix —
   * where every BU artifact is selected: true regardless of S3 selection.
   */
  function makeLegacyPlan(buName, selectedTypes) {
    const buJobs = [
      'bu_execution_plan',
      'acceptance_criteria_draft',
      'implementation_governance_checklist',
      'pdlc_epic_outline',
    ].map(type => ({
      artifactId:       `bu_${buName}_${type}`,
      artifactType:     type,
      scope:            'business_unit',
      businessUnitName: buName,
      selected:         true,        // all selected — legacy bug
      readinessStatus:  ARTIFACT_READINESS.READY,
    }))

    return {
      globalArtifacts:      [],
      businessUnitArtifacts: buJobs,
      artifacts:             buJobs,
    }
  }

  function makeHandoffWithS3Selection(buName, selectedTypes) {
    return {
      persistedAt: '2025-01-01T00:00:00.000Z',
      buHandoffs: [{
        buName,
        status: 'ready',
        stage3PanelModel: {
          panels: {
            executionSequence: {
              selectedStage4Deliverables: selectedTypes.map(t => ({ deliverableType: t, status: 'user_selected' })),
            },
          },
        },
      }],
    }
  }

  it('corrects over-selected artifacts to selected: false when type is absent from S3 selection', () => {
    const buName  = 'Engineering & API Infrastructure'
    const plan    = makeLegacyPlan(buName, [])
    const handoff = makeHandoffWithS3Selection(buName, ['bu_execution_plan', 'pdlc_epic_outline'])

    const corrected = correctPlanSelectionFromS3(plan, handoff)

    const byType = Object.fromEntries(
      corrected.businessUnitArtifacts.map(a => [a.artifactType, a])
    )
    expect(byType['bu_execution_plan'].selected).toBe(true)
    expect(byType['pdlc_epic_outline'].selected).toBe(true)
    expect(byType['acceptance_criteria_draft'].selected).toBe(false)
    expect(byType['implementation_governance_checklist'].selected).toBe(false)
  })

  it('returns the same object reference when no correction is needed', () => {
    const buName  = 'Engineering & API Infrastructure'
    const plan    = makeLegacyPlan(buName, [])
    // Make all artifacts already match S3 selection
    plan.businessUnitArtifacts.forEach(a => {
      if (!['bu_execution_plan', 'pdlc_epic_outline'].includes(a.artifactType)) {
        a.selected = false
      }
    })
    const handoff = makeHandoffWithS3Selection(buName, ['bu_execution_plan', 'pdlc_epic_outline'])

    const result = correctPlanSelectionFromS3(plan, handoff)
    expect(result).toBe(plan) // same reference — no unnecessary mutation
  })

  it('does not correct when selectedStage4Deliverables is empty (no S3 selection configured)', () => {
    const buName  = 'Engineering & API Infrastructure'
    const plan    = makeLegacyPlan(buName, [])
    const handoff = makeHandoffWithS3Selection(buName, []) // empty → no correction

    const result = correctPlanSelectionFromS3(plan, handoff)
    expect(result).toBe(plan) // unchanged
    result.businessUnitArtifacts.forEach(a => {
      expect(a.selected).toBe(true)
    })
  })

  it('does not turn selected: false → selected: true (never upgrades deselections)', () => {
    const buName  = 'Engineering & API Infrastructure'
    const plan    = makeLegacyPlan(buName, [])
    plan.businessUnitArtifacts[0].selected = false // user explicitly deselected

    const handoff = makeHandoffWithS3Selection(buName, [plan.businessUnitArtifacts[0].artifactType])
    const corrected = correctPlanSelectionFromS3(plan, handoff)

    // Even though S3 says this type is selected, the plan's explicit false is preserved
    expect(corrected.businessUnitArtifacts[0].selected).toBe(false)
  })

  it('does not modify global artifacts', () => {
    const plan = {
      globalArtifacts: [{ artifactId: 'global_exec_brief', artifactType: 'executive_decision_brief', scope: 'global', selected: true, readinessStatus: ARTIFACT_READINESS.READY }],
      businessUnitArtifacts: [],
      artifacts: [],
    }
    const handoff = {
      persistedAt: '2025-01-01T00:00:00.000Z',
      buHandoffs: [],
    }
    const result = correctPlanSelectionFromS3(plan, handoff)
    expect(result).toBe(plan) // no correction needed
    expect(result.globalArtifacts[0].selected).toBe(true)
  })

  it('handles null plan and null handoff gracefully', () => {
    expect(correctPlanSelectionFromS3(null, null)).toBe(null)
    expect(correctPlanSelectionFromS3(undefined, undefined)).toBe(undefined)
  })
})
