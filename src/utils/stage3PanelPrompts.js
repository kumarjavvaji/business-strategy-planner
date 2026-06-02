/**
 * Per-panel Stage 3 prompt builders — generation and refinement.
 *
 * Generation: produces a single panel from scratch, given BU + strategy context.
 * Refinement: improves an existing panel per the authoring contract.
 *
 * Each panel has a strict authoring contract (field roles must be distinct).
 * Panel generation/refinement must NOT touch unrelated panels.
 */

import { PANEL_LABELS } from './stage3PanelModel'

// ── Helpers ───────────────────────────────────────────────────────────────────

const safeStr  = v => (typeof v === 'string' ? v.trim() : String(v ?? ''))
const safeList = v => (Array.isArray(v) ? v.map(safeStr).filter(Boolean) : [])

function truncateText(text, max = 400) {
  const s = safeStr(text)
  return s.length > max ? s.slice(0, max).trim() + '...' : s
}

function parseJsonObject(rawText) {
  if (!rawText?.trim()) return { parsed: null, error: 'Empty response.' }
  let s = rawText.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) s = fence[1].trim()
  const first = s.indexOf('{'), last = s.lastIndexOf('}')
  if (first !== -1 && last > first) s = s.slice(first, last + 1)
  try { return { parsed: JSON.parse(s), error: null } } catch { return { parsed: null, error: 'Could not parse JSON from response.' } }
}

// ── Panel authoring contracts (embedded in prompts) ───────────────────────────

const PANEL_CONTRACTS = {
  strategicObjective: `
AUTHORING CONTRACT — Strategic Objective:
- summary: explain the strategic intent in one sentence. Include what this BU owns, why it matters.
- outcomeFocus: explain why the work matters and why now. This is NOT a risk or dependency statement.
- nonGoalsOrBoundaries: list hard constraints or exclusions. Do not repeat the summary or outcomeFocus.
Must not include risks, dependencies, validation gates, or repeated decision details.`,

  criticalDecisions: `
AUTHORING CONTRACT — Critical Decisions:
Each decision must have ALL of:
- decisionName: short title
- decisionQuestion: THE SPECIFIC CHOICE to be made (not the consequence)
- whyItMatters: consequence of leaving this unresolved (NOT the same sentence as decisionQuestion)
- decisionOptions: 2-4 concrete options
- decisionEvidenceNeeded: proof required to decide (NOT a restatement of the question or whyItMatters)
- decisionTiming: WHEN it must be made — each decision must have a DIFFERENT timing from others
FIELD UNIQUENESS RULE: question ≠ whyItMatters ≠ evidenceNeeded. No field may repeat another field's sentence.`,

  executionSequence: `
AUTHORING CONTRACT — Execution Sequence:
Each phase must have:
- phaseName: short phase name
- phaseObjective: what this phase achieves (unique per phase)
- recommendedHow: the specific recommended method for this phase
- whyThisFitsThePhase: why this method fits THIS phase specifically (different from other phases)
- exitCriteria: the observable condition ending this phase (specific, not generic)
- evidenceExamples: evidence produced by this phase (specific to this phase — not copied across phases)
Must not paste the same method library under every phase.`,

  dependencies: `
AUTHORING CONTRACT — Dependencies:
Each dependency must have:
- dependencyName: short name
- dependencyDescription: what the dependency IS (the full context sentence)
- whyItMatters: gating consequence — MUST differ from dependencyDescription
- requiredInput: the specific deliverable NOUN (short noun phrase, not a sentence)
- consequenceIfMissing: operational impact if not delivered (NOT the same as the description)
FIELD UNIQUENESS RULE: description ≠ requiredInput ≠ consequenceIfMissing. No field may copy another.`,

  risks: `
AUTHORING CONTRACT — Risk & Mitigation:
Each risk must have:
- riskName: short title
- riskDescription: THE FAILURE MODE — what specifically breaks (not a generic statement)
- whyItMatters: DOWNSTREAM CONSEQUENCE if this risk materializes (NOT the same as riskDescription)
- mitigationOptions: specific actions to reduce this risk (tailored, not a generic library)
- earlyWarningSignals: observable signs the risk is activating
- evidenceThatRiskIsReduced: what would show the risk has been managed
FIELD UNIQUENESS RULE: riskDescription ≠ whyItMatters. Two different risks must have different failure modes.`,

  validationFramework: `
AUTHORING CONTRACT — Validation Framework:
Each validation question must have:
- validationQuestion: what this check resolves
- completionCriteria: SPECIFIC condition closing this question (different for each question)
- howToDetermineCompletion: mechanism or process (different for each question)
- evidenceExamples: concrete evidence specific to THIS question (NOT the same list for all questions)
- veracityChecks: how to confirm evidence is reliable (question-specific, NOT generic for all)
- failureOrReworkTriggers: what triggers a rework loop for THIS question specifically
FIELD UNIQUENESS RULE: evidenceExamples, veracityChecks, and failureOrReworkTriggers MUST differ across questions.`,
}

// ── Schema definitions per panel (what the AI should return) ─────────────────

const PANEL_RESPONSE_SCHEMAS = {
  strategicObjective: `{
  "summary": "string — strategic intent in one sentence",
  "outcomeFocus": "string — why it matters and why now",
  "nonGoalsOrBoundaries": ["string — hard constraint or exclusion"]
}`,

  criticalDecisions: `[
  {
    "decisionName": "string",
    "decisionQuestion": "string — the specific choice",
    "whyItMatters": "string — consequence if unresolved (NOT same as question)",
    "decisionOptions": ["string — concrete option"],
    "decisionEvidenceNeeded": ["string — proof required (NOT restatement of question)"],
    "decisionTiming": "string — when to decide (unique per decision)"
  }
]`,

  executionSequence: `[
  {
    "phaseName": "string",
    "phaseObjective": "string — what this phase achieves",
    "recommendedHow": "string — specific recommended method",
    "whyThisFitsThePhase": "string — why this method fits THIS phase",
    "exitCriteria": "string — observable condition ending this phase",
    "evidenceExamples": ["string — evidence specific to this phase"],
    "howOptions": [
      {
        "optionName": "string",
        "whenToUse": "string",
        "whyItFitsThePhaseOutcome": "string",
        "evidenceProduced": "string"
      }
    ]
  }
]`,

  dependencies: `[
  {
    "dependencyName": "string",
    "dependencyDescription": "string — what the dependency IS (full context sentence)",
    "whyItMatters": "string — gating consequence (NOT same as description)",
    "requiredInput": "string — short deliverable noun phrase (NOT a sentence)",
    "consequenceIfMissing": "string — operational impact (NOT same as description or requiredInput)"
  }
]`,

  risks: `[
  {
    "riskName": "string",
    "riskDescription": "string — the specific failure mode",
    "whyItMatters": "string — downstream consequence (NOT same as riskDescription)",
    "mitigationOptions": ["string — specific mitigation action"],
    "earlyWarningSignals": ["string — observable activation sign"],
    "evidenceThatRiskIsReduced": ["string — what shows risk is managed"]
  }
]`,

  validationFramework: `[
  {
    "validationQuestion": "string",
    "completionCriteria": ["string — specific to this question"],
    "howToDetermineCompletion": ["string — mechanism specific to this question"],
    "evidenceExamples": ["string — evidence specific to THIS question (must differ from other questions)"],
    "veracityChecks": ["string — specific to this question (must differ from other questions)"],
    "failureOrReworkTriggers": ["string — rework trigger specific to this question"]
  }
]`,
}

// ── Spine context serializer ──────────────────────────────────────────────────

function buildSpineContext(compiledPlan, panelId) {
  if (!compiledPlan) return 'No strategy spine available.'
  const lines = []

  // Strategic objective always included as context
  const so = compiledPlan.strategicObjective
  if (so) {
    lines.push(`Strategic Objective: ${truncateText(so.summary, 200)}`)
    if (so.outcomeFocus) lines.push(`Outcome Focus: ${truncateText(so.outcomeFocus, 150)}`)
  }

  // Include other panels as brief context (not the panel being refined)
  if (panelId !== 'criticalDecisions' && compiledPlan.criticalDecisions?.length) {
    const names = compiledPlan.criticalDecisions.slice(0, 3).map(d => d.decisionName || 'Decision').join(', ')
    lines.push(`Critical Decisions (summary): ${names}`)
  }
  if (panelId !== 'executionSequence' && compiledPlan.executionSequence?.length) {
    const names = compiledPlan.executionSequence.slice(0, 3).map(p => p.phaseName || 'Phase').join(' → ')
    lines.push(`Execution Phases (summary): ${names}`)
  }
  if (panelId !== 'dependencies' && compiledPlan.dependencies?.length) {
    const names = compiledPlan.dependencies.slice(0, 3).map(d => d.dependencyName || 'Dep').join(', ')
    lines.push(`Dependencies (summary): ${names}`)
  }
  if (panelId !== 'risks' && compiledPlan.risksAndMitigations?.length) {
    const names = compiledPlan.risksAndMitigations.slice(0, 3).map(r => r.riskName || 'Risk').join(', ')
    lines.push(`Risks (summary): ${names}`)
  }

  return lines.join('\n')
}

// ── Main prompt builder ───────────────────────────────────────────────────────

/**
 * Build AI messages for a per-panel refinement.
 *
 * @param {string} panelId       - one of PANEL_IDS
 * @param {*}      panelContent  - current panel content
 * @param {object} compiledPlan  - full compiled plan (for spine context)
 * @param {object} crossPanelAudit - cross-panel audit findings to inform the refinement
 * @param {string} prompt        - user refinement instruction
 * @param {string} impactSummary - optional user-provided impact summary
 * @param {object} auditBefore   - panel completeness audit before refinement
 * @returns {{ messages: Array<{role, content}>, systemPrompt: string }}
 */
export function buildPanelRefinementMessages({ panelId, panelContent, compiledPlan, crossPanelAudit, prompt, impactSummary = '', auditBefore = null }) {
  const label    = PANEL_LABELS[panelId] || panelId
  const contract = PANEL_CONTRACTS[panelId] || ''
  const schema   = PANEL_RESPONSE_SCHEMAS[panelId] || '{}'

  const currentJson = JSON.stringify(panelContent ?? null, null, 2).slice(0, 2000)
  const spineContext = buildSpineContext(compiledPlan, panelId)

  // Audit findings to pass into the prompt
  const auditContext = auditBefore
    ? [
        auditBefore.missingFields?.length    ? `Missing fields: ${auditBefore.missingFields.join(', ')}` : null,
        auditBefore.truncatedFields?.length  ? `Truncated fields: ${auditBefore.truncatedFields.join(', ')}` : null,
        auditBefore.weakFields?.length       ? `Weak/placeholder fields: ${auditBefore.weakFields.join(', ')}` : null,
        auditBefore.duplicateFieldFindings?.length ? `Duplicate field violations: ${auditBefore.duplicateFieldFindings.join('; ')}` : null,
      ].filter(Boolean).join('\n')
    : null

  // Cross-panel findings relevant to this panel
  const crossPanelContext = crossPanelAudit
    ? [
        ...(crossPanelAudit.repeatedPhrases || []).filter(r => r.panelA === panelId || r.panelB === panelId).map(r => `Cross-panel overlap with ${PANEL_LABELS[r.panelA === panelId ? r.panelB : r.panelA]} (${r.similarity * 100}% similarity): ${r.note}`),
        ...(crossPanelAudit.misplacedContentFindings || []).filter(f => f.includes(label)).map(f => `Misplaced content: ${f}`),
      ].join('\n')
    : null

  const systemPrompt = `You are refining ONE specific panel of a Stage 3 BU execution plan.

PANEL: ${label}
SCOPE: Refine ONLY this panel. Do not regenerate other panels. Do not erase source traceability.
DO NOT truncate any field. Do not produce placeholder text. Do not copy one field's content into another field.

${contract}

Return ONLY JSON matching this exact schema. No markdown, no prose, no code fences:
${schema}`

  const userPromptLines = [
    `Strategy spine context:\n${spineContext}`,
    `\nCurrent panel content:\n${currentJson}`,
  ]
  if (auditContext) userPromptLines.push(`\nCompleteness audit findings:\n${auditContext}`)
  if (crossPanelContext) userPromptLines.push(`\nCross-panel findings:\n${crossPanelContext}`)
  userPromptLines.push(`\nRefinement instruction:\n${prompt}`)
  if (impactSummary) userPromptLines.push(`Impact summary: ${impactSummary}`)
  userPromptLines.push(`\nRefine the "${label}" panel and return ONLY the updated JSON.`)

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPromptLines.join('\n') },
    ],
    systemPrompt,
  }
}

// ── Response parser ───────────────────────────────────────────────────────────

/**
 * Parse the AI response for a per-panel refinement.
 * For array panels, expects an array. For strategicObjective, expects an object.
 *
 * @param {string} panelId
 * @param {string} rawText
 * @returns {{ content: any|null, error: string|null }}
 */
export function parsePanelRefinementResponse(panelId, rawText) {
  if (!rawText?.trim()) return { content: null, error: 'Empty response from API.' }

  // strategicObjective: expect object
  if (panelId === 'strategicObjective') {
    const { parsed, error } = parseJsonObject(rawText)
    if (error) return { content: null, error }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { content: null, error: 'Expected an object for strategicObjective panel.' }
    return {
      content: {
        summary:              safeStr(parsed.summary),
        outcomeFocus:         safeStr(parsed.outcomeFocus),
        nonGoalsOrBoundaries: safeList(parsed.nonGoalsOrBoundaries),
      },
      error: null,
    }
  }

  // Array panels: find the outermost JSON array
  let raw = rawText.trim()
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) raw = fenceMatch[1].trim()
  const firstBracket = raw.indexOf('[')
  const lastBracket  = raw.lastIndexOf(']')
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    raw = raw.slice(firstBracket, lastBracket + 1)
  }

  let parsed
  try { parsed = JSON.parse(raw) } catch { return { content: null, error: 'Could not parse JSON array from response.' } }
  if (!Array.isArray(parsed)) return { content: null, error: `Expected an array for panel "${panelId}".` }

  return { content: parsed, error: null }
}

// Alias — generation uses the same parser as refinement
export const parsePanelGenerationResponse = parsePanelRefinementResponse

// ── BU context builder ────────────────────────────────────────────────────────

/**
 * Build a concise BU context string for panel generation.
 */
function buildBUContext(buSummary) {
  if (!buSummary) return 'No BU context available.'
  const lines = []
  if (buSummary.name) lines.push(`BU name: ${buSummary.name}`)
  if (buSummary.purpose) lines.push(`Purpose: ${truncateText(buSummary.purpose, 200)}`)
  if (buSummary.strategicInvolvement) lines.push(`Strategic involvement: ${truncateText(buSummary.strategicInvolvement, 200)}`)
  if (buSummary.involvementLevel) lines.push(`Involvement level: ${buSummary.involvementLevel}`)
  if (buSummary.keyResponsibilities?.length) lines.push(`Key responsibilities: ${safeList(buSummary.keyResponsibilities).slice(0, 5).join('; ')}`)
  if (buSummary.dependencies?.length) lines.push(`Stage 2 dependencies: ${safeList(buSummary.dependencies).slice(0, 4).join('; ')}`)
  if (buSummary.risksAndUnknowns?.length) lines.push(`Stage 2 risks/unknowns: ${safeList(buSummary.risksAndUnknowns).slice(0, 3).join('; ')}`)
  return lines.filter(Boolean).join('\n')
}

/**
 * Build a brief summary of already-accepted panels for cross-panel awareness.
 */
function buildAcceptedPanelsContext(panelId, panels) {
  if (!panels) return ''
  const lines = []
  const PANEL_ID_ORDER = ['strategicObjective', 'criticalDecisions', 'executionSequence', 'dependencies', 'risks', 'validationFramework']
  PANEL_ID_ORDER.forEach(pid => {
    if (pid === panelId) return // skip the panel being generated
    const p = panels[pid]
    if (!p?.content || p.lifecycle !== 'accepted') return
    const { PANEL_LABELS: PL } = { PANEL_LABELS: { strategicObjective: 'Strategic Objective', criticalDecisions: 'Critical Decisions', executionSequence: 'Execution Sequence', dependencies: 'Dependencies', risks: 'Risk & Mitigation', validationFramework: 'Validation Framework' } }
    if (pid === 'strategicObjective' && p.content?.summary) {
      lines.push(`Accepted Strategic Objective summary: ${truncateText(p.content.summary, 180)}`)
    } else if (Array.isArray(p.content) && p.content.length > 0) {
      const names = p.content.slice(0, 3).map(item =>
        item.decisionName || item.phaseName || item.dependencyName || item.riskName || item.validationQuestion || 'item'
      ).join(', ')
      lines.push(`Accepted ${PL[pid] || pid}: ${p.content.length} item(s) — ${names}`)
    }
  })
  return lines.length ? `\nAlready accepted panels:\n${lines.join('\n')}` : ''
}

// ── Panel generation prompt ───────────────────────────────────────────────────

/**
 * Build AI messages to generate a single panel from scratch.
 *
 * @param {string} panelId        - one of PANEL_IDS
 * @param {object} buSummary      - Stage 2 BU summary fields (name, purpose, responsibilities, etc.)
 * @param {string} s1Summary      - Stage 1 strategy context (thesis, opportunity, direction)
 * @param {object} panels         - current panelModel.panels (for cross-panel context from accepted panels)
 * @param {string} [generationHint] - optional user hint about what to focus on
 * @returns {{ messages: Array<{role, content}>, systemPrompt: string }}
 */
export function buildPanelGenerationMessages({ panelId, buSummary, s1Summary, panels = null, generationHint = '' }) {
  const label    = PANEL_LABELS[panelId] || panelId
  const contract = PANEL_CONTRACTS[panelId] || ''
  const schema   = PANEL_RESPONSE_SCHEMAS[panelId] || '{}'

  const buContext       = buildBUContext(buSummary)
  const acceptedContext = buildAcceptedPanelsContext(panelId, panels)

  const systemPrompt = `You are generating the "${label}" panel of a Stage 3 BU execution plan.

This is a FIRST-TIME GENERATION — produce complete, high-quality content. Do not produce placeholder text. Do not truncate any field mid-sentence or mid-word. Every required field must be fully populated with domain-specific content.

${contract}

Anti-repetition rules:
- Do not copy the same sentence into multiple fields.
- Each field must serve its stated role and only that role.
- Do not repeat content from the Strategic Objective verbatim.
- If cross-panel context is provided, do not duplicate it — complement it.

Return ONLY JSON matching this exact schema. No markdown, no prose, no code fences:
${schema}`

  const userLines = [
    `Stage 1 strategy context:\n${truncateText(s1Summary || 'No Stage 1 context available.', 600)}`,
    `\nBU context:\n${buContext}`,
  ]
  if (acceptedContext) userLines.push(acceptedContext)
  if (generationHint)  userLines.push(`\nGeneration focus: ${generationHint}`)
  userLines.push(`\nGenerate the "${label}" panel now. Return only the JSON.`)

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userLines.join('\n') },
    ],
    systemPrompt,
  }
}
