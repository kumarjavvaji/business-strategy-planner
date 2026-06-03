import { describe, it, expect } from 'vitest'
import {
  ARTIFACT_SECTION_LIFECYCLE,
  ARTIFACT_GENERATION_STATUS,
  createArtifactSectionUnit,
  transitionSectionToGenerating,
} from './stage4ArtifactLifecycle'
import {
  applySectionGenerationSuccess,
  applySectionGenerationFailure,
  assembleArtifactFromSectionUnits,
  buildArtifactProgressOutput,
  OUTPUT_STATUS,
} from './stage4ArtifactOutput'
import {
  buildArtifactSectionPrompt,
  buildArtifactChildPrompt,
  deriveSectionChildDefs,
  getArtifactSectionOutline,
  resolveArtifactGenerator,
  parseArtifactChildResponse,
  parseArtifactSectionResponse,
} from './stage4ArtifactPrompts'
import {
  buildInitialArtifactChildUnits,
  applyChildGenerationSuccess,
  applyChildGenerationFailure,
  assembleSectionFromChildUnits,
} from './stage4ArtifactOutput'

const basis = {
  counts: { mappedHowOptions: 1 },
  selectedExecutionTactics: [{ optionName: 'Threat-Modeled Architecture Review' }],
  relevantDecisions: [
    { id: 'decision_1', name: 'Decision 1', summary: 'Approve architecture evidence gate.' },
    { id: 'decision_2', name: 'Decision 2', summary: 'Approve dependency ownership gate.' },
    { id: 'decision_3', name: 'Decision 3', summary: 'Approve validation evidence gate.' },
    { id: 'decision_4', name: 'Decision 4', summary: 'Approve production readiness gate.' },
  ],
  excludedContextSummary: { unmappedTacticNames: ['Regulatory Pre-Review Walkthrough'] },
}

const outputMeta = {
  workspaceId: 'workspace_1',
  stage1Id: 'stage1_1',
  stage2Id: 'stage2_1',
  stage3Id: 'stage3_1',
  handoff: { persistedAt: 'handoff_time' },
  plan: { persistedAt: 'plan_time', handoffKey: 'handoff_key' },
  artifactItem: {
    artifactId: 'executive_decision_brief_global',
    artifactType: 'executive_decision_brief',
    scope: 'global',
    title: 'Executive Decision Brief',
    sourceAtomIds: [],
  },
}

function goodSection(id = 'executive_summary') {
  return {
    sectionId: id,
    heading: 'Executive Summary',
    purpose: 'Summarize the decision needed.',
    body: 'Threat-Modeled Architecture Review is the mapped tactic informing this decision. The section states the action, owner, gate, and evidence required before proceeding.',
    sourceAtomIds: [],
    openQuestions: [],
    confidenceLevel: 'medium',
  }
}

describe('stage4 artifact section lifecycle', () => {
  it('uses shared lifecycle adapter states for section units', () => {
    const unit = createArtifactSectionUnit({ id: 'executive_summary', heading: 'Executive Summary', purpose: 'Test' })
    expect(unit.lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.NOT_STARTED)
    expect(transitionSectionToGenerating(unit).lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.GENERATING)
  })

  it('successful sections remain when a later section fails', () => {
    const first = applySectionGenerationSuccess(
      createArtifactSectionUnit({ id: 'executive_summary', heading: 'Executive Summary', purpose: 'Test' }),
      goodSection('executive_summary'),
      basis,
    )
    const second = applySectionGenerationFailure(
      createArtifactSectionUnit({ id: 'risk_summary', heading: 'Risk Summary', purpose: 'Test' }),
      'Truncated model output',
    )
    const assembled = assembleArtifactFromSectionUnits([first, second])

    expect(first.lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.ACCEPTED)
    expect(second.lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.FAILED)
    expect(assembled.artifactGenerationStatus).toBe(ARTIFACT_GENERATION_STATUS.PARTIAL)
    expect(assembled.contentSections.map(s => s.sectionId)).toEqual(['executive_summary'])
    expect(assembled.failedSections[0].sectionId).toBe('risk_summary')
  })

  it('failed section can be retried alone', () => {
    const failed = applySectionGenerationFailure(
      createArtifactSectionUnit({ id: 'risk_summary', heading: 'Risk Summary', purpose: 'Test' }),
      'Parse failure',
    )
    const retried = applySectionGenerationSuccess(failed, goodSection('risk_summary'), basis)

    expect(failed.lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.FAILED)
    expect(retried.lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.ACCEPTED)
    expect(retried.section.sectionId).toBe('risk_summary')
  })
})

describe('stage4 section prompts and parsing', () => {
  it('unsupported artifact type is not routed through a generic generator', () => {
    const result = buildArtifactSectionPrompt({ artifactType: 'cross_bu_dependency_map' }, { buHandoffs: [] }, { id: 'x' }, basis)
    expect(result.isSupported).toBe(false)
    expect(result.messages).toBeNull()
  })

  it('pdlc_epic_outline resolves to the registered atomic generator', () => {
    const generator = resolveArtifactGenerator('pdlc_epic_outline')
    expect(generator).toEqual(expect.objectContaining({
      artifactType: 'pdlc_epic_outline',
      executionMode: 'atomic_section_child_units',
    }))
    expect(generator.getSectionOutline().map(section => section.id)).toContain('epic_candidates')
  })

  it('max_tokens response fails only the affected section', () => {
    const parsed = parseArtifactSectionResponse('{"sectionId":"executive_summary"', { id: 'executive_summary' }, { stop_reason: 'max_tokens' })
    expect(parsed.error).toBe('Truncated model output')
    expect(parsed.truncated).toBe(true)
    expect(parsed.section).toBeNull()
  })

  it('generated artifact is assembled only from valid generated sections', () => {
    const good = applySectionGenerationSuccess(
      createArtifactSectionUnit({ id: 'executive_summary', heading: 'Executive Summary', purpose: 'Test' }),
      goodSection('executive_summary'),
      basis,
    )
    const bad = applySectionGenerationFailure(
      createArtifactSectionUnit({ id: 'risk_summary', heading: 'Risk Summary', purpose: 'Test' }),
      'Missing required section fields: body',
    )

    const assembled = assembleArtifactFromSectionUnits([good, bad])
    expect(assembled.contentSections).toHaveLength(1)
    expect(assembled.contentSections[0].sectionId).toBe('executive_summary')
  })

  it('progress output persists completed sections before full artifact assembly', () => {
    const good = applySectionGenerationSuccess(
      createArtifactSectionUnit({ id: 'executive_summary', heading: 'Executive Summary', purpose: 'Test' }),
      goodSection('executive_summary'),
      basis,
    )
    const failed = applySectionGenerationFailure(
      createArtifactSectionUnit({ id: 'risk_summary', heading: 'Risk Summary', purpose: 'Test' }),
      'Parse failure',
    )
    const previousOutput = {
      generationStatus: OUTPUT_STATUS.GENERATED,
      artifactGenerationStatus: 'generated',
      contentSections: [goodSection('previous')],
      persistedAt: 'previous_time',
    }

    const progress = buildArtifactProgressOutput({
      ...outputMeta,
      sectionUnits: [good, failed],
      artifactBasis: basis,
      previousOutput,
    })

    expect(progress.generationStatus).toBe(OUTPUT_STATUS.PARTIAL)
    expect(progress.artifactGenerationStatus).toBe(ARTIFACT_GENERATION_STATUS.PARTIAL)
    expect(progress.contentSections.map(section => section.sectionId)).toEqual(['executive_summary'])
    expect(progress.sectionUnits[1].lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.FAILED)
    expect(progress.previousAcceptedOutput.contentSections[0].sectionId).toBe('previous')
  })

  it('implemented artifact types expose section outlines', () => {
    expect(getArtifactSectionOutline('executive_decision_brief')).toContainEqual(expect.objectContaining({ id: 'executive_summary' }))
    expect(getArtifactSectionOutline('bu_execution_plan')).toContainEqual(expect.objectContaining({ id: 'execution_workstreams' }))
    expect(getArtifactSectionOutline('pdlc_epic_outline')).toContainEqual(expect.objectContaining({ id: 'epic_candidates' }))
    expect(getArtifactSectionOutline('global_sme_review_packet')).toContainEqual(expect.objectContaining({ id: 'cross_bu_scope' }))
  })

  it('key_decisions_required creates one child unit per decision', () => {
    const section = getArtifactSectionOutline('executive_decision_brief').find(s => s.id === 'key_decisions_required')
    const childDefs = deriveSectionChildDefs(section, basis)
    const childUnits = buildInitialArtifactChildUnits(childDefs)

    expect(section.generationMode).toBe('child_units')
    expect(childDefs).toHaveLength(4)
    expect(childUnits.map(child => child.lifecycle)).toEqual([
      ARTIFACT_SECTION_LIFECYCLE.NOT_STARTED,
      ARTIFACT_SECTION_LIFECYCLE.NOT_STARTED,
      ARTIFACT_SECTION_LIFECYCLE.NOT_STARTED,
      ARTIFACT_SECTION_LIFECYCLE.NOT_STARTED,
    ])
  })

  it('max_tokens on one decision child fails only that child and preserves siblings', () => {
    const section = getArtifactSectionOutline('executive_decision_brief').find(s => s.id === 'key_decisions_required')
    const childDefs = deriveSectionChildDefs(section, basis)
    let children = buildInitialArtifactChildUnits(childDefs)
    children[0] = applyChildGenerationSuccess(children[0], { childId: childDefs[0].childId, heading: 'Decision 1', body: 'Approve architecture evidence gate with owner, timing, and evidence.' })
    children[1] = applyChildGenerationSuccess(children[1], { childId: childDefs[1].childId, heading: 'Decision 2', body: 'Approve dependency ownership gate with owner, timing, and evidence.' })
    children[2] = applyChildGenerationSuccess(children[2], { childId: childDefs[2].childId, heading: 'Decision 3', body: 'Approve validation evidence gate with owner, timing, and evidence.' })
    const parsed = parseArtifactChildResponse('{"childId":"x"', childDefs[3], { stop_reason: 'max_tokens' })
    children[3] = applyChildGenerationFailure(children[3], parsed.failureReason)

    const parent = assembleSectionFromChildUnits(
      createArtifactSectionUnit({ id: section.id, heading: section.heading, purpose: section.purpose, generationMode: 'child_units' }),
      children,
    )

    expect(children[0].lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.ACCEPTED)
    expect(children[3].lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.FAILED)
    expect(parent.lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.FAILED)
    expect(parent.section).toBeNull()
  })

  it('progress output exposes completed child units before the parent section is assembled', () => {
    const section = getArtifactSectionOutline('executive_decision_brief').find(s => s.id === 'key_decisions_required')
    const childDefs = deriveSectionChildDefs(section, basis)
    const children = buildInitialArtifactChildUnits(childDefs)
    children[0] = applyChildGenerationSuccess(children[0], { childId: childDefs[0].childId, heading: 'Decision 1', body: 'Approve architecture evidence gate with owner, timing, and evidence.' })
    children[1] = applyChildGenerationFailure(children[1], 'Empty response from API')
    const partialParent = {
      ...createArtifactSectionUnit({ id: section.id, heading: section.heading, purpose: section.purpose, generationMode: 'child_units' }),
      generationMode: 'child_units',
      childUnits: children,
    }

    const progress = buildArtifactProgressOutput({
      ...outputMeta,
      sectionUnits: [partialParent],
      artifactBasis: basis,
      previousOutput: null,
    })

    expect(progress.generationStatus).toBe(OUTPUT_STATUS.PARTIAL)
    expect(progress.contentSections).toHaveLength(0)
    expect(progress.sectionUnits[0].childUnits[0].content.body).toContain('Approve architecture evidence gate')
    expect(progress.sectionUnits[0].childUnits[1].lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.FAILED)
  })

  it('failed child can be retried independently', () => {
    const section = getArtifactSectionOutline('executive_decision_brief').find(s => s.id === 'key_decisions_required')
    const childDef = deriveSectionChildDefs(section, basis)[3]
    const failed = applyChildGenerationFailure(createArtifactSectionUnit({ id: childDef.childId, heading: childDef.label, purpose: 'Child' }), 'Truncated model output')
    const retried = applyChildGenerationSuccess(failed, { childId: childDef.childId, heading: 'Decision 4', body: 'Approve production readiness gate with owner, timing, and evidence.' })

    expect(failed.lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.FAILED)
    expect(retried.lifecycle).toBe(ARTIFACT_SECTION_LIFECYCLE.ACCEPTED)
  })

  it('child prompts receive only one source item plus minimal context and exclude unmapped tactics', () => {
    const section = getArtifactSectionOutline('executive_decision_brief').find(s => s.id === 'key_decisions_required')
    const childDef = deriveSectionChildDefs(section, basis)[0]
    const prompt = buildArtifactChildPrompt({ artifactType: 'executive_decision_brief' }, { buHandoffs: [] }, section, childDef, basis)
    const text = prompt.messages[0].content

    expect(text).toContain('ONE SOURCE ITEM ONLY')
    expect(text).toContain('Decision 1')
    expect(text).not.toContain('Decision 2')
    expect(text).not.toContain('Regulatory Pre-Review Walkthrough')
  })
})
