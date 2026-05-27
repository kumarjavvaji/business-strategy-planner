// Handoff structure prompt builder and response parser.
// One API call per BU — returns only domainOfWork and handoffStructure.

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
