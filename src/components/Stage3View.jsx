// Stage 3 — Business Unit Execution Planning
// Translates active Stage 1 strategy + Stage 2 BU mapping into per-BU execution plans.
//
// Revision architecture mirrors Stage 2:
//   Unit-level  — localised refinement inside each BU card; regenerates one plan,
//                 merges back into full snapshot, saves new Stage 3 revision.
//   Stage-level — bottom RefinementPanel for cross-BU / org-wide changes.
//
// Staleness: Stage 3 is stale when its sourceBasisRevisionId ≠ stage1ActiveId
//            OR its sourceStage2RevisionId ≠ stage2ActiveId.
//
// Revision history remains strictly stage-level — no nested unit histories.

import React, { useState, useCallback, useEffect, useRef } from 'react'
import { hasApiKey, callAI, getApiMode, AI_MODEL_LABEL } from '../api/aiClient'
import {
  generateMockStage3,
  buildBUStructureMessages,
  parseBUStructureResponse,
  buildBUSectionMessages,
  parseBUSectionResponse,
  assembleBUPlan,
  buildStage3ExecutionAtomMessages,
  parseStage3ExecutionAtomResponse,
  buildStage3CoordinationSynthesisMessages,
  parseStage3CoordinationSynthesisResponse,
  buildStage3UnitRefinementMessages,
  parseStage3UnitResponse,
  SECTION_LABELS,
} from '../utils/stage3Prompts'
import { buildStage3RevisionRecord, stage3SnapshotToText } from '../utils/stageSnapshots'
import RevisionHistory    from './RevisionHistory'
import RevisionDiffViewer from './RevisionDiffViewer'
import LearningSignals    from './LearningSignals'
import RefinementPanel                    from './RefinementPanel'
import { REFINEMENT_SCOPES }             from './Stage2View'
import { deriveLearningSignals, buildLearningSignalMessages, parseLearningSignalResponse, normalizeLearningSignals } from '../utils/learningSignals'
import { ATOM_STATUSES, createGenerationAtom, summarizeAtoms } from '../utils/generationAtoms'
import { runGenerationQueue } from '../utils/generationQueue'
import { stage3ExecutiveLeadershipFixture } from '../fixtures/stage3ExecutiveLeadershipFixture'

// ── Indicator helpers ─────────────────────────────────────────────────────────

const RISK_COLORS = {
  low:    '#00e5b4',
  medium: '#fb923c',
  high:   '#f87171',
}
const READINESS_COLORS = {
  low:    '#f87171',
  medium: '#fb923c',
  high:   '#00e5b4',
}

const STAGE3_QUEUE_DELAY_MS = 850
const STAGE3_DRAFT_PLAN_VERSION = 1
const EXECUTIVE_TRACE_PATTERN = /executive leadership|strategic governance|executive/i
const DEBUG_STAGE3_TRACE = import.meta.env?.VITE_STAGE3_TRACE === 'true'
const USE_STAGE3_EXECUTIVE_FIXTURE = import.meta.env?.VITE_USE_STAGE3_FIXTURE === 'true'
const EXECUTIVE_STAGE3_QUEUE_DELAY_MS = 2500
const EXECUTIVE_STAGE3_RETRY = {
  maxAttempts: 4,
  baseDelayMs: 2500,
  maxDelayMs: 20000,
}
const STAGE3_FAILED_ATOM_STATUSES = new Set([
  ATOM_STATUSES.FAILED,
  ATOM_STATUSES.API_RATE_LIMITED,
])
const STAGE3_RETRYABLE_ATOM_STATUSES = new Set([
  ATOM_STATUSES.FAILED,
  ATOM_STATUSES.API_RATE_LIMITED,
  ATOM_STATUSES.RETRY_PENDING,
  ATOM_STATUSES.STALE,
  ATOM_STATUSES.PENDING,
  ATOM_STATUSES.NOT_STARTED,
])

function riskColor(level)      { return RISK_COLORS[level]     || '#fb923c' }
function readyColor(level)     { return READINESS_COLORS[level] || '#fb923c' }

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isRateLimitedAIResponse(response) {
  const error = response?.error || ''
  return !!(response?.rateLimited || response?.status === 429 || /429|rate.?limit|rate_limit/i.test(error))
}

function storageSafeName(name) {
  return String(name || 'unnamed').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 90)
}

function stage2HandoffDraftKey(workspaceId, buName) {
  return workspaceId ? `bsp_v1_handoff_${workspaceId}_${buName}` : null
}

function stage3BuPlanDraftKey(workspaceId, stage1Id, stage2Id, buName) {
  if (!workspaceId || !stage1Id || !stage2Id || !buName) return null
  return `bsp_v1_stage3_bu_plan_${workspaceId}_${stage1Id}_${stage2Id}_${storageSafeName(buName)}`
}

function stage3CoordinationDraftKey(workspaceId, stage1Id, stage2Id) {
  if (!workspaceId || !stage1Id || !stage2Id) return null
  return `bsp_v1_stage3_coordination_${workspaceId}_${stage1Id}_${stage2Id}`
}

function readJsonStorage(key) {
  if (!key || typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeJsonStorage(key, value) {
  if (!key || typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {}
}

function valueToSearchText(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(valueToSearchText).join(' ')
  if (typeof value === 'object') return Object.values(value).map(valueToSearchText).join(' ')
  return String(value)
}

function stage3TraceHash(value) {
  const text = JSON.stringify(value || {})
  let hash = 0
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

function isExecutiveTraceUnit(unit) {
  return EXECUTIVE_TRACE_PATTERN.test(unit?.name || unit?.buName || '')
}

function logExecutiveBoundary(unit, label, value) {
  if (!DEBUG_STAGE3_TRACE) return
  if (!isExecutiveTraceUnit(unit)) return
  console.groupCollapsed(`[Stage3 Executive Boundary Trace] ${label}`)
  console.log(value)
  console.groupEnd()
}

function listFromValue(value) {
  if (!value) return []
  if (Array.isArray(value)) {
    return value.map(v => {
      if (typeof v === 'string') return v
      if (v?.name || v?.label || v?.title) {
        return [v.name || v.label || v.title, v.purpose, v.whyThisSectionMatters, v.SMEReviewFocus]
          .filter(Boolean)
          .join(' - ')
      }
      return valueToSearchText(v)
    }).filter(Boolean)
  }
  if (typeof value === 'string') return value ? [value] : []
  return valueToSearchText(value) ? [valueToSearchText(value)] : []
}

function byteSize(value) {
  try {
    return new Blob([JSON.stringify(value || {})]).size
  } catch {
    return valueToSearchText(value).length
  }
}

function compactHandoffText(value) {
  const text = valueToSearchText(value).replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const sentence = text.match(/^.{1,280}?[.!?](\s|$)/)?.[0]?.trim()
  return sentence || (text.length > 280 ? `${text.slice(0, 277).trim()}...` : text)
}

function compactArray(values, maxItems = 6) {
  return listFromValue(values).map(compactHandoffText).filter(Boolean).slice(0, maxItems)
}

function handoffItemTitle(key, state = {}, idx = 0) {
  const parsed = state?.parsedValue
  if (parsed?.name || parsed?.label || parsed?.title) return parsed.name || parsed.label || parsed.title
  return state?.label || key || `handoff-section-${idx + 1}`
}

function createStage2ToStage3HandoffBrief(unit, draft) {
  const compiled = unit?.stage3PlanningContext || {}
  const parsed = draft?.parsed || {}
  const itemStates = draft?.itemStates || draft?.handoffItems || draft?.generatedItems || {}
  const structureItems = normalizeStructureItems(
    parsed.handoffStructure || draft?.handoffStructure || compiled.handoffStructure || compiled.likelyExecutionSections,
  )
  const itemEntries = Object.entries(itemStates)
  // structureItems are the canonical section labels; itemEntries hold generated content for those
  // same sections. Combining both creates duplicate entries (6 themes + 6 item-state rows = 12).
  // Use structure items when they exist; fall back to item-entry keys only if no structure yet.
  const sourceSectionTitles = (
    structureItems.length
      ? structureItems.map(item => item.label)
      : itemEntries.map(([key, state], idx) => handoffItemTitle(key, state, idx))
  ).filter(Boolean)
  const sourceStage2SectionIds = (
    structureItems.length
      ? structureItems.map(item => item.key)
      : itemEntries.map(([key]) => key)
  ).filter(Boolean)
  const sourceRefs = sourceStage2SectionIds.map((id, idx) => ({
    id,
    title: sourceSectionTitles[idx] || id,
    stage: 2,
    businessUnitName: unit?.name || '',
    pointer: `stage2:${unit?.name || 'unknown'}:${id}`,
  }))
  const textFor = (patterns, maxItems = 6) => {
    const rx = new RegExp(patterns.join('|'), 'i')
    return itemEntries
      .filter(([key, state]) => rx.test(key) || rx.test(valueToSearchText(state?.parsedValue)) || rx.test(valueToSearchText(state?.childAtoms)))
      .flatMap(([, state]) => compactArray(state?.parsedValue || state?.childAtoms, 3))
      .slice(0, maxItems)
  }
  const smeLens = getSmeLensFromDraft(draft, compiled)
  const domainOfWork = parsed.domainOfWork || draft?.domainOfWork || compiled.domainOfWork || ''
  const readinessStatus = draft?.handoffStatus || draft?.buHandoff?.handoffStatus || compiled.handoffStatus || (sourceRefs.length ? 'partial' : 'not_started')
  const now = new Date().toISOString()

  return {
    id: `stage2-stage3-brief:${storageSafeName(unit?.name || 'unknown')}`,
    businessUnitId: unit?.id || unit?.name || null,
    businessUnitName: unit?.name || '',
    sourceStage2SectionIds,
    sourceSectionTitles,
    planningPurpose: compactHandoffText(domainOfWork || unit?.purpose || compiled.domainOfWork),
    decisionBasisSummary: compactHandoffText(
      typeof smeLens === 'string'
        ? smeLens
        : smeLens?.summary || smeLens?.reviewerProfile || unit?.strategicInvolvement || unit?.purpose,
    ),
    keyImplications: compactArray([
      ...(compiled.stage4DeliveryImplications || []),
      ...(compiled.priorRefinementsToPreserve || []),
      ...textFor(['implication', 'outcome', 'decision', 'execution'], 4),
    ], 8),
    executionConstraints: compactArray([
      ...(compiled.constraintsToCarryForward || []),
      ...(unit?.risksAndUnknowns || []),
      ...textFor(['constraint', 'capacity', 'limit'], 4),
    ], 8),
    dependencies: compactArray([
      ...(compiled.criticalDependenciesToExplore || []),
      ...(unit?.dependencies || []),
      ...textFor(['depend', 'coordination', 'handoff', 'input', 'output'], 4),
    ], 8),
    risksOrContradictions: compactArray([
      ...(compiled.riskThemesToExplore || []),
      ...(unit?.risksAndUnknowns || []),
      ...textFor(['risk', 'contradiction', 'tradeoff'], 4),
    ], 8),
    unresolvedQuestions: compactArray([
      ...(compiled.unresolvedQuestionsForStage3 || []),
      ...textFor(['question', 'unknown', 'unresolved'], 4),
    ], 8),
    readinessStatus,
    metadata: {
      isStale: !!(draft?.structureIsStale || draft?.statuses?.structureIsStale || draft?.staleFlags?.structureIsStale),
      sourceDraftVersion: draft?.version || null,
      fullDraftSizeBytes: byteSize(draft),
      briefSizeBytes: 0,
      sourceDetailExcludedFromStage3Generation: true,
    },
    evidenceRefs: sourceRefs,
    createdAt: draft?.createdAt || draft?.lastSavedAt || now,
    updatedAt: draft?.lastSavedAt || draft?.updatedAt || now,
    regeneratedAt: draft?.regeneratedAt || draft?.lastGeneratedAt || null,
  }
}

function finalizeHandoffBrief(brief) {
  return {
    ...brief,
    metadata: {
      ...(brief?.metadata || {}),
      briefSizeBytes: byteSize({ ...brief, metadata: { ...(brief?.metadata || {}), briefSizeBytes: 0 } }),
    },
  }
}

function isMeaningfulStage3Value(value) {
  const text = valueToSearchText(value).trim()
  if (!text) return false
  return !/^(none identified|not specified|n\/a|none|null|undefined)$/i.test(text)
}

function validateExecutiveStage3Atom(section) {
  if (!section || typeof section !== 'object') {
    return { pass: false, reason: 'Parsed section is missing.' }
  }
  if (!isMeaningfulStage3Value(section.sectionName)) {
    return { pass: false, reason: 'Section name is missing.' }
  }
  if (!isMeaningfulStage3Value(section.objective)) {
    return { pass: false, reason: 'Objective is missing.' }
  }
  const evidenceKeys = [
    'executionStrategy',
    'decisionsRequired',
    'sequencingAndGates',
    'dependencies',
    'risks',
    'constraints',
    'unknowns',
    'validationReadinessChecks',
    'ownershipGovernance',
    'successIndicators',
    'failureSignals',
    'stage4DeliveryImplications',
  ]
  const evidenceCount = evidenceKeys.reduce((count, key) => (
    count + listFromValue(section[key]).filter(isMeaningfulStage3Value).length
  ), 0)
  if (evidenceCount < 2) {
    return { pass: false, reason: 'Section lacks concrete execution detail.' }
  }
  return { pass: true, reason: null }
}

function normalizeStructureItems(structure) {
  if (!Array.isArray(structure)) return []
  return structure.map((item, idx) => {
    if (typeof item === 'string') {
      return { key: item.toLowerCase().replace(/[^a-z0-9]+/g, '_'), label: item, text: item, required: true }
    }
    const label = item?.label || item?.name || item?.title || `Handoff item ${idx + 1}`
    return {
      key: item?.key || label.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      label,
      text: valueToSearchText(item),
      required: item?.required !== false,
    }
  })
}

function extractDraftItemStates(draft) {
  const states = draft?.itemStates || draft?.handoffItems || draft?.generatedItems || {}
  return Object.entries(states).map(([key, state], idx) => {
    const parsedValue = state?.parsedValue || draft?.parsedValues?.handoffItems?.[key] || null
    const childAtoms = state?.childAtoms || draft?.childAtoms?.[key] || {}
    const title = handoffItemTitle(key, { ...state, parsedValue }, idx)
    return {
      key,
      label: title,
      status: state?.status || draft?.statuses?.handoffItems?.[key]?.status || 'not_started',
      isStale: !!(state?.isStale || draft?.staleFlags?.handoffItems?.[key]),
      parsedValue: compactHandoffText(parsedValue),
      parserError: state?.parserError || draft?.parserErrors?.handoffItems?.[key]?.parserError || null,
      childAtoms: Object.fromEntries(Object.entries(childAtoms).map(([childKey, child]) => [childKey, {
        status: child?.status || 'not_started',
        parserError: child?.parserError || null,
        parsedValue: compactHandoffText(child?.parsedValue),
      }])),
      text: `${key} ${title} ${compactHandoffText(parsedValue)}`,
      sourceRefId: key,
    }
  })
}

function getSmeLensFromDraft(draft, compiled = {}) {
  return draft?.SMEReviewLens
    || draft?.SMEReviewLensAtom?.parsedValue
    || draft?.smeLensState?.parsedValue
    || draft?.parsedValues?.SMEReviewLens
    || compiled.SMEReviewLens
    || compiled.SMEReviewLensAtom?.parsedValue
    || null
}

function buildPlanningContextFromDraft(unit, draft) {
  const compiled = unit?.stage3PlanningContext || {}
  const parsed = draft?.parsed || {}
  const brief = finalizeHandoffBrief(createStage2ToStage3HandoffBrief(unit, draft))
  const sourceSections = brief.sourceSectionTitles.map((title, idx) => ({
    name: title,
    purpose: brief.keyImplications[idx] || brief.planningPurpose || '',
    whyThisSectionMatters: brief.decisionBasisSummary || title,
    required: true,
    sourceRefId: brief.sourceStage2SectionIds[idx] || null,
  }))
  return {
    handoffBrief: brief,
    stage2ToStage3HandoffBrief: brief,
    domainOfWork: parsed.domainOfWork || draft?.domainOfWork || compiled.domainOfWork || '',
    SMEReviewLens: getSmeLensFromDraft(draft, compiled),
    handoffStructure: sourceSections,
    likelyExecutionSections: compiled.likelyExecutionSections?.length
      ? compiled.likelyExecutionSections
      : sourceSections.map(item => ({
          name: item.name,
          purpose: item.purpose,
          whyThisSectionMatters: item.whyThisSectionMatters,
          required: item.required,
          sourceRefId: item.sourceRefId,
        })),
    criticalDependenciesToExplore: compiled.criticalDependenciesToExplore?.length
      ? compiled.criticalDependenciesToExplore
      : brief.dependencies,
    riskThemesToExplore: compiled.riskThemesToExplore?.length
      ? compiled.riskThemesToExplore
      : brief.risksOrContradictions,
    constraintsToCarryForward: compiled.constraintsToCarryForward?.length
      ? compiled.constraintsToCarryForward
      : brief.executionConstraints,
    unresolvedQuestionsForStage3: compiled.unresolvedQuestionsForStage3?.length
      ? compiled.unresolvedQuestionsForStage3
      : brief.unresolvedQuestions,
    validationNeedsForStage3: compiled.validationNeedsForStage3?.length
      ? compiled.validationNeedsForStage3
      : compactArray([brief.decisionBasisSummary, ...brief.keyImplications], 6),
    stage4DeliveryImplications: compiled.stage4DeliveryImplications?.length
      ? compiled.stage4DeliveryImplications
      : brief.keyImplications,
    priorRefinementsToPreserve: compiled.priorRefinementsToPreserve?.length
      ? compiled.priorRefinementsToPreserve
      : compactArray(draft?.refinementPrompts, 6),
    handoffStatus: brief.readinessStatus,
  }
}

function mergePlansByBuName(savedPlans, draftPlans) {
  const merged = [...(savedPlans || [])]
  for (const plan of draftPlans || []) {
    const idx = merged.findIndex(p => p?.buName === plan?.buName)
    if (idx >= 0) merged[idx] = { ...merged[idx], ...plan }
    else merged.push(plan)
  }
  return merged
}

const READINESS_COLUMNS = [
  {
    key: 'sequencing',
    label: 'Sequencing / Incentives',
    terms: ['sequenc', 'priorit', 'gate', 'incentiv', 'decision', 'milestone', 'path', 'tradeoff'],
    needed: ['priorities', 'decision gates'],
  },
  {
    key: 'risk',
    label: 'Risks / Constraints',
    terms: ['risk', 'constraint', 'unknown', 'question', 'assumption', 'limit', 'exposure'],
    needed: ['risk themes', 'constraints'],
  },
  {
    key: 'measurement',
    label: 'Measurement / Readiness',
    terms: ['metric', 'measure', 'success', 'failure', 'readiness', 'validation', 'evidence', 'indicator'],
    needed: ['validation needs', 'success/failure signals'],
  },
  {
    key: 'dependencies',
    label: 'Cross-functional Dependencies',
    terms: ['depend', 'input', 'output', 'coordination', 'handoff', 'interface', 'partner'],
    needed: ['inputs/outputs', 'coordination needs'],
  },
  {
    key: 'governance',
    label: 'Staffing / Governance',
    terms: ['owner', 'govern', 'decision', 'escalat', 'resource', 'staff', 'capacity', 'authority'],
    needed: ['ownership', 'decision rights'],
  },
  {
    key: 'domain',
    label: 'Domain Execution Lens',
    terms: ['domain', 'sme', 'review', 'lens', 'operational', 'execution'],
    needed: ['domain of work', 'SME lens'],
  },
]

function assessReadinessCell(column, handoff) {
  if (!handoff?.exists) return { status: 'not_started', detail: 'No handoff item generated' }
  if (column.key === 'domain') {
    const missing = []
    if (!handoff.domainOfWork) missing.push('domain of work')
    if (!handoff.smeLens) missing.push('SME lens')
    if (!handoff.structureItems.length) missing.push('handoff structure')
    if (handoff.structureIsStale || handoff.smeLensStale) {
      return { status: 'stale', detail: 'Needs regeneration or confirmation' }
    }
    if (!missing.length) return { status: 'ready', detail: 'SME lens + domain present' }
    return { status: 'partial', detail: `${missing.length === 1 ? 'Needed' : 'Needed'}: ${missing.slice(0, 2).join(', ')}` }
  }

  const rx = new RegExp(column.terms.join('|'), 'i')
  const matchingItems = [
    ...handoff.structureItems.filter(item => rx.test(item.text) || rx.test(item.label)),
    ...handoff.itemStates.filter(item => rx.test(item.key) || rx.test(item.text)),
  ]
  const completeItems = matchingItems.filter(item => item.status === 'complete' || item.parsedValue || Object.keys(item.childAtoms || {}).length)
  const staleItems = matchingItems.filter(item => item.isStale)
  const failedItems = matchingItems.filter(item => item.status === 'failed' || item.parserError)

  if (staleItems.length) return { status: 'stale', detail: 'Needs regeneration or confirmation' }
  if (completeItems.length) {
    const partial = failedItems.length || completeItems.length < matchingItems.length
    return {
      status: partial ? 'partial' : 'ready',
      detail: partial
        ? `${completeItems.length} item${completeItems.length === 1 ? '' : 's'} present; some missing`
        : `${completeItems.length} item${completeItems.length === 1 ? '' : 's'} present`,
    }
  }
  if (matchingItems.length) return { status: 'needed', detail: `Generate ${matchingItems[0].label || matchingItems[0].key}` }
  return { status: 'needed', detail: `Needed: ${column.needed.join(', ')}` }
}

function summarizeHandoffReadiness(bu, draft) {
  const compiled = bu?.stage3PlanningContext || {}
  const parsed = draft?.parsed || {}
  const brief = finalizeHandoffBrief(createStage2ToStage3HandoffBrief(bu, draft))
  const domainOfWork = parsed.domainOfWork || draft?.domainOfWork || compiled.domainOfWork || ''
  const smeLens = getSmeLensFromDraft(draft, compiled)
  const structureItems = brief.sourceSectionTitles.map((title, idx) => ({
    key: brief.sourceStage2SectionIds[idx] || storageSafeName(title),
    label: title,
    text: brief.keyImplications[idx] || brief.planningPurpose || title,
    required: true,
    sourceRefId: brief.sourceStage2SectionIds[idx] || null,
  }))
  const itemStates = extractDraftItemStates(draft)
  const exists = !!(domainOfWork || smeLens || structureItems.length || itemStates.length || draft?.buHandoff || draft?.assembledBuHandoff || Object.keys(compiled).length)
  const handoff = {
    exists,
    domainOfWork,
    smeLens,
    structureItems,
    itemStates,
    structureIsStale: !!(draft?.structureIsStale || draft?.statuses?.structureIsStale || draft?.staleFlags?.structureIsStale),
    smeLensStale: !!(draft?.SMEReviewLensAtom?.isStale || draft?.smeLensState?.isStale || draft?.staleFlags?.SMEReviewLens),
    status: draft?.handoffStatus || draft?.buHandoff?.handoffStatus || compiled.handoffStatus || (exists ? 'partial' : 'not_started'),
    handoffBrief: brief,
  }
  const cells = Object.fromEntries(READINESS_COLUMNS.map(col => [col.key, assessReadinessCell(col, handoff)]))
  const readyCount = Object.values(cells).filter(c => c.status === 'ready').length
  const usableCount = Object.values(cells).filter(c => ['ready', 'partial'].includes(c.status)).length
  const staleCount = Object.values(cells).filter(c => c.status === 'stale').length
  const failedCount = itemStates.filter(item => item.status === 'failed' || item.parserError).length
  const completedItemCount = itemStates.filter(item => (
    item.status === 'complete' ||
    item.status === 'partial' ||
    item.parsedValue ||
    Object.keys(item.childAtoms || {}).length
  )).length
  // Use itemStates as the denominator: completedItemCount is also counted from itemStates,
  // so both numerator and denominator must come from the same source. Fall back to
  // structureItems only when no items have been generated yet.
  const totalItemCount = itemStates.length || structureItems.length
  const completion = !exists
    ? 'none'
    : staleCount || failedCount
      ? 'partial'
      : totalItemCount > 0 && completedItemCount >= totalItemCount && domainOfWork && smeLens
        ? 'full'
        : readyCount >= 5
        ? 'full'
        : usableCount >= 2
          ? 'partial'
          : 'limited'
  return {
    ...handoff,
    cells,
    readyCount,
    usableCount,
    staleCount,
    failedCount,
    completedItemCount,
    totalItemCount,
    completion,
    planMode: completion === 'full' ? 'full' : completion === 'none' ? 'stage1_2_only' : 'limited',
    planningContext: buildPlanningContextFromDraft(bu, draft),
  }
}

function orderBusinessUnitsForStage3(units, stage1Snapshot) {
  const numericOrder = units
    .map((unit, idx) => ({ unit, idx, order: Number(unit?.orgOrder) }))
    .filter(row => Number.isFinite(row.order))
  if (numericOrder.length >= Math.max(2, Math.ceil(units.length * 0.6))) {
    return [...units].sort((a, b) => {
      const ao = Number.isFinite(Number(a?.orgOrder)) ? Number(a.orgOrder) : 999
      const bo = Number.isFinite(Number(b?.orgOrder)) ? Number(b.orgOrder) : 999
      return ao - bo
    })
  }

  const strategyText = valueToSearchText(stage1Snapshot).toLowerCase()
  const scoreUnit = (unit, idx) => {
    const text = valueToSearchText(unit).toLowerCase()
    let score = idx * 3
    if (/executive|leadership|strategy|govern|decision|authority|sponsor/.test(text)) score -= 70
    if (/primary|accountable|owner|driver/.test(unit?.involvementLevel || unit?.strategicInvolvement || '')) score -= 45
    if (/product|architecture|capability|portfolio/.test(text)) score -= 25
    if (/risk|compliance|control|regulatory|audit/.test(text)) score -= /compliance|regulatory|risk|audit/.test(strategyText) ? 35 : 5
    if (/engineering|technology|platform|data|api|infrastructure/.test(text)) score -= 10
    if (/delivery|service|client|advisory|consult/.test(text)) score += 8
    if (/partner|vendor|channel/.test(text)) score += 18
    if (/sales|marketing|gtm|commercial|finance|support/.test(text)) score += 28
    return score
  }
  return [...units].sort((a, b) => scoreUnit(a, units.indexOf(a)) - scoreUnit(b, units.indexOf(b)))
}

function buildExecutionAtomsForBU(unit, readiness, priorDraft, mode) {
  const priorAtoms = priorDraft?.executionAtoms || []
  const priorById = new Map(priorAtoms.map(atom => [atom.id, atom]))
  const sourceItems = readiness.structureItems.map((item, idx) => {
    const match = readiness.itemStates.find(state => (
      state.key === item.key ||
      state.key === String(idx) ||
      state.key === item.label
    ))
    return {
      ...item,
      ...(match || {}),
      elementName: item.label,
      detail: match?.parsedValue ? listFromValue(match.parsedValue).join('; ') : item.text,
    }
  }).filter(item => mode === 'stage1_2_only' || item.parsedValue || item.text || item.status === 'complete')

  const fallbackItems = [
    { key: 'stage1_2_priorities', label: 'Stage 1/2 Execution Priorities', text: 'Draft from Stage 1 strategy and Stage 2 core BU responsibilities.' },
    { key: 'stage1_2_dependencies', label: 'Stage 1/2 Dependencies and Constraints', text: 'Draft dependencies, constraints, and unknowns from Stage 2 core BU data.' },
    { key: 'stage1_2_validation', label: 'Stage 1/2 Validation and Readiness', text: 'Draft validation needs, readiness checks, and success/failure signals from available source data.' },
  ]

  const items = sourceItems.length ? sourceItems : fallbackItems
  return items.map((item, idx) => {
    const id = `stage3:${storageSafeName(unit.name)}:${storageSafeName(item.key || item.label || idx)}`
    return priorById.get(id) || createGenerationAtom({
      id,
      stage: 'stage3',
      phase: 'executionPlanAtom',
      parentId: unit.name,
      businessUnitName: unit.name,
      elementName: item.label || item.elementName || item.key,
      childKey: item.key || String(idx),
      status: ATOM_STATUSES.PENDING,
      metadata: { handoffItem: item, generationMode: mode },
    })
  })
}

function assembleAtomizedBUPlan(unit, readiness, atoms, mode) {
  const completedAtoms = atoms.filter(atom => atom.status === ATOM_STATUSES.COMPLETE && atom.parsedValue)
  const failedAtoms = atoms.filter(atom => STAGE3_FAILED_ATOM_STATUSES.has(atom.status))
  const pendingAtoms = atoms.filter(atom => ![
    ATOM_STATUSES.COMPLETE,
    ...STAGE3_FAILED_ATOM_STATUSES,
  ].includes(atom.status))
  const sections = completedAtoms.map(atom => ({
    ...atom.parsedValue,
    atomId: atom.id,
    sourceHandoffItem: atom.elementName,
  }))
  const flat = key => sections.flatMap(section => section[key] || [])
  const planStatus = failedAtoms.length
    ? (completedAtoms.length ? 'partial' : 'failed')
    : pendingAtoms.length
      ? 'partial'
      : 'complete'

  return {
    buName: unit.name,
    mission: unit.purpose || readiness.planningContext?.domainOfWork || '',
    strategicRole: unit.strategicInvolvement || unit.purpose || '',
    priorityOutcomes: sections.map(section => section.objective).filter(Boolean).slice(0, 5),
    criticalWorkstreams: sections.map(section => section.sectionName).filter(Boolean),
    executionSections: sections,
    missingSections: pendingAtoms.map(atom => atom.elementName),
    failedSections: failedAtoms.map(atom => ({
      name: atom.elementName,
      status: atom.status,
      error: atom.parserError,
      failureLabel: atom.metadata?.failureLabel || null,
    })),
    planStatus,
    generationMode: mode,
    sourceHandoffStatus: readiness.status,
    handoffWarnings: mode === 'full'
      ? []
      : mode === 'stage1_2_only'
        ? ['Generated without Stage 2 handoff context; review assumptions before coordination synthesis.']
        : ['Generated from partial Stage 2 handoff context; missing or stale handoff elements may reduce specificity.'],
    initiativesMissionCritical: flat('executionStrategy').slice(0, 5),
    initiativesOptional: flat('decisionsRequired').slice(0, 4),
    initiativesDeferred: [],
    initiativesBlocked: flat('unknowns').slice(0, 4),
    sequencingNarrative: flat('sequencingAndGates').slice(0, 3).join(' '),
    keyMilestones: flat('sequencingAndGates').slice(0, 4),
    crossFunctionalDependencies: flat('dependencies').slice(0, 6),
    requiredCapabilities: flat('stage4DeliveryImplications').slice(0, 5),
    staffingOwnership: flat('ownershipGovernance').slice(0, 5),
    systemsTools: [],
    governanceCadence: flat('ownershipGovernance').slice(0, 3),
    decisionRights: flat('decisionsRequired').slice(0, 4),
    risks: flat('risks').slice(0, 6),
    constraints: flat('constraints').slice(0, 6),
    unresolvedUnknowns: flat('unknowns').slice(0, 6),
    assumptions: [],
    leadingIndicators: flat('validationReadinessChecks').slice(0, 4),
    keySuccessMetrics: flat('successIndicators').slice(0, 5),
    failureSignals: flat('failureSignals').slice(0, 5),
    readinessAssessment: planStatus === 'complete'
      ? `${unit.name} has a complete atomized execution draft from ${completedAtoms.length} section${completedAtoms.length === 1 ? '' : 's'}.`
      : `${unit.name} has a partial atomized execution draft; ${failedAtoms.length} failed and ${pendingAtoms.length} remain pending.`,
    executionRisk: failedAtoms.length ? 'high' : mode === 'full' ? 'medium' : 'high',
    dependencyComplexity: flat('dependencies').length > 4 ? 'high' : 'medium',
    confidenceLevel: planStatus === 'complete' && mode === 'full' ? 'medium' : 'low',
    organizationalReadiness: planStatus === 'complete' ? 'medium' : 'low',
  }
}

function buildExecutiveLeadershipFixturePlan(unit, readiness) {
  const fixture = JSON.parse(JSON.stringify(stage3ExecutiveLeadershipFixture))
  const planningContext = readiness?.planningContext || unit?.stage3PlanningContext || {}
  const handoffItems = readiness?.structureItems || []
  const activeSourceBasis = {
    businessUnitName: unit?.name || 'Executive Leadership & Strategic Governance',
    stage2Purpose: unit?.purpose || '',
    strategicInvolvement: unit?.strategicInvolvement || '',
    domainOfWork: planningContext.domainOfWork || 'Executive governance, strategic decision authority, resource allocation, and escalation control.',
    SMEReviewLens: planningContext.SMEReviewLens || planningContext.smeReviewLens || null,
    handoffItemNames: handoffItems.map(item => item.label || item.name || item.key).filter(Boolean),
    keyResponsibilities: unit?.keyResponsibilities || [],
    dependencies: unit?.dependencies || [],
    risksAndUnknowns: unit?.risksAndUnknowns || [],
    keySuccessMetrics: unit?.keySuccessMetrics || [],
  }

  return {
    ...fixture,
    buName: unit?.name || 'Executive Leadership & Strategic Governance',
    sourceHandoffStatus: readiness?.status || 'fixture',
    confidenceLevel: readiness?.completion === 'full' ? 'medium' : 'low',
    organizationalReadiness: readiness?.completion === 'full' ? 'medium' : 'low',
    readiness: {
      ...fixture.readiness,
      status: readiness?.completion === 'full' ? 'ready_for_review' : 'draft_from_available_context',
    },
    sourceBasis: {
      ...fixture.sourceBasis,
      activeStage2Context: activeSourceBasis,
    },
  }
}

function buildExecutiveSectionReviewStates(source = 'ai') {
  const base = source === 'fixture'
    ? 'Fixture scaffold for reviewing the cockpit shape.'
    : 'Generated from Stage 2 handoff context; review before treating as accepted.'
  return {
    readiness: { status: 'draft', operatorNote: base, sourceBasis: ['Stage 2 handoff', 'Generated Stage 3 plan'], failureReason: null },
    decisionOwnership: { status: 'draft', operatorNote: base, sourceBasis: ['Decision rights', 'Ownership fields'], failureReason: null },
    executionWorkstreams: { status: 'draft', operatorNote: base, sourceBasis: ['Generated execution sections'], failureReason: null },
    crossFunctionalDependencies: { status: 'draft', operatorNote: base, sourceBasis: ['Generated dependencies'], failureReason: null },
    requiredCapabilities: { status: 'draft', operatorNote: base, sourceBasis: ['Generated capabilities'], failureReason: null },
    staffingAndOwnership: { status: 'draft', operatorNote: base, sourceBasis: ['Generated ownership/governance'], failureReason: null },
    systemsAndTools: { status: 'draft', operatorNote: base, sourceBasis: ['Generated systems/tools'], failureReason: null },
    governanceCadence: { status: 'draft', operatorNote: base, sourceBasis: ['Generated governance cadence'], failureReason: null },
    decisionRights: { status: 'draft', operatorNote: base, sourceBasis: ['Generated decisions required'], failureReason: null },
    riskConstraintUnknownRegister: { status: 'draft', operatorNote: base, sourceBasis: ['Generated risks, constraints, unknowns'], failureReason: null },
    sourceBasis: { status: 'draft', operatorNote: 'Collapsed by default to keep the cockpit usable.', sourceBasis: ['Stage 2 handoff', 'Stage 3 generation state'], failureReason: null },
  }
}

function toExecutiveCockpitPlan(plan) {
  if (plan?.planFormat === 'executive_stage3_fixture_v1') return plan
  const sections = plan?.executionSections || []
  const firstMeaningful = (...values) => values.flat().filter(Boolean)[0] || ''
  const asList = value => listFromValue(value).filter(Boolean)
  const workstreams = sections.length
    ? sections.map((section, idx) => ({
      name: section.sectionName || `Execution workstream ${idx + 1}`,
      objective: section.objective || 'Review generated section objective.',
      accountableOwner: firstMeaningful(section.ownershipGovernance, plan.staffingOwnership, plan.buName),
      dependentFunctions: asList(section.dependencies),
      decisionNeeded: firstMeaningful(section.decisionsRequired, section.sequencingAndGates, 'Review required decision.'),
      riskConstraintUnknown: firstMeaningful(section.risks, section.constraints, section.unknowns, 'Review generated risk, constraint, or unknown.'),
      nextAction: firstMeaningful(section.executionStrategy, section.validationReadinessChecks, 'Review generated execution strategy.'),
      sourceBasis: section.sourceHandoffItem || section.atomId || 'Generated Stage 3 execution atom.',
      reviewStatus: 'draft',
    }))
    : asList(plan?.criticalWorkstreams).map((name, idx) => ({
      name,
      objective: asList(plan?.priorityOutcomes)[idx] || 'Review generated workstream objective.',
      accountableOwner: firstMeaningful(plan?.staffingOwnership, plan?.buName),
      dependentFunctions: asList(plan?.crossFunctionalDependencies),
      decisionNeeded: firstMeaningful(plan?.decisionRights, 'Review required decision.'),
      riskConstraintUnknown: firstMeaningful(plan?.risks, plan?.constraints, plan?.unresolvedUnknowns),
      nextAction: firstMeaningful(plan?.initiativesMissionCritical, plan?.initiativesOptional),
      sourceBasis: 'Generated Stage 3 plan fields.',
      reviewStatus: 'draft',
    }))

  const dependencies = asList(plan?.crossFunctionalDependencies).map((dependency, idx) => ({
    name: `Dependency ${idx + 1}`,
    sourceFunction: plan?.buName || 'Executive Leadership & Strategic Governance',
    receivingFunction: dependency,
    whyItMatters: dependency,
    blocking: idx < 2,
    requiredCoordination: dependency,
    openQuestion: asList(plan?.unresolvedUnknowns)[idx] || '',
  }))

  return {
    planFormat: 'executive_stage3_cockpit_v1',
    buName: plan?.buName || 'Executive Leadership & Strategic Governance',
    planStatus: plan?.planStatus || 'partial',
    generationMode: plan?.generationMode || 'ai',
    sourceHandoffStatus: plan?.sourceHandoffStatus,
    executionRisk: plan?.executionRisk,
    dependencyComplexity: plan?.dependencyComplexity,
    confidenceLevel: plan?.confidenceLevel,
    organizationalReadiness: plan?.organizationalReadiness,
    readiness: {
      status: plan?.planStatus === 'complete' ? 'ready_for_review' : 'needs_review',
      rationale: plan?.readinessAssessment || 'Generated Stage 3 plan requires operator review.',
      ready: asList(plan?.priorityOutcomes).slice(0, 4),
      needsReview: asList(plan?.handoffWarnings).concat(asList(plan?.missingSections)).slice(0, 5),
      blocked: asList(plan?.failedSections).map(item => valueToSearchText(item)).slice(0, 4),
    },
    decisionOwnership: {
      primaryOwner: plan?.buName || 'Executive Leadership & Strategic Governance',
      accountableDecisions: asList(plan?.decisionRights),
      escalationTriggers: asList(plan?.risks).slice(0, 4),
      delegatedAuthorities: asList(plan?.staffingOwnership).slice(0, 5),
    },
    executionWorkstreams: workstreams,
    crossFunctionalDependencies: dependencies,
    requiredCapabilities: asList(plan?.requiredCapabilities),
    staffingAndOwnership: asList(plan?.staffingOwnership),
    systemsAndTools: asList(plan?.systemsTools),
    governanceCadence: asList(plan?.governanceCadence),
    decisionRights: asList(plan?.decisionRights),
    risks: asList(plan?.risks),
    constraints: asList(plan?.constraints),
    unknowns: asList(plan?.unresolvedUnknowns || plan?.unknowns),
    sourceBasis: {
      source: 'generated_stage3_plan',
      sourceHandoffStatus: plan?.sourceHandoffStatus || '',
      generationMode: plan?.generationMode || '',
      sourceHandoffWarnings: plan?.handoffWarnings || [],
      executionAtomCount: sections.length,
      rationale: 'Structured cockpit view adapted from persisted Stage 3 plan state.',
    },
    sectionReviewStates: buildExecutiveSectionReviewStates(plan?.generationMode || 'ai'),
  }
}

function buildCoordinationReadiness(rows, planDrafts) {
  const plans = rows.map(row => planDrafts[row.unit.name]?.plan).filter(Boolean)
  const completePlans = plans.filter(plan => plan.planStatus === 'complete' || plan.planStatus === 'full')
  if (plans.length === 0) {
    return { status: 'pending', label: 'Coordination pending until BU plans exist.', canSynthesize: false, provisional: false, plans, completePlans }
  }
  if (plans.length === 1) {
    return { status: 'not_ready', label: 'Coordination not ready; generate at least one more BU plan.', canSynthesize: false, provisional: false, plans, completePlans }
  }
  if (completePlans.length < rows.length) {
    return { status: 'provisional', label: 'Multiple BU plans exist; provisional coordination synthesis is available.', canSynthesize: true, provisional: true, plans, completePlans }
  }
  return { status: 'full', label: 'All required BU plans are complete; full coordination synthesis is available.', canSynthesize: true, provisional: false, plans, completePlans }
}

// ── Scope selector (reuses Stage2View's REFINEMENT_SCOPES list) ──────────────

function ScopeSelector({ value, onChange, disabled }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{
        fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)',
        textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5,
      }}>
        Refinement scope
        <span style={{ marginLeft: 5, fontWeight: 400, opacity: .6, textTransform: 'none', letterSpacing: 0 }}>
          — helps the model focus on the right fields
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {REFINEMENT_SCOPES.map(s => {
          const active = value === s.value
          return (
            <button
              key={s.value}
              onClick={() => onChange(s.value)}
              disabled={disabled}
              style={{
                fontSize: 8, fontFamily: 'var(--fm)', padding: '2px 8px', borderRadius: 3,
                cursor: disabled ? 'not-allowed' : 'pointer',
                background: active ? 'rgba(59,130,246,.18)' : 'var(--surface)',
                border: `1px solid ${active ? 'rgba(59,130,246,.45)' : 'var(--border)'}`,
                color: active ? 'var(--accent)' : 'var(--muted)',
                transition: 'background .1s, color .1s, border-color .1s',
                opacity: disabled ? 0.5 : 1,
              }}
            >
              {active && '✓ '}{s.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Shared small primitives ───────────────────────────────────────────────────

function Badge({ children, color, small }) {
  const c = color || 'rgba(255,255,255,.38)'
  return (
    <span style={{
      fontSize: small ? 7 : 8,
      fontFamily: 'var(--fm)', padding: small ? '1px 5px' : '2px 7px', borderRadius: 3,
      color: c, background: `${c}18`, border: `1px solid ${c}30`,
      display: 'inline-block', lineHeight: 1.6, whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  )
}

function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)',
      textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5,
    }}>
      {children}
    </div>
  )
}

function BulletList({ items, borderColor, empty }) {
  if (!items?.length) {
    return empty
      ? <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', fontStyle: 'italic' }}>{empty}</div>
      : null
  }
  const bc = borderColor || 'var(--border2)'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {items.map((item, i) => (
        <div key={i} style={{
          fontSize: 10, color: 'var(--muted2)', lineHeight: 1.65,
          paddingLeft: 10, borderLeft: `2px solid ${bc}`,
        }}>
          {typeof item === 'string' ? item : item?.text || ''}
        </div>
      ))}
    </div>
  )
}

function TwoCol({ left, right, gap = 20 }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: `0 ${gap}px` }}>
      {left}
      {right}
    </div>
  )
}

function PlanSection({ label, children, marginBottom = 12 }) {
  return (
    <div style={{ marginBottom }}>
      <SectionLabel>{label}</SectionLabel>
      {children}
    </div>
  )
}

// ── Assumption badge ──────────────────────────────────────────────────────────

function ReviewMeta({ state }) {
  if (!state) return null
  const palette = { draft: '#fb923c', accepted: '#00e5b4', needs_refinement: '#f87171', failed: '#f87171' }
  const color = palette[state.status] || 'var(--muted)'
  return (
    <div style={{ display: 'flex', gap: 7, alignItems: 'flex-start', flexWrap: 'wrap', marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
      <Badge color={color} small>{state.status || 'draft'}</Badge>
      {state.operatorNote && (
        <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.45, flex: '1 1 240px' }}>
          {state.operatorNote}
        </span>
      )}
      {state.failureReason && (
        <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#f87171', lineHeight: 1.45 }}>{state.failureReason}</span>
      )}
    </div>
  )
}

function CockpitCard({ title, children, reviewState: state, accent = 'var(--accent)' }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, background: 'var(--s2)', padding: '10px 11px', boxShadow: `inset 3px 0 0 ${accent}` }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text)', marginBottom: 7 }}>{title}</div>
      {children}
      <ReviewMeta state={state} />
    </div>
  )
}

function ExecutiveWorkstreamCard({ workstream }) {
  const review = {
    status: workstream.reviewStatus || 'draft',
    operatorNote: workstream.sourceBasis,
    sourceBasis: workstream.sourceBasis ? [workstream.sourceBasis] : [],
    failureReason: null,
  }
  return (
    <CockpitCard title={workstream.name} accent="#3b82f6" reviewState={review}>
      <Field label="objective" value={workstream.objective} />
      <Field label="accountable owner / function" value={workstream.accountableOwner || workstream.owner} />
      <Field label="dependent functions" value={workstream.dependentFunctions} />
      <Field label="decision needed" value={workstream.decisionNeeded || workstream.decisionGate} />
      <Field label="risk / constraint / unknown" value={workstream.riskConstraintUnknown} />
      <Field label="next action" value={workstream.nextAction} />
      <Field label="source basis / rationale" value={workstream.sourceBasis} />
    </CockpitCard>
  )
}

function ExecutiveDependencyCard({ dependency }) {
  return (
    <CockpitCard title={dependency.name || dependency.to || dependency.dependency} accent="#8b5cf6">
      <Field label="source function / team" value={dependency.sourceFunction || dependency.from} />
      <Field label="receiving function / team" value={dependency.receivingFunction || dependency.to} />
      <Field label="why it matters" value={dependency.whyItMatters || dependency.executiveUse || dependency.dependency} />
      <Field label="blocking" value={dependency.blocking ? 'Blocking' : 'Non-blocking'} />
      <Field label="required coordination" value={dependency.requiredCoordination} />
      <Field label="open question" value={dependency.openQuestion} />
    </CockpitCard>
  )
}

function SourceBasisDetails({ sourceBasis, reviewState: state }) {
  if (!sourceBasis) return null
  const entries = Object.entries(sourceBasis).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0
    return value !== null && value !== undefined && value !== ''
  })
  return (
    <details style={{ border: '1px solid var(--border)', borderRadius: 6, background: 'var(--s2)', padding: '9px 11px', marginBottom: 12 }}>
      <summary style={{ cursor: 'pointer', fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
        Source Basis
      </summary>
      <div style={{ marginTop: 10 }}>
        {entries.map(([key, value]) => (
          <Field key={key} label={key} value={Array.isArray(value) ? value : valueToSearchText(value)} />
        ))}
        <ReviewMeta state={state} />
      </div>
    </details>
  )
}

function ExecutivePlanCockpit({ plan, index }) {
  const cockpitPlan = toExecutiveCockpitPlan(plan)
  const reviews = cockpitPlan.sectionReviewStates || {}
  const isFixture = cockpitPlan.generationMode === 'fixture'
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r)', marginBottom: 8, overflow: 'hidden' }}>
      <div style={{ padding: '12px 14px', display: 'flex', gap: 10, alignItems: 'flex-start', borderBottom: '1px solid var(--border)' }}>
        <span style={{ flexShrink: 0, width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontFamily: 'var(--fm)', fontWeight: 700, background: 'rgba(59,130,246,.14)', border: '1px solid rgba(59,130,246,.35)', color: '#3b82f6' }}>
          {index + 1}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 5 }}>{cockpitPlan.buName}</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {isFixture && <Badge color="#3b82f6" small>dev fixture</Badge>}
            <Badge color={cockpitPlan.planStatus === 'complete' ? '#00e5b4' : '#fb923c'} small>{cockpitPlan.planStatus}</Badge>
            <Badge color="#fb923c" small>{cockpitPlan.readiness?.status || 'draft'}</Badge>
          </div>
        </div>
      </div>

      {isFixture && (
        <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', background: 'rgba(59,130,246,.06)', fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.45 }}>
          Live generation disabled in dev fixture mode.
        </div>
      )}

      <div style={{ padding: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <CockpitCard title="Readiness" reviewState={reviews.readiness} accent="#00e5b4">
            <Field label="status" value={cockpitPlan.readiness?.status} />
            <Field label="rationale" value={cockpitPlan.readiness?.rationale} />
            <PlanSection label="Ready" marginBottom={8}>
              <BulletList items={cockpitPlan.readiness?.ready} borderColor="rgba(0,229,180,.4)" />
            </PlanSection>
            <PlanSection label="Needs Review" marginBottom={8}>
              <BulletList items={cockpitPlan.readiness?.needsReview} borderColor="rgba(251,146,60,.4)" />
            </PlanSection>
            <PlanSection label="Blocked" marginBottom={0}>
              <BulletList items={cockpitPlan.readiness?.blocked} borderColor="rgba(248,113,113,.4)" />
            </PlanSection>
          </CockpitCard>
          <CockpitCard title="Decision Ownership" reviewState={reviews.decisionOwnership} accent="#fb923c">
            <Field label="primary owner" value={cockpitPlan.decisionOwnership?.primaryOwner} />
            <PlanSection label="Accountable Decisions" marginBottom={8}>
              <BulletList items={cockpitPlan.decisionOwnership?.accountableDecisions} borderColor="rgba(251,146,60,.4)" />
            </PlanSection>
            <PlanSection label="Escalation Triggers" marginBottom={0}>
              <BulletList items={cockpitPlan.decisionOwnership?.escalationTriggers} borderColor="rgba(248,113,113,.4)" />
            </PlanSection>
          </CockpitCard>
        </div>

        <PlanSection label="Execution Workstreams">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
            {(cockpitPlan.executionWorkstreams || []).map((workstream, i) => (
              <ExecutiveWorkstreamCard key={workstream.name || i} workstream={workstream} />
            ))}
          </div>
          <ReviewMeta state={reviews.executionWorkstreams} />
        </PlanSection>

        <PlanSection label="Cross-functional Dependencies">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
            {(cockpitPlan.crossFunctionalDependencies || []).map((dependency, i) => (
              <ExecutiveDependencyCard key={`${dependency.to || dependency.dependency}-${i}`} dependency={dependency} />
            ))}
          </div>
          <ReviewMeta state={reviews.crossFunctionalDependencies} />
        </PlanSection>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <CockpitCard title="Required Capabilities" reviewState={reviews.requiredCapabilities} accent="#3b82f6"><BulletList items={cockpitPlan.requiredCapabilities} borderColor="rgba(59,130,246,.4)" /></CockpitCard>
          <CockpitCard title="Staffing & Ownership" reviewState={reviews.staffingAndOwnership} accent="#fb923c"><BulletList items={cockpitPlan.staffingAndOwnership} borderColor="rgba(251,146,60,.4)" /></CockpitCard>
          <CockpitCard title="Systems & Tools" reviewState={reviews.systemsAndTools} accent="#94a3b8"><BulletList items={cockpitPlan.systemsAndTools} borderColor="rgba(148,163,184,.4)" /></CockpitCard>
          <CockpitCard title="Governance Cadence" reviewState={reviews.governanceCadence} accent="#00e5b4"><BulletList items={cockpitPlan.governanceCadence} borderColor="rgba(0,229,180,.4)" /></CockpitCard>
        </div>

        <div style={{ marginBottom: 12 }}>
          <CockpitCard title="Decision Rights" reviewState={reviews.decisionRights} accent="#fb923c">
            <BulletList items={cockpitPlan.decisionRights} borderColor="rgba(251,146,60,.4)" />
          </CockpitCard>
        </div>

        <PlanSection label="Risks, Constraints, Unknowns">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            <CockpitCard title="Risks" accent="#f87171"><BulletList items={cockpitPlan.risks} borderColor="rgba(248,113,113,.45)" /></CockpitCard>
            <CockpitCard title="Constraints" accent="#fb923c"><BulletList items={cockpitPlan.constraints} borderColor="rgba(251,146,60,.45)" /></CockpitCard>
            <CockpitCard title="Unknowns" accent="#94a3b8"><BulletList items={cockpitPlan.unknowns} borderColor="rgba(148,163,184,.45)" /></CockpitCard>
          </div>
          <ReviewMeta state={reviews.riskConstraintUnknownRegister} />
        </PlanSection>

        <SourceBasisDetails sourceBasis={cockpitPlan.sourceBasis} reviewState={reviews.sourceBasis} />
      </div>
    </div>
  )
}

function Field({ label, value }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div style={{ marginBottom: 7 }}>
      <div style={{
        fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)',
        textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 2,
      }}>
        {label}
      </div>
      <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted2)', lineHeight: 1.55 }}>
        {Array.isArray(value) ? value.join(', ') : String(value)}
      </div>
    </div>
  )
}

const ASSUMPTION_COLORS = {
  fact:        '#3b82f6',
  inferred:    '#fb923c',
  speculative: '#f87171',
}

function AssumptionItem({ assumption }) {
  const c = ASSUMPTION_COLORS[assumption.type] || '#fb923c'
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 7,
      marginBottom: 5,
    }}>
      <span style={{
        flexShrink: 0, marginTop: 2,
        fontSize: 7, fontFamily: 'var(--fm)', padding: '1px 5px', borderRadius: 2,
        color: c, background: `${c}18`, border: `1px solid ${c}30`,
      }}>
        {assumption.type || 'inferred'}
      </span>
      <span style={{ fontSize: 10, color: 'var(--muted2)', lineHeight: 1.65 }}>
        {assumption.text}
      </span>
    </div>
  )
}

// ── Initiative grid ───────────────────────────────────────────────────────────

function InitiativeBlock({ label, items, accentColor, empty }) {
  if (!items?.length && /Optional|Deferred|Blocked/.test(label || '')) return null
  const c = accentColor || 'rgba(255,255,255,.2)'
  return (
    <div style={{
      background: `${c}08`,
      border: `1px solid ${c}22`,
      borderRadius: 6, padding: '9px 11px',
    }}>
      <div style={{
        fontSize: 8, fontFamily: 'var(--fm)', color: c,
        textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6,
        fontWeight: 600,
      }}>
        {label}
      </div>
      {items?.length
        ? items.map((item, i) => (
            <div key={i} style={{
              fontSize: 10, color: 'var(--muted2)', lineHeight: 1.6,
              paddingLeft: 8, borderLeft: `2px solid ${c}40`,
              marginBottom: i < items.length - 1 ? 5 : 0,
            }}>
              {item}
            </div>
          ))
        : <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', fontStyle: 'italic' }}>
            {empty || 'None identified'}
          </div>
      }
    </div>
  )
}

// ── Indicator strip ───────────────────────────────────────────────────────────

function LensList({ lenses }) {
  if (!lenses?.length) return null
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7 }}>
      {lenses.map((lens, i) => {
        const title = lens?.name || `Lens ${i + 1}`
        return (
          <div key={`${title}-${i}`} style={{
            background: 'rgba(0,229,180,.05)',
            border: '1px solid rgba(0,229,180,.16)',
            borderRadius: 6,
            padding: '9px 11px',
          }}>
            <div style={{
              fontSize: 8,
              fontFamily: 'var(--fm)',
              color: '#00e5b4',
              textTransform: 'uppercase',
              letterSpacing: '.06em',
              marginBottom: 5,
              fontWeight: 600,
            }}>
              {title}
            </div>
            {lens?.focus && (
              <div style={{ fontSize: 10, color: 'var(--muted2)', lineHeight: 1.6, marginBottom: 6 }}>
                {lens.focus}
              </div>
            )}
            <BulletList items={lens?.actions} borderColor="rgba(0,229,180,.35)" />
            <BulletList items={lens?.validation} borderColor="rgba(59,130,246,.35)" />
            <BulletList items={lens?.risks} borderColor="rgba(248,113,113,.35)" />
          </div>
        )
      })}
    </div>
  )
}

async function collectStage3LearningSignals(context, useAI) {
  const heuristic = deriveLearningSignals({ stage: 'Stage 3', ...context })
  if (!useAI) return heuristic
  const { messages } = buildLearningSignalMessages({ stage: 'Stage 3', ...context })
  const { result } = await callAI(messages, { temperature: 0.2, maxTokens: 900, timeoutMs: 15000 })
  return normalizeLearningSignals([...heuristic, ...parseLearningSignalResponse(result, 'Stage 3')], 'Stage 3')
}

function CoordinationLayer({ layer }) {
  if (!layer) return null
  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid rgba(59,130,246,.25)',
      borderRadius: 'var(--r)',
      padding: '13px 15px',
      marginBottom: 12,
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8 }}>Cross-functional Coordination</div>
      {layer.executionSummary && (
        <div style={{ fontSize: 10, color: 'var(--muted2)', lineHeight: 1.65, marginBottom: 10, fontFamily: 'var(--fm)' }}>
          {layer.executionSummary}
        </div>
      )}
      {layer.sequencingOverview && (
        <PlanSection label="Sequencing Overview" marginBottom={10}>
          <div style={{ fontSize: 10, color: 'var(--muted2)', lineHeight: 1.65 }}>{layer.sequencingOverview}</div>
        </PlanSection>
      )}
      <TwoCol
        left={<PlanSection label="Critical Path"><BulletList items={layer.criticalExecutionPath} borderColor="rgba(248,113,113,.4)" /></PlanSection>}
        right={<PlanSection label="Parallel Workstreams"><BulletList items={layer.parallelizableWorkstreams} borderColor="rgba(0,229,180,.35)" /></PlanSection>}
      />
      <TwoCol
        left={<PlanSection label="Governance"><BulletList items={layer.governanceModel} borderColor="rgba(59,130,246,.35)" /></PlanSection>}
        right={<PlanSection label="Escalation Ownership"><BulletList items={layer.escalationDecisionOwnership} borderColor="rgba(251,146,60,.35)" /></PlanSection>}
      />
      <TwoCol
        left={<PlanSection label="Shared Risks"><BulletList items={layer.sharedRisks} borderColor="rgba(248,113,113,.35)" /></PlanSection>}
        right={<PlanSection label="Shared Unknowns"><BulletList items={layer.sharedUnknowns} borderColor="rgba(148,163,184,.35)" /></PlanSection>}
      />
      {layer.confidenceReadinessAssessment && (
        <div style={{ fontSize: 10, color: 'var(--muted2)', lineHeight: 1.65, fontFamily: 'var(--fm)' }}>
          {layer.confidenceReadinessAssessment}
        </div>
      )}
    </div>
  )
}

function GenerationProgress({ generation, onRetry }) {
  if (!generation?.active && !generation?.failedStep) return null
  const units    = generation.units    || []
  const buStates = generation.buStates || []
  const phase    = generation.phase    || 'bu_phases'

  const mark = s => ({ complete: '✓', generating: '~', failed: '!', rate_limited: '!', pending: '○' }[s] || '○')
  const col  = s => ({
    complete: '#00e5b4',
    failed: '#f87171',
    rate_limited: '#fb923c',
    generating: '#fb923c',
    pending: 'var(--muted)',
  }[s] || 'var(--muted)')
  const retryLabel = generation.rateLimited
    ? 'Resume after cooldown'
    : generation.failedStep === 'coordination'
      ? 'Retry coordination'
      : 'Retry failed sections'

  return (
    <div style={{
      background: 'rgba(59,130,246,.05)',
      border: '1px solid rgba(59,130,246,.22)',
      borderRadius: 'var(--r)',
      padding: '12px 15px',
      marginBottom: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 600, flex: 1 }}>Stage 3 generation progress</div>
        {generation.failedStep && (
          <button onClick={onRetry} style={{
            fontSize: 9, fontFamily: 'var(--fm)', fontWeight: 600,
            padding: '4px 12px', borderRadius: 4, cursor: 'pointer',
            background: 'rgba(251,146,60,.15)', border: '1px solid rgba(251,146,60,.4)', color: '#fb923c',
          }}>
            {retryLabel}
          </button>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {units.map((unit, i) => {
          const bs = buStates[i] || {}
          const plan = bs.plan

          // Determine overall BU status
          let buStatus
          if (plan && !plan._error)                         buStatus = 'complete'
          else if (bs.structureStatus === 'rate_limited')   buStatus = 'rate_limited'
          else if (bs.structureStatus === 'failed')         buStatus = 'failed'
          else if (bs.structureStatus === 'generating')     buStatus = 'generating'
          else if (bs.structureStatus === 'complete') {
            const sv = Object.values(bs.sectionStatuses || {})
            if (sv.some(s => s === 'rate_limited'))         buStatus = 'rate_limited'
            else if (sv.some(s => s === 'failed'))          buStatus = 'failed'
            else if (sv.some(s => s === 'generating'))      buStatus = 'generating'
            else if (sv.length && sv.every(s => s === 'complete')) buStatus = 'assembling'
            else                                            buStatus = 'generating'
          } else                                            buStatus = 'pending'

          const displayStatus = buStatus === 'assembling' ? 'generating' : buStatus
          const sectionEntries = Object.entries(bs.sectionStatuses || {})
          const showSections = bs.structureStatus === 'complete' && buStatus !== 'complete'

          return (
            <div key={`${unit.name}-${i}`} style={{ marginBottom: 2 }}>
              <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: col(displayStatus) }}>
                {mark(displayStatus)} {unit.name}
                {bs.structure?.domain && buStatus !== 'pending' && (
                  <span style={{ opacity: .55, marginLeft: 5 }}>· {bs.structure.domain}</span>
                )}
              </div>
              {showSections && sectionEntries.length > 0 && (
                <div style={{ paddingLeft: 14, marginTop: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {sectionEntries.map(([key, status]) => (
                    <div key={key} style={{ fontSize: 8, fontFamily: 'var(--fm)', color: col(status) }}>
                      {mark(status)} {SECTION_LABELS[key] || key}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {(phase === 'coordination' || generation.coordinationLayer || generation.failedStep === 'coordination') && (
          <div style={{
            fontSize: 9, fontFamily: 'var(--fm)',
            color: generation.coordinationLayer ? '#00e5b4' : generation.failedStep === 'coordination' ? '#f87171' : '#fb923c',
          }}>
            {mark(generation.coordinationLayer ? 'complete' : generation.failedStep === 'coordination' ? 'failed' : 'generating')}
            {' '}Coordination synthesis {generation.coordinationLayer ? 'complete' : generation.failedStep === 'coordination' ? 'failed' : 'generating'}
          </div>
        )}
      </div>
      {generation.error && (
        <div style={{ marginTop: 8, fontSize: 9, fontFamily: 'var(--fm)', color: '#f87171', lineHeight: 1.5 }}>
          {generation.error}
        </div>
      )}
    </div>
  )
}

const matrixThStyle = {
  textAlign: 'left',
  padding: '8px 9px',
  fontSize: 8,
  fontFamily: 'var(--fm)',
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: '.04em',
  borderRight: '1px solid var(--border)',
  verticalAlign: 'bottom',
}

const matrixTdStyle = {
  padding: '8px 9px',
  verticalAlign: 'top',
  borderRight: '1px solid var(--border)',
}

function ReadinessBadge({ status, detail }) {
  const palette = {
    ready:       { color: '#00e5b4', label: 'Ready' },
    partial:     { color: '#fb923c', label: 'Partial' },
    needed:      { color: '#fbbf24', label: 'Needed' },
    stale:       { color: '#f87171', label: 'Stale' },
    not_started: { color: 'var(--muted)', label: 'Not started' },
  }
  const p = palette[status] || palette.not_started
  return (
    <div style={{ minWidth: 112 }}>
      <div style={{ fontSize: 8, fontFamily: 'var(--fm)', fontWeight: 700, color: p.color, marginBottom: 3 }}>
        {p.label}
      </div>
      <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.45 }}>
        {detail}
      </div>
    </div>
  )
}

function Stage3ReadinessMatrix({
  rows,
  planDrafts,
  planGeneration,
  draftOptIns,
  onOptIntoStage12Draft,
  onGenerateBUPlan,
  apiMode,
  disabled,
}) {
  const completedCount = rows.filter(row => planDrafts[row.unit.name]?.plan).length
  const coordinationText = completedCount === 0
    ? 'Coordination pending until BU plans exist.'
    : completedCount === 1
      ? 'Coordination not ready; one BU plan exists.'
      : completedCount === rows.length
        ? 'Full coordination synthesis is ready after all required BU plans exist.'
        : 'Provisional coordination can be synthesized once explicitly triggered.'

  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r)',
      padding: '13px 14px',
      marginBottom: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
            BU Execution Readiness
          </div>
          <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.55 }}>
            Readiness is based on the Stage 2 handoff draft and compiled context for each business unit.
            Generated BU plans are persisted as Stage 3 drafts until a full stage-level revision is assembled.
          </div>
        </div>
        <Badge color={completedCount === rows.length && rows.length ? '#00e5b4' : '#fb923c'} small>
          {completedCount}/{rows.length} plans
        </Badge>
      </div>

      <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
          <thead>
            <tr style={{ background: 'var(--s2)' }}>
              <th style={matrixThStyle}>Business Unit</th>
              {READINESS_COLUMNS.map(col => (
                <th key={col.key} style={matrixThStyle}>{col.label}</th>
              ))}
              <th style={matrixThStyle}>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => {
              const unit = row.unit
              const readiness = row.readiness
              const draft = planDrafts[unit.name]
              const gen = planGeneration[unit.name]
              const isExecutiveFixtureMode = isExecutiveTraceUnit(unit)
              const hasPlan = !!draft?.plan
              const noHandoff = readiness.completion === 'none'
              const optIn = !!draftOptIns[unit.name]
              const canGenerate = !disabled && !gen?.running && (isExecutiveFixtureMode || !noHandoff || optIn)
              const cta = isExecutiveFixtureMode
                ? (USE_STAGE3_EXECUTIVE_FIXTURE
                  ? (hasPlan ? 'Preview dev fixture plan' : 'Load dev fixture plan')
                  : (hasPlan ? 'Regenerate Executive Leadership Plan' : 'Generate Executive Leadership Plan'))
                : hasPlan
                  ? 'Regenerate BU plan'
                  : readiness.completion === 'full'
                    ? 'Generate full exec plan'
                    : readiness.completion === 'partial' || readiness.completion === 'limited'
                      ? 'Generate limited draft'
                      : optIn
                        ? 'Generate from Stage 1/2 only'
                        : 'Pending handoff'

              return (
                <tr key={unit.name || idx} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={matrixTdStyle}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>
                      {unit.name}
                    </div>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 5 }}>
                      <Badge color={readiness.completion === 'full' ? '#00e5b4' : readiness.completion === 'none' ? 'var(--muted)' : '#fb923c'} small>
                        {readiness.completion === 'full' ? 'complete handoff' : readiness.completion === 'none' ? 'no handoff' : 'partial handoff'}
                      </Badge>
                      {isExecutiveFixtureMode && USE_STAGE3_EXECUTIVE_FIXTURE && <Badge color="#3b82f6" small>dev fixture</Badge>}
                      {hasPlan && (
                        <Badge color={draft.planGenerationMode === 'full' ? '#00e5b4' : '#fb923c'} small>
                          {draft.planGenerationMode === 'full' ? 'full plan saved' : 'draft plan saved'}
                        </Badge>
                      )}
                    </div>
                    {readiness.domainOfWork && (
                      <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.45 }}>
                        {readiness.domainOfWork}
                      </div>
                    )}
                  </td>
                  {READINESS_COLUMNS.map(col => (
                    <td key={col.key} style={matrixTdStyle}>
                      <ReadinessBadge {...readiness.cells[col.key]} />
                    </td>
                  ))}
                  <td style={matrixTdStyle}>
                    <button
                      onClick={() => onGenerateBUPlan(unit, readiness)}
                      disabled={!canGenerate}
                      style={{
                        fontSize: 8,
                        fontFamily: 'var(--fm)',
                        fontWeight: 700,
                        padding: '5px 9px',
                        borderRadius: 4,
                        cursor: canGenerate ? 'pointer' : 'not-allowed',
                        background: canGenerate ? 'var(--accent)' : 'var(--s2)',
                        border: `1px solid ${canGenerate ? 'var(--accent)' : 'var(--border)'}`,
                        color: canGenerate ? '#000' : 'var(--muted)',
                        opacity: canGenerate ? 1 : 0.65,
                        width: '100%',
                      }}
                    >
                      {gen?.running ? (isExecutiveFixtureMode ? 'Loading fixture...' : 'Generating...') : cta}
                    </button>
                    {noHandoff && !optIn && (
                      <button
                        onClick={() => onOptIntoStage12Draft(unit.name)}
                        disabled={disabled || gen?.running}
                        style={{
                          marginTop: 5,
                          fontSize: 8,
                          fontFamily: 'var(--fm)',
                          padding: '3px 7px',
                          borderRadius: 4,
                          cursor: disabled ? 'not-allowed' : 'pointer',
                          background: 'transparent',
                          border: '1px solid var(--border)',
                          color: 'var(--muted)',
                          width: '100%',
                        }}
                      >
                        Use Stage 1/2 only
                      </button>
                    )}
                    {gen?.error && (
                      <div style={{ marginTop: 5, fontSize: 8, fontFamily: 'var(--fm)', color: '#f87171', lineHeight: 1.4 }}>
                        {gen.error}
                      </div>
                    )}
                    {apiMode !== 'ai' && (
                      <div style={{ marginTop: 5, fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.4 }}>
                        Mock plan
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 9, fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.55 }}>
        {coordinationText}
      </div>
    </div>
  )
}

function HandoffItemRow({ item, unitName, onStage2Action }) {
  const status = item.isStale ? 'stale' : item.status || 'not_started'
  const color = {
    complete: '#00e5b4',
    partial: '#fb923c',
    failed: '#f87171',
    stale: '#f87171',
    running: '#fb923c',
    not_started: 'var(--muted)',
  }[status] || 'var(--muted)'
  const detail = item.parsedValue
    ? listFromValue(item.parsedValue).slice(0, 2).join('; ')
    : item.parserError || item.text || 'No generated detail yet'

  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 5,
      padding: '8px 9px',
      background: 'var(--s2)',
    }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text)' }}>
              {item.label || item.key}
            </span>
            <Badge color={color} small>{status.replace('_', ' ')}</Badge>
          </div>
          <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.5 }}>
            {detail}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 92 }}>
          {['Review', 'Refine', 'Regenerate'].map(action => (
            <button
              key={action}
              onClick={() => onStage2Action(unitName, item.key, action.toLowerCase())}
              style={{
                fontSize: 8,
                fontFamily: 'var(--fm)',
                padding: '3px 6px',
                borderRadius: 4,
                cursor: 'pointer',
                background: 'transparent',
                border: '1px solid var(--border)',
                color: 'var(--muted)',
              }}
            >
              {action} in Stage 2
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function Stage3HandoffBriefCard({ brief, unitName, onStage2Action }) {
  if (!brief) return null
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '10px 11px', background: 'var(--s2)', marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <SectionLabel>Stage 2 to Stage 3 Handoff Brief</SectionLabel>
          <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.45 }}>
            Compact planning input. Full Stage 2 handoff detail remains in Stage 2.
          </div>
        </div>
        <Badge color={brief.readinessStatus === 'complete' ? '#00e5b4' : '#fb923c'} small>
          {brief.readinessStatus || 'brief'}
        </Badge>
      </div>
      <Field label="planning purpose" value={brief.planningPurpose} />
      <Field label="decision basis" value={brief.decisionBasisSummary} />
      <Field label="key implications" value={brief.keyImplications} />
      <Field label="execution constraints" value={brief.executionConstraints} />
      <Field label="dependencies" value={brief.dependencies} />
      <Field label="risks / contradictions" value={brief.risksOrContradictions} />
      <Field label="unresolved questions" value={brief.unresolvedQuestions} />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        <Badge color="#3b82f6" small>{brief.metadata?.briefSizeBytes || 0}b brief</Badge>
        <Badge color="var(--muted)" small>{brief.metadata?.fullDraftSizeBytes || 0}b source</Badge>
        <Badge color="#00e5b4" small>{(brief.sourceStage2SectionIds || []).length} source refs</Badge>
      </div>
      <button
        onClick={() => onStage2Action(unitName, null, 'review')}
        style={{ ...secondaryButtonStyle, marginTop: 9 }}
      >
        View source detail in Stage 2
      </button>
    </div>
  )
}

function Stage3ReadinessPanels({
  rows,
  planDrafts,
  planGeneration,
  draftOptIns,
  onOptIntoStage12Draft,
  onGenerateBUPlan,
  onStage2Action,
  apiMode,
  disabled,
  generationEnabled = false,
}) {
  const [open, setOpen] = useState({})
  const completedCount = rows.filter(row => planDrafts[row.unit.name]?.plan).length

  const modeFor = (readiness, optIn) => {
    if (readiness.completion === 'full') {
      return { label: 'Full exec plan', cta: 'Generate full exec plan', color: '#00e5b4', enabled: generationEnabled }
    }
    if (readiness.completion === 'partial' || readiness.completion === 'limited') {
      return { label: 'Limited draft', cta: 'Generate limited draft', color: '#fb923c', enabled: generationEnabled }
    }
    if (optIn) {
      return { label: 'Stage 1/2-only draft', cta: 'Generate from Stage 1/2 only', color: '#fb923c', enabled: generationEnabled }
    }
    return { label: 'Pending', cta: 'Review/build handoff in Stage 2', color: 'var(--muted)', enabled: false }
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r)',
        padding: '13px 14px',
        marginBottom: 8,
      }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>BU Execution Readiness</div>
            <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.55 }}>
              Readiness now follows the Stage 2 domain-specific handoff model. Expand a BU to inspect its handoff state, Stage 2 linkbacks, and generation mode.
            </div>
          </div>
          <Badge color={completedCount === rows.length && rows.length ? '#00e5b4' : '#fb923c'} small>
            {completedCount}/{rows.length} plans
          </Badge>
        </div>
      </div>

      {rows.map((row, idx) => {
        const unit = row.unit
        const readiness = row.readiness
        const draft = planDrafts[unit.name]
        const gen = planGeneration[unit.name]
        const isExecutiveFixtureMode = isExecutiveTraceUnit(unit)
        const isOpen = open[unit.name] ?? idx === 0
        const hasPlan = !!draft?.plan
        const hasRetryableAtoms = isExecutiveTraceUnit(unit) && (draft?.executionAtoms || []).some(atom => (
          STAGE3_RETRYABLE_ATOM_STATUSES.has(atom?.status) && atom?.status !== ATOM_STATUSES.COMPLETE
        ))
        const executionStatus = gen?.error
          ? 'failed'
          : hasPlan
            ? (draft.plan?.planStatus === 'complete'
              ? (draft.planGenerationMode === 'full' ? 'generated' : 'draft')
              : draft.plan?.planStatus || 'partial')
            : 'not started'
        const handoffStatus = readiness.completion === 'none'
          ? 'missing'
          : readiness.staleCount
            ? 'stale'
            : readiness.completion === 'full'
              ? 'ready'
              : 'partial'
        const mode = modeFor(readiness, !!draftOptIns[unit.name])
        const ctaLabel = isExecutiveFixtureMode
          ? (USE_STAGE3_EXECUTIVE_FIXTURE
            ? (hasPlan ? 'Preview dev fixture plan' : 'Load dev fixture plan')
            : (hasPlan ? 'Regenerate Executive Leadership Plan' : 'Generate Executive Leadership Plan'))
          : hasRetryableAtoms
            ? 'Retry failed sections'
            : mode.cta
        const actionEnabled = isExecutiveFixtureMode || mode.enabled
        const handoffItems = readiness.structureItems.map(item => {
          const match = readiness.itemStates.find(state => state.key === item.key || state.key === String(readiness.structureItems.indexOf(item)))
          return { ...item, ...(match || {}) }
        })
        const failedItems = readiness.itemStates.filter(item => item.status === 'failed' || item.parserError)
        const staleItems = readiness.itemStates.filter(item => item.isStale)
        const missingItems = handoffItems.filter(item => !item.parsedValue && !Object.keys(item.childAtoms || {}).length && item.status !== 'complete')

        return (
          <div key={unit.name || idx} style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r)',
            marginBottom: 8,
            overflow: 'hidden',
          }}>
            <div
              onClick={() => setOpen(prev => ({ ...prev, [unit.name]: !isOpen }))}
              style={{
                padding: '11px 13px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                borderBottom: isOpen ? '1px solid var(--border)' : 'none',
              }}
            >
              <span style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 9,
                fontFamily: 'var(--fm)',
                fontWeight: 700,
                background: 'var(--s2)',
                border: '1px solid var(--border)',
                color: 'var(--muted2)',
              }}>
                {idx + 1}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>
                  {unit.name}
                </div>
                <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.45 }}>
                  {unit.involvementLevel || 'involvement n/a'} {unit.strategicInvolvement ? `· ${unit.strategicInvolvement}` : ''}
                </div>
              </div>
              <Badge color={handoffStatus === 'ready' ? '#00e5b4' : handoffStatus === 'missing' ? 'var(--muted)' : '#fb923c'} small>
                handoff {handoffStatus}
              </Badge>
              <Badge color={executionStatus === 'generated' ? '#00e5b4' : executionStatus === 'failed' ? '#f87171' : executionStatus === 'draft' ? '#fb923c' : 'var(--muted)'} small>
                plan {executionStatus}
              </Badge>
              <span style={{ fontSize: 9, color: 'var(--muted)' }}>{isOpen ? '▲' : '▼'}</span>
            </div>

            {isOpen && (
              <div style={{ padding: '12px 13px 13px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1.2fr .8fr', gap: 12, marginBottom: 12 }}>
                  <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '10px 11px', background: 'var(--s2)' }}>
                    <SectionLabel>Handoff Readiness</SectionLabel>
                    <Field label="domainOfWork" value={readiness.domainOfWork || 'Not generated'} />
                    <Field
                      label="SMEReviewLens"
                      value={typeof readiness.smeLens === 'string'
                        ? readiness.smeLens
                        : readiness.smeLens?.summary || readiness.smeLens?.reviewerProfile || 'Not generated'}
                    />
                    <Field label="handoffStatus" value={handoffStatus} />
                    <Field
                      label="assembled items"
                      value={`${readiness.completedItemCount}/${readiness.totalItemCount || readiness.structureItems.length || 0} assembled`}
                    />
                    {missingItems.length > 0 && <Field label="missing items" value={missingItems.map(item => item.label).join(', ')} />}
                    {failedItems.length > 0 && <Field label="failed items" value={failedItems.map(item => item.label || item.key).join(', ')} />}
                    {staleItems.length > 0 && <Field label="stale items" value={staleItems.map(item => item.label || item.key).join(', ')} />}
                  </div>

                  <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '10px 11px', background: 'var(--s2)' }}>
                    <SectionLabel>Generate</SectionLabel>
                    <div style={{ marginBottom: 8 }}>
                      <Badge color={mode.color}>{mode.label}</Badge>
                      {isExecutiveFixtureMode && USE_STAGE3_EXECUTIVE_FIXTURE && (
                        <span style={{ marginLeft: 6 }}>
                          <Badge color="#3b82f6">dev fixture</Badge>
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.55, marginBottom: 9 }}>
                      {isExecutiveFixtureMode && USE_STAGE3_EXECUTIVE_FIXTURE
                        ? 'Live generation disabled in dev fixture mode.'
                        : isExecutiveFixtureMode
                          ? 'Uses the real Stage 2 Executive handoff context to generate a structured execution cockpit.'
                        : readiness.completion === 'full'
                        ? 'Complete handoff exists; full BU execution plan generation is available.'
                        : readiness.completion === 'none'
                          ? 'No handoff exists. Use Stage 2 to build the handoff, or explicitly opt into a Stage 1/2-only draft.'
                          : 'Partial or stale handoff exists; limited draft generation should carry warnings.'}
                    </div>
                    {readiness.completion === 'none' && !draftOptIns[unit.name] && (
                      <button
                        onClick={() => onOptIntoStage12Draft(unit.name)}
                        disabled={disabled}
                        style={secondaryButtonStyle}
                      >
                        Enable Stage 1/2-only draft
                      </button>
                    )}
                    <button
                      onClick={() => actionEnabled ? onGenerateBUPlan(unit, readiness) : onStage2Action(unit.name, null, 'review')}
                      disabled={disabled || gen?.running || (!isExecutiveFixtureMode && readiness.completion === 'none' && !draftOptIns[unit.name] && mode.label !== 'Pending')}
                      style={{
                        ...primaryButtonStyle,
                        marginTop: 6,
                        background: actionEnabled ? 'var(--accent)' : 'var(--s2)',
                        borderColor: actionEnabled ? 'var(--accent)' : 'var(--border)',
                        color: actionEnabled ? '#000' : 'var(--muted)',
                      }}
                    >
                      {gen?.running ? (isExecutiveFixtureMode ? 'Loading fixture...' : 'Generating...') : ctaLabel}
                    </button>
                    {gen?.error && (
                      <div style={{ marginTop: 7, fontSize: 9, fontFamily: 'var(--fm)', color: '#f87171', lineHeight: 1.45 }}>
                        {gen.error}
                      </div>
                    )}
                    {apiMode !== 'ai' && (
                      <div style={{ marginTop: 7, fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
                        Mock mode active.
                      </div>
                    )}
                  </div>
                </div>

                <Stage3HandoffBriefCard
                  brief={readiness.handoffBrief || readiness.planningContext?.handoffBrief}
                  unitName={unit.name}
                  onStage2Action={onStage2Action}
                />

                <SectionLabel>Source References</SectionLabel>
                {handoffItems.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {handoffItems.map((item, itemIdx) => (
                      <HandoffItemRow
                        key={`${item.key}-${itemIdx}`}
                        item={item}
                        unitName={unit.name}
                        onStage2Action={onStage2Action}
                      />
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', fontStyle: 'italic' }}>
                    No Stage 2 handoff items generated yet.
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function CoordinationReadinessPanel({
  readiness,
  coordinationDraft,
  isGenerating,
  error,
  onGenerate,
}) {
  const color = readiness.status === 'full'
    ? '#00e5b4'
    : readiness.status === 'provisional'
      ? '#fb923c'
      : 'var(--muted)'
  return (
    <div style={{
      background: 'var(--surface)',
      border: `1px solid ${readiness.status === 'full' ? 'rgba(0,229,180,.25)' : readiness.status === 'provisional' ? 'rgba(251,146,60,.28)' : 'var(--border)'}`,
      borderRadius: 'var(--r)',
      padding: '13px 14px',
      marginBottom: 12,
    }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>Coordination Readiness</div>
          <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.55 }}>
            {readiness.label}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            <Badge color={color} small>{readiness.status.replace('_', ' ')}</Badge>
            <Badge color="#3b82f6" small>{readiness.plans.length} generated BU plan{readiness.plans.length === 1 ? '' : 's'}</Badge>
            {coordinationDraft?.mode && (
              <Badge color={coordinationDraft.mode === 'full' ? '#00e5b4' : '#fb923c'} small>
                {coordinationDraft.mode} coordination saved
              </Badge>
            )}
          </div>
        </div>
        {readiness.canSynthesize && (
          <button
            onClick={() => onGenerate(readiness.provisional)}
            disabled={isGenerating}
            style={{
              fontSize: 9,
              fontFamily: 'var(--fm)',
              fontWeight: 700,
              padding: '6px 12px',
              borderRadius: 5,
              cursor: isGenerating ? 'not-allowed' : 'pointer',
              background: readiness.provisional ? 'rgba(251,146,60,.15)' : 'var(--accent)',
              border: `1px solid ${readiness.provisional ? 'rgba(251,146,60,.4)' : 'var(--accent)'}`,
              color: readiness.provisional ? '#fb923c' : '#000',
            }}
          >
            {isGenerating
              ? 'Synthesizing...'
              : readiness.provisional
                ? 'Generate provisional coordination synthesis'
                : 'Generate full coordination synthesis'}
          </button>
        )}
      </div>
      {error && (
        <div style={{ marginTop: 8, fontSize: 9, fontFamily: 'var(--fm)', color: '#f87171', lineHeight: 1.5 }}>
          {error}
        </div>
      )}
      {coordinationDraft?.coordinationLayer && (
        <div style={{ marginTop: 12 }}>
          <CoordinationLayer layer={coordinationDraft.coordinationLayer} />
        </div>
      )}
    </div>
  )
}

const primaryButtonStyle = {
  width: '100%',
  fontSize: 9,
  fontFamily: 'var(--fm)',
  fontWeight: 700,
  padding: '6px 9px',
  borderRadius: 4,
  cursor: 'pointer',
  border: '1px solid var(--accent)',
}

const secondaryButtonStyle = {
  width: '100%',
  fontSize: 8,
  fontFamily: 'var(--fm)',
  padding: '4px 8px',
  borderRadius: 4,
  cursor: 'pointer',
  background: 'transparent',
  border: '1px solid var(--border)',
  color: 'var(--muted)',
}

function IndicatorStrip({ plan }) {
  const indicators = [
    { label: 'Exec Risk',   value: plan.executionRisk,           color: riskColor(plan.executionRisk)              },
    { label: 'Dep Complexity', value: plan.dependencyComplexity, color: riskColor(plan.dependencyComplexity)       },
    { label: 'Confidence',  value: plan.confidenceLevel,         color: readyColor(plan.confidenceLevel)           },
    { label: 'Readiness',   value: plan.organizationalReadiness, color: readyColor(plan.organizationalReadiness)   },
  ]
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {indicators.map(ind => (
        <span key={ind.label} style={{
          fontSize: 7, fontFamily: 'var(--fm)',
          padding: '2px 6px', borderRadius: 3,
          color: ind.color,
          background: `${ind.color}14`,
          border: `1px solid ${ind.color}30`,
          whiteSpace: 'nowrap',
        }}>
          {ind.label}: {ind.value || '—'}
        </span>
      ))}
    </div>
  )
}

// ── Execution plan card ───────────────────────────────────────────────────────

function PlanCard({ plan, index, onRefineUnit, apiMode, globalBusy }) {
  const [open,         setOpen]         = useState(true)
  const [refineOpen,   setRefineOpen]   = useState(false)
  const [refinePrompt, setRefinePrompt] = useState('')
  const [refineImpact, setRefineImpact] = useState('')
  const [refineScope,  setRefineScope]  = useState('auto')
  const [isRefining,   setIsRefining]   = useState(false)
  const [refineError,  setRefineError]  = useState(null)
  const [refineDone,   setRefineDone]   = useState(false)

  const canRefine  = apiMode === 'ai' && refinePrompt.trim().length > 0 && !isRefining && !globalBusy
  const aiDisabled = apiMode !== 'ai'

  if (isExecutiveTraceUnit(plan)) {
    return <ExecutivePlanCockpit plan={plan} index={index} />
  }

  async function handleRefine() {
    if (!canRefine) return
    setIsRefining(true)
    setRefineError(null)
    const { error } = await onRefineUnit(refinePrompt.trim(), refineImpact.trim(), refineScope)
    setIsRefining(false)
    if (error) {
      setRefineError(error)
    } else {
      setRefineDone(true)
      setRefinePrompt('')
      setRefineImpact('')
      setRefineScope('auto')
      setRefineOpen(false)
      setTimeout(() => setRefineDone(false), 2500)
    }
  }

  // Involvement badge color from indicator scores
  const execC = riskColor(plan.executionRisk)
  const priorityOutcomes = plan.priorityOutcomes?.length ? plan.priorityOutcomes : plan.strategicObjectives
  const hasMeasurement = plan.leadingIndicators?.length || plan.keySuccessMetrics?.length || plan.failureSignals?.length

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--r)', marginBottom: 8, overflow: 'hidden',
    }}>
      {/* Card header */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          padding: '10px 14px', cursor: 'pointer', userSelect: 'none',
          display: 'flex', alignItems: 'center', gap: 10,
          borderBottom: open ? '1px solid var(--border)' : 'none',
        }}
      >
        <span style={{
          flexShrink: 0,
          width: 22, height: 22, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 9, fontFamily: 'var(--fm)', fontWeight: 700,
          background: `${execC}18`, border: `1px solid ${execC}30`, color: execC,
        }}>
          {index + 1}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 3 }}>
            {plan.buName}
          </div>
          <IndicatorStrip plan={plan} />
        </div>
        {refineDone && (
          <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#00e5b4', flexShrink: 0 }}>
            ✓ Updated
          </span>
        )}
        <span style={{ fontSize: 9, color: 'var(--muted)', flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </div>

      {/* Card body */}
      {open && (
        <div style={{ padding: '14px 14px 0' }}>
          {plan.planStatus && plan.planStatus !== 'full' && (
            <div style={{
              marginBottom: 12,
              padding: '8px 11px',
              background: 'rgba(251,146,60,.07)',
              border: '1px solid rgba(251,146,60,.25)',
              borderRadius: 5,
              fontSize: 9,
              fontFamily: 'var(--fm)',
              color: '#fb923c',
              lineHeight: 1.55,
            }}>
              {plan.planStatus === 'stage1_2_draft'
                ? 'Stage 1/2-only draft. Review assumptions before coordination synthesis.'
                : 'Limited draft. Missing or stale Stage 2 handoff context may reduce specificity.'}
            </div>
          )}
          {plan.handoffWarnings?.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <BulletList items={plan.handoffWarnings} borderColor="rgba(251,146,60,.45)" />
            </div>
          )}
          {plan.executionSections?.length > 0 && (
            <PlanSection label="Atomized Execution Sections">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {plan.executionSections.map((section, sectionIdx) => (
                  <div key={section.atomId || sectionIdx} style={{
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    padding: '10px 11px',
                    background: 'var(--s2)',
                  }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text)', marginBottom: 5 }}>
                      {section.sectionName || `Execution section ${sectionIdx + 1}`}
                    </div>
                    {section.objective && (
                      <div style={{ fontSize: 10, color: 'var(--muted2)', lineHeight: 1.6, marginBottom: 7 }}>
                        {section.objective}
                      </div>
                    )}
                    <TwoCol
                      left={<PlanSection label="Execution Strategy" marginBottom={8}><BulletList items={section.executionStrategy} borderColor="rgba(59,130,246,.35)" /></PlanSection>}
                      right={<PlanSection label="Validation / Readiness" marginBottom={8}><BulletList items={section.validationReadinessChecks} borderColor="rgba(0,229,180,.35)" /></PlanSection>}
                      gap={12}
                    />
                    <TwoCol
                      left={<PlanSection label="Dependencies" marginBottom={8}><BulletList items={section.dependencies} borderColor="rgba(139,92,246,.35)" /></PlanSection>}
                      right={<PlanSection label="Risks / Unknowns" marginBottom={8}><BulletList items={[...(section.risks || []), ...(section.unknowns || [])]} borderColor="rgba(248,113,113,.35)" /></PlanSection>}
                      gap={12}
                    />
                  </div>
                ))}
              </div>
            </PlanSection>
          )}

          {/* Mission */}
          {plan.mission && (
            <div style={{
              marginBottom: 14,
              padding: '10px 13px',
              background: 'rgba(59,130,246,.05)',
              border: '1px solid rgba(59,130,246,.15)',
              borderRadius: 6,
            }}>
              <SectionLabel>Mission</SectionLabel>
              <div style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.7, fontStyle: 'italic' }}>
                {plan.mission}
              </div>
            </div>
          )}

          {plan.strategicRole && (
            <PlanSection label="Strategic Role">
              <div style={{ fontSize: 10, color: 'var(--muted2)', lineHeight: 1.7 }}>
                {plan.strategicRole}
              </div>
            </PlanSection>
          )}

          {/* Priority outcomes */}
          {priorityOutcomes?.length > 0 && (
            <PlanSection label="Priority Outcomes">
              <BulletList items={priorityOutcomes} borderColor="rgba(59,130,246,.4)" />
            </PlanSection>
          )}

          {/* Prioritised initiatives */}
          <PlanSection label="Execution Workstreams">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7, marginBottom: 2 }}>
              <InitiativeBlock label="🔴 Mission Critical" items={plan.initiativesMissionCritical} accentColor="#f87171" empty="None identified" />
              <InitiativeBlock label="🔵 Optional"         items={plan.initiativesOptional}        accentColor="#3b82f6" empty="None identified" />
              <InitiativeBlock label="⏱ Deferred"          items={plan.initiativesDeferred}        accentColor="#94a3b8" empty="None deferred"   />
              <InitiativeBlock label="🚫 Blocked"           items={plan.initiativesBlocked}         accentColor="#fb923c" empty="None blocked"    />
            </div>
          </PlanSection>

          {/* Sequencing + milestones */}
          {(plan.sequencingNarrative || plan.keyMilestones?.length > 0) && (
            <PlanSection label="Sequencing & Key Milestones">
              {plan.sequencingNarrative && (
                <div style={{ fontSize: 10, color: 'var(--muted2)', lineHeight: 1.7, marginBottom: 8, fontFamily: 'var(--fm)' }}>
                  {plan.sequencingNarrative}
                </div>
              )}
              <BulletList items={plan.keyMilestones} borderColor="rgba(0,229,180,.4)" />
            </PlanSection>
          )}

          {plan.executionLenses?.length > 0 && (
            <PlanSection label="Adaptive Execution Lenses">
              <LensList lenses={plan.executionLenses} />
            </PlanSection>
          )}

          {/* Dependencies + capabilities */}
          <TwoCol
            left={
              <PlanSection label="Cross-functional Dependencies">
                <BulletList items={plan.crossFunctionalDependencies} borderColor="rgba(139,92,246,.4)" empty="None identified" />
              </PlanSection>
            }
            right={
              <PlanSection label="Required Capabilities">
                <BulletList items={plan.requiredCapabilities} borderColor="rgba(59,130,246,.4)" empty="None identified" />
              </PlanSection>
            }
          />

          {/* Staffing + systems */}
          <TwoCol
            left={
              <PlanSection label="Staffing & Ownership">
                <BulletList items={plan.staffingOwnership} borderColor="rgba(251,146,60,.4)" empty="Not specified" />
              </PlanSection>
            }
            right={
              <PlanSection label="Systems & Tools">
                <BulletList items={plan.systemsTools} borderColor="rgba(148,163,184,.4)" empty="Not specified" />
              </PlanSection>
            }
          />

          {/* Governance + decision rights */}
          <TwoCol
            left={
              <PlanSection label="Governance Cadence">
                <BulletList items={plan.governanceCadence} borderColor="rgba(59,130,246,.35)" empty="Not specified" />
              </PlanSection>
            }
            right={
              <PlanSection label="Decision Rights">
                <BulletList items={plan.decisionRights} borderColor="rgba(59,130,246,.35)" empty="Not specified" />
              </PlanSection>
            }
          />

          {/* Risks / constraints / unknowns */}
          <PlanSection label="Risks · Constraints · Unknowns">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              <div>
                <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#f87171', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.05em' }}>Risks</div>
                <BulletList items={plan.risks} borderColor="rgba(248,113,113,.45)" empty="None identified" />
              </div>
              <div>
                <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#fb923c', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.05em' }}>Constraints</div>
                <BulletList items={plan.constraints} borderColor="rgba(251,146,60,.45)" empty="None identified" />
              </div>
              <div>
                <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#94a3b8', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.05em' }}>Unknowns</div>
                <BulletList items={plan.unresolvedUnknowns} borderColor="rgba(148,163,184,.45)" empty="None identified" />
              </div>
            </div>
          </PlanSection>

          {/* Assumptions */}
          {plan.assumptions?.length > 0 && (
            <PlanSection label="Assumptions">
              <div style={{
                background: 'var(--s2)', borderRadius: 5, padding: '10px 12px',
                border: '1px solid var(--border)',
              }}>
                <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', marginBottom: 8, display: 'flex', gap: 8 }}>
                  <Badge color="#3b82f6" small>fact</Badge>
                  <Badge color="#fb923c" small>inferred</Badge>
                  <Badge color="#f87171" small>speculative</Badge>
                  <span style={{ opacity: .6 }}>— assumption type labels</span>
                </div>
                {plan.assumptions.map((a, i) => (
                  <AssumptionItem key={i} assumption={a} />
                ))}
              </div>
            </PlanSection>
          )}

          {/* Metrics */}
          {hasMeasurement && (
          <PlanSection label="Measurement">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              <div>
                <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#00e5b4', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.05em' }}>Leading Indicators</div>
                <BulletList items={plan.leadingIndicators} borderColor="rgba(0,229,180,.4)" empty="Not defined" />
              </div>
              <div>
                <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#3b82f6', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.05em' }}>Success Metrics</div>
                <BulletList items={plan.keySuccessMetrics} borderColor="rgba(59,130,246,.4)" empty="Not defined" />
              </div>
              <div>
                <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#f87171', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.05em' }}>Failure Signals</div>
                <BulletList items={plan.failureSignals} borderColor="rgba(248,113,113,.4)" empty="Not defined" />
              </div>
            </div>
          </PlanSection>
          )}

          {/* Readiness assessment */}
          {plan.readinessAssessment && (
            <div style={{
              marginBottom: 14, padding: '10px 13px',
              background: `${readyColor(plan.organizationalReadiness)}0a`,
              border: `1px solid ${readyColor(plan.organizationalReadiness)}22`,
              borderRadius: 6,
              display: 'flex', alignItems: 'flex-start', gap: 10,
            }}>
              <Badge color={readyColor(plan.organizationalReadiness)}>
                {plan.organizationalReadiness} readiness
              </Badge>
              <div style={{ fontSize: 10, color: 'var(--muted2)', lineHeight: 1.65 }}>
                {plan.readinessAssessment}
              </div>
            </div>
          )}

          {/* Unit-level refinement panel */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, paddingBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: refineOpen ? 10 : 0 }}>
              <button
                onClick={() => { setRefineOpen(o => !o); setRefineError(null) }}
                disabled={globalBusy}
                style={{
                  fontSize: 9, fontFamily: 'var(--fm)', fontWeight: 600,
                  padding: '3px 10px', borderRadius: 4,
                  cursor: globalBusy ? 'not-allowed' : 'pointer',
                  background: refineOpen ? 'rgba(59,130,246,.12)' : 'var(--s2)',
                  border: `1px solid ${refineOpen ? 'rgba(59,130,246,.35)' : 'var(--border)'}`,
                  color: refineOpen ? 'var(--accent)' : 'var(--muted)',
                  transition: 'background .12s, color .12s',
                }}
              >
                ↻ Refine this unit plan {refineOpen ? '▲' : '▼'}
              </button>
              {aiDisabled && (
                <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
                  Requires API key
                </span>
              )}
            </div>

            {refineOpen && (
              <div style={{
                background: 'var(--s2)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '12px 12px 10px',
              }}>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>
                    Refinement instruction <span style={{ color: '#f87171' }}>*</span>
                  </div>
                  <textarea
                    value={refinePrompt}
                    onChange={e => setRefinePrompt(e.target.value)}
                    rows={3}
                    disabled={aiDisabled || isRefining}
                    placeholder={`e.g. ${plan.buName} is the primary client-facing channel — they need enablement, training, messaging consistency, adoption support, and feedback loops back to product and strategy.`}
                    style={{
                      width: '100%', boxSizing: 'border-box',
                      fontSize: 10, fontFamily: 'var(--fm)',
                      color: 'var(--text)', background: aiDisabled ? 'var(--s2)' : 'var(--surface)',
                      border: '1px solid var(--border)', borderRadius: 4,
                      padding: '7px 9px', resize: 'vertical', outline: 'none',
                      lineHeight: 1.6, opacity: aiDisabled ? 0.5 : 1,
                    }}
                  />
                </div>
                <ScopeSelector
                  value={refineScope}
                  onChange={setRefineScope}
                  disabled={aiDisabled || isRefining}
                />
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>
                    Impact summary <span style={{ opacity: .5 }}>(optional)</span>
                  </div>
                  <textarea
                    value={refineImpact}
                    onChange={e => setRefineImpact(e.target.value)}
                    rows={2}
                    disabled={aiDisabled || isRefining}
                    placeholder={`e.g. Shifts ${plan.buName} timeline right by 3 weeks; dependency on Legal now gates milestone 2.`}
                    style={{
                      width: '100%', boxSizing: 'border-box',
                      fontSize: 10, fontFamily: 'var(--fm)',
                      color: 'var(--text)', background: aiDisabled ? 'var(--s2)' : 'var(--surface)',
                      border: '1px solid var(--border)', borderRadius: 4,
                      padding: '7px 9px', resize: 'vertical', outline: 'none',
                      lineHeight: 1.6, opacity: aiDisabled ? 0.5 : 1,
                    }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button
                    onClick={handleRefine}
                    disabled={!canRefine}
                    style={{
                      fontSize: 9, fontFamily: 'var(--fm)', fontWeight: 600,
                      padding: '5px 14px', borderRadius: 4,
                      cursor: canRefine ? 'pointer' : 'not-allowed',
                      background: canRefine ? 'var(--accent)' : 'var(--s2)',
                      border: `1px solid ${canRefine ? 'var(--accent)' : 'var(--border)'}`,
                      color: canRefine ? '#000' : 'var(--muted)',
                      opacity: canRefine ? 1 : 0.6,
                      transition: 'background .12s, color .12s',
                    }}
                  >
                    {isRefining ? 'Regenerating…' : 'Regenerate this unit plan'}
                  </button>
                  {isRefining && (
                    <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
                      Regenerating "{plan.buName}" — preserving all other unit plans…
                    </span>
                  )}
                </div>
                {refineError && (
                  <div style={{
                    marginTop: 8, fontSize: 9, fontFamily: 'var(--fm)',
                    color: '#f87171', lineHeight: 1.6,
                    padding: '6px 9px', borderRadius: 4,
                    background: 'rgba(248,113,113,.07)', border: '1px solid rgba(248,113,113,.25)',
                    display: 'flex', gap: 5,
                  }}>
                    <span style={{ flexShrink: 0 }}>⚠</span> {refineError}
                  </div>
                )}
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  )
}

// ── Generate/Regenerate button ────────────────────────────────────────────────

function GenerateButton({ apiMode, isGenerating, isRegenerate, onGenerate, disabled, large }) {
  let label
  if (isGenerating)      label = 'Generating…'
  else if (apiMode === 'ai') label = isRegenerate ? 'Regenerate with AI' : 'Generate with AI'
  else                   label = isRegenerate ? 'Regenerate (mock)' : 'Generate (mock)'

  return (
    <button
      onClick={onGenerate}
      disabled={isGenerating || disabled}
      style={{
        fontSize: large ? 11 : 10, fontFamily: 'var(--fm)', fontWeight: 600,
        padding: large ? '9px 24px' : '6px 16px',
        borderRadius: 5, cursor: (isGenerating || disabled) ? 'not-allowed' : 'pointer',
        background: (isGenerating || disabled) ? 'var(--s2)' : 'var(--accent)',
        border: `1px solid ${(isGenerating || disabled) ? 'var(--border)' : 'var(--accent)'}`,
        color: (isGenerating || disabled) ? 'var(--muted)' : '#000',
        opacity: (isGenerating || disabled) ? 0.65 : 1,
        flexShrink: 0, transition: 'background .15s, color .15s',
      }}
    >
      {label}
    </button>
  )
}

// ── API mode status ───────────────────────────────────────────────────────────

function ApiModeStatus({ apiMode }) {
  if (apiMode === 'ai') {
    return (
      <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#00e5b4', display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: '50%', background: '#00e5b4', flexShrink: 0 }} />
        AI enabled · {AI_MODEL_LABEL}
      </div>
    )
  }
  return (
    <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#fb923c', display: 'flex', alignItems: 'center', gap: 4 }}>
      <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: '50%', background: '#fb923c', flexShrink: 0 }} />
      Mock mode — add VITE_ANTHROPIC_API_KEY for AI generation
    </div>
  )
}

// ── Main Stage 3 view ─────────────────────────────────────────────────────────

export default function Stage3View({
  workspace,
  workspaceId,
  stage1Revisions,
  stage1ActiveId,
  stage2Revisions,
  stage2ActiveId,
  stage3Revisions,
  stage3ActiveId,
  onSaveRevision,         // (revisionRecord) => void
  onNavigateToStage2,
  onNavigateToStage4,
  shouldAutoGenerate,     // boolean — set by Stage 2 "Regenerate & View Stage 3" CTA
  onAutoGenerateComplete, // () => void
}) {
  const [isGenerating, setIsGenerating] = useState(false)
  const [genError,     setGenError]     = useState(null)
  const [rawResponse,  setRawResponse]  = useState(null)
  const [showRaw,      setShowRaw]      = useState(false)
  const [compareRevId, setCompareRevId] = useState(null)
  const [isStageRefining, setIsStageRefining] = useState(false)
  const [generation, setGeneration] = useState(null)
  const [stage3DraftPlans, setStage3DraftPlans] = useState({})
  const [buPlanGeneration, setBuPlanGeneration] = useState({})
  const [stage12DraftOptIns, setStage12DraftOptIns] = useState({})
  const [coordinationDraft, setCoordinationDraft] = useState(null)
  const [coordinationGen, setCoordinationGen] = useState({ running: false, error: null })

  // ── Derived state ───────────────────────────────────────────────────────────
  const activeRev      = stage3Revisions.find(r => r.id === stage3ActiveId) ?? null
  const savedExecutionPlans = activeRev?.contentSnapshot?.executionPlans || []
  const savedSummaryNote    = activeRev?.contentSnapshot?.summaryNote    || ''
  const savedCoordinationLayer = activeRev?.contentSnapshot?.coordinationLayer || null
  const persistedExecutionPlans = Object.values(stage3DraftPlans).map(d => d?.plan).filter(Boolean)
  const executionPlans = generation
    ? (generation.buStates || []).map(bs => bs?.plan).filter(p => p && !p._error)
    : mergePlansByBuName(savedExecutionPlans, persistedExecutionPlans)
  const summaryNote    = generation?.summaryNote || savedSummaryNote
  const coordinationLayer = generation?.coordinationLayer || savedCoordinationLayer

  // Active upstream revisions
  const activeStage1Rev = stage1Revisions.find(r => r.id === stage1ActiveId) ?? null
  const activeStage2Rev = stage2Revisions.find(r => r.id === stage2ActiveId) ?? null

  // Stage 2 BU list (from active Stage 2 revision snapshot)
  const stage2BUs = activeStage2Rev?.contentSnapshot?.businessUnits || []

  // Staleness: Stage 3 is stale when Stage 1 OR Stage 2 changed after generation
  const latestStage3  = [...stage3Revisions].sort((a, b) => b.revisionNumber - a.revisionNumber)[0]
  const isStale       = !!(latestStage3 && (
    latestStage3.sourceBasisRevisionId  !== stage1ActiveId ||
    latestStage3.sourceStage2RevisionId !== stage2ActiveId
  ))

  const staleReason = latestStage3 && isStale
    ? (latestStage3.sourceBasisRevisionId  !== stage1ActiveId  ? 'Stage 1' :
       latestStage3.sourceStage2RevisionId !== stage2ActiveId  ? 'Stage 2' : 'upstream')
    : null

  const compareRevision = compareRevId ? stage3Revisions.find(r => r.id === compareRevId) ?? null : null
  const apiMode         = getApiMode()
  const effectiveWorkspaceId = workspaceId || workspace?.id || null
  const orderedStage2BUs = orderBusinessUnitsForStage3(stage2BUs, activeStage1Rev?.contentSnapshot)
  const readinessRows = orderedStage2BUs.map(unit => {
    const draft = readJsonStorage(stage2HandoffDraftKey(effectiveWorkspaceId, unit.name))
    return { unit, draft, readiness: summarizeHandoffReadiness(unit, draft) }
  })
  const coordinationReadiness = buildCoordinationReadiness(readinessRows, stage3DraftPlans)

  useEffect(() => {
    if (!effectiveWorkspaceId || !stage1ActiveId || !stage2ActiveId || !stage2BUs.length) {
      setStage3DraftPlans({})
      setCoordinationDraft(null)
      return
    }
    const hydrated = {}
    for (const bu of stage2BUs) {
      const key = stage3BuPlanDraftKey(effectiveWorkspaceId, stage1ActiveId, stage2ActiveId, bu.name)
      const draft = readJsonStorage(key)
      if (draft?.version === STAGE3_DRAFT_PLAN_VERSION && draft?.plan?.buName) {
        hydrated[bu.name] = draft
      }
    }
    setStage3DraftPlans(hydrated)
    const coordination = readJsonStorage(stage3CoordinationDraftKey(effectiveWorkspaceId, stage1ActiveId, stage2ActiveId))
    setCoordinationDraft(coordination?.version === 1 ? coordination : null)
  }, [effectiveWorkspaceId, stage1ActiveId, stage2ActiveId, activeStage2Rev?.id])

  function handleStage2HandoffAction(buName, itemKey, action) {
    writeJsonStorage('bsp_v1_stage2_handoff_focus', {
      workspaceId: effectiveWorkspaceId,
      businessUnitName: buName,
      itemKey,
      action,
      requestedAt: new Date().toISOString(),
      source: 'stage3',
    })
    onNavigateToStage2?.()
  }

  // ── Source rev labels ───────────────────────────────────────────────────────
  function sourceLabel(src) {
    if (src === 'ai')     return { text: 'AI-generated',   color: '#3b82f6'  }
    if (src === 'mock')   return { text: 'Mock-generated', color: '#fb923c'  }
    if (src === 'manual') return { text: 'Manual note',    color: 'rgba(255,255,255,.38)' }
    return { text: src,   color: 'var(--muted)' }
  }

  function revNum(id, revs) {
    const r = revs.find(r => r.id === id)
    return r ? `v${r.revisionNumber}` : '?'
  }

  // ── Auto-generate guard (same StrictMode-safe pattern as Stage 2) ──────────
  const autoGenConsumedRef = useRef(false)

  useEffect(() => {
    if (!shouldAutoGenerate) {
      autoGenConsumedRef.current = false
      return
    }
    if (!activeStage1Rev || !activeStage2Rev || autoGenConsumedRef.current) return
    autoGenConsumedRef.current = true
    onAutoGenerateComplete?.()
    handleGenerate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldAutoGenerate])

  // ── Full Stage 3 generation — hierarchical: structure → sections → assembly → coordination ──

  async function runChunkedStage3({ refinementPrompt = '', impactSummary = '', resume = false } = {}) {
    if (!activeStage1Rev || !activeStage2Rev) return { error: 'No active upstream revisions.' }
    setIsGenerating(true)
    setGenError(null)
    setRawResponse(null)
    setShowRaw(false)

    const s1Snap = activeStage1Rev.contentSnapshot
    const s2Snap = activeStage2Rev.contentSnapshot
    const source = hasApiKey() ? 'ai' : 'mock'

    // ── Mock path ────────────────────────────────────────────────────────────
    if (!hasApiKey()) {
      const mock = generateMockStage3(s1Snap, s2Snap)
      const learningSignals = deriveLearningSignals({
        stage: 'Stage 3', source: 'mock', prompt: refinementPrompt,
        impactSummary: impactSummary || 'Generated Stage 3 with mock generator',
        refinementType: refinementPrompt ? 'stage' : null, structuralImpact: 'none', stalenessEvents: [],
      })
      const nextNum = stage3Revisions.length + 1
      onSaveRevision(buildStage3RevisionRecord({
        executionPlans: mock.executionPlans, summaryNote: mock.summaryNote,
        coordinationLayer: mock.coordinationLayer, revisionNumber: nextNum,
        sourceBasisRevisionId: stage1ActiveId, sourceStage2RevisionId: stage2ActiveId,
        source: 'mock', prompt: refinementPrompt,
        impactSummary: impactSummary || `Generated from Stage 1 ${revNum(stage1ActiveId, stage1Revisions)} + Stage 2 ${revNum(stage2ActiveId, stage2Revisions)} via mock generator.`,
        refinementType: refinementPrompt ? 'stage' : null, affectedUnit: null,
        structuralImpact: 'none', refinementClassification: null, learningSignals,
      }))
      setGeneration(null)
      setIsGenerating(false)
      return { error: null }
    }

    // ── AI path ──────────────────────────────────────────────────────────────
    const units = s2Snap.businessUnits || []
    if (units.length === 0) { setIsGenerating(false); return { error: 'No business units in Stage 2.' } }

    const emptyBUState = () => ({ structureStatus: 'pending', structure: null, sectionStatuses: {}, sections: {}, plan: null })
    const resetInFlight = (status) => status === 'generating' ? 'pending' : status
    const normalizeResumeBUState = (bs) => {
      if (!bs) return emptyBUState()
      return {
        ...emptyBUState(),
        ...bs,
        structureStatus: resetInFlight(bs.structureStatus || 'pending'),
        sectionStatuses: Object.fromEntries(
          Object.entries(bs.sectionStatuses || {}).map(([key, status]) => [key, resetInFlight(status)]),
        ),
        plan: bs.plan && !bs.plan._error ? bs.plan : null,
      }
    }
    let hasQueuedStage3Call = false
    const callQueuedStage3AI = async (messages, options) => {
      if (hasQueuedStage3Call) await sleep(STAGE3_QUEUE_DELAY_MS)
      hasQueuedStage3Call = true
      return callAI(messages, options)
    }

    // Resume: keep completed structures/sections/plans and only retry failed or rate-limited chunks.
    let buStates = (resume && generation?.buStates?.length === units.length)
      ? generation.buStates.map(normalizeResumeBUState)
      : units.map(() => emptyBUState())

    setGeneration({
      phase: 'bu_phases', active: true, units, buStates: [...buStates],
      coordinationLayer: null, summaryNote: '',
      failedStep: null, failedIndices: [], failedSections: [], rateLimited: false,
      error: null, refinementPrompt, impactSummary,
    })

    const otherNames = (idx) => units.filter((_, i) => i !== idx).map(u => u.name).join(', ')
    const refinement = { prompt: refinementPrompt, impactSummary }
    const failedBUIndices = []

    // Process one BU fully through the global queue: structure → sections → assembly.
    async function processBU(idx) {
      const unit = units[idx]
      const currentState = buStates[idx] || emptyBUState()
      if (currentState.plan && !currentState.plan._error) return { ok: true }

      // ── Structure call ──────────────────────────────────────────────────
      let structure = currentState.structure
      if (!structure || currentState.structureStatus !== 'complete') {
        console.log(`[Stage3 API] BU structure start: ${unit.name}`)
        buStates[idx] = { ...emptyBUState(), ...currentState, structureStatus: 'generating', plan: null }
        setGeneration(g => ({ ...(g || {}), buStates: [...buStates] }))

        const { messages: strMsgs } = buildBUStructureMessages(s1Snap, unit, otherNames(idx), refinement)
        const strResponse = await callQueuedStage3AI(strMsgs, { temperature: 0.3, maxTokens: 900 })
        const { result: strResult, error: strError } = strResponse

        if (strError) {
          const rateLimited = isRateLimitedAIResponse(strResponse)
          console.log(`[Stage3 API] BU structure ${rateLimited ? 'rate limited' : 'failed'}: ${unit.name}`)
          buStates[idx] = {
            ...buStates[idx],
            structureStatus: rateLimited ? 'rate_limited' : 'failed',
            structure: { _error: strError },
          }
          setGeneration(g => ({ ...(g || {}), buStates: [...buStates] }))
          return { ok: false, rateLimited, failedIndex: idx, failedSection: null, error: strError }
        }

        const parsedStr = parseBUStructureResponse(strResult)
        if (parsedStr.error || !parsedStr.structure) {
          const err = parsedStr.error || 'Structure parse failed.'
          console.log(`[Stage3 API] BU structure failed: ${unit.name}`)
          buStates[idx] = { ...buStates[idx], structureStatus: 'failed', structure: { _error: err } }
          setGeneration(g => ({ ...(g || {}), buStates: [...buStates] }))
          return { ok: false, rateLimited: false, failedIndex: idx, failedSection: null, error: err }
        }

        console.log(`[Stage3 API] BU structure complete: ${unit.name} → sections: [${parsedStr.structure.sections.join(', ')}]`)
        structure = parsedStr.structure
        const sectionStatuses = Object.fromEntries(structure.sections.map(k => [k, 'pending']))
        buStates[idx] = { ...buStates[idx], structureStatus: 'complete', structure, sectionStatuses, sections: {} }
        setGeneration(g => ({ ...(g || {}), buStates: [...buStates] }))
      }

      // ── Section calls (global queue: one API call at a time) ───────────
      const sectionTokens = { workstreams: 1400, lenses: 1200, risk: 1000 }
      for (const sectionKey of structure.sections) {
        if (buStates[idx].sections?.[sectionKey] && !buStates[idx].sections[sectionKey]._error) {
          buStates[idx] = {
            ...buStates[idx],
            sectionStatuses: { ...buStates[idx].sectionStatuses, [sectionKey]: 'complete' },
          }
          setGeneration(g => ({ ...(g || {}), buStates: [...buStates] }))
          continue
        }

        console.log(`[Stage3 API] BU section start: ${unit.name} / ${sectionKey}`)
        buStates[idx] = {
          ...buStates[idx],
          sectionStatuses: { ...buStates[idx].sectionStatuses, [sectionKey]: 'generating' },
        }
        setGeneration(g => ({ ...(g || {}), buStates: [...buStates] }))

        const maxTok = sectionTokens[sectionKey] || 900
        const { messages: secMsgs } = buildBUSectionMessages(s1Snap, unit, structure, sectionKey, otherNames(idx), refinement)
        const secResponse = await callQueuedStage3AI(secMsgs, { temperature: 0.3, maxTokens: maxTok })
        const { result: secResult, error: secError } = secResponse

        if (secError) {
          const rateLimited = isRateLimitedAIResponse(secResponse)
          console.log(`[Stage3 API] BU section ${rateLimited ? 'rate limited' : 'failed'}: ${unit.name} / ${sectionKey}`)
          buStates[idx] = {
            ...buStates[idx],
            sectionStatuses: { ...buStates[idx].sectionStatuses, [sectionKey]: rateLimited ? 'rate_limited' : 'failed' },
            sections: { ...buStates[idx].sections, [sectionKey]: { _error: secError } },
          }
          setGeneration(g => ({ ...(g || {}), buStates: [...buStates] }))
          return { ok: false, rateLimited, failedIndex: idx, failedSection: sectionKey, error: secError }
        }

        const parsedSec = parseBUSectionResponse(sectionKey, secResult)
        if (parsedSec.error || !parsedSec.section) {
          const err = parsedSec.error || 'Section parse failed.'
          console.log(`[Stage3 API] BU section failed: ${unit.name} / ${sectionKey}`)
          buStates[idx] = {
            ...buStates[idx],
            sectionStatuses: { ...buStates[idx].sectionStatuses, [sectionKey]: 'failed' },
            sections: { ...buStates[idx].sections, [sectionKey]: { _error: err } },
          }
          setGeneration(g => ({ ...(g || {}), buStates: [...buStates] }))
          continue
        }

        console.log(`[Stage3 API] BU section complete: ${unit.name} / ${sectionKey}`)
        buStates[idx] = {
          ...buStates[idx],
          sectionStatuses: { ...buStates[idx].sectionStatuses, [sectionKey]: 'complete' },
          sections: { ...buStates[idx].sections, [sectionKey]: parsedSec.section },
        }
        setGeneration(g => ({ ...(g || {}), buStates: [...buStates] }))
      }

      // Check for section failures
      const failedSection = structure.sections.find(k => buStates[idx].sections[k]?._error)
      if (failedSection) {
        return { ok: false, rateLimited: false, failedIndex: idx, failedSection, error: buStates[idx].sections[failedSection]._error }
      }

      // ── Client-side assembly ────────────────────────────────────────────
      const plan = assembleBUPlan(structure, buStates[idx].sections)
      console.log(`[Stage3 API] BU complete: ${unit.name}`)
      buStates[idx] = { ...buStates[idx], plan }
      setGeneration(g => ({ ...(g || {}), buStates: [...buStates] }))
      return { ok: true }
    }

    // Run one global Stage 3 queue. This intentionally avoids nested BU/section fanout.
    const pendingIndices = units.map((_, i) => i).filter(i => !buStates[i]?.plan || buStates[i].plan._error)
    const failedSections = []
    let rateLimitPause = null
    for (const idx of pendingIndices) {
      const result = await processBU(idx)
      if (!result.ok) {
        failedBUIndices.push(idx)
        if (result.failedSection) failedSections.push({ unitIndex: idx, sectionKey: result.failedSection })
        if (result.rateLimited) {
          rateLimitPause = result
          break
        }
      }
    }

    if (failedBUIndices.length > 0) {
      const failedUnitName = units[rateLimitPause?.failedIndex]?.name
      const failedSectionName = rateLimitPause?.failedSection
        ? (SECTION_LABELS[rateLimitPause.failedSection] || rateLimitPause.failedSection)
        : 'structure'
      const err = rateLimitPause
        ? `Stage 3 hit API rate limiting at ${failedUnitName || 'a business unit'} / ${failedSectionName}. Completed sections were preserved. Resume after cooldown to retry only unfinished sections.`
        : `${failedSections.length || failedBUIndices.length} Stage 3 section(s) failed. Retry to resume only failed sections.`
      setGenError(err)
      setGeneration(g => ({
        ...(g || {}),
        active: false,
        failedIndices: failedBUIndices,
        failedSections,
        failedStep: rateLimitPause ? 'rate_limit' : 'section',
        rateLimited: !!rateLimitPause,
        error: err,
      }))
      setIsGenerating(false)
      return { error: err }
    }

    // ── Coordination synthesis ────────────────────────────────────────────────
    const completedPlans = buStates.map(bs => bs.plan).filter(p => p && !p._error)
    setGeneration(g => ({ ...(g || {}), phase: 'coordination' }))

    console.log('[Stage3 API] coordination start')
    const { messages: coordMsgs } = buildStage3CoordinationSynthesisMessages(s1Snap, completedPlans, refinement)
    const coordResponse = await callQueuedStage3AI(coordMsgs, { temperature: 0.3, maxTokens: 1800 })
    const { result: coordResult, error: coordError } = coordResponse

    if (coordError) {
      const rateLimited = isRateLimitedAIResponse(coordResponse)
      console.log('[Stage3 API] coordination failed')
      const err = rateLimited
        ? 'Stage 3 hit API rate limiting during coordination synthesis. Completed sections were preserved. Resume after cooldown to synthesize coordination and save the revision.'
        : coordError
      setGenError(err)
      setGeneration(g => ({ ...(g || {}), active: false, failedStep: 'coordination', rateLimited, error: err }))
      setIsGenerating(false)
      return { error: err }
    }

    const parsedCoord = parseStage3CoordinationSynthesisResponse(coordResult)
    if (parsedCoord.error || !parsedCoord.coordinationLayer) {
      const parseError = parsedCoord.error || 'Coordination synthesis parse failed.'
      console.log('[Stage3 API] coordination failed')
      setGenError(parseError)
      setGeneration(g => ({ ...(g || {}), active: false, failedStep: 'coordination', error: parseError }))
      setIsGenerating(false)
      return { error: parseError }
    }

    console.log('[Stage3 API] coordination complete')
    const coordination = parsedCoord.coordinationLayer
    const note         = parsedCoord.summaryNote
    setGeneration(g => ({ ...(g || {}), coordinationLayer: coordination, summaryNote: note }))

    // Learning signals — heuristic only, synchronous
    const learningSignals = deriveLearningSignals({
      stage: 'Stage 3', source: 'ai', prompt: refinementPrompt,
      impactSummary: impactSummary || (refinementPrompt
        ? 'Regenerated Stage 3 with hierarchical BU-first AI orchestration'
        : 'Generated Stage 3 with hierarchical BU-first AI orchestration'),
      refinementType: refinementPrompt ? 'stage' : null, structuralImpact: 'none', stalenessEvents: [],
    })

    const nextNum = stage3Revisions.length + 1
    onSaveRevision(buildStage3RevisionRecord({
      executionPlans: completedPlans, summaryNote: note, coordinationLayer: coordination,
      revisionNumber: nextNum, sourceBasisRevisionId: stage1ActiveId, sourceStage2RevisionId: stage2ActiveId,
      source: 'ai', prompt: refinementPrompt,
      impactSummary: impactSummary || `Generated from Stage 1 ${revNum(stage1ActiveId, stage1Revisions)} + Stage 2 ${revNum(stage2ActiveId, stage2Revisions)} via ${AI_MODEL_LABEL} hierarchical orchestration.`,
      refinementType: refinementPrompt ? 'stage' : null, affectedUnit: null,
      structuralImpact: 'none', refinementClassification: null, learningSignals,
    }))
    setGeneration(null)
    setIsGenerating(false)
    return { error: null }
  }

  const handleGenerate = useCallback(async () => runChunkedStage3(), [activeStage1Rev, activeStage2Rev, stage1ActiveId, stage2ActiveId, stage1Revisions, stage2Revisions, stage3Revisions.length, onSaveRevision])

  const handleRetryGeneration = useCallback(async () => runChunkedStage3({
    refinementPrompt: generation?.refinementPrompt || '',
    impactSummary: generation?.impactSummary || '',
    resume: true,
  }), [generation, activeStage1Rev, activeStage2Rev, stage1ActiveId, stage2ActiveId, stage3Revisions.length, onSaveRevision])

  // ── Unit-level refinement ───────────────────────────────────────────────────
  function persistBuPlanDraft(unit, plan, readiness, source, executionAtoms = []) {
    const now = new Date().toISOString()
    const draft = {
      version: STAGE3_DRAFT_PLAN_VERSION,
      businessUnitName: unit.name,
      sourceBasisRevisionId: stage1ActiveId,
      sourceStage2RevisionId: stage2ActiveId,
      plan,
      executionAtoms,
      atomSummary: summarizeAtoms(executionAtoms),
      planStatus: readiness.completion === 'full' ? 'full' : readiness.completion === 'none' ? 'stage1_2_draft' : 'limited_draft',
      planGenerationMode: readiness.completion === 'full' ? 'full' : readiness.completion === 'none' ? 'stage1_2_only' : 'limited',
      handoffStatus: readiness.status,
      readinessSummary: {
        completion: readiness.completion,
        readyCount: readiness.readyCount,
        usableCount: readiness.usableCount,
        staleCount: readiness.staleCount,
        failedCount: readiness.failedCount,
      },
      source,
      lastSavedAt: now,
    }
    const key = stage3BuPlanDraftKey(effectiveWorkspaceId, stage1ActiveId, stage2ActiveId, unit.name)
    writeJsonStorage(key, draft)
    logExecutiveBoundary(unit, 'H. persistedStage3State', draft)
    setStage3DraftPlans(prev => ({ ...prev, [unit.name]: draft }))
  }

  async function handleGenerateBUPlan(unit, readiness) {
    if (!activeStage1Rev || !activeStage2Rev) return { error: 'No active upstream revisions.' }
    const s1Snap = activeStage1Rev.contentSnapshot
    const enrichedUnit = { ...unit, stage3PlanningContext: readiness.planningContext }
    const otherNames = orderedStage2BUs.filter(u => u.name !== unit.name).map(u => u.name).join(', ')
    const stage2HandoffInput = readJsonStorage(stage2HandoffDraftKey(effectiveWorkspaceId, unit.name))
    const handoffBrief = readiness.planningContext?.handoffBrief || readiness.handoffBrief || null
    console.info('[Stage3 Handoff Brief]', {
      businessUnitName: unit.name,
      briefSizeBytes: handoffBrief?.metadata?.briefSizeBytes || byteSize(handoffBrief),
      sourceDetailExcludedFromStage3Generation: handoffBrief?.metadata?.sourceDetailExcludedFromStage3Generation !== false,
      sourceStage2SectionIds: handoffBrief?.sourceStage2SectionIds || [],
    })
    logExecutiveBoundary(unit, 'A. selectedBusinessUnit', {
      id: unit.id || unit.name,
      name: unit.name,
      readinessState: readiness,
      handoff: {
        id: stage2HandoffInput?.id || stage2HandoffInput?.businessUnitName || null,
        version: stage2HandoffInput?.version || null,
        hash: stage3TraceHash(stage2HandoffInput),
      },
    })
    logExecutiveBoundary(unit, 'B. stage2HandoffInput', stage2HandoffInput)
    logExecutiveBoundary(unit, 'C. normalizedStage3Input', enrichedUnit)
    const modeLabel = readiness.completion === 'full'
      ? 'full'
      : readiness.completion === 'none'
        ? 'Stage 1/2-only draft'
        : 'limited draft'

    setBuPlanGeneration(prev => ({ ...prev, [unit.name]: { running: true, error: null } }))
    setGenError(null)

    try {
      const mode = readiness.completion === 'full'
        ? 'full'
        : readiness.completion === 'none'
          ? 'stage1_2_only'
          : 'limited'
      const isExecutiveGeneration = isExecutiveTraceUnit(unit)
      const priorDraft = stage3DraftPlans[unit.name] || null
      let atoms = buildExecutionAtomsForBU(unit, readiness, priorDraft, mode)
      logExecutiveBoundary(unit, 'C2. executionAtoms', atoms)

      if (isExecutiveGeneration && USE_STAGE3_EXECUTIVE_FIXTURE) {
        const fixturePlan = buildExecutiveLeadershipFixturePlan(unit, readiness)
        const fixtureAtoms = atoms.map(atom => ({
          ...atom,
          status: ATOM_STATUSES.COMPLETE,
          parsedValue: {
            sectionName: atom.elementName,
            objective: 'Fixture-backed Executive Leadership vertical slice. Live AI generation is intentionally disabled for this slice until the structured UI is reviewable.',
          },
          completedAt: new Date().toISOString(),
          metadata: { ...(atom.metadata || {}), fixture: true },
        }))
        logExecutiveBoundary(unit, 'Fixture. structuredExecutivePlan', fixturePlan)
        persistBuPlanDraft(unit, fixturePlan, readiness, 'fixture', fixtureAtoms)
        setBuPlanGeneration(prev => ({ ...prev, [unit.name]: { running: false, error: null, atomSummary: summarizeAtoms(fixtureAtoms) } }))
        return { error: null }
      }

      if (!hasApiKey()) {
        atoms = atoms.map(atom => ({
          ...atom,
          status: ATOM_STATUSES.COMPLETE,
          parsedValue: {
            sectionName: atom.elementName,
            objective: `${unit.name} drafts ${atom.elementName} from available Stage 1/2 context.`,
            executionStrategy: [atom.metadata?.handoffItem?.detail || atom.metadata?.handoffItem?.text || 'Use available strategy and BU context.'],
            decisionsRequired: [],
            sequencingAndGates: [],
            dependencies: unit.dependencies || [],
            risks: unit.risksAndUnknowns || [],
            constraints: [],
            unknowns: readiness.completion === 'none' ? ['Stage 2 handoff context has not been generated.'] : [],
            validationReadinessChecks: unit.keySuccessMetrics || [],
            ownershipGovernance: unit.keyResponsibilities || [],
            successIndicators: unit.keySuccessMetrics || [],
            failureSignals: [],
            stage4DeliveryImplications: [],
          },
          completedAt: new Date().toISOString(),
        }))
        const plan = assembleAtomizedBUPlan(unit, readiness, atoms, mode)
        persistBuPlanDraft(unit, plan, readiness, 'mock', atoms)
        setBuPlanGeneration(prev => ({ ...prev, [unit.name]: { running: false, error: null } }))
        return { error: null }
      }

      const updatedAtoms = await runGenerationQueue({
        atoms,
        concurrency: 1,
        delayMs: isExecutiveGeneration ? EXECUTIVE_STAGE3_QUEUE_DELAY_MS : STAGE3_QUEUE_DELAY_MS,
        retryFailedOnly: true,
        retry: isExecutiveGeneration ? EXECUTIVE_STAGE3_RETRY : null,
        onAtomUpdate: (atom, allAtoms) => {
          const plan = assembleAtomizedBUPlan(unit, readiness, allAtoms, mode)
          persistBuPlanDraft(unit, plan, readiness, 'ai', allAtoms)
          setBuPlanGeneration(prev => ({
            ...prev,
            [unit.name]: { running: true, error: null, atomSummary: summarizeAtoms(allAtoms) },
          }))
        },
        worker: async (atom) => {
          console.log(`[Stage3 API] BU execution atom start: ${unit.name} / ${atom.elementName}`)
          const { messages } = buildStage3ExecutionAtomMessages(
            s1Snap,
            enrichedUnit,
            atom.metadata?.handoffItem || { key: atom.childKey, label: atom.elementName },
            mode,
            otherNames,
          )
          logExecutiveBoundary(unit, `D. stage3PromptPayload / ${atom.childKey}`, messages)
          const response = await callAI(messages, { temperature: 0.3, maxTokens: 1300 })
          logExecutiveBoundary(unit, `E. rawModelResponse / ${atom.childKey}`, response.result || response.error)
          if (response.error) {
            const message = isRateLimitedAIResponse(response)
              ? `Rate limited while generating ${unit.name} / ${atom.elementName}. Retry this atom after cooldown.`
              : response.error
            throw { message, rawResponseText: response.result || null, status: response.status, rateLimited: response.rateLimited }
          }
          const parsed = parseStage3ExecutionAtomResponse(response.result)
          logExecutiveBoundary(unit, `F. parsedStage3Result / ${atom.childKey}`, parsed)
          if (parsed.error || !parsed.section) {
            throw { message: parsed.error || 'Execution atom parse failed.', rawResponseText: response.result || null }
          }
          const validation = isExecutiveGeneration
            ? validateExecutiveStage3Atom(parsed.section)
            : { pass: true, reason: null }
          logExecutiveBoundary(unit, `G. atomValidationResults / ${atom.childKey}`, {
            atomKey: atom.childKey,
            parsedValue: parsed.section,
            validationPass: validation.pass,
            failureReason: validation.reason,
          })
          if (!validation.pass) {
            throw {
              message: `Execution atom validation failed: ${validation.reason}`,
              rawResponseText: response.result || null,
              failureLabel: 'validation_failed',
            }
          }
          return { rawResponseText: response.result, parsedValue: parsed.section }
        },
      })

      const plan = assembleAtomizedBUPlan(unit, readiness, updatedAtoms, mode)
      persistBuPlanDraft(unit, plan, readiness, 'ai', updatedAtoms)
      setBuPlanGeneration(prev => ({ ...prev, [unit.name]: { running: false, error: null } }))
      return { error: null }
    } catch (err) {
      const message = err?.message || String(err)
      setBuPlanGeneration(prev => ({ ...prev, [unit.name]: { running: false, error: message } }))
      return { error: message }
    }
  }

  async function handleGenerateCoordination(provisional) {
    if (!activeStage1Rev) return { error: 'No active Stage 1 revision.' }
    if (!coordinationReadiness.canSynthesize) return { error: 'Not enough BU execution plans for coordination synthesis.' }
    setCoordinationGen({ running: true, error: null })
    const mode = provisional ? 'provisional' : 'full'

    try {
      let coordinationLayer
      let summaryNote
      if (!hasApiKey()) {
        coordinationLayer = {
          executionSummary: `${mode === 'provisional' ? 'Provisional' : 'Full'} coordination synthesis from ${coordinationReadiness.plans.length} generated BU plan drafts.`,
          sequencingOverview: 'Mock coordination uses generated BU plan draft coverage and should be reviewed before use.',
          dependencyCoordinationMap: coordinationReadiness.plans.flatMap(plan => plan.crossFunctionalDependencies || []).slice(0, 8),
          governanceModel: coordinationReadiness.plans.flatMap(plan => plan.governanceCadence || plan.decisionRights || []).slice(0, 6),
          organizationalBottlenecks: coordinationReadiness.plans.flatMap(plan => plan.constraints || []).slice(0, 6),
          sharedRisks: coordinationReadiness.plans.flatMap(plan => plan.risks || []).slice(0, 6),
          sharedUnknowns: coordinationReadiness.plans.flatMap(plan => plan.unresolvedUnknowns || []).slice(0, 6),
          operationalReadinessOverview: provisional ? 'Partial BU coverage; treat this as provisional.' : 'All required BU plans are represented.',
          crossFunctionalSuccessMetrics: coordinationReadiness.plans.flatMap(plan => plan.keySuccessMetrics || []).slice(0, 6),
          escalationDecisionOwnership: coordinationReadiness.plans.flatMap(plan => plan.decisionRights || []).slice(0, 6),
          criticalExecutionPath: coordinationReadiness.plans.flatMap(plan => plan.criticalWorkstreams || []).slice(0, 6),
          parallelizableWorkstreams: coordinationReadiness.plans.flatMap(plan => plan.executionSections?.map(s => s.sectionName) || []).slice(0, 6),
          confidenceReadinessAssessment: provisional ? 'Low confidence until missing BU plans are generated.' : 'Medium confidence based on complete BU plan coverage.',
        }
        summaryNote = coordinationLayer.executionSummary
      } else {
        const { messages } = buildStage3CoordinationSynthesisMessages(activeStage1Rev.contentSnapshot, coordinationReadiness.plans, {
          prompt: provisional
            ? 'Generate provisional coordination only. Clearly mark that not all required BU execution plans are complete.'
            : 'Generate full coordination from all required completed BU execution plans.',
          impactSummary: `${mode} coordination synthesis from generated BU execution plans.`,
        })
        const response = await callAI(messages, { temperature: 0.3, maxTokens: 1800 })
        if (response.error) throw new Error(response.error)
        const parsed = parseStage3CoordinationSynthesisResponse(response.result)
        if (parsed.error || !parsed.coordinationLayer) throw new Error(parsed.error || 'Coordination synthesis parse failed.')
        coordinationLayer = parsed.coordinationLayer
        summaryNote = parsed.summaryNote
      }

      const draft = {
        version: 1,
        mode,
        sourceBasisRevisionId: stage1ActiveId,
        sourceStage2RevisionId: stage2ActiveId,
        planCount: coordinationReadiness.plans.length,
        requiredPlanCount: readinessRows.length,
        coordinationLayer,
        summaryNote,
        generatedAt: new Date().toISOString(),
      }
      writeJsonStorage(stage3CoordinationDraftKey(effectiveWorkspaceId, stage1ActiveId, stage2ActiveId), draft)
      setCoordinationDraft(draft)
      setCoordinationGen({ running: false, error: null })
      return { error: null }
    } catch (err) {
      const message = err?.message || String(err)
      setCoordinationGen({ running: false, error: message })
      return { error: message }
    }
  }

  const handleUnitRegenerate = useCallback(async (planIndex, refinementPrompt, impactSummary, refinementScope) => {
    if (!activeStage1Rev)  return { error: 'No active Stage 1 revision.' }
    if (!activeStage2Rev)  return { error: 'No active Stage 2 revision.' }
    if (!hasApiKey())      return { error: 'API key required for unit regeneration.' }
    if (!activeRev)        return { error: 'No active Stage 3 revision to update.' }

    const s1Snap = activeStage1Rev.contentSnapshot
    const s2Snap = activeStage2Rev.contentSnapshot

    const { messages } = buildStage3UnitRefinementMessages(
      s1Snap, s2Snap, executionPlans, planIndex, refinementPrompt, refinementScope,
    )
    const { result, error } = await callAI(messages, { temperature: 0.3, maxTokens: 3000 })
    if (error) return { error }

    const parsed = parseStage3UnitResponse(result)
    if (parsed.error || !parsed.plan) return { error: parsed.error || 'Response parse failed.' }

    const updatedPlans = executionPlans.map((p, i) => (i === planIndex ? parsed.plan : p))
    const unitName     = executionPlans[planIndex]?.buName || `Unit ${planIndex + 1}`
    const learningSignals = await collectStage3LearningSignals({
      source: 'ai',
      prompt: refinementPrompt,
      impactSummary: impactSummary || `Regenerated "${unitName}"`,
      refinementType: 'unit',
      refinementScope,
      affectedUnit: unitName,
      beforeAfterSummary: 'One Stage 3 business-unit execution plan was regenerated and merged back into the stage-level package.',
    }, true)

    const nextNum = stage3Revisions.length + 1
    const record  = buildStage3RevisionRecord({
      executionPlans:         updatedPlans,
      summaryNote,
      coordinationLayer,
      revisionNumber:         nextNum,
      sourceBasisRevisionId:  activeRev.sourceBasisRevisionId,
      sourceStage2RevisionId: activeRev.sourceStage2RevisionId,
      source:                 'ai',
      prompt:                 refinementPrompt,
      impactSummary:          impactSummary || `Regenerated "${unitName}": ${refinementPrompt.slice(0, 80)}${refinementPrompt.length > 80 ? '…' : ''}`,
      refinementType:         'unit',
      affectedUnit:           unitName,
      refinementScope,
      learningSignals,
    })

    onSaveRevision(record)
    return { error: null }
  }, [activeStage1Rev, activeStage2Rev, activeRev, executionPlans, summaryNote, stage3Revisions.length, onSaveRevision])

  // ── Stage-level correction ──────────────────────────────────────────────────
  async function handleStageRefinement({ prompt, impactSummary }) {
    if (!activeRev) return

    if (hasApiKey()) {
      if (!activeStage1Rev) return { error: 'No active Stage 1 revision.' }
      if (!activeStage2Rev) return { error: 'No active Stage 2 revision.' }
      setIsStageRefining(true)
      const result = await runChunkedStage3({ refinementPrompt: prompt, impactSummary })
      setIsStageRefining(false)
      return result
    }

    const learningSignals = deriveLearningSignals({
      stage: 'Stage 3',
      source: 'manual',
      prompt,
      impactSummary,
      refinementType: 'stage',
      structuralImpact: 'none',
    })
    const nextNum = stage3Revisions.length + 1
    const record  = buildStage3RevisionRecord({
      executionPlans: activeRev.contentSnapshot.executionPlans,
      summaryNote:    activeRev.contentSnapshot.summaryNote,
      coordinationLayer: activeRev.contentSnapshot.coordinationLayer,
      revisionNumber:         nextNum,
      sourceBasisRevisionId:  activeRev.sourceBasisRevisionId,
      sourceStage2RevisionId: activeRev.sourceStage2RevisionId,
      source:                 'manual',
      prompt,
      impactSummary,
      refinementType:         'stage',
      affectedUnit:           null,
      structuralImpact:       'none',
      learningSignals,
    })
    onSaveRevision(record)
    return { error: null }
  }

  // ── Guard: no Stage 2 revisions ─────────────────────────────────────────────
  if (stage2Revisions.length === 0) {
    return (
      <div style={{ maxWidth: 840, padding: '0 16px 40px' }}>
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--r)', padding: '40px 32px', textAlign: 'center',
        }}>
          <div style={{ fontSize: 24, opacity: .15, marginBottom: 16, lineHeight: 1 }}>▦</div>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Stage 2 required</div>
          <div style={{ fontSize: 11, color: 'var(--muted2)', fontFamily: 'var(--fm)', lineHeight: 1.7, maxWidth: 380, margin: '0 auto' }}>
            Stage 3 requires an active Stage 2 business unit mapping. Go to Stage 2 and generate the BU structure first.
          </div>
        </div>
      </div>
    )
  }

  // ── Empty state (no Stage 3 revisions) ─────────────────────────────────────
  if (stage3Revisions.length === 0) {
    return (
      <div style={{ maxWidth: 840, padding: '0 16px 40px' }}>
        <Stage3ReadinessPanels
          rows={readinessRows}
          planDrafts={stage3DraftPlans}
          planGeneration={buPlanGeneration}
          draftOptIns={stage12DraftOptIns}
          onOptIntoStage12Draft={buName => setStage12DraftOptIns(prev => ({ ...prev, [buName]: true }))}
          onGenerateBUPlan={handleGenerateBUPlan}
          onStage2Action={handleStage2HandoffAction}
          apiMode={apiMode}
          disabled={!activeStage1Rev || !activeStage2Rev || isGenerating}
          generationEnabled
        />
        <CoordinationReadinessPanel
          readiness={coordinationReadiness}
          coordinationDraft={coordinationDraft}
          isGenerating={coordinationGen.running}
          error={coordinationGen.error}
          onGenerate={handleGenerateCoordination}
        />
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--r)', padding: '40px 32px', textAlign: 'center', marginBottom: 12,
        }}>
          <div style={{ fontSize: 24, opacity: .15, marginBottom: 16, lineHeight: 1 }}>▦</div>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Execution Planning</div>
          <div style={{ fontSize: 11, color: 'var(--muted2)', fontFamily: 'var(--fm)', lineHeight: 1.7, maxWidth: 460, margin: '0 auto 24px' }}>
            {apiMode === 'ai'
              ? `Generate AI execution plans for all ${stage2BUs.length} Stage 2 business units. Plans will include prioritised initiatives, sequencing, dependencies, constraints, unknowns, and measurement.`
              : `Generate mock execution plans for ${stage2BUs.length} Stage 2 business units. Add VITE_ANTHROPIC_API_KEY to .env.local and restart for AI generation.`}
          </div>

          {(!activeStage1Rev || !activeStage2Rev) && (
            <div style={{
              fontSize: 10, color: '#f87171', marginBottom: 16, padding: '8px 14px',
              background: 'rgba(248,113,113,.06)', border: '1px solid rgba(248,113,113,.25)',
              borderRadius: 5, fontFamily: 'var(--fm)', display: 'inline-block',
            }}>
              {!activeStage1Rev ? 'No active Stage 1 revision.' : 'No active Stage 2 revision.'} Go back and complete it first.
            </div>
          )}

          <GenerateButton
            apiMode={apiMode} isGenerating={isGenerating} isRegenerate={false}
            onGenerate={handleGenerate} disabled={!activeStage1Rev || !activeStage2Rev} large
          />
          <div style={{ marginTop: 10 }}>
            <ApiModeStatus apiMode={apiMode} />
          </div>

          {genError && (
            <div style={{
              fontSize: 10, color: '#f87171', marginTop: 16, padding: '8px 14px',
              background: 'rgba(248,113,113,.06)', border: '1px solid rgba(248,113,113,.25)',
              borderRadius: 5, fontFamily: 'var(--fm)', textAlign: 'left',
              display: 'flex', flexDirection: 'column', gap: 6,
            }}>
              <div style={{ display: 'flex', gap: 6 }}><span style={{ flexShrink: 0 }}>⚠</span> {genError}</div>
              {rawResponse && (
                <button onClick={() => setShowRaw(s => !s)} style={{
                  fontSize: 8, fontFamily: 'var(--fm)', padding: '2px 8px', borderRadius: 3,
                  cursor: 'pointer', background: 'var(--s2)',
                  border: '1px solid var(--border)', color: 'var(--muted)', alignSelf: 'flex-start',
                }}>
                  {showRaw ? 'Hide raw' : 'Show raw response'}
                </button>
              )}
              {showRaw && rawResponse && (
                <pre style={{
                  fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted2)',
                  background: 'var(--s2)', borderRadius: 4, padding: '8px 10px',
                  overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  maxHeight: 200, overflowY: 'auto', margin: 0,
                }}>
                  {rawResponse}
                </pre>
              )}
            </div>
          )}
        </div>
        <GenerationProgress generation={generation} onRetry={handleRetryGeneration} />
        <CoordinationLayer layer={coordinationLayer} />
        {executionPlans.map((plan, i) => (
          <PlanCard
            key={`${plan.buName}-${i}`}
            plan={plan}
            index={i}
            apiMode={apiMode}
            globalBusy
            onRefineUnit={(prompt, impact, scope) => handleUnitRegenerate(i, prompt, impact, scope)}
          />
        ))}
      </div>
    )
  }

  // ── Main view (has revisions) ───────────────────────────────────────────────
  const srcLbl = sourceLabel(activeRev?.source)

  return (
    <div style={{ maxWidth: 840, padding: '0 16px 40px' }}>

      {/* ── Status header ─────────────────────────────────────────────────── */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--r)', padding: '14px 16px', marginBottom: 12,
        display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
            Execution Planning
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Badge color={srcLbl.color}>{srcLbl.text}</Badge>
            {activeRev && (
              <span style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
                v{activeRev.revisionNumber} · {new Date(activeRev.createdAt).toLocaleDateString()}
              </span>
            )}
            {activeRev?.sourceBasisRevisionId && (
              <span style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
                Stage 1 {revNum(activeRev.sourceBasisRevisionId, stage1Revisions)}
              </span>
            )}
            {activeRev?.sourceStage2RevisionId && (
              <span style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
                Stage 2 {revNum(activeRev.sourceStage2RevisionId, stage2Revisions)}
              </span>
            )}
            <span style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
              {executionPlans.length} unit{executionPlans.length !== 1 ? 's' : ''}
            </span>
          </div>
          {summaryNote && (
            <div style={{ fontSize: 10, color: 'var(--muted2)', lineHeight: 1.65, marginTop: 8, fontFamily: 'var(--fm)' }}>
              {summaryNote}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <GenerateButton
            apiMode={apiMode} isGenerating={isGenerating} isRegenerate
            onGenerate={handleGenerate} disabled={!activeStage1Rev || !activeStage2Rev}
          />
          <ApiModeStatus apiMode={apiMode} />
        </div>
      </div>

      <Stage3ReadinessPanels
        rows={readinessRows}
        planDrafts={stage3DraftPlans}
        planGeneration={buPlanGeneration}
        draftOptIns={stage12DraftOptIns}
        onOptIntoStage12Draft={buName => setStage12DraftOptIns(prev => ({ ...prev, [buName]: true }))}
        onGenerateBUPlan={handleGenerateBUPlan}
        onStage2Action={handleStage2HandoffAction}
        apiMode={apiMode}
        disabled={!activeStage1Rev || !activeStage2Rev || isGenerating}
        generationEnabled
      />
      <CoordinationReadinessPanel
        readiness={coordinationReadiness}
        coordinationDraft={coordinationDraft}
        isGenerating={coordinationGen.running}
        error={coordinationGen.error}
        onGenerate={handleGenerateCoordination}
      />

      {/* ── Staleness banner ──────────────────────────────────────────────── */}
      {isStale && (
        <div style={{
          background: 'rgba(251,146,60,.06)', border: '1px solid rgba(251,146,60,.35)',
          borderRadius: 'var(--r)', padding: '12px 16px', marginBottom: 12,
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 10, fontFamily: 'var(--fm)' }}>⚠</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#fb923c', marginBottom: 2 }}>
              Stage 3 is stale
            </div>
            <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.6 }}>
              {staleReason} has changed since this Stage 3 was generated.
              Regenerate to re-align the execution plans, or keep the existing plans.
            </div>
          </div>
          <button
            onClick={handleGenerate}
            disabled={isGenerating || !activeStage1Rev || !activeStage2Rev}
            style={{
              flexShrink: 0, fontSize: 9, fontFamily: 'var(--fm)', fontWeight: 600,
              padding: '5px 14px', borderRadius: 5, cursor: 'pointer',
              background: 'rgba(251,146,60,.15)', border: '1px solid rgba(251,146,60,.4)',
              color: '#fb923c',
            }}
          >
            {isGenerating ? 'Generating…' : 'Regenerate Stage 3'}
          </button>
        </div>
      )}

      {/* ── Generation error ──────────────────────────────────────────────── */}
      {genError && (
        <div style={{
          fontSize: 10, color: '#f87171', marginBottom: 12, padding: '10px 14px',
          background: 'rgba(248,113,113,.06)', border: '1px solid rgba(248,113,113,.25)',
          borderRadius: 'var(--r)', fontFamily: 'var(--fm)',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <span style={{ flexShrink: 0 }}>⚠</span> <span>{genError}</span>
          </div>
          {rawResponse && (
            <button onClick={() => setShowRaw(s => !s)} style={{
              fontSize: 8, fontFamily: 'var(--fm)', padding: '2px 8px', borderRadius: 3,
              cursor: 'pointer', background: 'var(--s2)',
              border: '1px solid var(--border)', color: 'var(--muted)',
            }}>
              {showRaw ? 'Hide raw response' : 'Show raw response'}
            </button>
          )}
          {showRaw && rawResponse && (
            <pre style={{
              fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted2)',
              background: 'var(--s2)', borderRadius: 4, padding: '8px 10px',
              overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              maxHeight: 200, overflowY: 'auto', margin: 0,
            }}>
              {rawResponse}
            </pre>
          )}
        </div>
      )}

      {/* ── Execution plan cards ──────────────────────────────────────────── */}
      <GenerationProgress generation={generation} onRetry={handleRetryGeneration} />
      <CoordinationLayer layer={coordinationLayer} />

      {executionPlans.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{
            fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            Execution Plans
            <span style={{
              padding: '1px 6px', borderRadius: 3,
              background: 'var(--s2)', border: '1px solid var(--border)',
              fontSize: 8, color: 'var(--muted)',
            }}>
              {executionPlans.length}
            </span>
            {apiMode === 'ai' && (
              <span style={{ fontSize: 8, opacity: .65 }}>
                · Each card has a localised ↻ Refine panel
              </span>
            )}
          </div>
          {executionPlans.map((plan, i) => (
            <PlanCard
              key={i}
              plan={plan}
              index={i}
              apiMode={apiMode}
              globalBusy={isGenerating}
              onRefineUnit={(prompt, impact, scope) => handleUnitRegenerate(i, prompt, impact, scope)}
            />
          ))}
        </div>
      )}

      {/* ── Diff viewer ───────────────────────────────────────────────────── */}
      <LearningSignals signals={activeRev?.contentSnapshot?.learningSignals || activeRev?.learningSignals} />

      {compareRevision && activeRev && (
        <RevisionDiffViewer
          revA={compareRevision}
          revB={activeRev}
          toText={stage3SnapshotToText}
          onClose={() => setCompareRevId(null)}
        />
      )}

      {/* ── Revision history ──────────────────────────────────────────────── */}
      <RevisionHistory
        revisions={stage3Revisions}
        activeRevisionId={stage3ActiveId}
        onCompare={id => setCompareRevId(id)}
        compareRevId={compareRevId}
      />

      {/* ── Stage-level cross-BU refinements ──────────────────────────────── */}
      <RefinementPanel
        onSaveRevision={handleStageRefinement}
        title="Cross-unit Execution Refinements"
        subtitle={
          apiMode === 'ai'
            ? 'Use this section for organisation-wide, cross-BU, or structural execution changes. API mode regenerates the full Stage 3 execution-plan package, including added, removed, merged, or reassigned plans when needed.'
            : 'Use this section to record organisation-wide or cross-BU execution corrections. Add an API key to regenerate the full Stage 3 package with AI.'
        }
        saveLabel={apiMode === 'ai' ? 'Regenerate Stage 3 with AI' : 'Save manual correction note'}
        promptLabel="Refinement instruction"
        promptPlaceholder={
          'Examples:\n' +
          '· Reduce all timelines by 3 weeks — leadership compressed the pilot window.\n' +
          '· Remove Finance from the gate review — decision rights have moved to the executive sponsor.\n' +
          '· Add a shared data infrastructure unit as a cross-cutting workstream.\n' +
          '· All BUs should defer phase-two commitments until the phase-one go/no-go review is complete.'
        }
        aiNotice={apiMode === 'ai' ? 'AI regeneration enabled' : null}
        isSaving={isStageRefining}
      />

      {/* ── Stage 4 CTA ───────────────────────────────────────────────────── */}
      <div style={{
        background: 'var(--surface)', border: '1px solid rgba(59,130,246,.3)',
        borderRadius: 'var(--r)', padding: '16px 18px',
        display: 'flex', alignItems: 'center', gap: 16,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
            Continue to Stage 4 — Product Delivery
          </div>
          <div style={{ fontSize: 10, color: 'var(--muted2)', fontFamily: 'var(--fm)', lineHeight: 1.65 }}>
            Stage 4 will translate these execution plans into PDLC strategy, epic-level requirements,
            acceptance criteria, non-functional requirements, delivery sequencing, and implementation governance.
          </div>
        </div>
        <button
          onClick={onNavigateToStage4}
          style={{
            flexShrink: 0, fontSize: 10, fontFamily: 'var(--fm)', fontWeight: 600,
            padding: '7px 20px', borderRadius: 5, cursor: 'pointer',
            background: 'var(--s2)', border: '1px solid var(--border)', color: 'var(--muted2)',
          }}
        >
          Stage 4 →
        </button>
      </div>

    </div>
  )
}
