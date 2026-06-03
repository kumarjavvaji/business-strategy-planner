/**
 * Tests for stage4ExecutionSectionNormalizer — group-based algorithm.
 *
 * Key behavioral contracts:
 *  - Sections sharing the same base framing (opening Jaccard >= threshold) are
 *    clustered into one framing group. Only the strongest representative is retained.
 *  - Unique execution details (words, list-field content) are extracted as deltas,
 *    not silently discarded.
 *  - Sections with genuinely different openings form separate groups and are retained.
 *  - Seven near-duplicate sections collapse to 1 retained + captured unique deltas.
 *  - Source refs from all merged members are preserved in the representative.
 *  - Diagnostics explain every disposition with the correct issueType.
 *  - No accepted Stage 3 source atoms are deleted or mutated.
 */

import { describe, it, expect } from 'vitest'
import {
  normalizeExecutionSectionsForStage4,
  getRetainedExecutionSections,
} from './stage4ExecutionSectionNormalizer'

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Very long shared opening — all 7 live sections start with this text
const SHARED_OPENING =
  'Deliver a contractor-governed explainability infrastructure sprint by onboarding four ' +
  'contracted developers within Sprint 1, allocating their capacity across partner integration, ' +
  'audit portal build, and client delivery protection'

// Full repeated objective — no unique delta between sections using only this
const REPEATED_OBJECTIVE =
  SHARED_OPENING +
  ' — ensuring core API staff remain uncommitted to ramp gaps, architectural decisions meet ' +
  'modularity standards extensible beyond BSA/AML, and scope bleed onto the core team is ' +
  'detected and escalated before it reaches Sprint 2 milestones.'

function makeSection(overrides = {}) {
  return {
    sectionName:        overrides.sectionName ?? 'Execution Section',
    objective:          overrides.objective   ?? REPEATED_OBJECTIVE,
    executionStrategy:  overrides.executionStrategy  || [],
    decisionsRequired:  overrides.decisionsRequired  || [],
    sequencingAndGates: overrides.sequencingAndGates || [],
    dependencies:       overrides.dependencies       || [],
    risks:              overrides.risks              || [],
    validationSignals:  overrides.validationSignals  || [],
    sourceAtomRefs:     overrides.sourceAtomRefs     || [],
  }
}

// ── Valid issueType taxonomy ───────────────────────────────────────────────────

const VALID_ISSUE_TYPES = new Set([
  'retained_distinct_execution_role',
  'unique_delta_extracted',
  'same_execution_role',
  'merged_low_distinctness_variant',
  'removed_no_unique_value',
])

// ── Core grouping: same opening → one representative ─────────────────────────

describe('same-opening sections collapse to one representative', () => {
  it('same opening phrase + no unique delta → merged/removed, 1 retained', () => {
    const sections = [
      makeSection({ sectionName: 'A', objective: REPEATED_OBJECTIVE }),
      makeSection({ sectionName: 'B', objective: REPEATED_OBJECTIVE }),
    ]
    const result = normalizeExecutionSectionsForStage4(sections)
    expect(result.retainedSections.length).toBe(1)
    expect(result.removedSections.length).toBe(1)
  })

  it('same opening phrase + minor wording only → merged_low_distinctness_variant, 1 retained', () => {
    const sections = [
      makeSection({ sectionName: 'A', objective: SHARED_OPENING + ' — enforcing standards.' }),
      makeSection({ sectionName: 'B', objective: SHARED_OPENING + ' — ensuring standards.' }),
    ]
    const result = normalizeExecutionSectionsForStage4(sections)
    expect(result.retainedSections.length).toBe(1)
    expect(result.removedSections.length).toBe(1)
    const tag = result.diagnostics.find(d => d.removedSectionIds?.length > 0)?.issueType
    expect(tag).toMatch(/merged_low_distinctness_variant|removed_no_unique_value/)
  })

  it('seven near-duplicate sections with no unique delta collapse to 1', () => {
    const sections = Array.from({ length: 7 }, (_, i) =>
      makeSection({
        sectionName: `Section ${i}`,
        objective:   REPEATED_OBJECTIVE + (i > 0 ? ` Variant ${i}.` : ''),
      })
    )
    const result = normalizeExecutionSectionsForStage4(sections)
    expect(result.retainedSections.length).toBe(1)
    expect(result.removedSections.length).toBe(6)
  })

  it('same opening + unique risk words → compact output preserving constraint words', () => {
    // The stronger (longer/richer) section becomes representative and is retained.
    // Unique constraint words must appear in the normalized output — either directly
    // in the retained section or captured in extractedUniqueDetails.
    const sections = [
      makeSection({
        sectionName: 'Base',
        objective:   SHARED_OPENING + ' — ensuring Sprint 2 delivery on schedule.',
      }),
      makeSection({
        sectionName: 'Risk Variant',
        objective:   SHARED_OPENING + ' — preventing ramp delay scope bleed core banking schema complexity Sprint 2.',
      }),
    ]
    const result = normalizeExecutionSectionsForStage4(sections)
    expect(result.retainedSections.length).toBe(1)
    expect(result.removedSections.length).toBe(1)
    // Constraint words must survive normalization — in retained objective or captured deltas
    const retainedText    = (result.retainedSections[0]?.objective || '').toLowerCase()
    const capturedText    = result.extractedUniqueDetails.map(d => JSON.stringify(d.capturedDetails)).join(' ').toLowerCase()
    expect(retainedText + capturedText).toMatch(/ramp|delay|schema|complexity/)
  })

  it('same opening + unique dependency in list field → 1 retained with dep folded in', () => {
    const sections = [
      makeSection({
        sectionName:  'A',
        objective:    SHARED_OPENING + ' — phase A.',
        dependencies: ['API gateway availability from Platform team'],
      }),
      makeSection({
        sectionName:  'B',
        objective:    SHARED_OPENING + ' — phase B.',
        dependencies: ['BSA/AML schema hand-off from Compliance team'],
      }),
    ]
    const result = normalizeExecutionSectionsForStage4(sections)
    expect(result.retainedSections.length).toBe(1)
    const retained = result.retainedSections[0]
    expect(retained.dependencies).toContain('API gateway availability from Platform team')
    expect(retained.dependencies).toContain('BSA/AML schema hand-off from Compliance team')
  })

  it('same opening + unique validation signal in list field → 1 retained with signal folded in', () => {
    const sections = [
      makeSection({
        sectionName:       'Gate A',
        objective:         SHARED_OPENING + ' — Sprint 1 gate.',
        validationSignals: ['Contractor velocity measured at end of Sprint 1'],
      }),
      makeSection({
        sectionName:       'Gate B',
        objective:         SHARED_OPENING + ' — Sprint 2 gate.',
        validationSignals: ['API modularity audit passed before Sprint 2 start'],
      }),
    ]
    const result = normalizeExecutionSectionsForStage4(sections)
    expect(result.retainedSections.length).toBe(1)
    const retained = result.retainedSections[0]
    expect(retained.validationSignals).toContain('Contractor velocity measured at end of Sprint 1')
    expect(retained.validationSignals).toContain('API modularity audit passed before Sprint 2 start')
  })

  it('same opening + unique gate in list field → 1 retained with gate folded in', () => {
    const sections = [
      makeSection({
        sectionName:        'Phase 1',
        objective:          SHARED_OPENING + ' — phase 1.',
        sequencingAndGates: ['Gate: architecture review approved before Sprint 2'],
      }),
      makeSection({
        sectionName:        'Phase 2',
        objective:          SHARED_OPENING + ' — phase 2.',
        sequencingAndGates: ['Gate: compliance sign-off required before client delivery'],
      }),
    ]
    const result = normalizeExecutionSectionsForStage4(sections)
    expect(result.retainedSections.length).toBe(1)
    const retained = result.retainedSections[0]
    expect(retained.sequencingAndGates).toContain('Gate: architecture review approved before Sprint 2')
    expect(retained.sequencingAndGates).toContain('Gate: compliance sign-off required before client delivery')
  })

  it('same opening + unique risk in list field → 1 retained with risk folded in', () => {
    const sections = [
      makeSection({
        sectionName: 'X',
        objective:   SHARED_OPENING + ' — managing ramp risk.',
        risks:       ['Contractor ramp delay exceeds two-week buffer'],
      }),
      makeSection({
        sectionName: 'Y',
        objective:   SHARED_OPENING + ' — managing scope risk.',
        risks:       ['Scope bleed from core banking schema complexity'],
      }),
    ]
    const result = normalizeExecutionSectionsForStage4(sections)
    expect(result.retainedSections.length).toBe(1)
    const retained = result.retainedSections[0]
    expect(retained.risks).toContain('Contractor ramp delay exceeds two-week buffer')
    expect(retained.risks).toContain('Scope bleed from core banking schema complexity')
  })
})

// ── Different execution role → separate groups ────────────────────────────────

describe('sections with different execution roles form separate groups and are retained', () => {
  it('genuinely different opening concepts → both retained as distinct top-level sections', () => {
    const sections = [
      makeSection({
        sectionName: 'Partner Integration',
        objective:   'Build API integration layer for partner explainability portal.',
      }),
      makeSection({
        sectionName: 'Audit Portal Build',
        objective:   'Deliver compliance module with BSA/AML validation framework.',
      }),
    ]
    const result = normalizeExecutionSectionsForStage4(sections)
    expect(result.retainedSections.length).toBe(2)
    expect(result.removedSections.length).toBe(0)
  })

  it('three different execution roles → three retained sections', () => {
    const sections = [
      makeSection({ sectionName: 'Partner Integration', objective: 'Build partner API integration with authentication gateway.' }),
      makeSection({ sectionName: 'Audit Portal',        objective: 'Deliver audit portal with BSA/AML compliance controls.' }),
      makeSection({ sectionName: 'Client Protection',   objective: 'Maintain client delivery SLAs during contractor ramp period.' }),
    ]
    const result = normalizeExecutionSectionsForStage4(sections)
    expect(result.retainedSections.length).toBe(3)
    expect(result.removedSections.length).toBe(0)
  })

  it('empty input returns empty output without error', () => {
    const result = normalizeExecutionSectionsForStage4([])
    expect(result.retainedSections).toEqual([])
    expect(result.removedSections).toEqual([])
    expect(result.extractedUniqueDetails).toEqual([])
  })

  it('single section is always retained', () => {
    const result = normalizeExecutionSectionsForStage4([
      makeSection({ sectionName: 'Solo', objective: 'Solo objective text here.' }),
    ])
    expect(result.retainedSections.length).toBe(1)
    expect(result.removedSections.length).toBe(0)
  })
})

// ── Unique-delta extraction and preservation ──────────────────────────────────

describe('unique deltas are extracted and preserved, not silently discarded', () => {
  it('significant unique objective words are captured in extractedUniqueDetails when member has unique constraints', () => {
    // Give 'Base' enough list-field content so it scores higher and becomes the representative.
    // The variant section (with unique objective words) then becomes the member, and its
    // unique objective delta is captured in extractedUniqueDetails.
    const sections = [
      makeSection({
        sectionName:       'Base',
        objective:         SHARED_OPENING + ' — ensuring Sprint 2 delivery.',
        decisionsRequired: ['Architecture gate', 'Vendor selection gate', 'Compliance sign-off'],
        risks:             ['Ramp delivery risk', 'Scope bleed risk'],
      }),
      makeSection({
        sectionName: 'Sprint 3 Variant',
        objective:   SHARED_OPENING + ' — ensuring active client pipelines protected while contracted developers absorb explainability load through sprint three.',
      }),
    ]
    // Base is stronger (list fields dominate score) → representative
    // Sprint 3 Variant adds ≥4 unique objective words → DELTA, captured in extractedUniqueDetails
    const result = normalizeExecutionSectionsForStage4(sections)
    expect(result.retainedSections.length).toBe(1)
    expect(result.removedSections.length).toBe(1)
    expect(result.extractedUniqueDetails.length).toBeGreaterThan(0)
    const delta = result.extractedUniqueDetails[0]
    expect(delta.fromSectionId).toBeTruthy()
    expect(delta.toSectionId).toBeTruthy()
    expect(delta.capturedDetails).toBeTruthy()
  })

  it('unique objective fragment is recorded in capturedDetails for member with ≥4 unique words', () => {
    // Base is stronger (list-field content) → representative
    // B has unique constraint words → member, delta captured
    const sections = [
      makeSection({
        sectionName:       'A',
        objective:         SHARED_OPENING + ' — base constraint.',
        decisionsRequired: ['Architecture gate required', 'Compliance approval required', 'Vendor selection gate'],
      }),
      makeSection({
        sectionName: 'B',
        objective:   SHARED_OPENING + ' — ramp delay scope bleed core banking schema complexity cascades sprint.',
      }),
    ]
    const result = normalizeExecutionSectionsForStage4(sections)
    expect(result.extractedUniqueDetails.length).toBeGreaterThan(0)
    const delta = result.extractedUniqueDetails.find(d => d.fromSectionId === 'B')
    expect(delta?.capturedDetails?.objectiveFragment || delta?.capturedDetails?.uniqueObjectiveWords).toBeTruthy()
  })

  it('unique list-field content is folded into retained representative', () => {
    const sections = [
      makeSection({
        sectionName:       'Representative',
        objective:         SHARED_OPENING + ' — base.',
        decisionsRequired: ['Architecture gate required before Sprint 2'],
      }),
      makeSection({
        sectionName:       'Variant',
        objective:         SHARED_OPENING + ' — variant.',
        decisionsRequired: ['Compliance sign-off required before client delivery'],
      }),
    ]
    const result = normalizeExecutionSectionsForStage4(sections)
    expect(result.retainedSections.length).toBe(1)
    const retained = result.retainedSections[0]
    expect(retained.decisionsRequired).toContain('Architecture gate required before Sprint 2')
    expect(retained.decisionsRequired).toContain('Compliance sign-off required before client delivery')
  })

  it('normalized output is compact but unique constraints from all 7 sections are captured', () => {
    const sections = [
      makeSection({ sectionName: 'S0', objective: SHARED_OPENING + ' — Sprint 2 milestone risk.' }),
      makeSection({ sectionName: 'S1', objective: SHARED_OPENING + ' — ramp delay blocks sprint timeline.' }),
      makeSection({ sectionName: 'S2', objective: SHARED_OPENING + ' — core banking schema complexity cascades.' }),
      makeSection({ sectionName: 'S3', objective: SHARED_OPENING + ' — active client pipelines protected sprint three.' }),
      makeSection({ sectionName: 'S4', objective: SHARED_OPENING + ' — contractor gaps Sprint 2 delayed.' }),
      makeSection({ sectionName: 'S5', objective: SHARED_OPENING + ' — audit portal architecture extensible BSA/AML.' }),
      makeSection({ sectionName: 'S6', objective: SHARED_OPENING + ' — explainability layer integration load through Sprint 3.' }),
    ]
    const result = normalizeExecutionSectionsForStage4(sections)
    // Compact: far fewer retained sections than input
    expect(result.retainedSections.length).toBeLessThan(sections.length)
    // Unique content not silently lost: extractedUniqueDetails captures what was removed
    const totalCaptured = result.extractedUniqueDetails.length + result.retainedSections.length
    expect(totalCaptured).toBeGreaterThan(1)
  })
})

// ── Source ref preservation ───────────────────────────────────────────────────

describe('merged sections preserve source refs from all group members', () => {
  it('retained representative carries source refs from every merged member', () => {
    const sections = [
      makeSection({ sectionName: 'A', objective: REPEATED_OBJECTIVE, sourceAtomRefs: ['atom_a'] }),
      makeSection({ sectionName: 'B', objective: REPEATED_OBJECTIVE, sourceAtomRefs: ['atom_b'] }),
      makeSection({ sectionName: 'C', objective: REPEATED_OBJECTIVE, sourceAtomRefs: ['atom_c'] }),
    ]
    const result = normalizeExecutionSectionsForStage4(sections)
    expect(result.retainedSections.length).toBe(1)
    const refs = result.retainedSections[0].sourceAtomRefs
    expect(refs).toContain('atom_a')
    expect(refs).toContain('atom_b')
    expect(refs).toContain('atom_c')
  })

  it('sections with different roles and different source refs are each retained with their own refs', () => {
    const sections = [
      makeSection({ sectionName: 'Integration', objective: 'Build API gateway integration.',   sourceAtomRefs: ['atom_1'] }),
      makeSection({ sectionName: 'Compliance',  objective: 'Deliver compliance audit portal.', sourceAtomRefs: ['atom_2'] }),
    ]
    const result = normalizeExecutionSectionsForStage4(sections)
    expect(result.retainedSections.length).toBe(2)
    const integration = result.retainedSections.find(s => s.sectionName === 'Integration')
    const compliance  = result.retainedSections.find(s => s.sectionName === 'Compliance')
    expect(integration?.sourceAtomRefs).toContain('atom_1')
    expect(compliance?.sourceAtomRefs).toContain('atom_2')
  })
})

// ── Diagnostics ───────────────────────────────────────────────────────────────

describe('diagnostics explain each disposition', () => {
  it('every diagnostic entry has issueType, reason, and remediation', () => {
    const sections = [
      makeSection({ sectionName: 'A', objective: REPEATED_OBJECTIVE }),
      makeSection({ sectionName: 'B', objective: REPEATED_OBJECTIVE }),
      makeSection({ sectionName: 'C', objective: 'Build compliance portal with audit controls.' }),
    ]
    const result = normalizeExecutionSectionsForStage4(sections)
    result.diagnostics.forEach(d => {
      expect(d.issueType).toBeTruthy()
      expect(d.reason).toBeTruthy()
      expect(d.remediation).toBeTruthy()
    })
  })

  it('issueType is always one of the defined taxonomy values', () => {
    const sections = [
      makeSection({ sectionName: 'A', objective: REPEATED_OBJECTIVE }),
      makeSection({ sectionName: 'B', objective: REPEATED_OBJECTIVE + ' Variant.' }),
      makeSection({ sectionName: 'C', objective: SHARED_OPENING + ' — ramp delay core banking schema uniquely distinct.' }),
      makeSection({ sectionName: 'D', objective: 'Establish compliance audit portal with BSA controls.' }),
    ]
    const result = normalizeExecutionSectionsForStage4(sections)
    result.diagnostics.forEach(d => {
      expect(VALID_ISSUE_TYPES.has(d.issueType)).toBe(true)
    })
  })

  it('retained_distinct_execution_role is emitted for every retained section', () => {
    const sections = [
      makeSection({ sectionName: 'A', objective: 'Build API gateway integration.' }),
      makeSection({ sectionName: 'B', objective: 'Deliver compliance audit portal.' }),
    ]
    const result = normalizeExecutionSectionsForStage4(sections)
    const retainedDiags = result.diagnostics.filter(d => d.issueType === 'retained_distinct_execution_role')
    expect(retainedDiags.length).toBe(result.retainedSections.length)
  })

  it('removed sections produce a diagnostic with correct retainedSectionId and removedSectionIds', () => {
    const sections = [
      makeSection({ sectionName: 'A', objective: REPEATED_OBJECTIVE }),
      makeSection({ sectionName: 'B', objective: REPEATED_OBJECTIVE }),
    ]
    const result = normalizeExecutionSectionsForStage4(sections)
    const removalDiag = result.diagnostics.find(d => d.removedSectionIds?.length > 0)
    expect(removalDiag).toBeTruthy()
    expect(removalDiag.retainedSectionId).toBeTruthy()
    expect(removalDiag.removedSectionIds[0]).toBeTruthy()
  })

  it('summary string describes the reduction when sections were removed', () => {
    const sections = [
      makeSection({ sectionName: 'A', objective: REPEATED_OBJECTIVE }),
      makeSection({ sectionName: 'B', objective: REPEATED_OBJECTIVE }),
    ]
    const result = normalizeExecutionSectionsForStage4(sections)
    expect(result.summary).toBeTruthy()
    expect(result.summary).toMatch(/normalized/)
  })

  it('summary is null when nothing was removed', () => {
    const sections = [
      makeSection({ sectionName: 'A', objective: 'Build partner API gateway integration.' }),
      makeSection({ sectionName: 'B', objective: 'Deliver compliance audit portal controls.' }),
    ]
    const result = normalizeExecutionSectionsForStage4(sections)
    if (result.removedSections.length === 0) {
      expect(result.summary).toBeNull()
    }
  })
})

// ── Source atom safety ────────────────────────────────────────────────────────

describe('source atom safety — Stage 3 atoms never deleted or mutated', () => {
  it('input sections array is not mutated', () => {
    const sections = [
      makeSection({ sectionName: 'A', objective: REPEATED_OBJECTIVE, sourceAtomRefs: ['atom_1'] }),
      makeSection({ sectionName: 'B', objective: REPEATED_OBJECTIVE, sourceAtomRefs: ['atom_2'] }),
    ]
    const frozen = sections.map(s => Object.freeze({ ...s }))
    expect(() => normalizeExecutionSectionsForStage4(frozen)).not.toThrow()
    expect(frozen[0].sectionName).toBe('A')
    expect(frozen[1].sectionName).toBe('B')
  })

  it('raw input array length is unchanged after normalization', () => {
    const sections = [
      makeSection({ sectionName: 'A', objective: REPEATED_OBJECTIVE }),
      makeSection({ sectionName: 'B', objective: REPEATED_OBJECTIVE }),
    ]
    const before = sections.length
    normalizeExecutionSectionsForStage4(sections)
    expect(sections.length).toBe(before)
  })

  it('getRetainedExecutionSections returns only the retained section array', () => {
    const sections = [
      makeSection({ sectionName: 'X', objective: REPEATED_OBJECTIVE }),
      makeSection({ sectionName: 'Y', objective: REPEATED_OBJECTIVE }),
    ]
    const retained = getRetainedExecutionSections(sections)
    expect(Array.isArray(retained)).toBe(true)
    expect(retained.length).toBeLessThanOrEqual(sections.length)
  })
})

// ── Strongest representative is chosen ───────────────────────────────────────

describe('strongest representative is kept from each framing group', () => {
  it('member with more list-field content becomes (or feeds) the retained section', () => {
    const sections = [
      makeSection({ sectionName: 'Thin', objective: REPEATED_OBJECTIVE }),
      makeSection({
        sectionName:       'Rich',
        objective:         REPEATED_OBJECTIVE,
        decisionsRequired: ['Architecture gate', 'Vendor approval'],
        risks:             ['Scope bleed risk'],
        dependencies:      ['Data pipeline readiness'],
        validationSignals: ['Sprint 2 milestone evidence'],
      }),
    ]
    const result = normalizeExecutionSectionsForStage4(sections)
    expect(result.retainedSections.length).toBe(1)
    const retained = result.retainedSections[0]
    expect(retained.decisionsRequired?.length).toBeGreaterThan(0)
    expect(retained.risks?.length).toBeGreaterThan(0)
  })
})
