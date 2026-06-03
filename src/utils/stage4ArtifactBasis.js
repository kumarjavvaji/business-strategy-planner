/**
 * Stage 4 artifact basis compiler.
 *
 * Builds a compact, artifact-specific packet from accepted Stage 3 panel data.
 * The basis includes only tactics mapped to the requested Stage 4 deliverable
 * plus supporting decisions/dependencies/risks/validation items selected by
 * deterministic keyword overlap.
 */

export const ARTIFACT_LABELS = {
  executive_decision_brief:            'Executive Decision Brief',
  bu_execution_plan:                   'BU Execution Plan',
  bu_execution_plan_partial:           'BU Execution Plan Partial',
  bu_sme_review_packet:                'BU SME Review Packet',
  global_sme_review_packet:            'SME Review Packet',
  acceptance_criteria_draft:           'Acceptance Criteria Draft',
  implementation_governance_checklist: 'Implementation Governance Checklist',
  risk_control_plan:                   'Risk and Control Plan',
  dependency_risk_brief:               'Dependency and Risk Brief',
  operating_cadence_plan:              'Operating Cadence Plan',
  pdlc_epic_outline:                   'PDLC Epic Outline',
  cross_bu_dependency_map:             'Cross-BU Dependency Map',
}

export const ARTIFACT_INTENTS = {
  executive_decision_brief: 'Board-ready decision brief covering recommendations, tradeoffs, feasibility, dependencies, risks, and evidence needed for leadership action.',
  bu_execution_plan: 'Concrete BU operating path using mapped execution tactics as the spine, with gates, dependencies, controls, and validation handoffs.',
  bu_execution_plan_partial: 'Partial BU operating path from available mapped tactics, with missing areas clearly called out.',
  bu_sme_review_packet: 'Specialist review packet focused on assumptions, evidence gaps, risks, validation questions, and tactics needing expert challenge.',
  global_sme_review_packet: 'Specialist review packet focused on assumptions, evidence gaps, risks, validation questions, and tactics needing expert challenge.',
  acceptance_criteria_draft: 'Turns validation needs into testable acceptance criteria for product, engineering, compliance, and delivery review.',
  implementation_governance_checklist: 'Controls and checkpoints for implementation governance, approvals, evidence, and escalation.',
  risk_control_plan: 'Risk-to-control plan with early warnings, owners/functions, and evidence that risk is reduced.',
  dependency_risk_brief: 'Brief of dependencies and risks that can block execution, with needed action.',
  operating_cadence_plan: 'Cadence, forums, triggers, escalation rhythm, and decision rights for recurring execution management.',
  pdlc_epic_outline: 'Product and engineering epic candidates, boundaries, dependencies, sequencing, and acceptance basis.',
  cross_bu_dependency_map: 'Cross-BU/function dependencies, required inputs, timing, consequences, and coordination needs.',
}

const TYPE_ALIASES = {
  bu_sme_review_packet: ['bu_sme_review_packet', 'global_sme_review_packet'],
  global_sme_review_packet: ['global_sme_review_packet', 'bu_sme_review_packet'],
}

const SUPPORT_LIMITS = {
  executive_decision_brief: { decisions: 5, dependencies: 4, risks: 4, validations: 3 },
  bu_execution_plan: { decisions: 4, dependencies: 5, risks: 4, validations: 4 },
  bu_execution_plan_partial: { decisions: 4, dependencies: 5, risks: 4, validations: 4 },
  bu_sme_review_packet: { decisions: 4, dependencies: 3, risks: 5, validations: 6 },
  global_sme_review_packet: { decisions: 4, dependencies: 3, risks: 5, validations: 6 },
}

const REQUIRED_SOURCE_PANELS = [
  'strategicObjective',
  'executionSequence',
  'criticalDecisions',
  'dependencies',
  'risks',
  'validationFramework',
]

const PANEL_LABELS = {
  strategicObjective:  'Strategic Objective',
  executionSequence:   'Execution Sequence',
  criticalDecisions:   'Critical Decisions',
  dependencies:        'Dependencies',
  risks:               'Risks & Mitigations',
  validationFramework: 'Validation Framework',
}

function panelIsAccepted(panel) {
  return Boolean(panel?.content && (!panel.lifecycle || panel.lifecycle === 'accepted'))
}

function normalizeImpactOptions(options) {
  if (!options || typeof options === 'string') return { buSeverity: options || null }
  return options
}

function panelIdsWithSeverity(panelImpacts = [], severity) {
  return [...new Set((panelImpacts || [])
    .filter(impact => impact?.severity === severity)
    .map(impact => impact.panelId)
    .filter(Boolean))]
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isPanelCompleteOrAccepted(panel) {
  if (!panel?.content) return false
  return !panel.lifecycle || ['accepted', 'complete'].includes(panel.lifecycle)
}

function isPanelFailed(panel) {
  return ['failed', 'rejected'].includes(panel?.lifecycle)
}

function reviewTargetRequested(reviewTargets, matchers) {
  return (reviewTargets || []).some(target => {
    const text = String(target || '').toLowerCase()
    return matchers.some(matcher => text.includes(matcher))
  })
}

function compiledAuditIsBlocking(audit) {
  if (!audit) return { blocking: false, reason: 'Compiled Strategy Quality Audit not available for this handoff record.' }
  const violations = audit.violations || audit.results?.filter(result => result.status === 'fail') || []
  const blocking = Boolean(
    audit.failedCount > 0 ||
    violations.some(result => {
      const text = `${result.ruleId || ''} ${result.label || ''} ${result.message || ''}`.toLowerCase()
      return text.includes('truncated') || text.includes('repetition') || text.includes('repeat') || text.includes('blocking')
    })
  )
  if (!blocking) return { blocking: false, reason: 'Compiled Strategy Quality Audit has no blocking violations.' }
  const first = violations[0]
  return {
    blocking: true,
    reason: first?.message || first?.label || 'Compiled Strategy Quality Audit has blocking violations.',
  }
}

function buildReviewTargetsForArtifact({
  buHandoff,
  panels,
  artifactId,
  mappedHowOptionsCount,
  rowMaterialStalePanels,
  rowUnacceptedSourcePanels,
  reviewTargets,
  qualityAudit,
}) {
  const plan = buHandoff?.plan || {}
  const summaryRequested = reviewTargetRequested(reviewTargets, ['summary', 'thesis'])
  const execRequested = reviewTargetRequested(reviewTargets, ['execution sequence'])
  const mappingRequested = reviewTargetRequested(reviewTargets, ['deliverable mapping', 'stage 4 mapping', 'mapping'])
  const auditRequested = reviewTargetRequested(reviewTargets, ['quality audit', 'compiled strategy'])

  const summaryPopulated = hasText(plan.mission) || hasText(plan.strategicRole) || hasText(plan.summary) || hasText(plan.thesis)
  const summaryStale = rowMaterialStalePanels.includes('strategicObjective')
  const execPanel = panels.executionSequence
  const execContent = Array.isArray(execPanel?.content) ? execPanel.content : []
  const execHasPhases = execContent.length > 0
  const execHasHowOptions = execContent.some(phase => Array.isArray(phase?.howOptions) && phase.howOptions.length > 0)
  const execStale = rowMaterialStalePanels.includes('executionSequence')
  const auditCheck = compiledAuditIsBlocking(qualityAudit)

  const targets = [
    {
      targetId: 'bu_summary_thesis',
      label: 'BU summary / thesis',
      sourcePanelId: 'strategicObjective',
      anchorId: 'buSummary',
      blocking: summaryRequested,
      status: summaryStale || !summaryPopulated ? 'unresolved' : 'resolved',
      reason: summaryStale
        ? 'material stale impact affects BU summary / thesis'
        : summaryPopulated
          ? 'summary / thesis source fields are populated'
          : 'summary / thesis source fields are missing',
    },
    {
      targetId: 'execution_sequence',
      label: 'Execution Sequence',
      sourcePanelId: 'executionSequence',
      anchorId: 'stage3-panel-executionSequence',
      blocking: execRequested,
      status: execStale || !execPanel || isPanelFailed(execPanel) || !isPanelCompleteOrAccepted(execPanel) || !execHasPhases || !execHasHowOptions ? 'unresolved' : 'resolved',
      reason: execStale
        ? 'material stale impact affects Execution Sequence'
        : !execPanel
          ? 'Execution Sequence panel is missing'
          : isPanelFailed(execPanel)
            ? 'Execution Sequence panel failed'
            : !isPanelCompleteOrAccepted(execPanel)
              ? 'Execution Sequence panel is not accepted or complete'
              : !execHasPhases
                ? 'Execution Sequence has no phases'
                : !execHasHowOptions
                  ? 'Execution Sequence has no how options'
                  : 'Execution Sequence is accepted and contains phases/how options',
    },
    {
      targetId: 'stage4_deliverable_mapping',
      label: 'Stage 4 deliverable mapping',
      sourcePanelId: 'executionSequence',
      anchorId: `stage3-artifact-mapping-${artifactId}`,
      remediationTarget: `Execution Sequence -> find ${ARTIFACT_LABELS[artifactId] || artifactId} row -> select how options`,
      blocking: mappingRequested || mappedHowOptionsCount === 0,
      status: mappedHowOptionsCount > 0 ? 'resolved' : 'unresolved',
      reason: mappedHowOptionsCount > 0
        ? `${mappedHowOptionsCount} mapped how option${mappedHowOptionsCount === 1 ? '' : 's'} selected`
        : 'selected artifact has 0 mapped how options',
    },
    {
      targetId: 'compiled_strategy_quality_audit',
      label: 'Compiled Strategy Quality Audit',
      sourcePanelId: null,
      anchorId: 'compiledStrategyQualityAudit',
      blocking: auditRequested && auditCheck.blocking,
      status: !qualityAudit && auditRequested
        ? 'unresolved'
        : auditCheck.blocking
          ? 'unresolved'
          : qualityAudit
            ? 'resolved'
            : 'advisory',
      reason: !qualityAudit && auditRequested
        ? 'Compiled Strategy Quality Audit is missing'
        : auditCheck.reason,
    },
  ]

  return targets.map(target => ({
    ...target,
    blocking: Boolean(target.blocking && target.status === 'unresolved'),
  }))
}

function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'item'
}

function words(value) {
  return new Set(String(value || '').toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || [])
}

function itemText(item) {
  if (!item) return ''
  if (typeof item === 'string') return item
  return Object.values(item)
    .flatMap(value => Array.isArray(value) ? value : [value])
    .filter(value => typeof value === 'string')
    .join(' ')
}

function overlapScore(item, basisWords, extraWords = new Set()) {
  const allWords = words(itemText(item))
  let score = 0
  allWords.forEach(word => {
    if (basisWords.has(word)) score += 2
    if (extraWords.has(word)) score += 1
  })
  return score
}

function compactItem(item, fallbackId) {
  if (typeof item === 'string') return { id: fallbackId, summary: item.slice(0, 240) }
  return {
    id: item.id || item.decisionId || item.dependencyId || item.riskId || item.validationId || fallbackId,
    name: item.decisionName || item.dependencyName || item.riskName || item.validationQuestion || item.name || item.title || null,
    summary: item.decisionQuestion || item.dependencyDescription || item.riskDescription || item.completionCriteria || item.summary || itemText(item).slice(0, 260),
    evidence: item.decisionEvidenceNeeded || item.requiredInput || item.evidenceThatRiskIsReduced || item.evidenceExamples || null,
    timing: item.decisionTiming || item.consequenceIfMissing || item.earlyWarningSignals || item.failureOrReworkTriggers || null,
  }
}

function selectRelevant(items, tacticText, artifactType, limit, extraTerms = []) {
  const basisWords = words(tacticText)
  const extraWords = words([artifactType, ...extraTerms].join(' '))
  return (items || [])
    .map((item, index) => ({ item, index, score: overlapScore(item, basisWords, extraWords) }))
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(row => compactItem(row.item, `item_${row.index + 1}`))
}

function acceptedContent(panel) {
  if (!panel?.content) return null
  if (!panel.lifecycle || panel.lifecycle === 'accepted') return panel.content
  return null
}

function getPanelModelForBu(bu) {
  return bu?.stage3PanelModel || bu?.panelModel || bu?.sourcePanelModel || null
}

function getTargetBus(artifactItem, handoff) {
  const bus = handoff?.buHandoffs || []
  if (artifactItem?.businessUnitName) {
    return bus.filter(bu => bu.buName === artifactItem.businessUnitName)
  }
  return bus.filter(bu => bu.status === 'ready' || bu.status === 'partial')
}

function mappedTypesFor(artifactType) {
  return new Set(TYPE_ALIASES[artifactType] || [artifactType])
}

function collectMappedTactics(execPanel, artifactType) {
  const content = acceptedContent(execPanel)
  const mappings = execPanel?.executionDeliverableMappings || {}
  const targetTypes = mappedTypesFor(artifactType)
  const selectedExecutionTactics = []
  const unmappedTacticNames = []

  ;(Array.isArray(content) ? content : []).forEach((phase, phaseIndex) => {
    const phaseId = slug(phase?.phaseName)
    const phaseMapping = mappings[phaseId] || {}
    const howOptionMappings = phaseMapping.howOptionMappings || {}
    ;(phase?.howOptions || []).forEach((option, optionIndex) => {
      const optionId = slug(option?.optionName)
      const mappedDeliverables = howOptionMappings[optionId]?.mappedDeliverables || []
      const isMapped = mappedDeliverables.some(type => targetTypes.has(type))
      const tactic = {
        id: `executionSequence:${phaseId}:${optionId}`,
        phaseId,
        phaseName: phase?.phaseName || `Phase ${phaseIndex + 1}`,
        optionId,
        optionName: option?.optionName || `Option ${optionIndex + 1}`,
        whenToUse: option?.whenToUse || '',
        whyItFits: option?.whyItFitsThePhaseOutcome || option?.whyItFits || '',
        evidenceProduced: option?.evidenceProduced || '',
        mappedDeliverables,
      }
      if (isMapped) selectedExecutionTactics.push(tactic)
      else unmappedTacticNames.push(tactic.optionName)
    })
  })

  return { selectedExecutionTactics, unmappedTacticNames }
}

function compileOneBuBasis(artifactItem, bu) {
  const panelModel = getPanelModelForBu(bu)
  const panels = panelModel?.panels || {}
  const strategicObjective = acceptedContent(panels.strategicObjective)
  const criticalDecisions = acceptedContent(panels.criticalDecisions) || []
  const dependencies = acceptedContent(panels.dependencies) || []
  const risks = acceptedContent(panels.risks) || []
  const validation = acceptedContent(panels.validationFramework) || []
  const execution = panels.executionSequence
  const { selectedExecutionTactics, unmappedTacticNames } = collectMappedTactics(execution, artifactItem.artifactType)
  const tacticText = selectedExecutionTactics.map(t => `${t.optionName} ${t.whenToUse} ${t.whyItFits} ${t.evidenceProduced}`).join(' ')
  const limits = SUPPORT_LIMITS[artifactItem.artifactType] || SUPPORT_LIMITS.bu_execution_plan

  return {
    buName: bu.buName,
    strategicThesis: strategicObjective?.summary || strategicObjective?.outcomeFocus || bu.plan?.strategicRole || '',
    selectedExecutionTactics,
    relevantDecisions: selectRelevant(criticalDecisions, tacticText, artifactItem.artifactType, limits.decisions, ['decision gate tradeoff']),
    relevantDependencies: selectRelevant(dependencies, tacticText, artifactItem.artifactType, limits.dependencies, ['dependency input owner timing']),
    relevantRisks: selectRelevant(risks, tacticText, artifactItem.artifactType, limits.risks, ['risk control mitigation warning']),
    relevantValidationQuestions: selectRelevant(validation, tacticText, artifactItem.artifactType, limits.validations, ['validation evidence acceptance criteria']),
    sourceTraceability: {
      sourceType: bu.sourceType || null,
      sourceAtomIds: bu.sourceAtomIds || [],
      sourceSectionIds: bu.sourceSectionIds || [],
      tacticSourceIds: selectedExecutionTactics.map(t => t.id),
    },
    excluded: {
      unmappedTacticCount: unmappedTacticNames.length,
      unmappedTacticNames: unmappedTacticNames.slice(0, 20),
      note: 'Unmapped tactics and unrelated panel prose are excluded from this basis.',
    },
    warnings: panelModel ? [] : ['No Stage 3 panel model available for this BU; basis is limited to handoff summary.'],
  }
}

export function compileArtifactBasis(artifactItem, handoff) {
  const bus = getTargetBus(artifactItem, handoff)
  const perBuBasis = bus.map(bu => compileOneBuBasis(artifactItem, bu))
  const selectedExecutionTactics = perBuBasis.flatMap(b => b.selectedExecutionTactics.map(t => ({ ...t, buName: b.buName })))
  const basisWarnings = perBuBasis.flatMap(b => b.warnings)

  const missingPrerequisites = []

  if (selectedExecutionTactics.length === 0) {
    basisWarnings.push(`No mapped how options found for ${artifactItem.artifactType}.`)
    // Provide actionable deep-link info so users know exactly where to fix this
    const affectedBuNames = bus.map(b => b.buName).filter(Boolean)
    missingPrerequisites.push({
      type:            'unmapped_execution_tactics',
      artifactType:    artifactItem.artifactType,
      affectedBuNames,
      panelId:         'executionSequence',
      deepLinkPanelId: 'executionSequence',
      description:
        `No how-options in the Execution Sequence panel are mapped to "${artifactItem.artifactType}". ` +
        `Open the Execution Sequence panel for ${affectedBuNames.join(', ') || 'the relevant BU'} ` +
        `and map at least one how-option to this artifact type.`,
      remediationSteps: [
        'Go to Stage 3 → Execution Sequence panel for the affected BU.',
        `Select a how-option and check "${artifactItem.artifactType}" in its deliverable mapping.`,
        'Return to Stage 4 and recompile the handoff.',
      ],
    })
  }

  // Flag BUs where the Stage 3 panel model is entirely absent
  bus.forEach(bu => {
    const panelModel = bu?.stage3PanelModel || bu?.panelModel || bu?.sourcePanelModel || null
    if (!panelModel) {
      missingPrerequisites.push({
        type:            'missing_stage3_panel_model',
        artifactType:    artifactItem.artifactType,
        affectedBuNames: [bu.buName],
        panelId:         null,
        deepLinkPanelId: null,
        description:
          `No Stage 3 panel model found for BU "${bu.buName}". ` +
          `This BU's execution plans may not have been generated or persisted. ` +
          `Regenerate Stage 3 for this BU and recompile the handoff.`,
        remediationSteps: [
          `Go to Stage 3 and generate or accept plans for BU "${bu.buName}".`,
          'Recompile the Stage 4 handoff.',
        ],
      })
    }
  })

  return {
    artifactType: artifactItem.artifactType,
    artifactIntent: ARTIFACT_INTENTS[artifactItem.artifactType] || artifactItem.purpose || '',
    buName: artifactItem.businessUnitName || (bus.length === 1 ? bus[0]?.buName : 'multiple BUs'),
    strategicThesis: perBuBasis.map(b => b.strategicThesis).filter(Boolean).slice(0, 3).join(' | '),
    selectedExecutionTactics,
    relevantDecisions: perBuBasis.flatMap(b => b.relevantDecisions.map(item => ({ ...item, buName: b.buName }))),
    relevantDependencies: perBuBasis.flatMap(b => b.relevantDependencies.map(item => ({ ...item, buName: b.buName }))),
    relevantRisks: perBuBasis.flatMap(b => b.relevantRisks.map(item => ({ ...item, buName: b.buName }))),
    relevantValidationQuestions: perBuBasis.flatMap(b => b.relevantValidationQuestions.map(item => ({ ...item, buName: b.buName }))),
    excludedContextSummary: {
      excluded: 'Unmapped tactics and unrelated Stage 3 panel prose.',
      unmappedTacticCount: perBuBasis.reduce((sum, b) => sum + b.excluded.unmappedTacticCount, 0),
      unmappedTacticNames: perBuBasis.flatMap(b => b.excluded.unmappedTacticNames).slice(0, 30),
    },
    sourceTraceability: {
      sourceBuNames: bus.map(b => b.buName),
      sourceAtomIds: perBuBasis.flatMap(b => b.sourceTraceability.sourceAtomIds),
      sourceSectionIds: perBuBasis.flatMap(b => b.sourceTraceability.sourceSectionIds),
      tacticSourceIds: selectedExecutionTactics.map(t => t.id),
    },
    basisWarnings,
    missingPrerequisites,
    counts: {
      mappedHowOptions: selectedExecutionTactics.length,
      criticalDecisions: perBuBasis.reduce((sum, b) => sum + b.relevantDecisions.length, 0),
      dependencies: perBuBasis.reduce((sum, b) => sum + b.relevantDependencies.length, 0),
      risks: perBuBasis.reduce((sum, b) => sum + b.relevantRisks.length, 0),
      validationQuestions: perBuBasis.reduce((sum, b) => sum + b.relevantValidationQuestions.length, 0),
    },
  }
}

/**
 * Source-grounded readiness summary for the Stage 4 pre-artifact view.
 * Returns a structured object so the UI can render each field distinctly.
 */
export function basisReadinessSummary(basis) {
  if (!basis) return null

  const buNames = basis.sourceTraceability?.sourceBuNames || (basis.buName ? [basis.buName] : [])
  const atomCount = (basis.sourceTraceability?.sourceAtomIds || []).length
  const sectionCount = (basis.sourceTraceability?.sourceSectionIds || []).length

  const prereqsMet = []
  const prereqsMissing = []

  if (basis.counts.mappedHowOptions > 0) {
    prereqsMet.push(`${basis.counts.mappedHowOptions} execution tactic${basis.counts.mappedHowOptions === 1 ? '' : 's'} mapped`)
  } else {
    prereqsMissing.push('No execution tactics mapped to this artifact — open Execution Sequence and map at least one how-option')
  }
  if (basis.counts.criticalDecisions > 0) prereqsMet.push(`${basis.counts.criticalDecisions} decision${basis.counts.criticalDecisions === 1 ? '' : 's'}`)
  if (basis.counts.dependencies > 0) prereqsMet.push(`${basis.counts.dependencies} dependenc${basis.counts.dependencies === 1 ? 'y' : 'ies'}`)
  if (basis.counts.risks > 0) prereqsMet.push(`${basis.counts.risks} risk${basis.counts.risks === 1 ? '' : 's'}`)
  if (basis.counts.validationQuestions > 0) prereqsMet.push(`${basis.counts.validationQuestions} validation item${basis.counts.validationQuestions === 1 ? '' : 's'}`)

  ;(basis.missingPrerequisites || []).forEach(p => {
    if (!prereqsMissing.some(m => m.includes(p.type))) {
      prereqsMissing.push(p.description || p.type)
    }
  })

  const nextAction = prereqsMissing.length > 0
    ? prereqsMissing[0]
    : basis.counts.mappedHowOptions > 0
      ? 'Ready to generate — click Generate artifact.'
      : 'Map execution tactics in Stage 3 first.'

  return {
    buNames,
    sourceRecord: buNames.length === 1 ? `${buNames[0]} Stage 3 accepted plan` : `${buNames.length} BU plans`,
    atomCount,
    sectionCount,
    prereqsMet,
    prereqsMissing,
    nextAction,
    isReady: prereqsMissing.length === 0 && basis.counts.mappedHowOptions > 0,
  }
}

/**
 * D28: Compute per-artifact readiness for a single BU's handoff entry.
 *
 * Returns one record per selected Stage 4 deliverable for this BU.  Each record
 * captures why the artifact is or is not generatable without requiring the caller
 * to invoke the full compileArtifactBasis pipeline.
 *
 * readinessStatus values:
 *   ready                     — all inputs present, BU not hard-stale
 *   review_recommended        — BU has review_recommended severity but inputs are complete
 *   blocked_missing_mapping   — no how-options in Execution Sequence mapped to this artifact
 *   blocked_missing_source    — no durable Stage 3 record / panel model in the handoff
 *   blocked_materially_stale  — BU classified as materially_stale by upstream impact map
 *
 * @param {object} buHandoff  — a buHandoffs entry from the compiled Stage 4 handoff
 * @param {string|null} buSeverity — STALE_SEVERITY string from the impact map, or null
 * @returns {ArtifactReadinessRecord[]}
 */
function computeArtifactReadinessForBuLegacy(buHandoff, buSeverity = null) {
  if (!buHandoff) return []

  const panelModel   = buHandoff.stage3PanelModel || buHandoff.panelModel || buHandoff.sourcePanelModel || null
  const execPanel    = panelModel?.panels?.executionSequence
  const selected     = execPanel?.selectedStage4Deliverables || []
  const mappings     = execPanel?.executionDeliverableMappings || {}
  const atomIds = buHandoff.sourceAtomIds || []
  const sourceAtomCount = atomIds.length > 0 ? atomIds.length : (buHandoff.completedAtomCount || 0)
  const buStatus     = buHandoff.status || 'blocked'

  const noPanelModel = !panelModel
  const buBlocked    = buStatus === 'blocked'

  return selected.map(record => {
    const artifactId = record?.deliverableType
    if (!artifactId) return null

    // Count how-options mapped to this artifact across all phases
    let mappedHowOptionsCount = 0
    Object.values(mappings).forEach(phaseMapping => {
      const howOptMaps = phaseMapping?.howOptionMappings
      if (howOptMaps) {
        Object.values(howOptMaps).forEach(optMapping => {
          if ((optMapping?.mappedDeliverables || []).includes(artifactId)) mappedHowOptionsCount++
        })
      } else {
        // Legacy phase-level mapping
        const phaseMapped = phaseMapping?.phaseMappedDeliverables || phaseMapping?.mappedDeliverables || []
        if (phaseMapped.includes(artifactId)) mappedHowOptionsCount++
      }
    })

    let readinessStatus
    let blockingReason = null
    let missingPrerequisites = []
    let sourcePanelId = null
    let sourcePanelLabel = null
    let remediationTarget

    if (buSeverity === 'materially_stale') {
      readinessStatus  = 'blocked_materially_stale'
      blockingReason   = 'BU has material upstream changes — regenerate affected Stage 3 panels first.'
      remediationTarget = 'Stage 3 → regenerate affected BU panels, then recompile handoff'
    } else if (buBlocked || noPanelModel) {
      readinessStatus  = 'blocked_missing_source'
      blockingReason   = buHandoff.blockedReason || 'No durable Stage 3 record or panel model found for this BU.'
      missingPrerequisites = ['Stage 3 BU plan not in storage']
      remediationTarget = 'Stage 3 → generate and accept panels for this BU, then recompile handoff'
    } else if (mappedHowOptionsCount === 0) {
      readinessStatus  = 'blocked_missing_mapping'
      blockingReason   = `No how-options in Execution Sequence are mapped to "${artifactId}".`
      sourcePanelId    = 'executionSequence'
      sourcePanelLabel = 'Execution Sequence'
      missingPrerequisites = ['No how-options mapped to this artifact']
      remediationTarget = `Execution Sequence → find ${ARTIFACT_LABELS[artifactId] || artifactId} row → select how options`
    } else if (buSeverity === 'review_recommended' || buSeverity === 'unknown_impact') {
      readinessStatus  = 'review_recommended'
      remediationTarget = 'Review BU summary and upstream change before generating'
    } else {
      readinessStatus  = 'ready'
      remediationTarget = 'Can generate'
    }

    return {
      buId:                 buHandoff.buId || buHandoff.stableBuKey || buHandoff.buKey || buHandoff.buName,
      buName:               buHandoff.buName,
      artifactId,
      artifactTitle:        ARTIFACT_LABELS[artifactId] || artifactId,
      anchorId:             `stage3-artifact-mapping-${artifactId}`,
      readinessStatus,
      mappedHowOptionsCount,
      sourceAtomCount,
      missingPrerequisites,
      blockingReason,
      sourcePanelId,
      sourcePanelLabel,
      remediationTarget,
    }
  }).filter(Boolean)
}

void computeArtifactReadinessForBuLegacy

export function computeArtifactReadinessForBu(buHandoff, buSeverity = null, impactOptions = null) {
  if (!buHandoff) return []

  const normalizedImpact = normalizeImpactOptions(impactOptions || buSeverity)
  const resolvedBuSeverity = typeof buSeverity === 'string' ? buSeverity : normalizedImpact.buSeverity
  const panelImpacts = normalizedImpact.panelImpacts || []
  const upstreamReviewTargetLabels = normalizedImpact.reviewTargets || []
  const panelModel   = buHandoff.stage3PanelModel || buHandoff.panelModel || buHandoff.sourcePanelModel || null
  const qualityAudit = normalizedImpact.qualityAudit || normalizedImpact.compiledQualityAudit || buHandoff.stage3CompiledStrategyQualityAudit || panelModel?.stage3CompiledStrategyQualityAudit || null
  const execPanel    = panelModel?.panels?.executionSequence
  const selected     = execPanel?.selectedStage4Deliverables || []
  const mappings     = execPanel?.executionDeliverableMappings || {}
  const atomIds = buHandoff.sourceAtomIds || []
  const sourceAtomCount = atomIds.length > 0 ? atomIds.length : (buHandoff.completedAtomCount || 0)
  const sourceEvidenceCount = sourceAtomCount + (buHandoff.sourceSectionIds || []).length
  const buStatus     = buHandoff.status || 'blocked'

  const noPanelModel = !panelModel
  const buBlocked    = buStatus === 'blocked'
  const panels = panelModel?.panels || {}
  const requiredSourcePanels = REQUIRED_SOURCE_PANELS.filter(panelId => panelId === 'executionSequence' || panels[panelId])
  const acceptedSourcePanels = requiredSourcePanels.filter(panelId => panelIsAccepted(panels[panelId]))
  const unacceptedSourcePanels = requiredSourcePanels.filter(panelId => !panelIsAccepted(panels[panelId]))
  const materialStalePanels = panelIdsWithSeverity(panelImpacts, 'materially_stale')
    .filter(panelId => requiredSourcePanels.includes(panelId))
  const reviewRecommendedPanels = panelIdsWithSeverity(panelImpacts, 'review_recommended')
    .filter(panelId => requiredSourcePanels.includes(panelId))

  return selected.map(record => {
    const artifactId = record?.deliverableType
    if (!artifactId) return null

    let mappedHowOptionsCount = 0
    Object.values(mappings).forEach(phaseMapping => {
      const howOptMaps = phaseMapping?.howOptionMappings
      if (howOptMaps) {
        Object.values(howOptMaps).forEach(optMapping => {
          if ((optMapping?.mappedDeliverables || []).includes(artifactId)) mappedHowOptionsCount++
        })
      } else {
        const phaseMapped = phaseMapping?.phaseMappedDeliverables || phaseMapping?.mappedDeliverables || []
        if (phaseMapped.includes(artifactId)) mappedHowOptionsCount++
      }
    })

    let readinessStatus
    let blockingReason = null
    let missingPrerequisites = []
    let sourcePanelId = null
    let sourcePanelLabel = null
    let remediationTarget
    let upstreamReviewReason = null
    let finalReadinessReason = null
    let missingMappings = []
    let rowMaterialStalePanels = [...materialStalePanels]
    const rowUnacceptedSourcePanels = [...unacceptedSourcePanels]
    const rowAcceptedSourcePanels = [...acceptedSourcePanels]
    const unsupportedGenerator = !ARTIFACT_LABELS[artifactId]

    if (mappedHowOptionsCount === 0) missingMappings = [artifactId]
    if (resolvedBuSeverity === 'materially_stale' && rowMaterialStalePanels.length === 0) {
      rowMaterialStalePanels = [...requiredSourcePanels]
    }

    if (resolvedBuSeverity === 'unknown_impact') {
      upstreamReviewReason = 'Impact is unknown for required source panels.'
    } else if (upstreamReviewTargetLabels.length > 0) {
      upstreamReviewReason = 'Upstream review targets are being evaluated from source state.'
    } else if (reviewRecommendedPanels.length > 0 && rowUnacceptedSourcePanels.some(panelId => reviewRecommendedPanels.includes(panelId))) {
      const affected = rowUnacceptedSourcePanels
        .filter(panelId => reviewRecommendedPanels.includes(panelId))
        .map(panelId => PANEL_LABELS[panelId] || panelId)
      upstreamReviewReason = `Review required for unaccepted source panel(s): ${affected.join(', ')}.`
    } else if (resolvedBuSeverity === 'review_recommended') {
      upstreamReviewReason = 'Upstream changed; no material impact detected. Source components accepted.'
    }

    const reviewTargetRecords = buildReviewTargetsForArtifact({
      buHandoff,
      panels,
      artifactId,
      mappedHowOptionsCount,
      rowMaterialStalePanels,
      rowUnacceptedSourcePanels,
      reviewTargets: upstreamReviewTargetLabels,
      qualityAudit,
    })
    const unresolvedReviewTargets = reviewTargetRecords.filter(target => target.status === 'unresolved' && target.blocking)
    const unresolvedReviewReason = unresolvedReviewTargets.length
      ? unresolvedReviewTargets.map(target => `${target.label}: ${target.reason}`).join('; ')
      : null

    if (buBlocked || noPanelModel) {
      readinessStatus  = 'blocked_missing_source'
      blockingReason   = buHandoff.blockedReason || 'No durable Stage 3 record or panel model found for this BU.'
      missingPrerequisites = ['Stage 3 BU plan not in storage']
      remediationTarget = 'Stage 3 -> generate and accept panels for this BU, then recompile handoff'
      finalReadinessReason = blockingReason
    } else if (mappedHowOptionsCount === 0 && !reviewTargetRequested(upstreamReviewTargetLabels, ['deliverable mapping', 'stage 4 mapping', 'mapping'])) {
      readinessStatus  = 'blocked_missing_mapping'
      blockingReason   = `No how-options in Execution Sequence are mapped to "${artifactId}".`
      sourcePanelId    = 'executionSequence'
      sourcePanelLabel = 'Execution Sequence'
      missingPrerequisites = ['No how-options mapped to this artifact']
      remediationTarget = `Execution Sequence -> find ${ARTIFACT_LABELS[artifactId] || artifactId} row -> select how options`
      finalReadinessReason = blockingReason
    } else if (sourceEvidenceCount === 0) {
      readinessStatus  = 'blocked_missing_source'
      blockingReason   = 'No source atoms or accepted source sections found for this artifact.'
      missingPrerequisites = ['Stage 3 source atoms or sections missing']
      remediationTarget = 'Stage 3 -> generate and accept source components, then recompile handoff'
      finalReadinessReason = blockingReason
    } else if (unsupportedGenerator) {
      readinessStatus  = 'blocked_missing_source'
      blockingReason   = `No supported Stage 4 generator is registered for "${artifactId}".`
      missingPrerequisites = ['Unsupported Stage 4 generator']
      remediationTarget = 'Select a supported Stage 4 artifact type'
      finalReadinessReason = blockingReason
    } else if (resolvedBuSeverity === 'materially_stale' || rowMaterialStalePanels.length > 0) {
      readinessStatus  = 'blocked_materially_stale'
      blockingReason   = `Material stale impact on source panel(s): ${rowMaterialStalePanels.map(panelId => PANEL_LABELS[panelId] || panelId).join(', ') || 'required source panels'}.`
      remediationTarget = 'Stage 3 -> regenerate affected BU panels, then recompile handoff'
      finalReadinessReason = blockingReason
    } else if (rowUnacceptedSourcePanels.length > 0) {
      readinessStatus  = 'review_recommended'
      upstreamReviewReason = `Unaccepted required source panel(s): ${rowUnacceptedSourcePanels.map(panelId => PANEL_LABELS[panelId] || panelId).join(', ')}.`
      remediationTarget = 'Review and accept required Stage 3 source panels before generating'
      finalReadinessReason = upstreamReviewReason
    } else if (resolvedBuSeverity === 'unknown_impact') {
      readinessStatus  = 'review_recommended'
      remediationTarget = 'Review unresolved upstream impact before generating'
      finalReadinessReason = upstreamReviewReason || 'Upstream impact requires review.'
    } else if (unresolvedReviewTargets.length > 0) {
      readinessStatus  = 'review_recommended'
      upstreamReviewReason = unresolvedReviewReason
      remediationTarget = unresolvedReviewTargets[0]?.remediationTarget || 'Resolve review target before generating'
      finalReadinessReason = unresolvedReviewReason
    } else if (resolvedBuSeverity === 'review_recommended') {
      readinessStatus  = 'ready_with_upstream_advisory'
      remediationTarget = 'Can generate'
      finalReadinessReason = 'All required source components accepted; upstream review advisory does not block generation.'
    } else {
      readinessStatus  = 'ready'
      remediationTarget = 'Can generate'
      finalReadinessReason = 'All required source components accepted and mappings are complete.'
    }

    return {
      buId:                 buHandoff.buId || buHandoff.stableBuKey || buHandoff.buKey || buHandoff.buName,
      buName:               buHandoff.buName,
      artifactId,
      artifactTitle:        ARTIFACT_LABELS[artifactId] || artifactId,
      anchorId:             `stage3-artifact-mapping-${artifactId}`,
      readinessStatus,
      requiredSourcePanels,
      acceptedSourcePanels: rowAcceptedSourcePanels,
      unacceptedSourcePanels: rowUnacceptedSourcePanels,
      materialStalePanels: rowMaterialStalePanels,
      missingMappings,
      reviewTargets: reviewTargetRecords,
      mappedHowOptionsCount,
      sourceAtomCount,
      missingPrerequisites,
      upstreamReviewReason,
      finalReadinessReason,
      blockingReason,
      sourcePanelId,
      sourcePanelLabel,
      remediationTarget,
    }
  }).filter(Boolean)
}

/** Compact single-line preview for inline display (legacy). */
export function basisPreviewText(basis) {
  if (!basis) return 'No basis available.'
  const summary = basisReadinessSummary(basis)
  if (!summary) return 'No basis available.'
  const sourceStr = summary.sourceRecord || 'source'
  const tacticStr = basis.counts.mappedHowOptions > 0
    ? `${basis.counts.mappedHowOptions} mapped tactic${basis.counts.mappedHowOptions === 1 ? '' : 's'}`
    : 'no tactics mapped'
  const supportStr = [
    basis.counts.criticalDecisions > 0 ? `${basis.counts.criticalDecisions} decision${basis.counts.criticalDecisions === 1 ? '' : 's'}` : null,
    basis.counts.dependencies > 0 ? `${basis.counts.dependencies} dep${basis.counts.dependencies === 1 ? '' : 's'}` : null,
    basis.counts.risks > 0 ? `${basis.counts.risks} risk${basis.counts.risks === 1 ? '' : 's'}` : null,
    basis.counts.validationQuestions > 0 ? `${basis.counts.validationQuestions} validation` : null,
  ].filter(Boolean).join(', ')
  const missing = summary.prereqsMissing.length > 0 ? ` ⚠ ${summary.prereqsMissing[0]}` : ''
  return `${sourceStr} · ${tacticStr}${supportStr ? ` · ${supportStr}` : ''}${missing}`
}
