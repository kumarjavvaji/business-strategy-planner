export const DEFAULT_SPEC_QUALITY_POLICY = {
  policyId: 'stage4_artifact_spec_quality_policy_v1',
  checks: [
    'no_truncation_markers',
    'no_incomplete_sentence_endings',
    'no_repeated_paragraph_blocks',
    'no_copied_stage3_prose_except_labeled_source_refs',
    'every_generated_section_maps_to_source_atoms',
    'every_section_adds_distinct_artifact_value',
    'audience_appropriate',
    'sme_reviewable',
    'actionable_not_generic_filler',
    'required_sections_present',
    'missing_prerequisites_block_generation',
  ],
}

const COMMON_OUTPUT_RULES = [
  'Use accepted Stage 3 source atoms and mapped how-options only.',
  'Do not paste Stage 3 prose except short labeled source references.',
  'Generate bounded artifact atoms, not full-document prose blocks.',
  'Name owners, gates, evidence, decisions, risks, and review anchors where available.',
  'Avoid generic consulting filler and repeated payload across sibling atoms.',
]

const COMMON_REMEDIATION_RULES = [
  'If source mapping is missing, block generation and route back to Stage 3 mapping.',
  'If an atom fails parsing or truncation checks, preserve raw output and retry only that atom.',
  'If copied source prose is detected, regenerate the affected atom with transform-not-copy instruction.',
]

const COMMON_REQUIRED_PANELS = ['strategicObjective', 'executionSequence']

function spec({
  artifactType,
  artifactTitle,
  artifactScope = 'bu',
  audience,
  purpose,
  requiredSourcePanels = COMMON_REQUIRED_PANELS,
  requiredSourceAtoms = ['mapped_how_options', 'accepted_source_atoms'],
  sectionSchema,
  sectionChildUnitSchema,
  smeLens,
  acceptanceChecks,
}) {
  return {
    artifactType,
    artifactTitle,
    artifactScope,
    audience,
    purpose,
    requiredSourcePanels,
    requiredSourceAtoms,
    sectionSchema,
    sectionChildUnitSchema,
    smeLens,
    outputRules: COMMON_OUTPUT_RULES,
    qualityPolicy: DEFAULT_SPEC_QUALITY_POLICY,
    acceptanceChecks,
    remediationRules: COMMON_REMEDIATION_RULES,
  }
}

const BU_EXECUTION_PLAN_SECTIONS = [
  {
    id: 'strategic_context',
    heading: 'Strategic Context',
    purpose: 'BU role in overall delivery and how it connects to the organisation strategy.',
    generationMode: 'child_units',
    staticAtoms: [
      { atomId: 'bu_role', atomType: 'context', label: 'BU Role', inputBasis: 'What does this BU own, produce, and contribute to the strategic outcome?' },
      { atomId: 'strategic_alignment', atomType: 'context', label: 'Strategic Alignment', inputBasis: 'How do mapped execution tactics advance the strategic thesis and named outcomes?' },
      { atomId: 'delivery_dependencies', atomType: 'context', label: 'Key Delivery Dependencies', inputBasis: 'Which dependencies must be resolved before or during execution, and who provides them?' },
    ],
  },
  { id: 'execution_workstreams', heading: 'Execution Workstreams', purpose: 'Key workstreams, activities, and suggested owners per mapped execution tactic.', generationMode: 'child_units', childSource: 'selectedExecutionTactics', atomType: 'workstream_item' },
  { id: 'gate_criteria', heading: 'Gate Criteria', purpose: 'What must be true at each delivery gate before proceeding, per mapped execution tactic.', generationMode: 'child_units', childSource: 'selectedExecutionTactics', atomType: 'gate_item' },
  { id: 'dependency_map', heading: 'Dependency Map', purpose: 'Internal and cross-BU dependencies that must be resolved during delivery.', generationMode: 'child_units', childSource: 'relevantDependencies', atomType: 'dependency_item' },
  { id: 'risk_controls', heading: 'Risk Controls', purpose: 'Specific controls for identified execution risks, with owner and trigger.', generationMode: 'child_units', childSource: 'relevantRisks', atomType: 'risk_item' },
  { id: 'validation_approach', heading: 'Validation Approach', purpose: 'How readiness and delivery quality will be confirmed at each phase.', generationMode: 'child_units', childSource: 'relevantValidationQuestions', atomType: 'validation_item' },
]

const PDLC_EPIC_OUTLINE_SECTIONS = [
  {
    id: 'epic_framing',
    heading: 'Epic Framing',
    purpose: 'Translate the accepted BU thesis and mapped tactics into the product delivery problem statement.',
    generationMode: 'child_units',
    staticAtoms: [
      { atomId: 'delivery_intent', atomType: 'pdlc_context', label: 'Delivery Intent', inputBasis: 'State the product delivery intent, accountable BU context, and source evidence that constrains this epic outline.' },
      { atomId: 'source_traceability', atomType: 'traceability', label: 'Source Traceability', inputBasis: 'Name the mapped execution tactics, source panels, and evidence anchors used to derive the epic outline.' },
    ],
  },
  { id: 'epic_candidates', heading: 'Epic Candidates', purpose: 'Candidate implementation epics derived one-for-one from mapped execution tactics.', generationMode: 'child_units', childSource: 'selectedExecutionTactics', atomType: 'pdlc_epic_item' },
  { id: 'scope_boundaries', heading: 'Scope Boundaries', purpose: 'In-scope and out-of-scope boundaries for each mapped tactic.', generationMode: 'child_units', childSource: 'selectedExecutionTactics', atomType: 'scope_boundary_item' },
  { id: 'delivery_sequence', heading: 'Delivery Sequence', purpose: 'Recommended phase/order and gate logic for delivering the epic set.', generationMode: 'child_units', childSource: 'selectedExecutionTactics', atomType: 'delivery_sequence_item' },
  { id: 'dependency_and_risk_controls', heading: 'Dependency And Risk Controls', purpose: 'Dependencies and risks that must be owned before or during epic execution.', generationMode: 'child_units', childSource: 'relevantDependencies', atomType: 'dependency_control_item' },
  { id: 'acceptance_intent', heading: 'Acceptance Intent', purpose: 'Acceptance checks and review anchors linked to validation questions.', generationMode: 'child_units', childSource: 'relevantValidationQuestions', atomType: 'acceptance_intent_item' },
]

const ACCEPTANCE_CRITERIA_SECTIONS = [
  {
    id: 'criteria_framing',
    heading: 'Criteria Framing',
    purpose: 'Define the acceptance basis, reviewers, and evidence standard for this BU.',
    generationMode: 'child_units',
    staticAtoms: [
      { atomId: 'acceptance_basis', atomType: 'acceptance_context', label: 'Acceptance Basis', inputBasis: 'Identify the source panels, mapped tactics, gates, dependencies, and risks that constrain acceptance criteria.' },
      { atomId: 'review_model', atomType: 'review_model', label: 'Review Model', inputBasis: 'Name reviewer roles, evidence owners, and decision gates for validating criteria.' },
    ],
  },
  { id: 'behavior_outcomes', heading: 'Behavior Outcomes', purpose: 'Testable expected behavior or outcome for each mapped execution tactic.', generationMode: 'child_units', childSource: 'selectedExecutionTactics', atomType: 'criterion_behavior_item' },
  { id: 'pass_evidence', heading: 'Pass Evidence', purpose: 'Evidence that proves the criterion has passed.', generationMode: 'child_units', childSource: 'relevantValidationQuestions', atomType: 'pass_evidence_item' },
  { id: 'fail_conditions', heading: 'Fail Conditions', purpose: 'Conditions that should fail acceptance or trigger remediation.', generationMode: 'child_units', childSource: 'relevantRisks', atomType: 'fail_condition_item' },
  { id: 'dependency_gate_linkage', heading: 'Dependency And Gate Linkage', purpose: 'Dependency, risk, and sequencing relevance for acceptance checks.', generationMode: 'child_units', childSource: 'relevantDependencies', atomType: 'acceptance_dependency_item' },
]

const GOVERNANCE_CHECKLIST_SECTIONS = [
  {
    id: 'checklist_framing',
    heading: 'Checklist Framing',
    purpose: 'Define the governance purpose, accountable reviewers, and evidence standard.',
    generationMode: 'child_units',
    staticAtoms: [
      { atomId: 'governance_intent', atomType: 'governance_context', label: 'Governance Intent', inputBasis: 'State why this implementation governance checklist is needed and what delivery risk it controls.' },
      { atomId: 'reviewer_model', atomType: 'reviewer_model', label: 'Reviewer Model', inputBasis: 'Name accountable reviewer roles, escalation owners, and timing gates.' },
    ],
  },
  { id: 'decision_checklist', heading: 'Decision Checklist', purpose: 'Checklist items derived from governance decisions and delivery gates.', generationMode: 'child_units', childSource: 'relevantDecisions', atomType: 'governance_decision_item' },
  { id: 'dependency_prerequisites', heading: 'Dependency Prerequisites', purpose: 'Prerequisite source/evidence required before implementation may proceed.', generationMode: 'child_units', childSource: 'relevantDependencies', atomType: 'governance_dependency_item' },
  { id: 'risk_escalation_triggers', heading: 'Risk Escalation Triggers', purpose: 'Escalation triggers and pass/fail conditions linked to implementation risks.', generationMode: 'child_units', childSource: 'relevantRisks', atomType: 'governance_risk_item' },
  { id: 'validation_gates', heading: 'Validation Gates', purpose: 'Timing/gate checks and evidence required to pass implementation review.', generationMode: 'child_units', childSource: 'relevantValidationQuestions', atomType: 'governance_validation_item' },
]

const EXEC_BRIEF_SECTIONS = [
  { id: 'executive_summary', heading: 'Executive Summary', purpose: 'Overall execution readiness, open blockers, and leadership actions required.', generationMode: 'child_units', staticAtoms: [
    { atomId: 'decision_context', atomType: 'context', label: 'Decision Context', inputBasis: 'What has been decided, what remains open, and why this brief is needed now?' },
    { atomId: 'current_readiness', atomType: 'readiness', label: 'Current Readiness', inputBasis: 'Which BUs are ready or partial, and what does that imply for launch sequencing?' },
    { atomId: 'unresolved_blockers', atomType: 'blocker', label: 'Unresolved Blockers', inputBasis: 'What cross-BU or executive-level blockers remain unresolved?' },
    { atomId: 'leadership_actions', atomType: 'action', label: 'Leadership Actions Required', inputBasis: 'What leadership decisions or commitments are required before delivery planning proceeds?' },
  ] },
  { id: 'key_decisions_required', heading: 'Key Decisions Required', purpose: 'Specific decisions needed before or during delivery.', generationMode: 'child_units', childSource: 'relevantDecisions', atomType: 'decision_item' },
  { id: 'cross_bu_commitments', heading: 'Cross-BU Commitments', purpose: 'Shared commitments and sequencing dependencies across BUs.', generationMode: 'child_units', childSource: 'relevantDependencies', atomType: 'dependency_item' },
  { id: 'governance_requirements', heading: 'Governance Requirements', purpose: 'Sign-off requirements, review gates, and escalation paths per delivery tactic.', generationMode: 'child_units', childSource: 'selectedExecutionTactics', atomType: 'governance_item' },
  { id: 'risk_summary', heading: 'Risk Summary', purpose: 'Top cross-cutting risks with owner and mitigation note per risk.', generationMode: 'child_units', childSource: 'relevantRisks', atomType: 'risk_item' },
  { id: 'recommended_next_steps', heading: 'Recommended Next Steps', purpose: 'Immediate actions before generation of BU-specific delivery plans.', generationMode: 'child_units', staticAtoms: [
    { atomId: 'immediate_decisions', atomType: 'next_step', label: 'Immediate Decisions', inputBasis: 'What specific decisions must be made before any BU delivery plan can launch?' },
    { atomId: 'governance_setup', atomType: 'next_step', label: 'Governance Setup', inputBasis: 'What governance structures, review gates, and escalation paths must be established?' },
  ] },
]

const SME_REVIEW_SECTIONS = [
  { id: 'review_scope', heading: 'Review Scope', purpose: 'What the SME is being asked to assess.', generationMode: 'child_units', staticAtoms: [
    { atomId: 'scope_deliverables', atomType: 'scope', label: 'Deliverables in Scope', inputBasis: 'What mapped execution tactics and deliverables should the SME review?' },
    { atomId: 'scope_expertise', atomType: 'scope', label: 'Required Expertise', inputBasis: 'What domain, technical, or operational expertise is required?' },
  ] },
  { id: 'knowledge_gaps', heading: 'Knowledge Gaps', purpose: 'Plan gaps that require specialist input to resolve.', generationMode: 'child_units', childSource: 'relevantValidationQuestions', atomType: 'gap_item' },
  { id: 'specialist_questions', heading: 'Specialist Questions', purpose: 'Specific questions for domain experts.', generationMode: 'child_units', childSource: 'relevantValidationQuestions', atomType: 'question_item' },
  { id: 'domain_risks', heading: 'Domain-Specific Risks', purpose: 'Risks that require expert judgement.', generationMode: 'child_units', childSource: 'relevantRisks', atomType: 'risk_item' },
  { id: 'recommended_experts', heading: 'Recommended Expert Profiles', purpose: 'Profile descriptions of specialists who should review this plan.', generationMode: 'child_units', staticAtoms: [
    { atomId: 'domain_expert', atomType: 'expert_profile', label: 'Domain Expert', inputBasis: 'What domain-specific expertise profile is required?' },
    { atomId: 'delivery_expert', atomType: 'expert_profile', label: 'Delivery Expert', inputBasis: 'What delivery and execution expertise profile is required?' },
  ] },
]

const GLOBAL_SME_REVIEW_SECTIONS = [
  { id: 'cross_bu_scope', heading: 'Cross-BU Review Scope', purpose: 'What the review covers and which BUs are in scope.', generationMode: 'child_units', staticAtoms: [
    { atomId: 'scope_coverage', atomType: 'scope', label: 'BU Coverage', inputBasis: 'Which BUs, delivery workstreams, and shared capabilities are included?' },
    { atomId: 'scope_boundaries', atomType: 'scope', label: 'Review Boundaries', inputBasis: 'What is explicitly out of scope for this review?' },
  ] },
  { id: 'capability_gaps', heading: 'Capability Gaps', purpose: 'Cross-cutting gaps that appear across multiple BU plans.', generationMode: 'child_units', childSource: 'relevantValidationQuestions', atomType: 'gap_item' },
  { id: 'critical_specialist_questions', heading: 'Critical Specialist Questions', purpose: 'Questions that must be resolved before delivery commitments are finalised.', generationMode: 'child_units', childSource: 'relevantValidationQuestions', atomType: 'question_item' },
  { id: 'systemic_risks', heading: 'Systemic Risks', purpose: 'Risks that span BUs and cannot be owned by any single team.', generationMode: 'child_units', childSource: 'relevantRisks', atomType: 'risk_item' },
  { id: 'review_structure', heading: 'Recommended Review Structure', purpose: 'How SME review should be organised across BUs and workstreams.', generationMode: 'child_units', staticAtoms: [
    { atomId: 'review_phases', atomType: 'review_structure', label: 'Review Phases', inputBasis: 'What phases should the organisation-wide SME review use?' },
    { atomId: 'review_outputs', atomType: 'review_structure', label: 'Review Outputs', inputBasis: 'What outputs and decisions should each review phase produce?' },
  ] },
]

export const ARTIFACT_SPECS = [
  spec({
    artifactType: 'bu_execution_plan',
    artifactTitle: 'BU Execution Plan',
    audience: 'BU delivery owners and accountable reviewers',
    purpose: 'Produces execution structure, not a Stage 3 summary.',
    sectionSchema: BU_EXECUTION_PLAN_SECTIONS,
    sectionChildUnitSchema: ['workstream', 'owner/accountable role', 'sequence/gate', 'dependencies', 'risks/mitigations', 'validation checks', 'evidence needed', 'escalation trigger'],
    smeLens: 'Delivery lead and implementation reviewer can verify owners, gates, evidence, risks, and escalation triggers.',
    acceptanceChecks: ['workstream', 'owner/accountable role', 'sequence/gate', 'dependencies', 'risks/mitigations', 'validation checks', 'evidence needed', 'escalation trigger'],
  }),
  spec({
    artifactType: 'bu_execution_plan_partial',
    artifactTitle: 'BU Execution Plan (Partial)',
    audience: 'BU delivery owners and accountable reviewers',
    purpose: 'Produces partial execution structure with incomplete areas clearly marked.',
    sectionSchema: BU_EXECUTION_PLAN_SECTIONS,
    sectionChildUnitSchema: ['workstream', 'owner/accountable role', 'sequence/gate', 'dependencies', 'risks/mitigations', 'validation checks', 'evidence needed', 'escalation trigger'],
    smeLens: 'Reviewer can identify what is usable now and what must return to Stage 3.',
    acceptanceChecks: ['partial scope is labeled', 'available workstreams are grounded', 'gaps are explicit'],
  }),
  spec({
    artifactType: 'pdlc_epic_outline',
    artifactTitle: 'PDLC Epic Outline',
    audience: 'Product, engineering, architecture, and delivery reviewers',
    purpose: 'Produces epic-level delivery structure, not generic product prose.',
    sectionSchema: PDLC_EPIC_OUTLINE_SECTIONS,
    sectionChildUnitSchema: ['epic name', 'problem/outcome', 'scope', 'out-of-scope', 'source basis', 'acceptance intent', 'dependency/risk linkage', 'sequencing', 'governance or non-functional constraints'],
    smeLens: 'Product and engineering reviewers can verify scope, acceptance intent, dependencies, sequencing, and constraints.',
    acceptanceChecks: ['epic name', 'problem/outcome', 'scope', 'out-of-scope', 'source basis', 'acceptance intent', 'dependency/risk linkage', 'sequencing'],
  }),
  spec({
    artifactType: 'acceptance_criteria_draft',
    artifactTitle: 'Acceptance Criteria Draft',
    audience: 'Product owners, QA/review leads, delivery owners, and SMEs',
    purpose: 'Produces testable acceptance criteria from execution sections, validation checks, dependencies, risks, and gates.',
    sectionSchema: ACCEPTANCE_CRITERIA_SECTIONS,
    sectionChildUnitSchema: ['criterion title', 'source basis', 'expected behavior/outcome', 'pass evidence', 'fail condition', 'owner/reviewer role', 'dependency/risk linkage', 'gate/sequencing relevance'],
    smeLens: 'Reviewer can test each criterion against evidence, pass/fail conditions, and source traceability.',
    acceptanceChecks: ['criterion title', 'source basis', 'expected behavior/outcome', 'pass evidence', 'fail condition', 'owner/reviewer role', 'dependency/risk linkage', 'gate/sequencing relevance'],
  }),
  spec({
    artifactType: 'implementation_governance_checklist',
    artifactTitle: 'Implementation Governance Checklist',
    audience: 'Implementation governance leads, risk owners, and delivery reviewers',
    purpose: 'Produces implementation review checklist items from governance decisions, dependencies, risks, validation checks, and gates.',
    sectionSchema: GOVERNANCE_CHECKLIST_SECTIONS,
    sectionChildUnitSchema: ['checklist item', 'governance purpose', 'accountable reviewer', 'prerequisite source', 'evidence required', 'pass/fail condition', 'escalation trigger', 'timing/gate'],
    smeLens: 'Reviewer can confirm accountable roles, prerequisite evidence, pass/fail criteria, escalation triggers, and gate timing.',
    acceptanceChecks: ['checklist item', 'governance purpose', 'accountable reviewer', 'prerequisite source', 'evidence required', 'pass/fail condition', 'escalation trigger', 'timing/gate'],
  }),
  spec({
    artifactType: 'executive_decision_brief',
    artifactTitle: 'Executive Decision Brief',
    artifactScope: 'global',
    audience: 'Executive and cross-functional delivery leadership',
    purpose: 'Synthesizes cross-BU commitments, decisions, and governance sign-offs.',
    requiredSourcePanels: COMMON_REQUIRED_PANELS,
    sectionSchema: EXEC_BRIEF_SECTIONS,
    sectionChildUnitSchema: ['decision', 'commitment', 'risk', 'governance requirement', 'leadership action'],
    smeLens: 'Executive reviewer can identify decisions, commitments, owners, and unblock actions.',
    acceptanceChecks: ['decisions are named', 'commitments are grounded', 'leadership actions are explicit'],
  }),
  spec({
    artifactType: 'bu_sme_review_packet',
    artifactTitle: 'SME Review Packet',
    audience: 'BU SMEs and specialist reviewers',
    purpose: 'Packages BU execution scope for specialist review.',
    sectionSchema: SME_REVIEW_SECTIONS,
    sectionChildUnitSchema: ['review scope', 'knowledge gap', 'specialist question', 'domain risk'],
    smeLens: 'SME can see review scope, expertise needed, unresolved questions, and risks.',
    acceptanceChecks: ['scope is bounded', 'questions are answerable by an SME', 'risks are source-linked'],
  }),
  spec({
    artifactType: 'global_sme_review_packet',
    artifactTitle: 'SME Review Packet',
    artifactScope: 'global',
    audience: 'Cross-BU SMEs and specialist reviewers',
    purpose: 'Packages cross-BU execution scope for specialist review.',
    sectionSchema: GLOBAL_SME_REVIEW_SECTIONS,
    sectionChildUnitSchema: ['review scope', 'knowledge gap', 'specialist question', 'systemic risk'],
    smeLens: 'SME can identify cross-BU review scope, shared risks, and unresolved specialist questions.',
    acceptanceChecks: ['cross-BU scope is explicit', 'questions are source-linked', 'systemic risks are reviewable'],
  }),
]

const SPEC_BY_TYPE = new Map(ARTIFACT_SPECS.map(item => [item.artifactType, item]))

export const SUPPORTED_ARTIFACT_SPEC_TYPES = new Set(SPEC_BY_TYPE.keys())

export function resolveArtifactSpec(artifactType) {
  return SPEC_BY_TYPE.get(artifactType) || null
}

export function getArtifactSectionSchema(artifactType) {
  return resolveArtifactSpec(artifactType)?.sectionSchema || null
}
