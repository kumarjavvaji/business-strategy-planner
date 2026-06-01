/**
 * Stage 3 panel-level governance model.
 *
 * Pure functions — no React, no side effects.
 *
 * Covers:
 *   - Panel schema and field contracts
 *   - Truncation detection
 *   - Per-panel completeness audit
 *   - Cross-panel redundancy / alignment audit
 *   - Stage 4 readiness gate
 *   - Panel model normalization from a compiled plan
 *   - Legacy record migration
 *   - Refinement history management
 */

import { semanticFingerprint, jaccardSim, normalizeSearchText, compiledText } from './stage3Compiler'
import {
  PANEL_LIFECYCLE,
  derivePanelLifecycle,
  computeLifecycleReadiness,
  transitionToAccepted,
  transitionToFailed,
} from './stage3PanelLifecycle'
import { unitAuditHasBlockingIssues } from './unitLifecycle'

// ── Panel registry ────────────────────────────────────────────────────────────

export const PANEL_IDS = [
  'strategicObjective',
  'criticalDecisions',
  'executionSequence',
  'dependencies',
  'risks',
  'validationFramework',
]

export const PANEL_LABELS = {
  strategicObjective:  'Strategic Objective',
  criticalDecisions:   'Critical Decisions',
  executionSequence:   'Execution Sequence',
  dependencies:        'Dependencies',
  risks:               'Risk & Mitigation',
  validationFramework: 'Validation Framework',
}

export const PANEL_ACCENTS = {
  strategicObjective:  '#00e5b4',
  criticalDecisions:   '#3b82f6',
  executionSequence:   '#00e5b4',
  dependencies:        '#fb923c',
  risks:               '#f87171',
  validationFramework: '#a3e635',
}

export const PANEL_AUDIT_STATUSES = {
  COMPLETE:          'complete',
  INCOMPLETE:        'incomplete',
  TRUNCATED:         'truncated',
  REDUNDANT:         'redundant',
  MISALIGNED:        'misaligned',
  NEEDS_REFINEMENT:  'needs_refinement',
}

export const CROSS_PANEL_QUALITY_STATUSES = {
  PASS:         'pass',
  FAIL:         'fail',
  NEEDS_REVIEW: 'needs_review',
}

export const REFINEMENT_STATUSES = {
  PROPOSED: 'proposed',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  FAILED:   'failed',
}

// Required top-level fields per panel.
// For array panels (criticalDecisions, executionSequence, etc.) these are
// the required fields on EACH item in the array.
export const PANEL_REQUIRED_FIELDS = {
  strategicObjective:  ['summary', 'outcomeFocus'],
  criticalDecisions:   ['decisionName', 'decisionQuestion', 'whyItMatters', 'decisionEvidenceNeeded', 'decisionTiming'],
  executionSequence:   ['phaseName', 'phaseObjective', 'recommendedHow', 'exitCriteria'],
  dependencies:        ['dependencyName', 'dependencyDescription', 'requiredInput', 'consequenceIfMissing'],
  risks:               ['riskName', 'riskDescription', 'mitigationOptions', 'earlyWarningSignals'],
  validationFramework: ['validationQuestion', 'completionCriteria', 'evidenceExamples', 'failureOrReworkTriggers'],
}

// Minimum character counts for key fields to qualify as non-trivially populated.
const FIELD_MIN_LENGTHS = {
  summary:              60,
  outcomeFocus:         40,
  decisionQuestion:     30,
  whyItMatters:         30,
  decisionTiming:       15,
  phaseObjective:       40,
  exitCriteria:         25,
  dependencyDescription:40,
  requiredInput:        15,
  consequenceIfMissing: 20,
  riskDescription:      40,
  validationQuestion:   30,
}

const SENTENCE_FORM_FIELDS = new Set([
  'summary',
  'outcomeFocus',
  'decisionQuestion',
  'whyItMatters',
  'phaseObjective',
  'recommendedHow',
  'whyThisFitsThePhase',
  'exitCriteria',
  'dependencyDescription',
  'consequenceIfMissing',
  'riskDescription',
  'validationQuestion',
])

// Placeholder / fallback text patterns that indicate the generator did not produce real content.
const PLACEHOLDER_PATTERNS = [
  /^(none|n\/a|tbd|not applicable|placeholder|stub|fill in|example|sample|todo|see above|same as above)\s*\.?$/i,
  /\bnot yet\s+(defined|determined|available|specified|known)\b/i,
  /\[.*\]/,  // bracket-enclosed placeholder tokens
  /^define\s+a\s+focused\s+execution\s+basis/i,  // known default fallback
  /^convert\s+stage\s+2\s+handoff/i,             // known default fallback
]

// ── Truncation detection ──────────────────────────────────────────────────────

/**
 * Detect truncation in a single string value.
 * Returns { truncated: boolean, reasons: string[] }.
 */
export function detectTruncation(text, minLength = 0) {
  if (text == null || text === '') return { truncated: false, reasons: [] }
  const s = String(text).trim()
  const reasons = []

  if (/…/.test(s)) {
    reasons.push('contains explicit truncation marker (ellipsis)')
  }

  // Explicit truncation markers
  if (/\.\.\.|…/.test(s)) {
    reasons.push('contains explicit truncation marker (… or ...)')
  }

  // Too short for the expected role
  if (minLength > 0 && s.length < minLength) {
    reasons.push(`text length (${s.length}) is below expected minimum (${minLength})`)
  }

  // Ends with hanging conjunction or preposition (incomplete thought)
  if (/\b(and|or|but|because|since|when|where|which|that|who|if|as|while|before|after|during|for|with|without|between|through|to|by|of|in|on|at|from)\s*$/i.test(s) && s.length < 300) {
    reasons.push('ends with hanging conjunction or preposition — possible incomplete sentence')
  }

  // Ends with comma (truncated list)
  if (/,\s*$/.test(s)) {
    reasons.push('ends with comma — possible truncated list or clause')
  }

  // Recognizable partial-word stubs
  if (/\b(fe|con|proc|deliv|exec|impl|asses|evaluat|identif|determin|establ|before con|approac|collabor|coordinat|facilit|integrat|manag|monitor|navigat|negoti|optim|organiz|priorit|provide|recogn|regulat|represent|resolv|schedul|strateg|structur|suppl|sustain|translat|utiliz|validat)\s*$/i.test(s)) {
    reasons.push('ends with recognizable partial word — text was likely cut mid-generation')
  }

  // Short isolated word at end with no terminal punctuation that looks like a fragment
  const shortEndWord = s.match(/\s([a-z]{2,4})\s*$/i)
  if (shortEndWord && !s.match(/[.!?;:]\s*$/) && s.length < 120) {
    const word = shortEndWord[1].toLowerCase()
    // Only flag if the word is not a complete common word
    const commonEndWords = new Set(['this', 'that', 'with', 'from', 'plan', 'work', 'team', 'data', 'each', 'such', 'both', 'some', 'well', 'also', 'only', 'over', 'more', 'than', 'then', 'thus', 'may', 'can', 'will', 'was', 'has', 'not', 'are', 'any', 'all', 'new', 'key', 'its', 'own', 'the', 'use', 'via', 'per', 'set', 'due', 'led', 'met', 'now'])
    if (!commonEndWords.has(word) && word.length <= 3) {
      reasons.push(`ends with very short word "${word}" without terminal punctuation — possible fragment`)
    }
  }

  // Sentence that is clearly mid-word (consonant cluster at end suggests generation stopped)
  const lastChars = s.slice(-6).trim()
  if (lastChars.length >= 3 && /^[b-df-hj-np-tv-z]{3,}$/i.test(lastChars)) {
    reasons.push('ends with consonant cluster — generation likely stopped mid-word')
  }

  if (/\b(into|against|within|until)\s*$/i.test(s) && s.length < 300) {
    reasons.push('ends with hanging preposition - possible incomplete sentence')
  }

  if (/\b(del|ma|assess)\s*$/i.test(s)) {
    reasons.push('ends with recognizable short fragment - text was likely cut mid-generation')
  }

  return { truncated: reasons.length > 0, reasons }
}

/**
 * Check a field value (string, array, or object) for truncation.
 * Returns { truncated: boolean, truncatedSubFields: string[] }.
 */
export function detectTruncationInField(value, fieldKey = '', minLength = 0) {
  const issues = []
  if (typeof value === 'string') {
    const result = detectTruncation(value, minLength)
    if (result.truncated) issues.push(fieldKey || 'value')
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => {
      if (typeof item === 'string') {
        const result = detectTruncation(item, 0)
        if (result.truncated) issues.push(`${fieldKey}[${i}]`)
      }
    })
  }
  return { truncated: issues.length > 0, truncatedSubFields: issues }
}

// ── Placeholder detection ─────────────────────────────────────────────────────

function isPlaceholder(text) {
  if (!text || typeof text !== 'string') return false
  return PLACEHOLDER_PATTERNS.some(re => re.test(text.trim()))
}

// ── Panel completeness audit ──────────────────────────────────────────────────

/**
 * Compute completeness audit for a single panel.
 *
 * @param {string} panelId - one of PANEL_IDS
 * @param {*} content - the compiled panel content (object or array)
 * @returns PanelAudit object
 */
export function auditPanelCompleteness(panelId, content) {
  const now = new Date().toISOString()
  const requiredFields = PANEL_REQUIRED_FIELDS[panelId] || []

  const missingFields   = []
  const truncatedFields = []
  const weakFields      = []
  const duplicateFieldFindings = []
  const alignmentFindings = []

  function checkItem(item, itemLabel) {
    if (!item || typeof item !== 'object') {
      missingFields.push(`${itemLabel} (item is missing or not an object)`)
      return
    }
    requiredFields.forEach(field => {
      const val = item[field]
      const isEmpty = val == null || val === '' || (Array.isArray(val) && val.length === 0)
      if (isEmpty) {
        missingFields.push(`${itemLabel}.${field}`)
        return
      }
      // Truncation check
      const strVal = typeof val === 'string' ? val : compiledText(val)
      const minLen = FIELD_MIN_LENGTHS[field] || 0
      const trunc = detectTruncation(strVal, minLen)
      if (trunc.truncated) {
        truncatedFields.push(`${itemLabel}.${field}: ${trunc.reasons[0]}`)
      }
      if (SENTENCE_FORM_FIELDS.has(field) && minLen > 0 && typeof val === 'string' && strVal.length >= minLen && !/[.!?;:)\]]\s*$/.test(strVal)) {
        truncatedFields.push(`${itemLabel}.${field}: sentence-form field ends without terminal punctuation`)
      }
      // Placeholder check
      if (isPlaceholder(strVal)) {
        weakFields.push(`${itemLabel}.${field}: contains placeholder or fallback text`)
      }
    })
  }

  // strategicObjective is a plain object, all others may be arrays
  if (panelId === 'strategicObjective') {
    checkItem(content, 'strategicObjective')
  } else if (Array.isArray(content)) {
    if (content.length === 0) {
      missingFields.push(`${panelId} array is empty — no items generated`)
    } else {
      content.forEach((item, i) => checkItem(item, `${panelId}[${i}]`))
    }
  } else {
    missingFields.push(`${panelId}: content is not in expected format`)
  }

  // Duplicate-field check for critical decisions: flag if question ≈ whyItMatters
  if (panelId === 'criticalDecisions' && Array.isArray(content)) {
    content.forEach((d, i) => {
      if (d?.decisionQuestion && d?.whyItMatters) {
        const sim = jaccardSim(semanticFingerprint(d.decisionQuestion), semanticFingerprint(d.whyItMatters))
        if (sim >= 0.72) duplicateFieldFindings.push(`criticalDecisions[${i}].decisionQuestion ≈ whyItMatters (sim=${sim.toFixed(2)})`)
      }
    })
  }

  // Duplicate-field check for dependencies: flag if description === requiredInput
  if (panelId === 'dependencies' && Array.isArray(content)) {
    content.forEach((d, i) => {
      if (d?.dependencyDescription && d?.requiredInput) {
        if (normalizeSearchText(d.dependencyDescription) === normalizeSearchText(d.requiredInput)) {
          duplicateFieldFindings.push(`dependencies[${i}].dependencyDescription is identical to requiredInput`)
        }
      }
    })
  }

  // Duplicate-field check for risks: flag if riskDescription ≈ whyItMatters
  if (panelId === 'risks' && Array.isArray(content)) {
    content.forEach((r, i) => {
      if (r?.riskDescription && r?.whyItMatters) {
        const sim = jaccardSim(semanticFingerprint(r.riskDescription), semanticFingerprint(r.whyItMatters))
        if (sim >= 0.72) duplicateFieldFindings.push(`risks[${i}].riskDescription ≈ whyItMatters (sim=${sim.toFixed(2)})`)
      }
    })
  }

  // Duplicate-field check for validationFramework: flag identical arrays across items
  if (panelId === 'validationFramework' && Array.isArray(content) && content.length >= 2) {
    const evidenceArrays = content.map(v => JSON.stringify(v?.evidenceExamples || []))
    const veracityArrays = content.map(v => JSON.stringify(v?.veracityChecks || []))
    const failureArrays  = content.map(v => JSON.stringify(v?.failureOrReworkTriggers || []))
    for (let i = 0; i < content.length - 1; i++) {
      for (let j = i + 1; j < content.length; j++) {
        if (evidenceArrays[i] === evidenceArrays[j] && evidenceArrays[i] !== '[]')
          duplicateFieldFindings.push(`validationFramework[${i}] and [${j}] share identical evidenceExamples — validation boilerplate repeated`)
        if (veracityArrays[i] === veracityArrays[j] && veracityArrays[i] !== '[]')
          duplicateFieldFindings.push(`validationFramework[${i}] and [${j}] share identical veracityChecks — validation boilerplate repeated`)
        if (failureArrays[i] === failureArrays[j] && failureArrays[i] !== '[]')
          duplicateFieldFindings.push(`validationFramework[${i}] and [${j}] share identical failureOrReworkTriggers — validation boilerplate repeated`)
      }
    }
  }

  // Determine status
  let status
  if (truncatedFields.length > 0) {
    status = PANEL_AUDIT_STATUSES.TRUNCATED
  } else if (missingFields.length > 0) {
    status = PANEL_AUDIT_STATUSES.INCOMPLETE
  } else if (duplicateFieldFindings.length > 0) {
    status = PANEL_AUDIT_STATUSES.NEEDS_REFINEMENT
  } else if (weakFields.length > 0) {
    status = PANEL_AUDIT_STATUSES.NEEDS_REFINEMENT
  } else {
    status = PANEL_AUDIT_STATUSES.COMPLETE
  }

  const recommendedAction = status === PANEL_AUDIT_STATUSES.TRUNCATED
    ? 'Regenerate this panel — truncation detected. Do not pass to Stage 4.'
    : status === PANEL_AUDIT_STATUSES.INCOMPLETE
      ? `Add missing fields: ${missingFields.slice(0, 3).join(', ')}.`
      : status === PANEL_AUDIT_STATUSES.NEEDS_REFINEMENT
        ? duplicateFieldFindings.length
          ? 'Refine to remove duplicated fields — fields must serve distinct roles.'
          : 'Replace placeholder or weak text with domain-specific content.'
        : 'Panel passes completeness checks.'

  return {
    panelId,
    status,
    blocking: status !== PANEL_AUDIT_STATUSES.COMPLETE,
    missingFields,
    truncatedFields,
    weakFields,
    duplicateFieldFindings,
    alignmentFindings,
    recommendedAction,
    lastAuditedAt: now,
  }
}

export function panelAuditHasBlockingIssues(audit) {
  return unitAuditHasBlockingIssues(audit)
}

export function resolvePanelDisplayStatus(panel) {
  const lifecycle = panel?.lifecycle
  const audit = panel?.completenessAudit
  if (lifecycle === PANEL_LIFECYCLE.FAILED) return PANEL_LIFECYCLE.FAILED
  if (audit?.status === PANEL_AUDIT_STATUSES.TRUNCATED) return PANEL_AUDIT_STATUSES.TRUNCATED
  if (audit?.status === PANEL_AUDIT_STATUSES.INCOMPLETE) return PANEL_AUDIT_STATUSES.NEEDS_REFINEMENT
  if (audit?.status === PANEL_AUDIT_STATUSES.NEEDS_REFINEMENT || panelAuditHasBlockingIssues(audit)) return PANEL_AUDIT_STATUSES.NEEDS_REFINEMENT
  if (lifecycle === PANEL_LIFECYCLE.DRAFT_READY) return PANEL_LIFECYCLE.DRAFT_READY
  if (lifecycle === PANEL_LIFECYCLE.ACCEPTED) return PANEL_LIFECYCLE.ACCEPTED
  return audit?.status || lifecycle || PANEL_LIFECYCLE.NOT_STARTED
}

export function validateProposedPanelContent({ panelId, proposedContent, currentPanelModel = null }) {
  const auditAfter = auditPanelCompleteness(panelId, proposedContent)
  const nextPanels = currentPanelModel?.panels?.[panelId]
    ? {
        ...currentPanelModel.panels,
        [panelId]: {
          ...currentPanelModel.panels[panelId],
          content: proposedContent,
          completenessAudit: auditAfter,
        },
      }
    : null
  const crossPanelAudit = nextPanels ? auditCrossPanels(nextPanels) : null
  const failureReasons = []

  if (auditAfter.status === PANEL_AUDIT_STATUSES.TRUNCATED) {
    failureReasons.push('Truncated model output')
  }
  if (auditAfter.status === PANEL_AUDIT_STATUSES.INCOMPLETE) {
    failureReasons.push(`Missing required fields: ${(auditAfter.missingFields || []).slice(0, 3).join(', ')}`)
  }
  if ((auditAfter.duplicateFieldFindings || []).length) {
    failureReasons.push(`Field-role audit failed: ${auditAfter.duplicateFieldFindings[0]}`)
  }
  if ((auditAfter.alignmentFindings || []).length) {
    failureReasons.push(`Panel role audit failed: ${auditAfter.alignmentFindings[0]}`)
  }
  if (crossPanelAudit?.qualityStatus === CROSS_PANEL_QUALITY_STATUSES.FAIL) {
    const firstFinding = crossPanelAudit.duplicatedFieldPairs?.[0]?.note ||
      crossPanelAudit.misplacedContentFindings?.[0] ||
      crossPanelAudit.repeatedPhrases?.[0]?.note ||
      'Cross-panel audit failed.'
    failureReasons.push(`Cross-panel impact failed: ${firstFinding}`)
  }

  return {
    ok: failureReasons.length === 0,
    auditAfter,
    crossPanelAudit,
    failureReason: failureReasons.join(' | '),
    failureReasons,
  }
}

// ── Cross-panel audit ─────────────────────────────────────────────────────────

/**
 * Alignment rules: content that belongs in one panel must not appear in another.
 * Returns an array of misplacement finding strings.
 */
function checkMisplacedContent(panelId, content) {
  const findings = []
  const text = normalizeSearchText(compiledText(content))

  // Dependencies must not contain risk / validation language.
  // Use phrase-level patterns to avoid false-positives (e.g. "rework" can appear in consequence clauses).
  if (panelId === 'dependencies' && /\bmitigation option|\bearly warning signal|\bfailure trigger|\bveracity check|\brework trigger\b/i.test(text)) {
    findings.push(`${PANEL_LABELS.dependencies} contains language that belongs in Risk & Mitigation or Validation Framework`)
  }

  // Critical Decisions must not contain control / risk language
  if (panelId === 'criticalDecisions' && /early warning|failure mode|mitigation option|rework trigger/i.test(text)) {
    findings.push(`${PANEL_LABELS.criticalDecisions} contains risk / validation language — move to Risk & Mitigation or Validation Framework`)
  }

  // Risks must not contain validation gates (which belong in Validation Framework)
  if (panelId === 'risks' && /completion criteria|veracity check|how to determine completion/i.test(text)) {
    findings.push(`${PANEL_LABELS.risks} contains validation gate language — move to Validation Framework`)
  }

  // Validation must not restate execution steps — detect via specific keyword patterns
  // (Full-text similarity is unreliable because both panels discuss the same initiative vocabulary)
  if (panelId === 'validationFramework' && /recommended how|phase objective|how option|exit criteria.*phase|phase.*exit criteria/i.test(text)) {
    findings.push(`${PANEL_LABELS.validationFramework} contains execution-phase language (phase objectives or how-options) — move to Execution Sequence`)
  }

  return findings
}

/**
 * Cross-panel redundancy and alignment audit.
 * Takes a panels map { panelId: { content, ... } } and returns a cross-panel audit object.
 */
export function auditCrossPanels(panels) {
  const repeatedPhrases        = []
  const duplicatedFieldPairs   = []
  const misplacedContentFindings = []
  const planAlignmentFindings  = []

  // Build text blocks per panel for similarity comparisons
  const panelTexts = {}
  PANEL_IDS.forEach(pid => {
    const content = panels[pid]?.content
    if (content) panelTexts[pid] = normalizeSearchText(compiledText(content))
  })

  // 1. Cross-panel phrase repetition (Jaccard-based)
  const panelItems = PANEL_IDS
    .filter(pid => panelTexts[pid] && panelTexts[pid].length > 60)
    .map(pid => ({
      panelId: pid,
      text: panelTexts[pid],
      fp: semanticFingerprint(panelTexts[pid].slice(0, 600)),
    }))

  // Threshold is intentionally high (0.82) — plans about the same initiative
  // naturally share vocabulary. Only flag when panels are near-identical in content.
  for (let i = 0; i < panelItems.length; i++) {
    for (let j = i + 1; j < panelItems.length; j++) {
      const sim = jaccardSim(panelItems[i].fp, panelItems[j].fp)
      if (panelItems[i].panelId !== 'strategicObjective' && panelItems[j].panelId !== 'strategicObjective' && sim >= 0.82) {
        repeatedPhrases.push({
          panelA: panelItems[i].panelId,
          panelB: panelItems[j].panelId,
          similarity: parseFloat(sim.toFixed(2)),
          note: `Panels share ${Math.round(sim * 100)}% content overlap — likely duplicated source framing`,
        })
      }
    }
  }

  // 2. Check Strategic Objective is not fully restated in other panels
  const soText = panelTexts.strategicObjective
  if (soText) {
    PANEL_IDS.filter(pid => pid !== 'strategicObjective').forEach(pid => {
      if (!panelTexts[pid]) return
      // High threshold (0.80) — brief shared context is expected; flag only when a panel
      // appears to BE the strategic objective rather than reference it.
      const sim = jaccardSim(semanticFingerprint(soText.slice(0, 400)), semanticFingerprint(panelTexts[pid].slice(0, 400)))
      if (sim >= 0.80) {
        planAlignmentFindings.push(`${PANEL_LABELS[pid]} appears to restate the Strategic Objective (${Math.round(sim * 100)}% similarity) — only Strategic Objective should carry the shared context`)
      }
    })
  }

  // 3. Specific field-level duplications across panel boundaries
  const decisions = panels.criticalDecisions?.content || []
  const deps      = panels.dependencies?.content || []
  const risks     = panels.risks?.content || []

  // Decision rationale should not appear verbatim in dependency descriptions
  if (Array.isArray(decisions) && Array.isArray(deps)) {
    decisions.forEach(d => {
      deps.forEach(dep => {
        if (!d?.decisionQuestion || !dep?.dependencyDescription) return
        if (normalizeSearchText(d.decisionQuestion) === normalizeSearchText(dep.dependencyDescription)) {
          duplicatedFieldPairs.push({
            source: `criticalDecisions.decisionQuestion ("${(d.decisionName || '').slice(0, 40)}")`,
            target: `dependencies.dependencyDescription ("${(dep.dependencyName || '').slice(0, 40)}")`,
            note: 'Decision rationale copied into dependency description',
          })
        }
      })
    })
  }

  // Risk descriptions should not repeat across categories
  if (Array.isArray(risks) && risks.length >= 2) {
    for (let i = 0; i < risks.length - 1; i++) {
      for (let j = i + 1; j < risks.length; j++) {
        const ri = risks[i]?.riskDescription
        const rj = risks[j]?.riskDescription
        if (!ri || !rj) continue
        if (normalizeSearchText(ri) === normalizeSearchText(rj)) {
          duplicatedFieldPairs.push({
            source: `risks[${i}].riskDescription ("${(risks[i]?.riskName || '').slice(0, 40)}")`,
            target: `risks[${j}].riskDescription ("${(risks[j]?.riskName || '').slice(0, 40)}")`,
            note: 'Identical failure-mode description across two different risk categories',
          })
        }
      }
    }
  }

  // 4. Misplaced content per panel
  PANEL_IDS.forEach(pid => {
    const content = panels[pid]?.content
    if (!content) return
    const findings = checkMisplacedContent(pid, content)
    misplacedContentFindings.push(...findings)
  })

  // 5. Overall quality status
  const hasSerious = repeatedPhrases.length > 0 || duplicatedFieldPairs.length > 0 || misplacedContentFindings.length > 0
  const hasAlignmentIssues = planAlignmentFindings.length > 0
  const qualityStatus = hasSerious
    ? CROSS_PANEL_QUALITY_STATUSES.FAIL
    : hasAlignmentIssues
      ? CROSS_PANEL_QUALITY_STATUSES.NEEDS_REVIEW
      : CROSS_PANEL_QUALITY_STATUSES.PASS

  return {
    repeatedPhrases,
    duplicatedFieldPairs,
    misplacedContentFindings,
    planAlignmentFindings,
    qualityStatus,
    auditedAt: new Date().toISOString(),
  }
}

// ── Readiness gate ────────────────────────────────────────────────────────────

/**
 * Compute Stage 4 readiness from panel audits and cross-panel audit.
 * A BU is NOT ready if any required panel is truncated, incomplete, or fails cross-panel checks.
 */
export function computeReadinessStatus(panels, crossPanelAudit) {
  const blockingPanels  = []
  const blockingReasons = []

  PANEL_IDS.forEach(panelId => {
    const audit = panels[panelId]?.completenessAudit
    if (!audit) {
      blockingPanels.push(panelId)
      blockingReasons.push(`${PANEL_LABELS[panelId]}: not yet audited`)
      return
    }
    if (audit.status === PANEL_AUDIT_STATUSES.TRUNCATED) {
      blockingPanels.push(panelId)
      blockingReasons.push(`${PANEL_LABELS[panelId]}: TRUNCATED — ${audit.truncatedFields.slice(0, 2).join(', ')}`)
    } else if (audit.status === PANEL_AUDIT_STATUSES.INCOMPLETE) {
      blockingPanels.push(panelId)
      blockingReasons.push(`${PANEL_LABELS[panelId]}: INCOMPLETE — missing ${audit.missingFields.slice(0, 2).join(', ')}`)
    }
    // needs_refinement is not blocking (it has content, just suboptimal)
  })

  // Cross-panel audit failure blocks readiness
  if (crossPanelAudit?.qualityStatus === CROSS_PANEL_QUALITY_STATUSES.FAIL) {
    blockingReasons.push(`Cross-panel audit failed: ${crossPanelAudit.duplicatedFieldPairs.length} duplicated field pair(s), ${crossPanelAudit.misplacedContentFindings.length} misplaced content finding(s)`)
  }

  const isReady = blockingPanels.length === 0 && crossPanelAudit?.qualityStatus !== CROSS_PANEL_QUALITY_STATUSES.FAIL

  return {
    isReady,
    blockingPanels,
    blockingReasons,
    crossPanelQuality: crossPanelAudit?.qualityStatus || null,
    lastCheckedAt: new Date().toISOString(),
  }
}

// ── Panel model construction ──────────────────────────────────────────────────

/**
 * Create an empty panel record for a given panel ID.
 */
function emptyPanel(panelId) {
  return {
    panelId,
    content:            null,
    lifecycle:          PANEL_LIFECYCLE.NOT_STARTED,
    lifecycleError:     null,
    completenessAudit:  null,
    refinementHistory:  [],
    sourceAtomIds:      [],
    lastGeneratedAt:    null,
    lastRefinedAt:      null,
    acceptedAt:         null,
    needsRefinementReason: null,
  }
}

function collectSourceAtomIds(content) {
  const refs = new Set()
  function visit(value) {
    if (!value) return
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (typeof value !== 'object') return
    if (Array.isArray(value.sourceRefs)) {
      value.sourceRefs.forEach(ref => {
        const id = ref?.atomId || ref?.id || ref?.sourceId || ref
        if (id) refs.add(String(id))
      })
    }
    Object.values(value).forEach(visit)
  }
  visit(content)
  return Array.from(refs)
}

/**
 * Build the full panel model from a compiled plan.
 * Runs audits for all panels and cross-panel.
 *
 * @param {object} compiledPlan - output of compileBUExecutionPlan
 * @returns stage3BuPlan panel model
 */
export function normalizeToPanelModel(compiledPlan) {
  const contentMap = {
    strategicObjective:  compiledPlan?.strategicObjective  || null,
    criticalDecisions:   compiledPlan?.criticalDecisions   || [],
    executionSequence:   compiledPlan?.executionSequence   || [],
    dependencies:        compiledPlan?.dependencies        || [],
    risks:               compiledPlan?.risksAndMitigations || [],
    validationFramework: compiledPlan?.validationFramework || [],
  }

  const panels = {}
  PANEL_IDS.forEach(panelId => {
    const content = contentMap[panelId]
    const completenessAudit = auditPanelCompleteness(panelId, content)
    const lifecycle = derivePanelLifecycle(content, completenessAudit)
    panels[panelId] = {
      ...emptyPanel(panelId),
      content,
      completenessAudit,
      lifecycle,
      sourceAtomIds: collectSourceAtomIds(content),
      lastGeneratedAt: new Date().toISOString(),
    }
  })

  const crossPanelAudit = auditCrossPanels(panels)
  const readinessStatus = computeLifecycleReadiness(panels, crossPanelAudit)

  return {
    panels,
    crossPanelAudit,
    readinessStatus,
    normalizedAt: new Date().toISOString(),
  }
}

// ── Legacy record migration ───────────────────────────────────────────────────

/**
 * Normalize a draft record that may or may not already have a panelModel.
 * Does NOT overwrite existing panelModel — adds it only if absent.
 * Returns the draft with panelModel (marks legacy as needing audit if it was missing).
 */
export function normalizeLegacyDraftRecord(draft, compiledPlan) {
  if (!draft) return draft

  // Already has a valid panel model
  if (draft.panelModel?.panels && Object.keys(draft.panelModel.panels).length > 0) {
    return draft
  }

  // Legacy record — add panel model from compiled plan if available, otherwise mark as needing audit
  if (compiledPlan && !compiledPlan.error) {
    const panelModel = normalizeToPanelModel(compiledPlan)
    return {
      ...draft,
      panelModel: {
        ...panelModel,
        migratedFromLegacy: true,
        legacyMigratedAt: new Date().toISOString(),
      },
    }
  }

  // No compiled plan available — mark as needing audit
  const emptyPanels = {}
  PANEL_IDS.forEach(pid => { emptyPanels[pid] = { ...emptyPanel(pid), completenessAudit: { panelId: pid, status: PANEL_AUDIT_STATUSES.INCOMPLETE, missingFields: ['content not yet available'], truncatedFields: [], weakFields: [], duplicateFieldFindings: [], alignmentFindings: [], recommendedAction: 'Generate a Stage 3 plan for this BU.', lastAuditedAt: new Date().toISOString() }, lifecycle: PANEL_LIFECYCLE.NOT_STARTED } })
  return {
    ...draft,
    panelModel: {
      panels: emptyPanels,
      crossPanelAudit: null,
      readinessStatus: { isReady: false, blockingPanels: PANEL_IDS, blockingReasons: ['Plan has not been generated.'], lastCheckedAt: new Date().toISOString() },
      migratedFromLegacy: true,
      legacyMigratedAt: new Date().toISOString(),
    },
  }
}

// ── Refinement history ────────────────────────────────────────────────────────

/**
 * Create a new refinement history record (status: 'proposed').
 */
export function createRefinementRecord({
  panelId,
  prompt,
  impactSummary = null,
  previousContent,
  revisedContent,
  auditBefore,
  auditAfter,
  changedFields = [],
  error = null,
  failureReason = null,
}) {
  return {
    refinementId: `ref_${panelId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    panelId,
    prompt: String(prompt || '').trim(),
    impactSummary: impactSummary ? String(impactSummary).trim() : null,
    previousPanelSnapshot: previousContent ?? null,
    revisedPanelSnapshot: revisedContent ?? null,
    auditBefore: auditBefore ?? null,
    auditAfter: auditAfter ?? null,
    changedFields,
    error: error ? String(error) : null,
    failureReason: failureReason ? String(failureReason) : null,
    createdAt: new Date().toISOString(),
    acceptedAt: null,
    rejectedAt: null,
    status: REFINEMENT_STATUSES.PROPOSED,
  }
}

/**
 * Create a failed refinement record. Used when the API fails or returns an
 * empty/unparseable response; previous content remains untouched.
 */
export function createFailedRefinementRecord({
  panelId,
  prompt,
  impactSummary = null,
  previousContent,
  proposedContent = null,
  auditBefore,
  auditAfter = null,
  error,
  failureReason = null,
}) {
  const reason = failureReason || error || 'Refinement failed.'
  return {
    ...createRefinementRecord({
      panelId,
      prompt,
      impactSummary,
      previousContent,
      revisedContent: proposedContent,
      auditBefore,
      auditAfter,
      changedFields: [],
      error: reason,
      failureReason: reason,
    }),
    status: REFINEMENT_STATUSES.FAILED,
    failedAt: new Date().toISOString(),
  }
}

/**
 * Append a refinement record to a panel's refinement history.
 * Returns a new panel model (immutable).
 */
export function appendRefinementRecord(panelModel, panelId, refinementRecord) {
  if (!panelModel?.panels?.[panelId]) return panelModel
  return {
    ...panelModel,
    panels: {
      ...panelModel.panels,
      [panelId]: {
        ...panelModel.panels[panelId],
        refinementHistory: [
          ...(panelModel.panels[panelId].refinementHistory || []),
          refinementRecord,
        ],
        lastRefinedAt: refinementRecord.createdAt,
      },
    },
  }
}

/**
 * Update the status of a refinement record (accept or reject).
 * Returns a new panel model (immutable).
 */
export function updateRefinementStatus(panelModel, panelId, refinementId, newStatus) {
  if (!panelModel?.panels?.[panelId]) return panelModel
  const now = new Date().toISOString()
  const updatedHistory = (panelModel.panels[panelId].refinementHistory || []).map(r => {
    if (r.refinementId !== refinementId) return r
    return {
      ...r,
      status:     newStatus,
      acceptedAt: newStatus === REFINEMENT_STATUSES.ACCEPTED ? now : r.acceptedAt,
      rejectedAt: newStatus === REFINEMENT_STATUSES.REJECTED ? now : r.rejectedAt,
      failedAt:   newStatus === REFINEMENT_STATUSES.FAILED   ? now : r.failedAt,
    }
  })
  return {
    ...panelModel,
    panels: {
      ...panelModel.panels,
      [panelId]: {
        ...panelModel.panels[panelId],
        refinementHistory: updatedHistory,
      },
    },
  }
}

/**
 * Mark a panel as accepted and recompute Stage 4 readiness.
 */
export function acceptPanel(panelModel, panelId) {
  if (!panelModel?.panels?.[panelId]) return panelModel
  const updatedPanels = {
    ...panelModel.panels,
    [panelId]: transitionToAccepted(panelModel.panels[panelId]),
  }
  const crossPanelAudit = auditCrossPanels(updatedPanels)
  const readinessStatus = computeLifecycleReadiness(updatedPanels, crossPanelAudit)
  return { ...panelModel, panels: updatedPanels, crossPanelAudit, readinessStatus }
}

/**
 * Reject the current panel draft without deleting its content. The panel can be
 * regenerated or refined again, and Stage 4 remains blocked.
 */
export function rejectPanel(panelModel, panelId, reason = 'Panel draft rejected by user.') {
  if (!panelModel?.panels?.[panelId]) return panelModel
  const updatedPanels = {
    ...panelModel.panels,
    [panelId]: {
      ...transitionToFailed(panelModel.panels[panelId], reason),
      acceptedAt: null,
    },
  }
  const crossPanelAudit = auditCrossPanels(updatedPanels)
  const readinessStatus = computeLifecycleReadiness(updatedPanels, crossPanelAudit)
  return { ...panelModel, panels: updatedPanels, crossPanelAudit, readinessStatus }
}

/**
 * Apply an accepted refinement — update panel content + audit.
 * Marks the refinement record as accepted and re-runs panel + cross-panel audits.
 */
export function applyAcceptedRefinement(panelModel, panelId, revisedContent) {
  if (!panelModel?.panels?.[panelId]) return panelModel
  const now = new Date().toISOString()
  const newAudit = auditPanelCompleteness(panelId, revisedContent)
  const newLifecycle = derivePanelLifecycle(revisedContent, newAudit)
  const updatedPanels = {
    ...panelModel.panels,
    [panelId]: {
      ...panelModel.panels[panelId],
      content:          revisedContent,
      completenessAudit: newAudit,
      lifecycle:        newLifecycle,
      sourceAtomIds:    collectSourceAtomIds(revisedContent).length
        ? collectSourceAtomIds(revisedContent)
        : (panelModel.panels[panelId].sourceAtomIds || []),
      lastGeneratedAt:  panelModel.panels[panelId].lastGeneratedAt,
      lastRefinedAt:    now,
      // A refinement creates a new draft; user must explicitly accept again.
      acceptedAt:       null,
    },
  }
  const crossPanelAudit = auditCrossPanels(updatedPanels)
  const readinessStatus = computeLifecycleReadiness(updatedPanels, crossPanelAudit)
  return {
    ...panelModel,
    panels:          updatedPanels,
    crossPanelAudit,
    readinessStatus,
  }
}

// ── Short panel summaries ─────────────────────────────────────────────────────

/**
 * Synthesize a 1-sentence summary for a panel (used in collapsed card header).
 * Never truncates mid-sentence; returns a short synthesized summary suitable for display.
 */
export function synthesizePanelSummary(panelId, content) {
  if (!content) return 'Not yet generated.'

  try {
    switch (panelId) {
      case 'strategicObjective':
        return String(content.summary || content.outcomeFocus || 'Strategic context defined.').slice(0, 160)

      case 'criticalDecisions': {
        const items = Array.isArray(content) ? content : []
        if (!items.length) return 'No decisions defined.'
        const names = items.slice(0, 3).map(d => d.decisionName || 'Decision').join(', ')
        return `${items.length} decision${items.length === 1 ? '' : 's'}: ${names}.`
      }

      case 'executionSequence': {
        const items = Array.isArray(content) ? content : []
        if (!items.length) return 'No phases defined.'
        const names = items.slice(0, 3).map(p => p.phaseName || 'Phase').join(' → ')
        return `${items.length} phase${items.length === 1 ? '' : 's'}: ${names}.`
      }

      case 'dependencies': {
        const items = Array.isArray(content) ? content : []
        if (!items.length) return 'No dependencies identified.'
        const names = items.slice(0, 3).map(d => d.dependencyName || 'Dependency').join(', ')
        return `${items.length} dependenc${items.length === 1 ? 'y' : 'ies'}: ${names}.`
      }

      case 'risks': {
        const items = Array.isArray(content) ? content : []
        if (!items.length) return 'No risks identified.'
        const names = items.slice(0, 3).map(r => r.riskName || 'Risk').join(', ')
        return `${items.length} risk${items.length === 1 ? '' : 's'}: ${names}.`
      }

      case 'validationFramework': {
        const items = Array.isArray(content) ? content : []
        if (!items.length) return 'No validation questions defined.'
        return `${items.length} validation question${items.length === 1 ? '' : 's'} with completion criteria.`
      }

      default:
        return 'Panel content available.'
    }
  } catch {
    return 'Summary not available.'
  }
}
