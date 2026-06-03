/**
 * Stage 5 learning signal collection and persistence.
 *
 * Reads from durable Stage 1–4 records and normalises into the canonical
 * signal schema Stage 5 synthesis will consume.  All collection functions
 * are pure (no IDB calls) so they can be tested in isolation.
 *
 * Canonical signal schema:
 * {
 *   stageId:          '1' | '2' | '3' | '4'
 *   signalType:       snake_case string (see SIGNAL_TYPES)
 *   sourceArtifactId: string | null   — artifact ID for Stage 4 signals
 *   sourceContext:    string | null   — BU name, revision label, section id, etc.
 *   summary:          string          — the observation (45+ chars)
 *   impact:           string          — downstream significance
 *   createdAt:        ISO string
 * }
 *
 * Storage key: bsp_v1_stage5_learning_signals_{workspaceId}_{s1}_{s2}_{s3}
 * Store: stage5_learning_signals (IDB-primary, LS pointer)
 *
 * Stage 5 synthesis MUST NOT be called here.
 * These functions only collect, normalise, and persist.
 */

import { readArtifactFromIdb, writeArtifact } from './storageRouter'

// ── Signal type registry ───────────────────────────────────────────────────────

export const SIGNAL_TYPES = {
  // Stage 1
  REFINEMENT_CORRECTION:    'refinement_correction',
  ASSUMPTION_SHIFT:         'assumption_shift',
  EVIDENCE_GAP:             'evidence_gap',
  SCOPE_CLARIFICATION:      'scope_clarification',
  STAGE_BOUNDARY_LESSON:    'stage_boundary_lesson',
  SME_VALIDATION_NEED:      'sme_validation_need',
  FAILURE_MODE:             'failure_mode',

  // Stage 2
  BU_SELECTION_DECISION:    'bu_selection_decision',
  STRUCTURAL_CHANGE:        'structural_change',
  DEPENDENCY_CHANGE:        'dependency_change',
  MAPPING_CORRECTION:       'mapping_correction',

  // Stage 3
  ATOM_GENERATION_FAILED:   'atom_generation_failed',
  HANDOFF_PARTIAL:          'handoff_partial',
  EXECUTION_GAP:            'execution_gap',
  READINESS_ISSUE:          'readiness_issue',
  PLAN_REFINEMENT:          'plan_refinement',

  // Stage 4
  QUALITY_REDUNDANCY:       'quality_redundancy_detected',
  QUALITY_COVERAGE_GAP:     'quality_coverage_gap',
  QUALITY_VERBATIM_COPY:    'quality_verbatim_copy_detected',
  QUALITY_GENERIC_LANGUAGE: 'quality_generic_language',
  QUALITY_INCOMPLETE:       'quality_incomplete_content',
  ARTIFACT_STRONG:          'artifact_strong_quality',
  ARTIFACT_NEEDS_REVISION:  'artifact_needs_revision',
  GENERATION_PARTIAL:       'generation_partial',
  GENERATOR_MISSING:        'generator_missing',
}

const SIGNAL_IMPACTS = {
  refinement_correction:        'User correction indicates a prompt or framing gap; revisit generation instructions before the next iteration.',
  assumption_shift:             'Changed assumption propagates to downstream stages; verify nothing inherited from this stage is now stale.',
  evidence_gap:                 'Unresolved gap carries forward and may block delivery assumptions if not resolved before execution.',
  scope_clarification:          'Scope boundary decision constrains downstream deliverable selection and artifact coverage.',
  stage_boundary_lesson:        'Cross-stage interpretation issue informs handoff quality; tighten the basis passed between stages.',
  sme_validation_need:          'Requires specialist validation before this assumption can be treated as confirmed in execution planning.',
  failure_mode:                 'Identified failure mode should inform risk controls and contingency planning in Stage 3–4.',
  bu_selection_decision:        'BU selection or mapping decision shapes the scope and coverage of all downstream execution planning.',
  structural_change:            'Structural org change may cascade to execution responsibilities; check for stale ownership assumptions.',
  dependency_change:            'Dependency shift requires cross-BU coordination to be re-established in the execution stage.',
  mapping_correction:           'Mapping correction improves basis quality; downstream stages that inherited this mapping should be reviewed.',
  atom_generation_failed:       'Atom failure reduces plan completeness; the affected area may require manual input or re-generation.',
  handoff_partial:              'Partial BU handoff means Stage 4 artifact basis is incomplete; generated artifacts will be partial.',
  execution_gap:                'Execution gap may surface as unresolved risk or dependency in Stage 4 delivery planning.',
  readiness_issue:              'Readiness issue may block artifact generation or delivery commitment for the affected BU.',
  plan_refinement:              'Plan refinement changes execution assumptions; downstream Stage 4 artifacts may need regeneration.',
  quality_redundancy_detected:  'Redundant language reduces SME reviewability; atom generation prompts should enforce role-distinctiveness.',
  quality_coverage_gap:         'A mapped tactic was omitted from the artifact; atom generation coverage should be audited.',
  quality_verbatim_copy_detected:'Verbatim copy from Stage 3 reduces artifact traceability; generation prompts should strengthen the no-copy constraint.',
  quality_generic_language:     'Generic filler language detected; generation prompts should demand named owners, gates, and specific evidence.',
  quality_incomplete_content:   'Incomplete content means the artifact section requires regeneration or manual completion before SME review.',
  artifact_strong_quality:      'High-quality artifact provides a proven generation pattern to replicate across similar artifact types.',
  artifact_needs_revision:      'Artifact requires revision; the quality dimensions flagged should inform prompt tuning.',
  generation_partial:           'Partial generation means some sections are missing; atom-level retry recovered what it could.',
  generator_missing:            'Artifact type has no generator; must be created manually or added to the generation pipeline.',
}

// ── Existing signal format → canonical type mapping ────────────────────────────

const CATEGORY_TO_SIGNAL_TYPE = {
  'Refinement patterns':    SIGNAL_TYPES.REFINEMENT_CORRECTION,
  'Stage-boundary lessons': SIGNAL_TYPES.STAGE_BOUNDARY_LESSON,
  'Assumption shifts':      SIGNAL_TYPES.ASSUMPTION_SHIFT,
  'SME validation needs':   SIGNAL_TYPES.SME_VALIDATION_NEED,
  'Downstream implications':SIGNAL_TYPES.STAGE_BOUNDARY_LESSON,
  'Evidence gaps':          SIGNAL_TYPES.EVIDENCE_GAP,
  'Failure modes':          SIGNAL_TYPES.FAILURE_MODE,
}

const AUDIT_FINDING_TO_SIGNAL_TYPE = {
  repeated_section_language: SIGNAL_TYPES.QUALITY_REDUNDANCY,
  missing_mapped_tactic:     SIGNAL_TYPES.QUALITY_COVERAGE_GAP,
  copied_stage3_prose:       SIGNAL_TYPES.QUALITY_VERBATIM_COPY,
  unmapped_tactic_included:  SIGNAL_TYPES.QUALITY_COVERAGE_GAP,
  generic_consultant_filler: SIGNAL_TYPES.QUALITY_GENERIC_LANGUAGE,
  incomplete_section:        SIGNAL_TYPES.QUALITY_INCOMPLETE,
  incomplete_child:          SIGNAL_TYPES.QUALITY_INCOMPLETE,
  missing_required_fields:   SIGNAL_TYPES.QUALITY_INCOMPLETE,
  excessive_prose:           SIGNAL_TYPES.QUALITY_GENERIC_LANGUAGE,
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const LEARNING_SIGNALS_VERSION = 1

function safeText(v) {
  return typeof v === 'string' ? v.trim() : ''
}

function impactFor(signalType) {
  return SIGNAL_IMPACTS[signalType] || 'Informs Stage 5 synthesis of cross-stage patterns and prompt improvements.'
}

function makeSignal({ stageId, signalType, sourceArtifactId = null, sourceContext = null, summary, createdAt }) {
  if (!summary || summary.length < 20) return null
  return {
    stageId,
    signalType,
    sourceArtifactId: sourceArtifactId || null,
    sourceContext:    sourceContext    || null,
    summary:          safeText(summary),
    impact:           impactFor(signalType),
    createdAt:        createdAt || new Date().toISOString(),
  }
}

function dedupeSignals(signals) {
  const seen = new Set()
  return signals.filter(Boolean).filter(s => {
    const key = `${s.stageId}|${s.signalType}|${s.sourceArtifactId || ''}|${(s.summary || '').slice(0, 80).toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ── Stage 1 collector ──────────────────────────────────────────────────────────

/**
 * Collect Stage 1 learning signals from plan revision records.
 * Reads from plan.stageRevisions.stage1[].learningSignals[].
 *
 * @param {object} plan   — the active plan object (stageRevisions.stage1 array)
 * @returns {Array}       — canonical signal records
 */
export function collectStage1Signals(plan) {
  const revisions = plan?.stageRevisions?.stage1 || []
  const signals = []

  for (const revision of revisions) {
    const revContext = `stage1:${revision.label || `rev_${revision.revisionNumber}`}`
    const ts = revision.createdAt || new Date().toISOString()

    for (const raw of revision.learningSignals || []) {
      const signalType = CATEGORY_TO_SIGNAL_TYPE[raw.category] || SIGNAL_TYPES.STAGE_BOUNDARY_LESSON
      signals.push(makeSignal({
        stageId:      '1',
        signalType,
        sourceContext: revContext,
        summary:       safeText(raw.text),
        createdAt:     ts,
      }))
    }

    // Derive additional signal from unresolved questions in the snapshot
    const snapshot = revision.contentSnapshot || {}
    if (Array.isArray(snapshot.unresolvedQuestions) && snapshot.unresolvedQuestions.length > 0) {
      signals.push(makeSignal({
        stageId:      '1',
        signalType:   SIGNAL_TYPES.EVIDENCE_GAP,
        sourceContext: revContext,
        summary:      `${snapshot.unresolvedQuestions.length} unresolved question(s) carried forward from ${revision.label || 'Stage 1 revision'}: ${snapshot.unresolvedQuestions.slice(0, 2).join('; ')}`,
        createdAt:    ts,
      }))
    }
  }

  return dedupeSignals(signals)
}

// ── Stage 2 collector ──────────────────────────────────────────────────────────

/**
 * Collect Stage 2 learning signals from plan revision records.
 * Reads learningSignals[] and derives additional signals from structural metadata.
 *
 * @param {object} plan — the active plan object (stageRevisions.stage2 array)
 * @returns {Array}     — canonical signal records
 */
export function collectStage2Signals(plan) {
  const revisions = plan?.stageRevisions?.stage2 || []
  const signals = []

  for (const revision of revisions) {
    const revContext = `stage2:${revision.affectedUnit || revision.label || `rev_${revision.revisionNumber}`}`
    const ts = revision.createdAt || new Date().toISOString()

    for (const raw of revision.learningSignals || []) {
      const signalType = CATEGORY_TO_SIGNAL_TYPE[raw.category] || SIGNAL_TYPES.MAPPING_CORRECTION
      signals.push(makeSignal({
        stageId:      '2',
        signalType,
        sourceContext: revContext,
        summary:       safeText(raw.text),
        createdAt:     ts,
      }))
    }

    // Structural impact → dedicated signal
    if (revision.structuralImpact && revision.structuralImpact !== 'none') {
      const impactMap = {
        unit_added:           SIGNAL_TYPES.BU_SELECTION_DECISION,
        unit_removed:         SIGNAL_TYPES.BU_SELECTION_DECISION,
        unit_merged:          SIGNAL_TYPES.STRUCTURAL_CHANGE,
        ownership_changed:    SIGNAL_TYPES.STRUCTURAL_CHANGE,
        dependencies_changed: SIGNAL_TYPES.DEPENDENCY_CHANGE,
      }
      const signalType = impactMap[revision.structuralImpact] || SIGNAL_TYPES.STRUCTURAL_CHANGE
      signals.push(makeSignal({
        stageId:      '2',
        signalType,
        sourceContext: revContext,
        summary:      `Stage 2 structural change "${revision.structuralImpact}" applied${revision.affectedUnit ? ` to "${revision.affectedUnit}"` : ''}. ${safeText(revision.impactSummary)}`,
        createdAt:    ts,
      }))
    }

    // Refinement classification → scope clarification signal
    if (revision.refinementClassification && revision.refinementType === 'unit' && revision.affectedUnit) {
      signals.push(makeSignal({
        stageId:      '2',
        signalType:   SIGNAL_TYPES.SCOPE_CLARIFICATION,
        sourceContext: revContext,
        summary:      `Targeted BU refinement on "${revision.affectedUnit}" classified as "${revision.refinementClassification}"; execution assumptions for this BU may have changed.`,
        createdAt:    ts,
      }))
    }
  }

  return dedupeSignals(signals)
}

// ── Stage 3 collector ──────────────────────────────────────────────────────────

/**
 * Collect Stage 3 learning signals from plan revisions AND per-BU IDB records.
 *
 * @param {object}   plan             — active plan (stageRevisions.stage3)
 * @param {Array}    buPlanRecords    — array of per-BU IDB records loaded from stage3_bu_plans
 * @returns {Array}                  — canonical signal records
 */
export function collectStage3Signals(plan, buPlanRecords = []) {
  const revisions = plan?.stageRevisions?.stage3 || []
  const signals = []

  // ── From revision learning signals ───────────────────────────────────────────
  for (const revision of revisions) {
    const revContext = `stage3:${revision.affectedUnit || revision.label || `rev_${revision.revisionNumber}`}`
    const ts = revision.createdAt || new Date().toISOString()

    for (const raw of revision.learningSignals || []) {
      const signalType = CATEGORY_TO_SIGNAL_TYPE[raw.category] || SIGNAL_TYPES.PLAN_REFINEMENT
      signals.push(makeSignal({
        stageId:      '3',
        signalType,
        sourceContext: revContext,
        summary:       safeText(raw.text),
        createdAt:     ts,
      }))
    }

    // Structural impact on Stage 3
    if (revision.structuralImpact && revision.structuralImpact !== 'none') {
      signals.push(makeSignal({
        stageId:      '3',
        signalType:   SIGNAL_TYPES.PLAN_REFINEMENT,
        sourceContext: revContext,
        summary:      `Stage 3 structural change "${revision.structuralImpact}"${revision.affectedUnit ? ` on "${revision.affectedUnit}"` : ''}: ${safeText(revision.impactSummary)}`,
        createdAt:    ts,
      }))
    }
  }

  // ── From per-BU IDB records (atom-level signals) ──────────────────────────────
  for (const record of buPlanRecords) {
    const buName = record.buName || record.plan?.buName || 'unknown BU'
    const ts     = record.persistedAt || new Date().toISOString()

    // Partial handoff signal
    if (record.lifecycle?.status === 'partial_draft') {
      const completed = record.atomSummary ? (/(\d+)\/(\d+)/.exec(record.atomSummary) || [])[0] : null
      signals.push(makeSignal({
        stageId:      '3',
        signalType:   SIGNAL_TYPES.HANDOFF_PARTIAL,
        sourceContext: buName,
        summary:      `BU "${buName}" handoff is partial${completed ? ` (${completed} atoms complete)` : ''}. Stage 4 artifact basis for this BU will be incomplete until atoms are regenerated.`,
        createdAt:    ts,
      }))
    }

    // Failed atom signals (one signal per distinct failure status, not per atom, to avoid noise)
    const failedAtoms = (record.executionAtoms || []).filter(a =>
      a.status && !['complete', 'accepted'].includes(a.status)
    )
    if (failedAtoms.length > 0) {
      const byStatus = {}
      for (const atom of failedAtoms) {
        byStatus[atom.status] = (byStatus[atom.status] || 0) + 1
      }
      for (const [status, count] of Object.entries(byStatus)) {
        signals.push(makeSignal({
          stageId:      '3',
          signalType:   SIGNAL_TYPES.ATOM_GENERATION_FAILED,
          sourceContext: `${buName}:${status}`,
          summary:      `${count} atom(s) in "${buName}" failed with status "${status}". Affected atom types may require prompt tuning or manual completion.`,
          createdAt:    ts,
        }))
      }
    }
  }

  return dedupeSignals(signals)
}

// ── Stage 4 collector ──────────────────────────────────────────────────────────

/**
 * Derive Stage 4 learning signals from artifact output records.
 * Stage 4 has no explicit learningSignals[] field; signals are derived from
 * qualityAudit findings, generation status, and user review data.
 *
 * @param {Array|object} artifactOutputs — array of output records, or { [id]: record } map
 * @returns {Array}                      — canonical signal records
 */
export function collectStage4Signals(artifactOutputs) {
  const outputs = Array.isArray(artifactOutputs)
    ? artifactOutputs
    : Object.values(artifactOutputs || {})
  const signals = []

  for (const output of outputs) {
    if (!output?.artifactId) continue

    const artifactId = output.artifactId
    const title      = output.title || artifactId
    const ts         = output.qualityAudit?.checkedAt || output.persistedAt || new Date().toISOString()

    // Quality audit findings → one signal per distinct finding type
    const seenFindingTypes = new Set()
    for (const finding of output.qualityAudit?.findings || []) {
      const signalType = AUDIT_FINDING_TO_SIGNAL_TYPE[finding.type]
      if (!signalType || seenFindingTypes.has(signalType)) continue
      seenFindingTypes.add(signalType)
      signals.push(makeSignal({
        stageId:         '4',
        signalType,
        sourceArtifactId: artifactId,
        sourceContext:   `${title}:${finding.severity}`,
        summary:         `Artifact "${title}" — ${finding.detail}`,
        createdAt:       ts,
      }))
    }

    // Generation status: partial
    if (output.generationStatus === 'partial' || output.artifactGenerationStatus === 'partial') {
      signals.push(makeSignal({
        stageId:         '4',
        signalType:      SIGNAL_TYPES.GENERATION_PARTIAL,
        sourceArtifactId: artifactId,
        sourceContext:   title,
        summary:         `Artifact "${title}" completed with partial generation — some sections or atoms failed and could not be assembled into the final output.`,
        createdAt:       ts,
      }))
    }

    // User review: strong or needs_revision (not_reviewed and usable carry no signal)
    const reviewTs = output.reviewUpdatedAt || output.reviewedAt || output.updatedAt || ts
    if (output.reviewStatus === 'strong') {
      signals.push(makeSignal({
        stageId:         '4',
        signalType:      SIGNAL_TYPES.ARTIFACT_STRONG,
        sourceArtifactId: artifactId,
        sourceContext:   title,
        summary:         `Artifact "${title}" rated strong by reviewer. Generation pattern for this artifact type is working well and can be used as a quality reference.`,
        createdAt:       reviewTs,
      }))
    } else if (output.reviewStatus === 'needs_revision') {
      const noteText = safeText(output.improvementNotes)
      signals.push(makeSignal({
        stageId:         '4',
        signalType:      SIGNAL_TYPES.ARTIFACT_NEEDS_REVISION,
        sourceArtifactId: artifactId,
        sourceContext:   title,
        summary:         `Artifact "${title}" flagged as needing revision.${noteText ? ` Notes: ${noteText.slice(0, 120)}` : ''}`,
        createdAt:       reviewTs,
      }))
    }

    // Review dimension-level signals: flag any dimension rated 1 or 2 (low)
    for (const [dim, val] of Object.entries(output.reviewDimensions || {})) {
      const rating = typeof val === 'object' ? val?.rating : val
      if (typeof rating === 'number' && rating <= 2) {
        signals.push(makeSignal({
          stageId:         '4',
          signalType:      SIGNAL_TYPES.ARTIFACT_NEEDS_REVISION,
          sourceArtifactId: artifactId,
          sourceContext:   `${title}:${dim}`,
          summary:         `Artifact "${title}" review dimension "${dim}" rated ${rating}/5${val?.comment ? `: ${String(val.comment).slice(0, 100)}` : ''}.`,
          createdAt:       reviewTs,
        }))
      }
    }
  }

  return dedupeSignals(signals)
}

// ── Compile all stages ─────────────────────────────────────────────────────────

/**
 * Compile all Stage 1–4 learning signals into a single canonical record.
 * Pure function — no IDB calls.
 *
 * @param {object} opts
 * @param {object}  opts.plan               — active plan with stageRevisions
 * @param {Array}   opts.stage3BuPlanRecords — per-BU IDB records from stage3_bu_plans
 * @param {Array|object} opts.stage4ArtifactOutputs — artifact output records
 * @returns {object} — { version, signals[], counts, compiledAt }
 */
export function compileStage5LearningSignals({ plan, stage3BuPlanRecords = [], stage4ArtifactOutputs = [] }) {
  const s1 = collectStage1Signals(plan)
  const s2 = collectStage2Signals(plan)
  const s3 = collectStage3Signals(plan, stage3BuPlanRecords)
  const s4 = collectStage4Signals(stage4ArtifactOutputs)
  const signals = dedupeSignals([...s1, ...s2, ...s3, ...s4])

  return {
    version:    LEARNING_SIGNALS_VERSION,
    signals,
    counts: {
      stage1: s1.length,
      stage2: s2.length,
      stage3: s3.length,
      stage4: s4.length,
      total:  signals.length,
    },
    compiledAt: new Date().toISOString(),
  }
}

// ── Storage key ────────────────────────────────────────────────────────────────

export function stage5LearningSignalsKey(workspaceId, stage1Id, stage2Id, stage3Id) {
  return `bsp_v1_stage5_learning_signals_${workspaceId}_${stage1Id}_${stage2Id}_${stage3Id}`
}

// ── Persistence ────────────────────────────────────────────────────────────────

/**
 * Write the compiled learning signals record to IDB.
 * Returns { ok, key, record }.
 */
export async function persistStage5LearningSignals(record, workspaceId, stage1Id, stage2Id, stage3Id) {
  const key     = stage5LearningSignalsKey(workspaceId, stage1Id, stage2Id, stage3Id)
  const toWrite = { ...record, persistedAt: new Date().toISOString() }
  const ok      = await writeArtifact(key, toWrite)
  return { ok, key, record: ok ? toWrite : record }
}

/**
 * Read the compiled learning signals record from IDB.
 * Returns null when absent or version-mismatched.
 */
export async function loadStage5LearningSignals(workspaceId, stage1Id, stage2Id, stage3Id) {
  const key = stage5LearningSignalsKey(workspaceId, stage1Id, stage2Id, stage3Id)
  try {
    const record = await readArtifactFromIdb(key)
    if (!record || record.version !== LEARNING_SIGNALS_VERSION) return null
    return record
  } catch {
    return null
  }
}

// ── Diagnostic ────────────────────────────────────────────────────────────────

/**
 * Returns a plain-object diagnostic report from a compiled signals record.
 * Safe to call with null — returns zeroed counts.
 *
 * Report shape:
 * {
 *   stage1: { count, types: {signalType: count} }
 *   stage2: { count, types: {...} }
 *   stage3: { count, types: {...} }
 *   stage4: { count, types: {...} }
 *   total:  number
 *   allTypes: {signalType: totalCount}
 *   readyForStage5: boolean   — true when all 4 stages have at least one signal
 * }
 */
export function diagnoseStage5LearningSignals(record) {
  const signals = record?.signals || []
  const byStage = { '1': {}, '2': {}, '3': {}, '4': {} }
  const allTypes = {}

  for (const s of signals) {
    const bucket = byStage[s.stageId] || {}
    bucket[s.signalType] = (bucket[s.signalType] || 0) + 1
    byStage[s.stageId] = bucket
    allTypes[s.signalType] = (allTypes[s.signalType] || 0) + 1
  }

  const counts = { '1': 0, '2': 0, '3': 0, '4': 0 }
  for (const s of signals) counts[s.stageId] = (counts[s.stageId] || 0) + 1

  return {
    stage1: { count: counts['1'], types: byStage['1'] },
    stage2: { count: counts['2'], types: byStage['2'] },
    stage3: { count: counts['3'], types: byStage['3'] },
    stage4: { count: counts['4'], types: byStage['4'] },
    total:  signals.length,
    allTypes,
    readyForStage5: counts['1'] > 0 && counts['2'] > 0 && counts['3'] > 0 && counts['4'] > 0,
    compiledAt: record?.compiledAt || null,
    persistedAt: record?.persistedAt || null,
  }
}

/**
 * Print a one-line console summary for dev-mode diagnostics.
 * Call from App startup or Stage 4 completion to confirm signal capture.
 */
export function logSignalDiagnostic(record) {
  const d = diagnoseStage5LearningSignals(record)
  const parts = [
    `S1:${d.stage1.count}`,
    `S2:${d.stage2.count}`,
    `S3:${d.stage3.count}`,
    `S4:${d.stage4.count}`,
    `total:${d.total}`,
    d.readyForStage5 ? '✓ ready-for-stage5' : '✗ missing signals',
  ]
  // eslint-disable-next-line no-console
  console.info('[Stage5LearningSignals]', parts.join(' | '))
}
