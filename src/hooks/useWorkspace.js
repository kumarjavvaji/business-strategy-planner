// Workspace hook: persists multiple planner sessions to browser localStorage.
// Legacy single-workspace key is preserved and copied into the plan registry on
// first load when no multi-plan structure exists yet.
//
// Multi-plan keys:
// - bsp_plan_index_v1
// - bsp_plan_v1_{planId}
//
// Legacy key left untouched:
// - bsp_v1_workspace

import { useEffect, useState } from 'react'
import { normalizeStrategyBasisPackage } from '../utils/packageImport'
import { buildInitialRevision, buildManualRevision } from '../utils/stageSnapshots'
import { writeArtifact as writeArtifactToIdb } from '../utils/storageRouter'

const LEGACY_STORAGE_KEY = 'bsp_v1_workspace'
const LEGACY_PLAN_ID = 'legacy_bsp_v1_workspace'
const PLAN_INDEX_KEY = 'bsp_plan_index_v1'
const PLAN_KEY_PREFIX = 'bsp_plan_v1_'

function workspaceId() {
  return 'ws_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7)
}

function planId() {
  return 'plan_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7)
}

function planStorageKey(id) {
  return `${PLAN_KEY_PREFIX}${id}`
}

function emptyStageRevisions() {
  return { stage1: [], stage2: [], stage3: [], stage4: [], stage5: [] }
}

function emptyActiveIds() {
  return { stage1: null, stage2: null, stage3: null, stage4: null, stage5: null }
}

function emptyWorkspacePlan(id = planId(), name = 'Untitled plan') {
  const now = new Date().toISOString()
  return {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    sourceType: 'empty',
    sourcePackage: null,
    normalizedWorkspace: null,
    stageRevisions: emptyStageRevisions(),
    activeStageRevisionIds: emptyActiveIds(),
  }
}

function cloneDeep(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function safeFilePart(value) {
  return String(value || 'plan')
    .trim()
    .replace(/[^a-z0-9-_]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'plan'
}

function dedupeAndRepairIds(stageRevisions, activeStageRevisionIds) {
  const dedupedRevisions = {}
  const repairedIds = { ...emptyActiveIds(), ...(activeStageRevisionIds || {}) }

  for (const stage of Object.keys(emptyStageRevisions())) {
    const seen = new Set()
    const deduped = (stageRevisions?.[stage] || []).filter(r => {
      if (seen.has(r.revisionNumber)) return false
      seen.add(r.revisionNumber)
      return true
    })
    dedupedRevisions[stage] = deduped

    const activeId = repairedIds[stage]
    const stillExists = activeId && deduped.some(r => r.id === activeId)
    if (!stillExists && deduped.length > 0) {
      const sorted = [...deduped].sort((a, b) => b.revisionNumber - a.revisionNumber)
      repairedIds[stage] = sorted[0].id
    }
  }

  return { stageRevisions: dedupedRevisions, activeStageRevisionIds: repairedIds }
}

function migrateOldShape(stored) {
  if (!stored?.workspace || stored.normalizedWorkspace) return null
  const nw = stored.workspace
  const initRev = buildInitialRevision(nw)
  const now = new Date().toISOString()
  const name = nw.entity?.company || nw.entity?.name || 'Imported plan'
  return {
    id: workspaceId(),
    name,
    createdAt: now,
    updatedAt: now,
    sourceType: 'import',
    sourcePackage: stored.sourcePackage || null,
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

function normalizeStoredPlan(stored, fallbackId) {
  if (!stored) return null
  let plan = stored

  if (stored.workspace && !stored.normalizedWorkspace) {
    plan = migrateOldShape(stored)
  }

  if (!plan?.id) {
    plan = { ...plan, id: fallbackId || workspaceId() }
  }

  const fixed = dedupeAndRepairIds(
    plan.stageRevisions || emptyStageRevisions(),
    plan.activeStageRevisionIds || emptyActiveIds(),
  )

  return {
    ...emptyWorkspacePlan(plan.id, plan.name || 'Untitled plan'),
    ...plan,
    stageRevisions: fixed.stageRevisions,
    activeStageRevisionIds: fixed.activeStageRevisionIds,
  }
}

function stageProgressSummary(plan) {
  if (!plan?.normalizedWorkspace) return 'Empty'
  const revisions = plan.stageRevisions || {}
  const completed = Object.entries(revisions)
    .filter(([, revs]) => Array.isArray(revs) && revs.length > 0)
    .map(([stage]) => stage.replace('stage', 'Stage '))
  return completed.length ? completed.join(', ') : 'Imported'
}

function sourceLabel(plan) {
  if (!plan?.normalizedWorkspace) return 'Empty plan'
  const app = plan.sourcePackage?.sourceApp || 'DomainIQ'
  const version = plan.sourcePackage?.packageVersion
  return version ? `${app} v${version}` : app
}

function planDisplayName(plan) {
  return plan?.name ||
    plan?.normalizedWorkspace?.entity?.company ||
    plan?.normalizedWorkspace?.entity?.name ||
    'Untitled plan'
}

function metaForPlan(plan, existing = {}) {
  return {
    id: plan.id,
    name: planDisplayName(plan),
    createdAt: plan.createdAt || existing.createdAt || new Date().toISOString(),
    updatedAt: plan.updatedAt || new Date().toISOString(),
    sourceLabel: sourceLabel(plan),
    stageProgressSummary: stageProgressSummary(plan),
    storageKey: plan.storageKey || existing.storageKey || planStorageKey(plan.id),
  }
}

function readJsonKey(key) {
  const raw = localStorage.getItem(key)
  return raw ? JSON.parse(raw) : null
}

function storageKeyForPlan(index, id) {
  const meta = index?.plans?.find(plan => plan.id === id)
  return meta?.storageKey || planStorageKey(id)
}

function readPlanFromIndex(index, id) {
  const key = storageKeyForPlan(index, id)
  const plan = normalizeStoredPlan(readJsonKey(key), id)
  return plan ? { ...plan, id, storageKey: key } : null
}

function writePlan(plan, index) {
  const key = plan.storageKey || storageKeyForPlan(index, plan.id)
  // Synchronous LS write — needed for startup (loadMultiPlanStorage runs sync)
  localStorage.setItem(key, JSON.stringify(plan))
  // Async IDB backup — fire-and-forget; keeps IDB in sync for recovery
  writeArtifactToIdb(key, plan).catch(() => {})
}

function writeIndex(index) {
  localStorage.setItem(PLAN_INDEX_KEY, JSON.stringify(index))
}

function createIndexForPlan(plan) {
  return {
    activePlanId: plan.id,
    plans: [metaForPlan(plan)],
  }
}

function migrateLegacySingleWorkspace() {
  const plan = legacyPlanCopy()
  if (!plan) return null
  const index = createIndexForPlan(plan)
  writeIndex(index)
  return { index, activePlan: plan }
}

function legacyPlanCopy() {
  const legacy = readJsonKey(LEGACY_STORAGE_KEY)
  const migrated = normalizeStoredPlan(legacy, LEGACY_PLAN_ID)
  if (!migrated?.normalizedWorkspace) return null

  return {
    ...migrated,
    id: LEGACY_PLAN_ID,
    name: planDisplayName(migrated),
    storageKey: LEGACY_STORAGE_KEY,
    updatedAt: migrated.updatedAt || new Date().toISOString(),
  }
}

function recoverableLocalPlans() {
  const recovered = []
  const seenKeys = new Set()

  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (!key || key === PLAN_INDEX_KEY || seenKeys.has(key)) continue
    seenKeys.add(key)

    let stored
    try {
      stored = readJsonKey(key)
    } catch {
      continue
    }

    const fallbackId = key === LEGACY_STORAGE_KEY
      ? LEGACY_PLAN_ID
      : key.startsWith(PLAN_KEY_PREFIX)
      ? key.slice(PLAN_KEY_PREFIX.length)
      : workspaceId()
    const normalized = normalizeStoredPlan(stored, fallbackId)
    if (!normalized?.normalizedWorkspace) continue

    const id = key === LEGACY_STORAGE_KEY
      ? LEGACY_PLAN_ID
      : key.startsWith(PLAN_KEY_PREFIX)
      ? fallbackId
      : planId()
    recovered.push({
      ...normalized,
      id,
      name: planDisplayName(normalized),
      storageKey: key === LEGACY_STORAGE_KEY || key.startsWith(PLAN_KEY_PREFIX) ? key : planStorageKey(id),
      updatedAt: normalized.updatedAt || new Date().toISOString(),
    })
  }

  return recovered
}

function recoveredStateFromLocalStorage() {
  const recovered = recoverableLocalPlans()
  if (!recovered.length) return null

  for (const plan of recovered) {
    writePlan(plan)
  }

  const sorted = [...recovered].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  const activePlan = sorted[0]
  const index = {
    activePlanId: activePlan.id,
    plans: sorted.map(plan => metaForPlan(plan)),
  }
  writeIndex(index)
  return { index, activePlan }
}

function loadMultiPlanStorage() {
  try {
    const existingIndex = readJsonKey(PLAN_INDEX_KEY)
    if (!existingIndex) {
      return migrateLegacySingleWorkspace() ||
        recoveredStateFromLocalStorage() ||
        { index: { activePlanId: null, plans: [] }, activePlan: null }
    }

    const plans = Array.isArray(existingIndex.plans) ? existingIndex.plans : []
    if (plans.length === 0) {
      const migratedLegacy = legacyPlanCopy()
      if (migratedLegacy) {
        writePlan(migratedLegacy)
        const recoveredIndex = createIndexForPlan(migratedLegacy)
        writeIndex(recoveredIndex)
        return { index: recoveredIndex, activePlan: migratedLegacy }
      }

      const recovered = recoveredStateFromLocalStorage()
      if (recovered) return recovered
    }

    const activePlanId = existingIndex.activePlanId || plans[0]?.id || null
    const activePlan = activePlanId
      ? readPlanFromIndex(existingIndex, activePlanId)
      : null

    const repairedIndex = {
      activePlanId: activePlan?.id || activePlanId,
      plans: plans.map(meta => (
        activePlan?.id === meta.id ? metaForPlan(activePlan, meta) : meta
      )),
    }
    if (JSON.stringify(repairedIndex) !== JSON.stringify(existingIndex)) {
      writeIndex(repairedIndex)
    }
    if (activePlan) writePlan(activePlan, repairedIndex)

    return { index: repairedIndex, activePlan }
  } catch {
    return recoveredStateFromLocalStorage() || { index: { activePlanId: null, plans: [] }, activePlan: null }
  }
}

function replacePlanMeta(index, plan) {
  const existing = index.plans.find(p => p.id === plan.id)
  const meta = metaForPlan(plan, existing)
  const plans = existing
    ? index.plans.map(p => p.id === plan.id ? meta : p)
    : [...index.plans, meta]
  return { activePlanId: plan.id, plans }
}

export function useWorkspace() {
  const [{ index, activePlan }, setPlannerState] = useState(loadMultiPlanStorage)

  useEffect(() => {
    try {
      writeIndex(index)
      if (activePlan) writePlan(activePlan)
    } catch (error) {
      void error
    }
  }, [index, activePlan])

  function setActivePlan(nextPlan) {
    setPlannerState(prev => {
      const updatedIndex = replacePlanMeta(prev.index, nextPlan)
      return { index: updatedIndex, activePlan: nextPlan }
    })
  }

  function importPackage(raw) {
    const result = normalizeStrategyBasisPackage(raw)
    if (result.error) return { error: result.error }

    const nw = result.workspace
    const initRev = buildInitialRevision(nw)
    const now = new Date().toISOString()
    const current = activePlan || emptyWorkspacePlan()
    const name = nw.entity?.company || nw.entity?.name || current.name || 'Imported plan'

    setActivePlan({
      ...current,
      name,
      updatedAt: now,
      sourceType: 'import',
      sourcePackage: result.sourcePackage,
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

  function saveStageRevision(stage, { prompt, impactSummary, learningSignals } = {}) {
    setPlannerState(prev => {
      if (!prev.activePlan) return prev
      const existing = prev.activePlan.stageRevisions[stage] || []
      const nextNum = existing.length + 1
      const nw = prev.activePlan.normalizedWorkspace
      const newRev = buildManualRevision(nw, nextNum, prompt, impactSummary, learningSignals)
      const updatedPlan = {
        ...prev.activePlan,
        updatedAt: new Date().toISOString(),
        stageRevisions: {
          ...prev.activePlan.stageRevisions,
          [stage]: [...existing, newRev],
        },
        activeStageRevisionIds: {
          ...prev.activePlan.activeStageRevisionIds,
          [stage]: newRev.id,
        },
      }
      return { index: replacePlanMeta(prev.index, updatedPlan), activePlan: updatedPlan }
    })
  }

  function saveRawRevision(stage, revisionRecord) {
    setPlannerState(prev => {
      if (!prev.activePlan) return prev
      const existing = prev.activePlan.stageRevisions[stage] || []
      const updatedPlan = {
        ...prev.activePlan,
        updatedAt: new Date().toISOString(),
        stageRevisions: {
          ...prev.activePlan.stageRevisions,
          [stage]: [...existing, revisionRecord],
        },
        activeStageRevisionIds: {
          ...prev.activePlan.activeStageRevisionIds,
          [stage]: revisionRecord.id,
        },
      }
      return { index: replacePlanMeta(prev.index, updatedPlan), activePlan: updatedPlan }
    })
  }

  function saveStage1AIRevision(revisionRecord, patchedWorkspace) {
    setPlannerState(prev => {
      if (!prev.activePlan) return prev
      const existing = prev.activePlan.stageRevisions.stage1 || []
      const updatedPlan = {
        ...prev.activePlan,
        updatedAt: new Date().toISOString(),
        normalizedWorkspace: patchedWorkspace,
        stageRevisions: {
          ...prev.activePlan.stageRevisions,
          stage1: [...existing, revisionRecord],
        },
        activeStageRevisionIds: {
          ...prev.activePlan.activeStageRevisionIds,
          stage1: revisionRecord.id,
        },
      }
      return { index: replacePlanMeta(prev.index, updatedPlan), activePlan: updatedPlan }
    })
  }

  function createNewPlan() {
    const nextPlan = emptyWorkspacePlan()
    setActivePlan(nextPlan)
  }

  function duplicateCurrentPlan() {
    const base = activePlan || emptyWorkspacePlan()
    const now = new Date().toISOString()
    const id = planId()
    const copy = {
      ...cloneDeep(base),
      id,
      name: `${planDisplayName(base)} Copy`,
      createdAt: now,
      updatedAt: now,
      storageKey: planStorageKey(id),
    }
    setActivePlan(copy)
  }

  function switchPlan(id) {
    if (!id || id === index.activePlanId) return
    try {
      const nextPlan = readPlanFromIndex(index, id)
      if (!nextPlan) return
      setPlannerState(prev => ({
        index: {
          activePlanId: id,
          plans: prev.index.plans.map(meta => meta.id === id ? metaForPlan(nextPlan, meta) : meta),
        },
        activePlan: nextPlan,
      }))
    } catch (error) {
      void error
    }
  }

  function renameCurrentPlan(name) {
    const trimmed = String(name || '').trim()
    if (!trimmed || !activePlan) return
    setActivePlan({
      ...activePlan,
      name: trimmed,
      updatedAt: new Date().toISOString(),
    })
  }

  function deleteCurrentPlan() {
    if (!activePlan) return
    const deletedId = activePlan.id
    const deletedKey = storageKeyForPlan(index, deletedId)
    try {
      if (deletedKey !== LEGACY_STORAGE_KEY) {
        localStorage.removeItem(deletedKey)
      }
    } catch (error) {
      void error
    }

    const remaining = index.plans.filter(plan => plan.id !== deletedId)
    const nextActiveId = remaining[0]?.id || null
    const nextIndex = { activePlanId: nextActiveId, plans: remaining }
    const nextPlan = nextActiveId ? readPlanFromIndex(nextIndex, nextActiveId) : null
    setPlannerState({
      index: nextIndex,
      activePlan: nextPlan,
    })
  }

  function clearCurrentPlan() {
    if (!activePlan) return
    setActivePlan(emptyWorkspacePlan(activePlan.id, activePlan.name))
  }

  function exportCurrentPlanJson() {
    if (!activePlan) return
    downloadJson(`bsp-${safeFilePart(planDisplayName(activePlan))}.json`, {
      schema: 'bsp_plan_export_v1',
      exportedAt: new Date().toISOString(),
      plan: activePlan,
    })
  }

  function importPlanJson(raw) {
    const imported = raw?.schema === 'bsp_plan_export_v1' ? raw.plan : raw
    const normalized = normalizeStoredPlan(imported, planId())
    if (!normalized) return { error: 'Plan JSON was not recognized.' }

    const now = new Date().toISOString()
    const id = planId()
    const importedPlan = {
      ...normalized,
      id,
      name: `${planDisplayName(normalized)} Import`,
      createdAt: now,
      updatedAt: now,
      storageKey: planStorageKey(id),
    }
    setActivePlan(importedPlan)
    return { error: null }
  }

  function deleteAllLocalPlannerData() {
    try {
      for (const meta of index.plans) {
        localStorage.removeItem(meta.storageKey || planStorageKey(meta.id))
      }
      localStorage.removeItem(PLAN_INDEX_KEY)
      localStorage.removeItem(LEGACY_STORAGE_KEY)
    } catch (error) {
      void error
    }
    setPlannerState({ index: { activePlanId: null, plans: [] }, activePlan: null })
  }

  const workspace = activePlan?.normalizedWorkspace ?? null
  const importedAt = activePlan?.sourceType === 'import' ? activePlan.createdAt : null

  return {
    fullWorkspace: activePlan,
    workspace,
    importedAt,
    planIndex: index,
    activePlanId: index.activePlanId,
    importPackage,
    saveStageRevision,
    saveRawRevision,
    saveStage1AIRevision,
    createNewPlan,
    duplicateCurrentPlan,
    switchPlan,
    renameCurrentPlan,
    deleteCurrentPlan,
    clearCurrentPlan,
    exportCurrentPlanJson,
    importPlanJson,
    deleteAllLocalPlannerData,
  }
}
