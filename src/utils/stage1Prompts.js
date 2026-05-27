// Stage 1 — AI refinement prompt builder, response normaliser, and workspace patcher.
// Pure functions — no React, no side effects.

import { stageSnapshotToText } from './stageSnapshots'

// ── AI prompt builder ─────────────────────────────────────────────────────────

/**
 * Build messages for AI-assisted Stage 1 refinement.
 * @param {object} currentSnapshot  — contentSnapshot from the active Stage 1 revision
 * @param {string} refinementPrompt — user's refinement instruction
 * @returns {{ messages: Array<{ role, content }>, systemPrompt: string }}
 */
export function buildStage1Messages(currentSnapshot, refinementPrompt) {
  const context = stageSnapshotToText(currentSnapshot)

  const systemPrompt = `You are a strategic analyst refining a Stage 1 Strategy Basis document.

Your task: Apply the user's refinement instruction to the existing document, updating ONLY the fields directly impacted by the instruction. Preserve all unchanged content verbatim.

Return ONLY a valid JSON object — no markdown, no prose, no code fences. Exact schema:

{
  "thesis": "string",
  "businessProblem": "string",
  "opportunity": "string",
  "recommendedDirection": "string",
  "confidenceLevel": "High | Medium | Low",
  "readinessLevel": "string",
  "targetCustomer": "string",
  "sections": [{ "heading": "string", "body": "string" }],
  "keyDecisions": ["string"],
  "callToAction": "string",
  "validationCheckpoints": ["string"],
  "readinessWarnings": ["string"],
  "risks": ["string"],
  "keyInsights": ["string"],
  "supportingClaims": ["string"],
  "unresolvedQuestions": ["string"]
}

Rules:
- Return ALL fields in the schema, even if unchanged — never omit a field
- Preserve exact wording of unchanged fields — do not paraphrase or reformat them
- Only modify content that is directly impacted by the refinement instruction
- Maintain internal consistency: if you change the thesis or opportunity, update risks, decisions,
  and validation checkpoints only where they are materially affected
- Do not change entity name, company, or lineage metadata
- sections[]: preserve the existing structure; add, remove, or update sections only if the
  refinement instruction specifically requires it`

  const userPrompt = `Current Stage 1 document:

${context}

Refinement instruction:
${refinementPrompt}

Apply this refinement and return the complete updated JSON.`

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
    systemPrompt,
  }
}

// ── Response normaliser ───────────────────────────────────────────────────────

/**
 * Parse and normalise the AI text response into a Stage 1 patch object.
 * @param {string} rawText
 * @returns {{ patch: object|null, error: string|null }}
 */
export function parseStage1Response(rawText) {
  if (!rawText?.trim()) {
    return { patch: null, error: 'Empty response from API.' }
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
    return { patch: null, error: 'Could not parse JSON from response. See raw output.' }
  }

  // Require at least one of the key narrative fields to be present
  if (!parsed?.thesis && !parsed?.opportunity && !parsed?.businessProblem) {
    return { patch: null, error: 'Response did not contain a valid Stage 1 document object.' }
  }

  const safeStr  = v => (typeof v === 'string' ? v.trim() : String(v ?? ''))
  const safeList = v => (Array.isArray(v)
    ? v.map(i => typeof i === 'string' ? i.trim() : String(i ?? '')).filter(Boolean)
    : [])
  const safeSections = v => Array.isArray(v)
    ? v.map(s => ({ heading: safeStr(s?.heading), body: safeStr(s?.body) }))
        .filter(s => s.heading || s.body)
    : []

  return {
    patch: {
      thesis:                safeStr(parsed.thesis),
      businessProblem:       safeStr(parsed.businessProblem),
      opportunity:           safeStr(parsed.opportunity),
      recommendedDirection:  safeStr(parsed.recommendedDirection),
      confidenceLevel:       safeStr(parsed.confidenceLevel),
      readinessLevel:        safeStr(parsed.readinessLevel),
      targetCustomer:        safeStr(parsed.targetCustomer),
      sections:              safeSections(parsed.sections),
      keyDecisions:          safeList(parsed.keyDecisions),
      callToAction:          safeStr(parsed.callToAction),
      validationCheckpoints: safeList(parsed.validationCheckpoints),
      readinessWarnings:     safeList(parsed.readinessWarnings),
      risks:                 safeList(parsed.risks),
      keyInsights:           safeList(parsed.keyInsights),
      supportingClaims:      safeList(parsed.supportingClaims),
      unresolvedQuestions:   safeList(parsed.unresolvedQuestions),
    },
    error: null,
  }
}

// ── Workspace patcher ─────────────────────────────────────────────────────────

/**
 * Applies an AI-generated patch to the normalized workspace.
 * Only updates refineable strategy/content/evidence fields.
 * Entity, lineage, and artifact identity (title, type, version) are never changed.
 *
 * Uses existing value as fallback so no field is accidentally blanked.
 *
 * @param {object} workspace — current normalizedWorkspace
 * @param {object} patch     — normalised patch from parseStage1Response
 * @returns {object}         — updated normalizedWorkspace (new object, original not mutated)
 */
export function applyStage1PatchToWorkspace(workspace, patch) {
  const keep = (newVal, oldVal) => newVal || oldVal   // prefer AI value, fall back to existing

  return {
    ...workspace,

    strategy: {
      ...workspace.strategy,
      thesis:               keep(patch.thesis,               workspace.strategy?.thesis),
      businessProblem:      keep(patch.businessProblem,      workspace.strategy?.businessProblem),
      opportunity:          keep(patch.opportunity,          workspace.strategy?.opportunity),
      recommendedDirection: keep(patch.recommendedDirection, workspace.strategy?.recommendedDirection),
      confidenceLevel:      keep(patch.confidenceLevel,      workspace.strategy?.confidenceLevel),
      readinessLevel:       keep(patch.readinessLevel,       workspace.strategy?.readinessLevel),
      targetCustomer:       keep(patch.targetCustomer,       workspace.strategy?.targetCustomer),
    },

    artifact: {
      ...workspace.artifact,
      data: {
        ...workspace.artifact?.data,
        subtitle:             workspace.artifact?.data?.subtitle,  // never overwritten
        personaSummary:       workspace.artifact?.data?.personaSummary,
        sections:             patch.sections?.length
                                ? patch.sections
                                : (workspace.artifact?.data?.sections || []),
        keyDecisions:         patch.keyDecisions?.length
                                ? patch.keyDecisions
                                : (workspace.artifact?.data?.keyDecisions || []),
        callToAction:         keep(patch.callToAction, workspace.artifact?.data?.callToAction),
        validationCheckpoints: patch.validationCheckpoints?.length
                                ? patch.validationCheckpoints
                                : (workspace.artifact?.data?.validationCheckpoints || []),
        readinessWarnings:    patch.readinessWarnings?.length
                                ? patch.readinessWarnings
                                : (workspace.artifact?.data?.readinessWarnings || []),
      },
    },

    evidence: {
      ...workspace.evidence,
      risks:               patch.risks?.length
                             ? patch.risks
                             : (workspace.evidence?.risks || []),
      keyInsights:         patch.keyInsights?.length
                             ? patch.keyInsights
                             : (workspace.evidence?.keyInsights || []),
      supportingClaims:    patch.supportingClaims?.length
                             ? patch.supportingClaims
                             : (workspace.evidence?.supportingClaims || []),
      unresolvedQuestions: patch.unresolvedQuestions?.length
                             ? patch.unresolvedQuestions
                             : (workspace.evidence?.unresolvedQuestions || []),
    },
  }
}
