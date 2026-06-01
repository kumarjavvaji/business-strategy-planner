/**
 * Shared storage key helpers for Stage 3 BU plan records.
 *
 * Canonical format (all new writes from Stage 3, all reads in Stage 4):
 *   bsp_v1_stage3_bu_plan_{wid}_{s1id}_{s2id}_{safe}
 *   where safe = name.toLowerCase().replace(/[^a-z0-9]/g, '_')
 *
 * Legacy format (read-fallback only — records written before this module existed):
 *   Same prefix but safe = name.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 90)
 *   This preserves uppercase letters and allows hyphens, producing a different
 *   suffix for any BU name that contains uppercase or hyphens.
 *
 * Stage 4 readers try the canonical key first, then the legacy key.
 * stage3BuPlanLegacyKey() returns null when both keys are identical (no fallback needed).
 */

const KEY_PREFIX = 'bsp_v1_stage3_bu_plan_'

export function storageSafeNameCanonical(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '_')
}

export function storageSafeNameLegacy(name) {
  return String(name || 'unnamed').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 90)
}

/**
 * Canonical key — used for all Stage 3 BU plan writes going forward.
 * Returns null when any required segment is missing.
 */
export function stage3BuPlanKey(workspaceId, stage1Id, stage2Id, buName) {
  if (!workspaceId || !stage1Id || !stage2Id || !buName) return null
  return `${KEY_PREFIX}${workspaceId}_${stage1Id}_${stage2Id}_${storageSafeNameCanonical(buName)}`
}

/**
 * Legacy key — used only as a backward-compatible read fallback in Stage 4.
 * Returns null when the legacy key would be identical to the canonical key
 * (i.e. the BU name is already all-lowercase with no hyphens), since no
 * fallback read is needed in that case.
 */
export function stage3BuPlanLegacyKey(workspaceId, stage1Id, stage2Id, buName) {
  if (!workspaceId || !stage1Id || !stage2Id || !buName) return null
  const canonical = storageSafeNameCanonical(buName)
  const legacy    = storageSafeNameLegacy(buName)
  if (legacy === canonical) return null
  return `${KEY_PREFIX}${workspaceId}_${stage1Id}_${stage2Id}_${legacy}`
}
