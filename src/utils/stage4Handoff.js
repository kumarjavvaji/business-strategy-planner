/**
 * Stage 3 → Stage 4 handoff compiler.
 *
 * SOURCE INVARIANT: this module reads Stage 3 BU plan records exclusively via
 * readArtifactAsync(), which awaits storageReady() and resolves from the IDB
 * cache.  It never consults React state, generation progress state, readCached(),
 * or any optimistic in-memory object.  If a BU's durable record is missing or
 * lacks a persistedAt/lastSavedAt timestamp the BU is marked blocked and its
 * content is excluded from the handoff.
 *
 * OUTPUT INVARIANT: the compiled handoff record is written via writeArtifact()
 * to the stage4_handoffs IDB store.  Callers must treat the handoff as unusable
 * until writeArtifact returns true and the record can be read back from storage.
 *
 * Key shapes:
 *   Stage 3 source : bsp_v1_stage3_bu_plan_{wid}_{s1id}_{s2id}_{buNameSafe}
 *   Stage 4 handoff: bsp_v1_stage4_handoff_{wid}_{s1id}_{s2id}_{s3id}
 */

import { readArtifactAsync, writeArtifact } from './storageRouter'

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

// ── Lifecycle constants ────────────────────────────────────────────────────────

export const STAGE4_HANDOFF_VERSION = 1

export const BU_HANDOFF_STATUS = {
  READY:   'ready',    // durable record present, all required fields found
  PARTIAL: 'partial',  // record present but atoms incomplete / partial draft
  BLOCKED: 'blocked',  // no durable record, missing timestamps, or persistError
}

export const HANDOFF_STATUS = {
  READY:   'ready',    // all required BUs are ready
  PARTIAL: 'partial',  // at least one ready, some partial/blocked
  BLOCKED: 'blocked',  // no BUs are ready
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
    record = await readArtifactAsync(key)
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

// ── Per-BU handoff entry builder ───────────────────────────────────────────────

function buildBuHandoffEntry(loaded) {
  if (loaded.status === BU_HANDOFF_STATUS.BLOCKED) {
    return {
      buName: loaded.buName,
      status: BU_HANDOFF_STATUS.BLOCKED,
      blockedReason: loaded.blockedReason,
      sourcePersistKey: loaded.key,
      sourcePersistAt: null,
      sourceAtomIds: [],
      plan: null,
      executionSections: [],
      stage4DeliveryImplications: [],
      diagnostics: null,
      atomSummary: null,
    }
  }

  const { record } = loaded
  const plan = record.plan || null

  // Extract atom IDs only from completed atoms — no partial/failed content forwarded
  const completedAtoms = (record.executionAtoms || []).filter(a => a?.status === 'complete')
  const sourceAtomIds = completedAtoms.map(a => a.id).filter(Boolean)

  // Collect stage4DeliveryImplications from plan fields
  const stage4DeliveryImplications = [
    ...(plan?.stage4DeliveryImplications || []),
    ...(plan?.executionSections || []).flatMap(s => s.stage4DeliveryImplications || []),
  ].filter(Boolean)

  return {
    buName: loaded.buName,
    status: loaded.status,
    blockedReason: null,
    sourcePersistKey: loaded.key,
    sourcePersistAt: loaded.persistTimestamp,
    sourceAtomIds,
    completedAtomCount: loaded.completedAtomCount,
    totalAtomCount: loaded.totalAtomCount,
    lifecycleStatus: record.lifecycle?.status || record.status || null,
    plan: plan
      ? {
          buName: plan.buName,
          mission: plan.mission || null,
          strategicRole: plan.strategicRole || null,
          priorityOutcomes: plan.priorityOutcomes || [],
          criticalWorkstreams: plan.criticalWorkstreams || [],
        }
      : null,
    executionSections: (plan?.executionSections || []).map(s => ({
      sectionName: s.sectionName,
      objective: s.objective || null,
      executionStrategy: s.executionStrategy || [],
      decisionsRequired: s.decisionsRequired || [],
      sequencingAndGates: s.sequencingAndGates || [],
      dependencies: s.dependencies || [],
      risks: s.risks || [],
      validationSignals: s.validationReadinessChecks || s.validationSignals || [],
    })),
    stage4DeliveryImplications,
    diagnostics: record.diagnostics
      ? { inputTokens: record.diagnostics.inputTokens || 0, outputTokens: record.diagnostics.outputTokens || 0 }
      : null,
    atomSummary: record.atomSummary || null,
    source: record.source || 'ai',
    generatedAt: record.generatedAt || null,
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Compiles a Stage 4 handoff record from durable Stage 3 BU plan IDB records.
 *
 * Does NOT write to storage — call persistStage4Handoff() to durably save and
 * confirm the record before treating it as usable.
 *
 * @param {object} opts
 * @param {string} opts.workspaceId
 * @param {string} opts.stage1Id
 * @param {string} opts.stage2Id
 * @param {string} opts.stage3Id      active Stage 3 revision ID
 * @param {Array}  opts.buNames       ordered list of BU names from Stage 2
 * @returns {Promise<object>}         compiled handoff record (not yet persisted)
 */
export async function compileStage4Handoff({ workspaceId, stage1Id, stage2Id, stage3Id, buNames }) {
  const now = new Date().toISOString()

  // Load all BU records in parallel — each read is independent
  const loadedResults = await Promise.all(
    buNames.map(name => loadBuDurableRecord(workspaceId, stage1Id, stage2Id, name))
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
