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
import {
  createArtifactChildUnit,
  createArtifactSectionUnit,
  transitionSectionToDraft,
  transitionSectionToFailed,
  transitionSectionToAccepted,
  transitionUnitToDraftReady,
  transitionUnitToFailed,
  transitionUnitToAccepted,
  deriveArtifactGenerationStatus,
  sectionIsValid,
} from './stage4ArtifactLifecycle'

// ── Constants ──────────────────────────────────────────────────────────────────

export const ARTIFACT_OUTPUT_VERSION = 1

export const OUTPUT_STATUS = {
  GENERATED: 'generated',
  PARTIAL:   'partial',
  FAILED:    'failed',
  STALE:     'stale',
}

export const REVIEW_STATUS = {
  NOT_REVIEWED:   'not_reviewed',
  NEEDS_REVISION: 'needs_revision',
  USABLE:         'usable',
  STRONG:         'strong',
}

export const ARTIFACT_QUALITY_STATUS = {
  STRONG:         'strong',
  USABLE:         'usable',
  NEEDS_REVISION: 'needs_revision',
  FAILED:         'failed',
}

// Ordered list of review dimensions shown in the UI
export const REVIEW_DIMENSIONS = [
  { key: 'strategicClarity',          label: 'Strategic clarity' },
  { key: 'traceability',              label: 'Traceability to Stage 1–3 basis' },
  { key: 'executionSpecificity',      label: 'Execution specificity' },
  { key: 'dependencyRiskUsefulness',  label: 'Dependency / risk usefulness' },
  { key: 'smeReviewability',          label: 'SME reviewability' },
  { key: 'redundancyIssues',          label: 'Redundancy / copied-language issues' },
  { key: 'overallUsability',          label: 'Overall usability' },
]

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
  artifactBasis = null, qualityAudit = null, sectionUnits = null, artifactGenerationStatus = null,
}) {
  const now = new Date().toISOString()
  const resolvedGenerationStatus = artifactGenerationStatus || (sectionUnits ? deriveArtifactGenerationStatus(sectionUnits) : 'generated')
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
    generationStatus:                    resolvedGenerationStatus === 'partial' ? OUTPUT_STATUS.PARTIAL : OUTPUT_STATUS.GENERATED,
    contentSections,
    sectionUnits:                         sectionUnits || [],
    artifactGenerationStatus:             resolvedGenerationStatus,
    evidenceBasis:                       evidenceBasis || '',
    assumptions:                         assumptions   || [],
    openQuestions:                       openQuestions || [],
    artifactBasis,
    qualityAudit,
    reviewStatus:                        qualityAudit?.status === ARTIFACT_QUALITY_STATUS.STRONG ? REVIEW_STATUS.STRONG
      : qualityAudit?.status === ARTIFACT_QUALITY_STATUS.USABLE ? REVIEW_STATUS.USABLE
      : qualityAudit?.status === ARTIFACT_QUALITY_STATUS.NEEDS_REVISION ? REVIEW_STATUS.NEEDS_REVISION
      : REVIEW_STATUS.NOT_REVIEWED,
    reviewNotes:                         '',
    createdAt:                           now,
    updatedAt:                           now,
    persistedAt:                         null,  // set by persistArtifactOutput
    verifiedAt:                          null,  // set by caller after loadArtifactOutput succeeds
    error:                               null,
  }
}

function normalizeSentence(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}

function sentences(text) {
  return String(text || '').split(/[.!?]\s+/).map(normalizeSentence).filter(s => s.length > 35)
}

function allOutputText(contentSections) {
  return (contentSections || []).map(section => `${section.heading || ''} ${section.purpose || ''} ${section.body || ''}`).join(' ')
}

export function auditArtifactOutput({ contentSections = [], artifactBasis = null }) {
  const findings = []
  const outputText = allOutputText(contentSections)
  const normalizedOutput = normalizeSentence(outputText)
  const sectionSentences = contentSections.map(section => sentences(section.body))
  const seenSentences = new Map()

  sectionSentences.forEach((items, sectionIndex) => {
    items.forEach(sentence => {
      if (seenSentences.has(sentence)) {
        findings.push({ type: 'repeated_section_language', severity: 'blocking', detail: `Repeated sentence appears in sections ${seenSentences.get(sentence) + 1} and ${sectionIndex + 1}.` })
      } else {
        seenSentences.set(sentence, sectionIndex)
      }
    })
  })

  ;(artifactBasis?.selectedExecutionTactics || []).forEach(tactic => {
    const tacticName = normalizeSentence(tactic.optionName)
    if (tacticName && !normalizedOutput.includes(tacticName)) {
      findings.push({ type: 'missing_mapped_tactic', severity: 'blocking', detail: `Mapped tactic omitted: ${tactic.optionName}` })
    }
    ;[tactic.whenToUse, tactic.whyItFits, tactic.evidenceProduced].filter(Boolean).forEach(sourceText => {
      const normalizedSource = normalizeSentence(sourceText)
      if (normalizedSource.length > 60 && normalizedOutput.includes(normalizedSource.slice(0, 80))) {
        findings.push({ type: 'copied_stage3_prose', severity: 'blocking', detail: `Output appears to copy Stage 3 prose for tactic: ${tactic.optionName}` })
      }
    })
  })

  ;(artifactBasis?.excludedContextSummary?.unmappedTacticNames || []).forEach(name => {
    const normalizedName = normalizeSentence(name)
    if (normalizedName && normalizedOutput.includes(normalizedName)) {
      findings.push({ type: 'unmapped_tactic_included', severity: 'blocking', detail: `Unmapped tactic appears in output: ${name}` })
    }
  })

  const genericPhrases = ['best practices', 'stakeholder alignment', 'robust governance', 'continuous improvement', 'cross functional collaboration']
  genericPhrases.forEach(phrase => {
    if (normalizedOutput.includes(phrase)) {
      findings.push({ type: 'generic_consultant_filler', severity: 'warning', detail: `Generic phrase detected: ${phrase}` })
    }
  })

  contentSections.forEach((section, index) => {
    const body = String(section.body || '')
    if (body.length < 40 || /[,;:]$/.test(body.trim())) {
      findings.push({ type: 'incomplete_section', severity: 'blocking', detail: `Section ${index + 1} appears incomplete.` })
    }
    if (body.length > 1600) {
      findings.push({ type: 'excessive_prose', severity: 'warning', detail: `Section ${index + 1} is longer than expected for a concise artifact.` })
    }
  })

  const blocking = findings.filter(f => f.severity === 'blocking')
  const status = blocking.length > 0 ? ARTIFACT_QUALITY_STATUS.NEEDS_REVISION
    : findings.length > 0 ? ARTIFACT_QUALITY_STATUS.USABLE
    : ARTIFACT_QUALITY_STATUS.STRONG

  return {
    status,
    findings,
    checkedAt: new Date().toISOString(),
  }
}

export function auditArtifactSection(section, artifactBasis = null) {
  const findings = []
  const text = allOutputText([section])
  const normalizedOutput = normalizeSentence(text)

  if (!section?.sectionId || !section?.heading || !section?.purpose || !section?.body) {
    findings.push({ type: 'missing_required_fields', severity: 'blocking', detail: 'Section is missing one or more required fields.' })
  }
  if (String(section?.body || '').length < 40 || /[,;:]$/.test(String(section?.body || '').trim())) {
    findings.push({ type: 'incomplete_section', severity: 'blocking', detail: 'Section appears incomplete or truncated.' })
  }

  ;(artifactBasis?.selectedExecutionTactics || []).forEach(tactic => {
    ;[tactic.whenToUse, tactic.whyItFits, tactic.evidenceProduced].filter(Boolean).forEach(sourceText => {
      const normalizedSource = normalizeSentence(sourceText)
      if (normalizedSource.length > 60 && normalizedOutput.includes(normalizedSource.slice(0, 80))) {
        findings.push({ type: 'copied_stage3_prose', severity: 'blocking', detail: `Output appears to copy Stage 3 prose for tactic: ${tactic.optionName}` })
      }
    })
  })

  ;(artifactBasis?.excludedContextSummary?.unmappedTacticNames || []).forEach(name => {
    const normalizedName = normalizeSentence(name)
    if (normalizedName && normalizedOutput.includes(normalizedName)) {
      findings.push({ type: 'unmapped_tactic_included', severity: 'blocking', detail: `Unmapped tactic appears in output: ${name}` })
    }
  })

  const blockingFindings = findings.filter(f => f.severity === 'blocking')
  return {
    status: blockingFindings.length > 0 ? 'failed' : 'complete',
    blockingFindings,
    findings,
    lastAuditedAt: new Date().toISOString(),
  }
}

export function buildInitialArtifactSectionUnits(sectionOutline = [], existingUnits = []) {
  const byId = new Map((existingUnits || []).map(unit => [unit.sectionId, unit]))
  return (sectionOutline || []).map(sectionDef => byId.get(sectionDef.id) || createArtifactSectionUnit(sectionDef))
}

export function buildInitialArtifactChildUnits(childDefs = [], existingChildren = []) {
  const byId = new Map((existingChildren || []).map(child => [child.childId, child]))
  return (childDefs || []).map(childDef => byId.get(childDef.childId) || createArtifactChildUnit(childDef))
}

export function auditArtifactChild(child) {
  const findings = []
  if (!child?.childId || !child?.heading || !child?.body) {
    findings.push({ type: 'missing_required_fields', severity: 'blocking', detail: 'Child item is missing one or more required fields.' })
  }
  if (String(child?.body || '').length < 25 || /[,;:]$/.test(String(child?.body || '').trim())) {
    findings.push({ type: 'incomplete_child', severity: 'blocking', detail: 'Child item appears incomplete or truncated.' })
  }
  const blockingFindings = findings.filter(f => f.severity === 'blocking')
  return {
    status: blockingFindings.length > 0 ? 'failed' : 'complete',
    blockingFindings,
    findings,
    lastAuditedAt: new Date().toISOString(),
  }
}

export function applyChildGenerationSuccess(childUnit, childContent) {
  const audit = auditArtifactChild(childContent)
  const draft = transitionUnitToDraftReady(childUnit, {
    contentPatch: {
      content: childContent,
      audit,
      failureReason: null,
      lastGeneratedAt: new Date().toISOString(),
    },
    audit,
  })
  if (audit.status !== 'complete') return draft
  return transitionUnitToAccepted(draft, { audit })
}

export function applyChildGenerationFailure(childUnit, failureReason, attemptedContent = null, auditAfter = null) {
  return {
    ...transitionUnitToFailed(childUnit, failureReason, { attemptedContent, auditAfter }),
    failureReason,
  }
}

export function assembleSectionFromChildUnits(sectionUnit, childUnits = []) {
  const failedChildren = childUnits.filter(child => child.lifecycle === 'failed')
  const validChildren = childUnits.filter(child =>
    ['draft_ready', 'accepted'].includes(child.lifecycle) &&
    child.audit?.status === 'complete' &&
    child.content
  )
  if (failedChildren.length > 0 || validChildren.length !== childUnits.length) {
    return transitionSectionToFailed({
      ...sectionUnit,
      generationMode: 'child_units',
      childUnits,
    }, failedChildren[0]?.failureReason || 'One or more child units failed.')
  }

  const section = {
    sectionId: sectionUnit.sectionId,
    heading: sectionUnit.heading,
    purpose: sectionUnit.purpose,
    body: validChildren.map(child => `${child.content.heading}: ${child.content.body}`).join('\n'),
    sourceAtomIds: [...new Set(validChildren.flatMap(child => child.content.sourceAtomIds || []))],
    openQuestions: validChildren.flatMap(child => child.content.openQuestions || []),
    confidenceLevel: validChildren.some(child => child.content.confidenceLevel === 'low') ? 'low' : 'medium',
  }
  const audit = auditArtifactSection(section)
  const draft = transitionSectionToDraft({
    ...sectionUnit,
    generationMode: 'child_units',
    childUnits,
    assembledContent: section,
  }, section, audit)
  if (audit.status !== 'complete') return draft
  return transitionSectionToAccepted(draft, audit)
}

export function applySectionGenerationSuccess(sectionUnit, section, artifactBasis) {
  const audit = auditArtifactSection(section, artifactBasis)
  const draft = transitionSectionToDraft(sectionUnit, section, audit)
  if (audit.status !== 'complete') return draft
  return transitionSectionToAccepted(draft, audit)
}

export function applySectionGenerationFailure(sectionUnit, failureReason, attemptedContent = null, auditAfter = null) {
  return transitionSectionToFailed(sectionUnit, failureReason, { attemptedContent, auditAfter })
}

export function assembleArtifactFromSectionUnits(sectionUnits = []) {
  const validUnits = (sectionUnits || []).filter(sectionIsValid)
  return {
    contentSections: validUnits.map(unit => unit.section),
    failedSections: (sectionUnits || [])
      .filter(unit => unit?.lifecycle === 'failed')
      .map(unit => ({
        sectionId: unit.sectionId,
        failureReason: unit.lifecycleError || unit.lifecycleMeta?.failureReason || 'Section generation failed.',
      })),
    artifactGenerationStatus: deriveArtifactGenerationStatus(sectionUnits),
  }
}

export function buildArtifactProgressOutput({
  workspaceId, stage1Id, stage2Id, stage3Id,
  handoff, plan, artifactItem,
  sectionUnits = [],
  artifactBasis = null,
  previousOutput = null,
}) {
  const assembled = assembleArtifactFromSectionUnits(sectionUnits)
  const contentSections = assembled.contentSections
  const qualityAudit = contentSections.length
    ? auditArtifactOutput({ contentSections, artifactBasis })
    : null
  return {
    ...buildArtifactOutput({
      workspaceId, stage1Id, stage2Id, stage3Id,
      handoff, plan, artifactItem,
      contentSections,
      evidenceBasis: `Generated section-by-section from ${artifactBasis?.counts?.mappedHowOptions || 0} mapped how option(s).`,
      assumptions: artifactBasis?.basisWarnings || [],
      openQuestions: [],
      artifactBasis,
      qualityAudit,
      sectionUnits,
      artifactGenerationStatus: assembled.artifactGenerationStatus,
    }),
    previousAcceptedOutput: previousOutput?.artifactGenerationStatus === 'generated' || previousOutput?.generationStatus === OUTPUT_STATUS.GENERATED
      ? {
          contentSections: previousOutput.contentSections || [],
          persistedAt: previousOutput.persistedAt || null,
          artifactGenerationStatus: previousOutput.artifactGenerationStatus || previousOutput.generationStatus || null,
        }
      : previousOutput?.previousAcceptedOutput || null,
  }
}

export function mergeArtifactSectionResults(existingSections = [], sectionResults = []) {
  const byId = new Map((existingSections || []).map(section => [section.sectionId, section]))
  const failedSections = []
  ;(sectionResults || []).forEach(result => {
    if (!result?.sectionId) return
    if (result.status === 'failed' || result.status === 'truncated' || result.error) {
      failedSections.push({
        sectionId: result.sectionId,
        status: result.status || 'failed',
        error: result.error || 'Section generation failed.',
      })
      return
    }
    if (result.section) byId.set(result.sectionId, result.section)
  })
  return {
    contentSections: Array.from(byId.values()),
    failedSections,
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

// ── Quality review ─────────────────────────────────────────────────────────────

/**
 * Persists a quality review onto an existing artifact output record.
 *
 * INVARIANT: generated content (contentSections, evidenceBasis, assumptions,
 * openQuestions, persistedAt, generatedAt, sourceAtomIds) is NEVER modified.
 * Only review fields are written.
 *
 * @param {object} currentOutput  verified artifact output loaded from IDB
 * @param {object} reviewData     { reviewStatus, reviewDimensions, improvementNotes }
 * @returns {Promise<{ ok, record }>}
 */
export async function saveArtifactReview(currentOutput, reviewData, workspaceId, stage1Id, stage2Id, stage3Id) {
  if (!currentOutput?.artifactId) return { ok: false, record: currentOutput }
  const key = stage4ArtifactOutputKey(workspaceId, stage1Id, stage2Id, stage3Id, currentOutput.artifactId)
  const now = new Date().toISOString()

  // Merge review fields only — generated content fields are spread from currentOutput unchanged
  const updated = {
    ...currentOutput,
    reviewStatus:     reviewData.reviewStatus     ?? currentOutput.reviewStatus     ?? REVIEW_STATUS.NOT_REVIEWED,
    reviewDimensions: reviewData.reviewDimensions ?? currentOutput.reviewDimensions ?? {},
    improvementNotes: reviewData.improvementNotes ?? currentOutput.improvementNotes ?? '',
    reviewedAt:       currentOutput.reviewedAt || now,
    reviewUpdatedAt:  now,
    updatedAt:        now,
    // ── these fields are explicitly preserved and never overwritten by a review ──
    contentSections:  currentOutput.contentSections,
    evidenceBasis:    currentOutput.evidenceBasis,
    assumptions:      currentOutput.assumptions,
    openQuestions:    currentOutput.openQuestions,
    persistedAt:      currentOutput.persistedAt,
    generatedAt:      currentOutput.generatedAt,
    sourceAtomIds:    currentOutput.sourceAtomIds,
  }

  const ok = await writeArtifact(key, updated)
  return { ok, record: ok ? updated : currentOutput }
}
