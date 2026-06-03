/**
 * Tests for Stage 5 learning signal collection and normalisation.
 * All collection functions are pure — no IDB, no mocking required.
 */

import { describe, it, expect } from 'vitest'
import {
  SIGNAL_TYPES,
  collectStage1Signals,
  collectStage2Signals,
  collectStage3Signals,
  collectStage4Signals,
  compileStage5LearningSignals,
  diagnoseStage5LearningSignals,
  stage5LearningSignalsKey,
} from './stage5LearningSignals'

// ── Fixtures ───────────────────────────────────────────────────────────────────

const STAGE1_REVISION = {
  id: 'rev_s1_1',
  revisionNumber: 1,
  label: 'Initial import',
  createdAt: '2024-01-10T09:00:00.000Z',
  source: 'ai',
  learningSignals: [
    {
      stage: '1',
      category: 'Refinement patterns',
      text: 'User corrected the framing of the strategic thesis to emphasise competitive differentiation over market expansion, indicating the original prompt weighed market size too heavily.',
      source: 'heuristic',
    },
    {
      stage: '1',
      category: 'Evidence gaps',
      text: 'Unresolved question about regulatory approval timeline was carried forward without a confirmed resolution path, which will surface as an assumption in Stage 3 execution planning.',
      source: 'api',
    },
  ],
  contentSnapshot: {
    unresolvedQuestions: ['What is the regulatory approval timeline?', 'Who owns the compliance review?'],
  },
}

const STAGE1_REVISION_NO_SIGNALS = {
  id: 'rev_s1_2',
  revisionNumber: 2,
  label: 'Minor wording update',
  createdAt: '2024-01-11T10:00:00.000Z',
  source: 'manual',
  learningSignals: [],
  contentSnapshot: {},
}

const STAGE2_REVISION = {
  id: 'rev_s2_1',
  revisionNumber: 1,
  label: 'Added BU Alpha',
  createdAt: '2024-01-15T09:00:00.000Z',
  source: 'ai',
  affectedUnit: 'BU Alpha',
  refinementType: 'unit',
  refinementScope: 'ownership',
  structuralImpact: 'unit_added',
  refinementClassification: 'ownership_clarification',
  impactSummary: 'BU Alpha was added after recognising its delivery role in the digital platform workstream.',
  learningSignals: [
    {
      stage: '2',
      category: 'Stage-boundary lessons',
      text: 'Adding a new BU at Stage 2 after initial generation required full Stage 3 regeneration for the affected BU, confirming that BU scope decisions should be stabilised before execution planning begins.',
      source: 'heuristic',
    },
  ],
}

const STAGE2_REVISION_DEPENDENCIES = {
  id: 'rev_s2_2',
  revisionNumber: 2,
  label: 'Dependency update',
  createdAt: '2024-01-17T12:00:00.000Z',
  source: 'ai',
  affectedUnit: null,
  refinementType: 'stage',
  structuralImpact: 'dependencies_changed',
  impactSummary: 'Cross-BU dependency from BU Alpha to BU Beta was added after discovering a shared data platform requirement.',
  learningSignals: [],
}

const STAGE3_REVISION = {
  id: 'rev_s3_1',
  revisionNumber: 1,
  label: 'Stage 3 initial',
  createdAt: '2024-01-20T09:00:00.000Z',
  source: 'ai',
  affectedUnit: 'BU Beta',
  structuralImpact: 'none',
  impactSummary: '',
  learningSignals: [
    {
      stage: '3',
      category: 'Failure modes',
      text: 'Execution planning for BU Beta required three regeneration attempts before producing valid atom outputs, suggesting the BU profile prompt needs more specific operational context before generation is attempted.',
      source: 'api',
    },
  ],
}

const BU_PLAN_RECORD_COMPLETE = {
  buName: 'BU Alpha',
  persistedAt: '2024-01-20T10:00:00.000Z',
  lifecycle: { status: 'draft_generated' },
  atomSummary: '6/6 atoms complete',
  executionAtoms: [
    { id: 'atom_1', type: 'workstream', status: 'complete' },
    { id: 'atom_2', type: 'gate',       status: 'complete' },
  ],
}

const BU_PLAN_RECORD_PARTIAL = {
  buName: 'BU Beta',
  persistedAt: '2024-01-20T11:00:00.000Z',
  lifecycle: { status: 'partial_draft' },
  atomSummary: '3/6 atoms complete',
  executionAtoms: [
    { id: 'atom_3', type: 'workstream', status: 'complete' },
    { id: 'atom_4', type: 'gate',       status: 'max_tokens' },
    { id: 'atom_5', type: 'risk',       status: 'parser_error' },
  ],
}

const ARTIFACT_OUTPUT_STRONG = {
  artifactId: 'bu_execution_plan_bu_alpha',
  title: 'BU Alpha Execution Plan',
  artifactType: 'bu_execution_plan',
  generationStatus: 'generated',
  artifactGenerationStatus: 'generated',
  persistedAt: '2024-01-25T10:00:00.000Z',
  reviewStatus: 'strong',
  reviewDimensions: {
    strategicClarity:       { rating: 5, comment: 'Very clear strategic framing.' },
    executionSpecificity:   { rating: 4, comment: '' },
    smeReviewability:       { rating: 5, comment: '' },
  },
  improvementNotes: '',
  reviewUpdatedAt: '2024-01-26T09:00:00.000Z',
  qualityAudit: {
    status: 'strong',
    findings: [],
    checkedAt: '2024-01-25T10:00:00.000Z',
  },
}

const ARTIFACT_OUTPUT_WITH_FINDINGS = {
  artifactId: 'executive_decision_brief_global',
  title: 'Executive Decision Brief',
  artifactType: 'executive_decision_brief',
  generationStatus: 'generated',
  artifactGenerationStatus: 'generated',
  persistedAt: '2024-01-25T11:00:00.000Z',
  reviewStatus: 'needs_revision',
  reviewDimensions: {
    strategicClarity:       { rating: 2, comment: 'Strategic framing feels generic.' },
    executionSpecificity:   { rating: 3, comment: '' },
    redundancyIssues:       { rating: 2, comment: 'Several sentences repeat the same point.' },
  },
  improvementNotes: 'The recommended next steps section lacks specific owners and timelines.',
  reviewUpdatedAt: '2024-01-26T10:00:00.000Z',
  qualityAudit: {
    status: 'needs_revision',
    findings: [
      { type: 'repeated_section_language', severity: 'blocking',  detail: 'Repeated sentence appears in sections 2 and 4.' },
      { type: 'generic_consultant_filler', severity: 'warning',   detail: 'Generic phrase detected: stakeholder alignment.' },
      { type: 'missing_mapped_tactic',     severity: 'blocking',  detail: 'Mapped tactic omitted: Threat-Modeled Architecture Review.' },
    ],
    checkedAt: '2024-01-25T11:00:00.000Z',
  },
}

const ARTIFACT_OUTPUT_PARTIAL = {
  artifactId: 'global_sme_review_packet',
  title: 'Global SME Review Packet',
  artifactType: 'global_sme_review_packet',
  generationStatus: 'partial',
  artifactGenerationStatus: 'partial',
  persistedAt: '2024-01-25T12:00:00.000Z',
  reviewStatus: 'not_reviewed',
  reviewDimensions: {},
  improvementNotes: '',
  qualityAudit: { status: 'failed', findings: [], checkedAt: '2024-01-25T12:00:00.000Z' },
}

function makePlan(opts = {}) {
  return {
    stageRevisions: {
      stage1: opts.stage1 || [],
      stage2: opts.stage2 || [],
      stage3: opts.stage3 || [],
    },
  }
}

// ── Stage 1 ────────────────────────────────────────────────────────────────────

describe('collectStage1Signals', () => {
  it('normalises existing learningSignals to canonical schema', () => {
    const plan    = makePlan({ stage1: [STAGE1_REVISION] })
    const signals = collectStage1Signals(plan)

    expect(signals.length).toBeGreaterThanOrEqual(2)
    for (const s of signals) {
      expect(s.stageId).toBe('1')
      expect(s.signalType).toBeDefined()
      expect(s.summary.length).toBeGreaterThan(20)
      expect(s.impact.length).toBeGreaterThan(10)
      expect(s.createdAt).toBe(STAGE1_REVISION.createdAt)
    }
  })

  it('maps Refinement patterns category to refinement_correction', () => {
    const plan    = makePlan({ stage1: [STAGE1_REVISION] })
    const signals = collectStage1Signals(plan)
    expect(signals.some(s => s.signalType === SIGNAL_TYPES.REFINEMENT_CORRECTION)).toBe(true)
  })

  it('maps Evidence gaps category to evidence_gap', () => {
    const plan    = makePlan({ stage1: [STAGE1_REVISION] })
    const signals = collectStage1Signals(plan)
    expect(signals.some(s => s.signalType === SIGNAL_TYPES.EVIDENCE_GAP)).toBe(true)
  })

  it('derives an evidence_gap signal from unresolvedQuestions in contentSnapshot', () => {
    const plan    = makePlan({ stage1: [STAGE1_REVISION] })
    const signals = collectStage1Signals(plan)
    const derived = signals.find(s => s.signalType === SIGNAL_TYPES.EVIDENCE_GAP && s.summary.includes('unresolved question'))
    expect(derived).toBeDefined()
    expect(derived.summary).toContain('2 unresolved question(s)')
  })

  it('returns empty array for plan with no Stage 1 revisions', () => {
    expect(collectStage1Signals(makePlan())).toEqual([])
    expect(collectStage1Signals(null)).toEqual([])
  })

  it('does not duplicate signals across multiple revisions with the same text', () => {
    const plan = makePlan({ stage1: [STAGE1_REVISION, STAGE1_REVISION] })
    const signals = collectStage1Signals(plan)
    const texts = signals.map(s => s.summary)
    expect(new Set(texts).size).toBe(texts.length)
  })

  it('all signals have required canonical fields', () => {
    const plan    = makePlan({ stage1: [STAGE1_REVISION] })
    const signals = collectStage1Signals(plan)
    for (const s of signals) {
      expect(typeof s.stageId).toBe('string')
      expect(typeof s.signalType).toBe('string')
      expect('sourceArtifactId' in s).toBe(true)
      expect('sourceContext'    in s).toBe(true)
      expect(typeof s.summary).toBe('string')
      expect(typeof s.impact).toBe('string')
      expect(typeof s.createdAt).toBe('string')
    }
  })
})

// ── Stage 2 ────────────────────────────────────────────────────────────────────

describe('collectStage2Signals', () => {
  it('collects learningSignals from revision and derives structural signals', () => {
    const plan    = makePlan({ stage2: [STAGE2_REVISION] })
    const signals = collectStage2Signals(plan)

    expect(signals.some(s => s.signalType === SIGNAL_TYPES.STAGE_BOUNDARY_LESSON)).toBe(true)
    expect(signals.some(s => s.signalType === SIGNAL_TYPES.BU_SELECTION_DECISION)).toBe(true)
  })

  it('maps structuralImpact unit_added to bu_selection_decision', () => {
    const plan    = makePlan({ stage2: [STAGE2_REVISION] })
    const signals = collectStage2Signals(plan)
    const s       = signals.find(s => s.signalType === SIGNAL_TYPES.BU_SELECTION_DECISION)
    expect(s).toBeDefined()
    expect(s.summary).toContain('BU Alpha')
  })

  it('maps structuralImpact dependencies_changed to dependency_change', () => {
    const plan    = makePlan({ stage2: [STAGE2_REVISION_DEPENDENCIES] })
    const signals = collectStage2Signals(plan)
    expect(signals.some(s => s.signalType === SIGNAL_TYPES.DEPENDENCY_CHANGE)).toBe(true)
  })

  it('derives scope_clarification signal for targeted unit refinements', () => {
    const plan    = makePlan({ stage2: [STAGE2_REVISION] })
    const signals = collectStage2Signals(plan)
    expect(signals.some(s => s.signalType === SIGNAL_TYPES.SCOPE_CLARIFICATION)).toBe(true)
  })

  it('all signals have required canonical fields', () => {
    const plan    = makePlan({ stage2: [STAGE2_REVISION, STAGE2_REVISION_DEPENDENCIES] })
    const signals = collectStage2Signals(plan)
    for (const s of signals) {
      expect(s.stageId).toBe('2')
      expect(typeof s.signalType).toBe('string')
      expect(typeof s.impact).toBe('string')
      expect(s.sourceArtifactId).toBeNull()
    }
  })
})

// ── Stage 3 ────────────────────────────────────────────────────────────────────

describe('collectStage3Signals', () => {
  it('collects learningSignals from Stage 3 revisions', () => {
    const plan    = makePlan({ stage3: [STAGE3_REVISION] })
    const signals = collectStage3Signals(plan, [])
    expect(signals.some(s => s.signalType === SIGNAL_TYPES.EXECUTION_GAP || s.signalType === SIGNAL_TYPES.FAILURE_MODE)).toBe(true)
  })

  it('derives handoff_partial signal from partial BU plan record', () => {
    const plan    = makePlan()
    const signals = collectStage3Signals(plan, [BU_PLAN_RECORD_PARTIAL])
    const partial = signals.find(s => s.signalType === SIGNAL_TYPES.HANDOFF_PARTIAL)
    expect(partial).toBeDefined()
    expect(partial.sourceContext).toBe('BU Beta')
    expect(partial.summary).toContain('BU "BU Beta"')
  })

  it('does not emit handoff_partial for complete BU plan records', () => {
    const plan    = makePlan()
    const signals = collectStage3Signals(plan, [BU_PLAN_RECORD_COMPLETE])
    expect(signals.some(s => s.signalType === SIGNAL_TYPES.HANDOFF_PARTIAL)).toBe(false)
  })

  it('derives atom_generation_failed signal from failed atoms', () => {
    const plan    = makePlan()
    const signals = collectStage3Signals(plan, [BU_PLAN_RECORD_PARTIAL])
    const failed  = signals.filter(s => s.signalType === SIGNAL_TYPES.ATOM_GENERATION_FAILED)
    // BU_PLAN_RECORD_PARTIAL has max_tokens and parser_error — 2 distinct statuses
    expect(failed.length).toBe(2)
    expect(failed[0].sourceContext).toContain('BU Beta')
  })

  it('does not emit atom signals for complete atoms', () => {
    const plan    = makePlan()
    const signals = collectStage3Signals(plan, [BU_PLAN_RECORD_COMPLETE])
    expect(signals.some(s => s.signalType === SIGNAL_TYPES.ATOM_GENERATION_FAILED)).toBe(false)
  })

  it('all signals have stageId 3 and required fields', () => {
    const plan    = makePlan({ stage3: [STAGE3_REVISION] })
    const signals = collectStage3Signals(plan, [BU_PLAN_RECORD_PARTIAL])
    for (const s of signals) {
      expect(s.stageId).toBe('3')
      expect(s.signalType).toBeDefined()
      expect(s.impact.length).toBeGreaterThan(10)
      expect(s.createdAt).toBeDefined()
    }
  })
})

// ── Stage 4 ────────────────────────────────────────────────────────────────────

describe('collectStage4Signals', () => {
  it('derives artifact_strong_quality from a reviewed strong artifact', () => {
    const signals = collectStage4Signals([ARTIFACT_OUTPUT_STRONG])
    const s       = signals.find(s => s.signalType === SIGNAL_TYPES.ARTIFACT_STRONG)
    expect(s).toBeDefined()
    expect(s.sourceArtifactId).toBe(ARTIFACT_OUTPUT_STRONG.artifactId)
    expect(s.stageId).toBe('4')
  })

  it('derives quality_redundancy signal from repeated_section_language finding', () => {
    const signals = collectStage4Signals([ARTIFACT_OUTPUT_WITH_FINDINGS])
    const s       = signals.find(s => s.signalType === SIGNAL_TYPES.QUALITY_REDUNDANCY)
    expect(s).toBeDefined()
    expect(s.sourceArtifactId).toBe(ARTIFACT_OUTPUT_WITH_FINDINGS.artifactId)
  })

  it('derives quality_coverage_gap signal from missing_mapped_tactic finding', () => {
    const signals = collectStage4Signals([ARTIFACT_OUTPUT_WITH_FINDINGS])
    expect(signals.some(s => s.signalType === SIGNAL_TYPES.QUALITY_COVERAGE_GAP)).toBe(true)
  })

  it('derives quality_generic_language signal from generic_consultant_filler finding', () => {
    const signals = collectStage4Signals([ARTIFACT_OUTPUT_WITH_FINDINGS])
    expect(signals.some(s => s.signalType === SIGNAL_TYPES.QUALITY_GENERIC_LANGUAGE)).toBe(true)
  })

  it('derives artifact_needs_revision from needs_revision review status', () => {
    const signals = collectStage4Signals([ARTIFACT_OUTPUT_WITH_FINDINGS])
    const s       = signals.find(s => s.signalType === SIGNAL_TYPES.ARTIFACT_NEEDS_REVISION && s.summary.includes('improvement'))
    // Summary includes improvementNotes text
    const rev     = signals.find(s => s.signalType === SIGNAL_TYPES.ARTIFACT_NEEDS_REVISION)
    expect(rev).toBeDefined()
    expect(rev.summary).toContain('Executive Decision Brief')
  })

  it('derives artifact_needs_revision from low-rated review dimensions', () => {
    const signals = collectStage4Signals([ARTIFACT_OUTPUT_WITH_FINDINGS])
    // strategicClarity and redundancyIssues are both rated 2 — both should generate signals
    const dimSignals = signals.filter(s =>
      s.signalType === SIGNAL_TYPES.ARTIFACT_NEEDS_REVISION &&
      s.sourceContext?.includes(':')
    )
    expect(dimSignals.length).toBeGreaterThanOrEqual(2)
  })

  it('derives generation_partial signal for partial artifacts', () => {
    const signals = collectStage4Signals([ARTIFACT_OUTPUT_PARTIAL])
    const s       = signals.find(s => s.signalType === SIGNAL_TYPES.GENERATION_PARTIAL)
    expect(s).toBeDefined()
    expect(s.sourceArtifactId).toBe(ARTIFACT_OUTPUT_PARTIAL.artifactId)
  })

  it('accepts a map of artifact outputs as well as an array', () => {
    const map     = { [ARTIFACT_OUTPUT_STRONG.artifactId]: ARTIFACT_OUTPUT_STRONG }
    const signals = collectStage4Signals(map)
    expect(signals.some(s => s.signalType === SIGNAL_TYPES.ARTIFACT_STRONG)).toBe(true)
  })

  it('all signals have stageId 4 and sourceArtifactId', () => {
    const signals = collectStage4Signals([ARTIFACT_OUTPUT_STRONG, ARTIFACT_OUTPUT_WITH_FINDINGS])
    for (const s of signals) {
      expect(s.stageId).toBe('4')
      expect(s.sourceArtifactId).not.toBeNull()
    }
  })

  it('returns empty array for empty inputs', () => {
    expect(collectStage4Signals([])).toEqual([])
    expect(collectStage4Signals({})).toEqual([])
    expect(collectStage4Signals(null)).toEqual([])
  })
})

// ── compile ────────────────────────────────────────────────────────────────────

describe('compileStage5LearningSignals', () => {
  function makeFull() {
    return compileStage5LearningSignals({
      plan: makePlan({
        stage1: [STAGE1_REVISION],
        stage2: [STAGE2_REVISION, STAGE2_REVISION_DEPENDENCIES],
        stage3: [STAGE3_REVISION],
      }),
      stage3BuPlanRecords: [BU_PLAN_RECORD_COMPLETE, BU_PLAN_RECORD_PARTIAL],
      stage4ArtifactOutputs: [ARTIFACT_OUTPUT_STRONG, ARTIFACT_OUTPUT_WITH_FINDINGS, ARTIFACT_OUTPUT_PARTIAL],
    })
  }

  it('returns version, signals array, counts object, and compiledAt', () => {
    const record = makeFull()
    expect(record.version).toBe(1)
    expect(Array.isArray(record.signals)).toBe(true)
    expect(typeof record.counts).toBe('object')
    expect(typeof record.compiledAt).toBe('string')
  })

  it('counts are accurate per stage', () => {
    const record = makeFull()
    expect(record.counts.stage1).toBeGreaterThan(0)
    expect(record.counts.stage2).toBeGreaterThan(0)
    expect(record.counts.stage3).toBeGreaterThan(0)
    expect(record.counts.stage4).toBeGreaterThan(0)
    expect(record.counts.total).toBe(record.signals.length)
  })

  it('all compiled signals have the required canonical fields', () => {
    const { signals } = makeFull()
    for (const s of signals) {
      expect(['1','2','3','4']).toContain(s.stageId)
      expect(typeof s.signalType).toBe('string')
      expect(typeof s.summary).toBe('string')
      expect(typeof s.impact).toBe('string')
      expect(typeof s.createdAt).toBe('string')
      expect('sourceArtifactId' in s).toBe(true)
      expect('sourceContext'    in s).toBe(true)
    }
  })

  it('deduplicates signals with identical stageId + signalType + summary prefix', () => {
    // Pass the same Stage 4 output twice — signals should not double-count
    const record = compileStage5LearningSignals({
      plan: makePlan(),
      stage3BuPlanRecords: [],
      stage4ArtifactOutputs: [ARTIFACT_OUTPUT_STRONG, ARTIFACT_OUTPUT_STRONG],
    })
    const strongSignals = record.signals.filter(s => s.signalType === SIGNAL_TYPES.ARTIFACT_STRONG)
    expect(strongSignals.length).toBe(1)
  })
})

// ── diagnose ───────────────────────────────────────────────────────────────────

describe('diagnoseStage5LearningSignals', () => {
  it('returns zeroed counts and readyForStage5=false for null input', () => {
    const d = diagnoseStage5LearningSignals(null)
    expect(d.total).toBe(0)
    expect(d.readyForStage5).toBe(false)
    expect(d.stage1.count).toBe(0)
    expect(d.stage4.count).toBe(0)
  })

  it('counts signals by stage correctly', () => {
    const record = compileStage5LearningSignals({
      plan: makePlan({
        stage1: [STAGE1_REVISION],
        stage2: [STAGE2_REVISION],
        stage3: [STAGE3_REVISION],
      }),
      stage3BuPlanRecords: [BU_PLAN_RECORD_PARTIAL],
      stage4ArtifactOutputs: [ARTIFACT_OUTPUT_STRONG, ARTIFACT_OUTPUT_WITH_FINDINGS],
    })
    const d = diagnoseStage5LearningSignals(record)

    expect(d.stage1.count).toBe(record.counts.stage1)
    expect(d.stage2.count).toBe(record.counts.stage2)
    expect(d.stage3.count).toBe(record.counts.stage3)
    expect(d.stage4.count).toBe(record.counts.stage4)
    expect(d.total).toBe(record.signals.length)
  })

  it('readyForStage5 is true only when all 4 stages have at least one signal', () => {
    const full = compileStage5LearningSignals({
      plan: makePlan({ stage1: [STAGE1_REVISION], stage2: [STAGE2_REVISION], stage3: [STAGE3_REVISION] }),
      stage3BuPlanRecords: [BU_PLAN_RECORD_PARTIAL],
      stage4ArtifactOutputs: [ARTIFACT_OUTPUT_STRONG],
    })
    expect(diagnoseStage5LearningSignals(full).readyForStage5).toBe(true)

    // Without Stage 4 outputs
    const noS4 = compileStage5LearningSignals({
      plan: makePlan({ stage1: [STAGE1_REVISION], stage2: [STAGE2_REVISION], stage3: [STAGE3_REVISION] }),
      stage3BuPlanRecords: [],
      stage4ArtifactOutputs: [],
    })
    expect(diagnoseStage5LearningSignals(noS4).readyForStage5).toBe(false)
  })

  it('types breakdown is accurate for stage4', () => {
    const record = compileStage5LearningSignals({
      plan: makePlan(),
      stage3BuPlanRecords: [],
      stage4ArtifactOutputs: [ARTIFACT_OUTPUT_WITH_FINDINGS],
    })
    const d = diagnoseStage5LearningSignals(record)
    expect(d.stage4.types[SIGNAL_TYPES.QUALITY_REDUNDANCY]).toBeGreaterThanOrEqual(1)
    expect(d.stage4.types[SIGNAL_TYPES.QUALITY_COVERAGE_GAP]).toBeGreaterThanOrEqual(1)
  })
})

// ── storage key ────────────────────────────────────────────────────────────────

describe('stage5LearningSignalsKey', () => {
  it('produces a stable, prefixed key from workspace and revision IDs', () => {
    const key = stage5LearningSignalsKey('ws_1', 's1_rev1', 's2_rev1', 's3_rev1')
    expect(key).toBe('bsp_v1_stage5_learning_signals_ws_1_s1_rev1_s2_rev1_s3_rev1')
    expect(key.startsWith('bsp_v1_stage5_learning_signals_')).toBe(true)
  })
})
