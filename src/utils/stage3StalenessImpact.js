/**
 * Stage 3 upstream staleness — BU-level and panel-level impact classification.
 *
 * D26 / D27: replaces blanket version-mismatch staleness with impact-aware
 * classification at the BU and panel level.
 *
 * Severity values:
 *   materially_stale    — upstream change affects one or more material assumptions for this BU/panel
 *   review_recommended  — upstream changed but no material assumption detected as affected
 *   unaffected          — upstream change demonstrably does not affect this BU/panel
 *   unknown_impact      — insufficient information to determine impact
 *
 * A BU/panel is materially_stale only if the upstream change affects at least one of:
 *   buScope, targetUseCase, buildVsPartner, resourcing, timeline, riskPosture,
 *   validation, artifactPrerequisite, ownership, deliverySequencing
 *
 * If the upstream revision changes but none of those assumptions are materially
 * affected, the BU/panel is review_recommended, not hard stale.
 */

export const STALE_SEVERITY = {
  MATERIALLY_STALE:   'materially_stale',
  REVIEW_RECOMMENDED: 'review_recommended',
  UNAFFECTED:         'unaffected',
  UNKNOWN_IMPACT:     'unknown_impact',
}

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

// Human-readable label for each material assumption category
const ASSUMPTION_LABELS = {
  buScope:              'BU scope',
  targetUseCase:        'target use case',
  buildVsPartner:       'build-vs-partner stance',
  resourcing:           'resourcing/capacity',
  timeline:             'timeline/deadline',
  riskPosture:          'risk posture',
  validation:           'validation/evidence requirement',
  artifactPrerequisite: 'artifact prerequisite',
  ownership:            'ownership/decision authority',
  deliverySequencing:   'delivery sequencing',
}

// Keyword patterns for each assumption category (case-insensitive substring match)
const ASSUMPTION_KEYWORDS = {
  buScope: [
    'scope changed', 'bu added', 'bu removed', 'unit added', 'unit removed',
    'business unit added', 'business unit removed', 'merged bu', 'split bu',
    'new business unit', 'removed business unit', 'unit scope',
  ],
  targetUseCase: [
    'use case', 'use-case', 'target audience', 'customer segment', 'product line',
    'offering changed', 'market focus', 'target market', 'primary use case',
  ],
  buildVsPartner: [
    'build vs', 'partner vs', 'in-house', 'outsource', 'buy vs', 'make vs',
    'build-or-buy', 'partnership changed', 'vendor selection', 'vendor changed',
  ],
  resourcing: [
    'resource', 'capacity', 'headcount', 'team size', 'staffing', 'budget',
    'funding', 'api capacity', 'allocated', 'bandwidth', 'resourcing',
  ],
  timeline: [
    'timeline', 'deadline', 'date changed', 'quarter changed', 'milestone',
    'schedule', 'delay', 'compress', 'accelerate', 'extended', 'shortened',
    'pilot window', 'compressed window',
  ],
  riskPosture: [
    'risk posture', 'risk tolerance', 'risk threshold', 'risk exposure',
    'mitigation approach', 'constraint changed', 'risk appetite',
  ],
  validation: [
    'validation requirement', 'evidence requirement', 'proof requirement',
    'audit trail', 'compliance requirement', 'approval process', 'test criteria',
    'bsa', 'aml', 'compliance', 'regulatory', 'validation/evidence',
  ],
  artifactPrerequisite: [
    'prerequisite changed', 'artifact prerequisite', 'required input changed',
    'dependency input', 'deliverable prerequisite', 'prerequisite artifact',
  ],
  ownership: [
    'decision authority', 'decision rights', 'ownership changed', 'sponsor changed',
    'governance changed', 'accountable party', 'responsible party', 'decision maker',
  ],
  deliverySequencing: [
    'delivery sequence', 'phase order', 'sequencing changed', 'gate order',
    'priority order', 'phase priority', 'phase sequence', 'delivery order',
  ],
}

// Which panels are sensitive to which material assumption categories.
// Rules from spec:
//   resourcing → Execution Sequence, Dependencies, Risk & Mitigation, Validation Framework
//   validation (BSA/AML/regulatory) → Strategic Objective, Validation Framework, Risk & Mitigation, Execution Sequence
//   buildVsPartner → Critical Decisions, Execution Sequence, Dependencies, Risk & Mitigation
const PANEL_ASSUMPTION_SENSITIVITY = {
  strategicObjective:  ['buScope', 'targetUseCase', 'validation'],
  criticalDecisions:   ['buildVsPartner', 'ownership', 'riskPosture'],
  executionSequence:   ['timeline', 'deliverySequencing', 'resourcing', 'buildVsPartner', 'validation'],
  dependencies:        ['resourcing', 'artifactPrerequisite', 'buildVsPartner'],
  risks:               ['riskPosture', 'validation', 'resourcing', 'buildVsPartner'],
  validationFramework: ['validation', 'artifactPrerequisite', 'resourcing'],
}

// Review targets shown when no panel-specific assumption is detected
const REVIEW_ONLY_TARGETS = [
  'BU summary / thesis',
  'Execution Sequence → Stage 4 deliverable mapping',
  'Compiled Strategy Quality Audit',
]

/**
 * Compute the list of panel IDs that are materially affected by the given changed assumptions.
 */
export function getBuAffectedPanels(changedAssumptions) {
  if (!changedAssumptions?.length) return []
  return PANEL_IDS.filter(panelId => {
    const sensitive = PANEL_ASSUMPTION_SENSITIVITY[panelId] || []
    return sensitive.some(a => changedAssumptions.includes(a))
  })
}

function panelRecommendedAction(panelId, severity, affectedAssumptions) {
  const panelLabel = PANEL_LABELS[panelId] || panelId
  if (severity === STALE_SEVERITY.MATERIALLY_STALE) {
    if (affectedAssumptions.length > 0) {
      const assumptionText = affectedAssumptions.map(a => ASSUMPTION_LABELS[a] || a).join(', ')
      return `Regenerate ${panelLabel} — ${assumptionText} changed.`
    }
    return `Regenerate ${panelLabel} — material upstream change detected.`
  }
  if (severity === STALE_SEVERITY.REVIEW_RECOMMENDED) {
    return 'Review panel content — upstream changed; regeneration not required unless assumptions are affected.'
  }
  if (severity === STALE_SEVERITY.UNAFFECTED) {
    return 'No action required — upstream change does not affect this panel.'
  }
  return 'Review upstream change — insufficient information to determine impact.'
}

/**
 * Detect which material assumption categories are mentioned in a change summary.
 * Returns an array of assumption key names (e.g. ['resourcing', 'timeline']).
 */
export function detectChangedAssumptions(changeSummary) {
  if (!changeSummary || typeof changeSummary !== 'string') return []
  const lower = changeSummary.toLowerCase()
  const detected = []
  for (const [key, keywords] of Object.entries(ASSUMPTION_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw.toLowerCase()))) {
      detected.push(key)
    }
  }
  return detected
}

/**
 * Detect whether a BU is explicitly mentioned in a change summary (case-insensitive).
 */
export function isBuMentionedInChange(buName, changeSummary) {
  if (!buName || !changeSummary) return false
  return changeSummary.toLowerCase().includes(buName.toLowerCase())
}

/**
 * Classify the severity for a single BU given an upstream change.
 *
 * @param {string} buName
 * @param {object} upstreamChange
 *   {
 *     revisionSummary: string | null,
 *     changedAssumptions: string[],    — detected assumption keys
 *     affectedBuNames: string[] | null — if null, treat as all-BUs change
 *   }
 * @returns {{ severity, changedAssumptions, impactedAssumption, reason }}
 */
export function classifyBuImpact(buName, upstreamChange) {
  const { revisionSummary = null, changedAssumptions = [], affectedBuNames = null } = upstreamChange || {}

  // If affectedBuNames is a non-empty list and this BU is NOT in it → unaffected
  if (Array.isArray(affectedBuNames) && affectedBuNames.length > 0) {
    const mentioned = affectedBuNames.some(n =>
      typeof n === 'string' && n.toLowerCase() === String(buName).toLowerCase()
    )
    if (!mentioned) {
      return {
        severity:            STALE_SEVERITY.UNAFFECTED,
        changedAssumptions:  [],
        impactedAssumption:  null,
        affectedPanels:      [],
        reviewTargets:       [],
        reason:              'BU is not in the set of explicitly affected BUs for this upstream change.',
      }
    }
  }

  // No revision summary at all → unknown_impact
  if (!revisionSummary && changedAssumptions.length === 0) {
    return {
      severity:            STALE_SEVERITY.UNKNOWN_IMPACT,
      changedAssumptions:  [],
      impactedAssumption:  null,
      affectedPanels:      [],
      reviewTargets:       REVIEW_ONLY_TARGETS,
      reason:              'Upstream revision changed but no change summary is available to assess impact.',
    }
  }

  // If any material assumption changed, this BU is materially stale
  if (changedAssumptions.length > 0) {
    const affectedPanels = getBuAffectedPanels(changedAssumptions)
    return {
      severity:            STALE_SEVERITY.MATERIALLY_STALE,
      changedAssumptions,
      impactedAssumption:  changedAssumptions[0],
      affectedPanels,
      reviewTargets:       [],
      reason:              `Material assumption changed: ${changedAssumptions.map(a => ASSUMPTION_LABELS[a] || a).join(', ')}.`,
    }
  }

  // Version changed, summary available, but no material assumption detected → review_recommended
  // affectedPanels is empty — no panel-specific stale impact detected.
  return {
    severity:            STALE_SEVERITY.REVIEW_RECOMMENDED,
    changedAssumptions:  [],
    impactedAssumption:  null,
    affectedPanels:      [],
    reviewTargets:       REVIEW_ONLY_TARGETS,
    reason:              'Upstream version changed; no material assumption detected as affected.',
  }
}

/**
 * Classify the severity for a single panel given a BU's classification.
 *
 * When the BU is materially_stale but the panel's sensitive assumptions were not
 * specifically hit, the panel is downgraded to review_recommended.
 *
 * @returns {{ buName, panelId, severity, impactedAssumption, impactedAssumptions, action }}
 */
export function classifyPanelImpact(buName, panelId, buSeverity, changedAssumptions) {
  // Propagate unaffected / unknown directly to the panel
  if (buSeverity === STALE_SEVERITY.UNAFFECTED) {
    return {
      buName, panelId,
      severity:            STALE_SEVERITY.UNAFFECTED,
      impactedAssumption:  null,
      impactedAssumptions: [],
      action:              'No action required.',
    }
  }
  if (buSeverity === STALE_SEVERITY.UNKNOWN_IMPACT) {
    return {
      buName, panelId,
      severity:            STALE_SEVERITY.UNKNOWN_IMPACT,
      impactedAssumption:  null,
      impactedAssumptions: [],
      action:              'Review upstream change — insufficient information to determine panel impact.',
    }
  }

  // Check which of this panel's sensitive assumptions intersect with changed ones
  const sensitive = PANEL_ASSUMPTION_SENSITIVITY[panelId] || []
  const panelAffected = sensitive.filter(a => (changedAssumptions || []).includes(a))

  if (panelAffected.length > 0) {
    return {
      buName, panelId,
      severity:            STALE_SEVERITY.MATERIALLY_STALE,
      impactedAssumption:  panelAffected[0],
      impactedAssumptions: panelAffected,
      action:              panelRecommendedAction(panelId, STALE_SEVERITY.MATERIALLY_STALE, panelAffected),
    }
  }

  // BU is stale but panel's specific assumptions weren't hit → review_recommended
  const panelSeverity = STALE_SEVERITY.REVIEW_RECOMMENDED

  return {
    buName, panelId,
    severity:            panelSeverity,
    impactedAssumption:  null,
    impactedAssumptions: [],
    action:              panelRecommendedAction(panelId, panelSeverity, []),
  }
}

/**
 * Build the full stale impact map for all BUs and panels.
 *
 * The map captures:
 *   - Which material assumptions changed (from revisionSummary keyword detection)
 *   - Per-BU severity and impacted assumption
 *   - Per-panel severity and impacted assumption
 *   - A summary count for the UI
 *
 * @param {object} opts
 * @param {string[]}      opts.buNames             — ordered BU names
 * @param {string}        opts.upstreamSource       — 'Stage 1' | 'Stage 2' | 'upstream'
 * @param {string}        opts.upstreamRevisionId   — new revision ID
 * @param {string|null}   [opts.revisionSummary]    — impactSummary from the new revision
 * @param {string[]|null} [opts.affectedBuNames]    — explicitly affected BUs (null = all)
 * @returns {StaleImpactMap}
 */
export function buildStaleImpactMap({
  buNames = [],
  upstreamSource,
  upstreamRevisionId,
  revisionSummary = null,
  affectedBuNames = null,
}) {
  const changedAssumptions = detectChangedAssumptions(revisionSummary)

  const upstreamChange = { revisionSummary, changedAssumptions, affectedBuNames }

  const buImpacts = buNames.map(buName => {
    const impact = classifyBuImpact(buName, upstreamChange)
    return {
      buName,
      severity:            impact.severity,
      changedAssumptions:  impact.changedAssumptions,
      impactedAssumption:  impact.impactedAssumption,
      affectedPanels:      impact.affectedPanels,
      reviewTargets:       impact.reviewTargets,
      reason:              impact.reason,
      upstreamSource,
      upstreamRevisionId,
      revisionSummary,
    }
  })

  const panelImpacts = buNames.flatMap(buName => {
    const buImpact = buImpacts.find(b => b.buName === buName)
    return PANEL_IDS.map(panelId =>
      classifyPanelImpact(buName, panelId, buImpact.severity, buImpact.changedAssumptions)
    )
  })

  const materiallyStaleBUs   = buImpacts.filter(b => b.severity === STALE_SEVERITY.MATERIALLY_STALE).map(b => b.buName)
  const reviewRecommendedBUs = buImpacts.filter(b => b.severity === STALE_SEVERITY.REVIEW_RECOMMENDED).map(b => b.buName)
  const unaffectedBUs        = buImpacts.filter(b => b.severity === STALE_SEVERITY.UNAFFECTED).map(b => b.buName)
  const unknownBUs           = buImpacts.filter(b => b.severity === STALE_SEVERITY.UNKNOWN_IMPACT).map(b => b.buName)

  return {
    upstreamSource,
    upstreamRevisionId,
    revisionSummary,
    changedAssumptions,
    buImpacts,
    panelImpacts,
    computedAt: new Date().toISOString(),
    summary: {
      materiallyStaleBUs,
      reviewRecommendedBUs,
      unaffectedBUs,
      unknownBUs,
      total: buNames.length,
    },
  }
}

/**
 * Determine the worst-case (highest) severity across all BUs in an impact map.
 * Priority: materially_stale > unknown_impact > review_recommended > unaffected
 */
export function overallStaleSeverity(impactMap) {
  if (!impactMap) return null
  const { summary } = impactMap
  if (summary.materiallyStaleBUs.length > 0)   return STALE_SEVERITY.MATERIALLY_STALE
  if (summary.unknownBUs.length > 0)            return STALE_SEVERITY.UNKNOWN_IMPACT
  if (summary.reviewRecommendedBUs.length > 0)  return STALE_SEVERITY.REVIEW_RECOMMENDED
  return STALE_SEVERITY.UNAFFECTED
}

/**
 * Get the impact record for a specific BU.
 */
export function getBuImpact(impactMap, buName) {
  if (!impactMap?.buImpacts) return null
  return impactMap.buImpacts.find(b => b.buName === buName) || null
}

/**
 * Get the impact record for a specific BU's panel.
 */
export function getPanelImpact(impactMap, buName, panelId) {
  if (!impactMap?.panelImpacts) return null
  return impactMap.panelImpacts.find(p => p.buName === buName && p.panelId === panelId) || null
}

/**
 * Returns true when the overall impact requires blocking Stage 4 continuation
 * (i.e., at least one BU is materially_stale or unknown_impact).
 * review_recommended does NOT block — it allows continuation with a warning.
 */
export function staleImpactBlocksStage4(impactMap) {
  if (!impactMap) return false
  const severity = overallStaleSeverity(impactMap)
  return severity === STALE_SEVERITY.MATERIALLY_STALE || severity === STALE_SEVERITY.UNKNOWN_IMPACT
}
