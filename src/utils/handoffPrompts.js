// Handoff prompt builders and response parsers.
// buildHandoffStructureMessages — one call per BU, returns domainOfWork + handoffStructure.
// buildHandoffChildAtomMessages — one call per child atom of a structure item.

import { stageSnapshotToText } from './stageSnapshots'

/**
 * Build messages to generate the handoff structure for one BU.
 * Requires smeLens — the SME Review Lens drives what Stage 3 artifacts are needed.
 */
export function buildHandoffStructureMessages(stage1Snapshot, bu, smeLens, otherBuNames) {
  const stage1Context = stageSnapshotToText(stage1Snapshot)
  const otherBuList = otherBuNames.length > 0 ? otherBuNames.join(', ') : 'None'

  const buDetails = [
    `Name: ${bu.name}`,
    bu.purpose              ? `Purpose: ${bu.purpose}` : null,
    bu.strategicInvolvement ? `Strategic Involvement: ${bu.strategicInvolvement}` : null,
    bu.involvementLevel     ? `Involvement Level: ${bu.involvementLevel}` : null,
    bu.keyResponsibilities?.length
      ? `Key Responsibilities:\n${bu.keyResponsibilities.map(r => `  - ${r}`).join('\n')}`
      : null,
  ].filter(Boolean).join('\n')

  const smeLensSection = smeLens ? `\nSME Review Lens:\n${smeLens}` : ''

  const systemPrompt = `You are a strategic planning analyst preparing a Stage 3 execution planning handoff.

Given a Stage 1 strategy basis, one target business unit, and the SME Review Lens for that BU, return:
1. domainOfWork — a concise label for this BU's planning domain in this strategy (2–6 words)
2. handoffStructure — 4–7 Stage 3 execution-planning artifacts this BU must produce or validate

CRITICAL: Each handoffStructure item must represent a Stage 3 planning artifact or execution question — NOT a restatement of the BU's Stage 2 responsibilities.

Good example: "Partner Evaluation Decision Model" — a Stage 3 artifact Stage 3 must produce
Bad example: "Partner evaluation and selection" — restates Stage 2 responsibility in task language

The central question each item must answer:
"What must Stage 3 produce so this BU can act, validate, govern, or operationalize its part of the strategy?"

Return ONLY valid JSON — no markdown, no prose, no code fences. Exact schema:

{
  "domainOfWork": "string",
  "handoffStructure": [
    {
      "key": "camelCase identifier derived from the label",
      "label": "Artifact or planning question label (3–8 words)",
      "purpose": "What this artifact is and why Stage 3 must produce it (1–2 sentences)",
      "whyThisMattersForStage3": "What breaks in execution if this artifact is missing (1 sentence)",
      "SMEReviewFocus": "What the SME will scrutinize in this artifact (1 short phrase)",
      "required": true
    }
  ]
}

Rules:
- domainOfWork: 2–6 words, specific to this BU and strategy context
- handoffStructure: 4–7 items, each shaped by the provided SME Review Lens
- SMEReviewFocus: derive directly from the SME Review Lens provided
- Be specific to this company, strategy, and BU — no generic lists`

  const userPrompt = `Stage 1 Strategy Basis:
${stage1Context}

Target Business Unit:
${buDetails}${smeLensSection}

Other Business Units in this strategy: ${otherBuList}

Generate the handoff structure for ${bu.name} only. Return only the JSON object.`

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
  }
}

// Normalize a single structure item — handles both legacy string format and new object format
function normalizeStructureItem(item) {
  if (typeof item === 'string') {
    const label = item.trim()
    const key = label.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
      .split(/\s+/).map((w, i) => i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)).join('')
    return { key, label, purpose: '', whyThisMattersForStage3: '', SMEReviewFocus: '', required: true }
  }
  const label = typeof item.label === 'string' ? item.label.trim() : typeof item.key === 'string' ? item.key : '(unnamed)'
  const key   = typeof item.key   === 'string' ? item.key.trim()   : label.toLowerCase().replace(/[^a-z0-9]/g, '')
  return {
    key,
    label,
    purpose:               typeof item.purpose               === 'string' ? item.purpose.trim()               : '',
    whyThisMattersForStage3: typeof item.whyThisMattersForStage3 === 'string' ? item.whyThisMattersForStage3.trim() : '',
    SMEReviewFocus:        typeof item.SMEReviewFocus        === 'string' ? item.SMEReviewFocus.trim()        : '',
    required:              item.required !== false,
  }
}

export function parseHandoffStructureResponse(rawText) {
  if (!rawText?.trim()) {
    return { domainOfWork: null, handoffStructure: null, error: 'Empty response from API.' }
  }

  let jsonStr = rawText.trim()
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) jsonStr = fenceMatch[1].trim()

  const firstBrace = jsonStr.indexOf('{')
  const lastBrace  = jsonStr.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1)
  }

  let parsed
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    return { domainOfWork: null, handoffStructure: null, error: 'Could not parse JSON from response.' }
  }

  const domainOfWork = typeof parsed?.domainOfWork === 'string' ? parsed.domainOfWork.trim() : null
  const rawStructure = Array.isArray(parsed?.handoffStructure) ? parsed.handoffStructure : null

  if (!domainOfWork || !rawStructure?.length) {
    return { domainOfWork: null, handoffStructure: null, error: 'Response missing required fields.' }
  }

  const handoffStructure = rawStructure
    .filter(s => s && (typeof s === 'string' || typeof s === 'object'))
    .map(normalizeStructureItem)
    .filter(s => s.label)

  if (!handoffStructure.length) {
    return { domainOfWork: null, handoffStructure: null, error: 'Response missing required fields.' }
  }

  return { domainOfWork, handoffStructure, error: null }
}

// ── Handoff item ──────────────────────────────────────────────────────────────

/**
 * Build messages for one handoff item — one specific planning theme for one BU.
 * @param {object}   stage1Snapshot  — contentSnapshot from active Stage 1 revision
 * @param {object}   bu              — BU core record
 * @param {string}   domainOfWork    — already-generated domain label for this BU
 * @param {string|null} smeLens      — already-generated SME lens (or null)
 * @param {string}   structureItem   — the specific handoffStructure theme to elaborate
 * @param {string[]} otherBuNames    — sibling BU names for orientation
 */
export function buildHandoffItemMessages(stage1Snapshot, bu, domainOfWork, smeLens, structureItem, otherBuNames) {
  const stage1Context = stageSnapshotToText(stage1Snapshot)
  const otherBuList = otherBuNames.length > 0 ? otherBuNames.join(', ') : 'None'

  const buDetails = [
    `Name: ${bu.name}`,
    bu.purpose              ? `Purpose: ${bu.purpose}` : null,
    bu.strategicInvolvement ? `Strategic Involvement: ${bu.strategicInvolvement}` : null,
    bu.involvementLevel     ? `Involvement Level: ${bu.involvementLevel}` : null,
    bu.keyResponsibilities?.length
      ? `Key Responsibilities:\n${bu.keyResponsibilities.map(r => `  - ${r}`).join('\n')}`
      : null,
    bu.dependencies?.length
      ? `Dependencies:\n${bu.dependencies.map(d => `  - ${d}`).join('\n')}`
      : null,
    bu.risksAndUnknowns?.length
      ? `Risks & Unknowns:\n${bu.risksAndUnknowns.map(r => `  - ${r}`).join('\n')}`
      : null,
  ].filter(Boolean).join('\n')

  const systemPrompt = `You are a strategic planning analyst preparing a Stage 3 execution planning handoff.

Given a Stage 1 strategy basis and one business unit, generate a detailed handoff item for one specific planning theme.

Return ONLY valid JSON — no markdown, no prose, no code fences. Exact schema:

{
  "key": "string — camelCase identifier derived from the planning theme",
  "value": <string | string[] | object>
}

Value format guidance:
- Use a string for a single clear planning directive or note
- Use an array of strings for parallel considerations, actions, or required inputs
- Use an object with named sub-fields for multi-faceted items (e.g. {"summary": "...", "keyActions": [...], "constraints": [...]})

Rules:
- key: camelCase, concise, derived from the theme
- value: substantive Stage 3 planning content — specific, actionable, grounded in this BU and strategy
- Do not produce generic content — be specific to this company, BU, domain, and theme`

  const smeLensLine = smeLens ? `\nSME Review Lens: ${smeLens}` : ''

  const userPrompt = `Stage 1 Strategy Basis:
${stage1Context}

Business Unit:
${buDetails}

Domain of Work: ${domainOfWork}${smeLensLine}

Planning theme to elaborate:
"${structureItem}"

Other Business Units in this strategy: ${otherBuList}

Generate the handoff item for the above planning theme only. Return only the JSON object.`

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
  }
}

/**
 * Parse a raw handoff item response.
 * @returns {{ key: string|null, value: any, error: string|null }}
 */
export function parseHandoffItemResponse(rawText) {
  if (!rawText?.trim()) {
    return { key: null, value: null, error: 'Empty response from API.' }
  }

  let jsonStr = rawText.trim()
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) jsonStr = fenceMatch[1].trim()

  const firstBrace = jsonStr.indexOf('{')
  const lastBrace  = jsonStr.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1)
  }

  let parsed
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    return { key: null, value: null, error: 'Could not parse JSON from response.' }
  }

  const key   = typeof parsed?.key === 'string' ? parsed.key.trim() : null
  const value = parsed?.value !== undefined ? parsed.value : null

  if (!key || value === null) {
    return { key: null, value: null, error: 'Response missing required fields.' }
  }

  return { key, value, error: null }
}

// ── Handoff child atom ────────────────────────────────────────────────────────

// Fixed fallback sub-fields used when a parent item is decomposed.
export const CHILD_ATOM_KEYS = [
  'summary',
  'requiredOutputs',
  'constraints',
  'risksOrUnknowns',
  'dependencies',
  'validationNeeds',
  'successSignals',
  'stage4Implications',
]

const CHILD_FIELD_GUIDANCE = `Field value guidance:
- summary: 2-3 sentences summarising what this item addresses for Stage 3
- requiredOutputs: array of specific deliverables Stage 3 must produce
- constraints: array of constraints Stage 3 must operate within
- risksOrUnknowns: array of risks or open questions
- dependencies: array of dependencies on other BUs, systems, or data
- validationNeeds: array of things that must be validated before this item can proceed
- successSignals: array of leading indicators or checkpoints
- stage4Implications: string or array describing what this implies for Stage 4 decisions`

/**
 * Build messages for one child atom of a decomposed handoff item.
 * One call per child — returns only the requested sub-field.
 */
export function buildHandoffChildAtomMessages(stage1Snapshot, bu, domainOfWork, smeLens, structureItem, childKey, otherBuNames) {
  const stage1Context = stageSnapshotToText(stage1Snapshot)
  const otherBuList = otherBuNames.length > 0 ? otherBuNames.join(', ') : 'None'

  const buDetails = [
    `Name: ${bu.name}`,
    bu.purpose              ? `Purpose: ${bu.purpose}` : null,
    bu.strategicInvolvement ? `Strategic Involvement: ${bu.strategicInvolvement}` : null,
    bu.involvementLevel     ? `Involvement Level: ${bu.involvementLevel}` : null,
    bu.keyResponsibilities?.length
      ? `Key Responsibilities:\n${bu.keyResponsibilities.map(r => `  - ${r}`).join('\n')}`
      : null,
    bu.dependencies?.length
      ? `Dependencies:\n${bu.dependencies.map(d => `  - ${d}`).join('\n')}`
      : null,
    bu.risksAndUnknowns?.length
      ? `Risks & Unknowns:\n${bu.risksAndUnknowns.map(r => `  - ${r}`).join('\n')}`
      : null,
  ].filter(Boolean).join('\n')

  const systemPrompt = `You are a strategic planning analyst preparing a Stage 3 execution planning handoff.

Generate one specific sub-field for a handoff item. Return ONLY valid JSON — no markdown, no prose, no code fences:

{ "key": "<exact field name>", "value": <string | string[] | object> }

${CHILD_FIELD_GUIDANCE}

Rules:
- key: must exactly match the requested field name
- value: substantive, specific, actionable — no generic content
- Be specific to this company, BU, domain, and parent planning theme`

  const smeLensLine = smeLens ? `\nSME Review Lens: ${smeLens}` : ''

  const userPrompt = `Stage 1 Strategy Basis:
${stage1Context}

Business Unit:
${buDetails}

Domain of Work: ${domainOfWork}${smeLensLine}

Parent Planning Theme:
"${structureItem}"

Other Business Units: ${otherBuList}

Generate sub-field: ${childKey}

Return only the JSON object with key "${childKey}".`

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
  }
}

/**
 * Parse a child atom response. Accepts three shapes:
 *   1. Direct keyed  — { "<expectedKey>": value }
 *   2. Generic value — { "value": value }
 *   3. Explicit wrap — { "key": "...", "value": value }
 *
 * Shape 1 is tried first so the model can return the natural field name without
 * wrapping it in a key/value envelope.
 *
 * @param {string}      rawText
 * @param {string|null} expectedKey  — the child atom key (e.g. "validationNeeds")
 * @returns {{ value: any, error: string|null }}
 */
export function parseHandoffChildAtomResponse(rawText, expectedKey) {
  if (!rawText?.trim()) {
    return { value: null, error: 'Empty response from API.' }
  }

  let jsonStr = rawText.trim()
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) jsonStr = fenceMatch[1].trim()

  const firstBrace = jsonStr.indexOf('{')
  const lastBrace  = jsonStr.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1)
  }

  let parsed
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    return { value: null, error: 'Could not parse JSON from response.' }
  }

  // Shape 1: { "<expectedKey>": value }
  if (expectedKey && parsed?.[expectedKey] !== undefined) {
    return { value: parsed[expectedKey], error: null }
  }

  // Shape 2 & 3: { "value": ... } or { "key": "...", "value": ... }
  if (parsed?.value !== undefined) {
    return { value: parsed.value, error: null }
  }

  return { value: null, error: 'Response missing required fields.' }
}

// ── Refinement prompt builders ────────────────────────────────────────────────

function buildBuDetails(bu) {
  return [
    `Name: ${bu.name}`,
    bu.purpose              ? `Purpose: ${bu.purpose}` : null,
    bu.strategicInvolvement ? `Strategic Involvement: ${bu.strategicInvolvement}` : null,
    bu.involvementLevel     ? `Involvement Level: ${bu.involvementLevel}` : null,
    bu.keyResponsibilities?.length
      ? `Key Responsibilities:\n${bu.keyResponsibilities.map(r => `  - ${r}`).join('\n')}`
      : null,
    bu.dependencies?.length
      ? `Dependencies:\n${bu.dependencies.map(d => `  - ${d}`).join('\n')}`
      : null,
    bu.risksAndUnknowns?.length
      ? `Risks & Unknowns:\n${bu.risksAndUnknowns.map(r => `  - ${r}`).join('\n')}`
      : null,
  ].filter(Boolean).join('\n')
}

/**
 * Build messages to refine an existing complete/partial handoff item.
 * The model receives the current value and a user refinement instruction.
 * Response is parsed with parseHandoffItemResponse.
 */
export function buildHandoffItemRefinementMessages(stage1Snapshot, bu, domainOfWork, smeLens, structureItem, currentValue, userPrompt, otherBuNames) {
  const stage1Context = stageSnapshotToText(stage1Snapshot)
  const otherBuList = otherBuNames.length > 0 ? otherBuNames.join(', ') : 'None'
  const smeLensLine = smeLens ? `\nSME Review Lens: ${smeLens}` : ''

  const systemPrompt = `You are a strategic planning analyst refining a Stage 3 execution planning handoff item.

You will be given the current value of a handoff item and a refinement instruction. Update the item according to the instruction while preserving the overall structure and depth.

Return ONLY valid JSON — no markdown, no prose, no code fences. Exact schema:

{
  "key": "string — camelCase identifier, same as or derived from the planning theme",
  "value": <string | string[] | object>
}

Rules:
- Preserve the value type/structure unless the instruction explicitly changes it
- Make targeted changes — do not rewrite content that the instruction does not address
- Be specific to this company, BU, domain, and planning theme`

  const currentValueStr = typeof currentValue === 'string'
    ? currentValue
    : JSON.stringify(currentValue, null, 2)

  const userMsg = `Stage 1 Strategy Basis:
${stage1Context}

Business Unit:
${buildBuDetails(bu)}

Domain of Work: ${domainOfWork}${smeLensLine}

Planning Theme:
"${structureItem}"

Other Business Units: ${otherBuList}

Current Value:
${currentValueStr}

Refinement Instruction:
${userPrompt}

Return only the updated JSON object.`

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userMsg       },
    ],
  }
}

/**
 * Build messages to refine one child atom of a decomposed handoff item.
 * Response is parsed with parseHandoffChildAtomResponse(rawText, childKey).
 */
export function buildHandoffChildAtomRefinementMessages(stage1Snapshot, bu, domainOfWork, smeLens, structureItem, childKey, currentValue, userPrompt, otherBuNames) {
  const stage1Context = stageSnapshotToText(stage1Snapshot)
  const otherBuList = otherBuNames.length > 0 ? otherBuNames.join(', ') : 'None'
  const smeLensLine = smeLens ? `\nSME Review Lens: ${smeLens}` : ''

  const systemPrompt = `You are a strategic planning analyst refining one sub-field of a Stage 3 execution planning handoff item.

You will be given the current value of the sub-field and a refinement instruction. Update it according to the instruction.

Return ONLY valid JSON — no markdown, no prose, no code fences:

{ "key": "<exact field name>", "value": <string | string[] | object> }

${CHILD_FIELD_GUIDANCE}

Rules:
- key: must exactly match the requested field name
- Preserve value type unless instruction explicitly changes it
- Make targeted changes only — do not rewrite content the instruction does not address
- Be specific to this company, BU, domain, and parent planning theme`

  const currentValueStr = typeof currentValue === 'string'
    ? currentValue
    : JSON.stringify(currentValue, null, 2)

  const userMsg = `Stage 1 Strategy Basis:
${stage1Context}

Business Unit:
${buildBuDetails(bu)}

Domain of Work: ${domainOfWork}${smeLensLine}

Parent Planning Theme:
"${structureItem}"

Other Business Units: ${otherBuList}

Sub-field to refine: ${childKey}

Current Value:
${currentValueStr}

Refinement Instruction:
${userPrompt}

Return only the JSON object with key "${childKey}".`

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userMsg       },
    ],
  }
}

// ── SME Review Lens ───────────────────────────────────────────────────────────

/**
 * Build messages to generate the SMEReviewLens for one BU.
 * Produces a paragraph description of the SME reviewer, not a short label.
 */
export function buildSmeLensMessages(stage1Snapshot, bu, domainOfWork, handoffStructure, completedThemes, otherBuNames) {
  const stage1Context = stageSnapshotToText(stage1Snapshot)
  const otherBuList = otherBuNames.length > 0 ? otherBuNames.join(', ') : 'None'

  const domainLine = domainOfWork ? `\nDomain of Work: ${domainOfWork}` : ''
  const structureLabels = Array.isArray(handoffStructure)
    ? handoffStructure.map(s => typeof s === 'string' ? s : s.label || s.key).filter(Boolean)
    : []
  const structureSection = structureLabels.length
    ? `\nHandoff Structure Themes:\n${structureLabels.map(s => `  - ${s}`).join('\n')}`
    : ''
  const completedLabels = Array.isArray(completedThemes)
    ? completedThemes.map(s => typeof s === 'string' ? s : s.label || s.key).filter(Boolean)
    : []
  const completedSection = completedLabels.length
    ? `\nHandoff Items Generated (themes): ${completedLabels.join(', ')}`
    : ''

  const systemPrompt = `You are a strategic planning analyst preparing a Stage 3 execution planning handoff.

Identify the SME Review Lens for this business unit — a detailed description of who should review Stage 3 execution plans for this BU, what they own, what they would challenge, and what evidence they need.

Return ONLY valid JSON — no markdown, no prose, no code fences:

{ "SMEReviewLens": "string" }

Rules for SMEReviewLens — write a paragraph (2–5 sentences) that defines:
- Who the likely SME/reviewer is (their role and relevant expertise background)
- What decisions they own or influence in this strategy context
- What they would challenge or question in the execution plan
- What evidence or analysis they would require before accepting the plan
- What operational details they care about
- What would make the Stage 3 execution plan useful or unusable to them

Style example:
"A vendor-risk / regulated fintech integration SME would review whether the partner path actually reduces internal API burden, whether vendor outputs satisfy SR 11-7 evidence needs, whether contract terms prevent ongoing maintenance dependency, and whether escalation triggers are clear before partner scope bleed affects client delivery."

Be specific to this BU, its strategic role, and the company context — not a generic reviewer description.`

  const userPrompt = `Stage 1 Strategy Basis:
${stage1Context}

Business Unit:
${buildBuDetails(bu)}${domainLine}${structureSection}${completedSection}

Other Business Units: ${otherBuList}

Generate the SME Review Lens for ${bu.name}. Return only the JSON object.`

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
  }
}

/**
 * Convert an SME lens (string or structured object) to a prompt-ready string.
 * Used by all prompt builders that accept a smeLens argument.
 */
export function normalizeSMELensForPrompt(lens) {
  if (!lens) return null
  if (typeof lens === 'string') return lens
  if (typeof lens !== 'object') return String(lens)
  const parts = []
  if (lens.summary)           parts.push(lens.summary)
  if (lens.reviewerProfile)   parts.push(`Reviewer: ${lens.reviewerProfile}`)
  if (lens.decisionAuthority) parts.push(`Decision authority: ${lens.decisionAuthority}`)
  if (Array.isArray(lens.challengeAreas)       && lens.challengeAreas.length)       parts.push(`Challenge areas: ${lens.challengeAreas.join('; ')}`)
  if (Array.isArray(lens.evidenceRequired)      && lens.evidenceRequired.length)      parts.push(`Evidence required: ${lens.evidenceRequired.join('; ')}`)
  if (Array.isArray(lens.operationalConcerns)   && lens.operationalConcerns.length)   parts.push(`Operational concerns: ${lens.operationalConcerns.join('; ')}`)
  if (Array.isArray(lens.planFailureConditions) && lens.planFailureConditions.length) parts.push(`Plan failure conditions: ${lens.planFailureConditions.join('; ')}`)
  return parts.filter(Boolean).join('\n') || null
}

/**
 * Parse an SME lens response.
 * Accepts: { "SMEReviewLens": "..." | {...} } | { "smeReviewLens": ... } | { "value": ... }
 * parsedValue is string (legacy) or structured object.
 * @returns {{ parsedValue: string|object|null, error: string|null }}
 */
export function parseSmeLensResponse(rawText) {
  if (!rawText?.trim()) return { parsedValue: null, error: 'Empty response from API.' }

  let jsonStr = rawText.trim()
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) jsonStr = fenceMatch[1].trim()

  const firstBrace = jsonStr.indexOf('{')
  const lastBrace  = jsonStr.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1)
  }

  let parsed
  try { parsed = JSON.parse(jsonStr) }
  catch { return { parsedValue: null, error: 'Could not parse JSON from response.' } }

  const raw =
    parsed?.SMEReviewLens !== undefined ? parsed.SMEReviewLens :
    parsed?.smeReviewLens !== undefined ? parsed.smeReviewLens :
    parsed?.value         !== undefined ? parsed.value         :
    null

  if (raw === null || raw === undefined) return { parsedValue: null, error: 'Response missing SMEReviewLens value.' }

  // String — backward compat
  if (typeof raw === 'string') {
    const val = raw.trim()
    return val ? { parsedValue: val, error: null } : { parsedValue: null, error: 'Empty SMEReviewLens string.' }
  }

  // Structured object
  if (typeof raw === 'object') {
    if (raw.summary || raw.reviewerProfile || raw.challengeAreas) {
      return { parsedValue: raw, error: null }
    }
    // Unknown shape — extract any string values
    const text = Object.values(raw).filter(v => typeof v === 'string').join('\n').trim()
    return text ? { parsedValue: text, error: null } : { parsedValue: null, error: 'Unrecognizable SMEReviewLens structure.' }
  }

  return { parsedValue: null, error: 'Unrecognizable SMEReviewLens format.' }
}

/**
 * Build messages to refine an existing SME Review Lens.
 * Response is parsed with parseSmeLensResponse.
 */
export function buildSmeLensRefinementMessages(stage1Snapshot, bu, domainOfWork, handoffStructure, currentSmeLens, userPrompt, otherBuNames) {
  const stage1Context = stageSnapshotToText(stage1Snapshot)
  const otherBuList = otherBuNames.length > 0 ? otherBuNames.join(', ') : 'None'

  const domainLine = domainOfWork ? `\nDomain of Work: ${domainOfWork}` : ''
  const structureLabels2 = Array.isArray(handoffStructure)
    ? handoffStructure.map(s => typeof s === 'string' ? s : s.label || s.key).filter(Boolean)
    : []
  const structureSection = structureLabels2.length
    ? `\nHandoff Structure Themes:\n${structureLabels2.map(s => `  - ${s}`).join('\n')}`
    : ''

  const systemPrompt = `You are a strategic planning analyst refining the SME Review Lens for a Stage 3 execution planning handoff.

Update the SMEReviewLens according to the refinement instruction. Return ONLY valid JSON — no markdown, no prose, no code fences:

{ "SMEReviewLens": <string | structured object> }

SMEReviewLens may be either a detailed string or a structured object:
{
  "summary": "one-sentence summary",
  "reviewerProfile": "who reviews Stage 3 plans for this BU and their expertise",
  "decisionAuthority": "what decisions they own or influence",
  "challengeAreas": ["what they would challenge or question"],
  "evidenceRequired": ["what evidence or analysis they need before accepting the plan"],
  "operationalConcerns": ["operational details they care about"],
  "planFailureConditions": ["what would make the Stage 3 plan unusable to them"]
}

Rules:
- SMEReviewLens should be specific, readable, and detailed enough to shape downstream handoff structure and item generation
- Preserve ALL existing detail unless the refinement instruction explicitly asks to shorten or remove it
- If the instruction asks for readability improvements (paragraphs, bullets, structured format), reformat the existing detail — do not compress or omit substance
- Apply targeted changes only — do not rewrite content the instruction does not address
- Be specific to this BU, its strategic role, and the company context`

  const userMsg = `Stage 1 Strategy Basis:
${stage1Context}

Business Unit:
${buildBuDetails(bu)}${domainLine}${structureSection}

Other Business Units: ${otherBuList}

Current SME Review Lens:
"${currentSmeLens}"

Refinement Instruction:
${userPrompt}

Return only the updated JSON object.`

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userMsg       },
    ],
  }
}
