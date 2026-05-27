// Workspace hook — persists the full workspace model to localStorage.
// Storage key is namespaced away from DomainIQ's diq_v4_* keys.
//
// Full workspace shape (v2):
// {
//   id:                  'ws_...',
//   name:                string,
//   createdAt:           ISO,
//   updatedAt:           ISO,
//   sourceType:          'import',
//   sourcePackage:       rawPackage,
//   normalizedWorkspace: normalizedWorkspace,
//   stageRevisions: {
//     stage1: RevisionRecord[],
//     stage2: [], stage3: [], stage4: [], stage5: [],
//   },
//   activeStageRevisionIds: {
//     stage1: string|null, stage2: null, stage3: null, stage4: null, stage5: null,
//   },
// }
//
// Migration: detects old { workspace, sourcePackage } shape and upgrades on load.

import { useState, useEffect }                                           from 'react'
import { normalizeStrategyBasisPackage }                                 from '../utils/packageImport'
import { buildInitialRevision, buildManualRevision }                     from '../utils/stageSnapshots'

const STORAGE_KEY = 'bsp_v1_workspace'

function workspaceId() {
  return 'ws_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7)
}

function emptyStageRevisions() {
  return { stage1: [], stage2: [], stage3: [], stage4: [], stage5: [] }
}

function emptyActiveIds() {
  return { stage1: null, stage2: null, stage3: null, stage4: null, stage5: null }
}

// ── Deduplication ─────────────────────────────────────────────────────────────

/**
 * Removes duplicate revisions that share the same revisionNumber within a stage.
 * Keeps the first occurrence (lowest index = earliest created).
 * Also repairs activeStageRevisionIds: if the active ID was pointing to a removed
 * duplicate, it is updated to the last revision remaining in that stage.
 *
 * Returns { stageRevisions, activeStageRevisionIds } — both corrected.
 */
function dedupeAndRepairIds(stageRevisions, activeStageRevisionIds) {
  const dedupedRevisions = {}
  const repairedIds      = { ...(activeStageRevisionIds || emptyActiveIds()) }

  for (const [stage, revs] of Object.entries(stageRevisions || {})) {
    const seen    = new Set()
    const deduped = (revs || []).filter(r => {
      if (seen.has(r.revisionNumber)) return false
      seen.add(r.revisionNumber)
      return true
    })
    dedupedRevisions[stage] = deduped

    // If the active ID no longer exists after dedup, point to the highest-numbered rev
    const activeId    = repairedIds[stage]
    const stillExists = activeId && deduped.some(r => r.id === activeId)
    if (!stillExists && deduped.length > 0) {
      const sorted = [...deduped].sort((a, b) => b.revisionNumber - a.revisionNumber)
      repairedIds[stage] = sorted[0].id
    }
  }

  return { stageRevisions: dedupedRevisions, activeStageRevisionIds: repairedIds }
}

// ── Migration ─────────────────────────────────────────────────────────────────

/**
 * Upgrades old { workspace, sourcePackage } → new full workspace shape.
 * Returns null if the stored value is unrecognisable.
 */
function migrateOldShape(stored) {
  if (!stored?.workspace || stored.normalizedWorkspace) return null   // already new or empty
  const nw     = stored.workspace
  const initRev = buildInitialRevision(nw)
  const now    = new Date().toISOString()
  const name   = nw.entity?.company || nw.entity?.name || 'Workspace'
  return {
    id:                  workspaceId(),
    name,
    createdAt:           now,
    updatedAt:           now,
    sourceType:          'import',
    sourcePackage:       stored.sourcePackage || null,
    normalizedWorkspace: nw,
    stageRevisions: {
      ...emptyStageRevisions(),
      stage1: [initRev],
    },
    activeStageRevisionIds: {
      ...emptyActiveIds(),
      stage1: initRev.id,
    },
  }
}

// ── Storage ───────────────────────────────────────────────────────────────────

function loadFromStorage() {
  try {
    const raw    = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const stored = JSON.parse(raw)
    if (!stored) return null

    // Detect and migrate old shape
    if (stored.workspace && !stored.normalizedWorkspace) {
      const migrated = migrateOldShape(stored)
      if (migrated) {
        const fixed = dedupeAndRepairIds(migrated.stageRevisions, migrated.activeStageRevisionIds)
        migrated.stageRevisions         = fixed.stageRevisions
        migrated.activeStageRevisionIds = fixed.activeStageRevisionIds
      }
      return migrated   // will be saved on next effect cycle
    }

    // New shape — verify minimal required fields; dedupe + repair active IDs on load
    if (stored.id && stored.normalizedWorkspace) {
      const fixed = dedupeAndRepairIds(
        stored.stageRevisions         || emptyStageRevisions(),
        stored.activeStageRevisionIds || emptyActiveIds(),
      )
      stored.stageRevisions         = fixed.stageRevisions
      stored.activeStageRevisionIds = fixed.activeStageRevisionIds
      return stored
    }
  } catch {}
  return null
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useWorkspace() {
  const [fullWorkspace, setFullWorkspace] = useState(loadFromStorage)

  // Persist every time fullWorkspace changes
  useEffect(() => {
    try {
      if (fullWorkspace) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(fullWorkspace))
      } else {
        localStorage.removeItem(STORAGE_KEY)
      }
    } catch {}
  }, [fullWorkspace])

  // ── importPackage ────────────────────────────────────────────────────────────
  function importPackage(raw) {
    const result = normalizeStrategyBasisPackage(raw)
    if (result.error) return { error: result.error }

    const nw      = result.workspace
    const initRev = buildInitialRevision(nw)
    const now     = new Date().toISOString()
    const name    = nw.entity?.company || nw.entity?.name || 'Workspace'

    setFullWorkspace({
      id:                  workspaceId(),
      name,
      createdAt:           now,
      updatedAt:           now,
      sourceType:          'import',
      sourcePackage:       result.sourcePackage,
      normalizedWorkspace: nw,
      stageRevisions: {
        ...emptyStageRevisions(),
        stage1: [initRev],
      },
      activeStageRevisionIds: {
        ...emptyActiveIds(),
        stage1: initRev.id,
      },
    })

    return { error: null }
  }

  // ── saveStageRevision ────────────────────────────────────────────────────────
  // stage: 'stage1' | 'stage2' | ...
  // opts:  { prompt: string, impactSummary: string }
  function saveStageRevision(stage, { prompt, impactSummary, learningSignals } = {}) {
    setFullWorkspace(prev => {
      if (!prev) return prev
      const existing = prev.stageRevisions[stage] || []
      const nextNum  = existing.length + 1
      const nw       = prev.normalizedWorkspace
      const newRev   = buildManualRevision(nw, nextNum, prompt, impactSummary, learningSignals)
      const updated  = {
        ...prev,
        updatedAt: new Date().toISOString(),
        stageRevisions: {
          ...prev.stageRevisions,
          [stage]: [...existing, newRev],
        },
        activeStageRevisionIds: {
          ...prev.activeStageRevisionIds,
          [stage]: newRev.id,
        },
      }
      return updated
    })
  }

  // ── saveRawRevision ──────────────────────────────────────────────────────────
  // Accepts a pre-built revision object (Stage 2+ revisions build their own records).
  // stage: 'stage2' | 'stage3' | ...
  // revisionRecord: fully-formed record (see buildStage2RevisionRecord)
  function saveRawRevision(stage, revisionRecord) {
    setFullWorkspace(prev => {
      if (!prev) return prev
      const existing = prev.stageRevisions[stage] || []
      return {
        ...prev,
        updatedAt: new Date().toISOString(),
        stageRevisions: {
          ...prev.stageRevisions,
          [stage]: [...existing, revisionRecord],
        },
        activeStageRevisionIds: {
          ...prev.activeStageRevisionIds,
          [stage]: revisionRecord.id,
        },
      }
    })
  }

  // ── saveStage1AIRevision ─────────────────────────────────────────────────────
  // Atomically updates the normalized workspace (so Stage1View re-renders with
  // AI-refined content) and appends the pre-built revision record to stage1.
  //
  //   revisionRecord  — built by buildStage1AIRevision()
  //   patchedWorkspace — from applyStage1PatchToWorkspace(); becomes the new source of truth
  //
  // After this call, stage1ActiveId changes → Stage 2 becomes stale automatically.
  function saveStage1AIRevision(revisionRecord, patchedWorkspace) {
    setFullWorkspace(prev => {
      if (!prev) return prev
      const existing = prev.stageRevisions.stage1 || []
      return {
        ...prev,
        updatedAt:           new Date().toISOString(),
        normalizedWorkspace: patchedWorkspace,
        stageRevisions: {
          ...prev.stageRevisions,
          stage1: [...existing, revisionRecord],
        },
        activeStageRevisionIds: {
          ...prev.activeStageRevisionIds,
          stage1: revisionRecord.id,
        },
      }
    })
  }

  // ── clearWorkspace ───────────────────────────────────────────────────────────
  function clearWorkspace() {
    setFullWorkspace(null)
    try { localStorage.removeItem(STORAGE_KEY) } catch {}
  }

  // ── Derived convenience values ───────────────────────────────────────────────
  const workspace   = fullWorkspace?.normalizedWorkspace ?? null
  const importedAt  = fullWorkspace?.createdAt ?? null

  return {
    fullWorkspace,
    workspace,
    importedAt,
    importPackage,
    saveStageRevision,
    saveRawRevision,
    saveStage1AIRevision,
    clearWorkspace,
  }
}
