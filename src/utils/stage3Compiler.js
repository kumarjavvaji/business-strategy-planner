/**
 * Stage 3 compiled strategy builder.
 *
 * Extracted from Stage3View so these pure functions can be unit-tested.
 * Each buildCompiled* function enforces field-role distinctness:
 *   - question ≠ whyItMatters ≠ evidenceNeeded
 *   - dependencyDescription ≠ requiredInput ≠ consequenceIfMissing
 *   - riskDescription ≠ whyItMatters
 *   - validation evidenceExamples / veracityChecks / failureOrReworkTriggers vary per question
 */

// ── Stopwords / fingerprinting ──────────────────────────────────────────────

export const AUDIT_STOPWORDS = new Set(
  'a an the and or but in on at to for of with from by is are was were be been being have has had do does did will would could should may might shall must that this these those it its they their them we our us i my you your which who what when where how'.split(' ')
)

export function semanticFingerprint(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !AUDIT_STOPWORDS.has(w))
  const bigrams = []
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.push(words[i] + '_' + words[i + 1])
  }
  return new Set([...words, ...bigrams])
}

export function jaccardSim(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const w of a) if (b.has(w)) inter++
  return inter / (a.size + b.size - inter)
}

// ── Text helpers ─────────────────────────────────────────────────────────────

export function firstSentence(text, max = 210) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  const sentence = clean.match(/^.{1,220}?[.!?](\s|$)/)?.[0]?.trim()
  const chosen = sentence || clean
  return chosen.length > max ? chosen.slice(0, max).trim() : chosen
}

export function compiledText(value) {
  if (Array.isArray(value)) return value.map(compiledText).filter(Boolean).join(' ')
  if (value && typeof value === 'object') return Object.values(value).map(compiledText).filter(Boolean).join(' ')
  return String(value || '').replace(/\s+/g, ' ').trim()
}

export function normalizeSearchText(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value.toLowerCase().trim()
  if (Array.isArray(value)) return value.map(normalizeSearchText).filter(Boolean).join(' ')
  if (typeof value === 'object') {
    return [value.name, value.title, value.label, value.buName, value.unitName, value.teamName, value.domainOfWork, value.sectionName, value.summary]
      .map(normalizeSearchText).filter(Boolean).join(' ')
  }
  return String(value).toLowerCase().trim()
}

// ── Tree access ──────────────────────────────────────────────────────────────

export function allTreeBullets(tree, fieldKey = null) {
  return (tree?.sections || []).flatMap(section =>
    (section.taggedBullets || [])
      .filter(b => !fieldKey || b.fieldKey === fieldKey)
      .map(b => ({ ...b, sectionKey: section.sectionKey, sectionName: section.sectionName })),
  )
}

export function pickBulletTexts(tree, fieldKey, re, max = 4) {
  return allTreeBullets(tree, fieldKey).filter(b => !re || re.test(b.text)).map(b => b.text).filter(Boolean).slice(0, max)
}

// ── Profile inference ────────────────────────────────────────────────────────

export function inferCompiledBUProfile({ draft, legacyPlan, handoffBrief, tree }) {
  const text = normalizeSearchText([
    legacyPlan?.buName,
    legacyPlan?.mission,
    legacyPlan?.strategicRole,
    draft?.plan?.buName,
    draft?.plan?.mission,
    handoffBrief?.businessUnitName,
    handoffBrief?.planningPurpose,
    handoffBrief?.decisionBasisSummary,
    tree?.sections?.map(section => [section.sectionName, section.semanticLabel].join(' ')),
  ])
  if (/product|competitive|architecture|pdlc|roadmap|use case|prototype|mock/.test(text)) return 'productArchitecture'
  if (/executive|governance|leadership|investment authority|priorit/.test(text)) return 'executive'
  if (/compliance|model risk|regulatory|occ|fincen|examiner|audit/.test(text)) return 'compliance'
  if (/api|engineering|integration|technical|interface|infrastructure|platform/.test(text)) return 'engineering'
  if (/go.to.market|sales|channel|marketing|buyer|positioning|commercial/.test(text)) return 'goToMarket'
  if (/partner|vendor|procurement|ecosystem/.test(text)) return 'partner'
  if (/delivery|client|implementation|managed|support|adoption|workflow/.test(text)) return 'delivery'
  return 'general'
}

export function roleLearningTerms(profile) {
  return STAGE3_COMPILED_STRATEGY_LEARNING_SIGNALS.buAdaptationGuidance[profile] ||
    ['operating outcome', 'decision gate', 'execution method', 'dependency input', 'risk mitigation', 'validation evidence']
}

export function stage3SourceRefsFrom(handoffBrief, sectionKey = null) {
  const refs = handoffBrief?.evidenceRefs || []
  const matched = sectionKey ? refs.filter(ref => ref.id === sectionKey || ref.pointer?.includes(sectionKey)) : refs
  return (matched.length ? matched : refs.slice(0, 2)).map(ref => ({
    sourceTitle: ref.title || ref.id || 'Stage 2 source',
    sourceType: 'stage2-handoff',
    sourceId: ref.id || ref.pointer || null,
    stage2Link: ref.pointer || (ref.id ? `stage2:${handoffBrief?.businessUnitName || 'unknown'}:${ref.id}` : null),
  }))
}

// ── Decision patterns ─────────────────────────────────────────────────────────

export const PM_DECISION_PATTERNS = [
  { name: 'Build vs Partner',         re: /build|partner|vendor|external/i,                                              options: ['Build internally', 'Partner for selected capability', 'Hybrid build plus partner integration'] },
  { name: 'Investment Scope',          re: /investment|budget|scope|tier 1|full-service|full service|margin|pricing/i,    options: ['Narrow pilot scope', 'Fund full capability path', 'Stage investment behind evidence gates'] },
  { name: 'Architecture Boundaries',  re: /architecture|modular|schema|connector|api|etl|interface|boundary/i,            options: ['Fixed connector boundary', 'Extension-ready modular boundary', 'Custom integration exception path'] },
  { name: 'Pilot Validation Standard',re: /pilot|validation|evidence|threshold|workflow|completeness/i,                   options: ['Workflow mock validation', 'Controlled pilot evidence', 'Client plus SME review standard'] },
  { name: 'Rollout Gate',             re: /rollout|scale|gate|go\/no-go|launch|sprint|release/i,                          options: ['Hold for evidence', 'Limited rollout', 'Scale after validation and dependency clearance'] },
]

export function genericDecisionPatterns(profile) {
  const terms = roleLearningTerms(profile)
  return [
    { name: `${terms[0] || 'Outcome'} Priority`,    re: /outcome|priority|scope|decision|gate|threshold/i,  options: ['Proceed with current scope', 'Narrow to strongest evidence path', 'Defer until missing evidence is resolved'] },
    { name: `${terms[1] || 'Execution'} Boundary`,  re: /boundary|constraint|scope|capacity|dependency|handoff/i, options: ['Keep boundary narrow', 'Expand after readiness evidence', 'Route reciprocal ownership to coordination'] },
    { name: `${terms[2] || 'Readiness'} Standard`,  re: /readiness|validation|evidence|review|pilot|approval/i,   options: ['Use observed evidence', 'Require cross-functional review', 'Hold until evidence quality improves'] },
  ]
}

// ── Risk templates ───────────────────────────────────────────────────────────

export const PM_RISK_TEMPLATES = [
  {
    name: 'False Validation Risk',
    re: /false|validation|pilot|sandbox|self-reported|workflow|client feedback/i,
    description: 'Validation may appear positive without proving that the product improves a real client workflow.',
    consequence: 'Scale decisions proceed on unconfirmed evidence, compounding rework cost when live use diverges from mock expectations.',
    mitigations: ['Use observed workflow reviews, not only self-reported feedback', 'Test mocks or prototypes against realistic BSA/AML decisions', 'Document contradictions and unresolved objections before gate approval'],
    warnings: ['Positive feedback lacks observed workflow evidence', 'Pilot users need analyst translation to interpret outputs', 'Contradictory feedback is summarized away'],
    reduced: ['Observed use shows reduced friction or improved decision confidence', 'More than one review path supports the same conclusion', 'Assumptions remain tagged until confirmed'],
  },
  {
    name: 'Architecture Lock-In Risk',
    re: /architecture|lock|modular|schema|connector|api|etl|interface|core system/i,
    description: 'Early technical choices may lock the BU into brittle connectors, data mappings, or vendor assumptions before evidence is mature.',
    consequence: 'Rework costs escalate once clients or integrations have been built on the locked path, making scope changes expensive after pilot.',
    mitigations: ['Define interface boundaries before deep build', 'Separate reusable connector logic from custom ETL exceptions', 'Review architecture decisions against scale and regulatory change scenarios'],
    warnings: ['Connector work starts before schema coverage is confirmed', 'Custom ETL exceptions become the default path', 'Architecture choices depend on a single client or core system'],
    reduced: ['Architecture review confirms extension points and exception handling', 'Schema coverage gaps are visible before build commitment', 'Pilot scope can change without major rework'],
  },
  {
    name: 'Scope Expansion Risk',
    re: /scope|feature creep|generative ai|boundary|excluded|roadmap|full-service|full service/i,
    description: 'Execution can absorb adjacent feature, service, or AI commitments that blur the Tier 1 boundary.',
    consequence: 'Delivery labor and client expectations exceed what the current investment posture can sustain, degrading margins and timeline reliability.',
    mitigations: ['Publish explicit in-scope and out-of-scope boundaries', 'Use re-entry criteria for deferred features', 'Gate scope changes through evidence and commercial impact review'],
    warnings: ['Sales or delivery messages promise excluded capabilities', 'Pilot feedback expands scope without re-prioritization', 'Boundary exceptions are handled informally'],
    reduced: ['Scope exclusions and re-entry criteria are documented', 'Pilot agreements match product capability', 'Boundary changes are tied to evidence and margin impact'],
  },
  {
    name: 'Under-Investment Risk',
    re: /under.?investment|bandwidth|capacity|resourcing|engineering|api|delivery cost|consultant-hour|hours/i,
    description: 'The plan may require more product, engineering, delivery, or governance capacity than the current investment posture supports.',
    consequence: 'Critical-path inputs slip, execution gates are missed, and external commitments cannot be met without scope reduction or replanning.',
    mitigations: ['Tie phase advancement to capacity confirmation', 'Quantify API and delivery bottlenecks before rollout', 'Escalate margin or labor impacts before scope is locked'],
    warnings: ['Critical-path inputs slip without replanning', 'Manual delivery effort remains hidden in completeness metrics', 'Engineering or delivery dependencies are treated as assumptions'],
    reduced: ['Capacity constraints are visible in gates', 'Labor and connector complexity are reflected in pricing or scope', 'Blocked inputs have an explicit escalation path'],
  },
  {
    name: 'Regulatory Evolution Risk',
    re: /regulatory|occ|fincen|compliance|model risk|explainability|audit|examiner/i,
    description: 'Regulatory or examiner expectations may change after product scope, explainability, or evidence standards are set.',
    consequence: 'Audit or examiner review reveals gaps that require retroactive redesign or evidence reconstruction, reversing committed scope.',
    mitigations: ['Keep Compliance and Model Risk inputs as context before scope lock', 'Maintain traceable explainability and exclusion rationale', 'Design validation evidence so it can support audit review'],
    warnings: ['Compliance review lags product specification', 'Explainability evidence is not tied to actual outputs', 'Regulatory assumptions are treated as final'],
    reduced: ['Scope and validation decisions have compliance traceability', 'Evidence package can answer examiner-facing questions', 'Open regulatory assumptions remain visible'],
  },
]

export function inferRiskName(text, idx, profile) {
  const normalized = normalizeSearchText(text)
  if (/regulatory|compliance|examiner|model risk/.test(normalized)) return 'Regulatory Evidence Risk'
  if (/capacity|bandwidth|resourcing/.test(normalized)) return 'Capacity Constraint Risk'
  if (/dependency|handoff|input/.test(normalized)) return 'Dependency Readiness Risk'
  if (/adoption|client|workflow|delivery/.test(normalized)) return 'Operating Adoption Risk'
  const terms = roleLearningTerms(profile)
  return `${terms[idx % terms.length] || 'Execution'} Risk`
}

// Synthesize a consequence statement distinct from the failure-mode description.
function synthesizeRiskConsequence(description, profile) {
  const d = normalizeSearchText(description)
  if (/false.*valid|self-reported|without proving/.test(d))
    return 'Scale decisions proceed on unconfirmed evidence, compounding the cost of discovery in later phases.'
  if (/architecture|lock.in|brittle|connector/.test(d))
    return 'Rework costs escalate once integrations or clients have been built on the locked architectural path.'
  if (/scope.*expand|feature creep|blur.*boundary/.test(d))
    return 'Delivery labor and client expectations exceed what the investment posture can sustain.'
  if (/under.invest|bandwidth|capacity|resourcing/.test(d))
    return 'Critical-path inputs slip and execution gates are missed without scope reduction or replanning.'
  if (/regulatory|examiner|compliance|audit/.test(d))
    return 'Retroactive redesign or evidence reconstruction is required after regulatory review surfaces the gap.'
  const terms = roleLearningTerms(profile)
  return `The plan loses operating confidence and may require scope reduction to recover the ${terms[0] || 'execution'} gate.`
}

export function genericRiskTemplates(tree, profile) {
  const terms = roleLearningTerms(profile)
  const riskTexts = pickBulletTexts(tree, 'risks', null, 5)
  const fallback = [
    `${terms[0] || 'Operating outcome'} risk`,
    `${terms[1] || 'Decision gate'} risk`,
    `${terms[2] || 'Execution method'} readiness risk`,
  ]
  return (riskTexts.length ? riskTexts : fallback).slice(0, 5).map((text, idx) => ({
    name: inferRiskName(text, idx, profile),
    re: /./,
    description: firstSentence(text || fallback[idx] || 'Execution risk may reduce confidence in the BU plan.'),
    consequence: synthesizeRiskConsequence(text, profile),
    mitigations: ['Define the evidence needed before advancing the next gate', 'Use a bounded execution method before scaling commitment', 'Escalate cross-BU ownership or reciprocal dependency questions to coordination'],
    warnings: ['Required evidence remains assumption-based', 'The BU cannot explain how the risk is reducing', 'Dependencies or constraints change without revisiting the plan'],
    reduced: ['Observed evidence supports the decision path', 'Residual assumptions are documented and bounded', 'Mitigation status is traceable to source or execution evidence'],
  }))
}

// ── Execution phases ─────────────────────────────────────────────────────────

export const GENERAL_PHASES = [
  {
    name: 'Operating Outcome Clarification',
    objective: 'Clarify the BU-specific outcome, decision context, and evidence standard before committing execution capacity.',
    options: [
      ['Stakeholder workflow review', 'Use when the operating problem or decision moment needs clarification.', 'Connects execution to the work this BU actually performs.', 'Workflow notes and outcome criteria'],
      ['Current-state evidence review', 'Use when existing artifacts or signals can validate the starting point.', 'Prevents execution from starting on untested assumptions.', 'Evidence inventory and unresolved assumptions'],
      ['SME review session', 'Use when domain interpretation or operating feasibility matters.', 'Grounds the plan in role-specific judgment.', 'SME findings and decision implications'],
    ],
    exit: 'Priority outcome is named, evidence standard is observable, unresolved assumptions are tagged.',
  },
  {
    name: 'Execution Path Selection',
    objective: 'Compare feasible execution paths and decide which path best fits the BU role and constraints.',
    options: [
      ['Option comparison', 'Use when multiple execution approaches are viable.', 'Makes tradeoffs explicit before downstream work begins.', 'Option matrix and rationale'],
      ['Capability readiness check', 'Use when execution depends on capacity, tools, or expertise.', 'Links ambition to available operating capacity.', 'Readiness gaps and prerequisites'],
      ['Dependency input review', 'Use when other units shape the feasible path.', 'Keeps dependencies distinct from risk statements.', 'Required inputs and consequence notes'],
    ],
    exit: 'Preferred path is documented, rejected paths have rationale, evidence gaps are assigned to later gates.',
  },
  {
    name: 'Readiness & Control Design',
    objective: 'Define controls, handoffs, and evidence needed before execution moves into a controlled run.',
    options: [
      ['Readiness gate review', 'Use before work crosses into delivery or external exposure.', 'Confirms critical inputs, constraints, and evidence standards.', 'Gate checklist and open blockers'],
      ['Control/evidence design', 'Use when auditability, governance, or quality assurance matters.', 'Ensures execution can be validated after the fact.', 'Evidence plan and control notes'],
      ['Dry run or tabletop review', 'Use when coordination or operating behavior needs rehearsal.', 'Surfaces friction before live execution.', 'Dry-run findings and rework list'],
    ],
    exit: 'Controls and evidence standards are explicit, critical dependencies are confirmed or gated.',
  },
  {
    name: 'Controlled Execution',
    objective: 'Run the selected approach in a bounded way that produces evidence without overcommitting scale.',
    options: [
      ['Controlled pilot or operating trial', 'Use when evidence is needed before scale.', 'Tests the approach under bounded conditions.', 'Trial results and observed exceptions'],
      ['Parallel comparison', 'Use when new and current approaches can be compared.', 'Shows whether execution improves outcomes versus baseline.', 'Before/after or side-by-side comparison'],
      ['Feedback loop review', 'Use when adoption or operating quality matters.', 'Captures objections and failure signals while changes are still small.', 'Feedback themes and unresolved concerns'],
    ],
    exit: 'Evidence meets the validation standard, rework triggers are resolved or accepted.',
  },
  {
    name: 'Scale / Continue / Rework Decision',
    objective: 'Decide whether to scale, hold, narrow, defer, or rework based on evidence quality and dependency readiness.',
    options: [
      ['Evidence-based gate decision', 'Use when leadership or BU operators need a clear next step.', 'Forces the decision to cite evidence and unresolved assumptions.', 'Gate rationale and decision record'],
      ['Scope adjustment review', 'Use when the approach works but the boundary needs refinement.', 'Turns learning into a better-bounded execution plan.', 'Revised scope and deferred items'],
      ['Risk burn-down review', 'Use when risks remain material but manageable.', 'Confirms which risks reduced and which require coordination.', 'Risk evidence and mitigation status'],
    ],
    exit: 'Scale decision is evidence-backed, deferred work is routed to coordination or Stage 4.',
  },
]

export const PM_PHASES = [
  {
    name: 'Problem & Outcome Validation',
    objective: 'Clarify the priority use case, workflow outcome, and success signal before committing architecture or rollout scope.',
    options: [
      ['Client workflow interviews', 'Use when the workflow problem is understood at a high level but the decision moment is unclear.', 'Surfaces where users struggle, what they trust, and what outcome matters.', 'Interview notes tied to workflow steps and decision points'],
      ['Mock explainability output review', 'Use when the team needs fast feedback before engineering build.', 'Tests whether users can interpret the output and whether it supports a real decision.', 'Annotated mock review, hesitation points, accepted/rejected interpretations'],
      ['SME/advisor review', 'Use when regulatory, domain, or BSA/AML interpretation risk is material.', 'Separates product usefulness from domain correctness and explainability fit.', 'SME disposition notes, unresolved objections, required terminology changes'],
      ['Support/sales signal analysis', 'Use when existing field conversations reveal recurring pain or adoption barriers.', 'Converts anecdotal demand into patterns that can guide pilot scope.', 'Tagged objection themes, demand signals, buyer confusion patterns'],
      ['Workflow observation', 'Use when stated needs may not match actual analyst or client behavior.', 'Produces observed evidence of friction, workarounds, and decision confidence.', 'Observation notes, before/after workflow comparison, friction log'],
    ],
    exit: 'Priority workflow is named, outcome signal is observable, unresolved assumptions are tagged before solution comparison.',
  },
  {
    name: 'Solution Path Evaluation',
    objective: 'Compare build, partner, hybrid, and scope alternatives against evidence, constraints, and commercial fit.',
    options: [
      ['Build-vs-partner decision matrix', 'Use when external capability could accelerate delivery or reduce risk.', 'Makes tradeoffs explicit instead of burying them in architecture or dependency notes.', 'Option matrix with evidence, cost, control, integration, and timing implications'],
      ['Partner capability screen', 'Use when vendor claims need verification before roadmap dependency.', 'Tests whether a partner can meet workflow, integration, and explainability needs.', 'Vendor evidence checklist, integration gaps, contract or governance concerns'],
      ['Internal capability assessment', 'Use when build feasibility depends on scarce product or engineering capacity.', 'Links ambition to available architecture, data, and API bandwidth.', 'Capacity estimate, build risk notes, prerequisite inputs'],
      ['Commercial boundary comparison', 'Use when Tier 1 versus full-service scope affects margin or positioning.', 'Prevents solution choice from undermining pricing architecture.', 'Boundary scenarios, gross margin sensitivity, delivery labor impact'],
    ],
    exit: 'Preferred solution path is documented, rejected paths have rationale, evidence gaps are assigned to later gates.',
  },
  {
    name: 'Architecture & Delivery Readiness',
    objective: 'Define product, data, integration, and delivery boundaries before build work creates lock-in.',
    options: [
      ['Architecture boundary review', 'Use before connector or dashboard build begins.', 'Confirms what is reusable, configurable, custom, deferred, or excluded.', 'Boundary spec, extension points, exception handling notes'],
      ['Schema and data coverage matrix', 'Use when core-system or use-case coverage determines pilot eligibility.', 'Prevents technical coverage from being confused with functional completeness.', 'Field coverage matrix, gap flags, ETL classification'],
      ['Delivery templateability audit', 'Use when delivery labor reduction is part of the strategy.', 'Shows which work can be productized and which still depends on consultants.', 'Consultant-hour baseline, manual intervention list, templateability score'],
      ['Compliance explainability review', 'Use when outputs may carry OCC, FinCEN, or model-risk scrutiny.', 'Ensures architecture and feature scope can support audit and examiner expectations.', 'Explainability memo, restricted fields, disclosure or exclusion rationale'],
    ],
    exit: 'Architecture boundaries are explicit, critical dependencies are confirmed or gated, delivery and compliance constraints are visible before pilot.',
  },
  {
    name: 'Pilot / Controlled Rollout',
    objective: 'Expose the solution to realistic workflow use while limiting client, regulatory, and delivery risk.',
    options: [
      ['Controlled client pilot', 'Use when real workflow evidence is needed before broader launch.', 'Tests usefulness, completeness, and delivery effort under bounded conditions.', 'Pilot notes, completeness results, client objections, workflow outcomes'],
      ['Parallel mock-to-live comparison', 'Use when mock validation may not reflect production behavior.', 'Checks whether prototype assumptions survive real data and users.', 'Variance log between mock expectations and live use'],
      ['Delivery operations dry run', 'Use when onboarding effort or support load is a major risk.', 'Validates whether the operating model can support rollout without hidden labor.', 'Runbook gaps, escalation events, support burden estimate'],
      ['Regulatory evidence package review', 'Use when pilot outputs may need audit defensibility.', 'Tests whether the evidence record can explain product decisions and boundaries.', 'Evidence binder, compliance comments, unresolved regulatory assumptions'],
    ],
    exit: 'Pilot evidence meets the validation standard, rework triggers are resolved or accepted, rollout risks are visible before scale.',
  },
  {
    name: 'Scale Decision',
    objective: 'Decide whether to scale, hold, narrow, or redirect based on observed evidence and dependency readiness.',
    options: [
      ['Go/no-go gate review', 'Use when leadership needs a clean scale decision.', 'Forces the decision to cite evidence, dependencies, risks, and unresolved assumptions.', 'Gate memo, decision rationale, conditions for scale'],
      ['Segmented rollout plan', 'Use when evidence is strong for some clients, core systems, or use cases but not all.', 'Avoids all-or-nothing scaling while preserving evidence discipline.', 'Eligible segment list, excluded segment rationale, next validation needs'],
      ['Scope adjustment workshop', 'Use when validation shows value but boundaries need refinement.', 'Turns pilot learning into a narrower or more durable execution scope.', 'Revised scope, deferred items, Stage 4 requirements candidates'],
      ['Post-pilot risk burn-down review', 'Use when risks remain material but manageable.', 'Confirms which risks reduced, which remain, and which require coordination.', 'Risk evidence summary, mitigation status, residual risk notes'],
    ],
    exit: 'Scale decision is evidence-backed, deferred work is routed to coordination or Stage 4, source traceability remains available.',
  },
]

// ── Learning signals ─────────────────────────────────────────────────────────

export const STAGE3_COMPILED_STRATEGY_LEARNING_SIGNALS = {
  productIntent: [
    'Stage 3 compiled strategy is a BU-readable decision-support artifact.',
    'It converts Stage 2 handoff evidence, Stage 3 atomized detail, shared spine, source references, and review learning into decisions, execution logic, dependencies, mitigated risks, validation criteria, and traceability.',
    'It should compile, compress, organize, and audit rather than copy Stage 2 or restate atomized Stage 3 buckets.',
  ],
  acceptedStructure: [
    'Strategic Objective',
    'Critical Decisions',
    'Execution Sequence',
    'Dependencies',
    'Risk & Mitigation',
    'Validation Framework',
    'Handoff Coverage / Loss Audit',
  ],
  generalLearningSignals: [
    'Stage 3 should compile, not copy, Stage 2 handoff content.',
    'Compression must be auditable.',
    'The compiled view should reduce repetition across strategy, decisions, gates, risks, dependencies, and validation.',
    'Each BU plan must define what the unit must accomplish.',
    'Each BU plan must identify decisions that block, shape, or materially change execution.',
    'Each BU plan must include realistic execution methods appropriate to that BU role.',
    'Each BU plan must distinguish dependencies from risks.',
    'Each BU plan must define mitigation options for material risks.',
    'Each BU plan must define how validation is completed.',
    'Each BU plan must state what evidence counts and how evidence quality is assessed.',
    'Handoff content must be classified as used, compressed, converted, deferred, source-only, unused, or possibly lost.',
    'Cross-BU ownership and reciprocal dependency assignment belong in Cross-BU Coordination, not forced into every BU risk section.',
    'No generated strategic text should be truncated.',
    'Do not use first-N-words labels or ellipsis labels as semantic structure.',
    'The compiled plan should prefer clear, role-specific labels over sliced source text.',
  ],
  prohibitedPatterns: [
    'repeating the same recommendation across multiple compiled sections',
    'turning every compiled section into a mini-plan',
    'generating only what statements without how',
    'generic end-to-end options such as validation first, architecture first, or partner first',
    'copying large blocks of handoff text into the compiled strategy',
    'silently dropping Stage 2 handoff content',
    'risks without mitigation options',
    'validation criteria that only say pilot metrics achieved',
    'validation content without completion criteria',
    'validation content without veracity checks',
    'dependencies that overlap with risks without clarifying the distinction',
    'adding owners where ownership belongs in Cross-BU Coordination',
    'visible labels derived from string slices',
    'visible strategic content with ellipses or truncation',
  ],
  qualityChecks: [
    { id: 'accepted_structure',        label: 'Compiled strategy follows the accepted structure.',                                                                          category: 'compiledBUExecutionPlan' },
    { id: 'decision_depth',            label: 'Each critical decision includes why it matters and evidence needed.',                                                        category: 'criticalDecisions' },
    { id: 'phase_how_options',         label: 'Execution sequence includes phase-specific practical how options.',                                                          category: 'executionSequence', minHowOptionsPerPhase: 3 },
    { id: 'execution_method_fit',      label: 'Each execution method explains why it fits the phase objective and identifies evidence produced.',                           category: 'executionSequence' },
    { id: 'risk_mitigation_depth',     label: 'Risks include mitigation options, early warnings, and evidence of reduction.',                                              category: 'risksAndMitigations', requiredFields: ['mitigationOptions', 'earlyWarningSignals', 'evidenceThatRiskIsReduced'] },
    { id: 'validation_depth',          label: 'Validation includes criteria, completion method, evidence, veracity, and rework triggers.',                                 category: 'validationFramework', requiredFields: ['completionCriteria', 'howToDetermineCompletion', 'evidenceExamples', 'veracityChecks', 'failureOrReworkTriggers'] },
    { id: 'dependency_distinction',    label: 'Dependencies remain distinct from risks and validation.',                                                                    category: 'dependencies' },
    { id: 'no_forced_risk_ownership',  label: 'Ownership is not forced inside BU risk sections.',                                                                          category: 'risksAndMitigations' },
    { id: 'auditable_compression',     label: 'Compression is auditable through handoff coverage.',                                                                        category: 'handoffCoverageAudit' },
    { id: 'handoff_classification',    label: 'Handoff content is classified across coverage buckets.',                                                                     category: 'handoffCoverageAudit' },
    { id: 'no_truncated_strategy_text',label: 'No generated strategic text is truncated.',                                                                                  category: 'compiledBUExecutionPlan' },
    { id: 'reduce_repetition',         label: 'Compiled view reduces repetition compared with atomized buckets.',                                                           category: 'compiledBUExecutionPlan' },
    { id: 'field_distinctness',        label: 'Within each compiled item, fields play distinct roles and do not duplicate each other.',                                     category: 'compiledBUExecutionPlan' },
  ],
  buAdaptationGuidance: {
    executive:          ['investment authority', 'decision thresholds', 'governance cadence', 'prioritization tradeoffs', 'escalation criteria'],
    compliance:         ['regulatory interpretation', 'documentation standards', 'review checkpoints', 'evidence sufficiency', 'model-risk concerns', 'examiner readiness'],
    engineering:        ['capacity constraints', 'integration feasibility', 'technical sequencing', 'interface contracts', 'non-functional requirements', 'architecture risk'],
    goToMarket:         ['positioning', 'buyer segmentation', 'launch readiness', 'messaging validation', 'sales enablement', 'commercial signal quality'],
    partner:            ['vendor evaluation', 'commercial terms', 'integration risk', 'substitution rights', 'partner dependency', 'procurement readiness'],
    delivery:           ['workflow validation', 'client readiness', 'operational adoption', 'delivery burden', 'support model', 'implementation feedback loops'],
    productArchitecture:['use cases', 'outcomes', 'workflow evidence', 'mock/prototype validation', 'solution path comparison', 'architecture review', 'pilot evidence'],
  },
  pmValidationCaseGuidance: {
    phases: PM_PHASES,
    risks: PM_RISK_TEMPLATES,
    evidenceExamples: ['annotated mock review', 'workflow walkthrough notes', 'before/after workflow comparison', 'client feedback summary', 'Managed Client Delivery review notes', 'recorded objections', 'unresolved concerns', 'architecture review notes', 'interface specification', 'comparative vendor scorecard'],
    veracityChecks: ['evidence is observed, not only self-reported', 'evidence comes from more than one client/workflow where possible', 'contradictory feedback is documented', 'assumptions are tagged unresolved', 'decision rationale is traceable', 'evidence shows decision impact, not just user preference'],
  },
}

// ── Validation framework per-question data ────────────────────────────────────
//
// Each array is indexed by question position.
// Using distinct subsets per question prevents the same boilerplate
// appearing verbatim under every validation item.

// PM (productArchitecture) profile
const PM_EVIDENCE_BY_QUESTION = [
  // q0: Does the output improve a real BSA/AML or product workflow decision?
  ['annotated mock review', 'workflow walkthrough notes', 'before/after workflow comparison', 'client feedback summary'],
  // q1: Is the architecture and data coverage valid enough to support the promised product boundary?
  ['architecture review notes', 'interface specification', 'schema coverage matrix', 'data gap flags and ETL classification'],
  // q2: Is the pilot standard strong enough to justify rollout or scale?
  ['controlled pilot notes', 'completeness results', 'client objections log', 'Managed Client Delivery review notes'],
  // q3: Are regulatory and explainability assumptions traceable enough to proceed?
  ['recorded unresolved concerns', 'compliance commentary', 'comparative vendor scorecard', 'explainability memo or audit package'],
]

const PM_VERACITY_BY_QUESTION = [
  // q0: workflow outcome
  ['evidence is observed, not only self-reported', 'contradictory feedback is documented', 'evidence shows decision impact, not just user preference'],
  // q1: architecture/coverage
  ['architecture review is independent, not self-assessed', 'schema gaps are traced to specific use cases', 'extension points are documented with tested examples'],
  // q2: pilot standard
  ['evidence comes from more than one client/workflow where possible', 'pilot scope matches the validation standard', 'decision rationale is traceable to observed use'],
  // q3: regulatory/explainability
  ['regulatory inputs are from Compliance or MRG, not assumed by product', 'evidence package can support examiner-facing review', 'open regulatory questions remain visible and tagged'],
]

const PM_FAILURE_TRIGGERS_BY_QUESTION = [
  // q0
  ['Users cannot interpret the output without analyst translation.', 'Output does not change a real BSA/AML workflow decision.', 'Contradictory workflow feedback is unresolved before the gate.'],
  // q1
  ['Schema coverage gaps are discovered after build commitment begins.', 'Architecture choices create connector lock-in before pilot scope is confirmed.', 'Extension points are not independently testable without full redesign.'],
  // q2
  ['Pilot users require onboarding support to use the output independently.', 'Evidence conflicts between mock validation and live use are unresolved at gate.', 'Rollout decision is made on fewer clients or use cases than the validation standard requires.'],
  // q3
  ['Explainability gaps are discovered by an examiner rather than internal review.', 'Exclusion rationale is not traceable to source decisions.', 'Regulatory assumptions change after product boundaries are locked.'],
]

const PM_COMPLETION_CRITERIA_BY_QUESTION = [
  // q0
  [
    'At least one realistic workflow walkthrough shows a user completing a BSA/AML decision without analyst translation.',
    'Contradictory feedback and unresolved assumptions are documented, not summarized away.',
    'Outcome signal is observable and agreed before solution path evaluation begins.',
  ],
  // q1
  [
    'Architecture boundary spec confirms what is reusable, configurable, custom, deferred, and excluded.',
    'Schema coverage matrix maps each required field to a core system source or flags the gap.',
    'API Engineering or the relevant technical owner signs off on interface contracts before build starts.',
  ],
  // q2
  [
    'Pilot evidence covers the stated validation standard — not fewer clients or use cases than specified.',
    'Rework triggers are either resolved or explicitly accepted with a documented rationale.',
    'Rollout risks are visible and bounded before scale commitment is made.',
  ],
  // q3
  [
    'Compliance or Model Risk has reviewed scope, explainability approach, and exclusion rationale.',
    'Open regulatory assumptions are tagged and visible, not treated as resolved.',
    'Evidence package can answer an examiner query without engineering support to translate it.',
  ],
]

const PM_HOW_TO_COMPLETE_BY_QUESTION = [
  // q0
  ['Observe mock, prototype, or pilot use in a realistic BSA/AML workflow.', 'Compare expected use against actual user interpretation and decision behavior.', 'Document hesitation, rejection, reinterpretation, and decision changes.'],
  // q1
  ['Run an architecture boundary review before connector or dashboard build begins.', 'Complete a schema and data coverage matrix against the required use cases.', 'Confirm interface contracts with API Engineering before Sprint 2 kickoff.'],
  // q2
  ['Run the controlled pilot against the pre-agreed validation standard.', 'Compare mock expectations against live use behavior and flag variances.', 'Review delivery operations under realistic onboarding and support conditions.'],
  // q3
  ['Submit the scope, explainability approach, and evidence package to Compliance and Model Risk.', 'Review open regulatory assumptions with a legal or examiner-readiness lens.', 'Confirm that the evidence record can survive an independent audit review.'],
]

// Generic profiles — per-question data (3 questions)
const GEN_EVIDENCE_BY_QUESTION = [
  // q0: Does this BU execution path improve the operating outcome it is responsible for?
  ['observed workflow notes', 'before/after operating comparison', 'stakeholder feedback summary'],
  // q1: Are the decision and dependency inputs complete enough to proceed?
  ['dependency confirmation notes', 'readiness review notes', 'decision record'],
  // q2: Is the evidence strong enough to advance the next BU-specific gate?
  ['unresolved concerns log', 'evidence quality review', 'gate checklist'],
]

const GEN_VERACITY_BY_QUESTION = [
  // q0
  ['evidence is observed or source-traceable, not only asserted', 'contradictory feedback is documented', 'evidence shows operating impact, not only preference'],
  // q1
  ['dependency inputs are confirmed, not assumed', 'decision rationale is traceable', 'assumptions are tagged unresolved'],
  // q2
  ['evidence quality is assessed independently, not self-reported', 'unresolved concerns are visible', 'gate criteria are met in full, not partially'],
]

const GEN_FAILURE_TRIGGERS_BY_QUESTION = [
  // q0
  ['Operating outcome improvement cannot be demonstrated with observed evidence.', 'Users of this BU output still need translation to act on it.', 'Feedback is positive but unobserved — no workflow evidence supports the claim.'],
  // q1
  ['Key decision inputs are still assumed rather than confirmed at the gate.', 'Dependencies remain unresolved and block forward progress.', 'Evidence quality is insufficient to support the decision with confidence.'],
  // q2
  ['Gate evidence is partial, self-reported, or untraced to observed behavior.', 'Unresolved concerns are not documented or accepted before the gate.', 'Evidence conflicts are carried forward without a documented rationale.'],
]

const GEN_COMPLETION_CRITERIA_BY_QUESTION = [
  // q0
  [
    'The target user can use the output in a realistic workflow without extra translation.',
    'The evidence supports a real workflow decision or reduces observable friction.',
    'Contradictory feedback and unresolved assumptions are documented.',
  ],
  // q1
  [
    'All required dependency inputs are confirmed or the gap has an explicit escalation path.',
    'Decision criteria are met or the unresolved evidence has a named owner and deadline.',
    'Dependency readiness review is complete before the next execution phase begins.',
  ],
  // q2
  [
    'Evidence quality review confirms the gate criteria are met in full.',
    'Unresolved concerns are either resolved or accepted with documented rationale.',
    'No material evidence conflicts remain open at the gate.',
  ],
]

const GEN_HOW_TO_COMPLETE_BY_QUESTION = [
  // q0
  ['Observe or simulate the target workflow with realistic inputs and users.', 'Compare expected use against actual interpretation and decision behavior.', 'Document hesitation, rejection, reinterpretation, and decision changes.'],
  // q1
  ['Confirm each required dependency input with the owning function.', 'Resolve or escalate decision blockers before the gate review.', 'Document unresolved assumptions with owner and deadline.'],
  // q2
  ['Run an evidence quality review against the pre-agreed gate criteria.', 'Surface and resolve open concerns before the gate.', 'Confirm that no evidence conflicts remain without documented rationale.'],
]

// ── Builder: Critical Decisions ───────────────────────────────────────────────
//
// Field-role contract:
//   decisionQuestion   — the choice to be made (from decisionsRequired atoms)
//   whyItMatters       — consequence of leaving it unresolved (from sequencingAndGates or synthesized)
//   decisionEvidenceNeeded — proof required to decide (from validationSignals or domain defaults)
//   decisionTiming     — when the decision gates execution (phase-indexed defaults)

export function buildCompiledCriticalDecisions(tree, handoffBrief, profile) {
  const decisionTexts    = pickBulletTexts(tree, 'decisionsRequired',   null, 40)
  const sequencingTexts  = pickBulletTexts(tree, 'sequencingAndGates',  null, 20)
  const validationTexts  = pickBulletTexts(tree, 'validationSignals',   null, 20)
  const objectiveTexts   = pickBulletTexts(tree, 'objective',           null, 10)

  const patterns = profile === 'productArchitecture' ? PM_DECISION_PATTERNS : genericDecisionPatterns(profile)

  // Phase-indexed timing — unique per decision position, not one boilerplate for all
  const phaseTimingDefaults = [
    'Resolve before execution path is locked in Phase 1.',
    'Resolve before Phase 2 scope commitment and build start.',
    'Resolve before the pilot validation gate.',
    'Resolve before rollout or scale decision.',
    'Resolve before handoff to Stage 4 artifact planning.',
  ]

  return patterns.map((pattern, idx) => {
    const questionHits   = decisionTexts.filter(t => pattern.re.test(t))
    const sequencingHits = sequencingTexts.filter(t => pattern.re.test(t) || /before|prior|precede|gate|sprint|pilot/i.test(t))
    const evidenceHits   = validationTexts.filter(t => pattern.re.test(t))

    const questionBasis = questionHits[0] || ''

    // whyItMatters: from a DIFFERENT bucket (sequencingAndGates or objective),
    // or a synthesized consequence — never the same text as decisionQuestion.
    const consequenceSource = sequencingHits.find(t => t !== questionBasis) || objectiveTexts[idx] || null
    const whyItMatters = consequenceSource && normalizeSearchText(consequenceSource) !== normalizeSearchText(questionBasis)
      ? firstSentence(consequenceSource, 220)
      : `Unresolved, this decision directly changes scope, sequencing, and the evidence required before the next gate.`

    // decisionEvidenceNeeded: from validationSignals (different bucket from decisionsRequired),
    // filtered to exclude items that are near-duplicates of decisionQuestion.
    const questionFP = semanticFingerprint(questionBasis)
    const evidenceItems = evidenceHits
      .map(t => firstSentence(t, 180))
      .filter(Boolean)
      .filter(e => jaccardSim(semanticFingerprint(e), questionFP) < 0.65)
      .slice(0, 2)
    const domainDefault = profile === 'productArchitecture'
      ? ['Observed workflow or pilot evidence tied to the specific decision criteria', 'Architecture or coverage review confirming the chosen option is feasible', 'Dependency readiness confirmation from the relevant function']
      : ['Observed evidence tied to the decision criteria', 'Dependency readiness confirmation from the relevant function', 'Source-traceable rationale aligned to the option chosen']
    const decisionEvidenceNeeded = [...evidenceItems, ...domainDefault.filter(d => !evidenceItems.some(e => normalizeSearchText(e).includes(normalizeSearchText(d).slice(0, 30))))].slice(0, 3)

    // decisionTiming: use atom text ONLY if it specifically matches the pattern regex
    // (not just a generic timing keyword), so different decisions get different timings.
    const patternSpecificTiming = sequencingHits.find(t =>
      pattern.re.test(t) && /before|gate|sprint|phase|week|month/i.test(t)
    )
    const decisionTiming = patternSpecificTiming
      ? firstSentence(patternSpecificTiming, 170)
      : phaseTimingDefaults[idx] || `Resolve before the dependent execution phase proceeds.`

    return {
      decisionName: pattern.name,
      decisionQuestion: questionBasis ? firstSentence(questionBasis, 230) : `What ${pattern.name.toLowerCase()} position should govern execution?`,
      whyItMatters,
      decisionOptions: pattern.options,
      decisionEvidenceNeeded,
      decisionTiming,
      sourceRefs: stage3SourceRefsFrom(handoffBrief),
    }
  })
}

// ── Builder: Execution Sequence ───────────────────────────────────────────────

export function buildCompiledExecutionSequence(tree, handoffBrief, profile) {
  const validationEvidence = pickBulletTexts(tree, 'validationSignals',  null, 12)
  const sequencingEvidence = pickBulletTexts(tree, 'sequencingAndGates', null, 12)
  const phases = profile === 'productArchitecture' ? PM_PHASES : GENERAL_PHASES

  const phaseWhyText = [
    'The plan should validate workflow value before architecture or rollout commitments harden.',
    'Solution alternatives are useful only after the outcome and evidence standard are clear.',
    'Readiness work prevents pilot learning from being polluted by unresolved architecture or delivery constraints.',
    'A controlled pilot creates observed evidence while limiting risk.',
    'Scale should follow evidence, dependency readiness, and risk burn-down.',
  ]

  return phases.map((phase, idx) => ({
    phaseName: phase.name,
    phaseObjective: phase.objective,
    howOptions: phase.options.map(([optionName, whenToUse, whyItFits, evidenceProduced]) => ({
      optionName,
      whatItDoes: optionName,
      whenToUse,
      whyItFitsThePhaseOutcome: whyItFits,
      evidenceProduced,
    })),
    recommendedHow: phase.options[0][0],
    whyThisFitsThePhase: phaseWhyText[idx] || 'This phase sequences work in the order that protects evidence quality.',
    exitCriteria: phase.exit || '',
    evidenceExamples: [
      ...validationEvidence.slice(idx * 2, idx * 2 + 2),
      ...sequencingEvidence.slice(idx, idx + 1),
    ].filter(Boolean).slice(0, 4),
    sourceRefs: stage3SourceRefsFrom(handoffBrief),
  }))
}

// ── Builder: Dependencies ─────────────────────────────────────────────────────
//
// Field-role contract (enforced — no field may duplicate another):
//   dependencyDescription  — what the dependency IS (the full statement)
//   whyItMatters           — gating/consequence, synthesized (NOT same as description)
//   requiredInput          — the specific deliverable noun phrase (extracted, NOT same sentence)
//   consequenceIfMissing   — operational impact if not delivered (extracted or domain template)

function extractRequiredInputClause(text) {
  // Try: verb + short noun phrase (max 55 chars) — keeps requiredInput distinct from description
  const verbMatch = text.match(/(?:deliver|provide|approve|confirm|complete|finalize|supply|produce|submit|share|publish)\s+([^,;.\n]{5,55})/i)
  if (verbMatch) return verbMatch[0].trim()
  // Try: explicit noun phrase (specification/approval/schema/contract/guideline/output)
  const nounMatch = text.match(/\b(?:specification|requirement|approval|sign.?off|schema|contract|guideline|output|package|review|decision|assessment)\b[^,;.]{0,100}/i)
  if (nounMatch) return nounMatch[0].trim()
  // Try: split on conjunction / condition to get the first clause
  const firstClause = text.split(/(?:,\s*|\s+(?:and|or|so that|in order to|to ensure|before|by|which)\s+)/i)[0]
  if (firstClause && firstClause.length > 10 && firstClause !== text) return firstClause.trim().slice(0, 150)
  // Fallback: truncated first sentence
  return firstSentence(text, 160)
}

function extractConsequenceClause(text) {
  // Try: consequence keywords + following clause
  const m = text.match(/(?:cannot|can't|will not|blocks?|prevent|delay|fail|risk|miss|otherwise|without this|absent|if not)\b[^,;.]{5,200}/i)
  if (m) return m[0].trim().slice(0, 200)
  // Gate language without explicit consequence → use a gating template
  if (/gate|prerequisite|required before|must have before/.test(text))
    return 'Execution blocks at the dependent gate without this input.'
  // Generic fallback — differentiated from "whyItMatters"
  return 'Downstream execution phases must proceed on unvalidated assumptions, increasing rework risk.'
}

export function buildCompiledDependencies(tree, handoffBrief) {
  return pickBulletTexts(tree, 'dependencies', null, 10).slice(0, 8).map((text, idx) => {
    const name = firstSentence(text, 80)
      .replace(/\s+must\b.*$/i, '')
      .replace(/\s+is required\b.*$/i, '')
      .trim() || `Dependency ${idx + 1}`

    const description = firstSentence(text, 260)
    const requiredInput = extractRequiredInputClause(text)
    const consequenceIfMissing = extractConsequenceClause(text)

    // whyItMatters — synthesized, focused on gating impact.
    // Must not be the same sentence as description, requiredInput, or consequenceIfMissing.
    const isGating = /gate|block|before|prerequisite|required/i.test(text)
    const whyItMatters = isGating
      ? `This input gates forward progress — the ${name.toLowerCase().slice(0, 60)} track cannot proceed confidently without it.`
      : `Without this input, the relevant execution phase must proceed on untested assumptions, reducing evidence quality.`

    return {
      dependencyName: name,
      dependencyDescription: description,
      whyItMatters,
      requiredInput,
      consequenceIfMissing,
      sourceRefs: stage3SourceRefsFrom(handoffBrief),
    }
  })
}

// ── Builder: Risks ────────────────────────────────────────────────────────────
//
// Field-role contract:
//   riskDescription    — the failure mode (what specifically breaks)
//   whyItMatters       — downstream consequence if the risk materializes (NOT same as description)
//   mitigationOptions  — tailored actions that reduce this specific risk
//   earlyWarningSignals — observable signs the risk is activating
//   evidenceThatRiskIsReduced — what demonstrates the risk has been managed

export function buildCompiledRisks(tree, handoffBrief, profile) {
  const riskTexts = pickBulletTexts(tree, 'risks', null, 40)
  const templates = profile === 'productArchitecture'
    ? PM_RISK_TEMPLATES
    : genericRiskTemplates(tree, profile)

  // Track which atom texts have already been used as riskDescriptions so that
  // two templates matching the same atom don't produce identical descriptions.
  const usedDescriptions = new Set()

  return templates.map(template => {
    const hits = riskTexts.filter(t => template.re.test(t))

    // riskDescription = the failure mode. Use the first UNUSED hit, or the
    // template description if all hits are already consumed by earlier templates.
    const unusedHit = hits.find(h => !usedDescriptions.has(normalizeSearchText(h)))
    const riskDescription = unusedHit ? firstSentence(unusedHit, 260) : template.description
    if (unusedHit) usedDescriptions.add(normalizeSearchText(unusedHit))

    // whyItMatters = the downstream consequence — must be distinct from riskDescription.
    // If hits[1] exists AND is sufficiently different from riskDescription, use it.
    // Otherwise use the template consequence or synthesize one.
    let whyItMatters
    const secondHit = hits.find(h => h !== unusedHit && !usedDescriptions.has(normalizeSearchText(h)))
    if (secondHit && jaccardSim(semanticFingerprint(secondHit), semanticFingerprint(riskDescription)) < 0.65) {
      whyItMatters = firstSentence(secondHit, 220)
    } else if (template.consequence && normalizeSearchText(template.consequence) !== normalizeSearchText(riskDescription)) {
      whyItMatters = template.consequence
    } else {
      whyItMatters = synthesizeRiskConsequence(riskDescription, profile)
    }

    return {
      riskName:                 template.name,
      riskDescription,
      whyItMatters,
      mitigationOptions:        template.mitigations,
      earlyWarningSignals:      template.warnings,
      evidenceThatRiskIsReduced: template.reduced,
      sourceRefs: stage3SourceRefsFrom(handoffBrief),
    }
  })
}

// ── Builder: Validation Framework ────────────────────────────────────────────
//
// Anti-repetition contract:
//   Each validation question must have UNIQUE completionCriteria, evidenceExamples,
//   veracityChecks, howToDetermineCompletion, and failureOrReworkTriggers.
//   The same static array must NOT appear verbatim under every question.

export function buildCompiledValidationFramework(tree, handoffBrief, profile) {
  const validationTexts = pickBulletTexts(tree, 'validationSignals', null, 16)

  const isPM = profile === 'productArchitecture'

  const questions = isPM
    ? [
        'Does the output improve a real BSA/AML or product workflow decision?',
        'Is the architecture and data coverage valid enough to support the promised product boundary?',
        'Is the pilot standard strong enough to justify rollout or scale?',
        'Are regulatory and explainability assumptions traceable enough to proceed?',
      ]
    : [
        `Does this BU execution path improve the operating outcome it is responsible for?`,
        `Are the decision and dependency inputs complete enough to proceed?`,
        `Is the evidence strong enough to advance the next BU-specific gate?`,
      ]

  const evidenceByQ   = isPM ? PM_EVIDENCE_BY_QUESTION   : GEN_EVIDENCE_BY_QUESTION
  const veracityByQ   = isPM ? PM_VERACITY_BY_QUESTION   : GEN_VERACITY_BY_QUESTION
  const failureByQ    = isPM ? PM_FAILURE_TRIGGERS_BY_QUESTION : GEN_FAILURE_TRIGGERS_BY_QUESTION
  const criteriaByQ   = isPM ? PM_COMPLETION_CRITERIA_BY_QUESTION : GEN_COMPLETION_CRITERIA_BY_QUESTION
  const howByQ        = isPM ? PM_HOW_TO_COMPLETE_BY_QUESTION : GEN_HOW_TO_COMPLETE_BY_QUESTION

  return questions.map((question, idx) => {
    // Allow an atom-derived item to enrich the first completion criterion if available
    const atomCriterion = validationTexts[idx] ? firstSentence(validationTexts[idx], 210) : null
    const criteria = atomCriterion && normalizeSearchText(atomCriterion) !== normalizeSearchText(criteriaByQ[idx]?.[0])
      ? [atomCriterion, ...(criteriaByQ[idx] || []).slice(1)]
      : (criteriaByQ[idx] || [])

    return {
      validationQuestion:       question,
      completionCriteria:       criteria,
      howToDetermineCompletion: howByQ[idx] || ['Observe realistic use.', 'Compare expected vs actual behavior.', 'Document unresolved concerns.'],
      evidenceExamples:         evidenceByQ[idx] || [],
      veracityChecks:           veracityByQ[idx] || [],
      failureOrReworkTriggers:  failureByQ[idx] || [],
      sourceRefs: stage3SourceRefsFrom(handoffBrief),
    }
  })
}

// ── Quality checks ────────────────────────────────────────────────────────────

function asArr(v) { return Array.isArray(v) ? v : [] }

function stringsAreNearDuplicate(a, b, threshold = 0.72) {
  if (!a || !b) return false
  if (normalizeSearchText(a) === normalizeSearchText(b)) return true
  return jaccardSim(semanticFingerprint(a), semanticFingerprint(b)) >= threshold
}

function arraysAreIdentical(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  return a.every((item, i) => normalizeSearchText(item) === normalizeSearchText(b[i]))
}

/**
 * Validates field distinctness within a compiled plan.
 * Returns an array of violation objects:
 *   { section, item, field1, field2, reason }
 */
export function validateStage3CompiledFieldDistinctness(compiledPlan) {
  const violations = []

  // ── Critical Decisions ────────────────────────────────────────────────────
  asArr(compiledPlan?.criticalDecisions).forEach((d, i) => {
    const label = d.decisionName || `Decision ${i + 1}`
    if (stringsAreNearDuplicate(d.decisionQuestion, d.whyItMatters))
      violations.push({ section: 'criticalDecisions', item: label, field1: 'decisionQuestion', field2: 'whyItMatters', reason: 'question and whyItMatters repeat the same framing' })
    const firstEvidence = asArr(d.decisionEvidenceNeeded)[0]
    if (stringsAreNearDuplicate(d.decisionQuestion, firstEvidence))
      violations.push({ section: 'criticalDecisions', item: label, field1: 'decisionQuestion', field2: 'decisionEvidenceNeeded[0]', reason: 'question text appears verbatim in evidenceNeeded' })
    if (stringsAreNearDuplicate(d.whyItMatters, firstEvidence))
      violations.push({ section: 'criticalDecisions', item: label, field1: 'whyItMatters', field2: 'decisionEvidenceNeeded[0]', reason: 'whyItMatters and first evidence item repeat the same text' })
    // Flag if all decisions share the same timing boilerplate
  })
  const timings = asArr(compiledPlan?.criticalDecisions).map(d => normalizeSearchText(d.decisionTiming)).filter(Boolean)
  if (timings.length >= 2 && new Set(timings).size === 1)
    violations.push({ section: 'criticalDecisions', item: 'all', field1: 'decisionTiming', field2: 'decisionTiming', reason: 'all decisions share the same timing text' })

  // ── Dependencies ─────────────────────────────────────────────────────────
  // Note: description and requiredInput will naturally share vocabulary (same dependency).
  // Flag only exact-string duplication for that pair; use higher threshold for consequence.
  asArr(compiledPlan?.dependencies).forEach((d, i) => {
    const label = d.dependencyName || `Dependency ${i + 1}`
    if (normalizeSearchText(d.dependencyDescription) === normalizeSearchText(d.requiredInput))
      violations.push({ section: 'dependencies', item: label, field1: 'dependencyDescription', field2: 'requiredInput', reason: 'description and requiredInput are the same sentence' })
    if (stringsAreNearDuplicate(d.dependencyDescription, d.consequenceIfMissing, 0.82))
      violations.push({ section: 'dependencies', item: label, field1: 'dependencyDescription', field2: 'consequenceIfMissing', reason: 'description and consequenceIfMissing repeat the same text' })
    if (stringsAreNearDuplicate(d.requiredInput, d.consequenceIfMissing, 0.82))
      violations.push({ section: 'dependencies', item: label, field1: 'requiredInput', field2: 'consequenceIfMissing', reason: 'requiredInput and consequenceIfMissing are near-duplicates' })
  })

  // ── Risks ─────────────────────────────────────────────────────────────────
  asArr(compiledPlan?.risksAndMitigations).forEach((r, i) => {
    const label = r.riskName || `Risk ${i + 1}`
    if (stringsAreNearDuplicate(r.riskDescription, r.whyItMatters))
      violations.push({ section: 'risksAndMitigations', item: label, field1: 'riskDescription', field2: 'whyItMatters', reason: 'failure mode and whyItMatters repeat the same text' })
  })
  // Cross-risk: flag if different risks share identical descriptions
  const riskDescs = asArr(compiledPlan?.risksAndMitigations).map(r => normalizeSearchText(r.riskDescription)).filter(Boolean)
  riskDescs.forEach((desc, i) => {
    riskDescs.slice(i + 1).forEach((other, j) => {
      if (desc === other) {
        const ri = compiledPlan.risksAndMitigations[i]?.riskName || `Risk ${i + 1}`
        const rj = compiledPlan.risksAndMitigations[i + 1 + j]?.riskName || `Risk ${i + 2 + j}`
        violations.push({ section: 'risksAndMitigations', item: `${ri} vs ${rj}`, field1: 'riskDescription', field2: 'riskDescription', reason: 'two distinct risks share the same failure-mode description' })
      }
    })
  })

  // ── Validation Framework ─────────────────────────────────────────────────
  const vf = asArr(compiledPlan?.validationFramework)
  if (vf.length >= 2) {
    // Check if evidenceExamples / veracityChecks / failureOrReworkTriggers are
    // identical across questions (the original bug).
    const evidenceArrays = vf.map(v => asArr(v.evidenceExamples))
    const veracityArrays = vf.map(v => asArr(v.veracityChecks))
    const failureArrays  = vf.map(v => asArr(v.failureOrReworkTriggers))
    const criteriaArrays = vf.map(v => asArr(v.completionCriteria))

    for (let i = 0; i < vf.length - 1; i++) {
      for (let j = i + 1; j < vf.length; j++) {
        const qi = vf[i].validationQuestion || `Q${i + 1}`
        const qj = vf[j].validationQuestion || `Q${j + 1}`
        if (evidenceArrays[i].length && arraysAreIdentical(evidenceArrays[i], evidenceArrays[j]))
          violations.push({ section: 'validationFramework', item: `${qi} vs ${qj}`, field1: 'evidenceExamples', field2: 'evidenceExamples', reason: 'identical evidenceExamples array repeated across two different validation questions' })
        if (veracityArrays[i].length && arraysAreIdentical(veracityArrays[i], veracityArrays[j]))
          violations.push({ section: 'validationFramework', item: `${qi} vs ${qj}`, field1: 'veracityChecks', field2: 'veracityChecks', reason: 'identical veracityChecks array repeated across two different validation questions' })
        if (failureArrays[i].length && arraysAreIdentical(failureArrays[i], failureArrays[j]))
          violations.push({ section: 'validationFramework', item: `${qi} vs ${qj}`, field1: 'failureOrReworkTriggers', field2: 'failureOrReworkTriggers', reason: 'identical failureOrReworkTriggers array repeated across two different validation questions' })
        if (criteriaArrays[i].length && arraysAreIdentical(criteriaArrays[i], criteriaArrays[j]))
          violations.push({ section: 'validationFramework', item: `${qi} vs ${qj}`, field1: 'completionCriteria', field2: 'completionCriteria', reason: 'identical completionCriteria array repeated across two different validation questions' })
      }
    }
  }

  return violations
}

// ── Cross-section repetition ──────────────────────────────────────────────────

export function repeatedCompiledTextItems(compiledPlan) {
  const grouped = [
    ['criticalDecisions',   asArr(compiledPlan?.criticalDecisions).map(d => [d.decisionName, d.decisionQuestion, d.whyItMatters].join(' '))],
    ['executionSequence',   asArr(compiledPlan?.executionSequence).flatMap(p => [p.phaseObjective, p.whyThisFitsThePhase, ...asArr(p.exitCriteria), ...asArr(p.evidenceExamples)])],
    ['dependencies',        asArr(compiledPlan?.dependencies).map(d => [d.dependencyDescription, d.whyItMatters, d.requiredInput, d.consequenceIfMissing].join(' '))],
    ['risksAndMitigations', asArr(compiledPlan?.risksAndMitigations).map(r => [r.riskDescription, r.whyItMatters].join(' '))],
    ['validationFramework', asArr(compiledPlan?.validationFramework).flatMap(v => [v.validationQuestion, ...asArr(v.completionCriteria), ...asArr(v.failureOrReworkTriggers)])],
  ]
  const items = grouped.flatMap(([section, values]) =>
    values.map(value => ({ section, text: normalizeSearchText(value), fp: semanticFingerprint(value) })).filter(item => item.text.length > 50),
  )
  const repeats = []
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[i].section === items[j].section) continue
      if (jaccardSim(items[i].fp, items[j].fp) >= 0.78)
        repeats.push({ firstSection: items[i].section, secondSection: items[j].section, text: items[i].text })
    }
  }
  return repeats.slice(0, 6)
}

// ── Quality audit ─────────────────────────────────────────────────────────────

function auditPass(rule, details = {}) { return { ruleId: rule.id, label: rule.label, status: 'pass', details } }
function auditFail(rule, message, details = {}) { return { ruleId: rule.id, label: rule.label, status: 'fail', message, details } }

export function buildStage3CompiledStrategyQualityAudit(compiledPlan, handoffCoverageAudit, rules = STAGE3_COMPILED_STRATEGY_LEARNING_SIGNALS.qualityChecks) {
  const results = []
  const ruleById = Object.fromEntries(rules.map(r => [r.id, r]))

  const requiredTopLevel = ['strategicObjective', 'criticalDecisions', 'executionSequence', 'dependencies', 'risksAndMitigations', 'validationFramework']
  const missingTopLevel = requiredTopLevel.filter(key => !compiledPlan?.[key] || (Array.isArray(compiledPlan[key]) && !compiledPlan[key].length))
  results.push(missingTopLevel.length
    ? auditFail(ruleById.accepted_structure, 'Compiled strategy is missing one or more accepted structure sections.', { missing: missingTopLevel })
    : auditPass(ruleById.accepted_structure))

  const weakDecisions = asArr(compiledPlan?.criticalDecisions).filter(d => !d?.whyItMatters || !asArr(d?.decisionEvidenceNeeded).length)
  results.push(weakDecisions.length
    ? auditFail(ruleById.decision_depth, 'Some critical decisions are missing why-it-matters or evidence-needed detail.', { decisions: weakDecisions.map(d => d.decisionName) })
    : auditPass(ruleById.decision_depth, { decisionsChecked: asArr(compiledPlan?.criticalDecisions).length }))

  const phases = asArr(compiledPlan?.executionSequence)
  const weakHowPhases = phases.filter(p => asArr(p.howOptions).length < (ruleById.phase_how_options?.minHowOptionsPerPhase || 3))
  results.push(weakHowPhases.length
    ? auditFail(ruleById.phase_how_options, 'One or more phases are missing enough practical how options.', { phases: weakHowPhases.map(p => p.phaseName) })
    : auditPass(ruleById.phase_how_options, { phasesChecked: phases.length }))

  const weakExecutionMethods = phases.flatMap(p =>
    asArr(p.howOptions)
      .filter(o => !o?.whyItFitsThePhaseOutcome || !o?.evidenceProduced)
      .map(o => `${p.phaseName}: ${o.optionName || o.whatItDoes || 'option'}`),
  )
  results.push(weakExecutionMethods.length
    ? auditFail(ruleById.execution_method_fit, 'Some execution methods are missing why-it-fits or evidence-produced detail.', { options: weakExecutionMethods.slice(0, 8) })
    : auditPass(ruleById.execution_method_fit, { optionsChecked: phases.reduce((sum, p) => sum + asArr(p.howOptions).length, 0) }))

  const risks = asArr(compiledPlan?.risksAndMitigations)
  const weakRisks = risks.filter(r => (ruleById.risk_mitigation_depth?.requiredFields || []).some(f => !asArr(r?.[f]).length))
  results.push(weakRisks.length
    ? auditFail(ruleById.risk_mitigation_depth, 'Some risks are missing mitigation depth.', { risks: weakRisks.map(r => r.riskName) })
    : auditPass(ruleById.risk_mitigation_depth, { risksChecked: risks.length }))

  const validation = asArr(compiledPlan?.validationFramework)
  const weakValidation = validation.filter(v => (ruleById.validation_depth?.requiredFields || []).some(f => !asArr(v?.[f]).length))
  results.push(weakValidation.length
    ? auditFail(ruleById.validation_depth, 'Some validation items are missing criteria, evidence, veracity, or rework triggers.', { questions: weakValidation.map(v => v.validationQuestion) })
    : auditPass(ruleById.validation_depth, { validationItemsChecked: validation.length }))

  const dependencyBleed = asArr(compiledPlan?.dependencies).filter(d => /mitigation|early warning|veracity|completion criteria|failure trigger|risk is reduced/i.test(compiledText(d)))
  results.push(dependencyBleed.length
    ? auditFail(ruleById.dependency_distinction, 'Some dependencies appear to contain risk or validation language.', { dependencies: dependencyBleed.map(d => d.dependencyName) })
    : auditPass(ruleById.dependency_distinction, { dependenciesChecked: asArr(compiledPlan?.dependencies).length }))

  const forcedRiskOwnership = risks.filter(r => /\b(owner|owns|ownership|accountable|responsible|raci)\b/i.test(compiledText(r)))
  results.push(forcedRiskOwnership.length
    ? auditFail(ruleById.no_forced_risk_ownership, 'Some risk sections appear to force ownership inside the BU risk model.', { risks: forcedRiskOwnership.map(r => r.riskName) })
    : auditPass(ruleById.no_forced_risk_ownership, { risksChecked: risks.length }))

  results.push(handoffCoverageAudit
    ? auditPass(ruleById.auditable_compression, { possibleLosses: handoffCoverageAudit.possibleLosses?.length || 0 })
    : auditFail(ruleById.auditable_compression, 'No handoff coverage audit was derived.'))

  const classifiedCount = ['usedInCompiledStrategy', 'compressedIntoSpine', 'representedAsDependency', 'representedAsRisk', 'representedAsValidation', 'deferredToCoordination', 'deferredToStage4', 'sourceOnlyEvidence', 'notUsed', 'possibleLosses']
    .reduce((sum, key) => sum + (handoffCoverageAudit?.[key]?.length || 0), 0)
  results.push(classifiedCount > 0 || handoffCoverageAudit?.warnings?.length
    ? auditPass(ruleById.handoff_classification, { classifiedCount, warnings: handoffCoverageAudit?.warnings?.length || 0 })
    : auditFail(ruleById.handoff_classification, 'No handoff content was classified.'))

  const truncated = /\.\.\.|…/.test(compiledText(compiledPlan))
  results.push(truncated
    ? auditFail(ruleById.no_truncated_strategy_text, 'Compiled strategy text contains truncation markers.')
    : auditPass(ruleById.no_truncated_strategy_text))

  const repeats = repeatedCompiledTextItems(compiledPlan)
  results.push(repeats.length
    ? auditFail(ruleById.reduce_repetition, 'Repeated content appears across compiled strategy sections.', { repeats })
    : auditPass(ruleById.reduce_repetition))

  // Field-distinctness check — new rule
  if (ruleById.field_distinctness) {
    const fieldViolations = validateStage3CompiledFieldDistinctness(compiledPlan)
    results.push(fieldViolations.length
      ? auditFail(ruleById.field_distinctness, 'One or more compiled plan items have duplicate text across fields that should serve distinct roles.', { violations: fieldViolations })
      : auditPass(ruleById.field_distinctness))
  }

  return {
    rules,
    results,
    violations: results.filter(r => r.status === 'fail'),
    passedCount: results.filter(r => r.status === 'pass').length,
    failedCount: results.filter(r => r.status === 'fail').length,
  }
}
