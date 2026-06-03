export const STAGE4_READINESS_TARGETS = {
  EXECUTION_MAPPING: 'executionMapping',
  BU_SUMMARY: 'buSummary',
  QUALITY_AUDIT: 'compiledStrategyQualityAudit',
}

const EXECUTION_SEQUENCE_PANEL_ID = 'executionSequence'

export function artifactMappingAnchorId(artifactId) {
  return artifactId ? `stage3-artifact-mapping-${artifactId}` : null
}

export function missingReadinessNavigationFields(row, targetType = STAGE4_READINESS_TARGETS.EXECUTION_MAPPING) {
  const missing = []
  const buId = row?.buId || row?.stableBuKey || row?.buKey || row?.buName
  if (!buId) missing.push('buId or stable BU key')
  if (!row?.buName) missing.push('buName')
  if (targetType === STAGE4_READINESS_TARGETS.EXECUTION_MAPPING && !row?.artifactId) {
    missing.push('artifactId')
  }
  if (
    targetType !== STAGE4_READINESS_TARGETS.BU_SUMMARY &&
    targetType !== STAGE4_READINESS_TARGETS.QUALITY_AUDIT &&
    targetType !== STAGE4_READINESS_TARGETS.EXECUTION_MAPPING &&
    !row?.sourcePanelId
  ) {
    missing.push('sourcePanelId')
  }
  return missing
}

export function buildArtifactReadinessDeepLinkTarget(row, targetType = null) {
  const resolvedTargetType = targetType || (
    row?.readinessStatus === 'blocked_missing_mapping'
      ? STAGE4_READINESS_TARGETS.EXECUTION_MAPPING
      : row?.sourcePanelId
        ? row.sourcePanelId
        : STAGE4_READINESS_TARGETS.EXECUTION_MAPPING
  )
  const missing = missingReadinessNavigationFields(row, resolvedTargetType)
  if (missing.length) {
    return { target: null, missing }
  }

  const buId = row.buId || row.stableBuKey || row.buKey || row.buName
  const panelId = resolvedTargetType === STAGE4_READINESS_TARGETS.EXECUTION_MAPPING
    ? EXECUTION_SEQUENCE_PANEL_ID
    : resolvedTargetType === STAGE4_READINESS_TARGETS.BU_SUMMARY
      ? STAGE4_READINESS_TARGETS.BU_SUMMARY
      : resolvedTargetType === STAGE4_READINESS_TARGETS.QUALITY_AUDIT
        ? STAGE4_READINESS_TARGETS.QUALITY_AUDIT
        : row.sourcePanelId
  const anchorId = row.anchorId || (
    resolvedTargetType === STAGE4_READINESS_TARGETS.EXECUTION_MAPPING
      ? artifactMappingAnchorId(row.artifactId)
      : panelId
  )

  return {
    target: {
      buId,
      buName: row.buName,
      panelId,
      artifactId: row.artifactId || null,
      anchorId,
      sourcePanelId: panelId,
      reason: row.readinessStatus || 'artifact_readiness',
    },
    missing: [],
  }
}
