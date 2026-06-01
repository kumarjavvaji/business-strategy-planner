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
} from './stage3PanelModel'
import { PANEL_LIFECYCLE, canAccept } from './stage3PanelLifecycle'

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
      phaseObjective: 'Clarify the priority use case before committing architecture scope.',
      recommendedHow: 'Client workflow interviews',
      whyThisFitsThePhase: 'Surfaces where users struggle before architecture is locked.',
      exitCriteria: 'Priority workflow is named and outcome signal is agreed.',
      evidenceExamples: ['interview notes', 'workflow steps'],
      howOptions: [{ optionName: 'Mock review', whenToUse: 'Before engineering build', whyItFitsThePhaseOutcome: 'Fast feedback loop', evidenceProduced: 'Annotated mock' }],
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

  it('blocks accepting panels with blocking duplicate field findings', () => {
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
    expect(canAccept(pm.panels.dependencies)).toBe(false)
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
