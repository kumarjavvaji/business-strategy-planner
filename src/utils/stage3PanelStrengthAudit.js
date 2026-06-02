/**
 * Stage 3 document-strength audit.
 *
 * Evaluates whether a panel is a STRONG strategy document section —
 * not merely structurally complete. Structural completeness (field presence,
 * non-truncation) is already handled by auditPanelCompleteness. This layer adds:
 *
 *   - Mechanical-text detection (generic consulting filler)
 *   - Parent-section alignment (each item must match its panel's role)
 *   - Specificity checks (content must be concrete and BU-relevant)
 *   - Downstream usefulness (Stage 4 needs gates, inputs, outputs — not option menus)
 *
 * Returns panelStrengthAudit — sits beside completenessAudit, does not replace it.
 *
 * Pure functions — no React, no side effects.
 */

// ── Status enum ───────────────────────────────────────────────────────────────

export const STRENGTH_STATUSES = {
  STRONG:   'strong',
  ADEQUATE: 'adequate',
  WEAK:     'weak',
  FAILED:   'failed',
}

// ── Mechanical-text patterns ──────────────────────────────────────────────────

/**
 * Named consulting-filler phrases that signal generic, reusable text rather than
 * content that is specific to this BU's strategy.
 */
const MECHANICAL_PHRASES = [
  { re: /\bbest\s+practices?\b/gi,                                   label: '"best practices" (unnamed — specify which practices)' },
  { re: /\bindustry\s+standards?\b/gi,                               label: '"industry standards" (unnamed — specify which standards)' },
  { re: /\bensure\s+alignment\b/gi,                                  label: '"ensure alignment" (unspecified — alignment on what, with whom?)' },
  { re: /\bstakeholder\s+(?:engagement|buy-?in|management)\b/gi,    label: '"stakeholder engagement/buy-in" (generic — name the stakeholders)' },
  { re: /\bdeliver(?:ing)?\s+value\b/gi,                            label: '"delivering value" (generic mission language)' },
  { re: /\bdrive\s+(?:value|growth|efficiency|results|innovation)\b/gi, label: '"drive value/growth/efficiency" (generic)' },
  { re: /\bworld[\s-]class\b/gi,                                     label: '"world-class" (superlative filler)' },
  { re: /\bholistic\s+approach\b/gi,                                 label: '"holistic approach" (generic)' },
  { re: /\brobust\s+(?:framework|solution|process|approach|strategy)\b/gi, label: '"robust framework/solution" (generic)' },
  { re: /\bseamlessly?\s+integrat/gi,                               label: '"seamlessly integrated" (generic integration language)' },
  { re: /\bleverage\s+(?:existing|synerg|our\s)/gi,                 label: '"leverage existing/synergies" (generic)' },
  { re: /\bproactive(?:ly)?\s+(?:manage|address|mitigat|identif)/gi, label: '"proactively manage/address" (generic)' },
]

/**
 * Weasel-word pattern — words that indicate a commitment was avoided.
 * Used to compute weasel density across sentences.
 */
const WEASEL_RE = /\b(could|may|might|should\s+consider|where\s+applicable|as\s+needed|as\s+appropriate|when\s+relevant|depending\s+on\s+context|as\s+required)\b/gi

/**
 * Method-category names that indicate the field is naming a technique
 * rather than committing to a specific action.
 * Checked against `recommendedHow` in executionSequence phases.
 */
const METHOD_CATEGORY_RE = /^(customer\s+discovery|expert\s+interview|stakeholder\s+interview|user\s+interview|structured\s+interview|survey\s+research|focus\s+group|user\s+research|ethnograph|prototype|proof\s+of\s+concept|poc\s+build|mvp\s+development|mvp\s+build|design\s+sprint|discovery\s+sprint|design\s+thinking|root\s+cause\s+analysis|fishbone|five\s+why|literature\s+review|desk\s+research|secondary\s+research|market\s+(?:analysis|research)|competitive\s+analysis|benchmarking|process\s+mining|value\s+stream|journey\s+mapping|a\/b\s+test|controlled\s+experiment|field\s+experiment|simulation|modeling|workshop|working\s+session|ideation\s+session|structured\s+analysis|quantitative\s+analysis|qualitative\s+analysis|mixed\s+method|gap\s+analysis|swot|heuristic|cognitive\s+walkthrough|card\s+sorting|tree\s+testing|usability\s+testing)/i

/**
 * Generic phase names that indicate method-library thinking
 * rather than an operating path specific to this BU.
 */
const GENERIC_PHASE_RE = /^(discovery|analysis|research|design|planning|pilot|scale|scaling|implementation|evaluation|assessment|validation|testing|review|definition|scoping|initiation|execution|monitoring|alignment|launch|deployment|operationalization|optimization|consolidation|ideation|exploration|synthesis|prototyping|investigation|exploration|define|plan|build|test|deploy|measure|iterate|reflect|kickoff|close[-\s]?out|wrap[\s-]?up)(\s+phase)?$/i

/**
 * Generic consequence phrases used in Dependencies / Risks panels.
 */
const GENERIC_CONSEQUENCE_RE = /\b(delays?\s+(?:the\s+)?(?:project|timeline|schedule|program)|blocks?\s+(?:progress|delivery|execution|work)|impacts?\s+(?:the\s+)?timeline|creates?\s+(?:a\s+)?(?:risk|delay|blocker)|puts\s+(?:the\s+)?(?:project|plan|initiative)\s+at\s+risk|jeopardizes\s+(?:delivery|timeline|success))\b/i

/**
 * Generic risk descriptions — failure modes that apply to any SaaS delivery
 * and therefore add no BU-specific insight.
 */
const GENERIC_RISK_RE = /\b(unclear\s+requirements?|resource\s+constraints?|stakeholder\s+misalignment|scope\s+creep|budget\s+overrun|timeline\s+(?:delays?|slippage|risk|pressure)|communication\s+breakdown|change\s+management\s+(?:resistance|challenges?)|organizational\s+(?:resistance|change|inertia)|team\s+(?:capacity|bandwidth|availability)|competing\s+priorities|technical\s+debt)\b/i

// ── Text helpers ──────────────────────────────────────────────────────────────

function safeStr(v) { return typeof v === 'string' ? v.trim() : '' }
function safeList(v) { return Array.isArray(v) ? v : [] }

/** Flatten content (object, array, string) to a single string for pattern matching. */
function flatText(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(flatText).join(' ')
  if (typeof value === 'object') return Object.values(value).map(flatText).join(' ')
  return String(value)
}

/** Count regex matches (resets lastIndex after each use). */
function countMatches(re, text) {
  re.lastIndex = 0
  let count = 0
  while (re.exec(text)) count++
  re.lastIndex = 0
  return count
}

/**
 * Fraction of sentences in `text` that contain weasel-word patterns.
 * Returns a number 0–1.
 */
export function weaselDensity(text) {
  if (!text) return 0
  const sentences = text.split(/[.!?;]\s+/).filter(s => s.trim().length > 10)
  if (sentences.length === 0) return 0
  WEASEL_RE.lastIndex = 0
  const weaselCount = sentences.filter(s => { WEASEL_RE.lastIndex = 0; return WEASEL_RE.test(s) }).length
  WEASEL_RE.lastIndex = 0
  return weaselCount / sentences.length
}

/**
 * Return an array of human-readable labels for mechanical phrases found in `text`.
 */
export function detectMechanicalPhrases(text) {
  if (!text) return []
  const found = []
  MECHANICAL_PHRASES.forEach(({ re, label }) => {
    re.lastIndex = 0
    if (re.test(text)) found.push(label)
    re.lastIndex = 0
  })
  return found
}

// ── Result builder ────────────────────────────────────────────────────────────

function result({ status, findings = [], mechanicalTextFindings = [], parentAlignmentFindings = [], specificityFindings = [], downstreamUsefulnessFindings = [], recommendedAction = '' }) {
  return {
    status,
    score: { strong: 100, adequate: 75, weak: 45, failed: 10 }[status] ?? 0,
    findings: [
      ...parentAlignmentFindings,
      ...specificityFindings,
      ...downstreamUsefulnessFindings,
      ...mechanicalTextFindings,
      ...findings,
    ],
    mechanicalTextFindings,
    parentAlignmentFindings,
    specificityFindings,
    downstreamUsefulnessFindings,
    recommendedAction,
    auditedAt: new Date().toISOString(),
  }
}

function signalStatus(signals, { adequate = 1, weak = 3, failed = 5 } = {}) {
  if (signals === 0)       return STRENGTH_STATUSES.STRONG
  if (signals <= adequate) return STRENGTH_STATUSES.ADEQUATE
  if (signals <= weak)     return STRENGTH_STATUSES.WEAK
  return STRENGTH_STATUSES.FAILED
}

// ── strategicObjective ────────────────────────────────────────────────────────

export function auditStrategicObjectiveStrength(content) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return result({ status: STRENGTH_STATUSES.FAILED, findings: ['Strategic Objective content is missing or not an object.'] })
  }

  const summary    = safeStr(content.summary)
  const outcome    = safeStr(content.outcomeFocus)
  const nonGoals   = safeList(content.nonGoalsOrBoundaries)
  const allText    = [summary, outcome].filter(Boolean).join(' ')

  const mechanicalTextFindings  = detectMechanicalPhrases(allText).slice(0, 3)
  const specificityFindings     = []
  const parentAlignmentFindings = []

  let signals = 0

  if (summary.length < 80) {
    signals++
    specificityFindings.push('summary is too brief to define strategic role, timing, and capability target (< 80 chars).')
  }

  // outcomeFocus is generic mission boilerplate
  if (outcome && /^(deliver\s+value|enable\s+growth|support\s+the\s+business|drive\s+(?:efficiency|innovation|growth|results)|create\s+value|provide\s+(?:support|value)|improve\s+(?:performance|outcomes?)|achieve\s+(?:business\s+)?(?:goals?|objectives?)|maximize\s+(?:value|impact))/i.test(outcome)) {
    signals++
    specificityFindings.push('outcomeFocus uses generic mission language without a specific capability, timing, or boundary.')
  }

  if (nonGoals.length === 0) {
    signals++
    parentAlignmentFindings.push('no nonGoalsOrBoundaries defined — execution scope is unbounded, reducing downstream usefulness.')
  }

  if (mechanicalTextFindings.length >= 2) signals++

  if (weaselDensity(allText) > 0.25) {
    signals++
    specificityFindings.push('excessive hedging language (could/may/might) — a strategic objective must commit.')
  }

  const status = signalStatus(signals, { adequate: 1, weak: 3, failed: 4 })

  return result({
    status,
    mechanicalTextFindings,
    specificityFindings,
    parentAlignmentFindings,
    recommendedAction: status === STRENGTH_STATUSES.STRONG || status === STRENGTH_STATUSES.ADEQUATE
      ? 'Strategic Objective is clear and bounded.'
      : 'Strengthen by adding specific capability target, execution boundary, and timing. Remove generic mission language.',
  })
}

// ── criticalDecisions ─────────────────────────────────────────────────────────

export function auditCriticalDecisionsStrength(content) {
  if (!Array.isArray(content) || content.length === 0) {
    return result({ status: STRENGTH_STATUSES.FAILED, findings: ['Critical Decisions content is missing or empty.'] })
  }

  const parentAlignmentFindings = []
  const specificityFindings     = []
  const mechanicalTextFindings  = detectMechanicalPhrases(flatText(content)).slice(0, 3)

  let taskLikeCount     = 0
  let genericTimingCount = 0
  let genericEvCount     = 0

  content.forEach((item, i) => {
    const q      = safeStr(item?.decisionQuestion)
    const timing = safeStr(item?.decisionTiming)
    const ev     = safeList(item?.decisionEvidenceNeeded)

    // Decision question sounds like a task (imperative verb that executes, not decides)
    if (q && /^(implement|build|develop|create|define\s+a|establish\s+a|deploy|run|execute|deliver|complete|prepare|set\s+up|configure|install|integrate|migrate|train|hire|procure|obtain|acquire|onboard)/i.test(q)) {
      taskLikeCount++
      parentAlignmentFindings.push(`criticalDecisions[${i}] "${q.slice(0, 55)}…" reads as a task or work item — Critical Decisions must be unresolved choices, not deliverables.`)
    }

    // decisionTiming is generic
    if (timing && /^(before\s+execution\s+begins|at\s+project\s+start|when\s+(?:needed|appropriate|ready)|as\s+appropriate|during\s+planning|at\s+kickoff|to\s+be\s+determined|tbd|early\s+in\s+the\s+project|soon)/i.test(timing)) {
      genericTimingCount++
      specificityFindings.push(`criticalDecisions[${i}].decisionTiming is generic — specify a sprint, phase, gate, or milestone.`)
    }

    // decisionEvidenceNeeded is generic single-word or vague phrases
    if (ev.length > 0 && ev.every(e => /^(data|analysis|research|input|information|feedback|evidence|review|assessment|evaluation|more\s+information|further\s+analysis)$/i.test(e.trim()) || e.trim().length < 20)) {
      genericEvCount++
      specificityFindings.push(`criticalDecisions[${i}].decisionEvidenceNeeded is generic — evidence must be a specific proof artifact, not "data" or "research".`)
    }
  })

  let signals = 0
  if (taskLikeCount > 0)                                            signals++
  if (taskLikeCount >= Math.ceil(content.length / 2))              signals++   // majority are tasks = extra signal
  if (genericTimingCount >= Math.ceil(content.length / 2))         signals++
  if (genericEvCount    >= Math.ceil(content.length / 2))          signals++
  if (mechanicalTextFindings.length >= 2)                          signals++

  const status = signalStatus(signals, { adequate: 1, weak: 3, failed: 5 })

  return result({
    status,
    mechanicalTextFindings,
    parentAlignmentFindings,
    specificityFindings,
    recommendedAction: status === STRENGTH_STATUSES.STRONG || status === STRENGTH_STATUSES.ADEQUATE
      ? 'Critical Decisions represent real unresolved choices.'
      : 'Replace tasks with actual choices. Each decision must state: what choice, what changes, what evidence, and when it gates execution.',
  })
}

// ── executionSequence ─────────────────────────────────────────────────────────

/**
 * Execution Sequence strength audit.
 *
 * A panel FAILS if it is a generic method library rather than a concrete
 * execution path for this BU. Strength requires committed actions, gates,
 * inputs, and outputs — not option menus.
 *
 * Detection signals:
 *   1. howOptions domination — ≥ 50% of phases have 2+ options (option menu, not path)
 *   2. recommendedHow is a method-category name, not an action
 *   3. Generic phase names matching consulting framework categories
 *   4. Short / generic phaseObjectives (< 60 chars on average)
 *   5. "when to use" language anywhere — option-menu framing
 *   6. High weasel density (> 20%) — commitment avoidance
 *   7. No gate/decision-point found across all phases
 *   8. No output/handoff artifact found across all phases
 */
export function auditExecutionSequenceStrength(content) {
  if (!Array.isArray(content) || content.length === 0) {
    return result({ status: STRENGTH_STATUSES.FAILED, findings: ['Execution Sequence content is missing or empty.'] })
  }

  const allText                  = flatText(content)
  const mechanicalTextFindings   = detectMechanicalPhrases(allText).slice(0, 4)
  const specificityFindings      = []
  const parentAlignmentFindings  = []
  const downstreamFindings       = []

  let signals = 0
  const MAX   = 8

  // Signal 1: howOptions domination
  const phasesWithOptions = content.filter(p => Array.isArray(p?.howOptions) && p.howOptions.length >= 2)
  if (phasesWithOptions.length >= Math.ceil(content.length / 2)) {
    signals++
    downstreamFindings.push(
      `${phasesWithOptions.length}/${content.length} phases present ≥ 2 howOptions — this is a method library, not a committed execution path. Stage 4 needs a chosen path, not an option menu.`
    )
  }

  // Signal 2: recommendedHow is a method-category noun
  const methodCategoryPhases = content.filter(p => METHOD_CATEGORY_RE.test(safeStr(p?.recommendedHow).split(/[,;]/)[0].trim()))
  if (methodCategoryPhases.length >= Math.ceil(content.length / 2)) {
    signals++
    specificityFindings.push(
      `${methodCategoryPhases.length}/${content.length} phases use a method-category name as recommendedHow (e.g. "Customer Discovery", "Expert Interviews"). Use a specific committed action instead.`
    )
  }

  // Signal 3: Generic phase names
  const genericPhases = content.filter(p => GENERIC_PHASE_RE.test(safeStr(p?.phaseName).trim()))
  if (genericPhases.length >= Math.ceil(content.length / 2)) {
    signals++
    parentAlignmentFindings.push(
      `${genericPhases.length}/${content.length} phase names are generic consulting categories (e.g. "Discovery", "Analysis", "Pilot"). Phase names must reflect this BU's actual operating sequence.`
    )
  }

  // Signal 4: Short / generic phaseObjectives
  const shortObjectives = content.filter(p => safeStr(p?.phaseObjective).length < 60)
  if (shortObjectives.length >= Math.ceil(content.length / 2)) {
    signals++
    specificityFindings.push(
      `${shortObjectives.length}/${content.length} phase objectives are too brief (< 60 chars). Each objective must name the operational purpose, what changes, and what gate this phase closes.`
    )
  }

  // Signal 5: "when to use" framing — structural (whenToUse key in howOptions) or literal text.
  // The whenToUse field name is the primary structural indicator; literal text catches it in
  // free-text fields.
  const hasWhenToUseField = content.some(p =>
    Array.isArray(p?.howOptions) && p.howOptions.some(opt => opt != null && 'whenToUse' in opt)
  )
  if (hasWhenToUseField || /when\s+to\s+use/i.test(allText)) {
    signals++
    downstreamFindings.push(
      '"when to use" / whenToUse field detected — option-menu framing. Each phase must commit to one specific approach, not list conditions for choosing among methods.'
    )
  }

  // Signal 6: High weasel density
  if (weaselDensity(allText) > 0.20) {
    signals++
    specificityFindings.push(
      'High hedging-word density (could/may/might) across phases — an execution sequence must commit to specific actions, not describe possibilities.'
    )
  }

  // Signal 7: No gate or decision point found
  const gateRE = /\b(gate|decision\s+point|sign[\s-]off|approval|before\s+(?:this\s+phase|proceeding|beginning)|in\s+order\s+to\s+begin|prerequisite|must\s+be\s+(?:confirmed|completed|approved|resolved))\b/i
  if (!gateRE.test(allText)) {
    signals++
    downstreamFindings.push(
      'No phase defines a gate or decision point. Stage 4 artifact generation depends on knowing what must be true before each phase proceeds.'
    )
  }

  // Signal 8: No output or handoff artifact found
  const outputRE = /\b(output|artifact|deliverable|handoff|produces?|results?\s+in|creates?|yields?)\b/i
  if (!outputRE.test(allText)) {
    signals++
    downstreamFindings.push(
      'No phase defines an output or handoff artifact. Stage 4 needs concrete outputs from each phase to generate the BU Execution Plan.'
    )
  }

  // Determine status — Execution Sequence is scored more strictly
  // because it is the most common source of generic content
  const status = signals === 0 ? STRENGTH_STATUSES.STRONG
    : signals <= 2             ? STRENGTH_STATUSES.ADEQUATE
    : signals <= 4             ? STRENGTH_STATUSES.WEAK
    : STRENGTH_STATUSES.FAILED

  const score = Math.round(100 * (1 - signals / MAX))

  return {
    status,
    score,
    findings: [...parentAlignmentFindings, ...specificityFindings, ...downstreamFindings, ...mechanicalTextFindings],
    mechanicalTextFindings,
    parentAlignmentFindings,
    specificityFindings,
    downstreamUsefulnessFindings: downstreamFindings,
    recommendedAction: status === STRENGTH_STATUSES.STRONG || status === STRENGTH_STATUSES.ADEQUATE
      ? 'Execution Sequence defines a concrete path with committed actions and gates.'
      : 'Convert from generic method library to concrete execution path: commit to one approach per phase, add gates, inputs, outputs, and BU-specific context. Remove or collapse howOptions option menus.',
    auditedAt: new Date().toISOString(),
  }
}

// ── dependencies ──────────────────────────────────────────────────────────────

export function auditDependenciesStrength(content) {
  if (!Array.isArray(content) || content.length === 0) {
    return result({ status: STRENGTH_STATUSES.FAILED, findings: ['Dependencies content is missing or empty.'] })
  }

  const parentAlignmentFindings = []
  const specificityFindings     = []
  const mechanicalTextFindings  = detectMechanicalPhrases(flatText(content)).slice(0, 3)

  let copyCount       = 0   // requiredInput ≈ dependencyDescription
  let genericConsequenceCount = 0
  let missingFunctionCount    = 0

  content.forEach((dep, i) => {
    const desc    = safeStr(dep?.dependencyDescription).toLowerCase()
    const req     = safeStr(dep?.requiredInput).toLowerCase()
    const consq   = safeStr(dep?.consequenceIfMissing)

    // requiredInput is a substring/near-copy of dependencyDescription
    if (desc && req && req.length > 10 && desc.includes(req.slice(0, Math.min(req.length, 40)))) {
      copyCount++
      specificityFindings.push(`dependencies[${i}].requiredInput is a copy/excerpt of dependencyDescription — requiredInput must be the specific deliverable noun phrase, not a restatement.`)
    }

    // consequenceIfMissing is a generic delivery-anxiety phrase
    if (consq && GENERIC_CONSEQUENCE_RE.test(consq)) {
      genericConsequenceCount++
      specificityFindings.push(`dependencies[${i}].consequenceIfMissing is generic ("${consq.slice(0, 50)}") — state the operational blocking condition, not a generic delivery delay.`)
    }

    // No function/team named anywhere in this dependency
    const depText = flatText(dep)
    if (!/\b(team|function|squad|group|org|engineering|design|product|finance|legal|compliance|ops|operations|platform|data|analytics|research|qa|security|devops|infra|executive|leadership|board|committee|council|cto|cpo|ceo|vp|director|manager|lead|owner)\b/i.test(depText)) {
      missingFunctionCount++
    }
  })

  let signals = 0
  if (copyCount >= Math.ceil(content.length / 2))              signals++
  if (genericConsequenceCount >= Math.ceil(content.length / 2)) signals++
  if (missingFunctionCount === content.length) {
    signals++
    parentAlignmentFindings.push('No dependency names a function, team, or owner. Each dependency must identify who provides the required input.')
  }
  if (mechanicalTextFindings.length >= 2) signals++

  const status = signalStatus(signals, { adequate: 1, weak: 2, failed: 4 })

  return result({
    status,
    mechanicalTextFindings,
    parentAlignmentFindings,
    specificityFindings,
    recommendedAction: status === STRENGTH_STATUSES.STRONG || status === STRENGTH_STATUSES.ADEQUATE
      ? 'Dependencies are concrete and ownership-aware.'
      : 'For each dependency: name the providing function, the specific deliverable noun phrase, the timing, and the concrete operational consequence if missed.',
  })
}

// ── risks ─────────────────────────────────────────────────────────────────────

export function auditRisksStrength(content) {
  if (!Array.isArray(content) || content.length === 0) {
    return result({ status: STRENGTH_STATUSES.FAILED, findings: ['Risk & Mitigation content is missing or empty.'] })
  }

  const parentAlignmentFindings = []
  const specificityFindings     = []
  const mechanicalTextFindings  = detectMechanicalPhrases(flatText(content)).slice(0, 3)

  let genericRiskCount    = 0
  let vagueMitigationCount = 0
  let vagueWarningCount    = 0

  content.forEach((r, i) => {
    const desc     = safeStr(r?.riskDescription)
    const mitigate = safeList(r?.mitigationOptions)
    const warning  = safeList(r?.earlyWarningSignals)

    // Risk description is a generic SaaS delivery anxiety
    if (desc && GENERIC_RISK_RE.test(desc)) {
      genericRiskCount++
      parentAlignmentFindings.push(`risks[${i}] "${r?.riskName || desc.slice(0, 40)}" is a generic delivery risk — describe the specific failure mode for this BU, not a universal SaaS delivery concern.`)
    }

    // Mitigations are generic status-meeting suggestions
    const mitigateText = mitigate.join(' ')
    if (mitigate.length > 0 && /\b(regular\s+(?:meetings?|check-?ins?|status\s+updates?)|stakeholder\s+communication|risk\s+register|escalat(?:ion)?\s+process|communication\s+plan)\b/i.test(mitigateText)) {
      vagueMitigationCount++
      specificityFindings.push(`risks[${i}].mitigationOptions uses generic mitigation language — mitigations must be specific to this risk's failure mode.`)
    }

    // Early warning signals are vague timeline concerns
    const warningText = warning.join(' ')
    if (warning.length > 0 && /\b(missed\s+(?:deadlines?|milestones?)|delayed\s+(?:timelines?|delivery)|team\s+concerns?|negative\s+feedback|lack\s+of\s+(?:progress|engagement))\b/i.test(warningText)) {
      vagueWarningCount++
      specificityFindings.push(`risks[${i}].earlyWarningSignals are generic — specify observable signals specific to this failure mode.`)
    }
  })

  let signals = 0
  if (genericRiskCount    >= Math.ceil(content.length / 2)) signals++
  if (vagueMitigationCount >= Math.ceil(content.length / 2)) signals++
  if (vagueWarningCount   >= Math.ceil(content.length / 2)) signals++
  if (mechanicalTextFindings.length >= 2)                   signals++

  const status = signalStatus(signals, { adequate: 1, weak: 2, failed: 4 })

  return result({
    status,
    mechanicalTextFindings,
    parentAlignmentFindings,
    specificityFindings,
    recommendedAction: status === STRENGTH_STATUSES.STRONG || status === STRENGTH_STATUSES.ADEQUATE
      ? 'Risk & Mitigation describes concrete failure modes with specific mitigations.'
      : 'Each risk must describe a BU-specific failure mode, not generic delivery anxiety. Mitigations must address this risk specifically.',
  })
}

// ── validationFramework ───────────────────────────────────────────────────────

export function auditValidationFrameworkStrength(content) {
  if (!Array.isArray(content) || content.length === 0) {
    return result({ status: STRENGTH_STATUSES.FAILED, findings: ['Validation Framework content is missing or empty.'] })
  }

  const parentAlignmentFindings = []
  const specificityFindings     = []
  const mechanicalTextFindings  = detectMechanicalPhrases(flatText(content)).slice(0, 3)

  // Check for boilerplate shared across validation items
  let boilerplateCount = 0
  let genericCriteriaCount = 0

  content.forEach((v, i) => {
    const criteria  = safeList(v?.completionCriteria)
    const evidence  = safeList(v?.evidenceExamples)
    const triggers  = safeList(v?.failureOrReworkTriggers)

    // Completion criteria are generic thresholds without specific measurement
    const criteriaText = criteria.join(' ')
    if (criteria.length > 0 && /\b(stakeholder\s+(?:sign-?off|approval)|management\s+approval|general\s+consensus|team\s+agreement|good\s+enough|satisfactory|sufficient\s+evidence|threshold\s+(?:is\s+)?met)\b/i.test(criteriaText)) {
      genericCriteriaCount++
      specificityFindings.push(`validationFramework[${i}].completionCriteria uses generic approval language — specify observable conditions specific to this question.`)
    }

    // Evidence examples don't connect to BU artifacts
    const evidenceText = evidence.join(' ')
    if (evidence.length > 0 && evidence.every(e => /^(survey\s+results?|interview\s+notes?|meeting\s+minutes?|status\s+report|presentation|feedback|data|analysis|documentation|evidence\s+of|proof\s+of)$/i.test(e.trim()) || e.trim().length < 25)) {
      boilerplateCount++
      specificityFindings.push(`validationFramework[${i}].evidenceExamples are generic document types, not specific artifacts from this plan.`)
    }

    // Failure/rework triggers are generic "if progress stalls" language
    const triggerText = triggers.join(' ')
    if (triggers.length > 0 && /\b(if\s+(?:progress|work)\s+stalls?|insufficient\s+quality|below\s+expectations?|team\s+(?:dissatisfied|unsatisfied)|stakeholder\s+(?:dissatisfied|not\s+satisfied))\b/i.test(triggerText)) {
      specificityFindings.push(`validationFramework[${i}].failureOrReworkTriggers are generic — specify conditions tied to this validation question's specific success criteria.`)
    }
  })

  let signals = 0
  if (boilerplateCount    >= Math.ceil(content.length / 2)) signals++
  if (genericCriteriaCount >= Math.ceil(content.length / 2)) signals++
  if (mechanicalTextFindings.length >= 2)                   signals++

  // Check if validation questions reference BU-specific context
  const questionsText = content.map(v => safeStr(v?.validationQuestion)).join(' ')
  const allText = flatText(content)
  if (weaselDensity(allText) > 0.25) {
    signals++
    specificityFindings.push('High hedging density in validation criteria — proof standards must be definitive, not conditional.')
  }

  const status = signalStatus(signals, { adequate: 1, weak: 2, failed: 3 })

  return result({
    status,
    mechanicalTextFindings,
    parentAlignmentFindings,
    specificityFindings,
    recommendedAction: status === STRENGTH_STATUSES.STRONG || status === STRENGTH_STATUSES.ADEQUATE
      ? 'Validation Framework defines concrete proof standards.'
      : 'Validation questions must connect to decisions, risks, and dependencies in this plan. Evidence examples should name specific artifacts, not generic document types.',
  })
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run document-strength audit for a single panel.
 *
 * @param {string} panelId - one of the Stage 3 panel IDs
 * @param {*}      content - the panel content (object for strategicObjective, array for others)
 * @returns panelStrengthAudit object
 */
export function auditPanelStrength(panelId, content) {
  // Panels with no content are not auditable for strength — skip gracefully.
  if (content == null || (Array.isArray(content) && content.length === 0)) {
    return result({
      status: STRENGTH_STATUSES.FAILED,
      findings: [`${panelId}: no content to audit for document strength.`],
      recommendedAction: 'Generate panel content before running strength audit.',
    })
  }

  switch (panelId) {
    case 'strategicObjective':  return auditStrategicObjectiveStrength(content)
    case 'criticalDecisions':   return auditCriticalDecisionsStrength(content)
    case 'executionSequence':   return auditExecutionSequenceStrength(content)
    case 'dependencies':        return auditDependenciesStrength(content)
    case 'risks':               return auditRisksStrength(content)
    case 'validationFramework': return auditValidationFrameworkStrength(content)
    default:
      return result({
        status: STRENGTH_STATUSES.ADEQUATE,
        findings: [`Unknown panel "${panelId}" — no strength rules defined. Passing as adequate.`],
        recommendedAction: 'Add strength rules for this panel type.',
      })
  }
}

/**
 * Whether a panel's strength audit blocks Stage 4 readiness.
 * Panels that are weak or failed are blocking; adequate and strong are not.
 */
export function strengthAuditBlocks(panelStrengthAudit) {
  if (!panelStrengthAudit) return false
  const { status } = panelStrengthAudit
  return status === STRENGTH_STATUSES.WEAK || status === STRENGTH_STATUSES.FAILED
}
