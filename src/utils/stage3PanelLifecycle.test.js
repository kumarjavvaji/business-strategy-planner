/**
 * Tests for stage3PanelLifecycle — getPanelIssueList (D9), computeLifecycleReadiness (D22).
 */

import { describe, it, expect } from 'vitest'
import { getPanelIssueList, countPanelIssues, computeLifecycleReadiness, PANEL_LIFECYCLE } from './stage3PanelLifecycle'
import { PANEL_AUDIT_STATUSES } from './stage3PanelModel'

// ── D9 — Inspectable issue list ───────────────────────────────────────────────

function makePanelWithIssues({ lifecycle = PANEL_LIFECYCLE.NEEDS_REFINEMENT, audit = {}, strengthAudit = null } = {}) {
  return {
    panelId: 'criticalDecisions',
    lifecycle,
    lifecycleError: null,
    completenessAudit: {
      status:               PANEL_AUDIT_STATUSES.NEEDS_REFINEMENT,
      missingFields:        [],
      truncatedFields:      [],
      weakFields:           [],
      duplicateFieldFindings: [],
      punctuationIssues:    [],
      autoRepairs:          [],
      ...audit,
    },
    panelStrengthAudit: strengthAudit,
  }
}

describe('getPanelIssueList — D9 inspectable issue counts', () => {
  it('returns empty list when panel has no issues', () => {
    const panel = makePanelWithIssues({
      lifecycle: PANEL_LIFECYCLE.ACCEPTED,
      audit: { status: PANEL_AUDIT_STATUSES.COMPLETE, missingFields: [], truncatedFields: [], weakFields: [], duplicateFieldFindings: [], punctuationIssues: [], autoRepairs: [] },
    })
    expect(getPanelIssueList(panel, null)).toHaveLength(0)
  })

  it('returns missing_required_field issues with blocking severity', () => {
    const panel = makePanelWithIssues({
      audit: {
        status:        PANEL_AUDIT_STATUSES.INCOMPLETE,
        missingFields: ['criticalDecisions[0].decisionQuestion', 'criticalDecisions[0].whyItMatters'],
        truncatedFields: [], weakFields: [], duplicateFieldFindings: [],
        punctuationIssues: [], autoRepairs: [],
      },
    })
    const issues = getPanelIssueList(panel, null)
    const missingIssues = issues.filter(i => i.issueType === 'missing_required_field')
    expect(missingIssues).toHaveLength(2)
    expect(missingIssues[0].severity).toBe('blocking')
    expect(missingIssues[0].blocksStage4).toBe(true)
    expect(missingIssues[0].remediationHint).toBeTruthy()
  })

  it('returns genuinely_truncated issues with blocking severity', () => {
    const panel = makePanelWithIssues({
      audit: {
        status:         PANEL_AUDIT_STATUSES.TRUNCATED,
        truncatedFields: ['criticalDecisions[0].decisionQuestion: ends with partial word'],
        missingFields: [], weakFields: [], duplicateFieldFindings: [],
        punctuationIssues: [], autoRepairs: [],
      },
    })
    const issues = getPanelIssueList(panel, null)
    const truncIssues = issues.filter(i => i.issueType === 'genuinely_truncated')
    expect(truncIssues).toHaveLength(1)
    expect(truncIssues[0].severity).toBe('blocking')
    expect(truncIssues[0].blocksStage4).toBe(true)
    expect(truncIssues[0].remediationHint).toContain('Regenerate')
  })

  it('returns missing_terminal_punctuation issues as advisory (non-blocking)', () => {
    const panel = makePanelWithIssues({
      audit: {
        status:         PANEL_AUDIT_STATUSES.COMPLETE,
        punctuationIssues: ['criticalDecisions[0].decisionQuestion'],
        autoRepairs: [{
          fieldPath: 'criticalDecisions[0].decisionQuestion',
          field: 'decisionQuestion',
          itemLabel: 'criticalDecisions[0]',
          issueType: 'missing_terminal_punctuation',
          repairedValue: 'Which path should we choose?.',
          autoFixable: true,
        }],
        missingFields: [], truncatedFields: [], weakFields: [], duplicateFieldFindings: [],
      },
    })
    const issues = getPanelIssueList(panel, null)
    const punctIssues = issues.filter(i => i.issueType === 'missing_terminal_punctuation')
    expect(punctIssues).toHaveLength(1)
    expect(punctIssues[0].severity).toBe('advisory')
    expect(punctIssues[0].blocksStage4).toBe(false)
    expect(punctIssues[0].autoFixable).toBe(true)
    expect(punctIssues[0].repairedValue).toBeTruthy()
  })

  it('returns lifecycle_failed issue when panel is failed', () => {
    const panel = {
      panelId: 'dependencies',
      lifecycle: PANEL_LIFECYCLE.FAILED,
      lifecycleError: 'Generation timed out.',
      completenessAudit: null,
      panelStrengthAudit: null,
    }
    const issues = getPanelIssueList(panel, null)
    expect(issues.some(i => i.issueType === 'lifecycle_failed')).toBe(true)
    expect(issues.find(i => i.issueType === 'lifecycle_failed').description).toContain('Generation timed out')
  })

  it('every issue has all required fields', () => {
    const panel = makePanelWithIssues({
      audit: {
        status:         PANEL_AUDIT_STATUSES.INCOMPLETE,
        missingFields:  ['criticalDecisions[0].decisionQuestion'],
        truncatedFields: ['criticalDecisions[0].whyItMatters: ends with partial word'],
        weakFields:     ['criticalDecisions[0].decisionName: contains placeholder'],
        duplicateFieldFindings: ['criticalDecisions[0].decisionQuestion ≈ whyItMatters'],
        punctuationIssues: ['criticalDecisions[0].decisionTiming'],
        autoRepairs: [{ fieldPath: 'criticalDecisions[0].decisionTiming', field: 'decisionTiming', itemLabel: 'criticalDecisions[0]', issueType: 'missing_terminal_punctuation', repairedValue: 'Fix.', autoFixable: true }],
      },
    })
    const issues = getPanelIssueList(panel, null)
    expect(issues.length).toBeGreaterThan(0)
    issues.forEach(issue => {
      expect(issue.issueId).toBeTruthy()
      expect(issue.panelId).toBe('criticalDecisions')
      expect(issue.issueType).toBeTruthy()
      expect(typeof issue.severity).toBe('string')
      expect(typeof issue.blocksStage4).toBe('boolean')
      expect(typeof issue.autoFixable).toBe('boolean')
      expect(issue.remediationHint).toBeTruthy()
    })
  })

  it('cross-panel issues are included when crossPanelAudit is provided', () => {
    const panel = makePanelWithIssues({
      audit: { status: PANEL_AUDIT_STATUSES.COMPLETE, missingFields: [], truncatedFields: [], weakFields: [], duplicateFieldFindings: [], punctuationIssues: [], autoRepairs: [] },
    })
    const crossPanelAudit = {
      qualityStatus: 'fail',
      repeatedPhrases: [],
      duplicatedFieldPairs: [
        { source: 'criticalDecisions.decisionQuestion', target: 'dependencies.dependencyDescription', note: 'Decision rationale copied' },
      ],
      misplacedContentFindings: [],
    }
    const issues = getPanelIssueList(panel, crossPanelAudit)
    expect(issues.some(i => i.issueType === 'schema_mismatch')).toBe(true)
    expect(issues.find(i => i.issueType === 'schema_mismatch').blocksStage4).toBe(true)
  })

  it('countPanelIssues still returns a number (backward compat)', () => {
    const panel = makePanelWithIssues({
      audit: {
        status: PANEL_AUDIT_STATUSES.INCOMPLETE,
        missingFields: ['field1', 'field2'],
        truncatedFields: [], weakFields: [], duplicateFieldFindings: [],
        punctuationIssues: [], autoRepairs: [],
      },
    })
    expect(typeof countPanelIssues(panel, null)).toBe('number')
    expect(countPanelIssues(panel, null)).toBeGreaterThan(0)
  })

  it('truncatedFields produces blocking genuinely_truncated issues (D6)', () => {
    const panel = makePanelWithIssues({
      lifecycle: PANEL_LIFECYCLE.NEEDS_REFINEMENT,
      audit: {
        status: PANEL_AUDIT_STATUSES.TRUNCATED,
        truncatedFields: [
          'dependencies[0].dependencyDescription: ends mid-sentence',
          'risks[1].riskDescription: truncated at max_tokens',
        ],
        missingFields: [], weakFields: [], duplicateFieldFindings: [],
        punctuationIssues: [], autoRepairs: [],
      },
    })
    const issues = getPanelIssueList(panel, null)
    const truncated = issues.filter(i => i.issueType === 'genuinely_truncated')
    expect(truncated).toHaveLength(2)
    truncated.forEach(issue => {
      expect(issue.severity).toBe('blocking')
      expect(issue.blocksStage4).toBe(true)
      expect(issue.remediationHint).toContain('Regenerate')
    })
  })

  it('weakFields produce underfilled issues with warning severity (D6)', () => {
    const panel = makePanelWithIssues({
      lifecycle: PANEL_LIFECYCLE.DRAFT_READY,
      audit: {
        status: PANEL_AUDIT_STATUSES.NEEDS_REFINEMENT,
        weakFields: [
          'validationFramework[0].completionCriteria: too generic',
          'validationFramework[1].evidenceExamples: placeholder only',
        ],
        missingFields: [], truncatedFields: [], duplicateFieldFindings: [],
        punctuationIssues: [], autoRepairs: [],
      },
    })
    const issues = getPanelIssueList(panel, null)
    const underfilled = issues.filter(i => i.issueType === 'underfilled')
    expect(underfilled.length).toBeGreaterThanOrEqual(2)
    underfilled.forEach(issue => {
      expect(issue.severity).toBe('warning')
      expect(issue.blocksStage4).toBe(false)
    })
  })
})

// ── D22 — Execution Sequence mapping inconsistency ────────────────────────────

function makeAcceptedExecPanel(selectedDeliverableTypes = [], howOptionMappings = {}) {
  return {
    panelId: 'executionSequence',
    lifecycle: PANEL_LIFECYCLE.ACCEPTED,
    completenessAudit: { status: PANEL_AUDIT_STATUSES.COMPLETE, missingFields: [], truncatedFields: [], weakFields: [], duplicateFieldFindings: [], punctuationIssues: [], autoRepairs: [] },
    panelStrengthAudit: null,
    content: [
      {
        phaseName: 'Problem & Outcome Validation',
        phaseObjective: 'Validate the problem.',
        recommendedHow: 'Workshop.',
        exitCriteria: 'Sign-off achieved.',
        howOptions: [
          { optionName: 'Regulatory Gap Mapping Workshop' },
          { optionName: 'Peer Institution Benchmarking' },
        ],
      },
    ],
    executionDeliverableMappings: {
      problem_outcome_validation: {
        phaseName: 'Problem & Outcome Validation',
        howOptionMappings: {
          regulatory_gap_mapping_workshop: {
            optionName: 'Regulatory Gap Mapping Workshop',
            mappedDeliverables: howOptionMappings.regulatory_gap_mapping_workshop || [],
            mappingStatus: (howOptionMappings.regulatory_gap_mapping_workshop || []).length ? 'user_confirmed' : 'suggested',
          },
          peer_institution_benchmarking: {
            optionName: 'Peer Institution Benchmarking',
            mappedDeliverables: howOptionMappings.peer_institution_benchmarking || [],
            mappingStatus: 'suggested',
          },
        },
      },
    },
    selectedStage4Deliverables: selectedDeliverableTypes.map(deliverableType => ({
      deliverableType,
      status: 'user_selected',
      selectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
  }
}

function makeAllAcceptedPanels(execPanel) {
  const accepted = { status: PANEL_AUDIT_STATUSES.COMPLETE, missingFields: [], truncatedFields: [], weakFields: [], duplicateFieldFindings: [], punctuationIssues: [], autoRepairs: [] }
  return {
    strategicObjective:  { panelId: 'strategicObjective',  lifecycle: PANEL_LIFECYCLE.ACCEPTED, completenessAudit: accepted, panelStrengthAudit: null },
    criticalDecisions:   { panelId: 'criticalDecisions',   lifecycle: PANEL_LIFECYCLE.ACCEPTED, completenessAudit: accepted, panelStrengthAudit: null },
    executionSequence:   execPanel,
    dependencies:        { panelId: 'dependencies',        lifecycle: PANEL_LIFECYCLE.ACCEPTED, completenessAudit: accepted, panelStrengthAudit: null },
    risks:               { panelId: 'risks',               lifecycle: PANEL_LIFECYCLE.ACCEPTED, completenessAudit: accepted, panelStrengthAudit: null },
    validationFramework: { panelId: 'validationFramework', lifecycle: PANEL_LIFECYCLE.ACCEPTED, completenessAudit: accepted, panelStrengthAudit: null },
  }
}

const PASS_CROSS_PANEL = { qualityStatus: 'pass', repeatedPhrases: [], duplicatedFieldPairs: [], misplacedContentFindings: [], planAlignmentFindings: [] }

describe('computeLifecycleReadiness — D22 mapping inconsistency', () => {
  it('returns empty unmappedSelectedDeliverables when no deliverables are selected', () => {
    const panels = makeAllAcceptedPanels(makeAcceptedExecPanel([], {}))
    const result = computeLifecycleReadiness(panels, PASS_CROSS_PANEL)
    expect(result.unmappedSelectedDeliverables).toEqual([])
    expect(result.mappingWarnings).toHaveLength(0)
  })

  it('returns empty unmappedSelectedDeliverables when all selected deliverables are mapped', () => {
    const panels = makeAllAcceptedPanels(makeAcceptedExecPanel(
      ['executive_decision_brief'],
      { regulatory_gap_mapping_workshop: ['executive_decision_brief'] }
    ))
    const result = computeLifecycleReadiness(panels, PASS_CROSS_PANEL)
    expect(result.unmappedSelectedDeliverables).toEqual([])
    expect(result.mappingWarnings).toHaveLength(0)
  })

  it('D22: names the specific deliverable ID in unmappedSelectedDeliverables and warning', () => {
    const panels = makeAllAcceptedPanels(makeAcceptedExecPanel(
      ['bu_execution_plan'],
      {} // no how-option mapped to bu_execution_plan
    ))
    const result = computeLifecycleReadiness(panels, PASS_CROSS_PANEL)
    expect(result.unmappedSelectedDeliverables).toContain('bu_execution_plan')
    expect(result.mappingWarnings).toHaveLength(1)
    expect(result.mappingWarnings[0]).toContain('bu_execution_plan')
  })

  it('D22: lists all unmapped deliverable IDs when multiple are missing mappings', () => {
    const panels = makeAllAcceptedPanels(makeAcceptedExecPanel(
      ['bu_execution_plan', 'risk_control_plan', 'executive_decision_brief'],
      { regulatory_gap_mapping_workshop: ['executive_decision_brief'] }
    ))
    const result = computeLifecycleReadiness(panels, PASS_CROSS_PANEL)
    expect(result.unmappedSelectedDeliverables).toContain('bu_execution_plan')
    expect(result.unmappedSelectedDeliverables).toContain('risk_control_plan')
    expect(result.unmappedSelectedDeliverables).not.toContain('executive_decision_brief')
    expect(result.mappingWarnings[0]).toContain('bu_execution_plan')
    expect(result.mappingWarnings[0]).toContain('risk_control_plan')
  })

  it('D22: execPanel not accepted → unmappedSelectedDeliverables is empty (no premature warning)', () => {
    const panels = makeAllAcceptedPanels({
      ...makeAcceptedExecPanel(['bu_execution_plan'], {}),
      lifecycle: PANEL_LIFECYCLE.DRAFT_READY,
    })
    const result = computeLifecycleReadiness(panels, PASS_CROSS_PANEL)
    expect(result.unmappedSelectedDeliverables).toEqual([])
    expect(result.mappingWarnings).toHaveLength(0)
  })
})
