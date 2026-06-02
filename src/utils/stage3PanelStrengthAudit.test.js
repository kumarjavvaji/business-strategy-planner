/**
 * Tests for stage3PanelStrengthAudit — document-strength governance layer.
 *
 * Key behaviors tested:
 *   - Execution Sequence generic method-library content fails strength audit
 *   - Execution Sequence with concrete phases, inputs, gates, and outputs passes
 *   - Structurally complete panel can still be NEEDS_STRENGTHENING (weak/failed)
 *   - Stage 4 readiness is blocked when a required panel fails strength
 *   - Strength audit does not fail merely because a section is detailed
 *   - Critical Decisions pass only when each item is a real choice
 *   - Dependencies fail when requiredInput is a copy of description
 *   - Risk panel fails when risks are generic SaaS delivery anxieties
 *   - Validation Framework fails when validation questions share generic boilerplate
 */

import { describe, it, expect } from 'vitest'
import {
  STRENGTH_STATUSES,
  auditPanelStrength,
  auditExecutionSequenceStrength,
  auditCriticalDecisionsStrength,
  auditDependenciesStrength,
  auditRisksStrength,
  auditValidationFrameworkStrength,
  auditStrategicObjectiveStrength,
  strengthAuditBlocks,
  weaselDensity,
  detectMechanicalPhrases,
} from './stage3PanelStrengthAudit'

// ── Fixtures: Execution Sequence ──────────────────────────────────────────────

/** Generic method library — the exact failure pattern we must catch. */
const GENERIC_EXEC_SEQUENCE = [
  {
    phaseName:          'Discovery',
    phaseObjective:     'Understand the problem.',
    recommendedHow:     'Customer Discovery',
    whyThisFitsThePhase: 'Understanding the problem is important.',
    exitCriteria:       'Problem understood.',
    evidenceExamples:   ['Interview notes', 'Survey results'],
    howOptions: [
      { optionName: 'Expert Interviews', whenToUse: 'When domain expertise is available', whyItFitsThePhaseOutcome: 'Gets qualitative data', evidenceProduced: 'Interview transcripts' },
      { optionName: 'Surveys',           whenToUse: 'When broad input is needed',        whyItFitsThePhaseOutcome: 'Collects structured data', evidenceProduced: 'Survey spreadsheet' },
      { optionName: 'Focus Groups',      whenToUse: 'For group dynamics',                whyItFitsThePhaseOutcome: 'Provides rich insights', evidenceProduced: 'Session recordings' },
    ],
  },
  {
    phaseName:          'Analysis',
    phaseObjective:     'Analyze the findings.',
    recommendedHow:     'Structured Analysis',
    whyThisFitsThePhase: 'Analysis helps understand the data.',
    exitCriteria:       'Analysis complete.',
    evidenceExamples:   ['Analysis report', 'Presentation'],
    howOptions: [
      { optionName: 'Quantitative Analysis', whenToUse: 'When data is available',       whyItFitsThePhaseOutcome: 'Provides numbers', evidenceProduced: 'Data model' },
      { optionName: 'Qualitative Analysis',  whenToUse: 'When patterns are needed',     whyItFitsThePhaseOutcome: 'Reveals themes',   evidenceProduced: 'Theme document' },
    ],
  },
  {
    phaseName:          'Pilot',
    phaseObjective:     'Run a pilot.',
    recommendedHow:     'Prototype',
    whyThisFitsThePhase: 'Testing with a prototype may help.',
    exitCriteria:       'Pilot done.',
    evidenceExamples:   ['Pilot report'],
    howOptions: [
      { optionName: 'Controlled Experiment', whenToUse: 'When conditions can be controlled', whyItFitsThePhaseOutcome: 'Rigorous results', evidenceProduced: 'Experiment log' },
      { optionName: 'A/B Test',              whenToUse: 'When comparing two approaches',    whyItFitsThePhaseOutcome: 'Statistical evidence', evidenceProduced: 'A/B results report' },
    ],
  },
]

/** Concrete execution path — specific to this BU's operating sequence. */
const CONCRETE_EXEC_SEQUENCE = [
  {
    phaseName:          'Problem & Outcome Validation',
    phaseObjective:     'Confirm that examiner-facing explainability outputs meet SR 11-7 requirements before committing to build path.',
    recommendedHow:     'Structured review of two completed BSA/AML model outputs against SR 11-7 examiner expectations, with API Engineering and Compliance present.',
    whyThisFitsThePhase: 'This phase must confirm regulatory fit before architecture decisions are locked — validating against actual examiner expectations eliminates re-work once build begins.',
    exitCriteria:       'Compliance team signs off that two model outputs meet SR 11-7 format requirements; Architecture Review Board receives findings before Sprint 1 closes.',
    evidenceExamples:   ['Signed compliance review memo', 'Two completed model output examples with examiner annotations'],
    howOptions:         [],
  },
  {
    phaseName:          'Architecture & Delivery Readiness',
    phaseObjective:     'Lock schema contracts and define modularity boundaries before Sprint 2 connector build begins.',
    recommendedHow:     'API Engineering schema review with Product & Competitive Architecture team: each interface boundary signed off before Sprint 2 begins.',
    whyThisFitsThePhase: 'Starting connector build on unvalidated schema contracts is the primary technical risk for this BU — this phase is the gate that removes it.',
    exitCriteria:       'API Engineering countersigns schema interface contracts; Architecture decision record logged; no Sprint 2 ticket assigned before gate closes.',
    evidenceExamples:   ['Signed schema interface contracts', 'Architecture decision record', 'Sprint 2 ticket list (none pre-assigned)'],
    howOptions:         [],
  },
]

// ── Fixtures: Critical Decisions ──────────────────────────────────────────────

const TASK_LIKE_DECISIONS = [
  {
    decisionName:           'Build Connector',
    decisionQuestion:       'Build the data connector for the explainability output format.',
    whyItMatters:           'Connectors are needed for the platform.',
    decisionOptions:        ['Build it', 'Delay it'],
    decisionEvidenceNeeded: ['data'],
    decisionTiming:         'Before execution begins.',
  },
  {
    decisionName:           'Define Architecture',
    decisionQuestion:       'Define a clear architecture for the explainability platform.',
    whyItMatters:           'Architecture is important.',
    decisionOptions:        ['Simple', 'Complex'],
    decisionEvidenceNeeded: ['research'],
    decisionTiming:         'At project start.',
  },
]

const REAL_DECISIONS = [
  {
    decisionName:           'Build vs Partner',
    decisionQuestion:       'Which of the three core explainability components should be built internally versus sourced from Fiddler AI or Arthur AI?',
    whyItMatters:           'This determines long-term maintenance ownership, integration complexity, and whether SR 11-7 audit trails are internally controlled.',
    decisionOptions:        ['Full internal build', 'Strategic partnering for selected components', 'Hybrid approach with partner for edge cases'],
    decisionEvidenceNeeded: ['Pilot evidence from Fiddler AI capability screen in Sprint 0', 'Internal capacity assessment from API Engineering (Sprint 1)'],
    decisionTiming:         'Resolve before Sprint 2 architecture work begins — locks the connector interface contracts.',
  },
]

// ── Fixtures: Dependencies ────────────────────────────────────────────────────

const COPY_PASTE_DEPENDENCIES = [
  {
    dependencyName:        'Schema Review',
    dependencyDescription: 'API Engineering must review and approve schema contracts before Sprint 2 begins.',
    whyItMatters:          'This gates Sprint 2.',
    requiredInput:         'API Engineering must review and approve schema contracts before Sprint 2 begins.',
    consequenceIfMissing:  'Delays the project timeline.',
  },
]

const CONCRETE_DEPENDENCIES = [
  {
    dependencyName:        'API Engineering Schema Approval',
    dependencyDescription: 'API Engineering must review and sign off on interface contracts before Sprint 2 connector build begins.',
    whyItMatters:          'Sprint 2 connector build cannot start on unvalidated schema assumptions — this is the primary technical blocker.',
    requiredInput:         'Signed schema interface contracts',
    consequenceIfMissing:  'Sprint 2 connector build begins on unvalidated schema assumptions, creating re-work risk at Sprint 3 integration.',
  },
]

// ── Fixtures: Risks ───────────────────────────────────────────────────────────

const GENERIC_RISKS = [
  {
    riskName:                  'Resource Constraints',
    riskDescription:           'Resource constraints may impact delivery.',
    whyItMatters:              'Without sufficient resources the project may fail.',
    mitigationOptions:         ['Regular status meetings', 'Escalation process'],
    earlyWarningSignals:       ['Missed milestones', 'Delayed timelines'],
    evidenceThatRiskIsReduced: ['Project on schedule'],
  },
  {
    riskName:                  'Scope Creep',
    riskDescription:           'Scope creep could expand the project beyond its boundaries.',
    whyItMatters:              'Uncontrolled scope puts the project at risk.',
    mitigationOptions:         ['Stakeholder communication', 'Risk register'],
    earlyWarningSignals:       ['Team concerns', 'Negative feedback'],
    evidenceThatRiskIsReduced: ['Scope documentation maintained'],
  },
]

const SPECIFIC_RISKS = [
  {
    riskName:                  'Architecture Lock-In Risk',
    riskDescription:           'Early connector build may lock data field mappings before schema coverage is confirmed, embedding SR 11-7 gaps in the integration layer.',
    whyItMatters:              'Once the connector interface is deployed and integrated, changing field mappings requires coordinated re-work across API Engineering and the partner stack, estimated at 6–8 sprint-weeks.',
    mitigationOptions:         ['Define and freeze interface boundaries before Sprint 2 begins', 'Create separate reusable mapping logic distinct from ETL-specific exceptions'],
    earlyWarningSignals:       ['Connector Sprint 2 work begins before schema interface contracts are signed', 'Architecture decision record not filed before Sprint 1 closes'],
    evidenceThatRiskIsReduced: ['Architecture review confirms extension points', 'Schema coverage confirmed before Sprint 2 connector work begins'],
  },
]

// ── Fixtures: Validation Framework ───────────────────────────────────────────

const BOILERPLATE_VALIDATION = [
  {
    validationQuestion:      'Is the solution working?',
    completionCriteria:      ['Stakeholder sign-off received', 'Management approval obtained'],
    howToDetermineCompletion: ['Review outcomes', 'Check documentation'],
    evidenceExamples:        ['Survey results', 'Meeting minutes'],
    veracityChecks:          ['Evidence reviewed', 'Feedback collected'],
    failureOrReworkTriggers:  ['If progress stalls', 'If quality is insufficient'],
  },
  {
    validationQuestion:      'Is alignment achieved?',
    completionCriteria:      ['Stakeholder sign-off received', 'Management approval obtained'],
    howToDetermineCompletion: ['Review outcomes', 'Check documentation'],
    evidenceExamples:        ['Survey results', 'Meeting minutes'],
    veracityChecks:          ['Evidence reviewed', 'Feedback collected'],
    failureOrReworkTriggers:  ['If progress stalls', 'If quality is insufficient'],
  },
]

const SPECIFIC_VALIDATION = [
  {
    validationQuestion:      'Do examiner-facing explainability outputs meet SR 11-7 format requirements for BSA/AML model decisions?',
    completionCriteria:      ['Two completed model outputs reviewed against SR 11-7 checklist', 'Compliance sign-off dated and filed before Sprint 1 closes', 'No open audit items remaining'],
    howToDetermineCompletion: ['Compliance team structured review against SR 11-7 examiner checklist', 'Two real BSA/AML model outputs presented in the required format'],
    evidenceExamples:        ['Signed compliance review memo', 'Two annotated model output examples', 'SR 11-7 checklist with items marked pass/fail'],
    veracityChecks:          ['Review conducted by Compliance team, not product team', 'Outputs reviewed are from actual production model runs, not mocks'],
    failureOrReworkTriggers:  ['Compliance team identifies open SR 11-7 items after review', 'Output format does not match examiner-expected schema'],
  },
]

// ── Fixtures: Strategic Objective ─────────────────────────────────────────────

const GENERIC_STRATEGIC_OBJECTIVE = {
  summary:              'Deliver value.',
  outcomeFocus:         'Drive efficiency and enable growth across the business.',
  nonGoalsOrBoundaries: [],
}

const CONCRETE_STRATEGIC_OBJECTIVE = {
  summary:              'Product & Competitive Architecture owns the explainability infrastructure for AaaS BSA/AML outputs, ensuring SR 11-7 compliance by building modular, internally-controlled architecture.',
  outcomeFocus:         'By owning the connector layer and schema contracts, this BU eliminates dependence on Fiddler AI-managed explainability output formats, reducing audit risk and enabling faster regulatory iteration.',
  nonGoalsOrBoundaries: ['Does not own generative AI output generation', 'Excludes non-BSA/AML explainability use cases', 'Does not manage model training pipelines'],
}

// ── weaselDensity ─────────────────────────────────────────────────────────────

describe('weaselDensity', () => {
  it('returns 0 for text with no weasel words', () => {
    expect(weaselDensity('The connector build starts in Sprint 2. The gate closes when contracts are signed.')).toBe(0)
  })

  it('returns high density for heavy hedging', () => {
    const text = 'This could work well. It may be appropriate. We might consider this approach. As needed, this should work.'
    expect(weaselDensity(text)).toBeGreaterThan(0.5)
  })

  it('handles empty input', () => {
    expect(weaselDensity('')).toBe(0)
    expect(weaselDensity(null)).toBe(0)
  })
})

// ── detectMechanicalPhrases ───────────────────────────────────────────────────

describe('detectMechanicalPhrases', () => {
  it('detects best practices', () => {
    expect(detectMechanicalPhrases('This follows industry best practices.')).toHaveLength(1)
  })

  it('detects multiple mechanical phrases', () => {
    const findings = detectMechanicalPhrases('We leverage existing best practices to ensure alignment and deliver value.')
    expect(findings.length).toBeGreaterThanOrEqual(2)
  })

  it('returns empty array for clean text', () => {
    expect(detectMechanicalPhrases('Sprint 2 connector build begins after schema contracts are signed.')).toHaveLength(0)
  })
})

// ── auditExecutionSequenceStrength ────────────────────────────────────────────

describe('auditExecutionSequenceStrength — generic method library fails', () => {
  it('FAILS a generic method-library execution sequence', () => {
    const audit = auditExecutionSequenceStrength(GENERIC_EXEC_SEQUENCE)
    expect(audit.status).toBe(STRENGTH_STATUSES.FAILED)
    expect(audit.findings.length).toBeGreaterThan(0)
    expect(audit.score).toBeLessThan(35)
  })

  it('detects howOptions domination in generic panel', () => {
    const audit = auditExecutionSequenceStrength(GENERIC_EXEC_SEQUENCE)
    const hasHowOptionsFinding = audit.downstreamUsefulnessFindings.some(f =>
      f.includes('howOptions') || f.includes('option menu') || f.includes('method library')
    )
    expect(hasHowOptionsFinding).toBe(true)
  })

  it('detects "when to use" / whenToUse option-menu framing', () => {
    const audit = auditExecutionSequenceStrength(GENERIC_EXEC_SEQUENCE)
    const hasWhenToUse = audit.downstreamUsefulnessFindings.some(f =>
      /when.to.use/i.test(f) || f.includes('option-menu') || f.includes('whenToUse')
    )
    expect(hasWhenToUse).toBe(true)
  })

  it('PASSES a concrete, committed execution sequence', () => {
    const audit = auditExecutionSequenceStrength(CONCRETE_EXEC_SEQUENCE)
    expect([STRENGTH_STATUSES.STRONG, STRENGTH_STATUSES.ADEQUATE]).toContain(audit.status)
  })

  it('concrete sequence has score ≥ 60', () => {
    const audit = auditExecutionSequenceStrength(CONCRETE_EXEC_SEQUENCE)
    expect(audit.score).toBeGreaterThanOrEqual(60)
  })

  it('FAILS on empty content', () => {
    const audit = auditExecutionSequenceStrength([])
    expect(audit.status).toBe(STRENGTH_STATUSES.FAILED)
  })

  it('strength audit does not fail merely because a section is detailed', () => {
    // A panel with detailed content (many fields, long text) should not be penalized for being detailed
    const detailedPanel = CONCRETE_EXEC_SEQUENCE.map(p => ({
      ...p,
      evidenceExamples: [...(p.evidenceExamples || []), 'Additional detailed evidence item', 'Another concrete output with specifics'],
    }))
    const audit = auditExecutionSequenceStrength(detailedPanel)
    expect([STRENGTH_STATUSES.STRONG, STRENGTH_STATUSES.ADEQUATE]).toContain(audit.status)
  })
})

// ── auditCriticalDecisionsStrength ────────────────────────────────────────────

describe('auditCriticalDecisionsStrength — task vs choice detection', () => {
  it('FAILS when decisions are tasks not choices', () => {
    const audit = auditCriticalDecisionsStrength(TASK_LIKE_DECISIONS)
    expect([STRENGTH_STATUSES.WEAK, STRENGTH_STATUSES.FAILED]).toContain(audit.status)
    expect(audit.parentAlignmentFindings.length).toBeGreaterThan(0)
  })

  it('flags task-like decisions in alignment findings', () => {
    const audit = auditCriticalDecisionsStrength(TASK_LIKE_DECISIONS)
    const taskFinding = audit.parentAlignmentFindings.some(f => f.includes('task or work item'))
    expect(taskFinding).toBe(true)
  })

  it('PASSES when decisions are real unresolved choices', () => {
    const audit = auditCriticalDecisionsStrength(REAL_DECISIONS)
    expect([STRENGTH_STATUSES.STRONG, STRENGTH_STATUSES.ADEQUATE]).toContain(audit.status)
  })

  it('flags generic decisionTiming', () => {
    const audit = auditCriticalDecisionsStrength(TASK_LIKE_DECISIONS)
    const timingFinding = audit.specificityFindings.some(f => f.includes('decisionTiming'))
    expect(timingFinding).toBe(true)
  })

  it('FAILS on empty content', () => {
    const audit = auditCriticalDecisionsStrength([])
    expect(audit.status).toBe(STRENGTH_STATUSES.FAILED)
  })
})

// ── auditDependenciesStrength ─────────────────────────────────────────────────

describe('auditDependenciesStrength — requiredInput copy detection', () => {
  it('FAILS when requiredInput is a copy of dependencyDescription', () => {
    const audit = auditDependenciesStrength(COPY_PASTE_DEPENDENCIES)
    expect([STRENGTH_STATUSES.WEAK, STRENGTH_STATUSES.FAILED]).toContain(audit.status)
    const copyFinding = audit.specificityFindings.some(f =>
      f.includes('copy') || f.includes('restatement')
    )
    expect(copyFinding).toBe(true)
  })

  it('PASSES with concrete dependencies', () => {
    const audit = auditDependenciesStrength(CONCRETE_DEPENDENCIES)
    expect([STRENGTH_STATUSES.STRONG, STRENGTH_STATUSES.ADEQUATE]).toContain(audit.status)
  })

  it('flags generic consequenceIfMissing', () => {
    const audit = auditDependenciesStrength(COPY_PASTE_DEPENDENCIES)
    const consequenceFinding = audit.specificityFindings.some(f =>
      f.includes('consequenceIfMissing') || f.includes('generic')
    )
    expect(consequenceFinding).toBe(true)
  })
})

// ── auditRisksStrength ────────────────────────────────────────────────────────

describe('auditRisksStrength — generic vs BU-specific risks', () => {
  it('FAILS when risks are generic SaaS delivery anxieties', () => {
    const audit = auditRisksStrength(GENERIC_RISKS)
    expect([STRENGTH_STATUSES.WEAK, STRENGTH_STATUSES.FAILED]).toContain(audit.status)
  })

  it('flags generic risk descriptions in alignment findings', () => {
    const audit = auditRisksStrength(GENERIC_RISKS)
    const genericFinding = audit.parentAlignmentFindings.some(f =>
      f.includes('generic') || f.includes('universal SaaS delivery concern')
    )
    expect(genericFinding).toBe(true)
  })

  it('PASSES with specific BU-relevant risks', () => {
    const audit = auditRisksStrength(SPECIFIC_RISKS)
    expect([STRENGTH_STATUSES.STRONG, STRENGTH_STATUSES.ADEQUATE]).toContain(audit.status)
  })

  it('flags generic mitigation options', () => {
    const audit = auditRisksStrength(GENERIC_RISKS)
    const mitigationFinding = audit.specificityFindings.some(f =>
      f.includes('mitigationOptions') && f.includes('generic')
    )
    expect(mitigationFinding).toBe(true)
  })
})

// ── auditValidationFrameworkStrength ─────────────────────────────────────────

describe('auditValidationFrameworkStrength — boilerplate detection', () => {
  it('FAILS when validation items share generic boilerplate', () => {
    const audit = auditValidationFrameworkStrength(BOILERPLATE_VALIDATION)
    expect([STRENGTH_STATUSES.WEAK, STRENGTH_STATUSES.FAILED]).toContain(audit.status)
  })

  it('flags generic evidence examples', () => {
    const audit = auditValidationFrameworkStrength(BOILERPLATE_VALIDATION)
    expect(audit.specificityFindings.length).toBeGreaterThan(0)
  })

  it('PASSES with specific validation criteria', () => {
    const audit = auditValidationFrameworkStrength(SPECIFIC_VALIDATION)
    expect([STRENGTH_STATUSES.STRONG, STRENGTH_STATUSES.ADEQUATE]).toContain(audit.status)
  })
})

// ── auditStrategicObjectiveStrength ───────────────────────────────────────────

describe('auditStrategicObjectiveStrength', () => {
  it('FAILS a generic two-word strategic objective', () => {
    const audit = auditStrategicObjectiveStrength(GENERIC_STRATEGIC_OBJECTIVE)
    expect([STRENGTH_STATUSES.WEAK, STRENGTH_STATUSES.FAILED]).toContain(audit.status)
  })

  it('PASSES a concrete, bounded strategic objective', () => {
    const audit = auditStrategicObjectiveStrength(CONCRETE_STRATEGIC_OBJECTIVE)
    expect([STRENGTH_STATUSES.STRONG, STRENGTH_STATUSES.ADEQUATE]).toContain(audit.status)
  })

  it('flags missing nonGoalsOrBoundaries', () => {
    const audit = auditStrategicObjectiveStrength({ ...CONCRETE_STRATEGIC_OBJECTIVE, nonGoalsOrBoundaries: [] })
    const finding = audit.parentAlignmentFindings.some(f => f.includes('nonGoals') || f.includes('boundary') || f.includes('unbounded'))
    expect(finding).toBe(true)
  })
})

// ── auditPanelStrength (dispatch) ─────────────────────────────────────────────

describe('auditPanelStrength — dispatch to correct per-panel audit', () => {
  it('dispatches executionSequence correctly', () => {
    const audit = auditPanelStrength('executionSequence', GENERIC_EXEC_SEQUENCE)
    expect(audit.status).toBe(STRENGTH_STATUSES.FAILED)
  })

  it('dispatches criticalDecisions correctly', () => {
    const audit = auditPanelStrength('criticalDecisions', REAL_DECISIONS)
    expect([STRENGTH_STATUSES.STRONG, STRENGTH_STATUSES.ADEQUATE]).toContain(audit.status)
  })

  it('returns FAILED for null content', () => {
    const audit = auditPanelStrength('executionSequence', null)
    expect(audit.status).toBe(STRENGTH_STATUSES.FAILED)
  })

  it('returns FAILED for empty array content', () => {
    const audit = auditPanelStrength('risks', [])
    expect(audit.status).toBe(STRENGTH_STATUSES.FAILED)
  })

  it('always returns required shape', () => {
    const audit = auditPanelStrength('executionSequence', CONCRETE_EXEC_SEQUENCE)
    expect(typeof audit.status).toBe('string')
    expect(typeof audit.score).toBe('number')
    expect(Array.isArray(audit.findings)).toBe(true)
    expect(Array.isArray(audit.mechanicalTextFindings)).toBe(true)
    expect(Array.isArray(audit.parentAlignmentFindings)).toBe(true)
    expect(Array.isArray(audit.specificityFindings)).toBe(true)
    expect(Array.isArray(audit.downstreamUsefulnessFindings)).toBe(true)
    expect(typeof audit.recommendedAction).toBe('string')
    expect(typeof audit.auditedAt).toBe('string')
  })
})

// ── strengthAuditBlocks ───────────────────────────────────────────────────────

describe('strengthAuditBlocks — Stage 4 readiness gate', () => {
  it('blocks when status is WEAK', () => {
    expect(strengthAuditBlocks({ status: STRENGTH_STATUSES.WEAK })).toBe(true)
  })

  it('blocks when status is FAILED', () => {
    expect(strengthAuditBlocks({ status: STRENGTH_STATUSES.FAILED })).toBe(true)
  })

  it('does NOT block when status is ADEQUATE', () => {
    expect(strengthAuditBlocks({ status: STRENGTH_STATUSES.ADEQUATE })).toBe(false)
  })

  it('does NOT block when status is STRONG', () => {
    expect(strengthAuditBlocks({ status: STRENGTH_STATUSES.STRONG })).toBe(false)
  })

  it('does NOT block when audit is null (no audit run yet)', () => {
    expect(strengthAuditBlocks(null)).toBe(false)
  })
})

// ── Structurally complete but document-strength weak ─────────────────────────

describe('structurally complete panel can still be NEEDS_STRENGTHENING', () => {
  it('generic execution sequence passes schema checks but fails strength', () => {
    // Verify this content has all required fields (structurally complete)
    const requiredFields = ['phaseName', 'phaseObjective', 'recommendedHow', 'exitCriteria']
    GENERIC_EXEC_SEQUENCE.forEach(phase => {
      requiredFields.forEach(f => expect(phase[f]).toBeTruthy())
    })

    // But fails strength audit
    const strengthAudit = auditExecutionSequenceStrength(GENERIC_EXEC_SEQUENCE)
    expect([STRENGTH_STATUSES.WEAK, STRENGTH_STATUSES.FAILED]).toContain(strengthAudit.status)
    expect(strengthAuditBlocks(strengthAudit)).toBe(true)
  })
})
