/**
 * Stage 4 artifact pipeline tests.
 *
 * Covers the canonical Deliverable → Items → Atoms → Persisted Atom Outputs → Compiled View pipeline.
 * All supported artifact families are tested.  BU Execution Plan success path must continue to pass.
 * SME Review Packet and Executive Decision Brief must use atomised generation for every section.
 */

import { describe, it, expect } from 'vitest'
import {
  getArtifactSectionOutline,
  deriveSectionChildDefs,
  buildArtifactChildPrompt,
  parseArtifactChildResponse,
  SUPPORTED_GENERATION_TYPES,
} from './stage4ArtifactPrompts'
import {
  createArtifactSectionUnit,
  createArtifactChildUnit,
} from './stage4ArtifactLifecycle'
import {
  buildInitialArtifactChildUnits,
  applyChildGenerationSuccess,
  applyChildGenerationFailure,
  assembleSectionFromChildUnits,
  assembleArtifactFromSectionUnits,
  applySectionGenerationSuccess,
  applySectionGenerationFailure,
  buildArtifactProgressOutput,
  auditArtifactOutput,
  OUTPUT_STATUS,
} from './stage4ArtifactOutput'
import { ARTIFACT_SECTION_LIFECYCLE, ARTIFACT_GENERATION_STATUS } from './stage4ArtifactLifecycle'

// ── Shared fixtures ─────────────────────────────────────────────────────────────

const ARTIFACT_BASIS = {
  artifactType:    'executive_decision_brief',
  artifactIntent:  'Board-ready brief',
  buName:          null,
  strategicThesis: 'Accelerate go-to-market through digital delivery.',
  selectedExecutionTactics: [
    { optionName: 'Threat-Modeled Architecture Review', phaseName: 'Phase 1', whenToUse: 'Before design lock', evidenceProduced: 'Threat model report' },
  ],
  relevantDecisions: [
    { id: 'dec_1', name: 'Architecture Gate',   summary: 'Approve architecture evidence before build.' },
    { id: 'dec_2', name: 'Dependency Ownership',summary: 'Assign cross-BU dependency owners.' },
    { id: 'dec_3', name: 'Validation Gate',     summary: 'Approve validation evidence before launch.' },
  ],
  relevantDependencies: [
    { id: 'dep_1', name: 'Data Pipeline',    summary: 'Central data pipeline must be ready before BU A can launch.' },
    { id: 'dep_2', name: 'Auth Platform',    summary: 'Auth platform upgrade blocks BU B sign-on flow.' },
  ],
  relevantRisks: [
    { id: 'risk_1', name: 'Timeline Compression', summary: 'Parallel delivery tracks may compress review cycles.' },
    { id: 'risk_2', name: 'Specialist Availability', summary: 'Domain SME capacity is constrained through Q2.' },
  ],
  relevantValidationQuestions: [
    { id: 'val_1', name: 'Pilot Design',       summary: 'Is the pilot designed to produce statistically valid evidence?' },
    { id: 'val_2', name: 'Regulatory Scope',   summary: 'Which regulatory requirements apply to this delivery scope?' },
  ],
  excludedContextSummary: { unmappedTacticNames: ['Regulatory Pre-Review Walkthrough'] },
  sourceTraceability: { sourceAtomIds: ['atom_a', 'atom_b'], sourceBuNames: ['BU Alpha'] },
  counts: { mappedHowOptions: 1 },
  basisWarnings: [],
}

const BU_BASIS = {
  ...ARTIFACT_BASIS,
  artifactType: 'bu_execution_plan',
  buName: 'BU Alpha',
}

const BU_SME_BASIS = {
  ...ARTIFACT_BASIS,
  artifactType: 'bu_sme_review_packet',
  buName: 'BU Alpha',
}

const GLOBAL_SME_BASIS = {
  ...ARTIFACT_BASIS,
  artifactType: 'global_sme_review_packet',
  buName: null,
}

const OUTPUT_META = {
  workspaceId: 'ws_1',
  stage1Id:    's1_1',
  stage2Id:    's2_1',
  stage3Id:    's3_1',
  handoff:     { persistedAt: 'handoff_ts' },
  plan:        { persistedAt: 'plan_ts', handoffKey: 'hk' },
}

function goodChildContent(childId, heading) {
  return {
    childId,
    heading,
    body: `${heading}: specific action with named owner, gate, and evidence basis for this atom.`,
    sourceAtomIds: ['atom_a'],
    openQuestions: [],
    confidenceLevel: 'medium',
  }
}

function goodSection(id, heading = 'Section') {
  return {
    sectionId: id,
    heading,
    purpose: `Purpose for ${id}.`,
    body: `Threat-Modeled Architecture Review informs this section. Named owner, gate, evidence, and timing specified. Decision required before delivery proceeds.`,
    sourceAtomIds: ['atom_a'],
    openQuestions: [],
    confidenceLevel: 'medium',
  }
}

// ── 1. Artifact decomposition into sections / items / atoms ─────────────────────

describe('artifact decomposition into sections, items, and atoms', () => {
  const SUPPORTED_TYPES = [...SUPPORTED_GENERATION_TYPES]

  it.each(SUPPORTED_TYPES)('%s has a non-empty section outline', (artifactType) => {
    const outline = getArtifactSectionOutline(artifactType)
    expect(outline).not.toBeNull()
    expect(outline.length).toBeGreaterThan(0)
  })

  it.each(SUPPORTED_TYPES)('%s sections all use child_units generationMode', (artifactType) => {
    const outline = getArtifactSectionOutline(artifactType)
    for (const section of outline) {
      expect(section.generationMode).toBe('child_units')
    }
  })

  it.each(SUPPORTED_TYPES)('%s sections all produce at least one atom from the basis', (artifactType) => {
    const outline = getArtifactSectionOutline(artifactType)
    const basis = artifactType === 'bu_execution_plan'   ? BU_BASIS
      : artifactType === 'bu_execution_plan_partial'     ? BU_BASIS
      : artifactType === 'bu_sme_review_packet'          ? BU_SME_BASIS
      : artifactType === 'global_sme_review_packet'      ? GLOBAL_SME_BASIS
      : ARTIFACT_BASIS

    for (const section of outline) {
      const atoms = deriveSectionChildDefs(section, basis)
      expect(atoms.length).toBeGreaterThan(0)
    }
  })
})

// ── 2. Atom identity — stable IDs and sourceAtomRefs ───────────────────────────

describe('atom identity', () => {
  it('every atom has a stable childId and parentSectionId', () => {
    const outline = getArtifactSectionOutline('executive_decision_brief')
    for (const section of outline) {
      const atoms = deriveSectionChildDefs(section, ARTIFACT_BASIS)
      for (const atom of atoms) {
        expect(atom.childId).toMatch(new RegExp(`^${section.id}:`))
        expect(atom.parentSectionId).toBe(section.id)
      }
    }
  })

  it('source-item atoms carry sourceAtomRefs derived from the source item id', () => {
    const section = getArtifactSectionOutline('executive_decision_brief').find(s => s.id === 'key_decisions_required')
    const atoms   = deriveSectionChildDefs(section, ARTIFACT_BASIS)
    const dec1Atom = atoms.find(a => a.sourceItemId === 'dec_1')
    expect(dec1Atom).toBeDefined()
    expect(dec1Atom.sourceAtomRefs).toContain('dec_1')
    expect(dec1Atom.isStaticAtom).toBe(false)
  })

  it('static atoms carry sourceAtomRefs from sourceTraceability', () => {
    const section = getArtifactSectionOutline('executive_decision_brief').find(s => s.id === 'executive_summary')
    const atoms   = deriveSectionChildDefs(section, ARTIFACT_BASIS)
    for (const atom of atoms) {
      expect(atom.isStaticAtom).toBe(true)
      // sourceAtomRefs drawn from basis sourceTraceability
      expect(Array.isArray(atom.sourceAtomRefs)).toBe(true)
    }
  })

  it('creating a child unit preserves atomType, inputBasis, isStaticAtom, sourceAtomRefs', () => {
    const section = getArtifactSectionOutline('executive_decision_brief').find(s => s.id === 'executive_summary')
    const atomDef = deriveSectionChildDefs(section, ARTIFACT_BASIS)[0]
    const unit    = createArtifactChildUnit(atomDef)
    expect(unit.atomType).toBe(atomDef.atomType)
    expect(unit.inputBasis).toBe(atomDef.inputBasis)
    expect(unit.isStaticAtom).toBe(true)
    expect(unit.sourceAtomRefs).toEqual(atomDef.sourceAtomRefs)
  })
})

describe('artifact quality issue taxonomy', () => {
  it('flags truncation, repetition, copied source prose, and provides actionable remediation metadata', () => {
    const copiedSource = 'Use before architecture sign-off when model explainability controls must be reviewed in detail by accountable reviewers and delivery owners.'
    const basis = {
      ...ARTIFACT_BASIS,
      selectedExecutionTactics: [{ ...ARTIFACT_BASIS.selectedExecutionTactics[0], whenToUse: copiedSource }],
    }
    const audit = auditArtifactOutput({
      artifactBasis: basis,
      contentSections: [
        {
          sectionId: 's1',
          heading: 'Section One',
          purpose: 'Purpose',
          body: `${copiedSource} ...`,
          sourceAtomIds: ['atom_a'],
        },
        {
          sectionId: 's2',
          heading: 'Section Two',
          purpose: 'Purpose',
          body: `${copiedSource} ...`,
          sourceAtomIds: ['atom_a'],
        },
      ],
    })

    expect(audit.status).toBe('needs_revision')
    expect(audit.findings.some(f => f.issueType === 'genuinely_truncated')).toBe(true)
    expect(audit.findings.some(f => f.issueType === 'repeated_content')).toBe(true)
    expect(audit.findings.some(f => f.issueType === 'copied_source_prose')).toBe(true)
    audit.findings.forEach(finding => {
      expect(finding.exactReason).toBeTruthy()
      expect(finding.remediationAction).toBeTruthy()
      expect(finding).toHaveProperty('regenerationRequired')
      expect(finding).toHaveProperty('autoFixable')
    })
  })
})

// ── 3. Atom-level persistence — successful atoms survive sibling failures ──────

describe('atom-level persistence', () => {
  function buildChildUnitsWithOneFailed(sectionId, atomDefs, failIndex) {
    const childUnits = buildInitialArtifactChildUnits(atomDefs)
    atomDefs.forEach((def, i) => {
      if (i === failIndex) {
        childUnits[i] = applyChildGenerationFailure(childUnits[i], 'Truncated model output')
      } else {
        childUnits[i] = applyChildGenerationSuccess(childUnits[i], goodChildContent(def.childId, def.label))
      }
    })
    return childUnits
  }

  it('successful atoms remain when one atom fails — key_decisions_required', () => {
    const section  = getArtifactSectionOutline('executive_decision_brief').find(s => s.id === 'key_decisions_required')
    const atomDefs = deriveSectionChildDefs(section, ARTIFACT_BASIS)
    const children = buildChildUnitsWithOneFailed(section.id, atomDefs, 1)

    expect(children[0].lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.ACCEPTED)
    expect(children[1].lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.FAILED)
    expect(children[2].lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.ACCEPTED)
    // Failed child does NOT erase sibling atoms
    expect(children[0].content.body).toContain('specific action')
    expect(children[2].content.body).toContain('specific action')
  })

  it('successful atoms remain when one static atom fails — executive_summary', () => {
    const section  = getArtifactSectionOutline('executive_decision_brief').find(s => s.id === 'executive_summary')
    const atomDefs = deriveSectionChildDefs(section, ARTIFACT_BASIS)
    const children = buildChildUnitsWithOneFailed(section.id, atomDefs, 2)

    expect(children[0].lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.ACCEPTED)
    expect(children[1].lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.ACCEPTED)
    expect(children[2].lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.FAILED)
    expect(children[3].lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.ACCEPTED)
  })

  it('a failed atom does not propagate to a section that has other successful sibling sections', () => {
    const execBriefOutline = getArtifactSectionOutline('executive_decision_brief')

    const succeededSection = applySectionGenerationSuccess(
      createArtifactSectionUnit(execBriefOutline.find(s => s.id === 'risk_summary')),
      goodSection('risk_summary', 'Risk Summary'),
      ARTIFACT_BASIS,
    )
    const failedSection = applySectionGenerationFailure(
      createArtifactSectionUnit(execBriefOutline.find(s => s.id === 'recommended_next_steps')),
      'Truncated model output',
    )

    const assembled = assembleArtifactFromSectionUnits([succeededSection, failedSection])
    expect(assembled.contentSections.map(s => s.sectionId)).toContain('risk_summary')
    expect(assembled.artifactGenerationStatus).toBe(ARTIFACT_GENERATION_STATUS.PARTIAL)
  })
})

// ── 4. Retry a failed atom without regenerating successful siblings ─────────────

describe('atom retry isolation', () => {
  it('retrying a failed atom updates only that atom', () => {
    const section  = getArtifactSectionOutline('executive_decision_brief').find(s => s.id === 'key_decisions_required')
    const atomDefs = deriveSectionChildDefs(section, ARTIFACT_BASIS)
    let children   = buildInitialArtifactChildUnits(atomDefs)

    children[0] = applyChildGenerationSuccess(children[0], goodChildContent(atomDefs[0].childId, 'Decision 1'))
    children[1] = applyChildGenerationFailure(children[1], 'Truncated model output')
    children[2] = applyChildGenerationSuccess(children[2], goodChildContent(atomDefs[2].childId, 'Decision 3'))

    // Retry only atom at index 1
    const retried = applyChildGenerationSuccess(children[1], goodChildContent(atomDefs[1].childId, 'Decision 2 retried'))

    expect(retried.lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.ACCEPTED)
    expect(retried.content.heading).toBe('Decision 2 retried')
    // Siblings unchanged
    expect(children[0].lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.ACCEPTED)
    expect(children[2].lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.ACCEPTED)
  })

  it('after all atoms succeed, section can be assembled successfully', () => {
    const section  = getArtifactSectionOutline('executive_decision_brief').find(s => s.id === 'key_decisions_required')
    const atomDefs = deriveSectionChildDefs(section, ARTIFACT_BASIS)
    const children = buildInitialArtifactChildUnits(atomDefs)

    atomDefs.forEach((def, i) => {
      children[i] = applyChildGenerationSuccess(children[i], goodChildContent(def.childId, `Decision ${i + 1}`))
    })

    const sectionUnit = createArtifactSectionUnit(section)
    const assembled   = assembleSectionFromChildUnits({ ...sectionUnit, childUnits: children }, children)

    expect(assembled.lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.ACCEPTED)
    expect(assembled.section).not.toBeNull()
  })
})

// ── 5. Compiled artifact from persisted atoms ──────────────────────────────────

describe('compiled artifact view from persisted atoms', () => {
  it('assembleArtifactFromSectionUnits produces content only from accepted/draft-ready sections', () => {
    const outline = getArtifactSectionOutline('executive_decision_brief')

    const acceptedA = applySectionGenerationSuccess(
      createArtifactSectionUnit(outline[0]),
      goodSection(outline[0].id, outline[0].heading),
      ARTIFACT_BASIS,
    )
    const failedB = applySectionGenerationFailure(
      createArtifactSectionUnit(outline[1]),
      'Truncated model output',
    )
    const acceptedC = applySectionGenerationSuccess(
      createArtifactSectionUnit(outline[2]),
      goodSection(outline[2].id, outline[2].heading),
      ARTIFACT_BASIS,
    )

    const result = assembleArtifactFromSectionUnits([acceptedA, failedB, acceptedC])
    expect(result.contentSections.map(s => s.sectionId)).toEqual([outline[0].id, outline[2].id])
    expect(result.failedSections.map(s => s.sectionId)).toEqual([outline[1].id])
    expect(result.artifactGenerationStatus).toBe(ARTIFACT_GENERATION_STATUS.PARTIAL)
  })

  it('compiled view can be rebuilt by reassembling from sectionUnits stored in the output record', () => {
    const outline = getArtifactSectionOutline('bu_execution_plan')
    const sectionUnits = outline.map(def =>
      applySectionGenerationSuccess(
        createArtifactSectionUnit(def),
        goodSection(def.id, def.heading),
        BU_BASIS,
      )
    )

    const progress = buildArtifactProgressOutput({
      ...OUTPUT_META,
      artifactItem: { artifactId: 'bu_exec_1', artifactType: 'bu_execution_plan', scope: 'businessUnit', title: 'BU Execution Plan', sourceAtomIds: [] },
      sectionUnits,
      artifactBasis: BU_BASIS,
      previousOutput: null,
    })

    // Simulate rebuild: reassemble from stored sectionUnits
    const rebuilt = assembleArtifactFromSectionUnits(progress.sectionUnits)
    expect(rebuilt.contentSections.map(s => s.sectionId)).toEqual(progress.contentSections.map(s => s.sectionId))
  })
})

// ── 6. No section-level single call — specific failing sections ─────────────────

describe('no section-level single calls for supported artifact types', () => {
  it('executive_decision_brief recommended_next_steps uses atomised generation (staticAtoms)', () => {
    const section = getArtifactSectionOutline('executive_decision_brief').find(s => s.id === 'recommended_next_steps')
    expect(section.generationMode).toBe('child_units')
    expect(section.staticAtoms).toBeDefined()
    expect(section.staticAtoms.length).toBeGreaterThan(0)
    expect(section.childSource).toBeUndefined()
    const atoms = deriveSectionChildDefs(section, ARTIFACT_BASIS)
    expect(atoms.length).toBe(section.staticAtoms.length)
    expect(atoms.every(a => a.isStaticAtom)).toBe(true)
  })

  it('global_sme_review_packet cross_bu_scope uses atomised generation (staticAtoms)', () => {
    const section = getArtifactSectionOutline('global_sme_review_packet').find(s => s.id === 'cross_bu_scope')
    expect(section.generationMode).toBe('child_units')
    expect(section.staticAtoms).toBeDefined()
    expect(section.staticAtoms.length).toBeGreaterThan(0)
    const atoms = deriveSectionChildDefs(section, GLOBAL_SME_BASIS)
    expect(atoms.every(a => a.isStaticAtom)).toBe(true)
  })

  it('bu_sme_review_packet review_scope uses atomised generation (staticAtoms)', () => {
    const section = getArtifactSectionOutline('bu_sme_review_packet').find(s => s.id === 'review_scope')
    expect(section.generationMode).toBe('child_units')
    expect(section.staticAtoms).toBeDefined()
    const atoms = deriveSectionChildDefs(section, BU_SME_BASIS)
    expect(atoms.every(a => a.isStaticAtom)).toBe(true)
  })

  it('bu_sme_review_packet recommended_experts uses atomised generation (staticAtoms)', () => {
    const section = getArtifactSectionOutline('bu_sme_review_packet').find(s => s.id === 'recommended_experts')
    expect(section.generationMode).toBe('child_units')
    expect(section.staticAtoms).toBeDefined()
    const atoms = deriveSectionChildDefs(section, BU_SME_BASIS)
    expect(atoms.every(a => a.isStaticAtom)).toBe(true)
  })

  it('bu_execution_plan strategic_context uses atomised generation (staticAtoms)', () => {
    const section = getArtifactSectionOutline('bu_execution_plan').find(s => s.id === 'strategic_context')
    expect(section.generationMode).toBe('child_units')
    expect(section.staticAtoms).toBeDefined()
    const atoms = deriveSectionChildDefs(section, BU_BASIS)
    expect(atoms.every(a => a.isStaticAtom)).toBe(true)
  })
})

// ── 7. BU Execution Plan preserves atomised generation ─────────────────────────

describe('BU Execution Plan atomised generation', () => {
  it('all sections use child_units with either childSource or staticAtoms', () => {
    const outline = getArtifactSectionOutline('bu_execution_plan')
    for (const section of outline) {
      expect(section.generationMode).toBe('child_units')
      const hasSource = !!section.childSource || (section.staticAtoms?.length > 0)
      expect(hasSource).toBe(true)
    }
  })

  it('execution_workstreams creates one atom per mapped execution tactic', () => {
    const section  = getArtifactSectionOutline('bu_execution_plan').find(s => s.id === 'execution_workstreams')
    const atoms    = deriveSectionChildDefs(section, BU_BASIS)
    expect(atoms.length).toBe(BU_BASIS.selectedExecutionTactics.length)
    expect(atoms[0].isStaticAtom).toBe(false)
    expect(atoms[0].sourceItem.optionName).toBe('Threat-Modeled Architecture Review')
  })

  it('dependency_map creates one atom per relevant dependency', () => {
    const section = getArtifactSectionOutline('bu_execution_plan').find(s => s.id === 'dependency_map')
    const atoms   = deriveSectionChildDefs(section, BU_BASIS)
    expect(atoms.length).toBe(BU_BASIS.relevantDependencies.length)
  })

  it('risk_controls creates one atom per relevant risk', () => {
    const section = getArtifactSectionOutline('bu_execution_plan').find(s => s.id === 'risk_controls')
    const atoms   = deriveSectionChildDefs(section, BU_BASIS)
    expect(atoms.length).toBe(BU_BASIS.relevantRisks.length)
  })

  it('can assemble a complete BU Execution Plan from all accepted atoms', () => {
    const outline      = getArtifactSectionOutline('bu_execution_plan')
    const sectionUnits = outline.map(def => {
      const atomDefs  = deriveSectionChildDefs(def, BU_BASIS)
      const children  = buildInitialArtifactChildUnits(atomDefs)
      atomDefs.forEach((d, i) => {
        children[i] = applyChildGenerationSuccess(children[i], goodChildContent(d.childId, d.label))
      })
      const unit = createArtifactSectionUnit(def)
      return assembleSectionFromChildUnits({ ...unit, childUnits: children }, children)
    })

    const assembled = assembleArtifactFromSectionUnits(sectionUnits)
    expect(assembled.artifactGenerationStatus).toBe(ARTIFACT_GENERATION_STATUS.GENERATED)
    expect(assembled.contentSections.length).toBe(outline.length)
  })
})

// ── 8. Prompt content for source-item vs static atoms ─────────────────────────

describe('atom prompt content', () => {
  const artifactItem = { artifactType: 'executive_decision_brief' }
  const handoff      = { buHandoffs: [] }

  it('source-item atom prompt contains ONE SOURCE ITEM ONLY and the item name', () => {
    const section  = getArtifactSectionOutline('executive_decision_brief').find(s => s.id === 'key_decisions_required')
    const atomDefs = deriveSectionChildDefs(section, ARTIFACT_BASIS)
    const atomDef  = atomDefs.find(a => a.sourceItemId === 'dec_1')
    const { messages } = buildArtifactChildPrompt(artifactItem, handoff, section, atomDef, ARTIFACT_BASIS)
    const text = messages[0].content

    expect(text).toContain('ONE SOURCE ITEM ONLY')
    expect(text).toContain('Architecture Gate')       // item name
    expect(text).not.toContain('Dependency Ownership') // sibling item must be excluded
    expect(text).not.toContain('Regulatory Pre-Review Walkthrough') // unmapped tactic excluded
  })

  it('static atom prompt contains the inputBasis directive, not ONE SOURCE ITEM ONLY', () => {
    const section  = getArtifactSectionOutline('executive_decision_brief').find(s => s.id === 'executive_summary')
    const atomDefs = deriveSectionChildDefs(section, ARTIFACT_BASIS)
    const atomDef  = atomDefs[0]
    const { messages } = buildArtifactChildPrompt(artifactItem, handoff, section, atomDef, ARTIFACT_BASIS)
    const text = messages[0].content

    expect(text).not.toContain('ONE SOURCE ITEM ONLY')
    expect(text).toContain('Generation directive:')
    expect(text).toContain(atomDef.inputBasis.slice(0, 30))
  })

  it('static atom prompt for recommended_next_steps uses synthesis context, not single source item', () => {
    const section  = getArtifactSectionOutline('executive_decision_brief').find(s => s.id === 'recommended_next_steps')
    const atomDefs = deriveSectionChildDefs(section, ARTIFACT_BASIS)
    expect(atomDefs.length).toBeGreaterThan(0)

    const { messages } = buildArtifactChildPrompt(artifactItem, handoff, section, atomDefs[0], ARTIFACT_BASIS)
    const text = messages[0].content

    expect(text).toContain('Generation directive:')
    expect(text).not.toContain('ONE SOURCE ITEM ONLY')
  })

  it('cross_bu_scope static atom prompt uses synthesis context', () => {
    const section  = getArtifactSectionOutline('global_sme_review_packet').find(s => s.id === 'cross_bu_scope')
    const atomDefs = deriveSectionChildDefs(section, GLOBAL_SME_BASIS)
    const { messages } = buildArtifactChildPrompt({ artifactType: 'global_sme_review_packet' }, handoff, section, atomDefs[0], GLOBAL_SME_BASIS)
    const text = messages[0].content

    expect(text).toContain('Generation directive:')
    expect(text).not.toContain('ONE SOURCE ITEM ONLY')
  })
})

// ── 9. Unsupported artifact types — no broken partial state ───────────────────

describe('unsupported artifact types', () => {
  const UNSUPPORTED = [
    'acceptance_criteria_draft',
    'implementation_governance_checklist',
    'risk_control_plan',
    'dependency_risk_brief',
    'operating_cadence_plan',
    'cross_bu_dependency_map',
  ]

  it.each(UNSUPPORTED)('%s returns no section outline (safe no-op)', (artifactType) => {
    expect(getArtifactSectionOutline(artifactType)).toBeNull()
    expect(SUPPORTED_GENERATION_TYPES.has(artifactType)).toBe(false)
  })
})

describe('pdlc epic outline generator registration', () => {
  it('uses child-unit sections from the persisted generation-unit shape', () => {
    const outline = getArtifactSectionOutline('pdlc_epic_outline')
    expect(SUPPORTED_GENERATION_TYPES.has('pdlc_epic_outline')).toBe(true)
    expect(outline.map(section => section.id)).toContain('epic_candidates')
    expect(outline.every(section => section.generationMode === 'child_units')).toBe(true)
  })
})

// ── 10. Truncation handled at atom level, not section level ───────────────────

describe('truncation is isolated to the failing atom', () => {
  it('max_tokens response on a child atom fails only that atom', () => {
    const parsed = parseArtifactChildResponse(
      '{"childId":"executive_summary:decision_context"',
      { childId: 'executive_summary:decision_context' },
      { stop_reason: 'max_tokens' },
    )
    expect(parsed.truncated).toBe(true)
    expect(parsed.error).toBe('Truncated model output')
    expect(parsed.child).toBeNull()
  })

  it('sibling atoms in the same section are unaffected by a truncated atom', () => {
    const section  = getArtifactSectionOutline('executive_decision_brief').find(s => s.id === 'executive_summary')
    const atomDefs = deriveSectionChildDefs(section, ARTIFACT_BASIS)
    const children = buildInitialArtifactChildUnits(atomDefs)

    // Atom 0 succeeds, atom 1 is truncated, atom 2 succeeds, atom 3 succeeds
    children[0] = applyChildGenerationSuccess(children[0], goodChildContent(atomDefs[0].childId, 'Decision Context'))
    children[1] = applyChildGenerationFailure(children[1], 'Truncated model output')
    children[2] = applyChildGenerationSuccess(children[2], goodChildContent(atomDefs[2].childId, 'Unresolved Blockers'))
    children[3] = applyChildGenerationSuccess(children[3], goodChildContent(atomDefs[3].childId, 'Leadership Actions'))

    expect(children[0].lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.ACCEPTED)
    expect(children[1].lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.FAILED)
    expect(children[2].lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.ACCEPTED)
    expect(children[3].lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.ACCEPTED)

    // Children 0, 2, 3 retain their content — the truncated atom does not erase them
    expect(children[0].content).not.toBeNull()
    expect(children[2].content).not.toBeNull()
    expect(children[3].content).not.toBeNull()
  })
})
