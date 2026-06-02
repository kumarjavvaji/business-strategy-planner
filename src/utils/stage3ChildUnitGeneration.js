/**
 * Atomic per-item panel generation for Stage 3.
 *
 * Root problem: Generating all items for Risk & Mitigation (5+ items),
 * Critical Decisions (3–5), or Validation Framework (3–4) in a single
 * model call regularly hits max_tokens, producing truncated JSON that
 * corrupts the whole panel.
 *
 * Solution: generate one item at a time. Each call is small enough to
 * complete reliably. Successful items are persisted immediately. A failed
 * item (max_tokens, parse error, empty response) is logged as a failed
 * child unit and can be retried independently without discarding the
 * items that already succeeded.
 *
 * Pure functions and a single async orchestrator — no React, no side effects
 * except through the callAI and onProgress callbacks.
 */

import { detectTruncation, PANEL_AUDIT_STATUSES } from './stage3PanelModel'

// ── Panel item configuration ──────────────────────────────────────────────────

/** Panels that use atomic generation (one item per AI call). */
export const ATOMIC_GENERATION_PANELS = new Set([
  'criticalDecisions',
  'executionSequence',
  'dependencies',
  'risks',
  'validationFramework',
])

/** strategicObjective uses a single AI call and is not atomic. */
export const SINGLE_CALL_PANELS = new Set(['strategicObjective'])

/** Default number of items to generate per panel when no override is given. */
export const DEFAULT_ITEM_COUNTS = {
  criticalDecisions:   3,
  executionSequence:   4,
  dependencies:        3,
  risks:               4,
  validationFramework: 3,
}

/** Named positions for execution phases — helps the AI generate coherent phased content. */
const EXECUTION_PHASE_NAMES = [
  'Problem & Outcome Validation',
  'Solution Path Evaluation',
  'Architecture & Delivery Readiness',
  'Pilot / Controlled Execution',
  'Scale Decision',
]

// ── Per-item authoring contracts (embedded in prompts) ────────────────────────

const ITEM_AUTHORING_CONTRACTS = {
  criticalDecisions: `AUTHORING CONTRACT — ONE Critical Decision item:
- decisionName: short unique name for this decision (distinct from other decisions listed above)
- decisionQuestion: THE SPECIFIC CHOICE to be made (not the consequence — max 1 sentence)
- whyItMatters: consequence if left unresolved (NOT the same sentence as decisionQuestion)
- decisionOptions: 2–4 concrete options
- decisionEvidenceNeeded: proof required to decide (NOT a restatement of the question or whyItMatters)
- decisionTiming: WHEN this must be decided — state a specific phase or gate, not generic boilerplate
RULE: decisionQuestion, whyItMatters, and decisionEvidenceNeeded MUST be distinct.`,

  executionSequence: `AUTHORING CONTRACT — ONE Execution Phase item:
- phaseName: the phase name provided in the context below
- phaseObjective: what this SPECIFIC phase achieves (unique to this phase)
- recommendedHow: the specific recommended validation or build method for this phase
- whyThisFitsThePhase: why this method fits THIS phase specifically — not generic
- exitCriteria: observable condition that ends this phase (specific, not boilerplate)
- evidenceExamples: 2–4 concrete evidence items specific to THIS phase — do not repeat the same list for every phase
- howOptions: 2–4 alternative methods for this phase; each option must include: optionName, whenToUse, whyItFitsThePhaseOutcome, evidenceProduced
RULE: evidenceExamples, exitCriteria, and howOptions must be unique to this phase.`,

  dependencies: `AUTHORING CONTRACT — ONE Dependency item:
- dependencyName: short unique name (distinct from other dependencies listed above)
- dependencyDescription: what the dependency IS — the full context sentence
- whyItMatters: gating or blocking consequence — MUST differ from dependencyDescription
- requiredInput: the specific deliverable NOUN PHRASE (short, NOT a full sentence)
- consequenceIfMissing: operational impact if not delivered on time (NOT the same as description or requiredInput)
RULE: dependencyDescription ≠ requiredInput ≠ consequenceIfMissing — each field must play a distinct role.`,

  risks: `AUTHORING CONTRACT — ONE Risk item:
- riskName: short unique name for this risk (distinct from other risks listed above)
- riskDescription: THE FAILURE MODE — what specifically breaks (not generic)
- whyItMatters: DOWNSTREAM CONSEQUENCE if this risk materializes (NOT the same as riskDescription)
- mitigationOptions: 2–3 specific mitigations tailored to this risk, not a generic library
- earlyWarningSignals: 2–3 observable signs this risk is activating
- evidenceThatRiskIsReduced: 2–3 items that would show this risk has been managed
RULE: riskDescription ≠ whyItMatters. Each risk item must have a DISTINCT failure mode from other risks.`,

  validationFramework: `AUTHORING CONTRACT — ONE Validation item:
- validationQuestion: what this specific check resolves
- completionCriteria: 2–3 specific observable conditions that close THIS question — unique to this question
- howToDetermineCompletion: 2–3 mechanism or process steps specific to this validation question
- evidenceExamples: 2–4 concrete evidence items specific to THIS question — MUST differ from other validation questions
- veracityChecks: 2–3 ways to confirm evidence is reliable — MUST differ from other validation questions
- failureOrReworkTriggers: 2–3 conditions that trigger a rework loop for THIS question specifically
RULE: evidenceExamples, veracityChecks, and failureOrReworkTriggers MUST be distinct from other validation items.`,
}

const ITEM_SCHEMAS = {
  criticalDecisions: `{
  "decisionName": "string",
  "decisionQuestion": "string — the specific choice",
  "whyItMatters": "string — consequence if unresolved (NOT same as question)",
  "decisionOptions": ["string — concrete option"],
  "decisionEvidenceNeeded": ["string — proof required (NOT restatement of question or whyItMatters)"],
  "decisionTiming": "string — when to decide (specific gate or phase)"
}`,
  executionSequence: `{
  "phaseName": "string — use the phase name provided in context",
  "phaseObjective": "string — what this phase achieves",
  "recommendedHow": "string — specific method",
  "whyThisFitsThePhase": "string — why this method fits this phase (not generic)",
  "exitCriteria": "string — observable condition specific to this phase",
  "evidenceExamples": ["string — evidence specific to this phase"],
  "howOptions": [
    { "optionName": "string", "whenToUse": "string", "whyItFitsThePhaseOutcome": "string", "evidenceProduced": "string" }
  ]
}`,
  dependencies: `{
  "dependencyName": "string — short unique name",
  "dependencyDescription": "string — what the dependency IS",
  "whyItMatters": "string — gating consequence (NOT same as description)",
  "requiredInput": "string — specific deliverable noun phrase (NOT a sentence)",
  "consequenceIfMissing": "string — operational impact (NOT same as description or requiredInput)"
}`,
  risks: `{
  "riskName": "string — unique risk name",
  "riskDescription": "string — the specific failure mode",
  "whyItMatters": "string — downstream consequence (NOT same as riskDescription)",
  "mitigationOptions": ["string — specific mitigation action"],
  "earlyWarningSignals": ["string — observable activation sign"],
  "evidenceThatRiskIsReduced": ["string — what shows risk is managed"]
}`,
  validationFramework: `{
  "validationQuestion": "string — what this check resolves",
  "completionCriteria": ["string — specific to this question"],
  "howToDetermineCompletion": ["string — mechanism specific to this question"],
  "evidenceExamples": ["string — evidence specific to THIS question"],
  "veracityChecks": ["string — specific to this question"],
  "failureOrReworkTriggers": ["string — rework trigger specific to this question"]
}`,
}

/** Field used as the display name for each item type. */
const ITEM_NAME_FIELD = {
  criticalDecisions:   'decisionName',
  executionSequence:   'phaseName',
  dependencies:        'dependencyName',
  risks:               'riskName',
  validationFramework: 'validationQuestion',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeStr(v) { return typeof v === 'string' ? v.trim() : String(v ?? '').trim() }
function safeList(v) { return Array.isArray(v) ? v.map(safeStr).filter(Boolean) : [] }
function truncate(text, max = 300) {
  const s = safeStr(text)
  return s.length > max ? s.slice(0, max).trim() + '...' : s
}

function parseJsonObject(rawText) {
  if (!rawText?.trim()) return { parsed: null, error: 'Empty response.' }
  let s = rawText.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) s = fence[1].trim()
  const firstBrace = s.indexOf('{')
  const lastBrace  = s.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) s = s.slice(firstBrace, lastBrace + 1)
  try { return { parsed: JSON.parse(s), error: null } }
  catch { return { parsed: null, error: 'Could not parse JSON object from response.' } }
}

// ── Child unit ID ─────────────────────────────────────────────────────────────

export function childUnitId(panelId, index) {
  return `${panelId}__unit_${index}`
}

// ── Prompt builder ────────────────────────────────────────────────────────────

/**
 * Build AI messages for one child unit (single item in a panel).
 *
 * @param {string} panelId
 * @param {number} itemIndex       - 0-based index of this item
 * @param {number} totalItems      - total number of items expected in this panel
 * @param {object} buSummary       - { name, purpose, strategicInvolvement, ... }
 * @param {string} s1Summary       - Stage 1 context string
 * @param {object[]} completedItems - already-generated items (content only, for uniqueness guidance)
 * @param {string} [hint]          - optional generation hint / focus
 */
export function buildChildUnitMessages({ panelId, itemIndex, totalItems, buSummary, s1Summary, completedItems = [], hint = '' }) {
  const schema   = ITEM_SCHEMAS[panelId]
  const contract = ITEM_AUTHORING_CONTRACTS[panelId]
  const nameField = ITEM_NAME_FIELD[panelId]
  if (!schema) throw new Error(`No child unit schema for panel "${panelId}"`)

  const ordinal = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'][itemIndex] || `item ${itemIndex + 1}`
  const alreadyNamed = completedItems
    .map(item => item?.[nameField])
    .filter(Boolean)
    .slice(0, 10)

  // For execution sequence, tell the AI exactly which phase to generate
  const phaseHint = panelId === 'executionSequence'
    ? `\nPhase to generate: "${EXECUTION_PHASE_NAMES[itemIndex] || `Phase ${itemIndex + 1}`}"`
    : ''

  const systemPrompt = `You are generating item ${itemIndex + 1} of ${totalItems} for the ${panelId.replace(/([A-Z])/g, ' $1').toLowerCase()} panel of a Stage 3 BU execution plan.

This is a single-item call. Return ONLY ONE JSON object — not an array, not multiple items.

${contract}

Anti-repetition:
- This item must be DISTINCT from all already-generated items listed below.
- Every field must serve its stated role and only that role.
- Do NOT truncate any field. Do NOT end a sentence mid-word. Complete every field fully.
- Do NOT produce placeholder text.

Return ONLY the JSON object matching this schema. No markdown, no prose, no code fences:
${schema}`

  const contextLines = [
    `BU name: ${safeStr(buSummary?.name || 'Unknown BU')}`,
    buSummary?.purpose ? `BU purpose: ${truncate(buSummary.purpose, 200)}` : null,
    buSummary?.strategicInvolvement ? `Strategic role: ${truncate(buSummary.strategicInvolvement, 200)}` : null,
    buSummary?.keyResponsibilities?.length ? `Key responsibilities: ${safeList(buSummary.keyResponsibilities).slice(0, 4).join('; ')}` : null,
    s1Summary ? `\nStrategy context:\n${truncate(s1Summary, 400)}` : null,
    phaseHint,
    alreadyNamed.length ? `\nAlready generated (avoid repeating these names or failure modes):\n${alreadyNamed.map((n, i) => `  ${i + 1}. ${n}`).join('\n')}` : null,
    hint ? `\nGeneration focus: ${hint}` : null,
  ].filter(Boolean).join('\n')

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: `${contextLines}\n\nGenerate the ${ordinal} item now. Return only the JSON object.` },
    ],
    systemPrompt,
  }
}

// ── Response parser ───────────────────────────────────────────────────────────

/**
 * Parse the AI response for one child unit item.
 * Returns { item: object|null, error: string|null }.
 */
export function parseChildUnitResponse(panelId, rawText) {
  if (!rawText?.trim()) return { item: null, error: 'Empty response from API.' }

  // Detect array-wrapped responses before trying to extract the object.
  // If the AI returns [{ ... }], reject it — each call must produce exactly one item.
  let s = rawText.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) s = fence[1].trim()
  const firstBracket = s.indexOf('[')
  const firstBrace   = s.indexOf('{')
  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
    return { item: null, error: `Expected a single JSON object for "${panelId}" item, but response appears to be an array.` }
  }

  const { parsed, error } = parseJsonObject(rawText)
  if (error || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { item: null, error: error || `Expected a single JSON object for "${panelId}" item.` }
  }
  return { item: parsed, error: null }
}

// ── Single-item audit ─────────────────────────────────────────────────────────

/**
 * Quick completeness check on a single panel item.
 * Returns { status, truncatedFields, missingFields }.
 */
export function auditChildUnit(panelId, item) {
  if (!item || typeof item !== 'object') {
    return { status: PANEL_AUDIT_STATUSES.INCOMPLETE, truncatedFields: [], missingFields: ['item is null or not an object'] }
  }

  const truncatedFields = []
  const missingFields   = []

  function checkField(fieldKey, value, minLength = 0) {
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) {
      missingFields.push(fieldKey)
      return
    }
    const strVal = typeof value === 'string' ? value : (Array.isArray(value) ? value.join(' ') : String(value))
    const trunc = detectTruncation(strVal, minLength)
    if (trunc.truncated) truncatedFields.push(`${fieldKey}: ${trunc.reasons[0]}`)
  }

  switch (panelId) {
    case 'criticalDecisions':
      checkField('decisionName',          item.decisionName,          5)
      checkField('decisionQuestion',      item.decisionQuestion,      30)
      checkField('whyItMatters',          item.whyItMatters,          30)
      checkField('decisionEvidenceNeeded',item.decisionEvidenceNeeded, 0)
      checkField('decisionTiming',        item.decisionTiming,        15)
      break
    case 'executionSequence':
      checkField('phaseName',             item.phaseName,             5)
      checkField('phaseObjective',        item.phaseObjective,        40)
      checkField('recommendedHow',        item.recommendedHow,        20)
      checkField('exitCriteria',          item.exitCriteria,          25)
      break
    case 'dependencies':
      checkField('dependencyName',        item.dependencyName,        5)
      checkField('dependencyDescription', item.dependencyDescription, 40)
      checkField('requiredInput',         item.requiredInput,         15)
      checkField('consequenceIfMissing',  item.consequenceIfMissing,  20)
      break
    case 'risks':
      checkField('riskName',              item.riskName,              5)
      checkField('riskDescription',       item.riskDescription,       40)
      checkField('whyItMatters',          item.whyItMatters,          30)
      checkField('mitigationOptions',     item.mitigationOptions,      0)
      checkField('earlyWarningSignals',   item.earlyWarningSignals,    0)
      break
    case 'validationFramework':
      checkField('validationQuestion',    item.validationQuestion,    30)
      checkField('completionCriteria',    item.completionCriteria,     0)
      checkField('evidenceExamples',      item.evidenceExamples,       0)
      checkField('failureOrReworkTriggers', item.failureOrReworkTriggers, 0)
      break
    default:
      break
  }

  const status = truncatedFields.length > 0
    ? PANEL_AUDIT_STATUSES.TRUNCATED
    : missingFields.length > 0
      ? PANEL_AUDIT_STATUSES.INCOMPLETE
      : PANEL_AUDIT_STATUSES.COMPLETE

  return { status, truncatedFields, missingFields }
}

// ── Child unit record ─────────────────────────────────────────────────────────

/** Create a new child unit record. */
export function createChildUnit(panelId, index, overrides = {}) {
  return {
    unitId:       childUnitId(panelId, index),
    panelId,
    index,
    status:       'not_started',
    content:      null,
    audit:        null,
    error:        null,
    prompt:       null,
    generatedAt:  null,
    ...overrides,
  }
}

/** Produce a complete list of child unit records for a panel. */
export function initChildUnits(panelId, totalItems) {
  return Array.from({ length: totalItems }, (_, i) => createChildUnit(panelId, i))
}

// ── Determine truncation from API response ────────────────────────────────────

/**
 * Returns a reason string if the API response indicates the model was cut off
 * (stop_reason: max_tokens / length), or null if the response finished normally.
 */
export function apiStopReasonTruncation(response) {
  const stop = String(response?.stopReason || response?.stop_reason || response?.finishReason || response?.finish_reason || '').toLowerCase()
  if (stop === 'max_tokens' || stop === 'length') return 'Truncated model output (stop_reason: max_tokens)'
  if (response?.incomplete || response?.truncated) return 'Truncated model output'
  return null
}

// ── Atomic panel generation orchestrator ─────────────────────────────────────

/**
 * Generate all items of a panel one at a time, preserving successful items
 * when later items fail.
 *
 * @param {object} options
 * @param {string}   options.panelId
 * @param {object}   options.buSummary          - BU context (name, purpose, …)
 * @param {string}   options.s1Summary          - Stage 1 context text
 * @param {object}   [options.existingPanels]   - panel map for cross-panel awareness
 * @param {object[]} [options.existingChildUnits] - prior child units (to skip already-accepted)
 * @param {number}   [options.totalItems]        - overrides DEFAULT_ITEM_COUNTS
 * @param {Function} options.callAI              - async (messages) => response
 * @param {Function} [options.onChildUnitStart]   - (index, totalItems) => void
 * @param {Function} [options.onChildUnitComplete]- (index, content, audit) => void
 * @param {Function} [options.onChildUnitFailed]  - (index, error, isTruncation) => void
 * @param {string}   [options.hint]              - optional generation hint
 *
 * @returns {{ completedUnits, failedUnits, skippedUnits, assembledContent, allChildUnits }}
 */
export async function generatePanelAtomically({
  panelId,
  buSummary,
  s1Summary,
  existingPanels = null,
  existingChildUnits = [],
  totalItems,
  callAI,
  onChildUnitStart   = () => {},
  onChildUnitComplete = () => {},
  onChildUnitFailed  = () => {},
  hint = '',
}) {
  if (!ATOMIC_GENERATION_PANELS.has(panelId)) {
    throw new Error(`Panel "${panelId}" does not use atomic generation.`)
  }

  const count = totalItems ?? DEFAULT_ITEM_COUNTS[panelId] ?? 3
  const completedUnits = []
  const failedUnits    = []
  const skippedUnits   = []
  const allChildUnits  = initChildUnits(panelId, count)

  for (let i = 0; i < count; i++) {
    // Skip if this index already has an accepted child unit from a prior generation
    const prior = existingChildUnits.find(u => u.index === i && u.status === 'accepted')
    if (prior) {
      completedUnits.push({ index: i, content: prior.content, audit: prior.audit })
      allChildUnits[i] = { ...prior }
      skippedUnits.push(i)
      continue
    }

    onChildUnitStart(i, count)
    allChildUnits[i] = { ...allChildUnits[i], status: 'generating', generatedAt: new Date().toISOString() }

    try {
      const { messages, systemPrompt } = buildChildUnitMessages({
        panelId,
        itemIndex: i,
        totalItems: count,
        buSummary,
        s1Summary,
        completedItems: completedUnits.map(u => u.content),
        hint,
      })

      const response = await callAI(messages)

      // Check for truncation before parsing
      const truncationReason = apiStopReasonTruncation(response)
      const rawText = response?.result || response?.content || response?.text || ''

      if (response?.error || response?.rateLimited) {
        const error = response.error || 'API rate limited.'
        allChildUnits[i] = { ...allChildUnits[i], status: 'failed', error, prompt: systemPrompt }
        failedUnits.push({ index: i, error, isTruncation: false })
        onChildUnitFailed(i, error, false)
        continue
      }

      if (truncationReason || !rawText.trim()) {
        const error = truncationReason || 'Empty response from API.'
        allChildUnits[i] = { ...allChildUnits[i], status: 'failed', error, prompt: systemPrompt }
        failedUnits.push({ index: i, error, isTruncation: true })
        onChildUnitFailed(i, error, true)
        continue
      }

      const { item, error: parseError } = parseChildUnitResponse(panelId, rawText)
      if (parseError || !item) {
        const error = parseError || 'Could not parse item response.'
        allChildUnits[i] = { ...allChildUnits[i], status: 'failed', error, prompt: systemPrompt }
        failedUnits.push({ index: i, error, isTruncation: false })
        onChildUnitFailed(i, error, false)
        continue
      }

      const audit = auditChildUnit(panelId, item)
      if (audit.status === PANEL_AUDIT_STATUSES.TRUNCATED) {
        const error = `Generated item has truncated fields: ${audit.truncatedFields.join(', ')}`
        allChildUnits[i] = { ...allChildUnits[i], status: 'failed', error, content: item, audit, prompt: systemPrompt }
        failedUnits.push({ index: i, error, isTruncation: true })
        onChildUnitFailed(i, error, true)
        continue
      }

      allChildUnits[i] = {
        ...allChildUnits[i],
        status:      audit.status === PANEL_AUDIT_STATUSES.INCOMPLETE ? 'needs_refinement' : 'draft_ready',
        content:     item,
        audit,
        prompt:      systemPrompt,
        generatedAt: new Date().toISOString(),
      }
      completedUnits.push({ index: i, content: item, audit })
      onChildUnitComplete(i, item, audit)

    } catch (err) {
      const error = `Child unit ${i} failed: ${err?.message || String(err)}`
      allChildUnits[i] = { ...allChildUnits[i], status: 'failed', error }
      failedUnits.push({ index: i, error, isTruncation: false })
      onChildUnitFailed(i, error, false)
    }
  }

  // Assemble panel content from completed (non-failed) units, sorted by index
  const assembledContent = completedUnits
    .sort((a, b) => a.index - b.index)
    .map(u => u.content)

  return { completedUnits, failedUnits, skippedUnits, assembledContent, allChildUnits }
}

// ── Retry a single failed child unit ─────────────────────────────────────────

/**
 * Retry a single failed child unit without regenerating the rest.
 * Returns the updated child unit record, or null if still failing.
 */
export async function retryChildUnit({
  panelId,
  index,
  buSummary,
  s1Summary,
  siblingsContent,   // content from successful sibling units (for uniqueness guidance)
  callAI,
  hint = '',
}) {
  const count = DEFAULT_ITEM_COUNTS[panelId] ?? 3

  try {
    const { messages, systemPrompt } = buildChildUnitMessages({
      panelId,
      itemIndex: index,
      totalItems: count,
      buSummary,
      s1Summary,
      completedItems: siblingsContent,
      hint,
    })

    const response = await callAI(messages)
    const truncationReason = apiStopReasonTruncation(response)
    const rawText = response?.result || response?.content || response?.text || ''

    if (response?.error || response?.rateLimited || truncationReason || !rawText.trim()) {
      const error = response?.error || truncationReason || 'Empty response.'
      return createChildUnit(panelId, index, {
        status:  'failed',
        error,
        prompt:  systemPrompt,
        generatedAt: new Date().toISOString(),
      })
    }

    const { item, error: parseError } = parseChildUnitResponse(panelId, rawText)
    if (parseError || !item) {
      return createChildUnit(panelId, index, {
        status:  'failed',
        error:   parseError || 'Parse error.',
        prompt:  systemPrompt,
        generatedAt: new Date().toISOString(),
      })
    }

    const audit = auditChildUnit(panelId, item)
    if (audit.status === PANEL_AUDIT_STATUSES.TRUNCATED) {
      return createChildUnit(panelId, index, {
        status:  'failed',
        error:   `Truncated fields: ${audit.truncatedFields.join(', ')}`,
        content: item,
        audit,
        prompt:  systemPrompt,
        generatedAt: new Date().toISOString(),
      })
    }

    return createChildUnit(panelId, index, {
      status:      audit.status === PANEL_AUDIT_STATUSES.INCOMPLETE ? 'needs_refinement' : 'draft_ready',
      content:     item,
      audit,
      prompt:      systemPrompt,
      generatedAt: new Date().toISOString(),
    })
  } catch (err) {
    return createChildUnit(panelId, index, {
      status:  'failed',
      error:   `Retry failed: ${err?.message || String(err)}`,
      generatedAt: new Date().toISOString(),
    })
  }
}
