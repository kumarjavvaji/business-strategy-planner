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
import { stage3BuPlanKey, stage3BuPlanLegacyKey } from './stage3BuPlanKeys'

// ── Key helpers ────────────────────────────────────────────────────────────────

// Re-export the canonical key under the legacy name so any external callers
// that imported stage3BuPlanDraftKey from this module keep working.
export function stage3BuPlanDraftKey(workspaceId, stage1Id, stage2Id, buName) {
  return stage3BuPlanKey(workspaceId, stage1Id, stage2Id, buName)
}

export function stage4HandoffKey(workspaceId, stage1Id, stage2Id, stage3Id) {
  return `bsp_v1_stage4_handoff_${workspaceId}_${stage1Id}_${stage2Id}_${stage3Id}`
}

// ── Constants ──────────────────────────────────────────────────────────────────

export const STAGE4_HANDOFF_VERSION = 1

/**
 * Returns true when a persisted Stage 4 handoff was compiled from a different Stage 1/2/3
 * basis than what is currently active — meaning Stage 4 artifacts may be derived from
 * outdated upstream content.
 *
 * Stage 4 artifacts should be regenerated or reviewed when this returns true.
 */
export function isHandoffUpstreamStale(handoff, currentStage1Id, currentStage2Id, currentStage3Id) {
  if (!handoff) return false
  if (currentStage1Id && handoff.stage1RevisionId !== currentStage1Id) return true
  if (currentStage2Id && handoff.stage2RevisionId !== currentStage2Id) return true
  if (currentStage3Id && handoff.stage3RevisionId !== currentStage3Id) return true
  return false
}

/**
 * Build a human-readable staleness warning for a handoff that was compiled from an earlier basis.
 * Returns null when the handoff is current.
 */
export function buildUpstreamStalenessWarning(handoff, currentStage1Id, currentStage2Id, currentStage3Id) {
  if (!isHandoffUpstreamStale(handoff, currentStage1Id, currentStage2Id, currentStage3Id)) return null
  const changed = []
  if (currentStage1Id && handoff.stage1RevisionId !== currentStage1Id) changed.push('Stage 1')
  if (currentStage2Id && handoff.stage2RevisionId !== currentStage2Id) changed.push('Stage 2')
  if (currentStage3Id && handoff.stage3RevisionId !== currentStage3Id) changed.push('Stage 3')
  return `Generated from earlier upstream basis. ${changed.join(' and ')} ${changed.length === 1 ? 'has' : 'have'} changed since this handoff was compiled. Recompile the Stage 4 handoff before generating new artifacts.`
}

/**
 * D26/D27: Impact-aware staleness classification for a Stage 4 handoff.
 *
 * When a staleImpactMap (from buildStaleImpactMap) is provided, uses BU-level
 * severity instead of raw version mismatch.  Falls back to version-mismatch-only
 * detection for backward compatibility when no map is supplied.
 *
 * Returns one of:
 *   'materially_stale'   — at least one BU is materially stale; block or warn hard
 *   'review_recommended' — upstream changed but no material assumption detected; allow with amber warning
 *   'unaffected'         — upstream changed but all BUs classified as unaffected
 *   'unknown_impact'     — insufficient info to classify; warn and require review
 *   null                 — handoff is current (no version mismatch at all)
 */
export function classifyHandoffStaleness(handoff, currentStage1Id, currentStage2Id, currentStage3Id, staleImpactMap = null) {
  if (!isHandoffUpstreamStale(handoff, currentStage1Id, currentStage2Id, currentStage3Id)) return null

  // When we have an impact map, use its overall severity
  if (staleImpactMap?.summary) {
    const { materiallyStaleBUs, unknownBUs, reviewRecommendedBUs } = staleImpactMap.summary
    if (materiallyStaleBUs.length > 0) return 'materially_stale'
    if (unknownBUs.length > 0)          return 'unknown_impact'
    if (reviewRecommendedBUs.length > 0) return 'review_recommended'
    return 'unaffected'
  }

  // Fallback: version mismatch without impact info → review_recommended (not hard block)
  return 'review_recommended'
}

/**
 * D26/D27: Get the impact-aware staleness for a specific BU within a handoff.
 * Returns the BU's severity string from the impact map, or falls back to
 * 'review_recommended' when the handoff is stale but no map is available.
 * Returns null when the handoff is current.
 */
export function classifyHandoffBuStaleness(buName, handoff, currentStage1Id, currentStage2Id, currentStage3Id, staleImpactMap = null) {
  if (!isHandoffUpstreamStale(handoff, currentStage1Id, currentStage2Id, currentStage3Id)) return null

  if (staleImpactMap?.buImpacts) {
    const buImpact = staleImpactMap.buImpacts.find(b => b.buName === buName)
    if (buImpact) return buImpact.severity
  }

  return 'review_recommended'
}

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
  const canonicalKey = stage3BuPlanKey(workspaceId, stage1Id, stage2Id, buName)
  let record    = null
  let usedKey   = canonicalKey
  let loadError = null

  try {
    // readArtifactFromIdb bypasses the in-memory cache so a failed IDB write
    // in the same session cannot produce a false-positive durable read.
    record = await readArtifactFromIdb(canonicalKey)
  } catch (e) {
    loadError = e?.message || String(e)
  }

  // Backward-compatible fallback: try the legacy uppercase-preserving key that
  // Stage 3 used before the shared key helper was introduced.  Only attempted
  // when the canonical read returned nothing and did not throw.
  if (!record && !loadError) {
    const legacyKey = stage3BuPlanLegacyKey(workspaceId, stage1Id, stage2Id, buName)
    if (legacyKey) {
      try {
        const legacyRecord = await readArtifactFromIdb(legacyKey)
        if (legacyRecord) {
          record  = legacyRecord
          usedKey = legacyKey
        }
      } catch {
        // ignore — canonical read already failed to find a record; legacy is best-effort
      }
    }
  }

  if (loadError) {
    return { buName, key: canonicalKey, status: BU_HANDOFF_STATUS.BLOCKED, blockedReason: `IDB read failed: ${loadError}`, record: null }
  }
  if (!record) {
    return { buName, key: canonicalKey, status: BU_HANDOFF_STATUS.BLOCKED, blockedReason: 'No durable Stage 3 record found in storage.', record: null }
  }
  if (record.version !== 1) {
    return { buName, key: usedKey, status: BU_HANDOFF_STATUS.BLOCKED, blockedReason: `Unrecognised record version: ${record.version}`, record: null }
  }

  // Require a write timestamp — content without one was never confirmed durable
  const persistTimestamp = record.persistedAt || record.lastSavedAt || null
  if (!persistTimestamp) {
    return { buName, key: usedKey, status: BU_HANDOFF_STATUS.BLOCKED, blockedReason: 'Record is missing persistedAt/lastSavedAt — durability unconfirmed.', record: null }
  }

  // Require a lifecycle status that indicates at least partial generation
  const lifecycleStatus = record.lifecycle?.status || record.status || null
  if (!REQUIRED_LIFECYCLE_STATUSES.has(lifecycleStatus)) {
    return { buName, key: usedKey, status: BU_HANDOFF_STATUS.BLOCKED, blockedReason: `Lifecycle status "${lifecycleStatus}" is not ready for handoff.`, record: null }
  }

  // Require at least one completed atom
  const completedAtoms = (record.executionAtoms || []).filter(a => a?.status === 'complete')
  if (!completedAtoms.length) {
    return { buName, key: usedKey, status: BU_HANDOFF_STATUS.BLOCKED, blockedReason: 'No completed execution atoms in durable record.', record: null }
  }

  // Partial: plan assembled but some atoms failed or lifecycle is partial_draft
  const hasFailedAtoms = (record.executionAtoms || []).some(a =>
    a?.status === 'failed' || a?.status === 'parser_error' || a?.status === 'max_tokens'
  )
  const isPartial = lifecycleStatus === 'partial_draft' || hasFailedAtoms

  return {
    buName,
    key: usedKey,
    legacyKeyFallback: usedKey !== canonicalKey,
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

// ── Compile-time helpers ────────────────────────────────────────────────────────

function firstNSentences(text, n) {
  if (!text || typeof text !== 'string') return null
  const parts = text.match(/[^.!?]+[.!?]+/g) || [text]
  return parts.slice(0, n).join(' ').trim() || text.slice(0, 400) || null
}

function normalizeForDedup(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}

function dedupStrings(arr) {
  if (!arr?.length) return []
  const seen = []
  const out  = []
  for (const item of arr) {
    if (!item || typeof item !== 'string') continue
    const norm = normalizeForDedup(item)
    if (!norm) continue
    const isDup = seen.some(s => {
      if (s === norm) return true
      const [sh, lo] = norm.length <= s.length ? [norm, s] : [s, norm]
      if (sh.length >= 15 && lo.includes(sh)) return true
      if (norm.length > 40 && s.length > 40 && norm.slice(0, 40) === s.slice(0, 40)) return true
      return false
    })
    if (!isDup) { seen.push(norm); out.push(item) }
  }
  return out
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

// Source examples for collapsed display in the renderer.
function compileSourceExamples(completedAtoms, max) {
  return (completedAtoms || [])
    .filter(a => a?.parsedValue && typeof a.parsedValue === 'string' && a.parsedValue.trim().length > 10)
    .slice(0, max || 3)
    .map(a => ({ atomId: String(a.id || ''), text: String(a.parsedValue).slice(0, 200) }))
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
      stage3PanelModel: null,
      executionSections: [],
      stage4DeliveryImplications: [],
      diagnostics:     null,
      atomSummary:     null,
    }
  }

  // ── Snapshot-derived entry (full Stage 3 rebuild path) ──────────────────────
  if (loaded.sourceType === BU_SOURCE_TYPE.REVISION_SNAPSHOT) {
    const plan       = loaded.snapshotPlan
    const rawSections = mapExecutionSections(plan.executionSections)
    const sectionIds  = rawSections.map(s => s.sectionName).filter(Boolean)

    const stage4DeliveryImplications = dedupStrings([
      ...(plan.stage4DeliveryImplications || []),
      ...rawSections.flatMap(s => s.stage4DeliveryImplications || []),
    ])

    return {
      buName:           loaded.buName,
      status:           loaded.status,
      blockedReason:    null,
      sourcePersistKey: null,
      sourcePersistAt:  null,
      sourceType:       BU_SOURCE_TYPE.REVISION_SNAPSHOT,
      sourceTraceabilityLevel: 'section',
      sourceAtomIds:    [],
      sourceSectionIds: sectionIds,
      completedAtomCount: 0,
      totalAtomCount:   0,
      lifecycleStatus:  'accepted',
      plan: {
        buName:             plan.buName || loaded.buName,
        mission:            firstNSentences(plan.mission, 3),
        strategicRole:      firstNSentences(plan.strategicRole, 3),
        priorityOutcomes:   dedupStrings(plan.priorityOutcomes || []),
        criticalWorkstreams: plan.criticalWorkstreams || [],
      },
      stage3PanelModel: plan.panelModel || null,
      synthesisSchema:    'source_basis_v1',
      executionSections:          rawSections,
      stage4DeliveryImplications,
      sourceAtomExamples: [],
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

  const rawSections = mapExecutionSections(plan?.executionSections)

  const stage4DeliveryImplications = dedupStrings([
    ...(plan?.stage4DeliveryImplications || []),
    ...(plan?.executionSections || []).flatMap(s => s.stage4DeliveryImplications || []),
  ])

  return {
    buName:           loaded.buName,
    status:           loaded.status,
    blockedReason:    null,
    sourcePersistKey: loaded.key,
    sourcePersistAt:  loaded.persistTimestamp,
    legacyKeyFallback: loaded.legacyKeyFallback || false,
    sourceType:       BU_SOURCE_TYPE.IDB_RECORD,
    sourceTraceabilityLevel: 'atom',
    sourceAtomIds,
    sourceSectionIds: [],
    completedAtomCount: loaded.completedAtomCount,
    totalAtomCount:     loaded.totalAtomCount,
    lifecycleStatus:  record.lifecycle?.status || record.status || null,
    synthesisSchema:  'source_basis_v1',
    plan: plan ? {
      buName:              plan.buName,
      mission:             firstNSentences(plan.mission, 3),
      strategicRole:       firstNSentences(plan.strategicRole, 3),
      priorityOutcomes:    dedupStrings(plan.priorityOutcomes || []),
      criticalWorkstreams: plan.criticalWorkstreams || [],
    } : null,
    stage3PanelModel: record.panelModel || plan?.panelModel || null,
    executionSections:          rawSections,
    stage4DeliveryImplications,
    sourceAtomExamples:         compileSourceExamples(completedAtoms, 3),
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
    // Populated by consumers when they detect the handoff was compiled from an older basis
    upstreamStalenessWarning: null,
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
