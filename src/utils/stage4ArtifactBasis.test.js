import { describe, it, expect } from 'vitest'
import { compileArtifactBasis, basisReadinessSummary, basisPreviewText, computeArtifactReadinessForBu } from './stage4ArtifactBasis'
import { auditArtifactOutput, mergeArtifactSectionResults } from './stage4ArtifactOutput'

function makePanelModel() {
  return {
    panels: {
      strategicObjective: {
        lifecycle: 'accepted',
        content: {
          summary: 'Explainability delivery must meet SR 11-7 expectations while reducing partner dependency.',
          outcomeFocus: 'Operationalize examiner-ready explainability evidence.',
        },
      },
      executionSequence: {
        lifecycle: 'accepted',
        content: [{
          phaseName: 'Architecture Readiness',
          howOptions: [
            {
              optionName: 'Threat-Modeled Architecture Review',
              whenToUse: 'Use before architecture sign-off when model explainability controls must be reviewed.',
              whyItFitsThePhaseOutcome: 'It tests whether the architecture can produce examiner-ready evidence.',
              evidenceProduced: 'Signed architecture review memo and evidence trace.',
            },
            {
              optionName: 'Contract Engineer Scope Simulation',
              whenToUse: 'Use when contract engineer delivery scope could create dependency or ownership risk.',
              whyItFitsThePhaseOutcome: 'It exposes execution feasibility and dependency risks before staffing.',
              evidenceProduced: 'Scope simulation notes and unresolved dependency log.',
            },
            {
              optionName: 'Regulatory Pre-Review Walkthrough',
              whenToUse: 'Use when compliance needs an early view of examiner-facing outputs.',
              whyItFitsThePhaseOutcome: 'It validates regulatory interpretability before build commitment.',
              evidenceProduced: 'Compliance questions and sign-off evidence.',
            },
          ],
        }],
        executionDeliverableMappings: {
          architecture_readiness: {
            howOptionMappings: {
              threat_modeled_architecture_review: {
                mappedDeliverables: ['bu_execution_plan', 'executive_decision_brief'],
              },
              contract_engineer_scope_simulation: {
                mappedDeliverables: ['bu_execution_plan', 'global_sme_review_packet'],
              },
              regulatory_pre_review_walkthrough: {
                mappedDeliverables: ['acceptance_criteria_draft'],
              },
            },
          },
        },
        selectedStage4Deliverables: [
          { deliverableType: 'bu_execution_plan', status: 'mapped' },
          { deliverableType: 'acceptance_criteria_draft', status: 'mapped' },
        ],
      },
      criticalDecisions: {
        lifecycle: 'accepted',
        content: [{
          decisionName: 'Architecture evidence gate',
          decisionQuestion: 'Can architecture sign-off proceed with examiner-ready evidence?',
          decisionEvidenceNeeded: 'Signed architecture review memo.',
        }],
      },
      dependencies: {
        lifecycle: 'accepted',
        content: [{
          dependencyName: 'Contract engineer scope',
          dependencyDescription: 'Contract engineer scope must be bounded before staffing.',
          requiredInput: 'Scope simulation notes.',
        }],
      },
      risks: {
        lifecycle: 'accepted',
        content: [{
          riskName: 'Ownership leakage',
          riskDescription: 'Contract engineer work could create ownership and dependency risk.',
          evidenceThatRiskIsReduced: 'Dependency log closed.',
        }],
      },
      validationFramework: {
        lifecycle: 'accepted',
        content: [{
          validationQuestion: 'Does the architecture produce examiner-ready evidence?',
          completionCriteria: 'Evidence trace is produced and signed off.',
          evidenceExamples: ['Signed review memo'],
        }],
      },
    },
  }
}

function makeHandoff(panelModel = makePanelModel()) {
  return {
    buHandoffs: [{
      buName: 'Product & Competitive Architecture',
      status: 'ready',
      sourceAtomIds: ['atom_1'],
      sourceSectionIds: ['Architecture Readiness'],
      plan: { strategicRole: 'Own explainability architecture.' },
      stage3PanelModel: panelModel,
    }],
  }
}

describe('compileArtifactBasis', () => {
  it('includes only how options mapped to the requested artifact', () => {
    const basis = compileArtifactBasis({
      artifactType: 'bu_execution_plan',
      businessUnitName: 'Product & Competitive Architecture',
    }, makeHandoff())

    expect(basis.selectedExecutionTactics.map(t => t.optionName)).toEqual([
      'Threat-Modeled Architecture Review',
      'Contract Engineer Scope Simulation',
    ])
    expect(basis.selectedExecutionTactics.map(t => t.optionName)).not.toContain('Regulatory Pre-Review Walkthrough')
  })

  it('includes relevant decisions, dependencies, risks, and validation items', () => {
    const basis = compileArtifactBasis({
      artifactType: 'bu_execution_plan',
      businessUnitName: 'Product & Competitive Architecture',
    }, makeHandoff())

    expect(basis.relevantDecisions[0].name).toBe('Architecture evidence gate')
    expect(basis.relevantDependencies[0].name).toBe('Contract engineer scope')
    expect(basis.relevantRisks[0].name).toBe('Ownership leakage')
    expect(basis.relevantValidationQuestions[0].name).toBe('Does the architecture produce examiner-ready evidence?')
  })

  it('warns when a selected artifact has no mapped tactics', () => {
    const basis = compileArtifactBasis({
      artifactType: 'operating_cadence_plan',
      businessUnitName: 'Product & Competitive Architecture',
    }, makeHandoff())

    expect(basis.counts.mappedHowOptions).toBe(0)
    expect(basis.basisWarnings.join(' ')).toContain('No mapped how options')
  })

  it('Executive Decision Brief basis avoids full execution-method detail', () => {
    const basis = compileArtifactBasis({
      artifactType: 'executive_decision_brief',
      businessUnitName: null,
    }, makeHandoff())

    expect(basis.selectedExecutionTactics.map(t => t.optionName)).not.toContain('Regulatory Pre-Review Walkthrough')
    expect(basis.selectedExecutionTactics[0]).toHaveProperty('optionName')
  })

  it('SME Review Packet focuses on mapped tactics requiring review', () => {
    const basis = compileArtifactBasis({
      artifactType: 'global_sme_review_packet',
      businessUnitName: 'Product & Competitive Architecture',
    }, makeHandoff())

    expect(basis.selectedExecutionTactics.map(t => t.optionName)).toContain('Contract Engineer Scope Simulation')
    expect(basis.relevantRisks.length).toBeGreaterThan(0)
  })

  // ── D8 — artifact-specific readiness with deep links ───────────────────────

  it('returns missingPrerequisites with deep-link info when no tactics are mapped', () => {
    const basis = compileArtifactBasis({
      artifactType: 'operating_cadence_plan',
      businessUnitName: 'Product & Competitive Architecture',
    }, makeHandoff())

    expect(basis.missingPrerequisites).toBeDefined()
    expect(basis.missingPrerequisites.length).toBeGreaterThan(0)
    const missing = basis.missingPrerequisites[0]
    expect(missing.type).toBe('unmapped_execution_tactics')
    expect(missing.panelId).toBe('executionSequence')
    expect(missing.deepLinkPanelId).toBe('executionSequence')
    expect(missing.description).toContain('operating_cadence_plan')
    expect(Array.isArray(missing.remediationSteps)).toBe(true)
    expect(missing.remediationSteps.length).toBeGreaterThan(0)
  })

  it('returns empty missingPrerequisites when tactics are mapped', () => {
    const basis = compileArtifactBasis({
      artifactType: 'bu_execution_plan',
      businessUnitName: 'Product & Competitive Architecture',
    }, makeHandoff())

    expect(basis.missingPrerequisites).toHaveLength(0)
  })

  it('returns missing_stage3_panel_model prerequisite when BU has no panel model', () => {
    const handoffWithoutPanelModel = {
      buHandoffs: [{
        buName: 'BU Without Panel Model',
        status: 'ready',
        plan: { strategicRole: 'Own explainability architecture.' },
        stage3PanelModel: null,   // no panel model
        panelModel: null,
        sourcePanelModel: null,
      }],
    }
    const basis = compileArtifactBasis(
      { artifactType: 'bu_execution_plan', businessUnitName: 'BU Without Panel Model' },
      handoffWithoutPanelModel,
    )
    const modelMissing = basis.missingPrerequisites.find(p => p.type === 'missing_stage3_panel_model')
    expect(modelMissing).toBeDefined()
    expect(modelMissing.affectedBuNames).toContain('BU Without Panel Model')
    expect(modelMissing.remediationSteps.length).toBeGreaterThan(0)
  })
})

// ── D8 — basisReadinessSummary: source-grounded, no generic filler ─────────────

describe('basisReadinessSummary', () => {
  it('returns null for null input', () => {
    expect(basisReadinessSummary(null)).toBeNull()
  })

  it('includes BU name and source record when tactics are mapped', () => {
    const basis = compileArtifactBasis({
      artifactType: 'bu_execution_plan',
      businessUnitName: 'Product & Competitive Architecture',
    }, makeHandoff())

    const summary = basisReadinessSummary(basis)
    expect(summary).not.toBeNull()
    expect(summary.sourceRecord).toContain('Product & Competitive Architecture')
    expect(summary.prereqsMet.some(p => p.includes('tactic'))).toBe(true)
    expect(summary.prereqsMissing).toHaveLength(0)
    expect(summary.isReady).toBe(true)
  })

  it('includes prereqsMissing and next action when no tactics mapped', () => {
    const basis = compileArtifactBasis({
      artifactType: 'operating_cadence_plan',
      businessUnitName: 'Product & Competitive Architecture',
    }, makeHandoff())

    const summary = basisReadinessSummary(basis)
    expect(summary.isReady).toBe(false)
    expect(summary.prereqsMissing.length).toBeGreaterThan(0)
    expect(summary.nextAction).toBeTruthy()
    expect(summary.nextAction).not.toBe('')
  })

  it('reports atom count from source traceability', () => {
    const basis = compileArtifactBasis({
      artifactType: 'bu_execution_plan',
      businessUnitName: 'Product & Competitive Architecture',
    }, makeHandoff())

    const summary = basisReadinessSummary(basis)
    // atomCount comes from sourceTraceability.sourceAtomIds
    expect(typeof summary.atomCount).toBe('number')
  })

  it('basisPreviewText does not return generic filler when basis is ready', () => {
    const basis = compileArtifactBasis({
      artifactType: 'bu_execution_plan',
      businessUnitName: 'Product & Competitive Architecture',
    }, makeHandoff())

    const text = basisPreviewText(basis)
    expect(text).not.toBe('No basis available.')
    expect(text).toContain('tactic')
    // Should NOT be the old generic boilerplate
    expect(text).not.toMatch(/^This artifact will use/)
  })
})

describe('auditArtifactOutput', () => {
  it('flags copied Stage 3 prose', () => {
    const basis = compileArtifactBasis({
      artifactType: 'bu_execution_plan',
      businessUnitName: 'Product & Competitive Architecture',
    }, makeHandoff())
    const audit = auditArtifactOutput({
      artifactBasis: basis,
      contentSections: [{
        heading: 'Execution Workstreams',
        body: 'Threat-Modeled Architecture Review. Use before architecture sign-off when model explainability controls must be reviewed.',
      }],
    })

    expect(audit.findings.some(f => f.type === 'copied_stage3_prose')).toBe(true)
  })

  it('flags unmapped tactics appearing in output', () => {
    const basis = compileArtifactBasis({
      artifactType: 'bu_execution_plan',
      businessUnitName: 'Product & Competitive Architecture',
    }, makeHandoff())
    const audit = auditArtifactOutput({
      artifactBasis: basis,
      contentSections: [{
        heading: 'Execution Workstreams',
        body: 'Threat-Modeled Architecture Review and Regulatory Pre-Review Walkthrough are both in scope.',
      }],
    })

    expect(audit.findings.some(f => f.type === 'unmapped_tactic_included')).toBe(true)
  })

  it('flags repeated section language', () => {
    const repeated = 'The delivery team must complete evidence review before the next gate opens'
    const audit = auditArtifactOutput({
      artifactBasis: null,
      contentSections: [
        { heading: 'A', body: `${repeated}.` },
        { heading: 'B', body: `${repeated}.` },
      ],
    })

    expect(audit.findings.some(f => f.type === 'repeated_section_language')).toBe(true)
  })

  it('preserves successful sections when another section fails', () => {
    const merged = mergeArtifactSectionResults(
      [{ sectionId: 'summary', heading: 'Summary', body: 'Existing good section.' }],
      [
        { sectionId: 'controls', status: 'generated', section: { sectionId: 'controls', heading: 'Controls', body: 'New good section.' } },
        { sectionId: 'risks', status: 'failed', error: 'Truncated model output' },
      ],
    )

    expect(merged.contentSections.map(s => s.sectionId)).toEqual(['summary', 'controls'])
    expect(merged.failedSections).toEqual([{ sectionId: 'risks', status: 'failed', error: 'Truncated model output' }])
  })
})

// ── D28: computeArtifactReadinessForBu ────────────────────────────────────────

function makeBuHandoff(overrides = {}) {
  return {
    buName: 'Engineering & API Infrastructure',
    status: 'ready',
    sourceAtomIds: Array.from({ length: 49 }, (_, i) => `atom_${i}`),
    completedAtomCount: 49,
    blockedReason: null,
    plan: {
      mission: 'Deliver accepted execution infrastructure for model explainability.',
      strategicRole: 'Own API, evidence, and platform readiness for explainability delivery.',
    },
    stage3PanelModel: makePanelModel(),
    ...overrides,
  }
}

const REVIEW_TARGET_LABELS = [
  'BU summary / thesis',
  'Execution Sequence -> Stage 4 deliverable mapping',
  'Compiled Strategy Quality Audit',
]

function passingCompiledAudit() {
  return {
    failedCount: 0,
    passedCount: 4,
    violations: [],
    results: [{ ruleId: 'accepted_structure', label: 'Compiled strategy follows accepted structure.', status: 'pass' }],
  }
}

function blockingCompiledAudit() {
  return {
    failedCount: 1,
    passedCount: 3,
    violations: [{
      ruleId: 'reduce_repetition',
      label: 'Reduce repetition',
      status: 'fail',
      message: 'Compiled view repetition still fails and is blocking.',
    }],
    results: [{
      ruleId: 'reduce_repetition',
      label: 'Reduce repetition',
      status: 'fail',
      message: 'Compiled view repetition still fails and is blocking.',
    }],
  }
}

describe('D28 — computeArtifactReadinessForBu', () => {
  it('returns ready when mapped how options exist and BU is not stale', () => {
    const handoff = makeBuHandoff()
    const results = computeArtifactReadinessForBu(handoff, null)
    const buExecPlan = results.find(r => r.artifactId === 'bu_execution_plan')
    expect(buExecPlan).toBeDefined()
    expect(buExecPlan.readinessStatus).toBe('ready')
    expect(buExecPlan.mappedHowOptionsCount).toBeGreaterThan(0)
    expect(buExecPlan.sourceAtomCount).toBeGreaterThan(0)
  })

  it('populated and accepted source panels plus complete mapping and passing audit returns ready', () => {
    const handoff = makeBuHandoff()
    const results = computeArtifactReadinessForBu(handoff, null, {
      reviewTargets: REVIEW_TARGET_LABELS,
      qualityAudit: passingCompiledAudit(),
    })
    const buExecPlan = results.find(r => r.artifactId === 'bu_execution_plan')
    expect(buExecPlan.readinessStatus).toBe('ready')
    expect(buExecPlan.reviewTargets.every(target => target.status === 'resolved' || target.status === 'advisory')).toBe(true)
    expect(buExecPlan.reviewTargets.filter(target => target.status === 'unresolved')).toEqual([])
  })

  it('returns blocked_missing_mapping when selected artifact has zero mapped how options', () => {
    const panelModel = makePanelModel()
    // Add an artifact with no mapping
    panelModel.panels.executionSequence.selectedStage4Deliverables.push({
      deliverableType: 'operating_cadence_plan',
      status: 'user_selected',
    })
    const handoff = makeBuHandoff({ stage3PanelModel: panelModel })
    const results = computeArtifactReadinessForBu(handoff, null)
    const cadence = results.find(r => r.artifactId === 'operating_cadence_plan')
    expect(cadence).toBeDefined()
    expect(cadence.readinessStatus).toBe('blocked_missing_mapping')
    expect(cadence.sourcePanelId).toBe('executionSequence')
    expect(cadence.sourcePanelLabel).toBe('Execution Sequence')
    expect(cadence.missingPrerequisites.length).toBeGreaterThan(0)
    expect(cadence.missingMappings).toEqual(['operating_cadence_plan'])
    expect(cadence.remediationTarget).toContain('Execution Sequence')
  })

  it('populated source panels plus incomplete mapping resolves review targets with only mapping unresolved', () => {
    const panelModel = makePanelModel()
    panelModel.panels.executionSequence.selectedStage4Deliverables.push({
      deliverableType: 'operating_cadence_plan',
      status: 'user_selected',
    })
    const handoff = makeBuHandoff({ stage3PanelModel: panelModel })
    const results = computeArtifactReadinessForBu(handoff, 'review_recommended', {
      buSeverity: 'review_recommended',
      reviewTargets: ['Execution Sequence -> Stage 4 deliverable mapping'],
      qualityAudit: passingCompiledAudit(),
    })
    const cadence = results.find(r => r.artifactId === 'operating_cadence_plan')
    const unresolved = cadence.reviewTargets.filter(target => target.status === 'unresolved')
    expect(cadence.readinessStatus).toBe('review_recommended')
    expect(unresolved).toHaveLength(1)
    expect(unresolved[0].targetId).toBe('stage4_deliverable_mapping')
    expect(unresolved[0].reason).toBe('selected artifact has 0 mapped how options')
    expect(cadence.finalReadinessReason).toContain('Stage 4 deliverable mapping')
  })

  it('returns ready_with_upstream_advisory when upstream review is advisory and source panels are accepted', () => {
    const handoff = makeBuHandoff()
    const results = computeArtifactReadinessForBu(handoff, 'review_recommended')
    const buExecPlan = results.find(r => r.artifactId === 'bu_execution_plan')
    expect(['ready_with_upstream_advisory', 'ready']).toContain(buExecPlan.readinessStatus)
    expect(buExecPlan.readinessStatus).not.toBe('review_recommended')
    expect(buExecPlan.upstreamReviewReason).toBe('Upstream changed; no material impact detected. Source components accepted.')
    expect(buExecPlan.finalReadinessReason).toContain('accepted')
  })

  it('returns blocked_materially_stale when BU is materially_stale', () => {
    const handoff = makeBuHandoff()
    const results = computeArtifactReadinessForBu(handoff, 'materially_stale')
    results.forEach(r => {
      expect(r.readinessStatus).toBe('blocked_materially_stale')
    })
  })

  it('returns blocked_materially_stale when a required source panel has material stale impact', () => {
    const handoff = makeBuHandoff()
    const results = computeArtifactReadinessForBu(handoff, 'review_recommended', {
      buSeverity: 'review_recommended',
      panelImpacts: [{ panelId: 'executionSequence', severity: 'materially_stale' }],
    })
    const buExecPlan = results.find(r => r.artifactId === 'bu_execution_plan')
    expect(buExecPlan.readinessStatus).toBe('blocked_materially_stale')
    expect(buExecPlan.materialStalePanels).toEqual(['executionSequence'])
    expect(buExecPlan.finalReadinessReason).toContain('Execution Sequence')
  })

  it('returns review_recommended when a required source panel is unaccepted', () => {
    const panelModel = makePanelModel()
    panelModel.panels.dependencies.lifecycle = 'draft_ready'
    const handoff = makeBuHandoff({ stage3PanelModel: panelModel })
    const results = computeArtifactReadinessForBu(handoff, null)
    const buExecPlan = results.find(r => r.artifactId === 'bu_execution_plan')
    expect(buExecPlan.readinessStatus).toBe('review_recommended')
    expect(buExecPlan.unacceptedSourcePanels).toContain('dependencies')
    expect(buExecPlan.upstreamReviewReason).toContain('Dependencies')
    expect(buExecPlan.finalReadinessReason).toContain('Dependencies')
  })

  it('review_recommended row includes exact unresolved review reason', () => {
    const handoff = makeBuHandoff()
    const results = computeArtifactReadinessForBu(handoff, 'unknown_impact')
    const buExecPlan = results.find(r => r.artifactId === 'bu_execution_plan')
    expect(buExecPlan.readinessStatus).toBe('review_recommended')
    expect(buExecPlan.upstreamReviewReason).toContain('unknown')
    expect(buExecPlan.finalReadinessReason).toContain('unknown')
  })

  it('blocking compiled audit violation leaves only audit target unresolved', () => {
    const handoff = makeBuHandoff()
    const results = computeArtifactReadinessForBu(handoff, 'review_recommended', {
      buSeverity: 'review_recommended',
      reviewTargets: ['Compiled Strategy Quality Audit'],
      qualityAudit: blockingCompiledAudit(),
    })
    const buExecPlan = results.find(r => r.artifactId === 'bu_execution_plan')
    const unresolved = buExecPlan.reviewTargets.filter(target => target.status === 'unresolved')
    expect(buExecPlan.readinessStatus).toBe('review_recommended')
    expect(unresolved).toHaveLength(1)
    expect(unresolved[0].targetId).toBe('compiled_strategy_quality_audit')
    expect(unresolved[0].reason).toContain('repetition')
    expect(buExecPlan.finalReadinessReason).toContain('Compiled Strategy Quality Audit')
  })

  it('returns blocked_missing_source when BU handoff is blocked', () => {
    const handoff = makeBuHandoff({
      status: 'blocked',
      blockedReason: 'No durable Stage 3 record found.',
      stage3PanelModel: null,
    })
    const results = computeArtifactReadinessForBu(handoff, null)
    results.forEach(r => {
      expect(r.readinessStatus).toBe('blocked_missing_source')
    })
  })

  it('returns blocked_missing_source when panel model is absent', () => {
    const handoff = makeBuHandoff({ stage3PanelModel: null })
    const results = computeArtifactReadinessForBu(handoff, null)
    results.forEach(r => {
      expect(r.readinessStatus).toBe('blocked_missing_source')
    })
  })

  it('each result record has all required fields', () => {
    const results = computeArtifactReadinessForBu(makeBuHandoff(), null)
    expect(results.length).toBeGreaterThan(0)
    results.forEach(r => {
      expect(r).toHaveProperty('buName')
      expect(r).toHaveProperty('buId')
      expect(r).toHaveProperty('artifactId')
      expect(r).toHaveProperty('artifactTitle')
      expect(r).toHaveProperty('anchorId')
      expect(r).toHaveProperty('readinessStatus')
      expect(r).toHaveProperty('requiredSourcePanels')
      expect(r).toHaveProperty('acceptedSourcePanels')
      expect(r).toHaveProperty('unacceptedSourcePanels')
      expect(r).toHaveProperty('materialStalePanels')
      expect(r).toHaveProperty('missingMappings')
      expect(r).toHaveProperty('reviewTargets')
      expect(r).toHaveProperty('mappedHowOptionsCount')
      expect(r).toHaveProperty('sourceAtomCount')
      expect(r).toHaveProperty('missingPrerequisites')
      expect(r).toHaveProperty('upstreamReviewReason')
      expect(r).toHaveProperty('finalReadinessReason')
      expect(r).toHaveProperty('blockingReason')
      expect(r).toHaveProperty('sourcePanelId')
      expect(r).toHaveProperty('sourcePanelLabel')
      expect(r).toHaveProperty('remediationTarget')
    })
  })

  it('returns empty array for null handoff', () => {
    expect(computeArtifactReadinessForBu(null, null)).toEqual([])
  })

  it('returns empty array when no deliverables are selected', () => {
    const panelModel = makePanelModel()
    panelModel.panels.executionSequence.selectedStage4Deliverables = []
    const handoff = makeBuHandoff({ stage3PanelModel: panelModel })
    expect(computeArtifactReadinessForBu(handoff, null)).toEqual([])
  })

  it('ready artifact shows mapped how option count and source atom count', () => {
    const handoff = makeBuHandoff()
    const results = computeArtifactReadinessForBu(handoff, null)
    const ready = results.find(r => r.readinessStatus === 'ready')
    if (ready) {
      expect(ready.mappedHowOptionsCount).toBeGreaterThan(0)
      expect(ready.sourceAtomCount).toBe(49)
    }
  })

  it('upstream version mismatch alone does not override accepted source readiness', () => {
    const handoff = makeBuHandoff()
    const results = computeArtifactReadinessForBu(handoff, 'review_recommended', {
      buSeverity: 'review_recommended',
      panelImpacts: [],
      reviewTargets: [],
    })
    const ready = results.find(r => r.artifactId === 'bu_execution_plan')
    expect(ready.readinessStatus).toBe('ready_with_upstream_advisory')
    expect(ready.acceptedSourcePanels).toEqual(expect.arrayContaining(ready.requiredSourcePanels))
    expect(ready.unacceptedSourcePanels).toEqual([])
    expect(ready.materialStalePanels).toEqual([])
  })
})
