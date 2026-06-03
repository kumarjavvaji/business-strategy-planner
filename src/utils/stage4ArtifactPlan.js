/**
 * Stage 4 artifact planning utilities.
 *
 * Deterministically suggests artifact types from a verified Stage 4 handoff.
 * Does NOT call AI — artifact content generation is a separate step.
 *
 * Storage key: bsp_v1_stage4_artifact_plan_{workspaceId}_{stage1Id}_{stage2Id}_{stage3Id}
 * Store:       IndexedDB → stage4_artifact_plans  (IDB-primary, LS pointer)
 *
 * Staleness: plan.generatedFromHandoffPersistedAt !== handoff.persistedAt
 *
 * Source invariant: readArtifactFromIdb is used for all loads so the cache
 * cannot surface an artifact plan that was never durably written.
 */

import { readArtifactFromIdb, writeArtifact } from './storageRouter'
import { BU_HANDOFF_STATUS, HANDOFF_STATUS } from './stage4Handoff'
import { compileArtifactBasis } from './stage4ArtifactBasis'
import { deriveSectionChildDefs } from './stage4ArtifactPrompts'
import { resolveArtifactSpec } from './stage4ArtifactSpecs'

// ── Constants ──────────────────────────────────────────────────────────────────

export const ARTIFACT_PLAN_VERSION = 1

export const ARTIFACT_PLAN_STATUS = {
  DRAFT:                'draft',
  READY_FOR_GENERATION: 'ready_for_generation',
  STALE:                'stale',
}

export const STAGE4_QUALITY_ISSUE_TYPES = [
  'genuinely_truncated',
  'repeated_content',
  'copied_source_prose',
  'missing_source_mapping',
  'missing_actionable_content',
  'generic_filler',
  'unsupported_artifact_type',
  'missing_artifact_spec',
  'missing_required_section',
  'failed_atom',
  'parse_failed',
  'source_basis_incomplete',
]

export const DEFAULT_STAGE4_QUALITY_POLICY = {
  policyId: 'stage4_default_authoring_quality_policy_v1',
  checks: [
    'no_truncation_markers',
    'no_incomplete_sentence_endings',
    'no_repeated_paragraph_blocks',
    'no_copied_stage3_prose_except_labeled_source_refs',
    'every_generated_section_maps_to_source_atoms',
    'every_section_adds_distinct_artifact_value',
    'audience_appropriate',
    'sme_reviewable',
    'actionable_not_generic_filler',
    'required_sections_present',
    'missing_prerequisites_block_generation',
  ],
  issueTypes: STAGE4_QUALITY_ISSUE_TYPES,
}

export const ARTIFACT_READINESS = {
  READY:                         'ready',
  PARTIAL:                       'partial',
  BLOCKED:                       'blocked',
  BLOCKED_UNSUPPORTED_GENERATOR: 'blocked_unsupported_generator',
  BLOCKED_MISSING_ARTIFACT_SPEC: 'blocked_missing_artifact_spec',
  BLOCKED_MISSING_SOURCE:        'blocked_missing_source',
  BLOCKED_MISSING_MAPPING:       'blocked_missing_mapping',
  BLOCKED_MATERIALLY_STALE:      'blocked_materially_stale',
}

export function artifactReadinessBlocksGeneration(status) {
  return status === ARTIFACT_READINESS.BLOCKED || String(status || '').startsWith('blocked_')
}

export const GENERATION_STATUS = {
  NOT_STARTED: 'not_started',
  QUEUED:      'queued',
  GENERATING:  'generating',
  GENERATED:   'generated',
  FAILED:      'failed',
}

// ── Artifact type catalogue ────────────────────────────────────────────────────

export const GLOBAL_ARTIFACT_DEFS = [
  {
    type: 'executive_decision_brief',
    title: 'Executive Decision Brief',
    purpose: 'Synthesises cross-BU execution commitments, key decisions required, and governance sign-offs into a single board-ready document.',
  },
  {
    type: 'cross_bu_dependency_map',
    title: 'Cross-BU Dependency Map',
    purpose: 'Maps all cross-functional dependencies identified in BU execution plans to surface sequencing risks before delivery begins.',
  },
  {
    type: 'risk_control_plan',
    title: 'Risk and Control Plan',
    purpose: 'Consolidates execution risks from all BU plans into a prioritised risk register with proposed controls and owners.',
  },
  {
    type: 'operating_cadence_plan',
    title: 'Operating Cadence Plan',
    purpose: 'Defines the shared governance cadence — review cycles, escalation paths, and decision checkpoints — across all BU execution tracks.',
  },
  {
    type: 'global_sme_review_packet',
    title: 'SME Review Packet',
    purpose: 'Packages the full execution scope for specialist review before committing to delivery phases.',
  },
]

export const BU_ARTIFACT_DEFS = {
  ready: [
    {
      type: 'bu_execution_plan',
      title: 'BU Execution Plan',
      purpose: 'Translates the BU Stage 3 execution sections into a structured delivery plan with workstreams, owners, and gate criteria.',
    },
    {
      type: 'pdlc_epic_outline',
      title: 'PDLC Epic Outline',
      purpose: 'Maps the BU execution strategy to product delivery epics with scope, acceptance boundaries, and sequencing.',
    },
    {
      type: 'acceptance_criteria_draft',
      title: 'Acceptance Criteria Draft',
      purpose: 'Drafts outcome-based acceptance criteria for each major execution section, aligned to validation readiness checks.',
    },
    {
      type: 'implementation_governance_checklist',
      title: 'Implementation Governance Checklist',
      purpose: 'Converts the BU governance model and decision rights into a checklist for implementation-phase review gates.',
    },
  ],
  partial: [
    {
      type: 'bu_sme_review_packet',
      title: 'SME Review Packet',
      purpose: 'Packages the available partial BU execution plan for specialist review to identify gaps before full generation.',
    },
    {
      type: 'dependency_risk_brief',
      title: 'Dependency and Risk Brief',
      purpose: 'Summarises cross-functional dependencies and execution risks from the partial BU plan for handoff coordination.',
    },
    {
      type: 'bu_execution_plan_partial',
      title: 'BU Execution Plan (Partial)',
      purpose: 'Generates a partial BU execution plan from the available sections, clearly marking incomplete areas for review.',
    },
  ],
}

// ── Key helpers ────────────────────────────────────────────────────────────────

function safe(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '_')
}

function sourcePanelRefsForBu(bu) {
  const panels = bu?.stage3PanelModel?.panels || bu?.panelModel?.panels || bu?.sourcePanelModel?.panels || {}
  return Object.entries(panels).map(([panelId, panel]) => ({
    panelId,
    lifecycle: panel?.lifecycle || null,
    accepted: !panel?.lifecycle || panel.lifecycle === 'accepted',
    sourceAtomIds: panel?.sourceAtomIds || [],
  }))
}

function requiredPanelsForBasis(basis, artifactSpec = null) {
  const specPanels = artifactSpec?.requiredSourcePanels || []
  const derivedPanels = [
    'strategicObjective',
    'executionSequence',
    basis?.counts?.criticalDecisions > 0 ? 'criticalDecisions' : null,
    basis?.counts?.dependencies > 0 ? 'dependencies' : null,
    basis?.counts?.risks > 0 ? 'risks' : null,
    basis?.counts?.validationQuestions > 0 ? 'validationFramework' : null,
  ].filter(Boolean)
  return [...new Set([...specPanels, ...derivedPanels])]
}

function artifactScopeFor(item) {
  if (item.scope === 'global') return 'global'
  if (item.scope === 'cross_bu') return 'cross_bu'
  return 'bu'
}

function deriveGenerationUnits(item, artifactBasis, artifactSpec) {
  const sectionOutline = artifactSpec?.sectionSchema || []
  const requiredPanels = requiredPanelsForBasis(artifactBasis, artifactSpec)
  const qualityChecks = artifactSpec?.qualityPolicy?.checks || DEFAULT_STAGE4_QUALITY_POLICY.checks
  return sectionOutline.map(sectionDef => {
    const childDefs = deriveSectionChildDefs(sectionDef, artifactBasis)
    return {
      unitId: sectionDef.id,
      sectionId: sectionDef.id,
      heading: sectionDef.heading,
      purpose: sectionDef.purpose,
      generationMode: sectionDef.generationMode || 'single',
      sourcePanelRefs: requiredPanels,
      artifactSpecRef: {
        artifactType: artifactSpec.artifactType,
        sectionId: sectionDef.id,
      },
      items: childDefs.length ? childDefs.map(child => ({
        itemId: child.childId,
        label: child.label,
        atomType: child.atomType,
        sourceAtomRefs: child.sourceAtomRefs || [],
        sourcePanelRefs: requiredPanels,
        requiredOutputUnits: artifactSpec?.sectionChildUnitSchema || [],
        atoms: [{
          atomId: child.childId,
          artifactJobId: item.artifactId,
          sectionId: sectionDef.id,
          itemId: child.childId,
          sourceAtomRefs: child.sourceAtomRefs || [],
          sourcePanelRefs: requiredPanels,
          intendedOutputRole: child.atomType || sectionDef.atomType || 'artifact_atom',
          promptPurpose: child.inputBasis || sectionDef.purpose,
          requiredOutputUnits: artifactSpec?.sectionChildUnitSchema || [],
          smeLens: artifactSpec?.smeLens || null,
          boundedScope: child.isStaticAtom ? 'static synthesis atom' : 'single source item transformation',
          validationRules: qualityChecks,
          status: 'not_started',
          content: null,
          rawOutputOnFailure: null,
          error: null,
          retryCount: 0,
          persistedAt: null,
        }],
      })) : [{
        itemId: `${sectionDef.id}:section`,
        label: sectionDef.heading,
        atomType: 'section',
        sourceAtomRefs: artifactBasis?.sourceTraceability?.sourceAtomIds || [],
        sourcePanelRefs: requiredPanels,
        requiredOutputUnits: artifactSpec?.sectionChildUnitSchema || [],
        atoms: [{
          atomId: `${sectionDef.id}:section`,
          artifactJobId: item.artifactId,
          sectionId: sectionDef.id,
          itemId: `${sectionDef.id}:section`,
          sourceAtomRefs: artifactBasis?.sourceTraceability?.sourceAtomIds || [],
          sourcePanelRefs: requiredPanels,
          intendedOutputRole: 'artifact_section',
          promptPurpose: sectionDef.purpose,
          requiredOutputUnits: artifactSpec?.sectionChildUnitSchema || [],
          smeLens: artifactSpec?.smeLens || null,
          boundedScope: 'single artifact section',
          validationRules: qualityChecks,
          status: 'not_started',
          content: null,
          rawOutputOnFailure: null,
          error: null,
          retryCount: 0,
          persistedAt: null,
        }],
      }],
    }
  })
}

function readinessForArtifact(item, bu, artifactBasis, artifactSpec) {
  if (item.artifactType === 'blocked') {
    return {
      status: item.readinessStatus || ARTIFACT_READINESS.BLOCKED,
      missingPrerequisites: [...(artifactBasis?.missingPrerequisites || [])],
      blockers: item.blockedReason ? [{ type: 'blocked_bu_source', reason: item.blockedReason }] : [],
      advisoryFlags: [],
    }
  }
  const blockers = []
  const missingPrerequisites = [...(artifactBasis?.missingPrerequisites || [])]
  const advisoryFlags = []
  let blockedStatus = null
  if (!artifactSpec) {
    blockers.push({ type: 'missing_artifact_spec', reason: `No artifact authoring spec is registered for ${item.artifactType}.` })
    blockedStatus = ARTIFACT_READINESS.BLOCKED_MISSING_ARTIFACT_SPEC
  }
  if ((item.sourceAtomIds || []).length === 0 && (artifactBasis?.sourceTraceability?.sourceSectionIds || []).length === 0) {
    blockers.push({ type: 'missing_source_atoms', reason: 'No accepted Stage 3 source atoms or source sections are available.' })
    missingPrerequisites.push({ type: 'missing_source_atoms', description: 'Accepted Stage 3 source atoms or sections are required.' })
    blockedStatus = blockedStatus || ARTIFACT_READINESS.BLOCKED_MISSING_SOURCE
  }
  if ((artifactBasis?.counts?.mappedHowOptions || 0) === 0) {
    advisoryFlags.push({ type: 'missing_source_mapping', reason: 'No mapped how-options are available yet; generation will be blocked until mapping is complete.' })
  }
  if (bu?.status === BU_HANDOFF_STATUS.PARTIAL) {
    advisoryFlags.push({ type: 'partial_source_basis', reason: 'Source BU handoff is partial.' })
  }
  return {
    status: blockers.length ? blockedStatus || ARTIFACT_READINESS.BLOCKED : item.readinessStatus,
    missingPrerequisites,
    blockers,
    advisoryFlags,
  }
}

function buildAuthoringJob(item, handoff, workspaceId, stage1Id, stage2Id, stage3Id) {
  const bu = item.businessUnitName
    ? (handoff.buHandoffs || []).find(entry => entry.buName === item.businessUnitName)
    : null
  const artifactBasis = compileArtifactBasis(item, handoff)
  const artifactSpec = resolveArtifactSpec(item.artifactType)
  const readiness = readinessForArtifact(item, bu, artifactBasis, artifactSpec)
  const requiredPanels = requiredPanelsForBasis(artifactBasis, artifactSpec)
  const sourcePanelRefs = item.businessUnitName
    ? sourcePanelRefsForBu(bu).filter(ref => !requiredPanels.length || requiredPanels.includes(ref.panelId))
    : (handoff.buHandoffs || []).flatMap(entry => sourcePanelRefsForBu(entry))
  const sourceAtomRefs = artifactBasis?.sourceTraceability?.sourceAtomIds || item.sourceAtomIds || []
  const generationUnits = artifactSpec ? deriveGenerationUnits(item, artifactBasis, artifactSpec) : []

  return {
    ...item,
    selected: !artifactReadinessBlocksGeneration(readiness.status) && item.selected,
    artifactJobId: item.artifactId,
    artifactTitle: item.title,
    artifactScope: artifactScopeFor(item),
    sourceBuId: bu?.buId || bu?.stableBuKey || bu?.buKey || item.businessUnitName || null,
    sourceBuName: item.businessUnitName || null,
    audience: item.scope === 'global' ? 'executive / cross-functional delivery leadership' : 'BU delivery owners and accountable reviewers',
    artifactSpecRef: artifactSpec ? {
      artifactType: artifactSpec.artifactType,
      artifactTitle: artifactSpec.artifactTitle,
      artifactScope: artifactSpec.artifactScope,
      specVersion: artifactSpec.qualityPolicy?.policyId || 'stage4_artifact_spec_v1',
      requiredSourcePanels: artifactSpec.requiredSourcePanels,
      requiredSourceAtoms: artifactSpec.requiredSourceAtoms,
      smeLens: artifactSpec.smeLens,
      acceptanceChecks: artifactSpec.acceptanceChecks,
      remediationRules: artifactSpec.remediationRules,
    } : null,
    sourceBasis: {
      stage3BuRecordId: bu?.sourcePersistKey || null,
      requiredPanels,
      sourceAtomRefs,
      sourcePanelRefs,
      handoffItemRefs: bu?.sourceSectionIds || [],
    },
    readiness,
    readinessStatus: readiness.status,
    blockedReason: readiness.blockers[0]?.reason || item.blockedReason || null,
    generationUnits,
    qualityPolicy: artifactSpec?.qualityPolicy || DEFAULT_STAGE4_QUALITY_POLICY,
    lifecycle: {
      status: 'not_started',
      generationStatus: GENERATION_STATUS.NOT_STARTED,
      acceptedAt: null,
      updatedAt: item.updatedAt,
    },
    planRefs: {
      workspaceId,
      stageId: 'stage4',
      sourceRevisionIds: { stage1: stage1Id, stage2: stage2Id, stage3: stage3Id },
    },
  }
}

function shouldRefreshSpecBackedJob(item) {
  if (!resolveArtifactSpec(item?.artifactType)) return false
  return item.readinessStatus === ARTIFACT_READINESS.BLOCKED_UNSUPPORTED_GENERATOR ||
    !item.artifactSpecRef ||
    !(item.generationUnits || []).length
}

export function upgradeArtifactPlanSpecCoverage(plan, handoff, workspaceId, stage1Id, stage2Id, stage3Id) {
  if (!plan || !handoff) return plan
  const upgradeItem = item => {
    if (!shouldRefreshSpecBackedJob(item)) return item
    const shouldRestoreSelection = item.readinessStatus === ARTIFACT_READINESS.BLOCKED_UNSUPPORTED_GENERATOR
    return buildAuthoringJob(
      {
        ...item,
        selected: shouldRestoreSelection ? true : item.selected,
        readinessStatus: item.sourceHandoffStatus === BU_HANDOFF_STATUS.PARTIAL
          ? ARTIFACT_READINESS.PARTIAL
          : ARTIFACT_READINESS.READY,
        blockedReason: null,
      },
      handoff,
      workspaceId || plan.workspaceId,
      stage1Id || plan.stage1RevisionId,
      stage2Id || plan.stage2RevisionId,
      stage3Id || plan.stage3RevisionId,
    )
  }

  const nextGlobalArtifacts = (plan.globalArtifacts || []).map(upgradeItem)
  const nextBusinessUnitArtifacts = (plan.businessUnitArtifacts || []).map(upgradeItem)
  const byId = new Map([...nextGlobalArtifacts, ...nextBusinessUnitArtifacts].map(item => [item.artifactId, item]))
  const nextArtifacts = (plan.artifacts?.length ? plan.artifacts : [...(plan.globalArtifacts || []), ...(plan.businessUnitArtifacts || [])])
    .map(item => byId.get(item.artifactId) || upgradeItem(item))
  const upgraded = nextArtifacts.some((item, index) => item !== (plan.artifacts?.length ? plan.artifacts : [...(plan.globalArtifacts || []), ...(plan.businessUnitArtifacts || [])])[index])

  return {
    ...plan,
    artifacts: nextArtifacts,
    globalArtifacts: nextGlobalArtifacts,
    businessUnitArtifacts: nextBusinessUnitArtifacts,
    planningDiagnostics: {
      ...(plan.planningDiagnostics || {}),
      specCoverageUpgraded: Boolean(plan.planningDiagnostics?.specCoverageUpgraded || upgraded),
    },
  }
}

export function stage4ArtifactPlanKey(workspaceId, stage1Id, stage2Id, stage3Id) {
  return `bsp_v1_stage4_artifact_plan_${workspaceId}_${stage1Id}_${stage2Id}_${stage3Id}`
}

/**
 * Retroactively applies the Stage 3 "selectedStage4Deliverables" signal to a
 * persisted artifact plan.
 *
 * Plans created before the suggestArtifacts S3-selection fix auto-selected every
 * BU artifact type (selected: true) regardless of what the user checked in the
 * Stage 3 Execution Sequence panel.  This function corrects that: any BU artifact
 * whose type is absent from the BU's selectedStage4Deliverables is set to
 * selected: false.
 *
 * Rules:
 *  - Only corrects BU-scoped artifacts (scope === 'business_unit').
 *  - Only corrects when the BU's selectedStage4Deliverables list is non-empty
 *    (empty list = user never configured the panel → preserve existing selected).
 *  - Never turns selected: false → true (respects explicit user deselections).
 *  - Blocked artifacts are already selected: false and are left unchanged.
 *  - Returns the same object reference when no correction is needed (cheap equality check).
 */
export function correctPlanSelectionFromS3(plan, handoff) {
  if (!plan || !handoff) return plan

  const buHandoffByName = new Map(
    (handoff.buHandoffs || []).map(b => [b.buName, b])
  )

  // Build a map of buName → Set<deliverableType> from Stage 3 panel model.
  // Empty set means no S3 selection exists → no correction for that BU.
  const s3SelectionByBu = new Map()
  buHandoffByName.forEach((bu, buName) => {
    const execPanel = bu.stage3PanelModel?.panels?.executionSequence
    const types = (execPanel?.selectedStage4Deliverables || []).map(d => d.deliverableType)
    if (types.length > 0) s3SelectionByBu.set(buName, new Set(types))
  })

  if (s3SelectionByBu.size === 0) return plan // nothing to correct

  let changed = false

  const correctItem = item => {
    if (item.scope !== 'business_unit') return item   // global artifacts unchanged
    if (!item.selected) return item                   // already unselected — no-op
    if (artifactReadinessBlocksGeneration(item.readinessStatus)) return item // blocked — already false

    const s3Types = s3SelectionByBu.get(item.businessUnitName)
    if (!s3Types) return item // BU has no S3 selection data → no correction

    if (!s3Types.has(item.artifactType)) {
      changed = true
      return { ...item, selected: false }
    }
    return item
  }

  const nextBuArtifacts = (plan.businessUnitArtifacts || []).map(correctItem)
  if (!changed) return plan

  const byId = new Map(nextBuArtifacts.map(a => [a.artifactId, a]))
  const nextArtifacts = (plan.artifacts || [...(plan.globalArtifacts || []), ...nextBuArtifacts])
    .map(a => byId.get(a.artifactId) || a)

  return {
    ...plan,
    businessUnitArtifacts: nextBuArtifacts,
    artifacts: nextArtifacts,
  }
}

// ── Artifact suggestion (pure, no AI) ─────────────────────────────────────────

/**
 * Deterministically derives suggested artifact items from a verified handoff.
 * Returns an array of artifact items; does not write anything.
 */
export function suggestArtifacts(handoff) {
  const now  = new Date().toISOString()
  const artifacts = []

  const readyBUs   = handoff.buHandoffs.filter(b => b.status === BU_HANDOFF_STATUS.READY)
  const partialBUs = handoff.buHandoffs.filter(b => b.status === BU_HANDOFF_STATUS.PARTIAL)
  const blockedBUs = handoff.buHandoffs.filter(b => b.status === BU_HANDOFF_STATUS.BLOCKED)

  const usableBuNames   = [...readyBUs, ...partialBUs].map(b => b.buName)
  const allSourceAtoms  = handoff.buHandoffs.flatMap(b => b.sourceAtomIds || [])

  // Global artifacts — only when at least one BU is ready or partial
  if (handoff.overallStatus !== HANDOFF_STATUS.BLOCKED) {
    const globalReadiness = readyBUs.length > 0 ? ARTIFACT_READINESS.READY : ARTIFACT_READINESS.PARTIAL
    for (const def of GLOBAL_ARTIFACT_DEFS) {
      artifacts.push({
        artifactId:          `global_${def.type}`,
        scope:               'global',
        businessUnitName:    null,
        artifactType:        def.type,
        title:               def.title,
        purpose:             def.purpose,
        sourceBuNames:       usableBuNames,
        sourceHandoffStatus: handoff.overallStatus,
        sourceAtomIds:       allSourceAtoms,
        readinessStatus:     globalReadiness,
        blockedReason:       null,
        selected:            true,
        generationStatus:    GENERATION_STATUS.NOT_STARTED,
        createdAt:           now,
        updatedAt:           now,
      })
    }
  }

  // Per-BU artifacts — READY
  for (const bu of readyBUs) {
    // Honour the user's Stage 3 execution-sequence deliverable selection.
    // selectedStage4Deliverables is the list of artifact types the user checked in
    // the "Stage 4 deliverables to prepare" panel.  When present and non-empty we
    // only auto-select artifact types that appear in that list; unchecked types are
    // suggested (visible in edit mode) but default to selected: false so they are
    // excluded from the active generation view without requiring another manual step.
    // When the list is absent (older handoffs / panel model not yet saved) we fall
    // back to selecting everything to avoid breaking existing workflows.
    const s3ExecPanel    = bu.stage3PanelModel?.panels?.executionSequence
    const s3SelectedTypes = (s3ExecPanel?.selectedStage4Deliverables || []).map(d => d.deliverableType)
    const hasS3Selection  = s3SelectedTypes.length > 0

    for (const def of BU_ARTIFACT_DEFS.ready) {
      artifacts.push({
        artifactId:          `bu_${safe(bu.buName)}_${def.type}`,
        scope:               'business_unit',
        businessUnitName:    bu.buName,
        artifactType:        def.type,
        title:               def.title,
        purpose:             def.purpose,
        sourceBuNames:       [bu.buName],
        sourceHandoffStatus: bu.status,
        sourceAtomIds:       bu.sourceAtomIds || [],
        readinessStatus:     ARTIFACT_READINESS.READY,
        blockedReason:       null,
        selected:            hasS3Selection ? s3SelectedTypes.includes(def.type) : true,
        generationStatus:    GENERATION_STATUS.NOT_STARTED,
        createdAt:           now,
        updatedAt:           now,
      })
    }
  }

  // Per-BU artifacts — PARTIAL
  for (const bu of partialBUs) {
    const s3ExecPanel    = bu.stage3PanelModel?.panels?.executionSequence
    const s3SelectedTypes = (s3ExecPanel?.selectedStage4Deliverables || []).map(d => d.deliverableType)
    const hasS3Selection  = s3SelectedTypes.length > 0

    for (const def of BU_ARTIFACT_DEFS.partial) {
      artifacts.push({
        artifactId:          `bu_${safe(bu.buName)}_${def.type}`,
        scope:               'business_unit',
        businessUnitName:    bu.buName,
        artifactType:        def.type,
        title:               def.title,
        purpose:             def.purpose,
        sourceBuNames:       [bu.buName],
        sourceHandoffStatus: bu.status,
        sourceAtomIds:       bu.sourceAtomIds || [],
        readinessStatus:     ARTIFACT_READINESS.PARTIAL,
        blockedReason:       null,
        selected:            hasS3Selection ? s3SelectedTypes.includes(def.type) : true,
        generationStatus:    GENERATION_STATUS.NOT_STARTED,
        createdAt:           now,
        updatedAt:           now,
      })
    }
  }

  // Per-BU artifacts — BLOCKED: one placeholder per BU, not selectable
  for (const bu of blockedBUs) {
    artifacts.push({
      artifactId:          `bu_${safe(bu.buName)}_blocked`,
      scope:               'business_unit',
      businessUnitName:    bu.buName,
      artifactType:        'blocked',
      title:               `${bu.buName} — Blocked`,
      purpose:             'No durable Stage 3 execution plan. Return to Stage 3 to generate and persist a BU plan before artifact planning.',
      sourceBuNames:       [bu.buName],
      sourceHandoffStatus: bu.status,
      sourceAtomIds:       [],
      readinessStatus:     ARTIFACT_READINESS.BLOCKED,
      blockedReason:       bu.blockedReason || 'No durable Stage 3 record.',
      selected:            false,
      generationStatus:    GENERATION_STATUS.NOT_STARTED,
      createdAt:           now,
      updatedAt:           now,
    })
  }

  return artifacts
}

// ── Plan construction ──────────────────────────────────────────────────────────

/**
 * Builds an artifact plan record in memory from a verified handoff.
 * persistedAt is null until persistArtifactPlan() writes it to IDB.
 */
export function buildArtifactPlan(handoff, workspaceId, stage1Id, stage2Id, stage3Id) {
  const now = new Date().toISOString()
  const artifacts = suggestArtifacts(handoff)
  const authoredArtifacts = artifacts.map(item => buildAuthoringJob(item, handoff, workspaceId, stage1Id, stage2Id, stage3Id))
  const globalArtifacts     = authoredArtifacts.filter(a => a.scope === 'global')
  const businessUnitArtifacts = authoredArtifacts.filter(a => a.scope === 'business_unit')
  const planningFailures = []
  if (!handoff?.persistedAt) planningFailures.push({ type: 'missing_verified_handoff', reason: 'Verified handoff is missing or not persisted.' })
  if (!(handoff?.buHandoffs || []).some(bu => bu.status !== BU_HANDOFF_STATUS.BLOCKED)) planningFailures.push({ type: 'no_eligible_bu_records', reason: 'No eligible BU records are available.' })
  if (!authoredArtifacts.length) planningFailures.push({ type: 'no_artifact_candidates', reason: 'No artifact candidates could be derived from the handoff.' })
  if (authoredArtifacts.some(artifact => artifact.readiness.blockers.some(blocker => blocker.type === 'missing_source_atoms'))) {
    planningFailures.push({ type: 'missing_source_atoms', reason: 'One or more artifact jobs lack accepted Stage 3 source atoms or source sections.' })
  }
  if (authoredArtifacts.some(artifact => artifact.readiness.blockers.some(blocker => blocker.type === 'missing_artifact_spec'))) {
    const missingTypes = [...new Set(authoredArtifacts
      .filter(artifact => artifact.readiness.blockers.some(blocker => blocker.type === 'missing_artifact_spec'))
      .map(artifact => artifact.artifactType))]
    planningFailures.push({ type: 'missing_artifact_spec', reason: `Artifact specs are missing for: ${missingTypes.join(', ')}.` })
  }

  return {
    version:                        ARTIFACT_PLAN_VERSION,
    planId:                         `stage4_plan_${workspaceId}_${stage1Id}_${stage2Id}_${stage3Id}`,
    workspaceId,
    stageId:                        'stage4',
    sourceHandoffId:                handoff.handoffId || handoff.handoffKey || `bsp_v1_stage4_handoff_${workspaceId}_${stage1Id}_${stage2Id}_${stage3Id}`,
    sourceRevisionIds: {
      stage1: stage1Id,
      stage2: stage2Id,
      stage3: stage3Id,
    },
    stage1RevisionId:               stage1Id,
    stage2RevisionId:               stage2Id,
    stage3RevisionId:               stage3Id,
    handoffKey:                     `bsp_v1_stage4_handoff_${workspaceId}_${stage1Id}_${stage2Id}_${stage3Id}`,
    generatedFromHandoffPersistedAt: handoff.persistedAt,
    generatedFromHandoffCompiledAt:  handoff.compiledAt,
    status:                         ARTIFACT_PLAN_STATUS.DRAFT,
    artifacts:                      authoredArtifacts,
    globalArtifacts,
    businessUnitArtifacts,
    planningDiagnostics: {
      planningFailures,
      eligibleBuCount: (handoff?.buHandoffs || []).filter(bu => bu.status !== BU_HANDOFF_STATUS.BLOCKED).length,
      artifactCandidateCount: authoredArtifacts.length,
      generationCalled: false,
    },
    reviewNotes:                    '',
    createdAt:                      now,
    updatedAt:                      now,
    persistedAt:                    null,  // set by persistArtifactPlan()
  }
}

// ── Persistence ────────────────────────────────────────────────────────────────

/**
 * Writes the artifact plan to IDB via writeArtifact.
 * Sets persistedAt on the written record only if the write succeeds.
 * Returns { ok, key, record }.
 */
export async function persistArtifactPlan(plan) {
  const key = stage4ArtifactPlanKey(
    plan.workspaceId,
    plan.stage1RevisionId,
    plan.stage2RevisionId,
    plan.stage3RevisionId,
  )
  const now    = new Date().toISOString()
  const record = { ...plan, persistedAt: now, updatedAt: now }
  const ok     = await writeArtifact(key, record)
  return { ok, key, record: ok ? record : plan }
}

/**
 * Reads the artifact plan directly from IDB, bypassing the cache.
 * Returns null if absent or version mismatch.
 */
export async function loadArtifactPlan(workspaceId, stage1Id, stage2Id, stage3Id) {
  const key = stage4ArtifactPlanKey(workspaceId, stage1Id, stage2Id, stage3Id)
  try {
    const record = await readArtifactFromIdb(key)
    if (!record || record.version !== ARTIFACT_PLAN_VERSION) return null
    if (!record.persistedAt) return null
    return record
  } catch {
    return null
  }
}

// ── Staleness detection ────────────────────────────────────────────────────────

/**
 * Returns true when the handoff has been re-persisted after the plan was built.
 * Does NOT delete the plan — callers should mark it stale and offer rebuild.
 */
export function isArtifactPlanStale(plan, handoff) {
  if (!plan || !handoff) return false
  return plan.generatedFromHandoffPersistedAt !== handoff.persistedAt
}
