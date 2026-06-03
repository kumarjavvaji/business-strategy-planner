/**
 * Tests for stage3StalenessImpact — D26 / D27 impact-aware stale classification.
 *
 * Covers:
 *  1. Stage 1 version changed, no material assumption → review_recommended (not materially_stale)
 *  2. Stage 1 API capacity changed → Engineering & API Infrastructure materially_stale (dependencies/executionSequence panels)
 *  3. Stage 1 BSA/AML compliance change → affected BUs/panels materially_stale
 *  4. Stage 1 wording-only refinement → review_recommended or unaffected
 *  5. Stage 4 handoff reflects materially_stale vs review_recommended differently (via classifyHandoffStaleness)
 *  6. Existing artifacts preserved — staleImpactMap does not mutate BU plan data
 *  7. buildStaleImpactMap returns BU-level and panel-level records with all required fields
 */

import { describe, it, expect } from 'vitest'
import {
  buildStaleImpactMap,
  classifyBuImpact,
  classifyPanelImpact,
  detectChangedAssumptions,
  isBuMentionedInChange,
  overallStaleSeverity,
  getBuImpact,
  getPanelImpact,
  getBuAffectedPanels,
  staleImpactBlocksStage4,
  STALE_SEVERITY,
  PANEL_IDS,
} from './stage3StalenessImpact'
import { classifyHandoffStaleness, classifyHandoffBuStaleness } from './stage4Handoff'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BU_NAMES = [
  'Engineering & API Infrastructure',
  'Compliance & Risk',
  'Product Management',
  'Operations',
  'Finance',
]

const BASE_HANDOFF = {
  stage1RevisionId: 's1_v1',
  stage2RevisionId: 's2_v1',
  stage3RevisionId: 's3_v1',
}

// ── 1. Version changed, no material assumption detected → review_recommended ──

describe('D26 — Stage 1 version changed but no material assumption changed', () => {
  it('classifies every BU as review_recommended when no material keywords detected', () => {
    const map = buildStaleImpactMap({
      buNames: BU_NAMES,
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'Minor wording refinements to executive summary.',
    })
    expect(map.changedAssumptions).toHaveLength(0)
    map.buImpacts.forEach(b => {
      expect(b.severity).toBe(STALE_SEVERITY.REVIEW_RECOMMENDED)
    })
  })

  it('overall severity is review_recommended, not materially_stale', () => {
    const map = buildStaleImpactMap({
      buNames: BU_NAMES,
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'Clarified wording in the strategic context section.',
    })
    expect(overallStaleSeverity(map)).toBe(STALE_SEVERITY.REVIEW_RECOMMENDED)
  })

  it('does NOT block Stage 4 continuation for review_recommended', () => {
    const map = buildStaleImpactMap({
      buNames: BU_NAMES,
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'Clarified wording in the strategic context section.',
    })
    expect(staleImpactBlocksStage4(map)).toBe(false)
  })
})

// ── 2. API capacity changed → Engineering & API Infrastructure materially stale ──

describe('D26 — Stage 1 API capacity assumption changed', () => {
  const revisionSummary = 'API capacity revised down — infrastructure team resourcing reduced from 12 to 8 engineers.'

  it('detects resourcing as a changed assumption', () => {
    const detected = detectChangedAssumptions(revisionSummary)
    expect(detected).toContain('resourcing')
  })

  it('classifies Engineering & API Infrastructure as materially_stale', () => {
    const buImpact = classifyBuImpact('Engineering & API Infrastructure', {
      revisionSummary,
      changedAssumptions: detectChangedAssumptions(revisionSummary),
      affectedBuNames: null,
    })
    expect(buImpact.severity).toBe(STALE_SEVERITY.MATERIALLY_STALE)
    expect(buImpact.changedAssumptions).toContain('resourcing')
  })

  it('marks dependencies and executionSequence panels as materially_stale (resourcing-sensitive)', () => {
    const changedAssumptions = detectChangedAssumptions(revisionSummary)
    const depsImpact = classifyPanelImpact('Engineering & API Infrastructure', 'dependencies', STALE_SEVERITY.MATERIALLY_STALE, changedAssumptions)
    const execImpact = classifyPanelImpact('Engineering & API Infrastructure', 'executionSequence', STALE_SEVERITY.MATERIALLY_STALE, changedAssumptions)
    expect(depsImpact.severity).toBe(STALE_SEVERITY.MATERIALLY_STALE)
    expect(execImpact.severity).toBe(STALE_SEVERITY.MATERIALLY_STALE)
    expect(depsImpact.impactedAssumptions).toContain('resourcing')
    expect(execImpact.impactedAssumptions).toContain('resourcing')
  })

  it('marks strategicObjective as review_recommended (not sensitive to resourcing alone)', () => {
    const changedAssumptions = detectChangedAssumptions(revisionSummary)
    const impact = classifyPanelImpact('Engineering & API Infrastructure', 'strategicObjective', STALE_SEVERITY.MATERIALLY_STALE, changedAssumptions)
    expect(impact.severity).toBe(STALE_SEVERITY.REVIEW_RECOMMENDED)
  })

  it('buildStaleImpactMap reflects materially_stale for affected BU and panel records', () => {
    const map = buildStaleImpactMap({
      buNames: ['Engineering & API Infrastructure', 'Compliance & Risk'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary,
    })
    const engBu = getBuImpact(map, 'Engineering & API Infrastructure')
    expect(engBu.severity).toBe(STALE_SEVERITY.MATERIALLY_STALE)
    const depPanel = getPanelImpact(map, 'Engineering & API Infrastructure', 'dependencies')
    expect(depPanel.severity).toBe(STALE_SEVERITY.MATERIALLY_STALE)
    expect(depPanel.impactedAssumptions).toContain('resourcing')
  })

  it('overall severity is materially_stale when at least one BU is', () => {
    const map = buildStaleImpactMap({
      buNames: BU_NAMES,
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary,
    })
    expect(overallStaleSeverity(map)).toBe(STALE_SEVERITY.MATERIALLY_STALE)
  })

  it('blocks Stage 4 continuation when materially_stale BUs exist', () => {
    const map = buildStaleImpactMap({
      buNames: BU_NAMES,
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary,
    })
    expect(staleImpactBlocksStage4(map)).toBe(true)
  })
})

// ── 3. BSA/AML compliance change → affected panels materially_stale ───────────

describe('D26 — Stage 1 BSA/AML priority changed', () => {
  const revisionSummary = 'BSA/AML compliance validation requirements elevated — additional evidence required for transaction monitoring.'

  it('detects validation as a changed assumption', () => {
    const detected = detectChangedAssumptions(revisionSummary)
    expect(detected).toContain('validation')
  })

  it('marks validationFramework and risks panels as materially_stale', () => {
    const changedAssumptions = detectChangedAssumptions(revisionSummary)
    const valImpact = classifyPanelImpact('Compliance & Risk', 'validationFramework', STALE_SEVERITY.MATERIALLY_STALE, changedAssumptions)
    const riskImpact = classifyPanelImpact('Compliance & Risk', 'risks', STALE_SEVERITY.MATERIALLY_STALE, changedAssumptions)
    expect(valImpact.severity).toBe(STALE_SEVERITY.MATERIALLY_STALE)
    expect(riskImpact.severity).toBe(STALE_SEVERITY.MATERIALLY_STALE)
    expect(valImpact.impactedAssumptions).toContain('validation')
    expect(riskImpact.impactedAssumptions).toContain('validation')
  })

  it('executionSequence is materially_stale when validation assumption changed (spec: possibly Execution Sequence)', () => {
    const changedAssumptions = detectChangedAssumptions(revisionSummary)
    const execImpact = classifyPanelImpact('Compliance & Risk', 'executionSequence', STALE_SEVERITY.MATERIALLY_STALE, changedAssumptions)
    // Execution Sequence is sensitive to validation per spec ("possibly Execution Sequence" for BSA/AML)
    expect(execImpact.severity).toBe(STALE_SEVERITY.MATERIALLY_STALE)
    expect(execImpact.impactedAssumptions).toContain('validation')
  })

  it('buildStaleImpactMap has materially_stale in summary.materiallyStaleBUs', () => {
    const map = buildStaleImpactMap({
      buNames: ['Compliance & Risk'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary,
    })
    expect(map.summary.materiallyStaleBUs).toContain('Compliance & Risk')
    expect(map.summary.reviewRecommendedBUs).toHaveLength(0)
  })
})

// ── 4. Wording-only refinement → review_recommended or unaffected ─────────────

describe('D26 — Stage 1 wording-only refinement', () => {
  it('review_recommended for generic wording change with no assumption keywords', () => {
    const map = buildStaleImpactMap({
      buNames: ['Engineering & API Infrastructure'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'Improved executive summary clarity and fixed minor typos.',
    })
    expect(overallStaleSeverity(map)).toBe(STALE_SEVERITY.REVIEW_RECOMMENDED)
    expect(staleImpactBlocksStage4(map)).toBe(false)
  })

  it('all panels for a review_recommended BU are also review_recommended', () => {
    const changedAssumptions = [] // wording-only
    PANEL_IDS.forEach(panelId => {
      const impact = classifyPanelImpact('Engineering & API Infrastructure', panelId, STALE_SEVERITY.REVIEW_RECOMMENDED, changedAssumptions)
      expect(impact.severity).toBe(STALE_SEVERITY.REVIEW_RECOMMENDED)
    })
  })

  it('unaffected BU when explicitly excluded from affectedBuNames', () => {
    const map = buildStaleImpactMap({
      buNames: ['Engineering & API Infrastructure', 'Finance'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'Finance budget assumptions updated.',
      affectedBuNames: ['Finance'],
    })
    const engBu = getBuImpact(map, 'Engineering & API Infrastructure')
    const finBu = getBuImpact(map, 'Finance')
    expect(engBu.severity).toBe(STALE_SEVERITY.UNAFFECTED)
    // Finance has no material assumption keywords despite being in affectedBuNames
    // (revisionSummary doesn't match any known assumption keyword for 'Finance' budget)
    // But 'budget' IS a resourcing keyword, so Finance should be materially stale.
    expect(finBu.severity).toBe(STALE_SEVERITY.MATERIALLY_STALE)
  })
})

// ── 5. Stage 4 handoff reflects materially_stale vs review_recommended ────────

describe('D27 — Stage 4 handoff classifyHandoffStaleness', () => {
  it('returns null when handoff is current (no version mismatch)', () => {
    const result = classifyHandoffStaleness(BASE_HANDOFF, 's1_v1', 's2_v1', 's3_v1', null)
    expect(result).toBeNull()
  })

  it('returns materially_stale when impactMap has materially_stale BUs', () => {
    const map = buildStaleImpactMap({
      buNames: ['Engineering & API Infrastructure'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'API capacity reduced significantly — resourcing changed.',
    })
    const result = classifyHandoffStaleness(BASE_HANDOFF, 's1_v2', 's2_v1', 's3_v1', map)
    expect(result).toBe('materially_stale')
  })

  it('returns review_recommended when impactMap has only review_recommended BUs', () => {
    const map = buildStaleImpactMap({
      buNames: ['Engineering & API Infrastructure'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'Clarified wording only — no assumption changes.',
    })
    const result = classifyHandoffStaleness(BASE_HANDOFF, 's1_v2', 's2_v1', 's3_v1', map)
    expect(result).toBe('review_recommended')
  })

  it('returns unaffected when all BUs are unaffected', () => {
    const map = buildStaleImpactMap({
      buNames: ['Engineering & API Infrastructure', 'Finance'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'Finance-specific change.',
      affectedBuNames: ['Finance'],  // Engineering explicitly unaffected
    })
    // Finance has no material assumption keyword in this revisionSummary
    // (we need to test with a summary that makes Finance unaffected too)
    // Use truly empty summary for both BUs being unaffected:
    const map2 = buildStaleImpactMap({
      buNames: ['Engineering & API Infrastructure'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: null,
      affectedBuNames: ['Finance'],  // Engineering not in list → unaffected
    })
    const result = classifyHandoffStaleness(BASE_HANDOFF, 's1_v2', 's2_v1', 's3_v1', map2)
    expect(result).toBe('unaffected')
  })

  it('falls back to review_recommended without impact map (backward compat)', () => {
    const result = classifyHandoffStaleness(BASE_HANDOFF, 's1_v2', 's2_v1', 's3_v1', null)
    expect(result).toBe('review_recommended')
  })

  it('returns null for a current handoff even with an impact map provided', () => {
    const map = buildStaleImpactMap({
      buNames: ['Engineering & API Infrastructure'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v1',  // matches handoff
      revisionSummary: 'Major change',
    })
    const result = classifyHandoffStaleness(BASE_HANDOFF, 's1_v1', 's2_v1', 's3_v1', map)
    expect(result).toBeNull()
  })

  it('classifyHandoffBuStaleness returns BU-level severity', () => {
    const map = buildStaleImpactMap({
      buNames: ['Engineering & API Infrastructure', 'Compliance & Risk'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'API capacity reduced — resourcing changed.',
      affectedBuNames: ['Engineering & API Infrastructure'],  // Compliance not affected
    })
    // Engineering should be materially_stale; Compliance should be unaffected
    const engSeverity = classifyHandoffBuStaleness('Engineering & API Infrastructure', BASE_HANDOFF, 's1_v2', 's2_v1', 's3_v1', map)
    const compSeverity = classifyHandoffBuStaleness('Compliance & Risk', BASE_HANDOFF, 's1_v2', 's2_v1', 's3_v1', map)
    expect(engSeverity).toBe(STALE_SEVERITY.MATERIALLY_STALE)
    expect(compSeverity).toBe(STALE_SEVERITY.UNAFFECTED)
  })
})

// ── 6. Existing artifacts are preserved when staleness metadata updates ────────

describe('D26 — existing artifacts preserved', () => {
  it('buildStaleImpactMap does not mutate BU name inputs', () => {
    const buNames = ['Engineering & API Infrastructure', 'Finance']
    const original = [...buNames]
    buildStaleImpactMap({
      buNames,
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'Timeline changed.',
    })
    expect(buNames).toEqual(original)
  })

  it('buildStaleImpactMap carries no BU plan content — only metadata', () => {
    const map = buildStaleImpactMap({
      buNames: ['Engineering & API Infrastructure'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'Timeline compressed.',
    })
    const buImpact = map.buImpacts[0]
    // Should not contain any BU plan content
    expect(buImpact.plan).toBeUndefined()
    expect(buImpact.executionSections).toBeUndefined()
    expect(buImpact.content).toBeUndefined()
  })
})

// ── 7. buildStaleImpactMap structure ──────────────────────────────────────────

describe('D27 — buildStaleImpactMap structure', () => {
  it('returns expected top-level shape', () => {
    const map = buildStaleImpactMap({
      buNames: ['Engineering & API Infrastructure'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'Timeline compressed by 2 weeks.',
    })
    expect(map).toHaveProperty('upstreamSource', 'Stage 1')
    expect(map).toHaveProperty('upstreamRevisionId', 's1_v2')
    expect(map).toHaveProperty('revisionSummary')
    expect(map).toHaveProperty('changedAssumptions')
    expect(map).toHaveProperty('buImpacts')
    expect(map).toHaveProperty('panelImpacts')
    expect(map).toHaveProperty('summary')
    expect(map).toHaveProperty('computedAt')
  })

  it('BU impact records have required fields', () => {
    const map = buildStaleImpactMap({
      buNames: ['Engineering & API Infrastructure'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'Timeline compressed.',
    })
    const bu = map.buImpacts[0]
    expect(bu).toHaveProperty('buName', 'Engineering & API Infrastructure')
    expect(bu).toHaveProperty('severity')
    expect(bu).toHaveProperty('changedAssumptions')
    expect(bu).toHaveProperty('impactedAssumption')
    expect(bu).toHaveProperty('reason')
    expect(bu).toHaveProperty('upstreamSource')
    expect(bu).toHaveProperty('upstreamRevisionId')
  })

  it('panel impact records have required fields', () => {
    const map = buildStaleImpactMap({
      buNames: ['Engineering & API Infrastructure'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'Timeline compressed.',
    })
    const panel = map.panelImpacts[0]
    expect(panel).toHaveProperty('buName')
    expect(panel).toHaveProperty('panelId')
    expect(panel).toHaveProperty('severity')
    expect(panel).toHaveProperty('impactedAssumption')
    expect(panel).toHaveProperty('impactedAssumptions')
    expect(panel).toHaveProperty('action')
  })

  it('produces one panel record per panel ID per BU', () => {
    const map = buildStaleImpactMap({
      buNames: ['Engineering & API Infrastructure', 'Compliance & Risk'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'Timeline compressed.',
    })
    expect(map.panelImpacts).toHaveLength(2 * PANEL_IDS.length)
  })

  it('summary counts match buImpacts array', () => {
    const map = buildStaleImpactMap({
      buNames: BU_NAMES,
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'Resourcing cut and delivery sequence changed.',
    })
    const total =
      map.summary.materiallyStaleBUs.length +
      map.summary.reviewRecommendedBUs.length +
      map.summary.unaffectedBUs.length +
      map.summary.unknownBUs.length
    expect(total).toBe(BU_NAMES.length)
  })

  it('returns empty arrays when buNames is empty', () => {
    const map = buildStaleImpactMap({
      buNames: [],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'API capacity changed.',
    })
    expect(map.buImpacts).toHaveLength(0)
    expect(map.panelImpacts).toHaveLength(0)
    expect(map.summary.total).toBe(0)
  })
})

// ── Assumption keyword detection ──────────────────────────────────────────────

describe('detectChangedAssumptions', () => {
  it('returns empty array for null/empty summary', () => {
    expect(detectChangedAssumptions(null)).toHaveLength(0)
    expect(detectChangedAssumptions('')).toHaveLength(0)
  })

  it('detects multiple assumptions in one summary', () => {
    const detected = detectChangedAssumptions(
      'Timeline compressed by 3 weeks due to BSA/AML compliance requirement elevated; headcount cut.'
    )
    expect(detected).toContain('timeline')
    expect(detected).toContain('validation')
    expect(detected).toContain('resourcing')
  })

  it('is case-insensitive', () => {
    expect(detectChangedAssumptions('RESOURCING CHANGED')).toContain('resourcing')
    expect(detectChangedAssumptions('Bsa compliance update')).toContain('validation')
  })
})

describe('isBuMentionedInChange', () => {
  it('returns true when BU name appears in summary (case-insensitive)', () => {
    expect(isBuMentionedInChange('Engineering & API Infrastructure', 'Engineering & API Infrastructure resourcing cut')).toBe(true)
    expect(isBuMentionedInChange('engineering & api infrastructure', 'ENGINEERING & API INFRASTRUCTURE resourcing cut')).toBe(true)
  })

  it('returns false when BU name is absent', () => {
    expect(isBuMentionedInChange('Compliance & Risk', 'Engineering resourcing cut')).toBe(false)
  })

  it('handles null inputs', () => {
    expect(isBuMentionedInChange(null, 'some summary')).toBe(false)
    expect(isBuMentionedInChange('BU Name', null)).toBe(false)
  })
})

// ── overallStaleSeverity ──────────────────────────────────────────────────────

describe('overallStaleSeverity', () => {
  it('returns null for null map', () => {
    expect(overallStaleSeverity(null)).toBeNull()
  })

  it('materially_stale wins over review_recommended', () => {
    const map = buildStaleImpactMap({
      buNames: ['BU A', 'BU B'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'API capacity reduced.',  // resourcing → BU A materially_stale
      affectedBuNames: ['BU A'],
    })
    // BU B is unaffected, BU A is materially_stale
    expect(overallStaleSeverity(map)).toBe(STALE_SEVERITY.MATERIALLY_STALE)
  })

  it('returns unaffected when all BUs are unaffected', () => {
    const map = buildStaleImpactMap({
      buNames: ['BU A'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: null,
      affectedBuNames: ['BU B'],  // BU A not in list → unaffected
    })
    expect(overallStaleSeverity(map)).toBe(STALE_SEVERITY.UNAFFECTED)
  })
})

// ── D28: affectedPanels and reviewTargets ─────────────────────────────────────

describe('D28 — affectedPanels and reviewTargets on BU impact records', () => {
  it('review_recommended BU has empty affectedPanels', () => {
    const map = buildStaleImpactMap({
      buNames: ['Engineering & API Infrastructure'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'Wording refinements to executive summary.',
    })
    const bu = getBuImpact(map, 'Engineering & API Infrastructure')
    expect(bu.severity).toBe(STALE_SEVERITY.REVIEW_RECOMMENDED)
    expect(bu.affectedPanels).toEqual([])
  })

  it('review_recommended BU has the three review targets', () => {
    const map = buildStaleImpactMap({
      buNames: ['Engineering & API Infrastructure'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'Wording refinements only.',
    })
    const bu = getBuImpact(map, 'Engineering & API Infrastructure')
    expect(bu.reviewTargets).toContain('BU summary / thesis')
    expect(bu.reviewTargets).toContain('Execution Sequence → Stage 4 deliverable mapping')
    expect(bu.reviewTargets).toContain('Compiled Strategy Quality Audit')
  })

  it('materially_stale BU (resourcing) has affectedPanels: executionSequence, dependencies, risks, validationFramework', () => {
    const map = buildStaleImpactMap({
      buNames: ['Engineering & API Infrastructure'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'API capacity reduced — resourcing cut.',
    })
    const bu = getBuImpact(map, 'Engineering & API Infrastructure')
    expect(bu.severity).toBe(STALE_SEVERITY.MATERIALLY_STALE)
    expect(bu.affectedPanels).toContain('executionSequence')
    expect(bu.affectedPanels).toContain('dependencies')
    expect(bu.affectedPanels).toContain('risks')
    expect(bu.affectedPanels).toContain('validationFramework')
    expect(bu.reviewTargets).toEqual([])
  })

  it('materially_stale BU (validation/BSA) has affectedPanels: strategicObjective, risks, validationFramework, executionSequence', () => {
    const map = buildStaleImpactMap({
      buNames: ['Compliance & Risk'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'BSA/AML compliance requirements elevated.',
    })
    const bu = getBuImpact(map, 'Compliance & Risk')
    expect(bu.affectedPanels).toContain('strategicObjective')
    expect(bu.affectedPanels).toContain('risks')
    expect(bu.affectedPanels).toContain('validationFramework')
    expect(bu.affectedPanels).toContain('executionSequence')
  })

  it('materially_stale BU (buildVsPartner) has affectedPanels: criticalDecisions, executionSequence, dependencies, risks', () => {
    const map = buildStaleImpactMap({
      buNames: ['Product Management'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'Build-or-buy decision changed — vendor selection reversed.',
    })
    const bu = getBuImpact(map, 'Product Management')
    expect(bu.affectedPanels).toContain('criticalDecisions')
    expect(bu.affectedPanels).toContain('executionSequence')
    expect(bu.affectedPanels).toContain('dependencies')
    expect(bu.affectedPanels).toContain('risks')
  })

  it('unaffected BU has empty affectedPanels and empty reviewTargets', () => {
    const map = buildStaleImpactMap({
      buNames: ['Engineering & API Infrastructure'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: null,
      affectedBuNames: ['Finance'],  // Engineering excluded
    })
    const bu = getBuImpact(map, 'Engineering & API Infrastructure')
    expect(bu.severity).toBe(STALE_SEVERITY.UNAFFECTED)
    expect(bu.affectedPanels).toEqual([])
    expect(bu.reviewTargets).toEqual([])
  })

  it('getBuAffectedPanels returns empty for no changed assumptions', () => {
    expect(getBuAffectedPanels([])).toEqual([])
    expect(getBuAffectedPanels(null)).toEqual([])
  })

  it('getBuAffectedPanels returns correct panels for resourcing', () => {
    const panels = getBuAffectedPanels(['resourcing'])
    expect(panels).toContain('executionSequence')
    expect(panels).toContain('dependencies')
    expect(panels).toContain('risks')
    expect(panels).toContain('validationFramework')
    expect(panels).not.toContain('criticalDecisions')  // not sensitive to resourcing
  })
})

// ── D28: Stage 3 / Stage 4 banners agree ─────────────────────────────────────

describe('D28 — banner agreement: Stage 3 banner vs Stage 4 handoff severity', () => {
  it('review_recommended map: overallSeverity is review_recommended (not materially_stale)', () => {
    const map = buildStaleImpactMap({
      buNames: ['Engineering & API Infrastructure'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'Wording clarifications only.',
    })
    // Stage 3 banner should show review_recommended
    expect(overallStaleSeverity(map)).toBe(STALE_SEVERITY.REVIEW_RECOMMENDED)
    // Stage 4 handoff should also be review_recommended (not hard stale)
    const handoffSeverity = classifyHandoffStaleness(BASE_HANDOFF, 's1_v2', 's2_v1', 's3_v1', map)
    expect(handoffSeverity).toBe('review_recommended')
    // Should NOT block Stage 4
    expect(staleImpactBlocksStage4(map)).toBe(false)
  })

  it('materially_stale map: both Stage 3 banner and Stage 4 handoff show hard stale', () => {
    const map = buildStaleImpactMap({
      buNames: ['Engineering & API Infrastructure'],
      upstreamSource: 'Stage 1',
      upstreamRevisionId: 's1_v2',
      revisionSummary: 'API capacity reduced.',
    })
    expect(overallStaleSeverity(map)).toBe(STALE_SEVERITY.MATERIALLY_STALE)
    const handoffSeverity = classifyHandoffStaleness(BASE_HANDOFF, 's1_v2', 's2_v1', 's3_v1', map)
    expect(handoffSeverity).toBe('materially_stale')
    expect(staleImpactBlocksStage4(map)).toBe(true)
  })
})
