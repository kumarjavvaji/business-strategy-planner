/**
 * Stage 4 artifact prompt builders and response parser.
 *
 * Each builder returns { messages } in Anthropic format.
 * The parser converts the raw model response into contentSections + metadata.
 *
 * Supported artifact types (first version):
 *   executive_decision_brief
 *   bu_execution_plan / bu_execution_plan_partial
 *   bu_sme_review_packet / global_sme_review_packet
 *
 * For unsupported types the caller receives { isSupported: false }.
 * Unsupported types must not cause page errors — they just skip generation.
 *
 * Source invariant: builders read only from the durable handoff and artifact
 * item passed by the caller. No React state or rendered UI text is used.
 */

import { BU_HANDOFF_STATUS } from './stage4Handoff'
import { compileArtifactBasis } from './stage4ArtifactBasis'

// ── Supported types ────────────────────────────────────────────────────────────

export const SUPPORTED_GENERATION_TYPES = new Set([
  'executive_decision_brief',
  'bu_execution_plan',
  'bu_execution_plan_partial',
  'pdlc_epic_outline',
  'bu_sme_review_packet',
  'global_sme_review_packet',
])

// ── Shared response schema ─────────────────────────────────────────────────────

const RESPONSE_SCHEMA = `{
  "contentSections": [
    {
      "sectionId": "string — snake_case identifier",
      "heading": "string — section heading",
      "purpose": "string — one sentence on what this section answers",
      "body": "string — 3-6 concise sentences or a tight bullet list",
      "sourceAtomIds": [],
      "openQuestions": ["string"],
      "confidenceLevel": "high | medium | low"
    }
  ],
  "evidenceBasis": "string — 1-2 sentences on what data this was derived from",
  "assumptions": ["string"],
  "openQuestions": ["string"]
}`

const SECTION_RESPONSE_SCHEMA = `{
  "sectionId": "string - must match requested section id",
  "heading": "string - section heading",
  "purpose": "string - one sentence on what this section answers",
  "body": "string - concise, action-oriented section content",
  "sourceAtomIds": ["string"],
  "openQuestions": ["string"],
  "confidenceLevel": "high | medium | low"
}`

const CHILD_RESPONSE_SCHEMA = `{
  "childId": "string - must match requested child id",
  "heading": "string - concise item heading",
  "body": "string - 2-4 concise bullets or sentences for this one item only",
  "sourceAtomIds": ["string"],
  "openQuestions": ["string"],
  "confidenceLevel": "high | medium | low"
}`

const SYSTEM_PREAMBLE = `You are a strategic delivery advisor generating structured planning artifacts from verified execution plans. Be concise and specific. Avoid generic filler. Each atom body should be 2-4 tight sentences or a short bullet list. Respond ONLY with valid JSON — no markdown fences, no prose outside the JSON. Every atom must answer: what decision, action, risk, gate, dependency, or review step does this clarify? Prefer specific owners, gates, timings, and named evidence over generalized strategy prose.`

// ── Formatting helpers ─────────────────────────────────────────────────────────

const BASIS_CONTRACT = `Use the compact artifact basis below. Transform the basis into the artifact; do not summarize it. Do not copy Stage 3 prose verbatim. Do not include unmapped tactics. Keep atoms role-distinct. Prefer concrete deliverable language over explanatory narrative. Do not restate the same basis across sibling atoms.`

function safeList(arr) {
  return (arr || []).filter(Boolean).join('; ') || '(none)'
}

function buSummary(bu) {
  const plan = bu.plan || {}
  const sections = (bu.executionSections || []).slice(0, 3)  // cap to keep prompt concise
  return [
    `BU: ${bu.buName} [${bu.status}]`,
    plan.mission         ? `Mission: ${plan.mission}`               : null,
    plan.strategicRole   ? `Strategic role: ${plan.strategicRole}`  : null,
    plan.priorityOutcomes?.length ? `Priority outcomes: ${safeList(plan.priorityOutcomes)}` : null,
    sections.length ? `Execution sections:\n${sections.map(s =>
      `  • ${s.sectionName}: ${s.objective || ''}${s.decisionsRequired?.length ? `; decisions: ${safeList(s.decisionsRequired)}` : ''}${s.dependencies?.length ? `; deps: ${safeList(s.dependencies)}` : ''}`
    ).join('\n')}` : null,
    bu.stage4DeliveryImplications?.length ? `Stage 4 implications: ${safeList(bu.stage4DeliveryImplications)}` : null,
  ].filter(Boolean).join('\n')
}

function usableBUs(handoff) {
  return (handoff.buHandoffs || []).filter(b =>
    b.status === BU_HANDOFF_STATUS.READY || b.status === BU_HANDOFF_STATUS.PARTIAL
  )
}

function basisJson(basis) {
  return JSON.stringify(basis, null, 2)
}

function sectionDefToPrompt(sectionDef) {
  return `sectionId="${sectionDef.id}" | heading="${sectionDef.heading}" | purpose="${sectionDef.purpose}"`
}

function childLabel(item, index) {
  return item?.name || item?.optionName || item?.validationQuestion || item?.summary || `Item ${index + 1}`
}

function sourceItemsForSection(sectionDef, artifactBasis) {
  return artifactBasis?.[sectionDef?.childSource] || []
}

function synthesisContextForBasis(artifactBasis) {
  return {
    artifactType:  artifactBasis.artifactType,
    artifactIntent: artifactBasis.artifactIntent,
    buName:        artifactBasis.buName,
    strategicThesis: artifactBasis.strategicThesis,
    selectedExecutionTactics: (artifactBasis.selectedExecutionTactics || []).slice(0, 4).map(t => ({
      optionName: t.optionName, phaseName: t.phaseName, whenToUse: t.whenToUse, evidenceProduced: t.evidenceProduced,
    })),
    relevantDecisions:          (artifactBasis.relevantDecisions          || []).slice(0, 4).map(d => ({ id: d.id, name: d.name, summary: d.summary, timing: d.timing })),
    relevantDependencies:       (artifactBasis.relevantDependencies       || []).slice(0, 3).map(d => ({ id: d.id, name: d.name, summary: d.summary })),
    relevantRisks:              (artifactBasis.relevantRisks              || []).slice(0, 3).map(r => ({ id: r.id, name: r.name, summary: r.summary })),
    relevantValidationQuestions:(artifactBasis.relevantValidationQuestions || []).slice(0, 3).map(v => ({ id: v.id, name: v.name, summary: v.summary })),
    counts:        artifactBasis.counts,
    basisWarnings: artifactBasis.basisWarnings || [],
  }
}

// ── Executive Decision Brief ───────────────────────────────────────────────────

const EXEC_BRIEF_SECTIONS = [
  {
    id: 'executive_summary',
    heading: 'Executive Summary',
    purpose: 'Overall execution readiness, open blockers, and leadership actions required.',
    generationMode: 'child_units',
    staticAtoms: [
      { atomId: 'decision_context',   atomType: 'context',   label: 'Decision Context',         inputBasis: 'What is the core strategic decision context requiring executive awareness — what has been decided, what remains open, and why this brief is needed now?' },
      { atomId: 'current_readiness',  atomType: 'readiness', label: 'Current Readiness',         inputBasis: 'What is the current delivery readiness level across the verified BUs — which BUs are ready, which are partial, and what the overall status implies for launch sequencing?' },
      { atomId: 'unresolved_blockers',atomType: 'blocker',   label: 'Unresolved Blockers',       inputBasis: 'What cross-BU or executive-level blockers remain unresolved that will prevent delivery from proceeding without leadership intervention?' },
      { atomId: 'leadership_actions', atomType: 'action',    label: 'Leadership Actions Required',inputBasis: 'What specific leadership decisions or formal commitments are required — with named owners where determinable — before BU-level delivery planning can proceed?' },
    ],
  },
  { id: 'key_decisions_required',  heading: 'Key Decisions Required',   purpose: 'Specific decisions needed before or during delivery, with decision owner and timing.', generationMode: 'child_units', childSource: 'relevantDecisions',          atomType: 'decision_item' },
  { id: 'cross_bu_commitments',    heading: 'Cross-BU Commitments',     purpose: 'Shared commitments and sequencing dependencies across BUs.',                             generationMode: 'child_units', childSource: 'relevantDependencies',       atomType: 'dependency_item' },
  { id: 'governance_requirements', heading: 'Governance Requirements',  purpose: 'Sign-off requirements, review gates, and escalation paths per delivery tactic.',        generationMode: 'child_units', childSource: 'selectedExecutionTactics',   atomType: 'governance_item' },
  { id: 'risk_summary',            heading: 'Risk Summary',             purpose: 'Top cross-cutting risks with owner and brief mitigation note per risk.',                 generationMode: 'child_units', childSource: 'relevantRisks',              atomType: 'risk_item' },
  {
    id: 'recommended_next_steps',
    heading: 'Recommended Next Steps',
    purpose: 'Immediate actions before generation of BU-specific delivery plans.',
    generationMode: 'child_units',
    staticAtoms: [
      { atomId: 'immediate_decisions',  atomType: 'next_step', label: 'Immediate Decisions',     inputBasis: 'What specific decisions must be made in the next 2-4 weeks — with named decision owners — before any BU delivery plan can launch?' },
      { atomId: 'resourcing_actions',   atomType: 'next_step', label: 'Resourcing Actions',       inputBasis: 'What resource commitments, ownership confirmations, or team structures must be formally established before delivery commences?' },
      { atomId: 'governance_setup',     atomType: 'next_step', label: 'Governance Setup',         inputBasis: 'What governance structures, review gates, and escalation paths must be established — with accountable owners — before delivery commences?' },
      { atomId: 'sequencing_alignment', atomType: 'next_step', label: 'Sequencing Alignment',     inputBasis: 'What cross-BU sequencing and dependency alignment must be completed — naming the dependency and the BUs involved — before individual BU plans proceed?' },
    ],
  },
]

function buildExecutiveDecisionBriefMessages(artifactItem, handoff) {
  const bus = usableBUs(handoff)
  const buText = bus.map(buSummary).join('\n\n')
  const artifactBasis = compileArtifactBasis(artifactItem, handoff)

  const userContent = `${SYSTEM_PREAMBLE}

TASK: Generate an Executive Decision Brief from the Stage 3 execution plans below.

${BASIS_CONTRACT}

ARTIFACT TYPE: ${artifactBasis.artifactType}
ARTIFACT INTENT: ${artifactBasis.artifactIntent}

COMPACT ARTIFACT BASIS:
${basisJson(artifactBasis)}

VERIFIED BU EXECUTION PLANS (${bus.length} BUs):
${buText ? '(legacy handoff summary retained only for BU names/status; do not mine it for unmapped tactics)' : '(none)'}

Generate exactly these sections in this order:
${EXEC_BRIEF_SECTIONS.map((s, i) => `${i + 1}. sectionId="${s.id}" | heading="${s.heading}" | ${s.purpose}`).join('\n')}

RESPONSE SCHEMA:
${RESPONSE_SCHEMA}`

  return { messages: [{ role: 'user', content: userContent }], artifactBasis }
}

// ── BU Execution Plan ──────────────────────────────────────────────────────────

const BU_PLAN_SECTIONS = [
  {
    id: 'strategic_context',
    heading: 'Strategic Context',
    purpose: 'BU role in overall delivery and how it connects to the organisation strategy.',
    generationMode: 'child_units',
    staticAtoms: [
      { atomId: 'bu_role',               atomType: 'context', label: 'BU Role',                   inputBasis: 'What is this BU\'s specific role in the delivery programme — what does it own, what does it produce, and how does it contribute to the strategic outcome?' },
      { atomId: 'strategic_alignment',   atomType: 'context', label: 'Strategic Alignment',        inputBasis: 'How does this BU\'s mapped execution plan advance the organisation\'s strategic thesis — naming specific tactics and the outcomes they produce?' },
      { atomId: 'delivery_dependencies', atomType: 'context', label: 'Key Delivery Dependencies',  inputBasis: 'What critical external and cross-BU dependencies must be resolved before or during this BU\'s execution — naming the dependency and the providing party?' },
    ],
  },
  { id: 'execution_workstreams', heading: 'Execution Workstreams', purpose: 'Key workstreams, activities, and suggested owners per mapped execution tactic.',        generationMode: 'child_units', childSource: 'selectedExecutionTactics', atomType: 'workstream_item' },
  { id: 'gate_criteria',         heading: 'Gate Criteria',         purpose: 'What must be true at each delivery gate before proceeding, per mapped execution tactic.',  generationMode: 'child_units', childSource: 'selectedExecutionTactics', atomType: 'gate_item' },
  { id: 'dependency_map',        heading: 'Dependency Map',        purpose: 'Internal and cross-BU dependencies that must be resolved during delivery.',                generationMode: 'child_units', childSource: 'relevantDependencies',      atomType: 'dependency_item' },
  { id: 'risk_controls',         heading: 'Risk Controls',         purpose: 'Specific controls for the identified execution risks, with owner and trigger.',             generationMode: 'child_units', childSource: 'relevantRisks',             atomType: 'risk_item' },
  { id: 'validation_approach',   heading: 'Validation Approach',   purpose: 'How readiness and delivery quality will be confirmed at each phase.',                       generationMode: 'child_units', childSource: 'relevantValidationQuestions', atomType: 'validation_item' },
]

// Stage 4 registers this single BU-scoped engineering artifact so persisted
// artifact jobs can execute without falling through to unsupported generation.
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
  { id: 'scope_boundaries', heading: 'Scope Boundaries', purpose: 'Explicit in-scope and out-of-scope boundaries for each mapped tactic.', generationMode: 'child_units', childSource: 'selectedExecutionTactics', atomType: 'scope_boundary_item' },
  { id: 'delivery_sequence', heading: 'Delivery Sequence', purpose: 'Recommended phase/order and gate logic for delivering the epic set.', generationMode: 'child_units', childSource: 'selectedExecutionTactics', atomType: 'delivery_sequence_item' },
  { id: 'dependency_and_risk_controls', heading: 'Dependency And Risk Controls', purpose: 'Dependencies and risks that must be owned before or during epic execution.', generationMode: 'child_units', childSource: 'relevantDependencies', atomType: 'dependency_control_item' },
  { id: 'acceptance_intent', heading: 'Acceptance Intent', purpose: 'Acceptance checks and review anchors linked to validation questions.', generationMode: 'child_units', childSource: 'relevantValidationQuestions', atomType: 'acceptance_intent_item' },
]

function buildBuExecutionPlanMessages(artifactItem, handoff) {
  const bu = (handoff.buHandoffs || []).find(b => b.buName === artifactItem.businessUnitName)
  if (!bu) return null

  const partial = artifactItem.artifactType === 'bu_execution_plan_partial'
  const plan = bu.plan || {}
  const artifactBasis = compileArtifactBasis(artifactItem, handoff)

  const userContent = `${SYSTEM_PREAMBLE}

TASK: Generate a ${partial ? 'partial ' : ''}BU Execution Plan for "${bu.buName}".${partial ? '\nNote: the Stage 3 plan is PARTIAL. Clearly flag incomplete sections.' : ''}

${BASIS_CONTRACT}

ARTIFACT TYPE: ${artifactBasis.artifactType}
ARTIFACT INTENT: ${artifactBasis.artifactIntent}

COMPACT ARTIFACT BASIS:
${basisJson(artifactBasis)}

BU PROFILE:
Mission: ${plan.mission || '(not specified)'}
Strategic role: ${plan.strategicRole || '(not specified)'}
Priority outcomes: ${safeList(plan.priorityOutcomes)}
Critical workstreams: ${safeList(plan.criticalWorkstreams)}

EXECUTION SPINE:
Use selectedExecutionTactics from COMPACT ARTIFACT BASIS only. Do not include unmapped execution sections or tactics.

Generate exactly these sections:
${BU_PLAN_SECTIONS.map((s, i) => `${i + 1}. sectionId="${s.id}" | heading="${s.heading}" | ${s.purpose}`).join('\n')}

RESPONSE SCHEMA:
${RESPONSE_SCHEMA}`

  return { messages: [{ role: 'user', content: userContent }], artifactBasis }
}

function buildPdlcEpicOutlineMessages(artifactItem, handoff) {
  const bu = (handoff.buHandoffs || []).find(b => b.buName === artifactItem.businessUnitName)
  if (!bu) return null
  const artifactBasis = compileArtifactBasis(artifactItem, handoff)

  const userContent = `${SYSTEM_PREAMBLE}

TASK: Generate a PDLC Epic Outline for "${bu.buName}" from accepted Stage 3 source atoms.

${BASIS_CONTRACT}

ARTIFACT TYPE: ${artifactBasis.artifactType}
ARTIFACT INTENT: ${artifactBasis.artifactIntent}

COMPACT ARTIFACT BASIS:
${basisJson(artifactBasis)}

AUTHORING RULES:
- Convert mapped execution tactics into implementation-ready epic candidates.
- Include owners, gates, evidence, dependencies, risks, and acceptance checks where available.
- Do not invent unmapped epics.
- Do not paste Stage 3 prose; use short labeled source references only.

Generate exactly these sections:
${PDLC_EPIC_OUTLINE_SECTIONS.map((s, i) => `${i + 1}. sectionId="${s.id}" | heading="${s.heading}" | ${s.purpose}`).join('\n')}

RESPONSE SCHEMA:
${RESPONSE_SCHEMA}`

  return { messages: [{ role: 'user', content: userContent }], artifactBasis }
}

// ── SME Review Packet (BU-scoped) ──────────────────────────────────────────────

const BU_SME_SECTIONS = [
  {
    id: 'review_scope',
    heading: 'Review Scope',
    purpose: 'What the SME is being asked to assess.',
    generationMode: 'child_units',
    staticAtoms: [
      { atomId: 'scope_deliverables', atomType: 'scope', label: 'Deliverables in Scope',  inputBasis: 'What specific deliverables, mapped execution tactics, and plan sections is the SME being asked to review — naming each tactic and what it produces?' },
      { atomId: 'scope_evidence',     atomType: 'scope', label: 'Evidence to Review',      inputBasis: 'What evidence artefacts, validated plans, and supporting documents will the SME be given access to during the review?' },
      { atomId: 'scope_expertise',    atomType: 'scope', label: 'Required Expertise',      inputBasis: 'What specific domain expertise — regulatory, technical, or operational — is required to conduct a credible review of this BU plan and its mapped tactics?' },
    ],
  },
  { id: 'knowledge_gaps',       heading: 'Knowledge Gaps',            purpose: 'Gaps in the plan that require specialist input to resolve.',                        generationMode: 'child_units', childSource: 'relevantValidationQuestions', atomType: 'gap_item' },
  { id: 'specialist_questions', heading: 'Specialist Questions',      purpose: 'Specific questions for the domain expert, each requiring expert judgement.',        generationMode: 'child_units', childSource: 'relevantValidationQuestions', atomType: 'question_item' },
  { id: 'domain_risks',         heading: 'Domain-Specific Risks',     purpose: 'Risks that require expert judgement, not general project oversight.',                generationMode: 'child_units', childSource: 'relevantRisks',              atomType: 'risk_item' },
  {
    id: 'recommended_experts',
    heading: 'Recommended Expert Profiles',
    purpose: 'Profile descriptions of the specialists who should review this plan.',
    generationMode: 'child_units',
    staticAtoms: [
      { atomId: 'domain_expert',      atomType: 'expert_profile', label: 'Domain Expert',       inputBasis: 'What domain-specific expertise profile — regulatory, technical, or industry — is required to review the mapped execution tactics and their evidence basis?' },
      { atomId: 'delivery_expert',    atomType: 'expert_profile', label: 'Delivery Expert',      inputBasis: 'What delivery and execution expertise profile is required to assess the BU plan\'s feasibility, gate criteria, and delivery sequencing?' },
      { atomId: 'review_coordinator', atomType: 'expert_profile', label: 'Review Coordinator',   inputBasis: 'Who should coordinate the SME review process — what skills and authority do they need to drive the review to a documented conclusion with clear outputs?' },
    ],
  },
]

function buildBuSmeReviewMessages(artifactItem, handoff) {
  const bu = (handoff.buHandoffs || []).find(b => b.buName === artifactItem.businessUnitName)
  if (!bu) return null
  const plan = bu.plan || {}
  const artifactBasis = compileArtifactBasis(artifactItem, handoff)

  const userContent = `${SYSTEM_PREAMBLE}

TASK: Generate a SME Review Packet for "${bu.buName}" to prepare specialist review before delivery commences.

${BASIS_CONTRACT}

ARTIFACT TYPE: ${artifactBasis.artifactType}
ARTIFACT INTENT: ${artifactBasis.artifactIntent}

COMPACT ARTIFACT BASIS:
${basisJson(artifactBasis)}

BU PROFILE:
Mission: ${plan.mission || '(not specified)'}
Strategic role: ${plan.strategicRole || '(not specified)'}
Priority outcomes: ${safeList(plan.priorityOutcomes)}

REVIEW BASIS:
Use mapped tactics, evidence gaps, risks, validation questions, and decisions from COMPACT ARTIFACT BASIS only.

Generate exactly these sections:
${BU_SME_SECTIONS.map((s, i) => `${i + 1}. sectionId="${s.id}" | heading="${s.heading}" | ${s.purpose}`).join('\n')}

RESPONSE SCHEMA:
${RESPONSE_SCHEMA}`

  return { messages: [{ role: 'user', content: userContent }], artifactBasis }
}

// ── SME Review Packet (global) ─────────────────────────────────────────────────

const GLOBAL_SME_SECTIONS = [
  {
    id: 'cross_bu_scope',
    heading: 'Cross-BU Review Scope',
    purpose: 'What the review covers and which BUs are in scope.',
    generationMode: 'child_units',
    staticAtoms: [
      { atomId: 'scope_coverage',   atomType: 'scope', label: 'BU Coverage',       inputBasis: 'Which specific BUs, delivery workstreams, and shared capabilities are included in this organisation-wide SME review, and what does each contribute to the shared delivery programme?' },
      { atomId: 'scope_boundaries', atomType: 'scope', label: 'Review Boundaries', inputBasis: 'What is explicitly out of scope for this review, and what should be deferred to BU-level specialist review or post-delivery retrospective?' },
      { atomId: 'review_triggers',  atomType: 'scope', label: 'Review Triggers',   inputBasis: 'What specific capability gaps, systemic risks, or delivery conditions triggered the requirement for an organisation-wide SME review rather than BU-scoped reviews?' },
    ],
  },
  { id: 'capability_gaps',               heading: 'Capability Gaps',               purpose: 'Cross-cutting gaps that appear across multiple BU plans, each requiring specialist input.',                 generationMode: 'child_units', childSource: 'relevantValidationQuestions', atomType: 'gap_item' },
  { id: 'critical_specialist_questions', heading: 'Critical Specialist Questions', purpose: 'Questions that must be resolved before delivery commitments are finalised, one per question cluster.', generationMode: 'child_units', childSource: 'relevantValidationQuestions', atomType: 'question_item' },
  { id: 'systemic_risks',                heading: 'Systemic Risks',                purpose: 'Risks that span BUs and cannot be owned by any single team, one per risk.',                                generationMode: 'child_units', childSource: 'relevantRisks',              atomType: 'risk_item' },
  {
    id: 'review_structure',
    heading: 'Recommended Review Structure',
    purpose: 'How the SME review should be organised across BUs and workstreams.',
    generationMode: 'child_units',
    staticAtoms: [
      { atomId: 'review_phases',      atomType: 'review_structure', label: 'Review Phases',       inputBasis: 'What are the recommended phases or stages for conducting the organisation-wide SME review — naming each phase, its focus, and its expected output?' },
      { atomId: 'review_participants',atomType: 'review_structure', label: 'Review Participants',  inputBasis: 'Who should participate at each review stage — naming the roles of BU leads, SMEs, and executives and what each is expected to contribute or decide?' },
      { atomId: 'review_outputs',     atomType: 'review_structure', label: 'Review Outputs',       inputBasis: 'What specific outputs, documented decisions, and sign-off artefacts should each review phase produce before the next phase can begin?' },
    ],
  },
]

function buildGlobalSmeReviewMessages(artifactItem, handoff) {
  const bus = usableBUs(handoff)
  const artifactBasis = compileArtifactBasis(artifactItem, handoff)

  const userContent = `${SYSTEM_PREAMBLE}

TASK: Generate an organisation-wide SME Review Packet covering all verified BU execution plans.

${BASIS_CONTRACT}

ARTIFACT TYPE: ${artifactBasis.artifactType}
ARTIFACT INTENT: ${artifactBasis.artifactIntent}

COMPACT ARTIFACT BASIS:
${basisJson(artifactBasis)}

VERIFIED BUs (${bus.length}):
${bus.map(b => `${b.buName} [${b.status}]`).join('\n')}

Generate exactly these sections:
${GLOBAL_SME_SECTIONS.map((s, i) => `${i + 1}. sectionId="${s.id}" | heading="${s.heading}" | ${s.purpose}`).join('\n')}

RESPONSE SCHEMA:
${RESPONSE_SCHEMA}`

  return { messages: [{ role: 'user', content: userContent }], artifactBasis }
}

// ── Public prompt builder ──────────────────────────────────────────────────────

/**
 * Returns { messages, isSupported } for the given artifact type.
 * When isSupported is false the caller must not call the AI and should
 * surface a "not yet implemented" message instead.
 */
export function buildArtifactPrompt(artifactItem, handoff) {
  if (!SUPPORTED_GENERATION_TYPES.has(artifactItem.artifactType)) {
    return { messages: null, isSupported: false }
  }

  let result = null
  switch (artifactItem.artifactType) {
    case 'executive_decision_brief':
      result = buildExecutiveDecisionBriefMessages(artifactItem, handoff)
      break
    case 'bu_execution_plan':
    case 'bu_execution_plan_partial':
      result = buildBuExecutionPlanMessages(artifactItem, handoff)
      break
    case 'pdlc_epic_outline':
      result = buildPdlcEpicOutlineMessages(artifactItem, handoff)
      break
    case 'bu_sme_review_packet':
      result = buildBuSmeReviewMessages(artifactItem, handoff)
      break
    case 'global_sme_review_packet':
      result = buildGlobalSmeReviewMessages(artifactItem, handoff)
      break
  }

  if (!result) return { messages: null, isSupported: false }
  return { ...result, isSupported: true }
}

export function getArtifactSectionOutline(artifactType) {
  switch (artifactType) {
    case 'executive_decision_brief':
      return EXEC_BRIEF_SECTIONS
    case 'bu_execution_plan':
    case 'bu_execution_plan_partial':
      return BU_PLAN_SECTIONS
    case 'pdlc_epic_outline':
      return PDLC_EPIC_OUTLINE_SECTIONS
    case 'bu_sme_review_packet':
      return BU_SME_SECTIONS
    case 'global_sme_review_packet':
      return GLOBAL_SME_SECTIONS
    default:
      return null
  }
}

export function resolveArtifactGenerator(artifactType) {
  if (!SUPPORTED_GENERATION_TYPES.has(artifactType)) return null
  return {
    artifactType,
    executionMode: 'atomic_section_child_units',
    getSectionOutline: () => getArtifactSectionOutline(artifactType),
    buildArtifactPrompt,
    buildSectionPrompt: buildArtifactSectionPrompt,
    buildChildPrompt: buildArtifactChildPrompt,
  }
}

export function buildArtifactSectionPrompt(artifactItem, handoff, sectionDef, artifactBasis = compileArtifactBasis(artifactItem, handoff)) {
  if (!SUPPORTED_GENERATION_TYPES.has(artifactItem.artifactType)) {
    return { messages: null, isSupported: false, artifactBasis, sectionDef: null }
  }
  if (!sectionDef?.id) {
    return { messages: null, isSupported: false, artifactBasis, sectionDef: null }
  }

  const userContent = `${SYSTEM_PREAMBLE}

TASK: Generate exactly one Stage 4 artifact section.

${BASIS_CONTRACT}

ARTIFACT TYPE: ${artifactBasis.artifactType}
ARTIFACT INTENT: ${artifactBasis.artifactIntent}

REQUESTED SECTION:
${sectionDefToPrompt(sectionDef)}

COMPACT ARTIFACT BASIS:
${basisJson(artifactBasis)}

EXPLICIT EXCLUSIONS:
- Do not include tactics absent from selectedExecutionTactics.
- Do not paste Stage 3 panel prose.
- Do not generate other sections.
- Do not add unsupported artifact types.

RESPONSE SCHEMA:
${SECTION_RESPONSE_SCHEMA}`

  return {
    messages: [{ role: 'user', content: userContent }],
    isSupported: true,
    artifactBasis,
    sectionDef,
  }
}

export function deriveSectionChildDefs(sectionDef, artifactBasis) {
  if (sectionDef?.generationMode !== 'child_units') return []

  // Static atoms: a fixed set of synthesis sub-prompts (no per-source-item mapping)
  if (sectionDef.staticAtoms?.length) {
    return sectionDef.staticAtoms.map(atom => ({
      childId:         `${sectionDef.id}:${atom.atomId}`,
      parentSectionId: sectionDef.id,
      sourceItemId:    atom.atomId,
      label:           atom.label,
      atomType:        atom.atomType,
      inputBasis:      atom.inputBasis,
      sourceAtomRefs:  (artifactBasis?.sourceTraceability?.sourceAtomIds || []).slice(0, 4),
      isStaticAtom:    true,
      sourceItem:      null,
    }))
  }

  // Source-item atoms: one atom per item in the childSource collection
  return sourceItemsForSection(sectionDef, artifactBasis).map((item, index) => ({
    childId:         `${sectionDef.id}:${item.id || item.optionId || index + 1}`,
    parentSectionId: sectionDef.id,
    sourceItemId:    item.id || item.optionId || `item_${index + 1}`,
    label:           childLabel(item, index),
    atomType:        sectionDef.atomType || 'source_item',
    inputBasis:      null,
    sourceAtomRefs:  item.id ? [item.id] : [],
    isStaticAtom:    false,
    sourceItem:      item,
  }))
}

export function buildArtifactChildPrompt(artifactItem, handoff, sectionDef, childDef, artifactBasis = compileArtifactBasis(artifactItem, handoff)) {
  if (!SUPPORTED_GENERATION_TYPES.has(artifactItem.artifactType)) {
    return { messages: null, isSupported: false, artifactBasis, sectionDef, childDef: null }
  }
  if (!sectionDef?.id || !childDef?.childId) {
    return { messages: null, isSupported: false, artifactBasis, sectionDef, childDef: null }
  }

  let userContent

  if (childDef.isStaticAtom) {
    // Static synthesis atom: no source item — answer a specific generation directive from the full basis
    const ctx = synthesisContextForBasis(artifactBasis)
    userContent = `${SYSTEM_PREAMBLE}

TASK: Generate exactly one atom for Stage 4 artifact section "${sectionDef.heading}".

${BASIS_CONTRACT}

PARENT SECTION:
${sectionDefToPrompt(sectionDef)}

ATOM TO GENERATE:
childId="${childDef.childId}" | label="${childDef.label}"
Generation directive: ${childDef.inputBasis}

ARTIFACT BASIS (compact — use to answer the directive):
${basisJson(ctx)}

EXPLICIT EXCLUSIONS:
- Answer the directive with specific named content from the basis — not generic strategy language.
- Do not generate other atoms or sections.
- Do not paste Stage 3 prose verbatim.
- Do not restate the generation directive as prose.

RESPONSE SCHEMA:
${CHILD_RESPONSE_SCHEMA}`
  } else {
    // Source-item atom: one source item only — transform it into the section's atom format
    const minimalContext = {
      artifactType:       artifactBasis.artifactType,
      artifactIntent:     artifactBasis.artifactIntent,
      buName:             artifactBasis.buName,
      strategicThesis:    artifactBasis.strategicThesis,
      sourceTraceability: artifactBasis.sourceTraceability,
    }

    userContent = `${SYSTEM_PREAMBLE}

TASK: Generate exactly one child item for a Stage 4 artifact section.

${BASIS_CONTRACT}

PARENT SECTION:
${sectionDefToPrompt(sectionDef)}

REQUESTED CHILD:
childId="${childDef.childId}" | label="${childDef.label}"

ONE SOURCE ITEM ONLY:
${basisJson(childDef.sourceItem)}

MINIMAL RELATED CONTEXT:
${basisJson(minimalContext)}

EXPLICIT EXCLUSIONS:
- Do not include any other source item.
- Do not include unmapped tactics.
- Do not paste Stage 3 prose.
- Keep this child item concise.

RESPONSE SCHEMA:
${CHILD_RESPONSE_SCHEMA}`
  }

  return {
    messages: [{ role: 'user', content: userContent }],
    isSupported: true,
    artifactBasis,
    sectionDef,
    childDef,
  }
}

// ── Response parser ────────────────────────────────────────────────────────────

/**
 * Parses the raw model response text into structured artifact output fields.
 * Returns { contentSections, evidenceBasis, assumptions, openQuestions, error }.
 */
export function parseArtifactResponse(raw) {
  if (!raw || typeof raw !== 'string') {
    return { error: 'Empty or non-string response from model.' }
  }

  let parsed
  try {
    // Strip markdown fences if the model wrapped the JSON despite the instruction
    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim()
    parsed = JSON.parse(cleaned)
  } catch {
    return { error: `Response was not valid JSON. First 200 chars: ${raw.slice(0, 200)}` }
  }

  const sections = parsed.contentSections
  if (!Array.isArray(sections) || !sections.length) {
    return { error: 'Response did not contain a contentSections array.' }
  }

  const contentSections = sections.map((s, i) => ({
    sectionId:       s.sectionId       || `section_${i}`,
    heading:         s.heading         || `Section ${i + 1}`,
    purpose:         s.purpose         || '',
    body:            s.body            || '',
    sourceAtomIds:   Array.isArray(s.sourceAtomIds) ? s.sourceAtomIds : [],
    openQuestions:   Array.isArray(s.openQuestions)  ? s.openQuestions  : [],
    confidenceLevel: ['high', 'medium', 'low'].includes(s.confidenceLevel) ? s.confidenceLevel : 'medium',
  }))

  return {
    contentSections,
    evidenceBasis: typeof parsed.evidenceBasis === 'string' ? parsed.evidenceBasis : '',
    assumptions:   Array.isArray(parsed.assumptions)   ? parsed.assumptions   : [],
    openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions : [],
    error:         null,
  }
}

function responseStopReason(response) {
  return String(response?.stop_reason || response?.stopReason || response?.finish_reason || response?.finishReason || '').toLowerCase()
}

export function parseArtifactSectionResponse(raw, sectionDef, responseMeta = {}) {
  const stopReason = responseStopReason(responseMeta)
  if (stopReason === 'max_tokens' || stopReason === 'length') {
    return { section: null, error: 'Truncated model output', failureReason: 'Truncated model output', truncated: true }
  }
  if (!raw || typeof raw !== 'string') {
    return { section: null, error: 'Empty response from model.', failureReason: 'Empty response from model.', truncated: false }
  }

  let parsed
  try {
    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim()
    parsed = JSON.parse(cleaned)
  } catch {
    return { section: null, error: `Response was not valid JSON. First 200 chars: ${raw.slice(0, 200)}`, failureReason: 'Parse failure', truncated: false }
  }

  const section = {
    sectionId:       parsed.sectionId || sectionDef?.id || '',
    heading:         parsed.heading || sectionDef?.heading || '',
    purpose:         parsed.purpose || sectionDef?.purpose || '',
    body:            parsed.body || '',
    sourceAtomIds:   Array.isArray(parsed.sourceAtomIds) ? parsed.sourceAtomIds : [],
    openQuestions:   Array.isArray(parsed.openQuestions) ? parsed.openQuestions : [],
    confidenceLevel: ['high', 'medium', 'low'].includes(parsed.confidenceLevel) ? parsed.confidenceLevel : 'medium',
  }

  const missing = []
  if (section.sectionId !== sectionDef?.id) missing.push('sectionId')
  if (!section.heading) missing.push('heading')
  if (!section.purpose) missing.push('purpose')
  if (!section.body || section.body.trim().length < 40) missing.push('body')
  if (missing.length > 0) {
    return { section: null, error: `Missing required section fields: ${missing.join(', ')}`, failureReason: `Missing required section fields: ${missing.join(', ')}`, truncated: false }
  }

  return { section, error: null, failureReason: null, truncated: false }
}

export function parseArtifactChildResponse(raw, childDef, responseMeta = {}) {
  const stopReason = responseStopReason(responseMeta)
  if (stopReason === 'max_tokens' || stopReason === 'length') {
    return { child: null, error: 'Truncated model output', failureReason: 'Truncated model output', truncated: true }
  }
  if (!raw || typeof raw !== 'string') {
    return { child: null, error: 'Empty response from model.', failureReason: 'Empty response from model.', truncated: false }
  }

  let parsed
  try {
    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim()
    parsed = JSON.parse(cleaned)
  } catch {
    return { child: null, error: `Response was not valid JSON. First 200 chars: ${raw.slice(0, 200)}`, failureReason: 'Parse failure', truncated: false }
  }

  const child = {
    childId:         parsed.childId || childDef?.childId || '',
    heading:         parsed.heading || childDef?.label || '',
    body:            parsed.body || '',
    sourceAtomIds:   Array.isArray(parsed.sourceAtomIds) ? parsed.sourceAtomIds : [],
    openQuestions:   Array.isArray(parsed.openQuestions) ? parsed.openQuestions : [],
    confidenceLevel: ['high', 'medium', 'low'].includes(parsed.confidenceLevel) ? parsed.confidenceLevel : 'medium',
  }

  const missing = []
  if (child.childId !== childDef?.childId) missing.push('childId')
  if (!child.heading) missing.push('heading')
  if (!child.body || child.body.trim().length < 25) missing.push('body')
  if (missing.length > 0) {
    return { child: null, error: `Missing required child fields: ${missing.join(', ')}`, failureReason: `Missing required child fields: ${missing.join(', ')}`, truncated: false }
  }

  return { child, error: null, failureReason: null, truncated: false }
}

// ── Mock generator (no API key required) ──────────────────────────────────────

/**
 * Returns deterministic mock artifact output for testing and mock-mode use.
 * Content is structurally valid but placeholder — clearly marked as mock.
 */
export function generateMockArtifactOutput(artifactItem, handoff, artifactBasis = compileArtifactBasis(artifactItem, handoff)) {
  const bu      = artifactItem.businessUnitName || 'organisation'
  const title   = artifactItem.title
  const bus     = usableBUs(handoff)
  const buNames = bus.map(b => b.buName).join(', ') || 'available BUs'
  const tacticNames = (artifactBasis?.selectedExecutionTactics || []).map(t => t.optionName).join(', ') || 'mapped tactics'

  const mkSection = (sectionId, heading, body) => ({
    sectionId,
    heading,
    purpose: `Mock purpose for ${heading}`,
    body,
    sourceAtomIds: artifactItem.sourceAtomIds?.slice(0, 3) || [],
    openQuestions: [`[Mock] What additional context is needed for ${heading}?`],
    confidenceLevel: 'low',
  })

  let contentSections
  switch (artifactItem.artifactType) {
    case 'executive_decision_brief':
      contentSections = [
        mkSection('executive_summary',      'Executive Summary',      `[Mock] ${bus.length} BUs are ready for Stage 4 delivery planning: ${buNames}. Overall readiness is ${handoff.overallStatus}. Mock mode — replace with AI-generated content.`),
        mkSection('key_decisions_required', 'Key Decisions Required', `[Mock] Key decisions required before delivery: resource allocation, governance ownership, and milestone sequencing. Specific decisions depend on ${buNames}.`),
        mkSection('cross_bu_commitments',   'Cross-BU Commitments',   `[Mock] Coordination commitments between ${buNames} are required. Shared milestones and dependency sequences need alignment.`),
        mkSection('governance_requirements','Governance Requirements', `[Mock] Executive sponsor sign-off required at phase gates. Review cadence to be established across ${bus.length} BUs.`),
        mkSection('risk_summary',           'Risk Summary',           `[Mock] Top risks: timeline compression, cross-BU dependency delays, resource contention. Mock — regenerate with API key for real content.`),
        mkSection('recommended_next_steps', 'Recommended Next Steps', `[Mock] 1. Confirm BU leads. 2. Schedule phase-gate reviews. 3. Generate BU-level execution plans. 4. Align on shared dependency map.`),
      ]
      break
    case 'bu_execution_plan':
    case 'bu_execution_plan_partial':
      contentSections = [
        mkSection('strategic_context',    'Strategic Context',    `[Mock] ${bu} plays a key role in the delivery programme. ${artifactItem.artifactType === 'bu_execution_plan_partial' ? 'Note: partial plan — incomplete sections are flagged.' : ''}`),
        mkSection('execution_workstreams','Execution Workstreams', `[Mock] Execution spine for ${bu}: ${tacticNames}. Owners to be confirmed.`),
        mkSection('gate_criteria',        'Gate Criteria',        `[Mock] Phase 1 gate: delivery infrastructure ready. Phase 2 gate: pilot validation complete. Phase 3 gate: production sign-off.`),
        mkSection('dependency_map',       'Dependency Map',       `[Mock] External dependencies: data infrastructure, compliance review. Cross-BU: coordination with ${buNames}.`),
        mkSection('risk_controls',        'Risk Controls',        `[Mock] Timeline risk: weekly status reviews. Dependency risk: shared tracking board. Quality risk: structured acceptance criteria.`),
        mkSection('validation_approach',  'Validation Approach',  `[Mock] Validation via observed workflow reviews, structured pilot, and sign-off against acceptance criteria.`),
      ]
      break
    case 'bu_sme_review_packet':
      contentSections = [
        mkSection('review_scope',         'Review Scope',           `[Mock] SME review covers ${bu} mapped tactics: ${tacticNames}. Focus on domain-specific risks and delivery assumptions.`),
        mkSection('knowledge_gaps',       'Knowledge Gaps',         `[Mock] Key gaps: regulatory interpretation, technical feasibility of proposed workstreams, and pilot design.`),
        mkSection('specialist_questions', 'Specialist Questions',   `[Mock] 1. Are the delivery timelines realistic? 2. Which regulatory constraints apply? 3. What validation evidence is sufficient?`),
        mkSection('domain_risks',         'Domain-Specific Risks',  `[Mock] Regulatory compliance risk, specialist availability, and domain-specific quality standards require expert review.`),
        mkSection('recommended_experts',  'Recommended Expert Profiles', `[Mock] Domain expert: regulatory background in the target domain. Delivery expert: experience with similar-scale programmes.`),
      ]
      break
    case 'global_sme_review_packet':
      contentSections = [
        mkSection('cross_bu_scope',               'Cross-BU Review Scope',         `[Mock] Review covers ${bus.length} BUs: ${buNames}. Focus on cross-cutting risks and shared capability gaps.`),
        mkSection('capability_gaps',              'Capability Gaps',                `[Mock] Identified gaps across BUs: delivery governance, shared data infrastructure, and cross-BU coordination capacity.`),
        mkSection('critical_specialist_questions','Critical Specialist Questions',  `[Mock] 1. Are cross-BU dependencies correctly sequenced? 2. Which shared risks require central governance? 3. Are timeline assumptions valid across BUs?`),
        mkSection('systemic_risks',               'Systemic Risks',                 `[Mock] Systemic risks include: coordinated timeline compression, single points of failure in shared dependencies, and governance overhead.`),
        mkSection('review_structure',             'Recommended Review Structure',   `[Mock] Phase 1: per-BU specialist review. Phase 2: cross-BU alignment workshop. Phase 3: executive sponsor sign-off.`),
      ]
      break
    default:
      contentSections = [mkSection('content', title, `[Mock] Content for ${title} (${bu}). Regenerate with an API key for real output.`)]
  }

  return {
    contentSections,
    evidenceBasis: `[Mock] Derived from ${bus.length} verified BU handoff records. Regenerate with API key for AI-generated evidence basis.`,
    assumptions:   [`[Mock] All BU plans are current`, `[Mock] Resource availability as estimated`],
    openQuestions: [`[Mock] What is the preferred delivery sequencing?`, `[Mock] Who owns cross-BU governance?`],
  }
}

export function generateMockArtifactSectionOutput(artifactItem, handoff, sectionDef, artifactBasis = compileArtifactBasis(artifactItem, handoff)) {
  const full = generateMockArtifactOutput(artifactItem, handoff, artifactBasis)
  const section = (full.contentSections || []).find(s => s.sectionId === sectionDef?.id) || {
    sectionId: sectionDef?.id,
    heading: sectionDef?.heading,
    purpose: sectionDef?.purpose,
    body: `[Mock] ${sectionDef?.heading} generated from ${artifactBasis?.counts?.mappedHowOptions || 0} mapped how option(s).`,
    sourceAtomIds: artifactItem.sourceAtomIds?.slice(0, 3) || [],
    openQuestions: [`[Mock] What additional context is needed for ${sectionDef?.heading}?`],
    confidenceLevel: 'low',
  }
  return { section }
}

export function generateMockArtifactChildOutput(_artifactItem, _handoff, sectionDef, childDef) {
  const body = childDef.isStaticAtom
    ? `[Mock] ${childDef.label}: synthesised from artifact basis. Directive: ${(childDef.inputBasis || '').slice(0, 80)}…`
    : `[Mock] ${childDef.label}: concise ${sectionDef.heading} item generated from one mapped source item.`
  return {
    child: {
      childId:        childDef.childId,
      heading:        childDef.label,
      body,
      sourceAtomIds:  [],
      openQuestions:  [`[Mock] What evidence confirms ${childDef.label}?`],
      confidenceLevel:'low',
    },
  }
}
