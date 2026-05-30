/**
 * Stage 4 artifact output — generated content persistence.
 *
 * One output record per artifact item, keyed by artifactId.
 * Re-generating overwrites the existing record after a successful persist+verify cycle.
 * A failed generation must not erase a previously stored output.
 *
 * Storage key: bsp_v1_stage4_artifact_output_{workspaceId}_{s1}_{s2}_{s3}_{artifactId_safe}
 * Store:       IndexedDB → stage4_artifact_outputs  (IDB-primary, LS pointer)
 *
 * Source invariant: loadArtifactOutput uses readArtifactFromIdb — the cache-bypass
 * path — so no optimistic in-memory state can be mistaken for a durable output.
 *
 * Staleness: output is stale when
 *   output.generatedFromArtifactPlanPersistedAt !== plan.persistedAt, OR
 *   output.generatedFromHandoffPersistedAt      !== handoff.persistedAt
 */

import { readArtifactFromIdb, writeArtifact } from './storageRouter'

// ── Constants ──────────────────────────────────────────────────────────────────

export const ARTIFACT_OUTPUT_VERSION = 1

export const OUTPUT_STATUS = {
  GENERATED: 'generated',
  FAILED:    'failed',
  STALE:     'stale',
}

// ── Key helper ─────────────────────────────────────────────────────────────────

function safeId(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 80)
}

export function stage4ArtifactOutputKey(workspaceId, stage1Id, stage2Id, stage3Id, artifactId) {
  return `bsp_v1_stage4_artifact_output_${workspaceId}_${stage1Id}_${stage2Id}_${stage3Id}_${safeId(artifactId)}`
}

// ── Record construction ────────────────────────────────────────────────────────

/**
 * Builds an artifact output record in memory.
 * persistedAt and verifiedAt are null until the persist+verify cycle completes.
 */
export function buildArtifactOutput({
  workspaceId, stage1Id, stage2Id, stage3Id,
  handoff, plan, artifactItem,
  contentSections, evidenceBasis, assumptions, openQuestions,
}) {
  const now = new Date().toISOString()
  return {
    version:                             ARTIFACT_OUTPUT_VERSION,
    workspaceId,
    stage1RevisionId:                    stage1Id,
    stage2RevisionId:                    stage2Id,
    stage3RevisionId:                    stage3Id,
    handoffKey:                          plan.handoffKey,
    artifactPlanKey:                     `bsp_v1_stage4_artifact_plan_${workspaceId}_${stage1Id}_${stage2Id}_${stage3Id}`,
    artifactId:                          artifactItem.artifactId,
    artifactType:                        artifactItem.artifactType,
    scope:                               artifactItem.scope,
    businessUnitName:                    artifactItem.businessUnitName,
    title:                               artifactItem.title,
    sourceAtomIds:                       artifactItem.sourceAtomIds || [],
    sourceHandoffStatus:                 artifactItem.sourceHandoffStatus,
    generatedFromArtifactPlanPersistedAt: plan.persistedAt,
    generatedFromHandoffPersistedAt:     handoff.persistedAt,
    generationStatus:                    OUTPUT_STATUS.GENERATED,
    contentSections,
    evidenceBasis:                       evidenceBasis || '',
    assumptions:                         assumptions   || [],
    openQuestions:                       openQuestions || [],
    reviewNotes:                         '',
    createdAt:                           now,
    updatedAt:                           now,
    persistedAt:                         null,  // set by persistArtifactOutput
    verifiedAt:                          null,  // set by caller after loadArtifactOutput succeeds
    error:                               null,
  }
}

// ── Persistence ────────────────────────────────────────────────────────────────

/**
 * Writes the output to IDB. Sets persistedAt on success.
 * Returns { ok, key, record }.
 *
 * A failed generation must not call this function — callers must guard
 * against writing partial or errored output to the durable store.
 */
export async function persistArtifactOutput(output, workspaceId, stage1Id, stage2Id, stage3Id) {
  const key = stage4ArtifactOutputKey(workspaceId, stage1Id, stage2Id, stage3Id, output.artifactId)
  const now    = new Date().toISOString()
  const record = { ...output, persistedAt: now, updatedAt: now }
  const ok     = await writeArtifact(key, record)
  return { ok, key, record: ok ? record : output }
}

// ── Load (cache-bypass) ────────────────────────────────────────────────────────

/**
 * Reads a single output directly from IDB, bypassing the in-memory cache.
 * Returns null when absent, version-mismatched, or unpersisted.
 */
export async function loadArtifactOutput(workspaceId, stage1Id, stage2Id, stage3Id, artifactId) {
  const key = stage4ArtifactOutputKey(workspaceId, stage1Id, stage2Id, stage3Id, artifactId)
  try {
    const record = await readArtifactFromIdb(key)
    if (!record || record.version !== ARTIFACT_OUTPUT_VERSION) return null
    if (!record.persistedAt) return null
    return record
  } catch {
    return null
  }
}

/**
 * Loads all outputs for a given set of artifact IDs in parallel.
 * Absent or invalid records are silently omitted from the result map.
 */
export async function loadAllArtifactOutputs(workspaceId, stage1Id, stage2Id, stage3Id, artifactIds) {
  const results = {}
  await Promise.all(
    artifactIds.map(async id => {
      const out = await loadArtifactOutput(workspaceId, stage1Id, stage2Id, stage3Id, id)
      if (out) results[id] = out
    })
  )
  return results
}

// ── Staleness detection ────────────────────────────────────────────────────────

/**
 * Returns true when the artifact plan or handoff has been re-persisted
 * after this output was generated.
 */
export function isArtifactOutputStale(output, plan, handoff) {
  if (!output || !plan || !handoff) return false
  return (
    output.generatedFromArtifactPlanPersistedAt !== plan.persistedAt ||
    output.generatedFromHandoffPersistedAt      !== handoff.persistedAt
  )
}
