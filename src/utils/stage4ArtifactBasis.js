/**
 * Stage 4 artifact basis compiler.
 *
 * Builds a compact, artifact-specific packet from accepted Stage 3 panel data.
 * The basis includes only tactics mapped to the requested Stage 4 deliverable
 * plus supporting decisions/dependencies/risks/validation items selected by
 * deterministic keyword overlap.
 */

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

  if (selectedExecutionTactics.length === 0) {
    basisWarnings.push(`No mapped how options found for ${artifactItem.artifactType}.`)
  }

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
    counts: {
      mappedHowOptions: selectedExecutionTactics.length,
      criticalDecisions: perBuBasis.reduce((sum, b) => sum + b.relevantDecisions.length, 0),
      dependencies: perBuBasis.reduce((sum, b) => sum + b.relevantDependencies.length, 0),
      risks: perBuBasis.reduce((sum, b) => sum + b.relevantRisks.length, 0),
      validationQuestions: perBuBasis.reduce((sum, b) => sum + b.relevantValidationQuestions.length, 0),
    },
  }
}

export function basisPreviewText(basis) {
  if (!basis) return 'No basis available.'
  return [
    `This artifact will use: ${basis.counts.mappedHowOptions} mapped how option${basis.counts.mappedHowOptions === 1 ? '' : 's'}, ${basis.counts.criticalDecisions} critical decision${basis.counts.criticalDecisions === 1 ? '' : 's'}, ${basis.counts.dependencies} dependenc${basis.counts.dependencies === 1 ? 'y' : 'ies'}, ${basis.counts.risks} risk${basis.counts.risks === 1 ? '' : 's'}, ${basis.counts.validationQuestions} validation question${basis.counts.validationQuestions === 1 ? '' : 's'}.`,
    'Excluded: unmapped tactics and unrelated panels.',
  ].join(' ')
}
