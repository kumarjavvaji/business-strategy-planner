// ── Strategy Basis Package — import normalization layer ───────────────────────
//
// Business Strategy Planner treats DomainIQ exports as external versioned
// contracts. Stage components never read the raw package directly — they
// consume the normalized workspace model produced here.
//
// When DomainIQ's export schema changes:
//   - Add a new normalizer (normalizeV11Package, normalizeV2Package, etc.)
//   - Map new fields to the existing workspace shape, or extend the shape
//   - Existing stage components keep working without modification
//
// Storage contract: always persist BOTH the raw package (sourcePackage) and
// the normalized workspace so traceability is never lost.

// ── Supported package types and versions ─────────────────────────────────────

const SUPPORTED_PACKAGE_TYPE = 'domainiq_strategy_basis_package'

const SUPPORTED_VERSIONS = {
  '1.0': normalizeV1Package,
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function safeStr(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  return String(value)
}

function safeArr(value) {
  return Array.isArray(value) ? value : []
}

function safeBool(value, fallback = false) {
  if (typeof value === 'boolean') return value
  return fallback
}

// ── detectPackageVersion ──────────────────────────────────────────────────────
// Reads packageType and packageVersion from the raw object.
// Returns { packageType, packageVersion } — does not validate.
// Safe to call on any unknown object.

export function detectPackageVersion(raw) {
  if (raw == null || typeof raw !== 'object') {
    return { packageType: null, packageVersion: null }
  }
  return {
    packageType:    safeStr(raw.packageType)    || null,
    packageVersion: safeStr(raw.packageVersion) || null,
  }
}

// ── validateStrategyBasisPackage ──────────────────────────────────────────────
// Returns { valid: true } or { valid: false, error: string }.
// Does not throw.

export function validateStrategyBasisPackage(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, error: 'Package is not a valid JSON object.' }
  }

  const { packageType, packageVersion } = detectPackageVersion(raw)

  if (!packageType) {
    return { valid: false, error: 'Missing packageType field.' }
  }

  if (packageType !== SUPPORTED_PACKAGE_TYPE) {
    return {
      valid: false,
      error: `Unsupported package type: "${packageType}". Expected "${SUPPORTED_PACKAGE_TYPE}".`,
    }
  }

  if (!packageVersion) {
    return { valid: false, error: 'Missing packageVersion field.' }
  }

  if (!SUPPORTED_VERSIONS[packageVersion]) {
    return {
      valid: false,
      error: `Unsupported package version: "${packageVersion}". Supported versions: ${Object.keys(SUPPORTED_VERSIONS).join(', ')}.`,
    }
  }

  return { valid: true, error: null }
}

// ── normalizeStrategyBasisPackage ─────────────────────────────────────────────
// Entry point for all import normalization.
// Returns { workspace, sourcePackage } on success.
// Returns { error } on failure — callers should check for error before using.
//
// workspace   — the normalized model stage components consume
// sourcePackage — the original raw package, preserved for traceability

export function normalizeStrategyBasisPackage(raw) {
  const validation = validateStrategyBasisPackage(raw)
  if (!validation.valid) {
    return { workspace: null, sourcePackage: raw ?? null, error: validation.error }
  }

  const { packageVersion } = detectPackageVersion(raw)
  const normalizer = SUPPORTED_VERSIONS[packageVersion]

  try {
    const workspace = normalizer(raw)
    return { workspace, sourcePackage: raw, error: null }
  } catch (err) {
    return {
      workspace:     null,
      sourcePackage: raw,
      error:         `Normalization failed for v${packageVersion}: ${err.message}`,
    }
  }
}

// ── normalizeV1Package ────────────────────────────────────────────────────────
// Maps a v1.0 Strategy Basis Package to the Business Strategy Planner
// workspace model.
//
// Design rules:
//   - Missing fields → empty string, empty array, or null (never undefined)
//   - Unknown/extra fields on the raw package are not silently dropped —
//     they are preserved under workspace.extras for forward compatibility
//   - Field names use the Business Strategy Planner's vocabulary, not
//     DomainIQ's internal names (they happen to align in v1, but can diverge)

export function normalizeV1Package(raw) {
  const session     = raw.sourceSession      || {}
  const artifact    = raw.selectedArtifact   || {}
  const basis       = raw.strategyBasis      || {}
  const evidence    = raw.evidenceChain      || {}
  const exec        = raw.executionImplications || {}
  const lineage     = raw.lineage            || {}

  // Known top-level keys — anything else is preserved in extras
  const knownKeys = new Set([
    'packageType', 'packageVersion', 'exportedAt', 'sourceApp',
    'sourceAppVersion', 'sourceSession', 'selectedArtifact',
    'strategyBasis', 'evidenceChain', 'executionImplications', 'lineage',
  ])
  const extras = {}
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) extras[key] = raw[key]
  }

  return {
    // ── Import metadata ─────────────────────────────────────────────────────
    importedAt:     new Date().toISOString(),
    exportedAt:     safeStr(raw.exportedAt),
    sourceApp:      safeStr(raw.sourceApp),
    sourceAppVersion: safeStr(raw.sourceAppVersion),
    packageVersion: safeStr(raw.packageVersion),

    // ── Entity context ───────────────────────────────────────────────────────
    entity: {
      name:         safeStr(session.sessionName  || session.company || session.industry || session.domain),
      company:      safeStr(session.company),
      industry:     safeStr(session.industry),
      domain:       safeStr(session.domain),
      workflow:     safeStr(session.workflow),
      analysisType: safeStr(session.analysisType),
      sessionId:    safeStr(session.sessionId),
    },

    // ── Anchor artifact ──────────────────────────────────────────────────────
    artifact: {
      id:              safeStr(artifact.artifactId),
      type:            safeStr(artifact.artifactType),
      title:           safeStr(artifact.artifactTitle),
      versionId:       safeStr(artifact.artifactVersionId),
      versionNumber:   artifact.artifactVersionNumber ?? null,
      createdAt:       safeStr(artifact.artifactCreatedAt),
      versionCreatedAt: safeStr(artifact.versionCreatedAt),
      content:         safeStr(artifact.artifactContent),
      summary:         safeStr(artifact.artifactSummary),
      data:            artifact.artifactData ?? null,
    },

    // ── Strategy basis ───────────────────────────────────────────────────────
    strategy: {
      thesis:               safeStr(basis.strategicThesis),
      businessProblem:      safeStr(basis.businessProblem),
      opportunity:          safeStr(basis.opportunity),
      recommendedDirection: safeStr(basis.recommendedDirection),
      confidenceLevel:      safeStr(basis.confidenceLevel),
      readinessLevel:       safeStr(basis.readinessLevel),
      targetCustomer:       safeStr(basis.targetCustomer),
    },

    // ── Evidence chain ───────────────────────────────────────────────────────
    evidence: {
      stage1Intent:         safeStr(evidence.stage1Intent),
      stage2Summary:        safeStr(evidence.stage2EvidenceSummary),
      stage3Synthesis:      safeStr(evidence.stage3Synthesis),
      userContextAdditions: safeArr(evidence.stage4UserContextAdditions),
      keyInsights:          safeArr(evidence.keyInsights),
      supportingClaims:     safeArr(evidence.supportingClaims),
      risks:                safeArr(evidence.risks),
      assumptions:          safeArr(evidence.assumptions),
      unresolvedQuestions:  safeArr(evidence.unresolvedQuestions),
      nextActions:          safeArr(evidence.recommendedNextActions),
      artifactCandidates:   safeArr(evidence.artifactCandidates),
    },

    // ── Execution implications ───────────────────────────────────────────────
    // All empty in v1.0 — structure is ready for downstream population
    executionImplications: {
      likelyBusinessUnits:        safeArr(exec.likelyBusinessUnits),
      executiveLeadership:        safeArr(exec.executiveLeadershipImplications),
      productPdlc:                safeArr(exec.productPdlcImplications),
      engineeringTechnology:      safeArr(exec.engineeringTechnologyImplications),
      designUx:                   safeArr(exec.designUxImplications),
      dataAnalytics:              safeArr(exec.dataAnalyticsImplications),
      sales:                      safeArr(exec.salesImplications),
      marketing:                  safeArr(exec.marketingImplications),
      customerSuccess:            safeArr(exec.customerSuccessImplications),
      operations:                 safeArr(exec.operationsImplications),
      finance:                    safeArr(exec.financeImplications),
      legalCompliance:            safeArr(exec.legalComplianceImplications),
      supportService:             safeArr(exec.supportServiceImplications),
      peopleChangeManagement:     safeArr(exec.peopleChangeManagementImplications),
      partnershipsEcosystem:      safeArr(exec.partnershipsEcosystemImplications),
    },

    // ── Lineage ──────────────────────────────────────────────────────────────
    lineage: {
      sourceStage:           safeStr(lineage.sourceStage),
      sourceArtifactVersion: safeStr(lineage.sourceArtifactVersion),
      basedOnStages:         safeArr(lineage.basedOnStages),
      citationsPreserved:    safeBool(lineage.citationsPreserved, false),
      userEdited:            safeBool(lineage.userEdited, false),
      notes:                 safeStr(lineage.notes),
    },

    // ── Forward-compatibility: unknown top-level fields ──────────────────────
    // Preserved so traceability is never silently dropped when DomainIQ
    // adds new top-level sections before this normalizer is updated.
    extras: Object.keys(extras).length > 0 ? extras : null,
  }
}
