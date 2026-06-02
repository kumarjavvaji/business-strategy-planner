import { describe, it, expect } from 'vitest'
import { compileArtifactBasis } from './stage4ArtifactBasis'
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
