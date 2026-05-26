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

import { useState, useEffect }                          from 'react'
import { normalizeStrategyBasisPackage }                from '../utils/packageImport'
import { buildInitialRevision, buildManualRevision }    from '../utils/stageSnapshots'

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
      return migrated   // will be saved on next effect cycle
    }

    // New shape — verify minimal required fields
    if (stored.id && stored.normalizedWorkspace) return stored
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
  function saveStageRevision(stage, { prompt, impactSummary } = {}) {
    setFullWorkspace(prev => {
      if (!prev) return prev
      const existing = prev.stageRevisions[stage] || []
      const nextNum  = existing.length + 1
      const nw       = prev.normalizedWorkspace
      const newRev   = buildManualRevision(nw, nextNum, prompt, impactSummary)
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
    clearWorkspace,
  }
}
