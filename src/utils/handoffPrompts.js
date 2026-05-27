// Handoff prompt builders and response parsers.
// buildHandoffStructureMessages — one call per BU, returns domainOfWork + handoffStructure.
// buildHandoffItemMessages      — one call per item, returns key + value for one structure theme.

import { stageSnapshotToText } from './stageSnapshots'

export function buildHandoffStructureMessages(stage1Snapshot, bu, otherBuNames) {
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

  const systemPrompt = `You are a strategic planning analyst preparing a Stage 3 planning handoff.

Given a Stage 1 strategy basis and one target business unit, return:
1. domainOfWork — a concise label for this BU's planning domain in this strategy (2–6 words)
2. handoffStructure — 3–6 planning themes or responsibility areas this BU must address in Stage 3 execution planning

Return ONLY valid JSON — no markdown, no prose, no code fences. Exact schema:

{
  "domainOfWork": "string",
  "handoffStructure": ["string", "..."]
}

Rules:
- domainOfWork: 2–6 words, specific to this BU and strategy context
- handoffStructure: 3–6 items, each a concrete planning theme for Stage 3
- Be specific to this company, strategy, and BU — no generic lists`

  const userPrompt = `Stage 1 Strategy Basis:
${stage1Context}

Target Business Unit:
${buDetails}

Other Business Units in this strategy: ${otherBuList}

Generate the handoff structure for ${bu.name} only. Return only the JSON object.`

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
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
  const handoffStructure = Array.isArray(parsed?.handoffStructure)
    ? parsed.handoffStructure.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim())
    : null

  if (!domainOfWork || !handoffStructure?.length) {
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
 * @param {object}       stage1Snapshot
 * @param {object}       bu
 * @param {string|null}  domainOfWork      — already-generated domain label (or null)
 * @param {string[]|null} handoffStructure — already-generated structure themes (or null)
 * @param {string[]|null} completedThemes  — subset of handoffStructure with completed items
 * @param {string[]}     otherBuNames
 */
export function buildSmeLensMessages(stage1Snapshot, bu, domainOfWork, handoffStructure, completedThemes, otherBuNames) {
  const stage1Context = stageSnapshotToText(stage1Snapshot)
  const otherBuList = otherBuNames.length > 0 ? otherBuNames.join(', ') : 'None'

  const domainLine = domainOfWork ? `\nDomain of Work: ${domainOfWork}` : ''
  const structureSection = handoffStructure?.length
    ? `\nHandoff Structure Themes:\n${handoffStructure.map(s => `  - ${s}`).join('\n')}`
    : ''
  const completedSection = completedThemes?.length
    ? `\nHandoff Items Generated (themes): ${completedThemes.join(', ')}`
    : ''

  const systemPrompt = `You are a strategic planning analyst preparing a Stage 3 execution planning handoff.

Identify the SME Review Lens for this business unit — the specific area of subject-matter expertise that Stage 3 execution planning should draw on for validation, calibration, and risk assessment.

Return ONLY valid JSON — no markdown, no prose, no code fences:

{ "SMEReviewLens": "string" }

Rules:
- SMEReviewLens: one concise phrase (3–10 words) naming the expert review lens
- Be specific to this BU, its domain of work, and the strategy — no generic labels
- Examples: "Legal & regulatory sign-off", "Supply chain resilience", "Customer segment economics"`

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
 * Parse an SME lens response.
 * Accepts: { "SMEReviewLens": "..." } | { "smeReviewLens": "..." } | { "value": "..." }
 * @returns {{ parsedValue: string|null, error: string|null }}
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

  const value =
    typeof parsed?.SMEReviewLens === 'string' ? parsed.SMEReviewLens.trim() :
    typeof parsed?.smeReviewLens === 'string' ? parsed.smeReviewLens.trim() :
    typeof parsed?.value         === 'string' ? parsed.value.trim()         :
    null

  if (!value) return { parsedValue: null, error: 'Response missing SMEReviewLens value.' }
  return { parsedValue: value, error: null }
}

/**
 * Build messages to refine an existing SME Review Lens.
 * Response is parsed with parseSmeLensResponse.
 */
export function buildSmeLensRefinementMessages(stage1Snapshot, bu, domainOfWork, handoffStructure, currentSmeLens, userPrompt, otherBuNames) {
  const stage1Context = stageSnapshotToText(stage1Snapshot)
  const otherBuList = otherBuNames.length > 0 ? otherBuNames.join(', ') : 'None'

  const domainLine = domainOfWork ? `\nDomain of Work: ${domainOfWork}` : ''
  const structureSection = handoffStructure?.length
    ? `\nHandoff Structure Themes:\n${handoffStructure.map(s => `  - ${s}`).join('\n')}`
    : ''

  const systemPrompt = `You are a strategic planning analyst refining the SME Review Lens for a Stage 3 execution planning handoff.

Update the SMEReviewLens according to the refinement instruction. Return ONLY valid JSON — no markdown, no prose, no code fences:

{ "SMEReviewLens": "string" }

Rules:
- SMEReviewLens: one concise phrase (3–10 words)
- Be specific to this BU, its domain, and the strategy
- Apply targeted changes only — do not rewrite the lens if the instruction does not require it`

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
