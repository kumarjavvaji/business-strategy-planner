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
