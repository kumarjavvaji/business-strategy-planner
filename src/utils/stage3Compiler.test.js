/**
 * Tests for stage3Compiler — field-distinctness contract.
 *
 * Regression case: Product & Competitive Architecture output where
 * decisionsRequired, validationSignals, and sequencingAndGates all contain
 * the same strategic framing, causing the compiler to echo the same text
 * into question/whyItMatters/evidenceNeeded, description/requiredInput/
 * consequenceIfMissing, and identical validation arrays per question.
 */

import { describe, it, expect } from 'vitest'
import {
  buildCompiledCriticalDecisions,
  buildCompiledDependencies,
  buildCompiledRisks,
  buildCompiledValidationFramework,
  validateStage3CompiledFieldDistinctness,
  semanticFingerprint,
  jaccardSim,
} from './stage3Compiler'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns Jaccard similarity between two strings. */
function sim(a, b) {
  return jaccardSim(semanticFingerprint(a), semanticFingerprint(b))
}

/** Build a minimal tree where all bullets repeat the same strategic framing. */
function makeRepetitiveTree(text) {
  const fields = ['decisionsRequired', 'validationSignals', 'sequencingAndGates', 'dependencies', 'risks', 'objective']
  return {
    sections: [
      {
        sectionKey: 'explainability',
        sectionName: 'Explainability Infrastructure',
        taggedBullets: fields.flatMap(fieldKey =>
          [text, text, text].map((t, i) => ({ fieldKey, text: t, idx: i }))
        ),
      },
    ],
  }
}

/** Build a richer tree that mirrors the "bad" PM output. */
function makePMRegressionTree() {
  return {
    sections: [
      {
        sectionKey: 'product_mgmt',
        sectionName: 'Product & Competitive Architecture',
        taggedBullets: [
          // decisionsRequired — same strategic framing for every bullet (the bug)
          { fieldKey: 'decisionsRequired', text: 'The build-vs-partner decision must be resolved to determine whether internal capacity can deliver SR 11-7 compliant explainability outputs or whether a vendor like Fiddler AI or Arthur AI should be engaged for selected components.' },
          { fieldKey: 'decisionsRequired', text: 'The build-vs-partner decision must be resolved to determine whether internal capacity can deliver SR 11-7 compliant explainability outputs or whether a vendor like Fiddler AI or Arthur AI should be engaged for selected components.' },
          { fieldKey: 'decisionsRequired', text: 'Investment scope must be confirmed before sprint planning can begin, as the four contract engineers represent a fixed-term commitment that cannot be easily extended.' },
          // validationSignals — same text echoed
          { fieldKey: 'validationSignals', text: 'The build-vs-partner decision must be resolved to determine whether internal capacity can deliver SR 11-7 compliant explainability outputs or whether a vendor like Fiddler AI or Arthur AI should be engaged for selected components.' },
          { fieldKey: 'validationSignals', text: 'Examiner-accessible output formats must be tested against actual BSA/AML review scenarios before rollout.' },
          // sequencingAndGates
          { fieldKey: 'sequencingAndGates', text: 'Architecture boundary review must precede Sprint 2 to prevent connector lock-in before schema coverage is confirmed.' },
          { fieldKey: 'sequencingAndGates', text: 'Go/no-go gate review gates the scale decision after pilot evidence is collected.' },
          // dependencies
          { fieldKey: 'dependencies', text: 'API Engineering must approve schema contracts before Sprint 2 kickoff or model documentation work cannot begin on time.' },
          { fieldKey: 'dependencies', text: 'Compliance must deliver signed SR 11-7 formatting guidelines by Week 4 otherwise model documentation sprints cannot be planned.' },
          // risks
          { fieldKey: 'risks', text: 'Early technical choices may lock the team into brittle connector assumptions before pilot evidence is mature.' },
          { fieldKey: 'risks', text: 'Contract engineer onboarding drag may consume the 4–6 week ramp window and compress Sprint 2 milestones.' },
        ],
      },
    ],
  }
}

const EMPTY_BRIEF = { evidenceRefs: [], businessUnitName: 'Product & Competitive Architecture' }

// ── criticalDecisions field-distinctness ─────────────────────────────────────

describe('buildCompiledCriticalDecisions — field-role distinctness', () => {
  it('decisionQuestion and whyItMatters are not near-duplicates', () => {
    const tree = makePMRegressionTree()
    const decisions = buildCompiledCriticalDecisions(tree, EMPTY_BRIEF, 'productArchitecture')
    expect(decisions.length).toBeGreaterThan(0)
    for (const d of decisions) {
      const similarity = sim(d.decisionQuestion, d.whyItMatters)
      expect(similarity, `${d.decisionName}: question vs whyItMatters sim=${similarity.toFixed(2)}`).toBeLessThan(0.72)
    }
  })

  it('decisionQuestion and first evidenceNeeded item are not near-duplicates', () => {
    const tree = makePMRegressionTree()
    const decisions = buildCompiledCriticalDecisions(tree, EMPTY_BRIEF, 'productArchitecture')
    for (const d of decisions) {
      const firstEvidence = d.decisionEvidenceNeeded?.[0] || ''
      if (!firstEvidence) continue
      const similarity = sim(d.decisionQuestion, firstEvidence)
      expect(similarity, `${d.decisionName}: question vs evidenceNeeded[0] sim=${similarity.toFixed(2)}`).toBeLessThan(0.72)
    }
  })

  it('different decisions have different decisionTiming values', () => {
    const tree = makePMRegressionTree()
    const decisions = buildCompiledCriticalDecisions(tree, EMPTY_BRIEF, 'productArchitecture')
    if (decisions.length < 2) return
    const timings = decisions.map(d => d.decisionTiming)
    const unique = new Set(timings)
    expect(unique.size, 'all decisions share the same timing boilerplate').toBeGreaterThan(1)
  })

  it('produces decisions with required fields populated', () => {
    const tree = makePMRegressionTree()
    const decisions = buildCompiledCriticalDecisions(tree, EMPTY_BRIEF, 'productArchitecture')
    for (const d of decisions) {
      expect(d.decisionName).toBeTruthy()
      expect(d.decisionQuestion).toBeTruthy()
      expect(d.whyItMatters).toBeTruthy()
      expect(Array.isArray(d.decisionOptions)).toBe(true)
      expect(Array.isArray(d.decisionEvidenceNeeded)).toBe(true)
      expect(d.decisionEvidenceNeeded.length).toBeGreaterThan(0)
      expect(d.decisionTiming).toBeTruthy()
    }
  })

  it('works for generic profile too', () => {
    const tree = makeRepetitiveTree('We need to decide the outcome priority and scope boundaries for the compliance review process.')
    const decisions = buildCompiledCriticalDecisions(tree, EMPTY_BRIEF, 'compliance')
    expect(decisions.length).toBeGreaterThan(0)
    for (const d of decisions) {
      const similarity = sim(d.decisionQuestion, d.whyItMatters)
      expect(similarity).toBeLessThan(0.72)
    }
  })
})

// ── dependencies field-distinctness ──────────────────────────────────────────

describe('buildCompiledDependencies — field-role distinctness', () => {
  it('dependencyDescription and requiredInput are not near-duplicates', () => {
    const tree = makePMRegressionTree()
    const deps = buildCompiledDependencies(tree, EMPTY_BRIEF)
    expect(deps.length).toBeGreaterThan(0)
    for (const d of deps) {
      const similarity = sim(d.dependencyDescription, d.requiredInput)
      expect(similarity, `${d.dependencyName}: description vs requiredInput sim=${similarity.toFixed(2)}`).toBeLessThan(0.80)
    }
  })

  it('dependencyDescription and consequenceIfMissing are not near-duplicates', () => {
    const tree = makePMRegressionTree()
    const deps = buildCompiledDependencies(tree, EMPTY_BRIEF)
    for (const d of deps) {
      const similarity = sim(d.dependencyDescription, d.consequenceIfMissing)
      expect(similarity, `${d.dependencyName}: description vs consequence sim=${similarity.toFixed(2)}`).toBeLessThan(0.80)
    }
  })

  it('whyItMatters is not a copy of dependencyDescription', () => {
    const tree = makePMRegressionTree()
    const deps = buildCompiledDependencies(tree, EMPTY_BRIEF)
    for (const d of deps) {
      expect(d.whyItMatters, `${d.dependencyName}: whyItMatters should not equal description`).not.toBe(d.dependencyDescription)
      const similarity = sim(d.dependencyDescription, d.whyItMatters)
      expect(similarity, `${d.dependencyName}: description vs whyItMatters sim=${similarity.toFixed(2)}`).toBeLessThan(0.80)
    }
  })

  it('produces dependencies with required fields populated', () => {
    const tree = makePMRegressionTree()
    const deps = buildCompiledDependencies(tree, EMPTY_BRIEF)
    for (const d of deps) {
      expect(d.dependencyName).toBeTruthy()
      expect(d.dependencyDescription).toBeTruthy()
      expect(d.whyItMatters).toBeTruthy()
      expect(d.requiredInput).toBeTruthy()
      expect(d.consequenceIfMissing).toBeTruthy()
    }
  })
})

// ── risks field-distinctness ──────────────────────────────────────────────────

describe('buildCompiledRisks — field-role distinctness', () => {
  it('riskDescription and whyItMatters are not near-duplicates', () => {
    const tree = makePMRegressionTree()
    const risks = buildCompiledRisks(tree, EMPTY_BRIEF, 'productArchitecture')
    expect(risks.length).toBeGreaterThan(0)
    for (const r of risks) {
      const similarity = sim(r.riskDescription, r.whyItMatters)
      expect(similarity, `${r.riskName}: riskDescription vs whyItMatters sim=${similarity.toFixed(2)}`).toBeLessThan(0.72)
    }
  })

  it('different risks have distinct riskDescriptions (no two templates share the same atom text)', () => {
    // When two templates match the same atom, the compiler should not assign it twice.
    // The regression tree has 2 risk bullets; 5 PM templates match them in various combos.
    // The 3 templates with no matching atom fall back to their unique template.description.
    const tree = makePMRegressionTree()
    const risks = buildCompiledRisks(tree, EMPTY_BRIEF, 'productArchitecture')
    const descriptions = risks.map(r => r.riskDescription)
    const unique = new Set(descriptions)
    expect(unique.size, 'some risks share identical riskDescription').toBe(descriptions.length)
  })

  it('produces risks with required mitigation fields', () => {
    const tree = makePMRegressionTree()
    const risks = buildCompiledRisks(tree, EMPTY_BRIEF, 'productArchitecture')
    for (const r of risks) {
      expect(r.riskName).toBeTruthy()
      expect(r.riskDescription).toBeTruthy()
      expect(r.whyItMatters).toBeTruthy()
      expect(Array.isArray(r.mitigationOptions) && r.mitigationOptions.length).toBeTruthy()
      expect(Array.isArray(r.earlyWarningSignals) && r.earlyWarningSignals.length).toBeTruthy()
      expect(Array.isArray(r.evidenceThatRiskIsReduced) && r.evidenceThatRiskIsReduced.length).toBeTruthy()
    }
  })

  it('works for generic profile — riskDescription and whyItMatters are distinct', () => {
    const tree = makeRepetitiveTree('The delivery team faces capacity constraints that may prevent timely handoff.')
    const risks = buildCompiledRisks(tree, EMPTY_BRIEF, 'delivery')
    expect(risks.length).toBeGreaterThan(0)
    for (const r of risks) {
      const similarity = sim(r.riskDescription, r.whyItMatters)
      expect(similarity).toBeLessThan(0.80)
    }
  })
})

// ── validationFramework anti-repetition ──────────────────────────────────────

describe('buildCompiledValidationFramework — no shared boilerplate across questions', () => {
  function arraysIdentical(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => item === b[i])
  }

  it('evidenceExamples differ between questions (productArchitecture)', () => {
    const tree = makePMRegressionTree()
    const vf = buildCompiledValidationFramework(tree, EMPTY_BRIEF, 'productArchitecture')
    expect(vf.length).toBeGreaterThanOrEqual(2)
    for (let i = 0; i < vf.length - 1; i++) {
      for (let j = i + 1; j < vf.length; j++) {
        expect(
          arraysIdentical(vf[i].evidenceExamples, vf[j].evidenceExamples),
          `Q${i + 1} and Q${j + 1} share identical evidenceExamples array`
        ).toBe(false)
      }
    }
  })

  it('veracityChecks differ between questions (productArchitecture)', () => {
    const tree = makePMRegressionTree()
    const vf = buildCompiledValidationFramework(tree, EMPTY_BRIEF, 'productArchitecture')
    for (let i = 0; i < vf.length - 1; i++) {
      for (let j = i + 1; j < vf.length; j++) {
        expect(
          arraysIdentical(vf[i].veracityChecks, vf[j].veracityChecks),
          `Q${i + 1} and Q${j + 1} share identical veracityChecks array`
        ).toBe(false)
      }
    }
  })

  it('failureOrReworkTriggers differ between questions (productArchitecture)', () => {
    const tree = makePMRegressionTree()
    const vf = buildCompiledValidationFramework(tree, EMPTY_BRIEF, 'productArchitecture')
    for (let i = 0; i < vf.length - 1; i++) {
      for (let j = i + 1; j < vf.length; j++) {
        expect(
          arraysIdentical(vf[i].failureOrReworkTriggers, vf[j].failureOrReworkTriggers),
          `Q${i + 1} and Q${j + 1} share identical failureOrReworkTriggers array`
        ).toBe(false)
      }
    }
  })

  it('completionCriteria differ between questions (productArchitecture)', () => {
    const tree = makePMRegressionTree()
    const vf = buildCompiledValidationFramework(tree, EMPTY_BRIEF, 'productArchitecture')
    for (let i = 0; i < vf.length - 1; i++) {
      for (let j = i + 1; j < vf.length; j++) {
        expect(
          arraysIdentical(vf[i].completionCriteria, vf[j].completionCriteria),
          `Q${i + 1} and Q${j + 1} share identical completionCriteria array`
        ).toBe(false)
      }
    }
  })

  it('produces required fields for each question', () => {
    const tree = makePMRegressionTree()
    const vf = buildCompiledValidationFramework(tree, EMPTY_BRIEF, 'productArchitecture')
    for (const item of vf) {
      expect(item.validationQuestion).toBeTruthy()
      expect(Array.isArray(item.completionCriteria) && item.completionCriteria.length).toBeTruthy()
      expect(Array.isArray(item.howToDetermineCompletion) && item.howToDetermineCompletion.length).toBeTruthy()
      expect(Array.isArray(item.evidenceExamples) && item.evidenceExamples.length).toBeTruthy()
      expect(Array.isArray(item.veracityChecks) && item.veracityChecks.length).toBeTruthy()
      expect(Array.isArray(item.failureOrReworkTriggers) && item.failureOrReworkTriggers.length).toBeTruthy()
    }
  })

  it('generic profile also produces distinct arrays per question', () => {
    const tree = makeRepetitiveTree('Compliance review must confirm all regulatory outputs meet SR 11-7 standards.')
    const vf = buildCompiledValidationFramework(tree, EMPTY_BRIEF, 'compliance')
    expect(vf.length).toBeGreaterThanOrEqual(2)
    for (let i = 0; i < vf.length - 1; i++) {
      for (let j = i + 1; j < vf.length; j++) {
        expect(arraysIdentical(vf[i].evidenceExamples, vf[j].evidenceExamples)).toBe(false)
        expect(arraysIdentical(vf[i].veracityChecks, vf[j].veracityChecks)).toBe(false)
        expect(arraysIdentical(vf[i].failureOrReworkTriggers, vf[j].failureOrReworkTriggers)).toBe(false)
      }
    }
  })
})

// ── validateStage3CompiledFieldDistinctness ───────────────────────────────────

describe('validateStage3CompiledFieldDistinctness', () => {
  it('flags identical decisionQuestion and whyItMatters', () => {
    const plan = {
      criticalDecisions: [{
        decisionName: 'Build vs Partner',
        decisionQuestion: 'Whether to build the explainability infrastructure internally or partner with a vendor.',
        whyItMatters: 'Whether to build the explainability infrastructure internally or partner with a vendor.',
        decisionEvidenceNeeded: ['Some evidence'],
        decisionTiming: 'Before Phase 1.',
      }],
      dependencies: [],
      risksAndMitigations: [],
      validationFramework: [],
    }
    const violations = validateStage3CompiledFieldDistinctness(plan)
    expect(violations.some(v => v.field1 === 'decisionQuestion' && v.field2 === 'whyItMatters')).toBe(true)
  })

  it('flags identical (exact-duplicate) dependencyDescription and requiredInput', () => {
    const plan = {
      criticalDecisions: [],
      dependencies: [{
        dependencyName: 'API Engineering',
        // Exactly the same string in both fields — the original bug pattern
        dependencyDescription: 'API Engineering must approve schema contracts before Sprint 2 kickoff.',
        requiredInput:         'API Engineering must approve schema contracts before Sprint 2 kickoff.',
        whyItMatters: 'This gates Sprint 2.',
        consequenceIfMissing: 'Sprint 2 cannot begin.',
      }],
      risksAndMitigations: [],
      validationFramework: [],
    }
    const violations = validateStage3CompiledFieldDistinctness(plan)
    expect(violations.some(v => v.field1 === 'dependencyDescription' && v.field2 === 'requiredInput')).toBe(true)
  })

  it('flags identical riskDescription and whyItMatters', () => {
    const plan = {
      criticalDecisions: [],
      dependencies: [],
      risksAndMitigations: [{
        riskName: 'Architecture Risk',
        riskDescription: 'Early technical choices may create lock-in before evidence is mature.',
        whyItMatters: 'Early technical choices may create lock-in before evidence is mature.',
        mitigationOptions: [],
        earlyWarningSignals: [],
        evidenceThatRiskIsReduced: [],
      }],
      validationFramework: [],
    }
    const violations = validateStage3CompiledFieldDistinctness(plan)
    expect(violations.some(v => v.field1 === 'riskDescription' && v.field2 === 'whyItMatters')).toBe(true)
  })

  it('flags identical evidenceExamples across validation questions', () => {
    const sharedEvidence = ['observed workflow notes', 'readiness review notes', 'before/after comparison']
    const plan = {
      criticalDecisions: [],
      dependencies: [],
      risksAndMitigations: [],
      validationFramework: [
        { validationQuestion: 'Q1', completionCriteria: ['c1'], howToDetermineCompletion: [], evidenceExamples: sharedEvidence, veracityChecks: ['v1'], failureOrReworkTriggers: ['f1'] },
        { validationQuestion: 'Q2', completionCriteria: ['c2'], howToDetermineCompletion: [], evidenceExamples: sharedEvidence, veracityChecks: ['v2'], failureOrReworkTriggers: ['f2'] },
      ],
    }
    const violations = validateStage3CompiledFieldDistinctness(plan)
    expect(violations.some(v => v.field1 === 'evidenceExamples' && v.section === 'validationFramework')).toBe(true)
  })

  it('flags identical failureOrReworkTriggers across validation questions', () => {
    const sharedTriggers = ['Users cannot interpret without translation.', 'Output does not change a decision.', 'Evidence conflicts unresolved.']
    const plan = {
      criticalDecisions: [],
      dependencies: [],
      risksAndMitigations: [],
      validationFramework: [
        { validationQuestion: 'Q1', completionCriteria: ['c1'], howToDetermineCompletion: [], evidenceExamples: ['e1'], veracityChecks: ['v1'], failureOrReworkTriggers: sharedTriggers },
        { validationQuestion: 'Q2', completionCriteria: ['c2'], howToDetermineCompletion: [], evidenceExamples: ['e2'], veracityChecks: ['v2'], failureOrReworkTriggers: sharedTriggers },
      ],
    }
    const violations = validateStage3CompiledFieldDistinctness(plan)
    expect(violations.some(v => v.field1 === 'failureOrReworkTriggers' && v.section === 'validationFramework')).toBe(true)
  })

  it('returns no violations for a compiled plan built from non-adversarial source atoms', () => {
    // Use a tree where each field bucket has genuinely distinct content
    // (as real AI-generated atoms would — different text per field type).
    const cleanTree = {
      sections: [{
        sectionKey: 'product_mgmt',
        sectionName: 'Product & Competitive Architecture',
        taggedBullets: [
          // decisionsRequired — decision-framed
          { fieldKey: 'decisionsRequired', text: 'Build-vs-partner scope must be decided before engineering work begins: which components are built internally versus sourced from Fiddler AI or Arthur AI.' },
          { fieldKey: 'decisionsRequired', text: 'Investment scope for the four contract engineers must be confirmed against a phased rollout timeline.' },
          { fieldKey: 'decisionsRequired', text: 'Pilot validation standard must be agreed before rollout — what evidence threshold justifies scaling.' },
          // validationSignals — evidence/completion-framed (different from decisions)
          { fieldKey: 'validationSignals', text: 'Architecture boundary spec must be signed off by API Engineering before Sprint 2 connector build begins.' },
          { fieldKey: 'validationSignals', text: 'Examiner-accessible output formats are tested against a live BSA/AML review scenario with a bank compliance officer.' },
          { fieldKey: 'validationSignals', text: 'Pilot evidence package is reviewed by Managed Client Delivery before any broader rollout is committed.' },
          // sequencingAndGates — timing/gate-framed (different from both above)
          { fieldKey: 'sequencingAndGates', text: 'Architecture boundary review must precede Sprint 2 kickoff to prevent connector lock-in.' },
          { fieldKey: 'sequencingAndGates', text: 'Investment scope gate occurs at the end of Phase 1 after pilot evidence is collected and reviewed.' },
          { fieldKey: 'sequencingAndGates', text: 'Rollout gate requires both pilot evidence and Compliance sign-off before scale is approved.' },
          // dependencies — ownership/deliverable-framed
          { fieldKey: 'dependencies', text: 'API Engineering must provide signed schema interface contracts to the contract team by Week 3.' },
          { fieldKey: 'dependencies', text: 'Compliance must confirm SR 11-7 output formatting requirements before model documentation sprint planning.' },
          // risks — failure-mode-framed
          { fieldKey: 'risks', text: 'Connector build may begin before schema coverage is confirmed, creating lock-in on brittle data mappings.' },
          { fieldKey: 'risks', text: 'Contract engineer onboarding drag could compress Sprint 2 milestones if ramp-up exceeds 6 weeks.' },
        ],
      }],
    }
    const compiled = {
      criticalDecisions:   buildCompiledCriticalDecisions(cleanTree, EMPTY_BRIEF, 'productArchitecture'),
      executionSequence:   [],
      dependencies:        buildCompiledDependencies(cleanTree, EMPTY_BRIEF),
      risksAndMitigations: buildCompiledRisks(cleanTree, EMPTY_BRIEF, 'productArchitecture'),
      validationFramework: buildCompiledValidationFramework(cleanTree, EMPTY_BRIEF, 'productArchitecture'),
    }
    const violations = validateStage3CompiledFieldDistinctness(compiled)
    expect(violations, `Expected no violations, got:\n${JSON.stringify(violations, null, 2)}`).toHaveLength(0)
  })
})
