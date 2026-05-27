// Stage snapshot utilities
// Builds serialisable content snapshots of each stage's workspace data.
// Used for revision storage and word-level diff comparisons.

// ── Stage 1 snapshot ──────────────────────────────────────────────────────────

/**
 * Captures all displayable Stage 1 content from a normalized workspace.
 * Returns a plain object — no functions, no React.
 */
export function buildStage1Snapshot(nw) {
  const { entity, artifact, strategy, evidence, lineage } = nw
  const data = artifact?.data || {}
  return {
    // Artifact identity
    artifactTitle:     artifact?.title    || '',
    artifactType:      artifact?.type     || '',
    artifactSubtitle:  data.subtitle      || '',
    personaSummary:    data.personaSummary || '',
    versionNumber:     artifact?.versionNumber ?? null,

    // Strategy basis
    thesis:               strategy?.thesis               || '',
    businessProblem:      strategy?.businessProblem      || '',
    opportunity:          strategy?.opportunity          || '',
    recommendedDirection: strategy?.recommendedDirection || '',
    confidenceLevel:      strategy?.confidenceLevel      || '',
    readinessLevel:       strategy?.readinessLevel       || '',
    targetCustomer:       strategy?.targetCustomer       || '',

    // Artifact content sections
    sections: (data.sections || []).map(s => ({
      heading: s.heading || '',
      body:    s.body    || '',
    })),

    // Decisions / actions
    keyDecisions:          data.keyDecisions           || [],
    callToAction:          data.callToAction           || '',
    validationCheckpoints: data.validationCheckpoints  || [],
    readinessWarnings:     data.readinessWarnings      || [],

    // Evidence
    risks:                 evidence?.risks                 || [],
    keyInsights:           evidence?.keyInsights           || [],
    supportingClaims:      evidence?.supportingClaims      || [],
    unresolvedQuestions:   evidence?.unresolvedQuestions   || [],
    userContextAdditions:  evidence?.userContextAdditions  || [],
    stage1Intent:          evidence?.stage1Intent          || '',
    stage2Summary:         evidence?.stage2Summary         || '',
    stage3Synthesis:       evidence?.stage3Synthesis       || '',

    // Lineage
    sourceStage:           lineage?.sourceStage           || '',
    sourceArtifactVersion: lineage?.sourceArtifactVersion || '',
    lineageNotes:          lineage?.notes                 || '',
  }
}

/**
 * Flattens a Stage 1 snapshot into a single text string for word-level diff.
 * Preserves structure through section headers so diffs are legible.
 */
export function stageSnapshotToText(snapshot) {
  const lines = []

  function push(label, value) {
    if (value) lines.push(`[${label}] ${value}`)
  }
  function pushList(label, arr) {
    if (arr?.length) {
      lines.push(`[${label}]`)
      arr.forEach((item, i) => lines.push(`  ${i + 1}. ${item}`))
    }
  }

  push('Title',                snapshot.artifactTitle)
  push('Type',                 snapshot.artifactType)
  push('Subtitle',             snapshot.artifactSubtitle)
  push('Persona',              snapshot.personaSummary)
  push('Target Customer',      snapshot.targetCustomer)
  push('Confidence',           snapshot.confidenceLevel)
  push('Readiness',            snapshot.readinessLevel)
  push('Thesis',               snapshot.thesis)
  push('Business Problem',     snapshot.businessProblem)
  push('Opportunity',          snapshot.opportunity)
  push('Recommended Direction',snapshot.recommendedDirection)

  if (snapshot.sections?.length) {
    snapshot.sections.forEach(sec => {
      push(sec.heading || 'Section', sec.body)
    })
  }

  pushList('Key Decisions',          snapshot.keyDecisions)
  push('Call to Action',             snapshot.callToAction)
  pushList('Validation Checkpoints', snapshot.validationCheckpoints)
  pushList('Readiness Warnings',     snapshot.readinessWarnings)
  pushList('Identified Risks',       snapshot.risks)
  pushList('Key Insights',           snapshot.keyInsights)
  pushList('Supporting Claims',      snapshot.supportingClaims)
  pushList('Unresolved Questions',   snapshot.unresolvedQuestions)
  pushList('User Context Additions', snapshot.userContextAdditions)

  push('Stage 1 Intent',    snapshot.stage1Intent)
  push('Stage 2 Summary',   snapshot.stage2Summary)
  push('Stage 3 Synthesis', snapshot.stage3Synthesis)
  push('Source Stage',      snapshot.sourceStage)
  push('Lineage Notes',     snapshot.lineageNotes)

  return lines.join('\n')
}

// ── Stage 2 snapshot ──────────────────────────────────────────────────────────

/**
 * Captures Stage 2 business-unit content as a plain serialisable object.
 */
export function buildStage2Snapshot(businessUnits, summaryNote) {
  return {
    businessUnits: (businessUnits || []).map(u => ({ ...u })),
    summaryNote:   summaryNote || '',
  }
}

/**
 * Flattens a Stage 2 snapshot into a single text string for word-level diff.
 */
export function stage2SnapshotToText(snapshot) {
  const lines = []
  if (snapshot?.summaryNote) lines.push(`[Summary] ${snapshot.summaryNote}`)
  ;(snapshot?.businessUnits || []).forEach((bu, i) => {
    lines.push(`\n[BU ${i + 1}: ${bu.name}]`)
    if (bu.purpose)              lines.push(`  Purpose: ${bu.purpose}`)
    if (bu.strategicInvolvement) lines.push(`  Involvement: ${bu.strategicInvolvement}`)
    const list = (label, arr) => {
      if (arr?.length) {
        lines.push(`  ${label}:`)
        arr.forEach(item => lines.push(`    - ${item}`))
      }
    }
    list('Responsibilities', bu.keyResponsibilities)
    list('Dependencies',     bu.dependencies)
    list('Risks',            bu.risksAndUnknowns)
    list('Metrics',          bu.keySuccessMetrics)
  })
  return lines.join('\n')
}

// ── Revision builders ─────────────────────────────────────────────────────────

function revisionId() {
  return 'rev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7)
}

/**
 * Creates a Stage 1 AI-generated revision record.
 * Takes an already-normalised snapshot (from buildStage1Snapshot applied to a patched workspace).
 * source: 'ai'
 * refinementType: 'stage' (full-document refinement)
 */
export function buildStage1AIRevision(snapshot, revisionNumber, prompt, impactSummary) {
  return {
    id:             revisionId(),
    revisionNumber,
    label:          `Revision ${revisionNumber}`,
    prompt:         prompt        || '',
    impactSummary:  impactSummary || '',
    createdAt:      new Date().toISOString(),
    source:         'ai',
    refinementType: 'stage',
    contentSnapshot: snapshot,
  }
}

/**
 * Creates the first (import) revision for a stage.
 */
export function buildInitialRevision(normalizedWorkspace) {
  const snapshot = buildStage1Snapshot(normalizedWorkspace)
  return {
    id:             revisionId(),
    revisionNumber: 1,
    label:          'Initial import',
    prompt:         '',
    impactSummary:  'Created from imported DomainIQ Strategy Basis Package.',
    createdAt:      new Date().toISOString(),
    source:         'import',
    contentSnapshot: snapshot,
  }
}

/**
 * Creates a subsequent manual revision for a stage.
 */
export function buildManualRevision(normalizedWorkspace, revisionNumber, prompt, impactSummary) {
  const snapshot = buildStage1Snapshot(normalizedWorkspace)
  return {
    id:             revisionId(),
    revisionNumber,
    label:          `Revision ${revisionNumber}`,
    prompt:         prompt         || '',
    impactSummary:  impactSummary  || '',
    createdAt:      new Date().toISOString(),
    source:         'manual',
    contentSnapshot: snapshot,
  }
}

/**
 * Creates a Stage 2 revision record.
 * source: 'ai' | 'mock' | 'manual'
 * sourceBasisRevisionId: the Stage 1 revision ID active when this was generated.
 * refinementType: 'unit' | 'stage' | null
 *   'unit'  — a single BU was regenerated via localised refinement
 *   'stage' — a cross-functional / org-wide correction note was recorded
 *   null    — initial generation or full regeneration (no refinement context)
 * affectedUnit: string | null — BU name for unit-level refinements
 */
export function buildStage2RevisionRecord({
  businessUnits,
  summaryNote,
  revisionNumber,
  sourceBasisRevisionId,
  source,
  prompt,
  impactSummary,
  refinementType,
  affectedUnit,
  refinementScope,   // 'auto'|'wording'|'ownership'|'cross-fn'|'execution'|'kpi'|null
  structuralImpact,  // 'none'|'unit_added'|'unit_removed'|'unit_merged'|'ownership_changed'|'dependencies_changed'|null
  refinementClassification,
}) {
  const isFirst = revisionNumber === 1
  return {
    id:                   revisionId(),
    revisionNumber,
    label:                isFirst ? 'Initial generation' : `Revision ${revisionNumber}`,
    prompt:               prompt        || '',
    impactSummary:        impactSummary || '',
    createdAt:            new Date().toISOString(),
    source,
    sourceBasisRevisionId: sourceBasisRevisionId || null,
    refinementType:       refinementType  || null,
    affectedUnit:         affectedUnit    || null,
    refinementScope:      (refinementScope && refinementScope !== 'auto') ? refinementScope : null,
    structuralImpact:     structuralImpact || null,
    refinementClassification: refinementClassification || null,
    contentSnapshot:      buildStage2Snapshot(businessUnits, summaryNote),
  }
}

// ── Stage 3 snapshot ──────────────────────────────────────────────────────────

/**
 * Captures Stage 3 execution-plan content as a plain serialisable object.
 * Each executionPlan corresponds to one Stage 2 business unit.
 */
export function buildStage3Snapshot(executionPlans, summaryNote) {
  return {
    executionPlans: (executionPlans || []).map(p => ({ ...p })),
    summaryNote:    summaryNote || '',
  }
}

/**
 * Flattens a Stage 3 snapshot into a single text string for word-level diff.
 */
export function stage3SnapshotToText(snapshot) {
  const lines = []
  if (snapshot?.summaryNote) lines.push(`[Summary] ${snapshot.summaryNote}`)

  ;(snapshot?.executionPlans || []).forEach((plan, i) => {
    lines.push(`\n[Plan ${i + 1}: ${plan.buName}]`)

    const push = (label, val) => { if (val) lines.push(`  ${label}: ${val}`) }
    const list = (label, arr) => {
      if (arr?.length) {
        lines.push(`  ${label}:`)
        arr.forEach(item => {
          if (typeof item === 'string') lines.push(`    - ${item}`)
          else if (item?.text)         lines.push(`    - [${item.type || '?'}] ${item.text}`)
        })
      }
    }

    push('Mission',               plan.mission)
    list('Strategic Objectives',  plan.strategicObjectives)
    list('Mission Critical',      plan.initiativesMissionCritical)
    list('Optional',              plan.initiativesOptional)
    list('Deferred',              plan.initiativesDeferred)
    list('Blocked',               plan.initiativesBlocked)
    push('Sequencing',            plan.sequencingNarrative)
    list('Key Milestones',        plan.keyMilestones)
    list('Cross-functional Deps', plan.crossFunctionalDependencies)
    list('Required Capabilities', plan.requiredCapabilities)
    list('Staffing/Ownership',    plan.staffingOwnership)
    list('Systems/Tools',         plan.systemsTools)
    list('Governance Cadence',    plan.governanceCadence)
    list('Decision Rights',       plan.decisionRights)
    list('Risks',                 plan.risks)
    list('Constraints',           plan.constraints)
    list('Unresolved Unknowns',   plan.unresolvedUnknowns)
    list('Assumptions',           plan.assumptions)
    list('Leading Indicators',    plan.leadingIndicators)
    list('Success Metrics',       plan.keySuccessMetrics)
    list('Failure Signals',       plan.failureSignals)
    push('Readiness Assessment',  plan.readinessAssessment)
    push('Execution Risk',        plan.executionRisk)
    push('Dependency Complexity', plan.dependencyComplexity)
    push('Confidence Level',      plan.confidenceLevel)
    push('Org Readiness',         plan.organizationalReadiness)
  })

  return lines.join('\n')
}

/**
 * Creates a Stage 3 revision record.
 * source: 'ai' | 'mock' | 'manual'
 * sourceBasisRevisionId:  Stage 1 revision ID active when generated.
 * sourceStage2RevisionId: Stage 2 revision ID active when generated.
 * refinementType: 'unit' | 'stage' | null
 * affectedUnit:   BU name for unit-level refinements, null otherwise.
 */
export function buildStage3RevisionRecord({
  executionPlans,
  summaryNote,
  revisionNumber,
  sourceBasisRevisionId,
  sourceStage2RevisionId,
  source,
  prompt,
  impactSummary,
  refinementType,
  affectedUnit,
  refinementScope,   // 'auto'|'wording'|'ownership'|'cross-fn'|'execution'|'kpi'|null
  structuralImpact,  // 'none'|'unit_added'|'unit_removed'|'unit_merged'|'ownership_changed'|'dependencies_changed'|null
  refinementClassification,
}) {
  const isFirst = revisionNumber === 1
  return {
    id:                     revisionId(),
    revisionNumber,
    label:                  isFirst ? 'Initial generation' : `Revision ${revisionNumber}`,
    prompt:                 prompt        || '',
    impactSummary:          impactSummary || '',
    createdAt:              new Date().toISOString(),
    source,
    sourceBasisRevisionId:  sourceBasisRevisionId  || null,
    sourceStage2RevisionId: sourceStage2RevisionId || null,
    refinementType:         refinementType || null,
    affectedUnit:           affectedUnit   || null,
    refinementScope:        (refinementScope && refinementScope !== 'auto') ? refinementScope : null,
    structuralImpact:       structuralImpact || null,
    refinementClassification: refinementClassification || null,
    contentSnapshot:        buildStage3Snapshot(executionPlans, summaryNote),
  }
}
