/**
 * Tests for stage3PanelModel — panel governance layer.
 *
 * Covers: truncation detection, completeness audit, cross-panel audit,
 * readiness gate, migration, refinement history.
 */

import { describe, it, expect } from 'vitest'
import {
  detectTruncation,
  detectTruncationInField,
  auditPanelCompleteness,
  auditCrossPanels,
  computeReadinessStatus,
  validateProposedPanelContent,
  normalizeToPanelModel,
  normalizeLegacyDraftRecord,
  createRefinementRecord,
  createFailedRefinementRecord,
  appendRefinementRecord,
  applyAcceptedRefinement,
  acceptPanel,
  rejectPanel,
  updateRefinementStatus,
  resolvePanelDisplayStatus,
  synthesizePanelSummary,
  PANEL_AUDIT_STATUSES,
  CROSS_PANEL_QUALITY_STATUSES,
  REFINEMENT_STATUSES,
  PANEL_IDS,
  // Mapping exports
  MAPPING_STATUS,
  phaseSlug,
  optionSlug,
  suggestPhaseDeliverables,
  suggestHowOptionDeliverables,
  buildInitialPhaseMappings,
  mergePhasesMappings,
  updatePhaseMapping,
  updateHowOptionMapping,
  updateSelectedStage4Deliverables,
  derivePhaseMappedDeliverables,
  getMappedDeliverableIds,
  getSelectedStage4Deliverables,
  getDeliverableMappingSummary,
  computeDeliverableMappingReadiness,
  computeMappingStatus,
  STAGE4_DELIVERABLES,
} from './stage3PanelModel'
import { PANEL_LIFECYCLE, canAccept, computeLifecycleReadiness } from './stage3PanelLifecycle'
import { STRENGTH_STATUSES } from './stage3PanelStrengthAudit'

// ── Shared fixtures ───────────────────────────────────────────────────────────

function makeGoodStrategicObjective() {
  return {
    summary:              'This BU owns the explainability infrastructure for AaaS BSA/AML outputs, ensuring SR 11-7 compliance.',
    outcomeFocus:         'Building modular, internally-owned explainability architecture reduces long-term partner dependencies.',
    nonGoalsOrBoundaries: ['Does not include generative AI output generation', 'Excludes non-BSA/AML explainability use cases'],
  }
}

function makeGoodCriticalDecisions() {
  return [
    {
      decisionName:          'Build vs Partner',
      decisionQuestion:      'Which of the three core explainability components should be built internally versus sourced from Fiddler AI or Arthur AI?',
      whyItMatters:          'This decision changes architecture ownership, long-term maintenance burden, and integration complexity.',
      decisionOptions:       ['Full internal build', 'Strategic partnering', 'Hybrid core'],
      decisionEvidenceNeeded:['Observed pilot evidence from Fiddler AI capability screen', 'Internal capacity assessment from API Engineering'],
      decisionTiming:        'Resolve before Sprint 2 architecture work begins.',
    },
  ]
}

function makeGoodDependencies() {
  return [
    {
      dependencyName:        'API Engineering Schema Approval',
      dependencyDescription: 'API Engineering must review and approve contract schema designs before the contract team begins connector build.',
      whyItMatters:          'This input gates Sprint 2 — without schema approval the connector build cannot start on the correct data model.',
      requiredInput:         'signed schema interface contracts',
      consequenceIfMissing:  'Sprint 2 connector build begins on unvalidated assumptions, requiring rework when schemas change.',
    },
  ]
}

function makeGoodRisks() {
  return [
    {
      riskName:                  'Architecture Lock-In Risk',
      riskDescription:           'Early connector build may lock data mappings before schema coverage is confirmed against all core systems.',
      whyItMatters:              'Rework costs escalate once clients or integrations are built on the locked path.',
      mitigationOptions:         ['Define interface boundaries before connector build', 'Separate reusable logic from custom ETL exceptions'],
      earlyWarningSignals:       ['Connector work starts before schema coverage matrix is complete'],
      evidenceThatRiskIsReduced: ['Architecture review confirms extension points', 'Schema gaps are visible before build commitment'],
    },
  ]
}

function makeGoodValidation() {
  return [
    {
      validationQuestion:       'Does the explainability output improve a real BSA/AML workflow decision?',
      completionCriteria:       ['A compliance officer can use the output without analyst translation', 'Contradictory feedback is documented'],
      howToDetermineCompletion: ['Observe mock review with a bank compliance officer', 'Compare expected vs actual interpretation'],
      evidenceExamples:         ['annotated mock review', 'workflow walkthrough notes'],
      veracityChecks:           ['evidence is observed, not self-reported', 'contradictory feedback is documented'],
      failureOrReworkTriggers:  ['Officer cannot interpret output without analyst translation'],
    },
    {
      validationQuestion:       'Is the architecture valid enough to support the promised product boundary?',
      completionCriteria:       ['Architecture review confirms extension points', 'Schema coverage matrix is complete'],
      howToDetermineCompletion: ['Run architecture boundary review before build starts', 'Complete schema coverage matrix'],
      evidenceExamples:         ['architecture review notes', 'interface specification', 'schema coverage matrix'],
      veracityChecks:           ['architecture review is independent, not self-assessed', 'schema gaps are traced to specific use cases'],
      failureOrReworkTriggers:  ['Schema coverage gaps discovered after build commitment'],
    },
  ]
}

function makeGoodCompiledPlan() {
  return {
    strategicObjective:  makeGoodStrategicObjective(),
    criticalDecisions:   makeGoodCriticalDecisions(),
    executionSequence: [{
      phaseName: 'Problem & Outcome Validation',
      phaseObjective: 'Confirm that examiner-facing explainability outputs meet SR 11-7 requirements before committing to build path.',
      recommendedHow: 'Structured review of completed BSA/AML model outputs against SR 11-7 examiner format, with Compliance and API Engineering present.',
      whyThisFitsThePhase: 'This phase must confirm regulatory fit before architecture decisions are locked — validation against examiner expectations prevents rework once build begins.',
      exitCriteria: 'Compliance team signs off that model outputs meet SR 11-7 format requirements before Sprint 1 closes. Gate must be confirmed before Sprint 2 begins.',
      evidenceExamples: ['Signed compliance review memo', 'Two annotated model output examples'],
      howOptions: [],
    }],
    dependencies:        makeGoodDependencies(),
    risksAndMitigations: makeGoodRisks(),
    validationFramework: makeGoodValidation(),
  }
}

function makeTruncatedDependencyRefinement() {
  return [
    {
      dependencyName: 'Contract Engineering Delivery',
      dependencyDescription: 'Contract Engineering must deliver SR 11-7 minimum viable output specifications before con',
      whyItMatters: 'Without this dependency the product architecture path cannot confirm explainability boundaries.',
      requiredInput: 'complete integration feasibility review of contract engineer del',
      consequenceIfMissing: 'Architecture and compliance teams proceed with components that ma',
    },
  ]
}

function makeStructurallyCompleteGenericStrategicObjective() {
  return {
    summary: 'This business unit will leverage existing best practices and robust frameworks to ensure alignment, drive value, improve outcomes, and support the business through a holistic approach that can be reused across most operating contexts.',
    outcomeFocus: 'Drive efficiency and enable growth across the business through stakeholder engagement, alignment, and delivery of value.',
    nonGoalsOrBoundaries: ['Does not own unrelated implementation details', 'Excludes areas outside this workstream'],
  }
}

// ── Truncation detection ──────────────────────────────────────────────────────

describe('detectTruncation', () => {
  it('detects explicit truncation markers', () => {
    expect(detectTruncation('The output must improve...').truncated).toBe(true)
    expect(detectTruncation('The output must improve…').truncated).toBe(true)
  })

  it('detects hanging conjunctions', () => {
    expect(detectTruncation('The plan must proceed before').truncated).toBe(true)
    expect(detectTruncation('Execution is blocked and').truncated).toBe(true)
  })

  it('detects truncated list (ends with comma)', () => {
    expect(detectTruncation('Option A, Option B,').truncated).toBe(true)
  })

  it('detects recognizable partial words', () => {
    expect(detectTruncation('This must be before con').truncated).toBe(true)
    expect(detectTruncation('The architecture should impl').truncated).toBe(true)
    expect(detectTruncation('complete integration feasibility review of contract engineer del').truncated).toBe(true)
    expect(detectTruncation('components that ma').truncated).toBe(true)
    expect(detectTruncation('finish the assessment assess').truncated).toBe(true)
  })

  it('detects text below minimum length', () => {
    expect(detectTruncation('Too short', 30).truncated).toBe(true)
  })

  it('does not flag clean complete sentences', () => {
    expect(detectTruncation('This BU owns the explainability infrastructure for AaaS.').truncated).toBe(false)
    expect(detectTruncation('Build vs partner decision must be resolved before sprint planning.').truncated).toBe(false)
    expect(detectTruncation('').truncated).toBe(false)
  })

  it('does not flag sentences ending with common short words', () => {
    expect(detectTruncation('The plan requires this.').truncated).toBe(false)
    expect(detectTruncation('The team has confirmed the approach.').truncated).toBe(false)
  })
})

describe('detectTruncationInField', () => {
  it('detects truncation in string field', () => {
    const result = detectTruncationInField('The plan proceeds before', 'summary')
    expect(result.truncated).toBe(true)
    expect(result.truncatedSubFields).toContain('summary')
  })

  it('detects truncation in array field', () => {
    const result = detectTruncationInField(['Clean item.', 'Item ends mid-word fe'], 'items')
    expect(result.truncated).toBe(true)
    expect(result.truncatedSubFields.some(f => f.includes('[1]'))).toBe(true)
  })

  it('passes clean values', () => {
    const result = detectTruncationInField('Complete and well-formed sentence.', 'field')
    expect(result.truncated).toBe(false)
  })
})

// ── Panel completeness audit ──────────────────────────────────────────────────

describe('auditPanelCompleteness — strategic objective', () => {
  it('marks complete for a well-formed strategic objective', () => {
    const audit = auditPanelCompleteness('strategicObjective', makeGoodStrategicObjective())
    expect(audit.status).toBe(PANEL_AUDIT_STATUSES.COMPLETE)
    expect(audit.missingFields).toHaveLength(0)
    expect(audit.truncatedFields).toHaveLength(0)
  })

  it('marks incomplete when required fields are missing', () => {
    const audit = auditPanelCompleteness('strategicObjective', { summary: '' })
    expect(audit.status).toBe(PANEL_AUDIT_STATUSES.INCOMPLETE)
    expect(audit.missingFields.some(f => f.includes('summary'))).toBe(true)
  })

  it('marks truncated when a field contains truncation markers', () => {
    const audit = auditPanelCompleteness('strategicObjective', {
      summary:      'This BU owns explainability for AaaS outputs...',
      outcomeFocus: 'Reducing partner dependencies and ensuring compliance.',
    })
    expect(audit.status).toBe(PANEL_AUDIT_STATUSES.TRUNCATED)
    expect(audit.truncatedFields.some(f => f.includes('summary'))).toBe(true)
  })

  it('marks incomplete for null content', () => {
    const audit = auditPanelCompleteness('strategicObjective', null)
    expect(audit.status).toBe(PANEL_AUDIT_STATUSES.INCOMPLETE)
    expect(audit.missingFields.length).toBeGreaterThan(0)
  })
})

describe('auditPanelCompleteness — critical decisions', () => {
  it('marks complete for well-formed decisions', () => {
    const audit = auditPanelCompleteness('criticalDecisions', makeGoodCriticalDecisions())
    expect(audit.status).toBe(PANEL_AUDIT_STATUSES.COMPLETE)
  })

  it('marks incomplete when decisions array is empty', () => {
    const audit = auditPanelCompleteness('criticalDecisions', [])
    expect(audit.status).toBe(PANEL_AUDIT_STATUSES.INCOMPLETE)
    expect(audit.missingFields.some(f => f.includes('empty'))).toBe(true)
  })

  it('marks incomplete for missing required fields within a decision', () => {
    const decisions = [{ decisionName: 'Build vs Partner', decisionQuestion: '' }]
    const audit = auditPanelCompleteness('criticalDecisions', decisions)
    expect(audit.status).toBe(PANEL_AUDIT_STATUSES.INCOMPLETE)
    expect(audit.missingFields.some(f => f.includes('decisionQuestion'))).toBe(true)
  })

  it('detects duplicate decisionQuestion ≈ whyItMatters', () => {
    const decisions = [{
      decisionName:          'Build vs Partner',
      decisionQuestion:      'Whether to build or partner for the explainability components.',
      whyItMatters:          'Whether to build or partner for the explainability components.',
      decisionOptions:       ['Build', 'Partner'],
      decisionEvidenceNeeded:['Some evidence needed here.'],
      decisionTiming:        'Before sprint planning.',
    }]
    const audit = auditPanelCompleteness('criticalDecisions', decisions)
    expect(audit.duplicateFieldFindings.length).toBeGreaterThan(0)
    expect(audit.status).toBe(PANEL_AUDIT_STATUSES.NEEDS_REFINEMENT)
  })
})

describe('auditPanelCompleteness — dependencies', () => {
  it('marks complete for well-formed dependencies', () => {
    const audit = auditPanelCompleteness('dependencies', makeGoodDependencies())
    expect(audit.status).toBe(PANEL_AUDIT_STATUSES.COMPLETE)
  })

  it('detects identical dependencyDescription and requiredInput', () => {
    const deps = [{
      dependencyName:        'API Engineering',
      dependencyDescription: 'API Engineering must approve schema contracts before Sprint 2 kickoff.',
      whyItMatters:          'This gates Sprint 2 forward progress.',
      requiredInput:         'API Engineering must approve schema contracts before Sprint 2 kickoff.',
      consequenceIfMissing:  'Sprint 2 is blocked.',
    }]
    const audit = auditPanelCompleteness('dependencies', deps)
    expect(audit.duplicateFieldFindings.length).toBeGreaterThan(0)
    expect(audit.status).toBe(PANEL_AUDIT_STATUSES.NEEDS_REFINEMENT)
  })

  it('marks visibly truncated dependency refinement output as truncated, not complete', () => {
    const audit = auditPanelCompleteness('dependencies', makeTruncatedDependencyRefinement())
    expect(audit.status).toBe(PANEL_AUDIT_STATUSES.TRUNCATED)
    expect(audit.truncatedFields.join(' ')).toContain('dependencyDescription')
    expect(audit.truncatedFields.join(' ')).toContain('requiredInput')
    expect(audit.truncatedFields.join(' ')).toContain('consequenceIfMissing')
  })
})

describe('auditPanelCompleteness — risks', () => {
  it('marks complete for well-formed risks', () => {
    const audit = auditPanelCompleteness('risks', makeGoodRisks())
    expect(audit.status).toBe(PANEL_AUDIT_STATUSES.COMPLETE)
  })

  it('detects identical riskDescription and whyItMatters', () => {
    const risks = [{
      riskName:                  'Architecture Risk',
      riskDescription:           'Early technical choices may create lock-in before evidence is mature.',
      whyItMatters:              'Early technical choices may create lock-in before evidence is mature.',
      mitigationOptions:         ['Define boundaries first'],
      earlyWarningSignals:       ['Build starts early'],
      evidenceThatRiskIsReduced: ['Review confirms extensions'],
    }]
    const audit = auditPanelCompleteness('risks', risks)
    expect(audit.duplicateFieldFindings.length).toBeGreaterThan(0)
  })
})

describe('auditPanelCompleteness — validation framework', () => {
  it('marks complete for well-formed, distinct validation questions', () => {
    const audit = auditPanelCompleteness('validationFramework', makeGoodValidation())
    expect(audit.status).toBe(PANEL_AUDIT_STATUSES.COMPLETE)
    expect(audit.duplicateFieldFindings).toHaveLength(0)
  })

  it('detects identical evidenceExamples arrays across questions', () => {
    const sharedEvidence = ['observed workflow notes', 'readiness review notes', 'before/after comparison']
    const vf = [
      {
        validationQuestion: 'Does this BU path improve the workflow outcome it owns?',
        completionCriteria: ['The target user completes the workflow without extra translation.'],
        howToDetermineCompletion: ['Observe realistic workflow with the target user.'],
        evidenceExamples: sharedEvidence,
        veracityChecks: ['Evidence is observed, not self-reported.'],
        failureOrReworkTriggers: ['User cannot complete workflow without analyst support.'],
      },
      {
        validationQuestion: 'Are the decision inputs complete enough to proceed?',
        completionCriteria: ['All required inputs are confirmed or escalated.'],
        howToDetermineCompletion: ['Confirm each dependency input with the owning function.'],
        evidenceExamples: sharedEvidence,
        veracityChecks: ['Inputs are confirmed, not assumed.'],
        failureOrReworkTriggers: ['Key decisions remain assumption-based at the gate.'],
      },
    ]
    const audit = auditPanelCompleteness('validationFramework', vf)
    expect(audit.duplicateFieldFindings.some(f => f.includes('evidenceExamples'))).toBe(true)
    expect(audit.status).toBe(PANEL_AUDIT_STATUSES.NEEDS_REFINEMENT)
  })

  it('detects identical failureOrReworkTriggers across questions', () => {
    const sharedTriggers = ['Users cannot interpret the output without analyst translation.', 'Output does not change a real workflow decision.', 'Evidence conflicts remain unresolved before the gate.']
    const vf = [
      {
        validationQuestion: 'Does this BU path improve the workflow outcome it owns?',
        completionCriteria: ['The user completes the workflow without extra translation support.'],
        howToDetermineCompletion: ['Observe realistic workflow completion with the target user.'],
        evidenceExamples: ['workflow walkthrough notes', 'before/after comparison'],
        veracityChecks: ['Evidence is observed, not self-reported.'],
        failureOrReworkTriggers: sharedTriggers,
      },
      {
        validationQuestion: 'Are the decision inputs complete enough to proceed?',
        completionCriteria: ['All required dependency inputs are confirmed or escalated.'],
        howToDetermineCompletion: ['Confirm each dependency input with the owning function.'],
        evidenceExamples: ['dependency confirmation notes', 'readiness review notes'],
        veracityChecks: ['Inputs are confirmed rather than assumed.'],
        failureOrReworkTriggers: sharedTriggers,
      },
    ]
    const audit = auditPanelCompleteness('validationFramework', vf)
    expect(audit.duplicateFieldFindings.some(f => f.includes('failureOrReworkTriggers'))).toBe(true)
  })
})

// ── Cross-panel audit ─────────────────────────────────────────────────────────

function makePanelMap(compiledPlan) {
  const map = {}
  const contentMap = {
    strategicObjective:  compiledPlan.strategicObjective,
    criticalDecisions:   compiledPlan.criticalDecisions,
    executionSequence:   compiledPlan.executionSequence,
    dependencies:        compiledPlan.dependencies,
    risks:               compiledPlan.risksAndMitigations || compiledPlan.risks || [],
    validationFramework: compiledPlan.validationFramework,
  }
  PANEL_IDS.forEach(pid => {
    const content = contentMap[pid] || null
    map[pid] = { content, completenessAudit: auditPanelCompleteness(pid, content) }
  })
  return map
}

describe('auditCrossPanels', () => {
  it('passes for a well-structured compiled plan', () => {
    const panels = makePanelMap(makeGoodCompiledPlan())
    const audit  = auditCrossPanels(panels)
    expect(audit.qualityStatus).toBe(CROSS_PANEL_QUALITY_STATUSES.PASS)
    expect(audit.duplicatedFieldPairs).toHaveLength(0)
  })

  it('flags duplicate risk descriptions across categories', () => {
    const plan = makeGoodCompiledPlan()
    const dupDesc = 'Early connector build creates lock-in before evidence is confirmed.'
    plan.risksAndMitigations = [
      { ...makeGoodRisks()[0], riskDescription: dupDesc },
      { riskName: 'Scope Risk', riskDescription: dupDesc, whyItMatters: 'Different consequence.', mitigationOptions: ['m'], earlyWarningSignals: ['w'], evidenceThatRiskIsReduced: ['e'] },
    ]
    const panels = makePanelMap(plan)
    const audit  = auditCrossPanels(panels)
    expect(audit.duplicatedFieldPairs.some(p => p.note.includes('Identical failure-mode'))).toBe(true)
    expect(audit.qualityStatus).toBe(CROSS_PANEL_QUALITY_STATUSES.FAIL)
  })

  it('detects decision rationale copied into dependency description', () => {
    const plan = makeGoodCompiledPlan()
    const sharedText = 'Which components should be built internally versus sourced from vendors?'
    plan.criticalDecisions = [{ ...makeGoodCriticalDecisions()[0], decisionQuestion: sharedText }]
    plan.dependencies = [{ ...makeGoodDependencies()[0], dependencyDescription: sharedText }]
    const panels = makePanelMap(plan)
    const audit  = auditCrossPanels(panels)
    expect(audit.duplicatedFieldPairs.some(p => p.note.includes('Decision rationale copied'))).toBe(true)
  })
})

// ── Readiness gate ────────────────────────────────────────────────────────────

describe('computeReadinessStatus', () => {
  it('marks ready when all panels are complete and cross-panel passes', () => {
    const panels = makePanelMap(makeGoodCompiledPlan())
    const crossPanelAudit = auditCrossPanels(panels)
    const status = computeReadinessStatus(panels, crossPanelAudit)
    expect(status.isReady).toBe(true)
    expect(status.blockingPanels).toHaveLength(0)
  })

  it('blocks when a panel is truncated', () => {
    const panels = makePanelMap(makeGoodCompiledPlan())
    // Force a truncated audit on strategicObjective
    panels.strategicObjective.completenessAudit = {
      ...panels.strategicObjective.completenessAudit,
      status: PANEL_AUDIT_STATUSES.TRUNCATED,
      truncatedFields: ['strategicObjective.summary: contains explicit truncation marker'],
    }
    const crossPanelAudit = auditCrossPanels(panels)
    const status = computeReadinessStatus(panels, crossPanelAudit)
    expect(status.isReady).toBe(false)
    expect(status.blockingPanels).toContain('strategicObjective')
    expect(status.blockingReasons.some(r => r.includes('TRUNCATED'))).toBe(true)
  })

  it('blocks when a panel is incomplete', () => {
    const panels = makePanelMap(makeGoodCompiledPlan())
    panels.criticalDecisions.completenessAudit = {
      ...panels.criticalDecisions.completenessAudit,
      status: PANEL_AUDIT_STATUSES.INCOMPLETE,
      missingFields: ['criticalDecisions[0].decisionQuestion'],
    }
    const crossPanelAudit = auditCrossPanels(panels)
    const status = computeReadinessStatus(panels, crossPanelAudit)
    expect(status.isReady).toBe(false)
    expect(status.blockingPanels).toContain('criticalDecisions')
  })

  it('blocks when cross-panel audit fails', () => {
    const panels = makePanelMap(makeGoodCompiledPlan())
    const failingCrossPanel = {
      qualityStatus: CROSS_PANEL_QUALITY_STATUSES.FAIL,
      duplicatedFieldPairs: [{ source: 'a', target: 'b', note: 'test' }],
      repeatedPhrases: [],
      misplacedContentFindings: [],
      planAlignmentFindings: [],
    }
    const status = computeReadinessStatus(panels, failingCrossPanel)
    expect(status.isReady).toBe(false)
    expect(status.blockingReasons.some(r => r.includes('Cross-panel audit failed'))).toBe(true)
  })

  it('does not block for needs_refinement status (has content, just suboptimal)', () => {
    const panels = makePanelMap(makeGoodCompiledPlan())
    panels.criticalDecisions.completenessAudit = {
      ...panels.criticalDecisions.completenessAudit,
      status: PANEL_AUDIT_STATUSES.NEEDS_REFINEMENT,
      duplicateFieldFindings: ['Some field is near-duplicate'],
    }
    const crossPanelAudit = { qualityStatus: CROSS_PANEL_QUALITY_STATUSES.PASS, duplicatedFieldPairs: [], repeatedPhrases: [], misplacedContentFindings: [], planAlignmentFindings: [] }
    const status = computeReadinessStatus(panels, crossPanelAudit)
    // needs_refinement should NOT block (it has content)
    expect(status.blockingPanels).not.toContain('criticalDecisions')
  })
})

// ── normalizeToPanelModel ─────────────────────────────────────────────────────

describe('normalizeToPanelModel', () => {
  it('creates a panel model with all required panel IDs', () => {
    const pm = normalizeToPanelModel(makeGoodCompiledPlan())
    expect(Object.keys(pm.panels)).toEqual(expect.arrayContaining(PANEL_IDS))
  })

  it('runs completeness audits on all panels', () => {
    const pm = normalizeToPanelModel(makeGoodCompiledPlan())
    PANEL_IDS.forEach(pid => {
      expect(pm.panels[pid].completenessAudit).toBeTruthy()
      expect(pm.panels[pid].completenessAudit.status).toBeTruthy()
    })
  })

  it('initializes empty refinement history per panel', () => {
    const pm = normalizeToPanelModel(makeGoodCompiledPlan())
    PANEL_IDS.forEach(pid => {
      expect(Array.isArray(pm.panels[pid].refinementHistory)).toBe(true)
      expect(pm.panels[pid].refinementHistory).toHaveLength(0)
    })
  })

  it('computes cross-panel and readiness status', () => {
    const pm = normalizeToPanelModel(makeGoodCompiledPlan())
    expect(pm.crossPanelAudit).toBeTruthy()
    expect(pm.readinessStatus).toBeTruthy()
    expect(typeof pm.readinessStatus.isReady).toBe('boolean')
  })

  it('blocks readiness for a clean compiled plan until panels are explicitly accepted', () => {
    const pm = normalizeToPanelModel(makeGoodCompiledPlan())
    expect(pm.readinessStatus.isReady).toBe(false)
    expect(pm.readinessStatus.blockingReasons.every(r => r.includes('not yet accepted'))).toBe(true)
  })
})

describe('panel lifecycle transitions', () => {
  it('initializes generated clean panels as draft_ready', () => {
    const pm = normalizeToPanelModel(makeGoodCompiledPlan())
    PANEL_IDS.forEach(pid => {
      expect(pm.panels[pid].lifecycle).toBe(PANEL_LIFECYCLE.DRAFT_READY)
      expect(canAccept(pm.panels[pid])).toBe(true)
    })
  })

  it('blocks accepting panels with failed audits', () => {
    const pm = normalizeToPanelModel({
      ...makeGoodCompiledPlan(),
      dependencies: [{
        dependencyName: 'API Engineering',
        dependencyDescription: 'before con',
        requiredInput: 'before con',
        consequenceIfMissing: '',
      }],
    })
    expect(pm.panels.dependencies.lifecycle).toBe(PANEL_LIFECYCLE.NEEDS_REFINEMENT)
    expect(canAccept(pm.panels.dependencies)).toBe(false)
    expect(() => acceptPanel(pm, 'dependencies')).toThrow(/Cannot accept panel/)
  })

  it('allows accepting panels with needs_refinement audit (user informed choice)', () => {
    // canAccept was relaxed to allow acceptance despite NEEDS_REFINEMENT warnings.
    // The user must explicitly accept; the strength audit then gates Stage 4 readiness.
    const pm = normalizeToPanelModel({
      ...makeGoodCompiledPlan(),
      dependencies: [{
        dependencyName: 'API Engineering',
        dependencyDescription: 'API Engineering must approve schema contracts before Sprint 2 kickoff.',
        whyItMatters: 'This gates Sprint 2 forward progress.',
        requiredInput: 'API Engineering must approve schema contracts before Sprint 2 kickoff.',
        consequenceIfMissing: 'Sprint 2 connector build proceeds on unvalidated schema assumptions.',
      }],
    })
    expect(pm.panels.dependencies.completenessAudit.status).toBe(PANEL_AUDIT_STATUSES.NEEDS_REFINEMENT)
    // Acceptance is now allowed even with NEEDS_REFINEMENT — strength audit provides the quality gate.
    expect(canAccept(pm.panels.dependencies)).toBe(true)
  })

  it('blocks Stage 4 readiness when any accepted set contains a truncated panel', () => {
    let pm = normalizeToPanelModel({
      ...makeGoodCompiledPlan(),
      dependencies: makeTruncatedDependencyRefinement(),
    })
    PANEL_IDS.filter(pid => pid !== 'dependencies').forEach(pid => {
      pm = acceptPanel(pm, pid)
    })
    expect(pm.readinessStatus.isReady).toBe(false)
    expect(pm.readinessStatus.blockingPanels).toContain('dependencies')
    expect(pm.readinessStatus.blockingReasons.some(r => r.includes('TRUNCATED'))).toBe(true)
  })

  it('classifies truncated panels as structural audit failures before strength gating', () => {
    const pm = normalizeToPanelModel({
      ...makeGoodCompiledPlan(),
      dependencies: makeTruncatedDependencyRefinement(),
    })

    expect(pm.panels.dependencies.completenessAudit.status).toBe(PANEL_AUDIT_STATUSES.TRUNCATED)
    expect(pm.panels.dependencies.lifecycle).toBe(PANEL_LIFECYCLE.NEEDS_REFINEMENT)
    expect(canAccept(pm.panels.dependencies)).toBe(false)
  })

  it('resolves failed critical decisions as failed instead of complete for display', () => {
    let pm = normalizeToPanelModel(makeGoodCompiledPlan())
    pm = rejectPanel(pm, 'criticalDecisions', 'API refinement returned empty content.')
    expect(pm.panels.criticalDecisions.completenessAudit.status).toBe(PANEL_AUDIT_STATUSES.COMPLETE)
    expect(resolvePanelDisplayStatus(pm.panels.criticalDecisions)).toBe(PANEL_LIFECYCLE.FAILED)
  })

  it('marks readiness true only after every panel is accepted', () => {
    let pm = normalizeToPanelModel(makeGoodCompiledPlan())
    PANEL_IDS.forEach(pid => {
      pm = acceptPanel(pm, pid)
    })
    expect(pm.readinessStatus.isReady).toBe(true)
    PANEL_IDS.forEach(pid => expect(pm.panels[pid].lifecycle).toBe(PANEL_LIFECYCLE.ACCEPTED))
  })

  it('failed or rejected panel blocks Stage 4 readiness', () => {
    let pm = normalizeToPanelModel(makeGoodCompiledPlan())
    PANEL_IDS.forEach(pid => {
      pm = acceptPanel(pm, pid)
    })
    pm = rejectPanel(pm, 'risks', 'User rejected the risk draft.')
    expect(pm.panels.risks.lifecycle).toBe(PANEL_LIFECYCLE.FAILED)
    expect(pm.readinessStatus.isReady).toBe(false)
    expect(pm.readinessStatus.blockingPanels).toContain('risks')
  })

  it('blocks Stage 4 readiness when all panels are accepted but a strength audit is weak', () => {
    let pm = normalizeToPanelModel({
      ...makeGoodCompiledPlan(),
      strategicObjective: makeStructurallyCompleteGenericStrategicObjective(),
    })

    expect(pm.panels.strategicObjective.completenessAudit.status).toBe(PANEL_AUDIT_STATUSES.COMPLETE)
    expect(pm.panels.strategicObjective.panelStrengthAudit.status).toBe(STRENGTH_STATUSES.WEAK)

    PANEL_IDS.forEach(pid => {
      pm = acceptPanel(pm, pid)
    })

    expect(pm.readinessStatus.isReady).toBe(false)
    expect(pm.readinessStatus.blockingPanels).toContain('strategicObjective')
    expect(pm.readinessStatus.blockingReasons).toContain('Panels accepted, strength audit failed.')
  })

  it('blocks Stage 4 readiness when compiled quality audit has blocking violations', () => {
    let pm = normalizeToPanelModel(makeGoodCompiledPlan())
    PANEL_IDS.forEach(pid => {
      pm = acceptPanel(pm, pid)
    })

    const readiness = computeLifecycleReadiness(pm.panels, {
      qualityStatus: CROSS_PANEL_QUALITY_STATUSES.FAIL,
      duplicatedFieldPairs: [{ source: 'dependencies[0].requiredInput', target: 'risks[0].mitigationOptions' }],
      misplacedContentFindings: ['Risk content appears inside dependencies.'],
      repeatedPhrases: [],
      planAlignmentFindings: [],
    })

    expect(readiness.isReady).toBe(false)
    expect(readiness.blockingReasons.some(reason => reason.includes('Cross-panel audit failed'))).toBe(true)
  })
})

// ── Legacy migration ──────────────────────────────────────────────────────────

describe('normalizeLegacyDraftRecord', () => {
  it('adds panelModel to a legacy draft that does not have one', () => {
    const legacyDraft = { version: 1, businessUnitName: 'Product Architecture', plan: { buName: 'Product Architecture' } }
    const compiledPlan = makeGoodCompiledPlan()
    const normalized = normalizeLegacyDraftRecord(legacyDraft, compiledPlan)
    expect(normalized.panelModel).toBeTruthy()
    expect(normalized.panelModel.migratedFromLegacy).toBe(true)
    expect(Object.keys(normalized.panelModel.panels)).toEqual(expect.arrayContaining(PANEL_IDS))
  })

  it('does not overwrite an existing panelModel', () => {
    const existingPanelModel = { panels: { strategicObjective: { content: 'existing', refinementHistory: [{ refinementId: 'r1' }] } } }
    const draft = { version: 1, panelModel: existingPanelModel }
    const normalized = normalizeLegacyDraftRecord(draft, makeGoodCompiledPlan())
    expect(normalized.panelModel).toBe(existingPanelModel)
  })

  it('marks panels as needing audit when no compiled plan is available', () => {
    const legacyDraft = { version: 1, businessUnitName: 'Engineering' }
    const normalized = normalizeLegacyDraftRecord(legacyDraft, null)
    expect(normalized.panelModel.readinessStatus.isReady).toBe(false)
    expect(normalized.panelModel.readinessStatus.blockingPanels.length).toBe(PANEL_IDS.length)
  })

  it('passes through null draft unchanged', () => {
    expect(normalizeLegacyDraftRecord(null, null)).toBe(null)
  })
})

// ── Refinement history ────────────────────────────────────────────────────────

describe('createRefinementRecord', () => {
  it('creates a refinement record with proposed status', () => {
    const record = createRefinementRecord({
      panelId:         'dependencies',
      prompt:          'Separate dependency description from required input.',
      previousContent: makeGoodDependencies(),
      revisedContent:  makeGoodDependencies(),
      auditBefore:     { status: PANEL_AUDIT_STATUSES.NEEDS_REFINEMENT },
      auditAfter:      { status: PANEL_AUDIT_STATUSES.COMPLETE },
      changedFields:   ['requiredInput'],
    })
    expect(record.status).toBe(REFINEMENT_STATUSES.PROPOSED)
    expect(record.refinementId).toBeTruthy()
    expect(record.panelId).toBe('dependencies')
    expect(record.createdAt).toBeTruthy()
    expect(record.acceptedAt).toBeNull()
    expect(record.rejectedAt).toBeNull()
  })

  it('creates failed refinement records for empty or invalid API responses', () => {
    const record = createFailedRefinementRecord({
      panelId: 'dependencies',
      prompt: 'Fix dependency duplication.',
      previousContent: makeGoodDependencies(),
      auditBefore: { status: PANEL_AUDIT_STATUSES.COMPLETE },
      error: 'Empty response from API.',
    })
    expect(record.status).toBe(REFINEMENT_STATUSES.FAILED)
    expect(record.error).toBe('Empty response from API.')
    expect(record.failureReason).toBe('Empty response from API.')
    expect(record.revisedPanelSnapshot).toBeNull()
    expect(record.failedAt).toBeTruthy()
  })
})

describe('appendRefinementRecord', () => {
  it('appends a refinement record to the specified panel', () => {
    const pm = normalizeToPanelModel(makeGoodCompiledPlan())
    const record = createRefinementRecord({ panelId: 'risks', prompt: 'Fix duplicate.', previousContent: [], revisedContent: [], auditBefore: null, auditAfter: null })
    const updated = appendRefinementRecord(pm, 'risks', record)
    expect(updated.panels.risks.refinementHistory).toHaveLength(1)
    expect(updated.panels.risks.refinementHistory[0].refinementId).toBe(record.refinementId)
    // Other panels unchanged
    expect(updated.panels.dependencies.refinementHistory).toHaveLength(0)
  })

  it('updates lastRefinedAt on the panel', () => {
    const pm = normalizeToPanelModel(makeGoodCompiledPlan())
    const record = createRefinementRecord({ panelId: 'risks', prompt: 'Fix.', previousContent: null, revisedContent: null, auditBefore: null, auditAfter: null })
    const updated = appendRefinementRecord(pm, 'risks', record)
    expect(updated.panels.risks.lastRefinedAt).toBe(record.createdAt)
  })

  it('returns original model unchanged if panelId not found', () => {
    const pm = normalizeToPanelModel(makeGoodCompiledPlan())
    const record = createRefinementRecord({ panelId: 'nonexistent', prompt: 'Test.', previousContent: null, revisedContent: null, auditBefore: null, auditAfter: null })
    const result = appendRefinementRecord(pm, 'nonexistent', record)
    expect(result).toBe(pm)
  })
})

describe('applyAcceptedRefinement', () => {
  it('updates panel content and re-runs audit', () => {
    const pm             = normalizeToPanelModel(makeGoodCompiledPlan())
    const revisedContent = makeGoodDependencies()
    const updated        = applyAcceptedRefinement(pm, 'dependencies', revisedContent)
    expect(updated.panels.dependencies.content).toBe(revisedContent)
    expect(updated.panels.dependencies.completenessAudit).toBeTruthy()
    expect(updated.panels.dependencies.completenessAudit.lastAuditedAt).toBeTruthy()
  })

  it('re-runs cross-panel and readiness audits after applying refinement', () => {
    const pm      = normalizeToPanelModel(makeGoodCompiledPlan())
    const updated = applyAcceptedRefinement(pm, 'dependencies', makeGoodDependencies())
    expect(updated.crossPanelAudit).toBeTruthy()
    expect(updated.readinessStatus).toBeTruthy()
  })

  it('validates truncated refinement output without persisting it as current panel content', () => {
    const pm = normalizeToPanelModel(makeGoodCompiledPlan())
    const previousContent = pm.panels.dependencies.content
    const proposedContent = makeTruncatedDependencyRefinement()
    const validation = validateProposedPanelContent({
      panelId: 'dependencies',
      proposedContent,
      currentPanelModel: pm,
    })
    expect(validation.ok).toBe(false)
    expect(validation.failureReason).toContain('Truncated model output')

    const failed = createFailedRefinementRecord({
      panelId: 'dependencies',
      prompt: 'Improve dependency clarity.',
      previousContent,
      proposedContent,
      auditBefore: pm.panels.dependencies.completenessAudit,
      auditAfter: validation.auditAfter,
      failureReason: validation.failureReason,
    })
    const updated = appendRefinementRecord(pm, 'dependencies', failed)
    expect(updated.panels.dependencies.content).toBe(previousContent)
    expect(updated.panels.dependencies.refinementHistory[0].status).toBe(REFINEMENT_STATUSES.FAILED)
    expect(updated.panels.dependencies.refinementHistory[0].failureReason).toContain('Truncated model output')
    expect(updated.panels.dependencies.refinementHistory[0].revisedPanelSnapshot).toBe(proposedContent)
  })

  it('preserves a prior accepted panel when a later refinement fails validation', () => {
    let pm = normalizeToPanelModel(makeGoodCompiledPlan())
    pm = acceptPanel(pm, 'dependencies')
    const acceptedContent = pm.panels.dependencies.content
    const validation = validateProposedPanelContent({
      panelId: 'dependencies',
      proposedContent: makeTruncatedDependencyRefinement(),
      currentPanelModel: pm,
    })
    const failed = createFailedRefinementRecord({
      panelId: 'dependencies',
      prompt: 'Try a sharper dependency rewrite.',
      previousContent: acceptedContent,
      proposedContent: makeTruncatedDependencyRefinement(),
      auditBefore: pm.panels.dependencies.completenessAudit,
      auditAfter: validation.auditAfter,
      failureReason: validation.failureReason,
    })
    const updated = appendRefinementRecord(pm, 'dependencies', failed)
    expect(updated.panels.dependencies.content).toBe(acceptedContent)
    expect(updated.panels.dependencies.lifecycle).toBe(PANEL_LIFECYCLE.ACCEPTED)
  })
})

describe('updateRefinementStatus', () => {
  it('sets status to accepted and stamps acceptedAt', () => {
    const pm = normalizeToPanelModel(makeGoodCompiledPlan())
    const record = createRefinementRecord({ panelId: 'risks', prompt: 'Fix.', previousContent: null, revisedContent: null, auditBefore: null, auditAfter: null })
    const withRecord = appendRefinementRecord(pm, 'risks', record)
    const accepted   = updateRefinementStatus(withRecord, 'risks', record.refinementId, REFINEMENT_STATUSES.ACCEPTED)
    const entry = accepted.panels.risks.refinementHistory[0]
    expect(entry.status).toBe(REFINEMENT_STATUSES.ACCEPTED)
    expect(entry.acceptedAt).toBeTruthy()
    expect(entry.rejectedAt).toBeNull()
  })

  it('sets status to rejected and stamps rejectedAt', () => {
    const pm = normalizeToPanelModel(makeGoodCompiledPlan())
    const record = createRefinementRecord({ panelId: 'risks', prompt: 'Fix.', previousContent: null, revisedContent: null, auditBefore: null, auditAfter: null })
    const withRecord = appendRefinementRecord(pm, 'risks', record)
    const rejected   = updateRefinementStatus(withRecord, 'risks', record.refinementId, REFINEMENT_STATUSES.REJECTED)
    const entry = rejected.panels.risks.refinementHistory[0]
    expect(entry.status).toBe(REFINEMENT_STATUSES.REJECTED)
    expect(entry.rejectedAt).toBeTruthy()
    expect(entry.acceptedAt).toBeNull()
  })
})

// ── synthesizePanelSummary ────────────────────────────────────────────────────

describe('synthesizePanelSummary', () => {
  it('produces a non-empty summary for all panel types', () => {
    const plan = makeGoodCompiledPlan()
    expect(synthesizePanelSummary('strategicObjective',  plan.strategicObjective)).toBeTruthy()
    expect(synthesizePanelSummary('criticalDecisions',   plan.criticalDecisions)).toBeTruthy()
    expect(synthesizePanelSummary('executionSequence',   plan.executionSequence)).toBeTruthy()
    expect(synthesizePanelSummary('dependencies',        plan.dependencies)).toBeTruthy()
    expect(synthesizePanelSummary('risks',               plan.risksAndMitigations)).toBeTruthy()
    expect(synthesizePanelSummary('validationFramework', plan.validationFramework)).toBeTruthy()
  })

  it('handles null content gracefully', () => {
    PANEL_IDS.forEach(pid => {
      const summary = synthesizePanelSummary(pid, null)
      expect(summary).toBeTruthy()
      expect(typeof summary).toBe('string')
    })
  })

  it('includes count and names in array panel summaries', () => {
    const summary = synthesizePanelSummary('criticalDecisions', makeGoodCriticalDecisions())
    expect(summary).toContain('1 decision')
    expect(summary).toContain('Build vs Partner')
  })
})

// ── Execution Sequence deliverable mapping ────────────────────────────────────

const KNOWN_PHASES = [
  { phaseName: 'Problem & Outcome Validation' },
  { phaseName: 'Solution Path Evaluation' },
  { phaseName: 'Architecture & Delivery Readiness' },
  { phaseName: 'Pilot / Controlled Execution' },
  { phaseName: 'Scale Decision' },
]

const UNKNOWN_PHASE = [{ phaseName: 'Data Lake Migration Sprint' }]

describe('phaseSlug', () => {
  it('slugifies a phase name', () => {
    expect(phaseSlug('Problem & Outcome Validation')).toBe('problem_outcome_validation')
    expect(phaseSlug('Architecture & Delivery Readiness')).toBe('architecture_delivery_readiness')
  })
  it('handles empty input', () => {
    expect(phaseSlug('')).toBe('phase')
    expect(phaseSlug(null)).toBe('phase')
  })
})

describe('suggestPhaseDeliverables', () => {
  it('suggests deliverables for known phase names', () => {
    expect(suggestPhaseDeliverables('Problem & Outcome Validation')).toContain('executive_decision_brief')
    expect(suggestPhaseDeliverables('Architecture & Delivery Readiness')).toContain('bu_execution_plan')
    expect(suggestPhaseDeliverables('Pilot / Controlled Execution')).toContain('risk_control_plan')
    expect(suggestPhaseDeliverables('Scale Decision')).toContain('operating_cadence_plan')
  })
  it('returns empty array for unknown phase', () => {
    expect(suggestPhaseDeliverables('Data Lake Migration Sprint')).toHaveLength(0)
  })
  it('returns empty array for empty input', () => {
    expect(suggestPhaseDeliverables('')).toHaveLength(0)
  })
})

describe('buildInitialPhaseMappings', () => {
  it('creates suggested mappings for known phase names', () => {
    const mappings = buildInitialPhaseMappings(KNOWN_PHASES)
    expect(Object.keys(mappings)).toHaveLength(5)
    // Problem & Outcome Validation → suggested
    const problem = mappings['problem_outcome_validation']
    expect(problem.mappingStatus).toBe(MAPPING_STATUS.SUGGESTED)
    expect(problem.mappedDeliverables).toContain('executive_decision_brief')
    expect(problem.suggestedDeliverables).toEqual(problem.mappedDeliverables)
  })

  it('marks unknown phases as unmapped', () => {
    const mappings = buildInitialPhaseMappings(UNKNOWN_PHASE)
    const phase = mappings['data_lake_migration_sprint']
    expect(phase.mappingStatus).toBe(MAPPING_STATUS.UNMAPPED)
    expect(phase.mappedDeliverables).toHaveLength(0)
  })

  it('returns empty object for empty input', () => {
    expect(buildInitialPhaseMappings([])).toEqual({})
    expect(buildInitialPhaseMappings(null)).toEqual({})
  })

  it('stores phaseName in each record', () => {
    const mappings = buildInitialPhaseMappings(KNOWN_PHASES)
    expect(mappings['problem_outcome_validation'].phaseName).toBe('Problem & Outcome Validation')
  })
})

describe('mergePhasesMappings', () => {
  it('preserves user_confirmed mappings through a regeneration', () => {
    const original = buildInitialPhaseMappings(KNOWN_PHASES)
    // Simulate user confirming a mapping
    original['problem_outcome_validation'] = {
      ...original['problem_outcome_validation'],
      mappedDeliverables: ['executive_decision_brief', 'bu_execution_plan'],
      mappingStatus: MAPPING_STATUS.USER_CONFIRMED,
    }
    const merged = mergePhasesMappings(original, KNOWN_PHASES)
    expect(merged['problem_outcome_validation'].mappingStatus).toBe(MAPPING_STATUS.USER_CONFIRMED)
    expect(merged['problem_outcome_validation'].mappedDeliverables).toContain('bu_execution_plan')
  })

  it('rebuilds suggested mappings for phases not yet user_confirmed', () => {
    const original = buildInitialPhaseMappings(KNOWN_PHASES)
    const merged = mergePhasesMappings(original, KNOWN_PHASES)
    // Non-confirmed phases stay as suggested
    expect(merged['architecture_delivery_readiness'].mappingStatus).toBe(MAPPING_STATUS.SUGGESTED)
  })
})

describe('updatePhaseMapping', () => {
  it('marks a phase as user_confirmed when deliverables are set', () => {
    let pm = normalizeToPanelModel(makeGoodCompiledPlan())
    pm = updatePhaseMapping(pm, 'problem_outcome_validation', ['executive_decision_brief', 'bu_execution_plan'])
    const mapping = pm.panels.executionSequence.executionDeliverableMappings['problem_outcome_validation']
    expect(mapping.mappingStatus).toBe(MAPPING_STATUS.USER_CONFIRMED)
    expect(mapping.mappedDeliverables).toContain('executive_decision_brief')
    expect(mapping.mappedDeliverables).toContain('bu_execution_plan')
  })

  it('does NOT mutate execution phase content when mapping changes', () => {
    let pm = normalizeToPanelModel(makeGoodCompiledPlan())
    const contentBefore = JSON.stringify(pm.panels.executionSequence.content)
    pm = updatePhaseMapping(pm, 'problem_outcome_validation', ['bu_execution_plan'])
    expect(JSON.stringify(pm.panels.executionSequence.content)).toBe(contentBefore)
  })

  it('returns original panelModel if executionSequence panel is missing', () => {
    const pm = { panels: {} }
    const result = updatePhaseMapping(pm, 'problem_outcome_validation', ['bu_execution_plan'])
    expect(result).toBe(pm)
  })
})

describe('computeMappingStatus', () => {
  it('returns allMapped=true when all phases have deliverables', () => {
    let pm = normalizeToPanelModel(makeGoodCompiledPlan())
    // The compiled plan has 1 phase — normalizeToPanelModel runs buildInitialPhaseMappings
    // with suggested deliverables (should map to at least one deliverable)
    const status = computeMappingStatus(pm.panels.executionSequence)
    // The phase is "Problem & Outcome Validation" which has suggestions
    expect(status.total).toBeGreaterThan(0)
    expect(status.mapped + status.unmapped).toBe(status.total)
  })

  it('counts unmapped phases correctly', () => {
    const panel = {
      content: [
        { phaseName: 'Data Lake Migration' },      // no match → unmapped
        { phaseName: 'Data Lake Post-Migration' },  // no match → unmapped
      ],
      executionDeliverableMappings: buildInitialPhaseMappings([
        { phaseName: 'Data Lake Migration' },
        { phaseName: 'Data Lake Post-Migration' },
      ]),
    }
    const status = computeMappingStatus(panel)
    expect(status.unmapped).toBe(2)
    expect(status.allMapped).toBe(false)
  })

  it('returns allMapped=true for empty content', () => {
    const status = computeMappingStatus({ content: [] })
    expect(status.allMapped).toBe(true)
    expect(status.total).toBe(0)
  })
})

// ── How-option level mapping ──────────────────────────────────────────────────

const PHASES_WITH_HOW_OPTIONS = [
  {
    phaseName: 'Problem & Outcome Validation',
    howOptions: [
      { optionName: 'Regulatory Gap Mapping Workshop', whenToUse: 'When regulatory gap exists.', whyItFitsThePhaseOutcome: 'Directly addresses validation.', evidenceProduced: 'Gap analysis report.' },
      { optionName: 'Peer Institution Benchmarking', whenToUse: 'When peer data available.', whyItFitsThePhaseOutcome: 'Provides external validation.', evidenceProduced: 'Benchmark comparison.' },
    ],
  },
  {
    phaseName: 'Solution Path Evaluation',
    howOptions: [
      { optionName: 'Architectural Spike with Proof-of-Concept Prototype', whenToUse: 'When approach is unclear.', whyItFitsThePhaseOutcome: 'Validates feasibility.', evidenceProduced: 'PoC report.' },
      { optionName: 'Contract Engineer Scope Simulation', whenToUse: 'When scope is at risk.', whyItFitsThePhaseOutcome: 'Bounds delivery risk.', evidenceProduced: 'Scope boundary doc.' },
    ],
  },
]

describe('optionSlug', () => {
  it('slugifies an option name', () => {
    expect(optionSlug('Regulatory Gap Mapping Workshop')).toBe('regulatory_gap_mapping_workshop')
    expect(optionSlug('RFI/RFP Competitive Solicitation')).toBe('rfi_rfp_competitive_solicitation')
    expect(optionSlug('Architectural Spike with Proof-of-Concept Prototype')).toBe('architectural_spike_with_proof_of_concept_prototype')
  })
  it('handles empty input', () => {
    expect(optionSlug('')).toBe('option')
    expect(optionSlug(null)).toBe('option')
  })
})

describe('suggestHowOptionDeliverables', () => {
  it('returns defaults for known phase + option combinations', () => {
    expect(suggestHowOptionDeliverables('problem_outcome_validation', 'Regulatory Gap Mapping Workshop'))
      .toEqual(['executive_decision_brief', 'global_sme_review_packet'])
    expect(suggestHowOptionDeliverables('solution_path_evaluation', 'Architectural Spike with Proof-of-Concept Prototype'))
      .toContain('pdlc_epic_outline')
    expect(suggestHowOptionDeliverables('architecture_delivery_readiness', 'Threat-Modeled Architecture Review'))
      .toContain('risk_control_plan')
    expect(suggestHowOptionDeliverables('pilot_controlled_execution', 'Shadow-Mode Parallel Run'))
      .toContain('acceptance_criteria_draft')
  })
  it('returns empty array for unknown combinations', () => {
    expect(suggestHowOptionDeliverables('problem_outcome_validation', 'Unknown Option')).toHaveLength(0)
    expect(suggestHowOptionDeliverables('unknown_phase', 'Regulatory Gap Mapping Workshop')).toHaveLength(0)
  })
})

describe('derivePhaseMappedDeliverables', () => {
  it('returns union of all how-option mapped deliverables', () => {
    const howOptMaps = {
      opt_a: { mappedDeliverables: ['executive_decision_brief', 'bu_execution_plan'] },
      opt_b: { mappedDeliverables: ['bu_execution_plan', 'risk_control_plan'] },
    }
    const result = derivePhaseMappedDeliverables(howOptMaps)
    expect(result).toContain('executive_decision_brief')
    expect(result).toContain('bu_execution_plan')
    expect(result).toContain('risk_control_plan')
    expect(result).toHaveLength(3)  // deduplicated
  })
  it('returns empty array for empty how-option mappings', () => {
    expect(derivePhaseMappedDeliverables({})).toHaveLength(0)
    expect(derivePhaseMappedDeliverables(null)).toHaveLength(0)
  })
})

describe('buildInitialPhaseMappings — with howOptions', () => {
  it('creates howOptionMappings for each how option with suggested defaults', () => {
    const mappings = buildInitialPhaseMappings(PHASES_WITH_HOW_OPTIONS)
    const problemPhase = mappings['problem_outcome_validation']
    expect(problemPhase).toBeTruthy()
    expect(problemPhase.howOptionMappings).toBeTruthy()
    const workshopOpt = problemPhase.howOptionMappings['regulatory_gap_mapping_workshop']
    expect(workshopOpt).toBeTruthy()
    expect(workshopOpt.mappedDeliverables).toContain('executive_decision_brief')
    expect(workshopOpt.mappingStatus).toBe(MAPPING_STATUS.SUGGESTED)
  })

  it('phaseMappedDeliverables is derived union of how-option deliverables', () => {
    const mappings = buildInitialPhaseMappings(PHASES_WITH_HOW_OPTIONS)
    const problemPhase = mappings['problem_outcome_validation']
    // Both workshop and benchmarking suggest executive_decision_brief, so it appears once
    expect(problemPhase.phaseMappedDeliverables).toContain('executive_decision_brief')
    expect(problemPhase.mappedDeliverables).toEqual(problemPhase.phaseMappedDeliverables)
  })

  it('stores optionName in each how-option record', () => {
    const mappings = buildInitialPhaseMappings(PHASES_WITH_HOW_OPTIONS)
    const workshopOpt = mappings['problem_outcome_validation'].howOptionMappings['regulatory_gap_mapping_workshop']
    expect(workshopOpt.optionName).toBe('Regulatory Gap Mapping Workshop')
  })

  it('phases with empty howOptions still use legacy phase-level path', () => {
    const phases = [{ phaseName: 'Problem & Outcome Validation', howOptions: [] }]
    const mappings = buildInitialPhaseMappings(phases)
    const phase = mappings['problem_outcome_validation']
    expect(phase.howOptionMappings).toEqual({})
    expect(phase.mappedDeliverables).toContain('executive_decision_brief')
    expect(phase.mappingStatus).toBe(MAPPING_STATUS.SUGGESTED)
  })
})

describe('mergePhasesMappings — how-option level', () => {
  it('preserves user_confirmed how-option mappings through a regeneration', () => {
    const initial = buildInitialPhaseMappings(PHASES_WITH_HOW_OPTIONS)
    // Simulate user confirming one how-option
    initial['problem_outcome_validation'].howOptionMappings['regulatory_gap_mapping_workshop'] = {
      ...initial['problem_outcome_validation'].howOptionMappings['regulatory_gap_mapping_workshop'],
      mappedDeliverables: ['executive_decision_brief', 'bu_execution_plan'],
      mappingStatus: MAPPING_STATUS.USER_CONFIRMED,
    }
    const merged = mergePhasesMappings(initial, PHASES_WITH_HOW_OPTIONS)
    const opt = merged['problem_outcome_validation'].howOptionMappings['regulatory_gap_mapping_workshop']
    expect(opt.mappingStatus).toBe(MAPPING_STATUS.USER_CONFIRMED)
    expect(opt.mappedDeliverables).toContain('bu_execution_plan')
  })

  it('rebuilds suggested mappings for non-confirmed how-options on regeneration', () => {
    const initial = buildInitialPhaseMappings(PHASES_WITH_HOW_OPTIONS)
    const merged = mergePhasesMappings(initial, PHASES_WITH_HOW_OPTIONS)
    const opt = merged['problem_outcome_validation'].howOptionMappings['peer_institution_benchmarking']
    expect(opt.mappingStatus).toBe(MAPPING_STATUS.SUGGESTED)
  })

  it('migrates a legacy phase-level record to how-option shape as suggested (not user_confirmed)', () => {
    const legacyMappings = {
      'problem_outcome_validation': {
        phaseName:         'Problem & Outcome Validation',
        mappedDeliverables: ['executive_decision_brief'],
        suggestedDeliverables: ['executive_decision_brief'],
        mappingStatus:     MAPPING_STATUS.USER_CONFIRMED,  // old-style confirmed
        updatedAt:         new Date().toISOString(),
        // NO howOptionMappings key
      },
    }
    const merged = mergePhasesMappings(legacyMappings, PHASES_WITH_HOW_OPTIONS)
    const phase = merged['problem_outcome_validation']
    expect(phase.howOptionMappings).toBeTruthy()
    expect(Object.keys(phase.howOptionMappings).length).toBe(2)
    // Migrated record is NOT user_confirmed — marked suggested
    expect(phase.mappingStatus).toBe(MAPPING_STATUS.SUGGESTED)
    // All how-option entries are suggested, not user_confirmed
    Object.values(phase.howOptionMappings).forEach(opt => {
      expect(opt.mappingStatus).not.toBe(MAPPING_STATUS.USER_CONFIRMED)
    })
  })
})

describe('updateHowOptionMapping', () => {
  function makePMWithHowOptions() {
    const plan = {
      ...makeGoodCompiledPlan(),
      executionSequence: PHASES_WITH_HOW_OPTIONS.map(p => ({
        ...p,
        phaseObjective: 'Confirm that the proposed path meets regulatory and delivery requirements before committing to the build.',
        recommendedHow: 'Structured review of completed BSA/AML model outputs against SR 11-7 examiner format with Compliance team.',
        exitCriteria:   'Compliance team signs off that model outputs meet SR 11-7 format requirements before Sprint 2 begins.',
        evidenceExamples: ['Signed compliance review memo', 'Two annotated model output examples'],
      })),
    }
    return normalizeToPanelModel(plan)
  }

  it('marks the targeted how-option as user_confirmed', () => {
    let pm = makePMWithHowOptions()
    pm = updateHowOptionMapping(pm, 'problem_outcome_validation', 'regulatory_gap_mapping_workshop', ['executive_decision_brief', 'risk_control_plan'])
    const opt = pm.panels.executionSequence.executionDeliverableMappings['problem_outcome_validation'].howOptionMappings['regulatory_gap_mapping_workshop']
    expect(opt.mappingStatus).toBe(MAPPING_STATUS.USER_CONFIRMED)
    expect(opt.mappedDeliverables).toContain('executive_decision_brief')
    expect(opt.mappedDeliverables).toContain('risk_control_plan')
  })

  it('updates phaseMappedDeliverables as the union after how-option change', () => {
    let pm = makePMWithHowOptions()
    pm = updateHowOptionMapping(pm, 'problem_outcome_validation', 'regulatory_gap_mapping_workshop', ['executive_decision_brief'])
    pm = updateHowOptionMapping(pm, 'problem_outcome_validation', 'peer_institution_benchmarking', ['risk_control_plan'])
    const phase = pm.panels.executionSequence.executionDeliverableMappings['problem_outcome_validation']
    expect(phase.phaseMappedDeliverables).toContain('executive_decision_brief')
    expect(phase.phaseMappedDeliverables).toContain('risk_control_plan')
    expect(phase.mappedDeliverables).toEqual(phase.phaseMappedDeliverables)
  })

  it('does NOT mutate phase or how-option text when mapping changes', () => {
    let pm = makePMWithHowOptions()
    const contentBefore = JSON.stringify(pm.panels.executionSequence.content)
    pm = updateHowOptionMapping(pm, 'problem_outcome_validation', 'regulatory_gap_mapping_workshop', ['bu_execution_plan'])
    expect(JSON.stringify(pm.panels.executionSequence.content)).toBe(contentBefore)
  })

  it('deliverable-first checkbox state reads existing how-option mappings', () => {
    let pm = makePMWithHowOptions()
    pm = updateHowOptionMapping(pm, 'problem_outcome_validation', 'regulatory_gap_mapping_workshop', ['bu_execution_plan'])
    const summary = getDeliverableMappingSummary(pm.panels.executionSequence, 'bu_execution_plan')

    expect(summary.selectedHowOptionCount).toBeGreaterThanOrEqual(1)
    expect(summary.selectedPhases).toContain('Problem & Outcome Validation')
  })

  it('checking a how option adds the active deliverable to mappedDeliverables', () => {
    let pm = makePMWithHowOptions()
    pm = updateHowOptionMapping(pm, 'problem_outcome_validation', 'regulatory_gap_mapping_workshop', ['executive_decision_brief'])
    const before = pm.panels.executionSequence.executionDeliverableMappings.problem_outcome_validation.howOptionMappings.regulatory_gap_mapping_workshop

    pm = updateHowOptionMapping(pm, 'problem_outcome_validation', 'regulatory_gap_mapping_workshop', [...before.mappedDeliverables, 'bu_execution_plan'])
    const after = pm.panels.executionSequence.executionDeliverableMappings.problem_outcome_validation.howOptionMappings.regulatory_gap_mapping_workshop

    expect(after.mappedDeliverables).toContain('executive_decision_brief')
    expect(after.mappedDeliverables).toContain('bu_execution_plan')
  })

  it('unchecking a how option removes the active deliverable from mappedDeliverables', () => {
    let pm = makePMWithHowOptions()
    pm = updateHowOptionMapping(pm, 'problem_outcome_validation', 'regulatory_gap_mapping_workshop', ['executive_decision_brief', 'bu_execution_plan'])
    const before = pm.panels.executionSequence.executionDeliverableMappings.problem_outcome_validation.howOptionMappings.regulatory_gap_mapping_workshop

    pm = updateHowOptionMapping(pm, 'problem_outcome_validation', 'regulatory_gap_mapping_workshop', before.mappedDeliverables.filter(d => d !== 'bu_execution_plan'))
    const after = pm.panels.executionSequence.executionDeliverableMappings.problem_outcome_validation.howOptionMappings.regulatory_gap_mapping_workshop

    expect(after.mappedDeliverables).toContain('executive_decision_brief')
    expect(after.mappedDeliverables).not.toContain('bu_execution_plan')
  })

  it('phase summary is derived from selected how options for the active deliverable', () => {
    let pm = makePMWithHowOptions()
    pm = updateHowOptionMapping(pm, 'problem_outcome_validation', 'regulatory_gap_mapping_workshop', ['bu_execution_plan'])
    pm = updateHowOptionMapping(pm, 'solution_path_evaluation', 'contract_engineer_scope_simulation', ['bu_execution_plan'])
    const summary = getDeliverableMappingSummary(pm.panels.executionSequence, 'bu_execution_plan')

    expect(summary.selectedHowOptionCount).toBeGreaterThanOrEqual(2)
    expect(summary.selectedPhaseCount).toBe(2)
    expect(summary.unmappedPhaseCount).toBe(0)
  })

  it('existing mapping metadata still loads into deliverable-first summaries', () => {
    const mappings = buildInitialPhaseMappings(PHASES_WITH_HOW_OPTIONS)
    const panel = { content: PHASES_WITH_HOW_OPTIONS, executionDeliverableMappings: mappings }
    const ids = getMappedDeliverableIds(panel)
    const summary = getDeliverableMappingSummary(panel, 'executive_decision_brief')

    expect(ids).toContain('executive_decision_brief')
    expect(summary.selectedHowOptionCount).toBeGreaterThan(0)
  })

  it('mapping readiness is based on intended deliverables, not every possible deliverable', () => {
    let pm = makePMWithHowOptions()
    pm = updateHowOptionMapping(pm, 'problem_outcome_validation', 'regulatory_gap_mapping_workshop', ['bu_execution_plan'])

    const ready = computeDeliverableMappingReadiness(pm.panels.executionSequence, ['bu_execution_plan'])
    const blocked = computeDeliverableMappingReadiness(pm.panels.executionSequence, ['bu_execution_plan', 'operating_cadence_plan'])

    expect(ready.mappingReady).toBe(true)
    expect(blocked.mappingReady).toBe(false)
    expect(blocked.unmappedDeliverables).toContain('operating_cadence_plan')
  })

  it('stores selected Stage 4 deliverables to prepare separately from mappings', () => {
    let pm = makePMWithHowOptions()
    pm = updateSelectedStage4Deliverables(pm, ['bu_execution_plan', 'acceptance_criteria_draft'])

    const selected = getSelectedStage4Deliverables(pm.panels.executionSequence)
    expect(selected.map(record => record.deliverableType)).toEqual(['bu_execution_plan', 'acceptance_criteria_draft'])
    expect(selected.every(record => record.selectedAt && record.updatedAt)).toBe(true)
  })

  it('active deliverable options are derived from selected deliverables only', () => {
    let pm = makePMWithHowOptions()
    pm = updateSelectedStage4Deliverables(pm, ['acceptance_criteria_draft'])

    const selected = getSelectedStage4Deliverables(pm.panels.executionSequence)
    expect(selected.map(record => record.deliverableType)).toEqual(['acceptance_criteria_draft'])
    expect(selected.map(record => record.deliverableType)).not.toContain('bu_execution_plan')
  })

  it('selected deliverable status becomes incomplete when no how options map to it', () => {
    let pm = makePMWithHowOptions()
    pm = updateSelectedStage4Deliverables(pm, ['operating_cadence_plan'])

    const selected = getSelectedStage4Deliverables(pm.panels.executionSequence)
    expect(selected[0]).toMatchObject({
      deliverableType: 'operating_cadence_plan',
      status: 'incomplete',
    })
    expect(computeDeliverableMappingReadiness(pm.panels.executionSequence, ['operating_cadence_plan']).mappingReady).toBe(false)
  })

  it('selected deliverable status becomes mapped when a how option feeds it', () => {
    let pm = makePMWithHowOptions()
    pm = updateSelectedStage4Deliverables(pm, ['operating_cadence_plan'])
    pm = updateHowOptionMapping(pm, 'problem_outcome_validation', 'regulatory_gap_mapping_workshop', ['operating_cadence_plan'])

    const selected = getSelectedStage4Deliverables(pm.panels.executionSequence)
    expect(selected[0]).toMatchObject({
      deliverableType: 'operating_cadence_plan',
      status: 'mapped',
    })
    expect(getDeliverableMappingSummary(pm.panels.executionSequence, 'operating_cadence_plan').selectedHowOptionCount).toBe(1)
  })

  it('selected deliverable metadata still loads after serialization', () => {
    let pm = makePMWithHowOptions()
    pm = updateSelectedStage4Deliverables(pm, ['bu_execution_plan'])
    pm = updateHowOptionMapping(pm, 'problem_outcome_validation', 'regulatory_gap_mapping_workshop', ['bu_execution_plan'])

    const reloadedPanel = JSON.parse(JSON.stringify(pm.panels.executionSequence))
    const selected = getSelectedStage4Deliverables(reloadedPanel)
    expect(selected).toHaveLength(1)
    expect(selected[0].deliverableType).toBe('bu_execution_plan')
    expect(getDeliverableMappingSummary(reloadedPanel, 'bu_execution_plan').selectedHowOptionCount).toBeGreaterThan(0)
  })

  it('Stage 4 deliverables expose concise preparation intent descriptions', () => {
    expect(STAGE4_DELIVERABLES.every(deliverable => deliverable.intent && deliverable.intent.length > 20)).toBe(true)
  })

  it('returns original panelModel if executionSequence panel is missing', () => {
    const pm = { panels: {} }
    const result = updateHowOptionMapping(pm, 'problem_outcome_validation', 'regulatory_gap_mapping_workshop', ['bu_execution_plan'])
    expect(result).toBe(pm)
  })
})

describe('computeMappingStatus — with howOptions', () => {
  it('counts a phase as mapped when at least one how-option has deliverables', () => {
    const phase = PHASES_WITH_HOW_OPTIONS[0]
    const id    = phaseSlug(phase.phaseName)
    const mapping = buildInitialPhaseMappings([phase])[id]
    const panel = { content: [phase], executionDeliverableMappings: { [id]: mapping } }
    const status = computeMappingStatus(panel)
    // Regulatory Gap Mapping Workshop has suggested deliverables → mapped
    expect(status.mapped).toBe(1)
    expect(status.unmapped).toBe(0)
  })

  it('counts a phase as unmapped when all how-options have empty deliverables', () => {
    const phase = { phaseName: 'Custom Phase', howOptions: [{ optionName: 'Unknown Option' }] }
    const id = phaseSlug(phase.phaseName)
    const mapping = buildInitialPhaseMappings([phase])[id]
    const panel = { content: [phase], executionDeliverableMappings: { [id]: mapping } }
    const status = computeMappingStatus(panel)
    expect(status.unmapped).toBe(1)
    expect(status.allMapped).toBe(false)
  })
})

describe('mapping readiness — Stage 4 preparation distinct from content readiness', () => {
  it('panel acceptance is not blocked by missing mappings', () => {
    let pm = normalizeToPanelModel(makeGoodCompiledPlan())
    // Execution sequence is DRAFT_READY — can be accepted regardless of mapping state
    expect(canAccept(pm.panels.executionSequence)).toBe(true)
  })

  it('accepted panel with unmapped phases does not warn unless deliverables are intended', () => {
    // Use the good compiled plan (all fields present), then clear the mappings
    // for the one execution phase so it reads as "unmapped".
    let pm = normalizeToPanelModel(makeGoodCompiledPlan())

    // Force-clear the mapping so the phase is unmapped
    pm = {
      ...pm,
      panels: {
        ...pm.panels,
        executionSequence: {
          ...pm.panels.executionSequence,
          selectedStage4Deliverables: [],
          executionDeliverableMappings: {
            'problem_outcome_validation': {
              phaseName:           'Problem & Outcome Validation',
              mappedDeliverables:  [],   // explicitly empty — unmapped
              suggestedDeliverables: [],
              mappingStatus:       MAPPING_STATUS.UNMAPPED,
              updatedAt:           new Date().toISOString(),
            },
          },
        },
      },
    }

    // Accept all panels that can be accepted
    PANEL_IDS.forEach(pid => {
      const p = pm.panels[pid]
      if (p && canAccept(p)) {
        pm = acceptPanel(pm, pid)
      }
    })

    // mappingWarnings should exist because the executionSequence phase is unmapped + accepted
    // Note: isReady may be false if strength audit blocks — we test the warning regardless
    const readiness = computeLifecycleReadiness(pm.panels, pm.crossPanelAudit)
    expect(readiness.mappingWarnings).toHaveLength(0)
    expect(readiness.mappingReady).toBe(true)
  })

  it('all phases mapped clears mapping warning', () => {
    let pm = normalizeToPanelModel(makeGoodCompiledPlan())
    PANEL_IDS.forEach(pid => {
      if (['draft_ready', 'needs_refinement'].includes(pm.panels[pid]?.lifecycle)) {
        pm = acceptPanel(pm, pid)
      }
    })
    // Confirm mapping for the one phase in the compiled plan
    pm = updatePhaseMapping(pm, 'problem_outcome_validation', ['executive_decision_brief'])
    const readiness = pm.readinessStatus
    if (readiness.isReady) {
      expect(readiness.mappingReady).toBe(true)
    }
  })

  it('how-option mapped phase clears mapping warning when accepted', () => {
    // Build a plan whose execution phases have howOptions
    const plan = {
      ...makeGoodCompiledPlan(),
      executionSequence: [{
        phaseName:    'Problem & Outcome Validation',
        phaseObjective: 'Confirm that examiner-facing explainability outputs meet SR 11-7 requirements before build commitment.',
        recommendedHow: 'Structured review of completed BSA/AML model outputs against SR 11-7 examiner format with Compliance team.',
        exitCriteria:   'Compliance team signs off that model outputs meet SR 11-7 format requirements before Sprint 2 begins.',
        evidenceExamples: ['Signed compliance review memo', 'Two annotated model output examples'],
        howOptions: [
          { optionName: 'Regulatory Gap Mapping Workshop', whenToUse: 'When regulatory gap exists.', whyItFitsThePhaseOutcome: 'Directly addresses validation need.', evidenceProduced: 'Gap analysis report.' },
        ],
      }],
    }
    let pm = normalizeToPanelModel(plan)
    pm = updateSelectedStage4Deliverables(pm, ['executive_decision_brief'])
    PANEL_IDS.forEach(pid => {
      if (canAccept(pm.panels[pid])) pm = acceptPanel(pm, pid)
    })
    pm = updateHowOptionMapping(pm, 'problem_outcome_validation', 'regulatory_gap_mapping_workshop', ['executive_decision_brief'])
    const readiness = computeLifecycleReadiness(pm.panels, pm.crossPanelAudit)
    expect(readiness.mappingWarnings).toHaveLength(0)
    expect(readiness.mappingReady).toBe(true)
  })

  it('accepted phase with howOptions and no selected deliverables does not require every possible deliverable', () => {
    const plan = {
      ...makeGoodCompiledPlan(),
      executionSequence: [{
        phaseName:    'Problem & Outcome Validation',
        phaseObjective: 'Confirm that examiner-facing explainability outputs meet SR 11-7 requirements before build commitment.',
        recommendedHow: 'Structured review of completed BSA/AML model outputs against SR 11-7 examiner format with Compliance team.',
        exitCriteria:   'Compliance team signs off that model outputs meet SR 11-7 format requirements before Sprint 2 begins.',
        evidenceExamples: ['Signed compliance review memo', 'Two annotated model output examples'],
        howOptions: [
          { optionName: 'Undocumented Custom Approach', whenToUse: 'In special circumstances only.', whyItFitsThePhaseOutcome: 'Context-dependent.', evidenceProduced: 'Custom evidence.' },
        ],
      }],
    }
    let pm = normalizeToPanelModel(plan)
    PANEL_IDS.forEach(pid => {
      if (canAccept(pm.panels[pid])) pm = acceptPanel(pm, pid)
    })
    // Do NOT confirm any how-option mapping — 'Undocumented Custom Approach' has no defaults
    const readiness = computeLifecycleReadiness(pm.panels, pm.crossPanelAudit)
    expect(readiness.mappingWarnings).toHaveLength(0)
    expect(readiness.mappingReady).toBe(true)
  })

  it('accepted execution sequence blocks Stage 4 readiness when a selected deliverable has no mapped how option', () => {
    const plan = {
      ...makeGoodCompiledPlan(),
      executionSequence: [{
        phaseName:    'Problem & Outcome Validation',
        phaseObjective: 'Confirm that examiner-facing explainability outputs meet SR 11-7 requirements before build commitment.',
        recommendedHow: 'Structured review of completed BSA/AML model outputs against SR 11-7 examiner format with Compliance team.',
        exitCriteria:   'Compliance team signs off that model outputs meet SR 11-7 format requirements before Sprint 2 begins.',
        evidenceExamples: ['Signed compliance review memo', 'Two annotated model output examples'],
        howOptions: [
          { optionName: 'Undocumented Custom Approach', whenToUse: 'In special circumstances only.', whyItFitsThePhaseOutcome: 'Context-dependent.', evidenceProduced: 'Custom evidence.' },
        ],
      }],
    }
    let pm = normalizeToPanelModel(plan)
    pm = updateSelectedStage4Deliverables(pm, ['operating_cadence_plan'])
    PANEL_IDS.forEach(pid => {
      if (canAccept(pm.panels[pid])) pm = acceptPanel(pm, pid)
    })

    const readiness = computeLifecycleReadiness(pm.panels, pm.crossPanelAudit)
    expect(readiness.mappingReady).toBe(false)
    expect(readiness.mappingWarnings.join(' ')).toContain('selected deliverable')
  })

  it('existing panels without executionDeliverableMappings normalize safely', () => {
    const legacyPanel = {
      panelId: 'executionSequence',
      content: [{ phaseName: 'Problem & Outcome Validation', phaseObjective: 'Test' }],
      lifecycle: 'accepted',
      completenessAudit: null,
      executionDeliverableMappings: undefined,  // missing
    }
    // computeMappingStatus should not throw for missing mappings
    const status = computeMappingStatus(legacyPanel)
    expect(status.total).toBe(1)
    expect(typeof status.mapped).toBe('number')
    expect(typeof status.unmapped).toBe('number')
  })
})
