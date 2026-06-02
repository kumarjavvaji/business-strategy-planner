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

const SYSTEM_PREAMBLE = `You are a strategic delivery advisor generating structured planning artifacts from verified execution plans. Be concise and specific. Avoid generic filler. Each section body should be 3-6 tight sentences or a short bullet list. Respond ONLY with valid JSON — no markdown fences, no prose outside the JSON.`

// ── Formatting helpers ─────────────────────────────────────────────────────────

const BASIS_CONTRACT = `Use the compact artifact basis below. Transform the basis into the artifact; do not summarize it. Do not copy Stage 3 prose verbatim. Do not include unmapped tactics. Keep sections role-distinct. Prefer concrete deliverable language over explanatory narrative.`

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

// ── Executive Decision Brief ───────────────────────────────────────────────────

const EXEC_BRIEF_SECTIONS = [
  { id: 'executive_summary',       heading: 'Executive Summary',        purpose: 'Overall execution readiness in 2-3 sentences.' },
  { id: 'key_decisions_required',  heading: 'Key Decisions Required',   purpose: 'Specific decisions needed before or during delivery, with decision owner.', generationMode: 'child_units', childSource: 'relevantDecisions' },
  { id: 'cross_bu_commitments',    heading: 'Cross-BU Commitments',     purpose: 'Shared commitments and sequencing dependencies across BUs.', generationMode: 'child_units', childSource: 'relevantDependencies' },
  { id: 'governance_requirements', heading: 'Governance Requirements',  purpose: 'Sign-off requirements, review gates, and escalation paths.', generationMode: 'child_units', childSource: 'selectedExecutionTactics' },
  { id: 'risk_summary',            heading: 'Risk Summary',             purpose: 'Top 3-5 cross-cutting risks with brief mitigation notes.', generationMode: 'child_units', childSource: 'relevantRisks' },
  { id: 'recommended_next_steps',  heading: 'Recommended Next Steps',   purpose: 'Immediate actions before generation of BU-specific delivery plans.' },
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
  { id: 'strategic_context',    heading: 'Strategic Context',           purpose: 'BU role in overall delivery and how it connects to the organisation strategy.' },
  { id: 'execution_workstreams',heading: 'Execution Workstreams',       purpose: 'Key workstreams, activities, and suggested owners.', generationMode: 'child_units', childSource: 'selectedExecutionTactics' },
  { id: 'gate_criteria',        heading: 'Gate Criteria',               purpose: 'What must be true at each delivery gate before proceeding.', generationMode: 'child_units', childSource: 'selectedExecutionTactics' },
  { id: 'dependency_map',       heading: 'Dependency Map',              purpose: 'Internal and cross-BU dependencies that must be resolved during delivery.', generationMode: 'child_units', childSource: 'relevantDependencies' },
  { id: 'risk_controls',        heading: 'Risk Controls',               purpose: 'Specific controls for the identified execution risks.', generationMode: 'child_units', childSource: 'relevantRisks' },
  { id: 'validation_approach',  heading: 'Validation Approach',         purpose: 'How readiness and delivery quality will be confirmed at each phase.', generationMode: 'child_units', childSource: 'relevantValidationQuestions' },
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

// ── SME Review Packet (BU-scoped) ──────────────────────────────────────────────

const BU_SME_SECTIONS = [
  { id: 'review_scope',          heading: 'Review Scope',              purpose: 'What the SME is being asked to assess.' },
  { id: 'knowledge_gaps',        heading: 'Knowledge Gaps',            purpose: 'Gaps in the plan that require specialist input to resolve.', generationMode: 'child_units', childSource: 'relevantValidationQuestions' },
  { id: 'specialist_questions',  heading: 'Specialist Questions',      purpose: 'Specific questions for the domain expert, prioritised.', generationMode: 'child_units', childSource: 'relevantValidationQuestions' },
  { id: 'domain_risks',          heading: 'Domain-Specific Risks',     purpose: 'Risks that require expert judgement, not general project oversight.', generationMode: 'child_units', childSource: 'relevantRisks' },
  { id: 'recommended_experts',   heading: 'Recommended Expert Profiles','purpose': 'Profile descriptions of the specialists who should review this plan.' },
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
  { id: 'cross_bu_scope',               heading: 'Cross-BU Review Scope',           purpose: 'What the review covers and which BUs are in scope.' },
  { id: 'capability_gaps',              heading: 'Capability Gaps',                  purpose: 'Cross-cutting gaps that appear across multiple BU plans.', generationMode: 'child_units', childSource: 'relevantValidationQuestions' },
  { id: 'critical_specialist_questions',heading: 'Critical Specialist Questions',    purpose: 'Questions that must be resolved before delivery commitments are finalised.', generationMode: 'child_units', childSource: 'relevantValidationQuestions' },
  { id: 'systemic_risks',               heading: 'Systemic Risks',                   purpose: 'Risks that span BUs and cannot be owned by any single team.', generationMode: 'child_units', childSource: 'relevantRisks' },
  { id: 'review_structure',             heading: 'Recommended Review Structure',     purpose: 'How the SME review should be organised across BUs and workstreams.' },
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
    case 'bu_sme_review_packet':
      return BU_SME_SECTIONS
    case 'global_sme_review_packet':
      return GLOBAL_SME_SECTIONS
    default:
      return null
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
  return sourceItemsForSection(sectionDef, artifactBasis).map((item, index) => ({
    childId: `${sectionDef.id}:${item.id || item.optionId || index + 1}`,
    parentSectionId: sectionDef.id,
    sourceItemId: item.id || item.optionId || `item_${index + 1}`,
    label: childLabel(item, index),
    sourceItem: item,
  }))
}

export function buildArtifactChildPrompt(artifactItem, handoff, sectionDef, childDef, artifactBasis = compileArtifactBasis(artifactItem, handoff)) {
  if (!SUPPORTED_GENERATION_TYPES.has(artifactItem.artifactType)) {
    return { messages: null, isSupported: false, artifactBasis, sectionDef, childDef: null }
  }
  if (!sectionDef?.id || !childDef?.childId) {
    return { messages: null, isSupported: false, artifactBasis, sectionDef, childDef: null }
  }

  const minimalContext = {
    artifactType: artifactBasis.artifactType,
    artifactIntent: artifactBasis.artifactIntent,
    buName: artifactBasis.buName,
    strategicThesis: artifactBasis.strategicThesis,
    sourceTraceability: artifactBasis.sourceTraceability,
  }

  const userContent = `${SYSTEM_PREAMBLE}

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
  return {
    child: {
      childId: childDef.childId,
      heading: childDef.label,
      body: `[Mock] ${childDef.label}: concise ${sectionDef.heading} item generated from one mapped source item.`,
      sourceAtomIds: [],
      openQuestions: [`[Mock] What evidence confirms ${childDef.label}?`],
      confidenceLevel: 'low',
    },
  }
}
