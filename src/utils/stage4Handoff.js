/**
 * Stage 3 → Stage 4 handoff compiler.
 *
 * SOURCE INVARIANT: the compiler prefers durable per-BU IDB records
 * (bsp_v1_stage3_bu_plan_*) read via readArtifactFromIdb().  When a per-BU
 * record is absent, it falls back to the accepted Stage 3 revision snapshot
 * (contentSnapshot.executionPlans[]) passed by the caller.  This covers the
 * full-rebuild path (runChunkedStage3), which saves execution plans into the
 * revision snapshot only and does NOT write per-BU IDB records.
 *
 * The snapshot fallback is only accepted when:
 *   • the caller supplies stage3ActiveRevision
 *   • stage3ActiveRevision.id === stage3Id (matches the active revision)
 *   • stage3ActiveRevision.sourceBasisRevisionId === stage1Id
 *   • stage3ActiveRevision.sourceStage2RevisionId === stage2Id
 *
 * Provenance is tracked on every BU handoff entry via sourceType:
 *   "stage3_bu_plan_record"     — per-BU IDB atom record (full traceability)
 *   "stage3_revision_snapshot"  — accepted Stage 3 revision snapshot (section traceability)
 *
 * OUTPUT INVARIANT: the compiled handoff record is written via writeArtifact()
 * to the stage4_handoffs IDB store.  Callers must treat the handoff as unusable
 * until writeArtifact returns true and the record can be read back from storage.
 *
 * Key shapes:
 *   Stage 3 source : bsp_v1_stage3_bu_plan_{wid}_{s1id}_{s2id}_{buNameSafe}
 *   Stage 4 handoff: bsp_v1_stage4_handoff_{wid}_{s1id}_{s2id}_{s3id}
 */

import { readArtifactFromIdb, readArtifactAsync, writeArtifact } from './storageRouter'

// ── Key helpers ────────────────────────────────────────────────────────────────

function storageSafeName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '_')
}

export function stage3BuPlanDraftKey(workspaceId, stage1Id, stage2Id, buName) {
  return `bsp_v1_stage3_bu_plan_${workspaceId}_${stage1Id}_${stage2Id}_${storageSafeName(buName)}`
}

export function stage4HandoffKey(workspaceId, stage1Id, stage2Id, stage3Id) {
  return `bsp_v1_stage4_handoff_${workspaceId}_${stage1Id}_${stage2Id}_${stage3Id}`
}

// ── Constants ──────────────────────────────────────────────────────────────────

export const STAGE4_HANDOFF_VERSION = 1

export const BU_HANDOFF_STATUS = {
  READY:   'ready',    // durable record present, all required fields found
  PARTIAL: 'partial',  // record present but atoms/sections incomplete
  BLOCKED: 'blocked',  // no durable record and no usable snapshot entry
}

export const HANDOFF_STATUS = {
  READY:   'ready',    // all required BUs are ready
  PARTIAL: 'partial',  // at least one ready, some partial/blocked
  BLOCKED: 'blocked',  // no BUs are ready
}

// Provenance: which storage path supplied this BU's data
export const BU_SOURCE_TYPE = {
  IDB_RECORD:          'stage3_bu_plan_record',    // per-BU IDB atom record
  REVISION_SNAPSHOT:   'stage3_revision_snapshot', // accepted Stage 3 revision snapshot
}

const REQUIRED_LIFECYCLE_STATUSES = new Set([
  'draft_generated',
  'partial_draft',
  'accepted',
])

// ── Per-BU record loader ───────────────────────────────────────────────────────

/**
 * Loads a single BU's Stage 3 durable record from IDB via readArtifactAsync.
 * Returns a structured result; never throws.
 */
async function loadBuDurableRecord(workspaceId, stage1Id, stage2Id, buName) {
  const key = stage3BuPlanDraftKey(workspaceId, stage1Id, stage2Id, buName)
  let record = null
  let loadError = null

  try {
    // readArtifactFromIdb bypasses the in-memory cache so a failed IDB write
    // in the same session cannot produce a false-positive durable read.
    record = await readArtifactFromIdb(key)
  } catch (e) {
    loadError = e?.message || String(e)
  }

  if (loadError) {
    return { buName, key, status: BU_HANDOFF_STATUS.BLOCKED, blockedReason: `IDB read failed: ${loadError}`, record: null }
  }
  if (!record) {
    return { buName, key, status: BU_HANDOFF_STATUS.BLOCKED, blockedReason: 'No durable Stage 3 record found in storage.', record: null }
  }
  if (record.version !== 1) {
    return { buName, key, status: BU_HANDOFF_STATUS.BLOCKED, blockedReason: `Unrecognised record version: ${record.version}`, record: null }
  }

  // Require a write timestamp — content without one was never confirmed durable
  const persistTimestamp = record.persistedAt || record.lastSavedAt || null
  if (!persistTimestamp) {
    return { buName, key, status: BU_HANDOFF_STATUS.BLOCKED, blockedReason: 'Record is missing persistedAt/lastSavedAt — durability unconfirmed.', record: null }
  }

  // Require a lifecycle status that indicates at least partial generation
  const lifecycleStatus = record.lifecycle?.status || record.status || null
  if (!REQUIRED_LIFECYCLE_STATUSES.has(lifecycleStatus)) {
    return { buName, key, status: BU_HANDOFF_STATUS.BLOCKED, blockedReason: `Lifecycle status "${lifecycleStatus}" is not ready for handoff.`, record: null }
  }

  // Require at least one completed atom
  const completedAtoms = (record.executionAtoms || []).filter(a => a?.status === 'complete')
  if (!completedAtoms.length) {
    return { buName, key, status: BU_HANDOFF_STATUS.BLOCKED, blockedReason: 'No completed execution atoms in durable record.', record: null }
  }

  // Partial: plan assembled but some atoms failed or lifecycle is partial_draft
  const hasFailedAtoms = (record.executionAtoms || []).some(a =>
    a?.status === 'failed' || a?.status === 'parser_error' || a?.status === 'max_tokens'
  )
  const isPartial = lifecycleStatus === 'partial_draft' || hasFailedAtoms

  return {
    buName,
    key,
    status: isPartial ? BU_HANDOFF_STATUS.PARTIAL : BU_HANDOFF_STATUS.READY,
    blockedReason: null,
    record,
    persistTimestamp,
    completedAtomCount: completedAtoms.length,
    totalAtomCount: (record.executionAtoms || []).length,
  }
}

// ── Snapshot fallback loader ───────────────────────────────────────────────────

/**
 * Attempts to find a BU's execution plan inside an accepted Stage 3 revision
 * snapshot (contentSnapshot.executionPlans[]).
 *
 * Returns a loaded-result shape with sourceType = REVISION_SNAPSHOT when found,
 * or null when the BU is absent from the snapshot.
 *
 * The snapshot is considered valid only when:
 *   • the revision ID matches stage3Id (caller guarantees this before calling)
 *   • executionPlans[] contains an entry for this buName
 */
function loadBuFromSnapshot(buName, contentSnapshot, stage3Id) {
  const plans = contentSnapshot?.executionPlans || []
  const plan  = plans.find(p =>
    (p.buName === buName || p.businessUnitName === buName)
  )
  if (!plan) return null

  const sections = plan.executionSections || []
  // PARTIAL when no sections, or all sections lack an objective
  const hasContent = sections.some(s => s.objective || (s.executionStrategy || []).length > 0)

  return {
    buName,
    key:  null,  // no per-BU IDB key for this source
    status: hasContent ? BU_HANDOFF_STATUS.READY : BU_HANDOFF_STATUS.PARTIAL,
    blockedReason:    null,
    record:           null,           // IDB record not available
    snapshotPlan:     plan,
    snapshotStage3Id: stage3Id,
    persistTimestamp: null,           // snapshot durability comes from the workspace plan blob
    completedAtomCount: 0,
    totalAtomCount:     0,
    sourceType: BU_SOURCE_TYPE.REVISION_SNAPSHOT,
  }
}

// ── Per-BU handoff entry builder ───────────────────────────────────────────────

function mapExecutionSections(sections) {
  return (sections || []).map(s => ({
    sectionName:        s.sectionName,
    objective:          s.objective || null,
    executionStrategy:  s.executionStrategy || [],
    decisionsRequired:  s.decisionsRequired || s.criticalDecisions || [],
    sequencingAndGates: s.sequencingAndGates || [],
    dependencies:       s.dependencies || [],
    risks:              s.risks || [],
    validationSignals:  s.validationReadinessChecks || s.validationSignals || [],
  }))
}

function buildBuHandoffEntry(loaded) {
  if (loaded.status === BU_HANDOFF_STATUS.BLOCKED) {
    return {
      buName:          loaded.buName,
      status:          BU_HANDOFF_STATUS.BLOCKED,
      blockedReason:   loaded.blockedReason,
      sourcePersistKey: loaded.key,
      sourcePersistAt: null,
      sourceType:      loaded.sourceType || BU_SOURCE_TYPE.IDB_RECORD,
      sourceTraceabilityLevel: null,
      sourceAtomIds:   [],
      sourceSectionIds: [],
      plan:            null,
      executionSections: [],
      stage4DeliveryImplications: [],
      diagnostics:     null,
      atomSummary:     null,
    }
  }

  // ── Snapshot-derived entry (full Stage 3 rebuild path) ──────────────────────
  if (loaded.sourceType === BU_SOURCE_TYPE.REVISION_SNAPSHOT) {
    const plan     = loaded.snapshotPlan
    const sections = mapExecutionSections(plan.executionSections)
    const sectionIds = sections.map(s => s.sectionName).filter(Boolean)

    const stage4DeliveryImplications = [
      ...(plan.stage4DeliveryImplications || []),
      ...sections.flatMap(s => s.stage4DeliveryImplications || []),
    ].filter(Boolean)

    return {
      buName:           loaded.buName,
      status:           loaded.status,
      blockedReason:    null,
      sourcePersistKey: null,
      sourcePersistAt:  null,         // durability comes from workspace plan blob
      sourceType:       BU_SOURCE_TYPE.REVISION_SNAPSHOT,
      sourceTraceabilityLevel: 'section',
      sourceAtomIds:    [],           // atoms not available from snapshot path
      sourceSectionIds: sectionIds,
      completedAtomCount: 0,
      totalAtomCount:   0,
      lifecycleStatus:  'accepted',   // snapshot is only used for accepted revisions
      plan: {
        buName:             plan.buName || loaded.buName,
        mission:            plan.mission            || null,
        strategicRole:      plan.strategicRole      || null,
        priorityOutcomes:   plan.priorityOutcomes   || [],
        criticalWorkstreams: plan.criticalWorkstreams || [],
      },
      executionSections: sections,
      stage4DeliveryImplications,
      diagnostics:  null,
      atomSummary:  null,
      source:       'ai',
      generatedAt:  null,
    }
  }

  // ── IDB per-BU atom record (per-BU generation path) ─────────────────────────
  const { record } = loaded
  const plan = record.plan || null

  const completedAtoms = (record.executionAtoms || []).filter(a => a?.status === 'complete')
  const sourceAtomIds  = completedAtoms.map(a => a.id).filter(Boolean)

  const stage4DeliveryImplications = [
    ...(plan?.stage4DeliveryImplications || []),
    ...(plan?.executionSections || []).flatMap(s => s.stage4DeliveryImplications || []),
  ].filter(Boolean)

  return {
    buName:           loaded.buName,
    status:           loaded.status,
    blockedReason:    null,
    sourcePersistKey: loaded.key,
    sourcePersistAt:  loaded.persistTimestamp,
    sourceType:       BU_SOURCE_TYPE.IDB_RECORD,
    sourceTraceabilityLevel: 'atom',
    sourceAtomIds,
    sourceSectionIds: [],
    completedAtomCount: loaded.completedAtomCount,
    totalAtomCount:     loaded.totalAtomCount,
    lifecycleStatus:  record.lifecycle?.status || record.status || null,
    plan: plan ? {
      buName:             plan.buName,
      mission:            plan.mission            || null,
      strategicRole:      plan.strategicRole      || null,
      priorityOutcomes:   plan.priorityOutcomes   || [],
      criticalWorkstreams: plan.criticalWorkstreams || [],
    } : null,
    executionSections: mapExecutionSections(plan?.executionSections),
    stage4DeliveryImplications,
    diagnostics: record.diagnostics
      ? { inputTokens: record.diagnostics.inputTokens || 0, outputTokens: record.diagnostics.outputTokens || 0 }
      : null,
    atomSummary: record.atomSummary || null,
    source:      record.source || 'ai',
    generatedAt: record.generatedAt || null,
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Compiles a Stage 4 handoff record from Stage 3 BU data.
 *
 * Primary source: per-BU IDB records (bsp_v1_stage3_bu_plan_*) read via
 * readArtifactFromIdb — bypasses the in-memory cache.
 *
 * Fallback source: when a per-BU IDB record is absent and stage3ActiveRevision
 * is provided and valid, the BU's execution plan is read from the accepted Stage 3
 * revision snapshot (contentSnapshot.executionPlans[]).  This covers the full
 * Stage 3 rebuild path which writes plans into the revision record, not into
 * per-BU IDB records.
 *
 * stage3ActiveRevision is considered valid when:
 *   • its id matches stage3Id
 *   • its sourceBasisRevisionId matches stage1Id
 *   • its sourceStage2RevisionId matches stage2Id
 *
 * Does NOT write to storage — call persistStage4Handoff() to durably save.
 *
 * @param {object}  opts
 * @param {string}  opts.workspaceId
 * @param {string}  opts.stage1Id
 * @param {string}  opts.stage2Id
 * @param {string}  opts.stage3Id               active Stage 3 revision ID
 * @param {Array}   opts.buNames                ordered BU name list from Stage 2
 * @param {object}  [opts.stage3ActiveRevision] optional; { id, contentSnapshot,
 *                                              sourceBasisRevisionId, sourceStage2RevisionId }
 * @returns {Promise<object>}                   compiled handoff (not yet persisted)
 */
export async function compileStage4Handoff({
  workspaceId, stage1Id, stage2Id, stage3Id, buNames,
  stage3ActiveRevision = null,
}) {
  const now = new Date().toISOString()

  // Validate the snapshot: only accept it when revision + basis IDs all match
  const snapshotValid = !!(
    stage3ActiveRevision &&
    stage3ActiveRevision.id === stage3Id &&
    stage3ActiveRevision.sourceBasisRevisionId  === stage1Id &&
    stage3ActiveRevision.sourceStage2RevisionId === stage2Id
  )
  const contentSnapshot = snapshotValid ? stage3ActiveRevision.contentSnapshot : null

  // Load all BU records in parallel — each read is independent
  const loadedResults = await Promise.all(
    buNames.map(async name => {
      // Try per-BU IDB record first
      const fromIdb = await loadBuDurableRecord(workspaceId, stage1Id, stage2Id, name)
      if (fromIdb.status !== BU_HANDOFF_STATUS.BLOCKED) return fromIdb

      // Fallback: accepted Stage 3 revision snapshot
      if (contentSnapshot) {
        const fromSnapshot = loadBuFromSnapshot(name, contentSnapshot, stage3Id)
        if (fromSnapshot) return fromSnapshot
      }

      return fromIdb  // remain BLOCKED — neither source found
    })
  )

  const buHandoffs = loadedResults.map(buildBuHandoffEntry)

  const readyCount   = buHandoffs.filter(b => b.status === BU_HANDOFF_STATUS.READY).length
  const partialCount = buHandoffs.filter(b => b.status === BU_HANDOFF_STATUS.PARTIAL).length
  const blockedCount = buHandoffs.filter(b => b.status === BU_HANDOFF_STATUS.BLOCKED).length

  const overallStatus =
    readyCount === buHandoffs.length ? HANDOFF_STATUS.READY :
    readyCount + partialCount > 0   ? HANDOFF_STATUS.PARTIAL :
    HANDOFF_STATUS.BLOCKED

  return {
    version: STAGE4_HANDOFF_VERSION,
    workspaceId,
    stage1RevisionId: stage1Id,
    stage2RevisionId: stage2Id,
    stage3RevisionId: stage3Id,
    compiledAt: now,
    persistedAt: null,           // set by persistStage4Handoff() after successful write
    overallStatus,
    readyCount,
    partialCount,
    blockedCount,
    totalCount: buHandoffs.length,
    buHandoffs,
  }
}

/**
 * Writes a compiled Stage 4 handoff record to the stage4_handoffs IDB store.
 * Sets persistedAt only on success.
 *
 * Returns { ok, key, record } — callers must check ok before treating the record
 * as durably stored.
 */
export async function persistStage4Handoff(handoff) {
  const key = stage4HandoffKey(
    handoff.workspaceId,
    handoff.stage1RevisionId,
    handoff.stage2RevisionId,
    handoff.stage3RevisionId,
  )
  const now = new Date().toISOString()
  const record = { ...handoff, persistedAt: now, lastSavedAt: now }
  const ok = await writeArtifact(key, record)
  return { ok, key, record: ok ? record : handoff }
}

/**
 * Reads a Stage 4 handoff record from IDB, confirming the content survived storage.
 * Returns null if the record is absent or unrecognised.
 */
export async function loadStage4Handoff(workspaceId, stage1Id, stage2Id, stage3Id) {
  const key = stage4HandoffKey(workspaceId, stage1Id, stage2Id, stage3Id)
  try {
    const record = await readArtifactAsync(key)
    if (!record || record.version !== STAGE4_HANDOFF_VERSION) return null
    if (!record.persistedAt && !record.lastSavedAt) return null
    return record
  } catch {
    return null
  }
}
