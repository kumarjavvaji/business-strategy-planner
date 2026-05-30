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

// ── Constants ──────────────────────────────────────────────────────────────────

export const ARTIFACT_PLAN_VERSION = 1

export const ARTIFACT_PLAN_STATUS = {
  DRAFT:                'draft',
  READY_FOR_GENERATION: 'ready_for_generation',
  STALE:                'stale',
}

export const ARTIFACT_READINESS = {
  READY:   'ready',
  PARTIAL: 'partial',
  BLOCKED: 'blocked',
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

export function stage4ArtifactPlanKey(workspaceId, stage1Id, stage2Id, stage3Id) {
  return `bsp_v1_stage4_artifact_plan_${workspaceId}_${stage1Id}_${stage2Id}_${stage3Id}`
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
        selected:            true,
        generationStatus:    GENERATION_STATUS.NOT_STARTED,
        createdAt:           now,
        updatedAt:           now,
      })
    }
  }

  // Per-BU artifacts — PARTIAL
  for (const bu of partialBUs) {
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
        selected:            true,
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

  const globalArtifacts     = artifacts.filter(a => a.scope === 'global')
  const businessUnitArtifacts = artifacts.filter(a => a.scope === 'business_unit')

  return {
    version:                        ARTIFACT_PLAN_VERSION,
    workspaceId,
    stage1RevisionId:               stage1Id,
    stage2RevisionId:               stage2Id,
    stage3RevisionId:               stage3Id,
    handoffKey:                     `bsp_v1_stage4_handoff_${workspaceId}_${stage1Id}_${stage2Id}_${stage3Id}`,
    generatedFromHandoffPersistedAt: handoff.persistedAt,
    generatedFromHandoffCompiledAt:  handoff.compiledAt,
    status:                         ARTIFACT_PLAN_STATUS.DRAFT,
    globalArtifacts,
    businessUnitArtifacts,
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
