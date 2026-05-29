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
import {
  LIFECYCLE_STATES,
  atomIsValidDraft,
  buildGenerationDiagnostics,
  deriveLifecycleState,
  estimateMessageBytes,
  estimateTextBytes,
  renderingEligibleAtoms,
  runGenerationLifecycle,
} from '../utils/generationLifecycle'
import { stage3ExecutiveLeadershipFixture } from '../fixtures/stage3ExecutiveLeadershipFixture'
import { readCached, readArtifactAsync, writeArtifact, storageReady, getStorageDiagnostics } from '../utils/storageRouter'

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
const STAGE3_BASIS_VERSION = 2
const STAGE3_LEARNING_SIGNALS_VERSION = 1
const STAGE3_REGENERATION_MODES = {
  SMART: 'smart',
  FORCE: 'force',
  RECOMPILE_ONLY: 'recompile_only',
}
const STAGE3_FIELD_ATOM_KEYS = [
  'objective',
  'executionStrategy',
  'decisionsRequired',
  'sequencingAndGates',
  'dependencies',
  'risks',
  'validationSignals',
]
const STAGE3_FIELD_ATOM_LABELS = {
  objective: 'Objective',
  executionStrategy: 'Execution Strategy',
  decisionsRequired: 'Decisions Required',
  sequencingAndGates: 'Sequencing and Gates',
  dependencies: 'Dependencies',
  risks: 'Risks',
  validationSignals: 'Validation Signals',
}
// Cross-cutting spine themes — content that belongs at the BU level (stated once)
// rather than re-derived independently in each execution section.
const SPINE_THEME_PATTERNS = [
  { key: 'build-vs-partner',       label: 'Build-vs-partner decision',                   re: /build[\s-]versus[\s-]partner|build[\s-]vs[\s-]partner|complete.*partner.*evaluation.*decision.*matrix|partner evaluation decision matrix/i },
  { key: 'api-bandwidth',          label: 'API Engineering bandwidth constraint',         re: /api.*engineering.*bandwidth|api.*team.*bandwidth|api.*bandwidth.*active.*client.*delivery/i },
  { key: 'dual-track',             label: 'Dual-track value streams',                    re: /client[\s-]operational.*examiner[\s-]facing|two distinct value stream|examiner[\s-]facing documentation.*second/i },
  { key: 'modularity-spec',        label: 'Architectural modularity specification',       re: /architectural modularity spec|modularity specification.*extension point|extension points.*interface boundaries|interface boundaries.*extension points/i },
  { key: 'pilot-validation-gate',  label: 'Pilot validation gate (live BSA/AML workflow)', re: /pilot validation.*live.*bsa|live.*bsa.*aml.*workflow.*before.*broader|bsa.*aml.*workflow.*before.*rollout/i },
  { key: 'scope-boundary',         label: 'Scope boundary / no hard regulatory deadline', re: /scope.{0,20}boundary.{0,20}definit|scope creep.{0,25}criteria|absence of a hard regulatory deadline|no hard regulatory deadline/i },
  { key: 'compliance-context',     label: 'Compliance & MRG provides context (not dictate)', re: /compliance.*model risk.*(?:regulatory context|documentation standard).*(?:before|cannot|without|architecture)/i },
  { key: 'exec-final-authority',   label: 'Executive Leadership final authority',         re: /executive leadership.*(?:holds )?final authority|executive.*strategic governance.*(?:holds )?final authority/i },
  { key: 'partner-vendor-ownership', label: 'Partner & Vendor ecosystem ownership',      re: /partner.*vendor ecosystem.*(?:owns|own|vendor shortlist|integration governance)/i },
  { key: 'mcd-feedback',           label: 'Managed Client Delivery workflow feedback',   re: /managed client delivery.*structured feedback.*bsa|managed client delivery.*(?:provide|provides).*feedback.*bsa.*aml/i },
]

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

function stage3BuPlanBackupKey(workspaceId, stage1Id, stage2Id, buName, timestamp) {
  const base = stage3BuPlanDraftKey(workspaceId, stage1Id, stage2Id, buName)
  return base ? `${base}_backup_${storageSafeName(timestamp || new Date().toISOString())}` : null
}

function stage3CoordinationDraftKey(workspaceId, stage1Id, stage2Id) {
  if (!workspaceId || !stage1Id || !stage2Id) return null
  return `bsp_v1_stage3_coordination_${workspaceId}_${stage1Id}_${stage2Id}`
}

// Fallback key for the PM capture import — matches the key that was live in the browser
// when the DOM capture was taken. Written alongside the runtime-computed key so the
// legacy search path and the canonical path both resolve the draft.
const CAPTURE_FALLBACK_KEY = 'bsp_v1_stage3_bu_plan_plan_mpphui1l_eq11b_Product_Management'

// DOM text uses ALL-CAPS concatenated labels (e.g. EXECUTIONSTRATEGY, DECISIONSREQUIRED).
// Map each to the camelCase field key used in the draft schema.
const CAPTURE_LABEL_MAP = {
  'OBJECTIVE':            'objective',
  'EXECUTIONSTRATEGY':    'executionStrategy',
  'DECISIONSREQUIRED':    'decisionsRequired',
  'SEQUENCINGANDGATES':   'sequencingAndGates',
  'DEPENDENCIES':         'dependencies',
  'RISKS':                'risks',
  'VALIDATIONSIGNALS':    'validationSignals',
  'ACCEPTANCECRITERIA':   'acceptanceCriteria',
  // spaced variants present in some render layouts
  'EXECUTION STRATEGY':   'executionStrategy',
  'DECISIONS REQUIRED':   'decisionsRequired',
  'SEQUENCING AND GATES': 'sequencingAndGates',
  'VALIDATION SIGNALS':   'validationSignals',
  'VALIDATION / READINESS': 'validationSignals',
  'ACCEPTANCE CRITERIA':  'acceptanceCriteria',
}
const CAPTURE_LABEL_RE = new RegExp(
  `^(${Object.keys(CAPTURE_LABEL_MAP).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`
)

// Parse the text block for a single section into a field map.
// sectionText starts with the section name line.
function extractCaptureSection(sectionText, sectionName) {
  const fields = {}
  const lines = sectionText.split('\n').map(l => l.trim()).filter(Boolean)
  let currentKey = null
  const buf = []

  function flush() {
    if (currentKey && buf.length) {
      const content = buf.join('\n').trim()
      if (content) fields[currentKey] = content
    }
    buf.length = 0
  }

  for (const line of lines) {
    if (line === sectionName) continue
    const labelMatch = line.match(CAPTURE_LABEL_RE)
    if (labelMatch) {
      flush()
      currentKey = CAPTURE_LABEL_MAP[line]
    } else if (currentKey) {
      buf.push(line)
    }
  }
  flush()
  return { sectionName, ...fields }
}

// Parse the PM execution-plan region from fullVisibleText and build the canonical draft.
function buildCapturedStage3Draft(captureJson, buName) {
  const foundSections = captureJson.foundSections || []
  const rawText = captureJson.fullVisibleText || ''
  const now = new Date().toISOString()

  // ── Locate the PM execution-plan region ─────────────────────────────────────
  // Start: "EXECUTION PLAN DRAFT" header (only one occurrence in the text)
  // End:   "\n2\nCompliance" — the next BU row (the "2" is the row index badge)
  const planStart = rawText.indexOf('EXECUTION PLAN DRAFT')
  const endMarker = planStart >= 0 ? rawText.indexOf('\n2\nCompliance', planStart) : -1
  const planEnd   = endMarker > planStart ? endMarker : rawText.length

  // ── Find each named section inside the PM region ─────────────────────────────
  // Sections appear in order, each starting with the section name on its own line
  // immediately followed by OBJECTIVE. We search only within [planStart, planEnd].
  const positions = []
  for (const name of foundSections) {
    let searchFrom = positions.length > 0
      ? positions[positions.length - 1].idx + name.length
      : planStart
    const idx = rawText.indexOf(name, searchFrom)
    if (idx >= 0 && idx < planEnd) positions.push({ name, idx })
  }

  // Extract each section's text block
  const extractedSections = positions.map((pos, i) => {
    const end = positions[i + 1]?.idx ?? planEnd
    return extractCaptureSection(rawText.slice(pos.idx, end), pos.name)
  })

  // Fall back to name-only stubs only if nothing was found in the text
  const sections = extractedSections.length
    ? extractedSections
    : foundSections.map(name => ({ sectionName: name }))

  // ── Build executionAtoms ─────────────────────────────────────────────────────
  const FIELD_KEYS = ['objective','executionStrategy','decisionsRequired','sequencingAndGates','dependencies','risks','validationSignals','acceptanceCriteria']
  const atoms = []
  sections.forEach(section => {
    const sectionKey = storageSafeName(section.sectionName)
    let addedAny = false
    FIELD_KEYS.forEach(fieldKey => {
      const value = section[fieldKey]
      if (!value) return
      addedAny = true
      atoms.push({
        id: `capture:${storageSafeName(buName)}:${sectionKey}:${fieldKey}`,
        stage: 'stage3',
        phase: 'executionPlanFieldAtom',
        status: ATOM_STATUSES.COMPLETE,
        parentId: buName,
        businessUnitName: buName,
        elementName: section.sectionName,
        childKey: fieldKey,
        metadata: {
          sectionKey,
          sectionName: section.sectionName,
          fieldKey,
          fieldName: fieldKey,
          buName,
          captureSource: 'browser_dom_visible_stage3_capture',
        },
        parsedValue: value,
        capturedAt: captureJson.capturedAt,
        completedAt: now,
        createdAt: captureJson.capturedAt,
        updatedAt: now,
      })
    })
    // Preserve section as a stub if no fields were extracted
    if (!addedAny) {
      atoms.push({
        id: `capture:${storageSafeName(buName)}:${sectionKey}:objective`,
        stage: 'stage3',
        phase: 'executionPlanFieldAtom',
        status: ATOM_STATUSES.COMPLETE,
        parentId: buName,
        businessUnitName: buName,
        elementName: section.sectionName,
        childKey: 'objective',
        metadata: { sectionKey, sectionName: section.sectionName, fieldKey: 'objective', fieldName: 'objective', buName, captureSource: 'browser_dom_visible_stage3_capture', note: 'field labels not matched in DOM text' },
        parsedValue: `${section.sectionName} — section found but field content not resolved from DOM text`,
        capturedAt: captureJson.capturedAt,
        completedAt: now,
        createdAt: captureJson.capturedAt,
        updatedAt: now,
      })
    }
  })

  // ── Aggregate plan-level fields from section content ─────────────────────────
  const NOT_CAPTURED = 'not captured from runtime import'
  const collectLines = key => sections.flatMap(s => s[key] ? [s[key]] : [])

  return {
    version: 1,
    businessUnitName: buName,
    source: 'browser_dom_visible_stage3_capture',
    status: 'runtime_captured_unaccepted_draft',
    accepted: false,
    capturedAt: captureJson.capturedAt,
    persistedAt: now,
    plan: {
      buName,
      captureSource: 'browser_dom_visible_stage3_capture',
      executionSections: sections.map(s => ({
        sectionName: s.sectionName,
        atomId: storageSafeName(s.sectionName),
        objective: s.objective || null,
        executionStrategy: asBulletArray(s.executionStrategy),
        decisionsRequired: asBulletArray(s.decisionsRequired),
        sequencingAndGates: asBulletArray(s.sequencingAndGates),
        dependencies: asBulletArray(s.dependencies),
        risks: asBulletArray(s.risks),
        validationSignals: asBulletArray(s.validationSignals),
        validationReadinessChecks: asBulletArray(s.validationSignals),
        acceptanceCriteria: asBulletArray(s.acceptanceCriteria),
        captureSource: 'browser_dom_visible_stage3_capture',
      })),
      criticalWorkstreams: foundSections,
      missingSections: [],
      failedSections: [],
      crossFunctionalDependencies: asBulletArray(collectLines('dependencies').length ? collectLines('dependencies') : [NOT_CAPTURED]),
      risks:         asBulletArray(collectLines('risks').length          ? collectLines('risks')          : [NOT_CAPTURED]),
      decisionRights: asBulletArray(collectLines('decisionsRequired').length ? collectLines('decisionsRequired') : [NOT_CAPTURED]),
      staffingOwnership: [NOT_CAPTURED],
      systemsTools:      [NOT_CAPTURED],
      governanceCadence: [NOT_CAPTURED],
    },
    executionAtoms: atoms,
    lifecycle: { status: LIFECYCLE_STATES.DRAFT_GENERATED },
    diagnostics: {
      captureType: captureJson.captureType || 'stage3_visible_page_text_capture',
      sectionsFound: foundSections.length,
      sectionsExtracted: sections.length,
      atomsBuilt: atoms.length,
      importedThroughApp: true,
      importedAt: now,
    },
    lastSavedAt: now,
  }
}

// readJsonStorage: checks IDB in-memory cache first (populated by storageReady()),
// then falls back to raw localStorage. For LS-only keys the behaviour is unchanged.
function readJsonStorage(key) {
  if (!key) return null
  return readCached(key)
}

// writeJsonStorageSync: synchronous LS-only write for small, non-routed keys.
// Do NOT use for stage3 plans, handoffs, or workspace plans — use writeArtifact() instead.
function writeJsonStorageSync(key, value) {
  if (!key || typeof localStorage === 'undefined') return false
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

function hasRenderableStage3Draft(draft) {
  return !!(
    draft?.plan?.buName ||
    draft?.plan?.executionSections?.length ||
    draft?.executionAtoms?.length ||
    draft?.plan?.failedSections?.length
  )
}

function normalizeLegacyStage3Draft(draft, storageKey) {
  if (!draft || draft.version === STAGE3_DRAFT_PLAN_VERSION) return draft
  const executionAtoms = draft.executionAtoms || []
  const hasPlanSections = !!draft?.plan?.executionSections?.length
  const hasValidAtoms = renderingEligibleAtoms(executionAtoms).length > 0
  const hasFailures = executionAtoms.some(atom => STAGE3_FAILED_ATOM_STATUSES.has(atom?.status)) || !!draft?.plan?.failedSections?.length
  return {
    ...draft,
    version: STAGE3_DRAFT_PLAN_VERSION,
    source: draft.source || 'legacy',
    storageKey,
    legacyStorageKey: storageKey,
    lifecycle: {
      ...(draft.lifecycle || {}),
      status: (hasPlanSections || hasValidAtoms) && hasFailures
        ? LIFECYCLE_STATES.PARTIAL_DRAFT
        : hasPlanSections || hasValidAtoms
          ? LIFECYCLE_STATES.DRAFT_GENERATED
          : hasFailures
            ? LIFECYCLE_STATES.GENERATION_FAILED
            : draft.lifecycle?.status || LIFECYCLE_STATES.NOT_STARTED,
    },
    diagnostics: {
      ...(draft.diagnostics || {}),
      recoveredFromLegacyStorageKey: storageKey,
      recoveredSections: draft?.plan?.executionSections?.length || 0,
      recoveredFieldAtoms: executionAtoms.length || 0,
      failedOrTruncatedAtoms: (draft?.plan?.failedSections?.length || 0) + executionAtoms.filter(atom => STAGE3_FAILED_ATOM_STATUSES.has(atom?.status)).length,
    },
  }
}

function findLegacyStage3DraftForBU(buName, exactKey = null) {
  if (!buName || typeof localStorage === 'undefined') return null
  const safeBu = storageSafeName(buName)
  const candidates = []
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (!key?.startsWith('bsp_v1_stage3_bu_plan_')) continue
    const keyLooksRelevant = key.endsWith(`_${safeBu}`) || key.includes(safeBu)
    const draft = readJsonStorage(key)
    const draftBu = draft?.businessUnitName || draft?.plan?.buName || draft?.plan?.businessUnitName
    const dataLooksRelevant = draftBu === buName || draftBu === safeBu
    if (!keyLooksRelevant && !dataLooksRelevant) continue
    if (!hasRenderableStage3Draft(draft)) continue
    const normalized = normalizeLegacyStage3Draft(draft, key)
    candidates.push({
      key,
      draft: normalized,
      score: [
        key === exactKey ? 1000 : 0,
        normalized?.plan?.executionSections?.length ? 100 : 0,
        normalized?.executionAtoms?.length ? 50 : 0,
        [LIFECYCLE_STATES.DRAFT_GENERATED, LIFECYCLE_STATES.PARTIAL_DRAFT].includes(normalized?.lifecycle?.status) ? 25 : 0,
        Date.parse(normalized?.lastSavedAt || normalized?.updatedAt || normalized?.createdAt || '') || 0,
      ].reduce((sum, value) => sum + value, 0),
    })
  }
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]?.draft || null
}

function findAllLegacyStage3Drafts() {
  if (typeof localStorage === 'undefined') return []
  const drafts = []
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (!key?.startsWith('bsp_v1_stage3_bu_plan_')) continue
    const draft = readJsonStorage(key)
    if (!hasRenderableStage3Draft(draft)) continue
    drafts.push(normalizeLegacyStage3Draft(draft, key))
  }
  return drafts
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

/**
 * Returns a human-readable block reason if the BU cannot generate right now,
 * or null if generation is allowed.
 *
 * Gate order:
 *  1. Already running          → 'Generation already running'
 *  2. IDB not initialised yet  → 'Storage not ready'
 *  3. LS quota critical (>90%) → 'Storage quota risk'
 *  4. No Stage 2 handoff       → 'Missing Stage 2 handoff'
 *  5. null                     → allowed
 */
function getPerBuGenerationBlock(unit, readiness, idbReady, gen) {
  if (gen?.running) return 'Generation already running'
  if (!idbReady) return 'Storage not ready'
  const diag = getStorageDiagnostics()
  if (diag.initialized && diag.lsEstimatedQuotaPct > 90) return 'Storage quota risk'
  if (!readiness || readiness.completion === 'none') return 'Missing Stage 2 handoff'
  return null
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

function safeStr(value) {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim()
}

function safeList(value) {
  return Array.isArray(value) ? value.map(safeStr).filter(Boolean) : []
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

function jsonParseObject(rawText) {
  if (!rawText?.trim()) return { parsed: null, error: 'Empty response from API.' }
  let jsonStr = rawText.trim()
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) jsonStr = fenceMatch[1].trim()
  const firstBrace = jsonStr.indexOf('{')
  const lastBrace = jsonStr.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1)
  }
  try {
    return { parsed: JSON.parse(jsonStr), error: null }
  } catch {
    return { parsed: null, error: 'Could not parse valid JSON from response.' }
  }
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

function normalizeStage3FieldValue(fieldKey, rawValue) {
  // Store full text — no truncation. compactHandoffText was previously applied here
  // and caused stored atoms to end with "..." at 277 chars. Removed.
  if (fieldKey === 'objective') {
    const text = valueToSearchText(rawValue).replace(/\s+/g, ' ').trim()
    return text || ''
  }
  return listFromValue(rawValue).map(v => {
    const text = valueToSearchText(v).replace(/\s+/g, ' ').trim()
    return text || null
  }).filter(Boolean).slice(0, 5)
}

function validateStage3FieldAtom(fieldKey, value) {
  if (fieldKey === 'objective') {
    const text = valueToSearchText(value).trim()
    if (!isMeaningfulStage3Value(text)) return { pass: false, reason: 'Objective is missing or empty.' }
    if (text.split(/\s+/).length > 80) return { pass: false, reason: 'Objective exceeds the 80-word target.' }
    return { pass: true, reason: null }
  }
  const items = listFromValue(value).filter(isMeaningfulStage3Value)
  if (items.length < 3) return { pass: false, reason: `${STAGE3_FIELD_ATOM_LABELS[fieldKey] || fieldKey} returned fewer than 3 usable bullets.` }
  if (items.length > 5) return { pass: false, reason: `${STAGE3_FIELD_ATOM_LABELS[fieldKey] || fieldKey} returned more than 5 bullets.` }
  return { pass: true, reason: null }
}

function parseStage3FieldAtomResponse(rawText, fieldKey) {
  const { parsed, error } = jsonParseObject(rawText)
  if (error) return { value: null, error }
  const rawValue = parsed?.[fieldKey] !== undefined ? parsed[fieldKey] : parsed?.value
  const value = normalizeStage3FieldValue(fieldKey, rawValue)
  const validation = validateStage3FieldAtom(fieldKey, value)
  if (!validation.pass) return { value: null, error: validation.reason }
  return { value, error: null }
}

function compactStage1SummaryForStage3(stage1Snapshot) {
  return [
    `Thesis: ${safeStr(stage1Snapshot?.thesis)}`,
    `Business problem: ${safeStr(stage1Snapshot?.businessProblem)}`,
    `Opportunity: ${safeStr(stage1Snapshot?.opportunity)}`,
    `Direction: ${safeStr(stage1Snapshot?.recommendedDirection)}`,
    `Posture: ${safeStr(stage1Snapshot?.artifactType)}`,
    `Target customer: ${safeStr(stage1Snapshot?.targetCustomer)}`,
    `Unknowns: ${safeList(stage1Snapshot?.unresolvedQuestions).slice(0, 4).join('; ')}`,
  ].filter(line => !line.endsWith(': ')).join('\n')
}

function compactBusinessUnitSummaryForStage3(unit) {
  return [
    `Name: ${unit?.name || unit?.buName || 'Unnamed unit'}`,
    `Purpose: ${safeStr(unit?.purpose)}`,
    `Strategic involvement: ${safeStr(unit?.strategicInvolvement)}`,
    `Responsibilities: ${safeList(unit?.keyResponsibilities).slice(0, 5).join('; ')}`,
    `Dependencies: ${safeList(unit?.dependencies).slice(0, 5).join('; ')}`,
    `Risks/unknowns: ${safeList(unit?.risksAndUnknowns).slice(0, 5).join('; ')}`,
    `Success metrics: ${safeList(unit?.keySuccessMetrics).slice(0, 5).join('; ')}`,
  ].filter(line => !line.endsWith(': ')).join('\n')
}

function compactStage3CompiledStrategyBasisForPrompt(unit) {
  const profile = inferCompiledBUProfile({ draft: null, legacyPlan: { buName: unit?.name, mission: unit?.purpose, strategicRole: unit?.strategicInvolvement }, handoffBrief: unit?.stage3PlanningContext?.handoffBrief, tree: null })
  const basis = STAGE3_COMPILED_STRATEGY_LEARNING_SIGNALS
  const pmNote = profile === 'productArchitecture'
    ? 'Product & Competitive Architecture validation case: start from use cases, outcomes, workflow evidence, mocks/prototypes, solution path comparison, architecture review, pilot evidence, and evidence quality.'
    : ''
  return [
    `Compiled strategy intent: ${basis.productIntent[0]}`,
    `Accepted compiled structure: ${basis.acceptedStructure.join(' > ')}`,
    `BU adaptation profile: ${profile}`,
    `Role terms: ${roleLearningTerms(profile).join('; ')}`,
    `General learning signals: ${basis.generalLearningSignals.slice(0, 6).join(' ')}`,
    `Avoid: ${basis.prohibitedPatterns.slice(0, 7).join('; ')}`,
    pmNote,
  ].filter(Boolean).join('\n')
}

function buildStage3FieldAtomMessages(stage1Snapshot, s2Unit, handoffItem, fieldKey, generationMode, otherUnitNames) {
  const planningContext = s2Unit?.stage3PlanningContext || {}
  const brief = planningContext.stage2ToStage3HandoffBrief || planningContext.handoffBrief || {}
  const sectionName = handoffItem?.label || handoffItem?.elementName || handoffItem?.key || 'Execution section'
  const sourceRefId = handoffItem?.sourceRefId || handoffItem?.key || ''
  const fieldLabel = STAGE3_FIELD_ATOM_LABELS[fieldKey] || fieldKey
  const valueContract = fieldKey === 'objective'
    ? `"${fieldKey}": "one string, max 80 words"`
    : `"${fieldKey}": ["3 to 5 concise bullets"]`

  const systemPrompt = `You are generating one small Stage 3 execution-planning field atom.

Return raw JSON only. No markdown fences. No prose before or after JSON.

JSON contract:
{ ${valueContract} }

Keep output short and reviewable. Do not include fields other than "${fieldKey}".`

  const userPrompt = `Business unit: ${s2Unit?.name || s2Unit?.buName}
Generation mode: ${generationMode}
Stage 1 summary:
${compactStage1SummaryForStage3(stage1Snapshot)}

BU summary:
${compactBusinessUnitSummaryForStage3(s2Unit)}

Compact Stage 2 to Stage 3 handoff brief:
Brief id: ${safeStr(brief.id)}
Planning purpose: ${safeStr(brief.planningPurpose)}
Decision basis: ${safeStr(brief.decisionBasisSummary)}
Constraints: ${safeList(brief.executionConstraints).slice(0, 5).join('; ')}
Dependencies: ${safeList(brief.dependencies).slice(0, 5).join('; ')}
Risks/questions: ${[...safeList(brief.risksOrContradictions).slice(0, 3), ...safeList(brief.unresolvedQuestions).slice(0, 3)].join('; ')}
Source section ids: ${safeList(brief.sourceStage2SectionIds).join(', ')}

Execution section:
Section id: ${sourceRefId}
Section name: ${sectionName}

Field atom to generate: ${fieldLabel} (${fieldKey})
Other business units for dependency awareness only: ${otherUnitNames || 'none'}`

  const learningBasis = compactStage3CompiledStrategyBasisForPrompt(s2Unit)

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `${userPrompt}\n\nStage 3 compiled strategy learning basis:\n${learningBasis}` },
    ],
  }
}

function buildStage3Progress({ unit, mode, atoms = [], currentAtom = null, lifecycleState = 'queued', skippedCount = null, latestFailureReason = null, latestUsage = null } = {}) {
  const atom = currentAtom || atoms.find(a => a.status === ATOM_STATUSES.RUNNING) || atoms.find(a => a.status === ATOM_STATUSES.PENDING) || atoms[0]
  const sectionKeys = [...new Set(atoms.map(a => a.metadata?.sectionKey || a.elementName || a.id))]
  const currentSectionKey = atom?.metadata?.sectionKey || atom?.elementName || null
  const currentSectionIndex = Math.max(0, sectionKeys.indexOf(currentSectionKey))
  const sectionAtoms = atoms.filter(a => (a.metadata?.sectionKey || a.elementName || a.id) === currentSectionKey)
  const currentAtomIndex = Math.max(0, sectionAtoms.findIndex(a => a.id === atom?.id))
  const resolvedSkippedCount = skippedCount ?? 0
  const failedAtoms = atoms.filter(a => STAGE3_FAILED_ATOM_STATUSES.has(a.status))
  return {
    buId: unit?.id || unit?.name || null,
    buName: unit?.name || '',
    mode,
    currentSectionId: currentSectionKey,
    currentSectionName: atom?.metadata?.sectionName || atom?.elementName || '',
    currentSectionIndex: currentSectionIndex + 1,
    totalSections: sectionKeys.length,
    currentAtomId: atom?.id || null,
    currentAtomName: atom?.metadata?.fieldName || atom?.childKey || '',
    currentAtomIndex: currentAtomIndex + 1,
    totalAtomsForSection: sectionAtoms.length || STAGE3_FIELD_ATOM_KEYS.length,
    lifecycleState,
    skippedCount: resolvedSkippedCount,
    generatedThisRunCount: Math.max(0, atoms.filter(atomIsValidDraft).length - resolvedSkippedCount),
    generatedCount: atoms.filter(atomIsValidDraft).length,
    failedCount: failedAtoms.length,
    totalAtomsCurrentlyPersisted: atoms.length,
    totalValidAtomsCurrentlyPersisted: atoms.filter(atomIsValidDraft).length,
    latestFailureReason: latestFailureReason || failedAtoms[failedAtoms.length - 1]?.parserError || null,
    latestUsage,
    startedAt: atoms.find(a => a.startedAt)?.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function normalizeStructureItems(structure) {
  if (!Array.isArray(structure)) return []
  return structure.map((item, idx) => {
    if (typeof item === 'string') {
      return { key: item.toLowerCase().replace(/[^a-z0-9]+/g, '_'), label: item, text: item, required: true }
    }
    const label = item?.label || item?.name || item?.title || `Handoff item ${idx + 1}`
    return {
      ...item,
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
  const draftStructureItems = normalizeStructureItems(draft?.handoffStructure || [])
  const structureItems = draftStructureItems.length
    ? draftStructureItems
    : brief.sourceSectionTitles.map((title, idx) => ({
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

function buildExecutionAtomPlanForBU(unit, readiness, priorDraft, mode, regenerationMode = STAGE3_REGENERATION_MODES.SMART, generationRunId = null) {
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
  const handoffBasis = buildStage3HandoffBasis(sourceItems)
  const learningBasisHash = stage3TraceHash(STAGE3_COMPILED_STRATEGY_LEARNING_SIGNALS)
  const runId = generationRunId || `stage3-run:${storageSafeName(unit.name)}:${stage3TraceHash(new Date().toISOString())}`
  const staleByReason = {
    handoffItemChanged: 0,
    learningBasisChanged: 0,
    missingMetadata: 0,
    stage3BasisChanged: 0,
    sourceItemMissing: 0,
    priorGlobalBasis: 0,
  }
  const handoffChanges = new Map()
  let currentAtoms = 0
  let staleAtoms = 0
  let skippedAtoms = 0

  const atoms = sourceItems.flatMap((item, sectionIdx) => (
    STAGE3_FIELD_ATOM_KEYS.map((fieldKey, fieldIdx) => {
      const itemBasis = handoffBasis.itemBasis[sectionIdx] || buildStage3HandoffItemBasis(item, sectionIdx)
      const sectionKey = itemBasis.handoffItemId
      const id = `stage3:${storageSafeName(unit.name)}:${storageSafeName(sectionKey)}:${fieldKey}`
      const prior = priorById.get(id)
      const sourceMetadata = {
        handoffItem: item,
        generationMode: mode,
        regenerationMode,
        generationRunId: runId,
        sectionKey,
        sectionName: itemBasis.handoffItemTitle,
        sectionIndex: sectionIdx,
        fieldKey,
        fieldName: STAGE3_FIELD_ATOM_LABELS[fieldKey] || fieldKey,
        fieldIndex: fieldIdx,
        totalFieldsForSection: STAGE3_FIELD_ATOM_KEYS.length,
        generatedFromBUName: unit.name,
        generatedFromHandoffBasisHash: handoffBasis.basisHash,
        generatedFromLearningBasisHash: learningBasisHash,
        learningSignalsVersion: STAGE3_LEARNING_SIGNALS_VERSION,
        generatedFromStage3BasisVersion: STAGE3_BASIS_VERSION,
        generatedFromHandoffItemIds: [itemBasis.handoffItemId],
        generatedFromHandoffItemHashes: { [itemBasis.handoffItemId]: itemBasis.handoffItemHash },
        generatedFromHandoffItems: [itemBasis],
        generatedAt: new Date().toISOString(),
      }
      const staleCheck = classifyStage3AtomStaleness(prior, unit.name, handoffBasis, itemBasis, learningBasisHash)
      const forceRun = regenerationMode === STAGE3_REGENERATION_MODES.FORCE
      if (regenerationMode === STAGE3_REGENERATION_MODES.RECOMPILE_ONLY && prior) {
        if (staleCheck.stale) {
          staleAtoms += 1
          staleByReason[staleCheck.reasonKey] = (staleByReason[staleCheck.reasonKey] || 0) + 1
        } else {
          currentAtoms += 1
          skippedAtoms += 1
        }
        return {
          ...prior,
          metadata: {
            ...(prior.metadata || {}),
            stalenessStatus: staleCheck.stale ? 'stale_not_regenerated' : 'current',
            stalenessReason: staleCheck.reason,
          },
        }
      }
      const shouldRegenerate = forceRun || staleCheck.stale
      if (prior && atomIsValidDraft(prior) && !shouldRegenerate) {
        currentAtoms += 1
        skippedAtoms += 1
        return {
          ...prior,
          metadata: {
            ...(prior.metadata || {}),
            stalenessStatus: 'current',
            stalenessReason: staleCheck.reason,
          },
        }
      }
      staleAtoms += 1
      staleByReason[forceRun ? 'stage3BasisChanged' : staleCheck.reasonKey] = (staleByReason[forceRun ? 'stage3BasisChanged' : staleCheck.reasonKey] || 0) + 1
      if (staleCheck.reasonKey === 'handoffItemChanged') {
        const current = handoffChanges.get(itemBasis.handoffItemId) || {
          handoffItemId: itemBasis.handoffItemId,
          handoffItemTitle: itemBasis.handoffItemTitle,
          previousHash: staleCheck.previousHash || null,
          currentHash: itemBasis.handoffItemHash,
          affectedAtomCount: 0,
          affectedGeneratedFields: [],
        }
        current.affectedAtomCount += 1
        current.affectedGeneratedFields.push(fieldKey)
        handoffChanges.set(itemBasis.handoffItemId, current)
      }
      return createGenerationAtom({
        id,
        stage: 'stage3',
        phase: 'executionPlanFieldAtom',
        parentId: unit.name,
        businessUnitName: unit.name,
        elementName: itemBasis.handoffItemTitle,
        childKey: fieldKey,
        status: ATOM_STATUSES.PENDING,
        metadata: {
          ...(prior?.metadata || {}),
          ...sourceMetadata,
          priorStatus: prior?.status || null,
          stalenessStatus: forceRun ? 'force_regenerate' : 'stale',
          stalenessReason: forceRun ? 'force regenerate all atoms' : staleCheck.reason,
          previousHandoffItemHashes: prior?.metadata?.generatedFromHandoffItemHashes || null,
        },
      })
    })
  ))

  return {
    atoms,
    sourceItems,
    handoffBasis,
    learningBasisHash,
    generationRunId: runId,
    stalenessPlan: {
      regenerationMode,
      generationRunId: runId,
      totalAtoms: atoms.length,
      currentAtoms,
      staleAtoms,
      willRegenerate: regenerationMode === STAGE3_REGENERATION_MODES.RECOMPILE_ONLY ? 0 : atoms.filter(atom => STAGE3_RETRYABLE_ATOM_STATUSES.has(atom?.status)).length,
      willSkip: skippedAtoms,
      staleDueToHandoffItemChange: staleByReason.handoffItemChanged || 0,
      staleDueToLearningBasisChange: staleByReason.learningBasisChanged || 0,
      staleDueToMissingMetadata: (staleByReason.missingMetadata || 0) + (staleByReason.priorGlobalBasis || 0),
      staleDueToStage3BasisChange: staleByReason.stage3BasisChanged || 0,
      staleDueToMissingSourceItem: staleByReason.sourceItemMissing || 0,
      sourceHandoffItemsChanged: handoffChanges.size,
      sourceHandoffItemsUnchanged: Math.max(0, sourceItems.length - handoffChanges.size),
      handoffChanges: Array.from(handoffChanges.values()).map(change => ({
        ...change,
        affectedGeneratedFields: [...new Set(change.affectedGeneratedFields)],
      })),
      atomSetCurrency: staleAtoms === 0 ? 'current' : currentAtoms > 0 ? 'mixed-current-after-regeneration' : 'stale',
    },
  }
}

function buildExecutionAtomsForBU(unit, readiness, priorDraft, mode) {
  return buildExecutionAtomPlanForBU(unit, readiness, priorDraft, mode).atoms
}

function assembleAtomizedBUPlan(unit, readiness, atoms, mode) {
  const completedAtoms = renderingEligibleAtoms(atoms)
  const failedAtoms = atoms.filter(atom => STAGE3_FAILED_ATOM_STATUSES.has(atom.status))
  const pendingAtoms = atoms.filter(atom => ![
    ATOM_STATUSES.COMPLETE,
    ...STAGE3_FAILED_ATOM_STATUSES,
  ].includes(atom.status))
  const sectionMap = new Map()
  for (const atom of completedAtoms) {
    const sectionKey = atom.metadata?.sectionKey || atom.elementName || atom.id
    const current = sectionMap.get(sectionKey) || {
      sectionName: atom.metadata?.sectionName || atom.elementName || sectionKey,
      atomIds: [],
      sourceHandoffItem: atom.elementName,
      executionStrategy: [],
      decisionsRequired: [],
      sequencingAndGates: [],
      dependencies: [],
      risks: [],
      constraints: [],
      unknowns: [],
      validationReadinessChecks: [],
      ownershipGovernance: [],
      successIndicators: [],
      failureSignals: [],
      stage4DeliveryImplications: [],
    }
    current.atomIds.push(atom.id)
    const fieldKey = atom.metadata?.fieldKey || atom.childKey
    if (fieldKey === 'validationSignals') {
      current.validationReadinessChecks = listFromValue(atom.parsedValue)
      current.successIndicators = listFromValue(atom.parsedValue)
    } else if (fieldKey === 'objective') {
      current.objective = atom.parsedValue
    } else {
      current[fieldKey] = listFromValue(atom.parsedValue)
    }
    sectionMap.set(sectionKey, current)
  }
  const sections = Array.from(sectionMap.values()).map(section => ({
    ...section,
    atomId: section.atomIds.join('|'),
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

const asBulletArray = (value) => {
  if (Array.isArray(value)) return value.filter(Boolean)
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (value == null) return []
  return [String(value)]
}

function BulletList({ items, borderColor, empty }) {
  const arr = asBulletArray(items)
  if (!arr.length) {
    return empty
      ? <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', fontStyle: 'italic' }}>{empty}</div>
      : null
  }
  const bc = borderColor || 'var(--border2)'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {arr.map((item, i) => (
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
                    {gen?.persistError && (
                      <div style={{ marginTop: 5, fontSize: 8, fontFamily: 'var(--fm)', color: '#fbbf24', lineHeight: 1.4, fontWeight: 600 }}>
                        ⚠ {gen.persistError}
                      </div>
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
    generating: '#fb923c',
    not_started: 'var(--muted)',
  }[status] || 'var(--muted)'
  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 5,
      padding: '8px 9px',
      background: 'var(--s2)',
    }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text)' }}>
              {item.label || item.key}
            </span>
            <Badge color={color} small>{status.replace('_', ' ')}</Badge>
            {item.key && (
              <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', opacity: .6 }}>
                {item.key}
              </span>
            )}
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
      {/* key implications, execution constraints, dependencies, risks, unresolved questions
          are canonical in the Execution Plan Draft — not repeated here */}
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

function buildExecutionDraftSectionsFromAtoms(atoms = [], fallbackSections = []) {
  const validAtoms = renderingEligibleAtoms(atoms)
  if (!validAtoms.length) return fallbackSections || []
  const sectionMap = new Map()
  for (const atom of validAtoms) {
    const sectionKey = atom.metadata?.sectionKey || atom.elementName || atom.id
    const current = sectionMap.get(sectionKey) || {
      sectionName: atom.metadata?.sectionName || atom.elementName || sectionKey,
      atomIds: [],
      fields: {},
    }
    const fieldKey = atom.metadata?.fieldKey || atom.childKey
    current.atomIds.push(atom.id)
    current.fields[fieldKey] = atom.parsedValue
    sectionMap.set(sectionKey, current)
  }
  return Array.from(sectionMap.values())
}

function migrateLegacyExecutionPlanToAtoms(plan, sourceLabel = 'legacy execution plan') {
  const sections = Array.isArray(plan?.executionSections) ? plan.executionSections : []
  const atoms = []
  sections.forEach((section, sectionIdx) => {
    const sectionKey = storageSafeName(section?.sectionName || section?.atomId || `section_${sectionIdx + 1}`)
    const fieldValues = {
      objective: section?.objective,
      executionStrategy: section?.executionStrategy,
      decisionsRequired: section?.decisionsRequired,
      sequencingAndGates: section?.sequencingAndGates,
      dependencies: section?.dependencies,
      risks: section?.risks,
      validationSignals: section?.validationSignals || section?.validationReadinessChecks || section?.successIndicators,
      acceptanceCriteria: section?.acceptanceCriteria,
    }
    Object.entries(fieldValues).forEach(([fieldKey, value], fieldIdx) => {
      const hasValue = fieldKey === 'objective'
        ? isMeaningfulStage3Value(value)
        : listFromValue(value).filter(isMeaningfulStage3Value).length > 0
      if (!hasValue) return
      atoms.push({
        id: `legacy:${storageSafeName(plan?.buName || 'bu')}:${sectionKey}:${fieldKey}`,
        stage: 'stage3',
        phase: 'legacyExecutionPlanFieldAtom',
        parentId: plan?.buName || null,
        businessUnitName: plan?.buName || '',
        elementName: section?.sectionName || `Execution section ${sectionIdx + 1}`,
        childKey: fieldKey,
        status: ATOM_STATUSES.COMPLETE,
        parsedValue: value,
        rawResponseText: null,
        completedAt: plan?.generatedAt || plan?.lastSavedAt || plan?.updatedAt || null,
        metadata: {
          migratedFromLegacy: true,
          sourceLabel,
          sourcePlanStatus: plan?.planStatus || null,
          sourceAtomId: section?.atomId || null,
          sourceHandoffItem: section?.sourceHandoffItem || null,
          sectionKey,
          sectionName: section?.sectionName || `Execution section ${sectionIdx + 1}`,
          sectionIndex: sectionIdx,
          fieldKey,
          fieldName: STAGE3_FIELD_ATOM_LABELS[fieldKey] || fieldKey,
          fieldIndex: fieldIdx,
          totalFieldsForSection: Object.keys(fieldValues).length,
        },
      })
    })
  })

  const failedSections = Array.isArray(plan?.failedSections)
    ? plan.failedSections
    : plan?.failedSections
      ? [plan.failedSections]
      : []
  const failedAtoms = failedSections.map((failed, idx) => {
    const label = failed?.sectionName || failed?.elementName || failed?.sectionKey || valueToSearchText(failed) || `Failed section ${idx + 1}`
    const failureReason = failed?.reason || failed?.parserError || failed?.failureReason || failed?.error || 'Legacy execution section failed or was incomplete.'
    const rawExcerpt = failed?.rawResponseText || failed?.rawExcerpt || failed?.responseText || null
    const isTruncated = /max.?tokens|truncat|incomplete/i.test(`${failureReason} ${rawExcerpt || ''}`)
    return {
      id: `legacy:${storageSafeName(plan?.buName || 'bu')}:failed:${storageSafeName(label)}:${idx}`,
      stage: 'stage3',
      phase: 'legacyExecutionPlanFieldAtom',
      parentId: plan?.buName || null,
      businessUnitName: plan?.buName || '',
      elementName: label,
      childKey: 'legacyFailure',
      status: ATOM_STATUSES.FAILED,
      parsedValue: null,
      rawResponseText: rawExcerpt,
      parserError: isTruncated
        ? 'Model output exceeded max_tokens before returning valid JSON.'
        : failureReason,
      metadata: {
        migratedFromLegacy: true,
        sourceLabel,
        failureLabel: isTruncated ? 'max_tokens' : 'legacy_failed',
        sectionName: label,
        fieldName: 'legacy failure',
      },
    }
  })

  return {
    atoms: [...atoms, ...failedAtoms],
    recoveredSections: sections.length,
    recoveredFieldAtoms: atoms.length,
    failedOrTruncatedAtoms: failedAtoms.length,
  }
}

function resolveExecutionDraftSource(draft, legacyPlan) {
  const canonicalAtoms = draft?.executionAtoms || []
  if (renderingEligibleAtoms(canonicalAtoms).length || canonicalAtoms.some(atom => STAGE3_FAILED_ATOM_STATUSES.has(atom?.status))) {
    return {
      source: 'canonical executionAtoms',
      atoms: canonicalAtoms,
      recoveredSections: buildExecutionDraftSectionsFromAtoms(canonicalAtoms).length,
      recoveredFieldAtoms: renderingEligibleAtoms(canonicalAtoms).length,
      failedOrTruncatedAtoms: canonicalAtoms.filter(atom => STAGE3_FAILED_ATOM_STATUSES.has(atom?.status)).length,
    }
  }

  if (draft?.plan?.executionSections?.length || draft?.plan?.failedSections?.length) {
    return {
      source: 'migrated legacy draft plan',
      ...migrateLegacyExecutionPlanToAtoms(draft.plan, 'stage3DraftPlans[].plan'),
    }
  }

  if (legacyPlan?.executionSections?.length || legacyPlan?.failedSections?.length) {
    return {
      source: 'migrated legacy Stage 3 revision',
      ...migrateLegacyExecutionPlanToAtoms(legacyPlan, 'active Stage 3 executionPlans[]'),
    }
  }

  return {
    source: 'empty',
    atoms: [],
    recoveredSections: 0,
    recoveredFieldAtoms: 0,
    failedOrTruncatedAtoms: 0,
  }
}

function ExecutionField({ label, value }) {
  const items = listFromValue(value).filter(isMeaningfulStage3Value)
  if (!items.length) return null
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.05em' }}>
        {label}
      </div>
      {items.length === 1 ? (
        <div style={{ fontSize: 9, color: 'var(--muted2)', lineHeight: 1.55 }}>
          {items[0]}
        </div>
      ) : (
        <BulletList items={items} borderColor="rgba(59,130,246,.32)" />
      )}
    </div>
  )
}

function Stage3ExecutionPlanDraft({ draft, legacyPlan }) {
  const resolved = resolveExecutionDraftSource(draft, legacyPlan)
  const atoms = resolved.atoms || []
  const failedAtoms = atoms.filter(atom => STAGE3_FAILED_ATOM_STATUSES.has(atom?.status))
  const sections = buildExecutionDraftSectionsFromAtoms(atoms, [])

  const sectionFieldValue = (section, key) => {
    if (section.fields) return section.fields[key]
    if (key === 'validationSignals') return section.validationSignals || section.validationReadinessChecks || section.successIndicators
    return section[key]
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 7 }}>
        <SectionLabel>Execution Plan Draft</SectionLabel>
        {resolved.source !== 'empty' && (
          <Badge color={resolved.source === 'canonical executionAtoms' ? '#00e5b4' : '#3b82f6'} small>
            {resolved.source}
          </Badge>
        )}
        {resolved.source !== 'empty' && (
          <Badge color="var(--muted)" small>
            {resolved.recoveredSections} sections / {resolved.recoveredFieldAtoms} atoms
          </Badge>
        )}
      </div>
      {!sections.length && (
        <div style={{
          fontSize: 9,
          fontFamily: 'var(--fm)',
          color: 'var(--muted)',
          fontStyle: 'italic',
          padding: '8px 9px',
          border: '1px solid var(--border)',
          borderRadius: 6,
          background: 'var(--s2)',
        }}>
          No execution-plan atoms generated yet.
        </div>
      )}
      {sections.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sections.map((section, sectionIdx) => (
            <div key={section.atomIds?.join('|') || section.atomId || sectionIdx} style={{
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '10px 11px',
              background: 'var(--s2)',
            }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text)', marginBottom: 7 }}>
                {section.sectionName || `Execution section ${sectionIdx + 1}`}
              </div>
              <ExecutionField label="objective" value={sectionFieldValue(section, 'objective')} />
              <ExecutionField label="executionStrategy" value={sectionFieldValue(section, 'executionStrategy')} />
              <ExecutionField label="decisionsRequired" value={sectionFieldValue(section, 'decisionsRequired')} />
              <ExecutionField label="sequencingAndGates" value={sectionFieldValue(section, 'sequencingAndGates')} />
              <ExecutionField label="dependencies" value={sectionFieldValue(section, 'dependencies')} />
              <ExecutionField label="risks" value={sectionFieldValue(section, 'risks')} />
              <ExecutionField label="validationSignals" value={sectionFieldValue(section, 'validationSignals')} />
              <ExecutionField label="acceptanceCriteria" value={sectionFieldValue(section, 'acceptanceCriteria')} />
            </div>
          ))}
        </div>
      )}
      {failedAtoms.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <SectionLabel>Failed Atoms</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {failedAtoms.map(atom => (
              <div key={atom.id} style={{
                border: '1px solid rgba(248,113,113,.35)',
                borderRadius: 5,
                padding: '7px 9px',
                background: 'rgba(248,113,113,.06)',
              }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: '#f87171', marginBottom: 3 }}>
                  {atom.metadata?.sectionName || atom.elementName || 'Execution section'} - {atom.metadata?.fieldName || atom.childKey || 'atom'}
                </div>
                <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted2)', lineHeight: 1.45 }}>
                  {atom.parserError || 'Generation failed.'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Stage3BuGenerationProgress({ progress }) {
  if (!progress) return null
  const usage = progress.latestUsage
  return (
    <div style={{ marginTop: 8, padding: '8px 9px', border: '1px solid var(--border)', borderRadius: 5, background: 'var(--surface)' }}>
      {progress && (
        <>
          <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted2)', lineHeight: 1.5, marginBottom: 5 }}>
            Generating {progress.buName} - section {progress.currentSectionIndex}/{progress.totalSections}: {progress.currentSectionName || 'queued'} - atom {progress.currentAtomIndex}/{progress.totalAtomsForSection}: {progress.currentAtomName || 'queued'}
          </div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: progress.latestFailureReason || usage ? 5 : 0 }}>
            <Badge color={progress.lifecycleState === 'failed' ? '#f87171' : progress.lifecycleState === 'persisted' ? '#00e5b4' : '#fb923c'} small>
              {progress.lifecycleState}
            </Badge>
            <Badge color="var(--muted)" small>{progress.mode}</Badge>
            <Badge color="#00e5b4" small>{progress.generatedThisRunCount ?? 0} generated this run</Badge>
            <Badge color="var(--muted)" small>{progress.skippedCount ?? 0} skipped this run</Badge>
            <Badge color={progress.failedCount ? '#f87171' : 'var(--muted)'} small>{progress.failedCount ?? 0} failed this run</Badge>
            <Badge color="#3b82f6" small>{progress.totalValidAtomsCurrentlyPersisted ?? progress.generatedCount ?? 0} valid persisted</Badge>
            <Badge color="var(--muted)" small>{progress.totalAtomsCurrentlyPersisted ?? 0} total persisted</Badge>
          </div>
        </>
      )}
      {progress?.latestFailureReason && (
        <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#f87171', lineHeight: 1.45, marginBottom: 4 }}>
          {progress.latestFailureReason}
        </div>
      )}
      {usage && (
        <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.45 }}>
          tokens in {usage.input_tokens || 0} / out {usage.output_tokens || 0} - stop {usage.stop_reason || 'n/a'} - {usage.model || 'model n/a'}
        </div>
      )}
    </div>
  )
}

// ── Storage health indicator ──────────────────────────────────────────────────
// Compact, dev-facing panel that shows IDB readiness, plan migration status,
// PM draft persistence, and whether large artifacts have left localStorage.

function StorageStatusIndicator({ idbReady, stage3DraftPlans }) {
  const [diag, setDiag] = useState(null)
  useEffect(() => {
    storageReady().then(() => setDiag(getStorageDiagnostics())).catch(() => {})
  }, [idbReady])

  const pmDraft          = stage3DraftPlans?.['Product Management']
  const pmPersisted      = !!(pmDraft?.persistedAt)
  const activePlanInIdb  = !!(diag?.idbCachedKeys?.some(k => k.startsWith('bsp_plan_v1_')))
  const lsWritesBlocked  = !!(diag?.lsPointerKeys?.some(k =>
    k.startsWith('bsp_v1_stage3_') || k.startsWith('bsp_v1_handoff_')
  ))

  function Row({ label, ok, okText = 'yes', failText = 'no' }) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ color: ok ? '#00e5b4' : '#f87171', fontSize: 8, lineHeight: 1 }}>●</span>
        <span style={{ fontSize: 8, color: 'var(--muted)', fontFamily: 'var(--fm)', flex: 1 }}>{label}</span>
        <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: ok ? '#00e5b4' : '#f87171' }}>{ok ? okText : failText}</span>
      </div>
    )
  }

  return (
    <div style={{
      background: 'var(--s2)',
      border: '1px solid var(--border)',
      borderRadius: 5,
      padding: '8px 10px',
      marginBottom: 8,
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--muted2)', marginBottom: 2, letterSpacing: '.04em' }}>
        Storage Health
      </div>
      <Row label="IndexedDB ready"           ok={idbReady}       okText="ready"              failText="not ready" />
      <Row label="Active plan in IDB"         ok={activePlanInIdb} />
      <Row label="PM draft persisted"         ok={pmPersisted} />
      <Row label="LS large writes blocked"    ok={lsWritesBlocked} okText="yes (IDB used)"   failText="no (migration pending)" />
      {diag && (
        <div style={{ fontSize: 7, color: 'var(--muted)', marginTop: 2, fontFamily: 'var(--fm)' }}>
          LS quota ~{diag.lsEstimatedQuotaPct ?? '?'}% · IDB cache {diag.idbCacheSize ?? 0} keys
        </div>
      )}
    </div>
  )
}

// ── Duplicate audit ───────────────────────────────────────────────────────────
// Dev-visible cross-layer duplicate detector. Surfaces exact-duplicate text
// that appears in more than one section. Uses semantic fingerprinting (Jaccard
// similarity on content word n-grams) rather than exact-line matching, so it
// catches concept-level duplication even when wording differs across sections.

// ── Semantic duplicate helpers ────────────────────────────────────────────────

// Common stopwords to ignore when fingerprinting bullets
const AUDIT_STOPWORDS = new Set(
  'a an the and or but in on at to for of with from by is are was were be been being have has had do does did will would could should may might shall must that this these those it its they their them we our us i my you your which who what when where how'.split(' ')
)

/**
 * Extract significant content words from a string for fingerprinting.
 * Returns a Set of lowercased words (length > 3, non-stopword) plus common bigrams.
 */
function semanticFingerprint(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !AUDIT_STOPWORDS.has(w))
  const bigrams = []
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.push(words[i] + '_' + words[i + 1])
  }
  return new Set([...words, ...bigrams])
}

/** Jaccard similarity between two fingerprint Sets. */
function jaccardSim(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const w of a) if (b.has(w)) inter++
  return inter / (a.size + b.size - inter)
}

/**
 * Extract individual bullet/sentence items from an atom's parsedValue,
 * keeping provenance (sectionName, fieldKey).
 */
function atomsToBullets(atoms) {
  const bullets = []
  ;(atoms || []).forEach(atom => {
    const sn = atom.metadata?.sectionName || atom.elementName || atom.id || '?'
    const fk = atom.metadata?.fieldKey || atom.childKey || '?'
    const val = atom.parsedValue
    const items = Array.isArray(val) ? val : [String(val || '')]
    items.forEach(item => {
      const t = String(item || '').replace(/\s+/g, ' ').trim()
      if (t.length > 40) bullets.push({ section: sn, field: fk, text: t })
    })
  })
  return bullets
}

/**
 * Find cross-section semantic duplicates in a list of bullets.
 * Returns pairs with similarity above the threshold, deduplicated by concept cluster.
 */
function findSemanticDuplicates(bullets, threshold = 0.42) {
  const fps = bullets.map(b => ({ ...b, fp: semanticFingerprint(b.text) }))
  const pairs = []
  const seen = new Set()

  for (let i = 0; i < fps.length; i++) {
    for (let j = i + 1; j < fps.length; j++) {
      if (fps[i].section === fps[j].section) continue
      const sim = jaccardSim(fps[i].fp, fps[j].fp)
      if (sim < threshold) continue
      // Deduplicate by concept: use the shorter text as the cluster key
      const clusterKey = (fps[i].text.length <= fps[j].text.length ? fps[i].text : fps[j].text).slice(0, 80).toLowerCase()
      if (seen.has(clusterKey)) continue
      seen.add(clusterKey)
      pairs.push({ sim, a: fps[i], b: fps[j] })
    }
  }
  return pairs.sort((x, y) => y.sim - x.sim)
}

// ── Duplicate audit component ─────────────────────────────────────────────────

function Stage3DuplicateAudit({ draft, legacyPlan, handoffBrief }) {
  const [open, setOpen] = React.useState(false)

  const findings = React.useMemo(() => {
    // Build bullet corpus from execution atoms (primary source)
    const resolved = resolveExecutionDraftSource(draft, legacyPlan)
    const atoms = resolved.atoms || []
    const atomBullets = atomsToBullets(atoms)

    // Include handoff brief bullets as a separate provenance layer
    const briefBullets = []
    if (handoffBrief) {
      const briefFields = {
        'planning purpose': handoffBrief.planningPurpose,
        'decision basis':   handoffBrief.decisionBasisSummary,
        'key implications': handoffBrief.keyImplications,
        'constraints':      handoffBrief.executionConstraints,
        'dependencies':     handoffBrief.dependencies,
        'risks':            handoffBrief.risksOrContradictions,
        'open questions':   handoffBrief.unresolvedQuestions,
      }
      Object.entries(briefFields).forEach(([fk, val]) => {
        const items = Array.isArray(val) ? val : [String(val || '')]
        items.forEach(item => {
          const t = String(item || '').replace(/\s+/g, ' ').trim()
          if (t.length > 40) briefBullets.push({ section: 'Handoff Brief', field: fk, text: t })
        })
      })
    }

    const allBullets = [...atomBullets, ...briefBullets]
    const pairs = findSemanticDuplicates(allBullets)

    // Compute section-level stats
    const sectionCounts = {}
    atomBullets.forEach(b => {
      sectionCounts[b.section] = (sectionCounts[b.section] || 0) + 1
    })

    return { pairs, sectionCounts, totalBullets: allBullets.length }
  }, [draft, legacyPlan, handoffBrief])

  const dupCount = findings.pairs.length
  const color = dupCount === 0 ? '#00e5b4' : dupCount < 4 ? '#fb923c' : '#f87171'
  const sectionNames = Object.keys(findings.sectionCounts)

  return (
    <div style={{ marginTop: 10, border: '1px solid var(--border)', borderRadius: 5, overflow: 'hidden' }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
          padding: '7px 10px', background: 'var(--s2)',
        }}
      >
        <Badge color={color} small>
          {dupCount} semantic dup{dupCount !== 1 ? 's' : ''}
        </Badge>
        <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', flex: 1 }}>
          Semantic Ownership Audit · {findings.totalBullets} bullets · {sectionNames.length} sections
        </span>
        <span style={{ fontSize: 8, color: 'var(--muted)' }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div style={{ padding: '10px 12px', background: 'var(--surface)' }}>
          {dupCount === 0 ? (
            <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: '#00e5b4' }}>
              No cross-section semantic duplicates detected above threshold.
            </div>
          ) : (
            <>
              <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', marginBottom: 8, lineHeight: 1.5 }}>
                Bullets with Jaccard similarity &gt; 0.42 across different sections — same concept, different wording.
                Canonical = first occurrence; repeated = later section re-deriving the same meaning.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {findings.pairs.map((p, i) => (
                  <div key={i} style={{
                    background: 'var(--s2)', border: '1px solid rgba(248,113,113,.22)',
                    borderRadius: 4, padding: '8px 10px',
                  }}>
                    <div style={{ display: 'flex', gap: 5, marginBottom: 5, flexWrap: 'wrap', alignItems: 'center' }}>
                      <Badge color="#94a3b8" small>sim {(p.sim * 100).toFixed(0)}%</Badge>
                      <Badge color="#00e5b4" small>↑ {p.a.section.length > 28 ? p.a.section.slice(0, 25) + '…' : p.a.section} / {p.a.field}</Badge>
                      <Badge color="#f87171" small>↓ {p.b.section.length > 28 ? p.b.section.slice(0, 25) + '…' : p.b.section} / {p.b.field}</Badge>
                    </div>
                    <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted2)', lineHeight: 1.55, marginBottom: 4 }}>
                      <span style={{ color: '#00e5b4', opacity: .8 }}>↑ </span>
                      {p.a.text.length > 180 ? p.a.text.slice(0, 177) + '…' : p.a.text}
                    </div>
                    <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted2)', lineHeight: 1.55 }}>
                      <span style={{ color: '#f87171', opacity: .8 }}>↓ </span>
                      {p.b.text.length > 180 ? p.b.text.slice(0, 177) + '…' : p.b.text}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Stage3ReadinessPanels({
  rows,
  planDrafts,
  legacyExecutionPlans = [],
  planGeneration,
  draftOptIns,
  onOptIntoStage12Draft,
  onGenerateBUPlan,
  onStage2Action,
  onRefineUnit = null,
  apiMode,
  disabled,
  generationEnabled = false,
  captureImportRef = null,
  captureImportStatus = null,
  onCaptureImport = null,
  idbReady = false,
}) {
  const [open, setOpen] = useState({})
  // Per-BU: whether "Operational Setup" (handoff readiness + generate + brief) is expanded
  // Defaults collapsed when a plan exists, open when no plan yet
  const [opsOpen, setOpsOpen] = useState({})
  // Per-BU: refine panel state
  const [refineState, setRefineState] = useState({})
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
          {legacyExecutionPlans.length > 0 && (
            <Badge color="#3b82f6" small>
              {legacyExecutionPlans.length} legacy recovered
            </Badge>
          )}
        </div>
      </div>

      <StorageStatusIndicator idbReady={idbReady} stage3DraftPlans={planDrafts} />

      {rows.map((row, idx) => {
        const unit = row.unit
        const readiness = row.readiness
        const draft = planDrafts[unit.name]
        const legacyPlan = legacyExecutionPlans.find(plan => plan?.buName === unit.name || plan?.businessUnitName === unit.name)
        const gen = planGeneration[unit.name]
        const isExecutiveFixtureMode = isExecutiveTraceUnit(unit)
        const isOpen = open[unit.name] ?? idx === 0
        const hasPlan = !!draft?.plan
        const lifecycleState = gen?.lifecycleState || draft?.lifecycle?.status || LIFECYCLE_STATES.NOT_STARTED
        const hasRetryableAtoms = (draft?.executionAtoms || []).some(atom => (
          STAGE3_RETRYABLE_ATOM_STATUSES.has(atom?.status) && atom?.status !== ATOM_STATUSES.COMPLETE
        ))
        const blockReason = getPerBuGenerationBlock(unit, readiness, idbReady, gen)
        const executionStatus = gen?.persistError
          ? 'not persisted'
          : gen?.error && lifecycleState === LIFECYCLE_STATES.GENERATION_FAILED
            ? 'failed'
          : lifecycleState === LIFECYCLE_STATES.ACCEPTED
            ? 'accepted'
          : lifecycleState === LIFECYCLE_STATES.DRAFT_GENERATED
            ? 'draft'
          : lifecycleState === LIFECYCLE_STATES.PARTIAL_DRAFT
            ? 'partial draft'
          : lifecycleState === LIFECYCLE_STATES.GENERATION_FAILED
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
        const ctaLabel = blockReason
          ? `Blocked: ${blockReason}`
          : hasRetryableAtoms || lifecycleState === LIFECYCLE_STATES.PARTIAL_DRAFT
            ? 'Retry failed sections'
            : lifecycleState === LIFECYCLE_STATES.DRAFT_GENERATED
              ? `Regenerate ${unit.name}`
              : lifecycleState === LIFECYCLE_STATES.ACCEPTED
                ? 'Accepted'
              : mode.cta
        const actionEnabled = !blockReason && mode.enabled && lifecycleState !== LIFECYCLE_STATES.ACCEPTED
        const handoffItems = readiness.structureItems.map(item => {
          const match = readiness.itemStates.find(state => state.key === item.key || state.key === String(readiness.structureItems.indexOf(item)))
          return { ...item, ...(match || {}) }
        })
        const executionGenerationMode = readiness.completion === 'full'
          ? 'full'
          : readiness.completion === 'none'
            ? 'stage1_2_only'
            : 'limited'
        const smartRegenerationPreview = (() => {
          try {
            return buildExecutionAtomPlanForBU(unit, readiness, draft, executionGenerationMode, STAGE3_REGENERATION_MODES.SMART)
          } catch {
            return null
          }
        })()
        const visibleStalenessPlan = gen?.stalenessPlan || draft?.stalenessPlan || smartRegenerationPreview?.stalenessPlan || null
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
                alignItems: 'flex-start',
                gap: 10,
                borderBottom: isOpen ? '1px solid var(--border)' : 'none',
              }}
            >
              <span style={{
                width: 22, height: 22, borderRadius: '50%', flexShrink: 0, marginTop: 2,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 9, fontFamily: 'var(--fm)', fontWeight: 700,
                background: 'var(--s2)', border: '1px solid var(--border)', color: 'var(--muted2)',
              }}>
                {idx + 1}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)', marginBottom: 3 }}>
                  {unit.name}
                </div>
                {/* Plan health line — exec risk, confidence, readiness when plan exists */}
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center', marginBottom: 2 }}>
                  {hasPlan && draft?.plan?.executionRisk && (
                    <Badge color={riskColor(draft.plan.executionRisk)} small>
                      exec risk {draft.plan.executionRisk}
                    </Badge>
                  )}
                  {hasPlan && draft?.plan?.confidenceLevel && (
                    <Badge color={readyColor(draft.plan.confidenceLevel)} small>
                      confidence {draft.plan.confidenceLevel}
                    </Badge>
                  )}
                  {hasPlan && draft?.plan?.organizationalReadiness && (
                    <Badge color={readyColor(draft.plan.organizationalReadiness)} small>
                      readiness {draft.plan.organizationalReadiness}
                    </Badge>
                  )}
                  {!hasPlan && (
                    <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', fontStyle: 'italic' }}>
                      {executionStatus === 'not started' ? 'No plan yet' : `Plan ${executionStatus}`}
                    </span>
                  )}
                  {hasPlan && onRefineUnit && (
                    <button
                      onClick={e => {
                        e.stopPropagation()
                        setRefineState(p => ({ ...p, [unit.name]: { ...p[unit.name], open: !p[unit.name]?.open } }))
                      }}
                      style={{
                        fontSize: 8, fontFamily: 'var(--fm)', padding: '1px 7px', borderRadius: 3,
                        cursor: 'pointer', background: 'var(--s2)', border: '1px solid var(--border)',
                        color: 'var(--muted)',
                      }}
                    >
                      ↻ Refine
                    </button>
                  )}
                </div>
              </div>
              <span style={{ fontSize: 9, color: 'var(--muted)', flexShrink: 0, marginTop: 4 }}>{isOpen ? '▲' : '▼'}</span>
            </div>

            {/* Inline refine panel — triggered from header button */}
            {isOpen && hasPlan && onRefineUnit && refineState[unit.name]?.open && (
              <div style={{ padding: '10px 13px', borderBottom: '1px solid var(--border)', background: 'rgba(59,130,246,.04)' }}>
                <div style={{ fontSize: 9, fontFamily: 'var(--fm)', fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }}>
                  Refinement instruction for {unit.name}
                </div>
                <textarea
                  value={refineState[unit.name]?.prompt || ''}
                  onChange={e => setRefineState(p => ({ ...p, [unit.name]: { ...p[unit.name], prompt: e.target.value } }))}
                  rows={2}
                  placeholder="e.g. Focus on partner evaluation criteria and adjust the build-vs-partner timeline."
                  style={{
                    width: '100%', boxSizing: 'border-box', fontSize: 9, fontFamily: 'var(--fm)',
                    color: 'var(--text)', background: 'var(--surface)', border: '1px solid var(--border)',
                    borderRadius: 4, padding: '6px 8px', resize: 'vertical', outline: 'none', lineHeight: 1.5, marginBottom: 6,
                  }}
                />
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button
                    disabled={!refineState[unit.name]?.prompt?.trim() || refineState[unit.name]?.loading}
                    onClick={async () => {
                      const prompt = refineState[unit.name]?.prompt?.trim()
                      if (!prompt) return
                      setRefineState(p => ({ ...p, [unit.name]: { ...p[unit.name], loading: true, error: null } }))
                      const result = await onRefineUnit(unit.name, prompt, '', 'auto')
                      setRefineState(p => ({
                        ...p,
                        [unit.name]: { ...p[unit.name], loading: false, error: result?.error || null, open: result?.error ? true : false, prompt: '' },
                      }))
                    }}
                    style={{
                      fontSize: 9, fontFamily: 'var(--fm)', fontWeight: 600, padding: '4px 12px', borderRadius: 4,
                      cursor: 'pointer', background: 'var(--accent)', border: '1px solid var(--accent)', color: '#000',
                      opacity: !refineState[unit.name]?.prompt?.trim() ? .5 : 1,
                    }}
                  >
                    {refineState[unit.name]?.loading ? 'Regenerating…' : 'Regenerate'}
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); setRefineState(p => ({ ...p, [unit.name]: { ...p[unit.name], open: false } })) }}
                    style={{ fontSize: 8, fontFamily: 'var(--fm)', padding: '4px 8px', borderRadius: 4, cursor: 'pointer', background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)' }}
                  >
                    Cancel
                  </button>
                  {refineState[unit.name]?.error && (
                    <span style={{ fontSize: 8, color: '#f87171', fontFamily: 'var(--fm)' }}>{refineState[unit.name].error}</span>
                  )}
                </div>
              </div>
            )}

            {isOpen && (
              <div style={{ padding: '12px 13px 13px' }}>

                {/* Operational Setup — collapsed by default when plan exists */}
                {(() => {
                  const opsIsOpen = opsOpen[unit.name] !== undefined ? opsOpen[unit.name] : !hasPlan
                  return (
                    <div style={{ border: '1px solid var(--border)', borderRadius: 5, marginBottom: 12, overflow: 'hidden' }}>
                      <div
                        onClick={() => setOpsOpen(p => ({ ...p, [unit.name]: !opsIsOpen }))}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                          padding: '7px 10px', background: 'var(--s2)',
                          borderBottom: opsIsOpen ? '1px solid var(--border)' : 'none',
                        }}
                      >
                        <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--muted)', flex: 1 }}>Operational Setup</span>
                        <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', opacity: .7 }}>
                          Handoff Readiness · Generate · Stage 2→3 Handoff Brief
                        </span>
                        <span style={{ fontSize: 8, color: 'var(--muted)', marginLeft: 4 }}>{opsIsOpen ? '▲' : '▼'}</span>
                      </div>
                      {opsIsOpen && (
                        <div style={{ padding: '10px 11px' }}>
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
                      <Badge color={blockReason ? '#f87171' : mode.color}>
                        {blockReason ? 'blocked' : mode.label}
                      </Badge>
                      {isExecutiveFixtureMode && USE_STAGE3_EXECUTIVE_FIXTURE && (
                        <span style={{ marginLeft: 6 }}>
                          <Badge color="#3b82f6">dev fixture</Badge>
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: blockReason ? '#f87171' : 'var(--muted)', lineHeight: 1.55, marginBottom: 9 }}>
                      {blockReason
                        ? `Blocked: ${blockReason}. Resolve this before generating ${unit.name}.`
                        : readiness.completion === 'full'
                          ? `${unit.name}: existing valid atoms will be skipped; failed/missing/stale atoms only will run.`
                          : readiness.completion === 'none'
                            ? `No ${unit.name} handoff exists. Build the Stage 2 handoff before generating Stage 3.`
                            : `Retry mode: only failed, missing, or stale atoms for ${unit.name} will run.`}
                    </div>
                    <button
                      onClick={() => actionEnabled ? onGenerateBUPlan(unit, { ...readiness, regenerationMode: STAGE3_REGENERATION_MODES.SMART }) : onStage2Action(unit.name, null, 'review')}
                      disabled={disabled || gen?.running || !!blockReason || (!isExecutiveFixtureMode && readiness.completion === 'none' && !draftOptIns[unit.name] && mode.label !== 'Pending')}
                      style={{
                        ...primaryButtonStyle,
                        marginTop: 6,
                        background: actionEnabled ? 'var(--accent)' : 'var(--s2)',
                        borderColor: actionEnabled ? 'var(--accent)' : 'var(--border)',
                        color: actionEnabled ? '#000' : 'var(--muted)',
                      }}
                    >
                      {gen?.running ? (isExecutiveFixtureMode ? 'Loading fixture...' : 'Generating...') : ctaLabel === `Regenerate ${unit.name}` ? 'Smart regenerate stale atoms' : ctaLabel}
                    </button>
                    {hasPlan && !blockReason && lifecycleState !== LIFECYCLE_STATES.ACCEPTED && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                        <button
                          onClick={() => onGenerateBUPlan(unit, { ...readiness, regenerationMode: STAGE3_REGENERATION_MODES.FORCE })}
                          disabled={disabled || gen?.running}
                          style={{ ...secondaryButtonStyle, marginTop: 0 }}
                        >
                          Force regenerate all atoms
                        </button>
                        <button
                          onClick={() => onGenerateBUPlan(unit, { ...readiness, regenerationMode: STAGE3_REGENERATION_MODES.RECOMPILE_ONLY })}
                          disabled={disabled || gen?.running}
                          style={{ ...secondaryButtonStyle, marginTop: 0 }}
                        >
                          Recompile only
                        </button>
                      </div>
                    )}
                    {draft?.lifecycle?.status === LIFECYCLE_STATES.DRAFT_GENERATED && !blockReason && (
                      <button
                        onClick={() => onGenerateBUPlan(unit, { ...readiness, acceptOnly: true })}
                        disabled={disabled || gen?.running}
                        style={{ ...secondaryButtonStyle, marginTop: 6 }}
                      >
                        Accept {unit.name} draft
                      </button>
                    )}
                    {(gen?.diagnostics || draft?.diagnostics) && (
                      <div style={{ marginTop: 8, fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.45 }}>
                        {(() => {
                          const d = gen?.diagnostics || draft?.diagnostics
                          const skippedThisRun = d.atomsSkippedAlreadyValid || 0
                          const generatedThisRun = Math.max(0, (d.atomsGenerated || 0) - skippedThisRun)
                          return `${d.retryMode || 'partial'} - current run requested ${d.atomsRequestedThisRun ?? d.atomCountRequested ?? 0}, generated this run ${generatedThisRun}, skipped this run ${skippedThisRun}, failed this run ${d.atomsFailed || 0}; total evaluated ${d.totalAtomsEvaluated ?? d.atomCountRequested ?? 0}; total valid persisted ${d.atomsGenerated || 0}; input ${d.inputTokens || 0} tokens, output ${d.outputTokens || 0} tokens`
                        })()}
                      </div>
                    )}
                    <Stage3BuGenerationProgress progress={gen?.progress || draft?.progress} />
                    <Stage3SelectiveRegenerationDiagnostics plan={visibleStalenessPlan} />
                    {gen?.persistError && (
                      <div style={{ marginTop: 7, fontSize: 9, fontFamily: 'var(--fm)', color: '#fbbf24', lineHeight: 1.45, fontWeight: 600 }}>
                        ⚠ {gen.persistError}
                      </div>
                    )}
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
                    {onCaptureImport && (
                      <div style={{ marginTop: 9, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                        <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', marginBottom: 5, lineHeight: 1.45 }}>
                          Restore from DOM capture — import a <code>bsp-stage3-pm-runtime-capture.json</code> file to persist a captured draft without regenerating.
                        </div>
                        <input
                          type="file"
                          accept=".json"
                          ref={captureImportRef}
                          style={{ display: 'none' }}
                          onChange={e => {
                            const file = e.target.files?.[0]
                            if (file && onCaptureImport) onCaptureImport(file, unit)
                            e.target.value = ''
                          }}
                        />
                        <button
                          onClick={() => captureImportRef.current?.click()}
                          style={{ ...secondaryButtonStyle }}
                        >
                          Import Stage 3 capture
                        </button>
                        {captureImportStatus?.ok && (
                          <div style={{ marginTop: 6, fontSize: 8, fontFamily: 'var(--fm)', color: '#00e5b4', lineHeight: 1.55 }}>
                            Imported: {captureImportStatus.sections} sections · {captureImportStatus.atoms} atoms
                            <br />Runtime key: {captureImportStatus.runtimeKey}
                            <br />Fallback key: {captureImportStatus.fallbackKey}
                          </div>
                        )}
                        {captureImportStatus?.error && (
                          <div style={{ marginTop: 6, fontSize: 8, fontFamily: 'var(--fm)', color: '#f87171', lineHeight: 1.45 }}>
                            {captureImportStatus.error}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <Stage3HandoffBriefCard
                  brief={readiness.handoffBrief || readiness.planningContext?.handoffBrief}
                  unitName={unit.name}
                  onStage2Action={onStage2Action}
                />
                        </div>
                      )}
                    </div>
                  )
                })()}

                {/* Execution plan — rendered here when a draft exists so BU plan
                    appears in one place (the expanded readiness row), not duplicated below */}
                {(draft || legacyPlan) && (
                  <Stage3BUPlanTree
                    draft={draft}
                    legacyPlan={legacyPlan}
                    handoffBrief={readiness.handoffBrief || readiness.planningContext?.handoffBrief}
                    handoffItems={handoffItems}
                    unitName={unit.name}
                    onStage2Action={onStage2Action}
                    showHandoffBrief={false}
                    generationState={gen}
                  />
                )}

                {/* Stage 2 actions — kept for operators but not the primary reading path */}
                {handoffItems.length > 0 && !(draft || legacyPlan) && (
                  <div style={{ marginTop: 4 }}>
                    <SectionLabel>Source References</SectionLabel>
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

// ── Plan tree helpers ─────────────────────────────────────────────────────────

// Fields that appear in the compiled Execution Plan (excludes objective)
const EXEC_PLAN_FIELDS = [
  'executionStrategy',
  'decisionsRequired',
  'sequencingAndGates',
  'dependencies',
  'risks',
  'validationSignals',
]

function classifyBulletSpine(text) {
  return SPINE_THEME_PATTERNS.filter(p => p.re.test(text))
}

// Predefined semantic area labels — matched against section content to produce
// a short meaningful identifier instead of a truncated mandate clause.
const SEMANTIC_AREA_PATTERNS = [
  { label: 'Capability Architecture',  re: /etl.*schema.*variab|core.*system.*schema.*variab|jack henry.*fiserv.*fis.*schema/i },
  { label: 'Partner Evaluation',       re: /examination.*preparation.*stall|idiosyncratic.*workflow.*prefer|partner.*evaluation.*stall/i },
  { label: 'Modularity Specification', re: /institution.*size.*diverge|sub.*\$?500m.*\$?1.*5b|two.*parallel.*explainab/i },
  { label: 'Execution Governance',     re: /three.phase|phased.*rollout.*govern|artifact.*owner.*formal|camelCase.*artifact|named.*artifact/i },
  { label: 'Scope Governance',         re: /scope.*ratif|scope.*contain.*rule|executive.*scope.*ratif|scope.*publication|under-investment.*scope.creep/i },
  { label: 'Pilot Validation',         re: /v1.*evolution.*point|interface.*contract.*fixed|pilot.*threshold.*evidence|pilot.*stress.*test.*protocol/i },
  { label: 'Managed Client Delivery',  re: /managed client.*incentive|mcd.*accountability.*defer|delivery.*continuity.*defer.*validation/i },
  { label: 'API Engineering',          re: /api.*bandwidth.*sequenc.*risk|api.*team.*sequenc.*conflict|api.*onboarding.*destabiliz/i },
  { label: 'Compliance & Model Risk',  re: /occ.*fincen.*examiner.*lag|compliance.*review.*lag|model risk.*disclosure.*obligation/i },
  { label: 'Executive Governance',     re: /executive.*ratif.*scope|executive.*govern.*authority.*scope/i },
  { label: 'Partner & Vendor',         re: /vendor.*model.agnostic.*finlytica|no.*vendor.*model.agnostic|vendor.*paradigm.*finlytica/i },
]

// Ordered fallback labels by section index — used when pattern matching finds nothing
const SEMANTIC_AREA_FALLBACKS = [
  'Capability Architecture',
  'Partner Evaluation',
  'Modularity Specification',
  'Execution Governance',
  'Scope Governance',
  'Pilot Validation',
  'Managed Client Delivery',
]

function inferSemanticAreaLabel(sec) {
  const uniqueText = sec.taggedBullets.filter(b => b.isUnique).map(b => b.text).join(' ')
  const allText    = sec.taggedBullets.map(b => b.text).join(' ')
  const text = uniqueText.length > 40 ? uniqueText : allText
  for (const { label, re } of SEMANTIC_AREA_PATTERNS) {
    if (re.test(text)) return label
  }
  return SEMANTIC_AREA_FALLBACKS[sec.sectionIndex] ?? `Perspective ${sec.sectionIndex + 1}`
}

function inferSectionMandate(atoms, sectionIdx) {
  const objAtom = atoms.find(a => (a.metadata?.fieldKey || a.childKey) === 'objective')
  const raw = String(objAtom?.parsedValue || '').replace(/\s+/g, ' ').trim()
  if (!raw) return `Section ${sectionIdx}`
  const dashIdx = raw.indexOf(' — ')
  if (dashIdx > 0) {
    const after = raw.slice(dashIdx + 3).replace(/[,;]\s*$/, '').trim()
    if (after.length > 10) return after
  }
  const stripped = raw
    .replace(/^(?:Define and (?:govern|sequence|build)\s+(?:a|the)\s+)?(?:modular,\s+)?(?:evolution-ready\s+)?BSA\/AML explainability capability (?:roadmap|build)(?:\s+as a modular,[\w\s-]+investment)?\s+(?:that\s+)?/i, '')
  return stripped.replace(/[,;]\s*$/, '').trim() || `Section ${sectionIdx}`
}

/**
 * Groups atoms by section, tags bullets as spine/duplicate/unique, computes
 * per-section stats, and aggregates a dimension-first execution plan.
 *
 * Returns { spine, sections, executionPlan }
 *   executionPlan[fieldKey] = [ { sectionKey, sectionIndex, mandate, bullets } ]
 *   where bullets are de-duplicated canonical occurrences (spine excluded).
 */
function buildPlanTree(atoms) {
  const eligible = renderingEligibleAtoms(atoms)
  if (!eligible.length) return { spine: [], sections: [], executionPlan: {} }

  // ── 1. Group by section ────────────────────────────────────────────────────
  const sectionMap = new Map()
  eligible.forEach(atom => {
    const sk = atom.metadata?.sectionKey || atom.elementName || atom.id
    if (!sectionMap.has(sk)) {
      sectionMap.set(sk, {
        sectionKey: sk,
        sectionName: atom.metadata?.sectionName || atom.elementName || sk,
        sectionIndex: atom.metadata?.sectionIndex ?? sectionMap.size,
        atoms: [],
      })
    }
    sectionMap.get(sk).atoms.push(atom)
  })
  const rawSections = Array.from(sectionMap.values()).sort((a, b) => a.sectionIndex - b.sectionIndex)

  // ── 2. Extract bullets — prefer rawResponseText for full text ────────────────
  // parsedValue may have been stored with compactHandoffText(...) truncation (ending
  // in "..."). rawResponseText holds the complete model JSON. Re-parse it when the
  // stored parsedValue is detectably truncated.
  function fullItemsFromAtom(atom, fk) {
    const stored = atom.parsedValue
    const storedItems = Array.isArray(stored) ? stored : (stored ? [String(stored)] : [])
    const needsRecovery = storedItems.some(s => String(s).trimEnd().endsWith('...'))
    if (needsRecovery && atom.rawResponseText) {
      try {
        const { parsed } = jsonParseObject(atom.rawResponseText)
        if (parsed) {
          const raw = parsed[fk] !== undefined ? parsed[fk] : parsed?.value
          if (raw) {
            const recovered = Array.isArray(raw) ? raw : [String(raw)]
            if (recovered.length > 0) return recovered
          }
        }
      } catch { /* fall through to stored */ }
    }
    return storedItems
  }

  const withBullets = rawSections.map(sec => {
    const bullets = []
    sec.atoms.forEach(atom => {
      const fk = atom.metadata?.fieldKey || atom.childKey
      const items = fullItemsFromAtom(atom, fk)
      items.forEach(item => {
        const t = String(item).replace(/\s+/g, ' ').trim()
        if (t.length > 30) bullets.push({ text: t, fieldKey: fk, spineThemes: classifyBulletSpine(t) })
      })
    })
    return { ...sec, bullets }
  })

  // ── 3. Cross-section Jaccard duplicate detection ───────────────────────────
  let gi = 0
  const flat = withBullets.flatMap(sec =>
    sec.bullets.map(b => ({ ...b, sectionKey: sec.sectionKey, gi: gi++, fp: semanticFingerprint(b.text) }))
  )
  const bulletDups = new Map()
  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      if (flat[i].sectionKey === flat[j].sectionKey) continue
      if (jaccardSim(flat[i].fp, flat[j].fp) < 0.42) continue
      if (!bulletDups.has(flat[i].gi)) bulletDups.set(flat[i].gi, new Set())
      if (!bulletDups.has(flat[j].gi)) bulletDups.set(flat[j].gi, new Set())
      bulletDups.get(flat[i].gi).add(flat[j].sectionKey)
      bulletDups.get(flat[j].gi).add(flat[i].sectionKey)
    }
  }

  // ── 4. Tag bullets + per-section stats ────────────────────────────────────
  const sectionIdxByKey = new Map(rawSections.map(s => [s.sectionKey, s.sectionIndex]))
  let flatIdx = 0
  const sections = withBullets.map(sec => {
    const tagged = sec.bullets.map(b => {
      const dups    = bulletDups.get(flatIdx++) || new Set()
      const isSpine = b.spineThemes.length > 0
      const isDup   = dups.size > 0 && !isSpine
      const isUniq  = dups.size === 0 && !isSpine
      // Canonical = first (lowest sectionIndex) occurrence among all dup matches
      const isCanonical = isSpine
        ? false
        : isUniq
          ? true
          : [...dups].every(sk => (sectionIdxByKey.get(sk) ?? Infinity) > sec.sectionIndex)
      return { ...b, dupSections: [...dups], isSpine, isDup, isUnique: isUniq, isCanonical }
    })

    const total     = tagged.length
    const spineRefs = tagged.filter(b => b.isSpine).length
    const semDups   = tagged.filter(b => b.isDup).length
    const unique    = tagged.filter(b => b.isUnique).length
    const ratio     = total > 0 ? unique / total : 0
    const uniqueScore = ratio > 0.4 ? 'high' : ratio > 0.2 ? 'medium' : 'low'

    const fieldMap = Object.fromEntries(STAGE3_FIELD_ATOM_KEYS.map(k => [k, []]))
    tagged.forEach(b => { if (fieldMap[b.fieldKey]) fieldMap[b.fieldKey].push(b) })

    const uniq = tagged.filter(b => b.isUnique)
    const best = [...uniq.filter(b => b.fieldKey === 'risks'), ...uniq.filter(b => b.fieldKey !== 'risks')]
    const uniqueContrib = best.slice(0, 2).map(b => b.text).join(' · ')
      || '(no unique content detected)'

    // semanticLabel computed after tagging so it can use isUnique classification
    // Temporarily attach tagged so inferSemanticAreaLabel can read it
    const secWithTagged = { ...sec, taggedBullets: tagged }

    return {
      ...sec,
      mandate: inferSectionMandate(sec.atoms, sec.sectionIndex),
      semanticLabel: inferSemanticAreaLabel(secWithTagged),
      taggedBullets: tagged,
      fieldMap,
      stats: { total, spineRefs, semDups, unique, uniqueScore },
      uniqueContrib,
    }
  })

  // ── 5. Shared spine ────────────────────────────────────────────────────────
  const spineAgg = {}
  sections.forEach(sec =>
    sec.taggedBullets.forEach(b =>
      b.spineThemes.forEach(t => {
        if (!spineAgg[t.key]) spineAgg[t.key] = { theme: t, sectionKeys: new Set(), representative: b.text }
        spineAgg[t.key].sectionKeys.add(sec.sectionKey)
      })
    )
  )
  const spine = Object.values(spineAgg)
    .filter(e => e.sectionKeys.size >= 2)
    .map(e => ({
      ...e.theme,
      sectionCount: e.sectionKeys.size,
      representative: e.representative,
      contributingSecKeys: [...e.sectionKeys],
    }))
    .sort((a, b) => b.sectionCount - a.sectionCount)

  // ── 6. Execution plan — dimension-first aggregation ────────────────────────
  // For each field: collect canonical (non-spine, first-occurrence) bullets
  // from every section that contributes something, grouped by section.
  const executionPlan = {}
  EXEC_PLAN_FIELDS.forEach(fk => {
    const contributions = sections
      .map(sec => ({
        sectionKey:    sec.sectionKey,
        sectionIndex:  sec.sectionIndex,
        mandate:       sec.mandate,
        semanticLabel: sec.semanticLabel,
        bullets: (sec.fieldMap[fk] || [])
          .filter(b => b.isCanonical)
          .map(b => b.text),
      }))
      .filter(c => c.bullets.length > 0)
    executionPlan[fk] = contributions
  })

  return { spine, sections, executionPlan }
}

// ── Stage3BUPlanTree — dimension-first BU execution plan hierarchy ────────────

// Stage 3 Strategy Basis Compiler - derived view only. It reads the compact
// handoff brief plus current atoms and does not alter persisted Stage 3 atoms.
const PM_DECISION_PATTERNS = [
  { name: 'Build vs Partner', re: /build|partner|vendor|external/i, options: ['Build internally', 'Partner for selected capability', 'Hybrid build plus partner integration'] },
  { name: 'Investment Scope', re: /investment|budget|scope|tier 1|full-service|full service|margin|pricing/i, options: ['Narrow pilot scope', 'Fund full capability path', 'Stage investment behind evidence gates'] },
  { name: 'Architecture Boundaries', re: /architecture|modular|schema|connector|api|etl|interface|boundary/i, options: ['Fixed connector boundary', 'Extension-ready modular boundary', 'Custom integration exception path'] },
  { name: 'Pilot Validation Standard', re: /pilot|validation|evidence|threshold|workflow|completeness/i, options: ['Workflow mock validation', 'Controlled pilot evidence', 'Client plus SME review standard'] },
  { name: 'Rollout Gate', re: /rollout|scale|gate|go\/no-go|launch|sprint|release/i, options: ['Hold for evidence', 'Limited rollout', 'Scale after validation and dependency clearance'] },
]

const PM_RISK_TEMPLATES = [
  { name: 'False Validation Risk', re: /false|validation|pilot|sandbox|self-reported|workflow|client feedback/i, description: 'Validation may appear positive without proving that the product improves a real client workflow.', mitigations: ['Use observed workflow reviews, not only self-reported feedback', 'Test mocks or prototypes against realistic BSA/AML decisions', 'Document contradictions and unresolved objections before gate approval'], warnings: ['Positive feedback lacks observed workflow evidence', 'Pilot users need analyst translation to interpret outputs', 'Contradictory feedback is summarized away'], reduced: ['Observed use shows reduced friction or improved decision confidence', 'More than one review path supports the same conclusion', 'Assumptions remain tagged until confirmed'] },
  { name: 'Architecture Lock-In Risk', re: /architecture|lock|modular|schema|connector|api|etl|interface|core system/i, description: 'Early technical choices may lock the BU into brittle connectors, data mappings, or vendor assumptions before evidence is mature.', mitigations: ['Define interface boundaries before deep build', 'Separate reusable connector logic from custom ETL exceptions', 'Review architecture decisions against scale and regulatory change scenarios'], warnings: ['Connector work starts before schema coverage is confirmed', 'Custom ETL exceptions become the default path', 'Architecture choices depend on a single client or core system'], reduced: ['Architecture review confirms extension points and exception handling', 'Schema coverage gaps are visible before build commitment', 'Pilot scope can change without major rework'] },
  { name: 'Scope Expansion Risk', re: /scope|feature creep|generative ai|boundary|excluded|roadmap|full-service|full service/i, description: 'Execution can absorb adjacent feature, service, or AI commitments that blur the Tier 1 boundary.', mitigations: ['Publish explicit in-scope and out-of-scope boundaries', 'Use re-entry criteria for deferred features', 'Gate scope changes through evidence and commercial impact review'], warnings: ['Sales or delivery messages promise excluded capabilities', 'Pilot feedback expands scope without re-prioritization', 'Boundary exceptions are handled informally'], reduced: ['Scope exclusions and re-entry criteria are documented', 'Pilot agreements match product capability', 'Boundary changes are tied to evidence and margin impact'] },
  { name: 'Under-Investment Risk', re: /under.?investment|bandwidth|capacity|resourcing|engineering|api|delivery cost|consultant-hour|hours/i, description: 'The plan may require more product, engineering, delivery, or governance capacity than the current investment posture supports.', mitigations: ['Tie phase advancement to capacity confirmation', 'Quantify API and delivery bottlenecks before rollout', 'Escalate margin or labor impacts before scope is locked'], warnings: ['Critical-path inputs slip without replanning', 'Manual delivery effort remains hidden in completeness metrics', 'Engineering or delivery dependencies are treated as assumptions'], reduced: ['Capacity constraints are visible in gates', 'Labor and connector complexity are reflected in pricing or scope', 'Blocked inputs have an explicit escalation path'] },
  { name: 'Regulatory Evolution Risk', re: /regulatory|occ|fincen|compliance|model risk|explainability|audit|examiner/i, description: 'Regulatory or examiner expectations may change after product scope, explainability, or evidence standards are set.', mitigations: ['Keep Compliance and Model Risk inputs as context before scope lock', 'Maintain traceable explainability and exclusion rationale', 'Design validation evidence so it can support audit review'], warnings: ['Compliance review lags product specification', 'Explainability evidence is not tied to actual outputs', 'Regulatory assumptions are treated as final'], reduced: ['Scope and validation decisions have compliance traceability', 'Evidence package can answer examiner-facing questions', 'Open regulatory assumptions remain visible'] },
]

const PM_PHASES = [
  { name: 'Problem & Outcome Validation', objective: 'Clarify the priority use case, workflow outcome, and success signal before committing architecture or rollout scope.', options: [['Client workflow interviews', 'Use when the workflow problem is understood at a high level but the decision moment is unclear.', 'Surfaces where users struggle, what they trust, and what outcome matters.', 'Interview notes tied to workflow steps and decision points'], ['Mock explainability output review', 'Use when the team needs fast feedback before engineering build.', 'Tests whether users can interpret the output and whether it supports a real decision.', 'Annotated mock review, hesitation points, accepted/rejected interpretations'], ['SME/advisor review', 'Use when regulatory, domain, or BSA/AML interpretation risk is material.', 'Separates product usefulness from domain correctness and explainability fit.', 'SME disposition notes, unresolved objections, required terminology changes'], ['Support/sales signal analysis', 'Use when existing field conversations reveal recurring pain or adoption barriers.', 'Converts anecdotal demand into patterns that can guide pilot scope.', 'Tagged objection themes, demand signals, buyer confusion patterns'], ['Workflow observation', 'Use when stated needs may not match actual analyst or client behavior.', 'Produces observed evidence of friction, workarounds, and decision confidence.', 'Observation notes, before/after workflow comparison, friction log']], exit: ['Priority workflow is named', 'Outcome signal is observable', 'Unresolved assumptions are tagged before solution comparison'] },
  { name: 'Solution Path Evaluation', objective: 'Compare build, partner, hybrid, and scope alternatives against evidence, constraints, and commercial fit.', options: [['Build-vs-partner decision matrix', 'Use when external capability could accelerate delivery or reduce risk.', 'Makes tradeoffs explicit instead of burying them in architecture or dependency notes.', 'Option matrix with evidence, cost, control, integration, and timing implications'], ['Partner capability screen', 'Use when vendor claims need verification before roadmap dependency.', 'Tests whether a partner can meet workflow, integration, and explainability needs.', 'Vendor evidence checklist, integration gaps, contract or governance concerns'], ['Internal capability assessment', 'Use when build feasibility depends on scarce product or engineering capacity.', 'Links ambition to available architecture, data, and API bandwidth.', 'Capacity estimate, build risk notes, prerequisite inputs'], ['Commercial boundary comparison', 'Use when Tier 1 versus full-service scope affects margin or positioning.', 'Prevents solution choice from undermining pricing architecture.', 'Boundary scenarios, gross margin sensitivity, delivery labor impact']], exit: ['Preferred solution path is documented', 'Rejected paths have rationale', 'Evidence gaps are assigned to later gates rather than hidden'] },
  { name: 'Architecture & Delivery Readiness', objective: 'Define product, data, integration, and delivery boundaries before build work creates lock-in.', options: [['Architecture boundary review', 'Use before connector or dashboard build begins.', 'Confirms what is reusable, configurable, custom, deferred, or excluded.', 'Boundary spec, extension points, exception handling notes'], ['Schema and data coverage matrix', 'Use when core-system or use-case coverage determines pilot eligibility.', 'Prevents technical coverage from being confused with functional completeness.', 'Field coverage matrix, gap flags, ETL classification'], ['Delivery templateability audit', 'Use when delivery labor reduction is part of the strategy.', 'Shows which work can be productized and which still depends on consultants.', 'Consultant-hour baseline, manual intervention list, templateability score'], ['Compliance explainability review', 'Use when outputs may carry OCC, FinCEN, or model-risk scrutiny.', 'Ensures architecture and feature scope can support audit and examiner expectations.', 'Explainability memo, restricted fields, disclosure or exclusion rationale']], exit: ['Architecture boundaries are explicit', 'Critical dependencies are confirmed or gated', 'Delivery and compliance constraints are visible before pilot'] },
  { name: 'Pilot / Controlled Rollout', objective: 'Expose the solution to realistic workflow use while limiting client, regulatory, and delivery risk.', options: [['Controlled client pilot', 'Use when real workflow evidence is needed before broader launch.', 'Tests usefulness, completeness, and delivery effort under bounded conditions.', 'Pilot notes, completeness results, client objections, workflow outcomes'], ['Parallel mock-to-live comparison', 'Use when mock validation may not reflect production behavior.', 'Checks whether prototype assumptions survive real data and users.', 'Variance log between mock expectations and live use'], ['Delivery operations dry run', 'Use when onboarding effort or support load is a major risk.', 'Validates whether the operating model can support rollout without hidden labor.', 'Runbook gaps, escalation events, support burden estimate'], ['Regulatory evidence package review', 'Use when pilot outputs may need audit defensibility.', 'Tests whether the evidence record can explain product decisions and boundaries.', 'Evidence binder, compliance comments, unresolved regulatory assumptions']], exit: ['Pilot evidence meets the validation standard', 'Rework triggers are resolved or accepted', 'Rollout risks are visible before scale'] },
  { name: 'Scale Decision', objective: 'Decide whether to scale, hold, narrow, or redirect based on observed evidence and dependency readiness.', options: [['Go/no-go gate review', 'Use when leadership needs a clean scale decision.', 'Forces the decision to cite evidence, dependencies, risks, and unresolved assumptions.', 'Gate memo, decision rationale, conditions for scale'], ['Segmented rollout plan', 'Use when evidence is strong for some clients, core systems, or use cases but not all.', 'Avoids all-or-nothing scaling while preserving evidence discipline.', 'Eligible segment list, excluded segment rationale, next validation needs'], ['Scope adjustment workshop', 'Use when validation shows value but boundaries need refinement.', 'Turns pilot learning into a narrower or more durable execution scope.', 'Revised scope, deferred items, Stage 4 requirements candidates'], ['Post-pilot risk burn-down review', 'Use when risks remain material but manageable.', 'Confirms which risks reduced, which remain, and which require coordination.', 'Risk evidence summary, mitigation status, residual risk notes']], exit: ['Scale decision is evidence-backed', 'Deferred work is routed to coordination or Stage 4', 'Source traceability remains available'] },
]

const STAGE3_COMPILED_STRATEGY_LEARNING_SIGNALS = {
  productIntent: [
    'Stage 3 compiled strategy is a BU-readable decision-support artifact.',
    'It converts Stage 2 handoff evidence, Stage 3 atomized detail, shared spine, source references, and review learning into decisions, execution logic, dependencies, mitigated risks, validation criteria, and traceability.',
    'It should compile, compress, organize, and audit rather than copy Stage 2 or restate atomized Stage 3 buckets.',
  ],
  acceptedStructure: [
    'Strategic Objective',
    'Critical Decisions',
    'Execution Sequence',
    'Dependencies',
    'Risk & Mitigation',
    'Validation Framework',
    'Handoff Coverage / Loss Audit',
  ],
  generalLearningSignals: [
    'Stage 3 should compile, not copy, Stage 2 handoff content.',
    'Compression must be auditable.',
    'The compiled view should reduce repetition across strategy, decisions, gates, risks, dependencies, and validation.',
    'Each BU plan must define what the unit must accomplish.',
    'Each BU plan must identify decisions that block, shape, or materially change execution.',
    'Each BU plan must include realistic execution methods appropriate to that BU role.',
    'Each BU plan must distinguish dependencies from risks.',
    'Each BU plan must define mitigation options for material risks.',
    'Each BU plan must define how validation is completed.',
    'Each BU plan must state what evidence counts and how evidence quality is assessed.',
    'Handoff content must be classified as used, compressed, converted, deferred, source-only, unused, or possibly lost.',
    'Cross-BU ownership and reciprocal dependency assignment belong in Cross-BU Coordination, not forced into every BU risk section.',
    'No generated strategic text should be truncated.',
    'Do not use first-N-words labels or ellipsis labels as semantic structure.',
    'The compiled plan should prefer clear, role-specific labels over sliced source text.',
  ],
  prohibitedPatterns: [
    'repeating the same recommendation across multiple compiled sections',
    'turning every compiled section into a mini-plan',
    'generating only what statements without how',
    'generic end-to-end options such as validation first, architecture first, or partner first',
    'copying large blocks of handoff text into the compiled strategy',
    'silently dropping Stage 2 handoff content',
    'risks without mitigation options',
    'validation criteria that only say pilot metrics achieved',
    'validation content without completion criteria',
    'validation content without veracity checks',
    'dependencies that overlap with risks without clarifying the distinction',
    'adding owners where ownership belongs in Cross-BU Coordination',
    'visible labels derived from string slices',
    'visible strategic content with ellipses or truncation',
  ],
  qualityChecks: [
    { id: 'accepted_structure', label: 'Compiled strategy follows the accepted structure.', category: 'compiledBUExecutionPlan' },
    { id: 'decision_depth', label: 'Each critical decision includes why it matters and evidence needed.', category: 'criticalDecisions' },
    { id: 'phase_how_options', label: 'Execution sequence includes phase-specific practical how options.', category: 'executionSequence', minHowOptionsPerPhase: 3 },
    { id: 'execution_method_fit', label: 'Each execution method explains why it fits the phase objective and identifies evidence produced.', category: 'executionSequence' },
    { id: 'risk_mitigation_depth', label: 'Risks include mitigation options, early warnings, and evidence of reduction.', category: 'risksAndMitigations', requiredFields: ['mitigationOptions', 'earlyWarningSignals', 'evidenceThatRiskIsReduced'] },
    { id: 'validation_depth', label: 'Validation includes criteria, completion method, evidence, veracity, and rework triggers.', category: 'validationFramework', requiredFields: ['completionCriteria', 'howToDetermineCompletion', 'evidenceExamples', 'veracityChecks', 'failureOrReworkTriggers'] },
    { id: 'dependency_distinction', label: 'Dependencies remain distinct from risks and validation.', category: 'dependencies' },
    { id: 'no_forced_risk_ownership', label: 'Ownership is not forced inside BU risk sections.', category: 'risksAndMitigations' },
    { id: 'auditable_compression', label: 'Compression is auditable through handoff coverage.', category: 'handoffCoverageAudit' },
    { id: 'handoff_classification', label: 'Handoff content is classified across coverage buckets.', category: 'handoffCoverageAudit' },
    { id: 'no_truncated_strategy_text', label: 'No generated strategic text is truncated.', category: 'compiledBUExecutionPlan' },
    { id: 'reduce_repetition', label: 'Compiled view reduces repetition compared with atomized buckets.', category: 'compiledBUExecutionPlan' },
  ],
  buAdaptationGuidance: {
    executive: ['investment authority', 'decision thresholds', 'governance cadence', 'prioritization tradeoffs', 'escalation criteria'],
    compliance: ['regulatory interpretation', 'documentation standards', 'review checkpoints', 'evidence sufficiency', 'model-risk concerns', 'examiner readiness'],
    engineering: ['capacity constraints', 'integration feasibility', 'technical sequencing', 'interface contracts', 'non-functional requirements', 'architecture risk'],
    goToMarket: ['positioning', 'buyer segmentation', 'launch readiness', 'messaging validation', 'sales enablement', 'commercial signal quality'],
    partner: ['vendor evaluation', 'commercial terms', 'integration risk', 'substitution rights', 'partner dependency', 'procurement readiness'],
    delivery: ['workflow validation', 'client readiness', 'operational adoption', 'delivery burden', 'support model', 'implementation feedback loops'],
    productArchitecture: ['use cases', 'outcomes', 'workflow evidence', 'mock/prototype validation', 'solution path comparison', 'architecture review', 'pilot evidence'],
  },
  pmValidationCaseGuidance: {
    phases: PM_PHASES,
    risks: PM_RISK_TEMPLATES,
    evidenceExamples: ['annotated mock review', 'workflow walkthrough notes', 'before/after workflow comparison', 'client feedback summary', 'Managed Client Delivery review notes', 'recorded objections', 'unresolved concerns', 'architecture review notes', 'interface specification', 'comparative vendor scorecard'],
    veracityChecks: ['evidence is observed, not only self-reported', 'evidence comes from more than one client/workflow where possible', 'contradictory feedback is documented', 'assumptions are tagged unresolved', 'decision rationale is traceable', 'evidence shows decision impact, not just user preference'],
  },
}

function Stage3SelectiveRegenerationDiagnostics({ plan }) {
  const [open, setOpen] = useState(false)
  if (!plan) return null
  const changed = plan.handoffChanges || []
  return (
    <div style={{ marginTop: 8, border: '1px solid var(--border)', borderRadius: 5, overflow: 'hidden', background: 'var(--surface)' }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', padding: '7px 9px', background: 'var(--s2)' }}
      >
        <Badge color={plan.willRegenerate ? '#fb923c' : '#00e5b4'} small>{plan.regenerationMode || 'smart'}</Badge>
        <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', flex: 1 }}>
          Handoff Changes Driving Regeneration - {plan.staleAtoms || 0} stale / {plan.totalAtoms || 0} atoms, {plan.willRegenerate || 0} will regenerate, {plan.willSkip || 0} will skip
        </span>
        <span style={{ fontSize: 8, color: 'var(--muted)' }}>{open ? 'hide' : 'show'}</span>
      </div>
      {open && (
        <div style={{ padding: '8px 9px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            <Badge color="#3b82f6" small>{plan.totalAtoms || 0} total atoms</Badge>
            <Badge color="#00e5b4" small>{plan.currentAtoms || 0} current atoms</Badge>
            <Badge color="#fb923c" small>{plan.staleDueToHandoffItemChange || 0} stale: handoff change</Badge>
            <Badge color="#fb923c" small>{plan.staleDueToLearningBasisChange || 0} stale: learning basis</Badge>
            <Badge color="#fb923c" small>{plan.staleDueToMissingMetadata || 0} stale: missing metadata</Badge>
            <Badge color="#fb923c" small>{plan.staleDueToStage3BasisChange || 0} stale: Stage 3 basis</Badge>
            <Badge color="#f87171" small>{plan.staleDueToMissingSourceItem || 0} stale: missing source</Badge>
            <Badge color="#a3e635" small>{plan.sourceHandoffItemsChanged || 0} source items changed</Badge>
            <Badge color="var(--muted)" small>{plan.sourceHandoffItemsUnchanged || 0} source items unchanged</Badge>
          </div>
          <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.45 }}>
            generationRunId {plan.generationRunId || 'not assigned'} - atom set {plan.atomSetCurrency || 'unknown'}
          </div>
          {changed.length > 0 ? (
            <div>
              <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 5 }}>
                Changed Handoff Items
              </div>
              {changed.map(change => (
                <div key={change.handoffItemId} style={{ border: '1px solid rgba(251,146,60,.25)', borderRadius: 4, padding: '7px 8px', marginBottom: 6, background: 'rgba(251,146,60,.04)' }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>{change.handoffItemTitle}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 5 }}>
                    <Field label="previous hash" value={change.previousHash || 'not available'} />
                    <Field label="current hash" value={change.currentHash || 'not available'} />
                    <Field label="affected atom count" value={String(change.affectedAtomCount || 0)} />
                    <Field label="affected fields" value={(change.affectedGeneratedFields || []).join(', ')} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted2)' }}>
              No changed handoff items are mapped to stale atoms. Smart regeneration will skip all atoms unless metadata or basis versions require regeneration.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function normalizeHandoffItemForHash(item = {}) {
  return {
    key: item.key || item.sourceRefId || item.id || item.label || item.name || '',
    label: item.label || item.name || item.title || item.elementName || '',
    text: item.text || '',
    parsedValue: item.parsedValue || null,
    childAtoms: item.childAtoms || null,
    detail: item.detail || '',
    status: item.status || '',
    sourceRefId: item.sourceRefId || null,
  }
}

function buildStage3HandoffItemBasis(item = {}, idx = 0) {
  const normalized = normalizeHandoffItemForHash(item)
  const handoffItemId = String(normalized.key || normalized.sourceRefId || storageSafeName(normalized.label) || idx)
  const handoffItemTitle = normalized.label || normalized.key || `Handoff item ${idx + 1}`
  const contentHash = stage3TraceHash(normalized)
  return {
    handoffItemId,
    handoffItemTitle,
    handoffItemHash: contentHash,
    handoffItemContentHash: contentHash,
    handoffItemUpdatedAt: item.updatedAt || item.completedAt || item.lastSavedAt || item.generatedAt || null,
  }
}

function buildStage3HandoffBasis(items = []) {
  const itemBasis = (items || []).map(buildStage3HandoffItemBasis)
  return {
    itemBasis,
    itemHashById: Object.fromEntries(itemBasis.map(item => [item.handoffItemId, item.handoffItemHash])),
    basisHash: stage3TraceHash(itemBasis.map(item => ({
      id: item.handoffItemId,
      hash: item.handoffItemHash,
      updatedAt: item.handoffItemUpdatedAt,
    }))),
  }
}

function getAtomSourceBasis(atom) {
  const meta = atom?.metadata || {}
  const idList = Array.isArray(meta.generatedFromHandoffItemIds)
    ? meta.generatedFromHandoffItemIds.map(id => String(id || '').trim()).filter(Boolean)
    : listFromValue(meta.generatedFromHandoffItemIds).map(id => String(id || '').trim()).filter(Boolean)
  return {
    generatedFromBUName: meta.generatedFromBUName,
    generatedFromHandoffBasisHash: meta.generatedFromHandoffBasisHash,
    generatedFromLearningBasisHash: meta.generatedFromLearningBasisHash,
    learningSignalsVersion: meta.learningSignalsVersion,
    generatedFromStage3BasisVersion: meta.generatedFromStage3BasisVersion,
    generatedFromHandoffItemIds: idList,
    generatedFromHandoffItemHashes: meta.generatedFromHandoffItemHashes || {},
  }
}

function classifyStage3AtomStaleness(atom, unitName, handoffBasis, itemBasis, learningBasisHash = null) {
  if (!atom || !atomIsValidDraft(atom)) return { stale: true, reason: 'missing metadata', reasonKey: 'missingMetadata' }
  const source = getAtomSourceBasis(atom)
  if (!source.generatedFromBUName || source.generatedFromBUName !== unitName) return { stale: true, reason: 'BU name mismatch', reasonKey: 'missingMetadata' }
  if (source.learningSignalsVersion !== STAGE3_LEARNING_SIGNALS_VERSION || !source.generatedFromLearningBasisHash || (learningBasisHash && source.generatedFromLearningBasisHash !== learningBasisHash)) return { stale: true, reason: 'learning basis changed', reasonKey: 'learningBasisChanged' }
  if (source.generatedFromStage3BasisVersion !== STAGE3_BASIS_VERSION) return { stale: true, reason: 'Stage 3 basis changed', reasonKey: 'stage3BasisChanged' }
  if (source.generatedFromHandoffBasisHash && source.generatedFromHandoffBasisHash !== handoffBasis.basisHash) {
    const ids = source.generatedFromHandoffItemIds
    const hasItemMapping = ids.length && ids.every(id => source.generatedFromHandoffItemHashes?.[id])
    if (!hasItemMapping) return { stale: true, reason: 'prior global handoff basis cannot be item-mapped', reasonKey: 'priorGlobalBasis' }
  }
  const ids = source.generatedFromHandoffItemIds
  if (!ids.length) return { stale: true, reason: 'missing handoff item mapping', reasonKey: 'missingMetadata' }
  for (const id of ids) {
    const currentHash = handoffBasis.itemHashById[id]
    const previousHash = source.generatedFromHandoffItemHashes?.[id]
    if (!currentHash) return { stale: true, reason: 'required source item missing', reasonKey: 'sourceItemMissing' }
    if (!previousHash || previousHash !== currentHash) {
      return {
        stale: true,
        reason: 'handoff item changed',
        reasonKey: 'handoffItemChanged',
        handoffItemId: id,
        previousHash,
        currentHash,
        handoffItemTitle: itemBasis?.handoffItemTitle || id,
      }
    }
  }
  return { stale: false, reason: 'source hashes match', reasonKey: 'current' }
}

function firstSentence(text, max = 210) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  const sentence = clean.match(/^.{1,220}?[.!?](\s|$)/)?.[0]?.trim()
  const chosen = sentence || clean
  return chosen
}

function compiledText(value) {
  if (Array.isArray(value)) return value.map(compiledText).filter(Boolean).join(' ')
  if (value && typeof value === 'object') return Object.values(value).map(compiledText).filter(Boolean).join(' ')
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function normalizeSearchText(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value.toLowerCase().trim()
  if (Array.isArray(value)) return value.map(normalizeSearchText).filter(Boolean).join(' ')
  if (typeof value === 'object') {
    return [
      value.name,
      value.title,
      value.label,
      value.buName,
      value.unitName,
      value.teamName,
      value.domainOfWork,
      value.sectionName,
      value.summary,
    ].map(normalizeSearchText).filter(Boolean).join(' ')
  }
  return String(value).toLowerCase().trim()
}

function normalizeTokenArray(value) {
  if (value == null) return []
  if (Array.isArray(value)) {
    return value
      .flatMap(normalizeTokenArray)
      .map(v => String(v).toLowerCase().trim())
      .filter(Boolean)
  }
  if (value instanceof Set) return normalizeTokenArray([...value])
  if (value instanceof Map) return normalizeTokenArray([...value.values()])
  if (typeof value === 'string') {
    return value
      .toLowerCase()
      .split(/[^a-z0-9&/.-]+/i)
      .map(v => v.trim())
      .filter(Boolean)
  }
  if (typeof value === 'object') {
    return normalizeTokenArray([
      value.name,
      value.title,
      value.label,
      value.key,
      value.id,
      value.summary,
      value.description,
      value.text,
      value.value,
      value.teamName,
      value.buName,
      value.unitName,
      value.sectionName,
      value.domainOfWork,
    ])
  }
  return normalizeTokenArray(String(value))
}

function inferCompiledBUProfile({ draft, legacyPlan, handoffBrief, tree }) {
  const text = normalizeSearchText([
    legacyPlan?.buName,
    legacyPlan?.mission,
    legacyPlan?.strategicRole,
    draft?.plan?.buName,
    draft?.plan?.mission,
    handoffBrief?.businessUnitName,
    handoffBrief?.planningPurpose,
    handoffBrief?.decisionBasisSummary,
    tree?.sections?.map(section => [section.sectionName, section.semanticLabel].join(' ')),
  ])
  if (/product|competitive|architecture|pdlc|roadmap|use case|prototype|mock/.test(text)) return 'productArchitecture'
  if (/executive|governance|leadership|investment authority|priorit/.test(text)) return 'executive'
  if (/compliance|model risk|regulatory|occ|fincen|examiner|audit/.test(text)) return 'compliance'
  if (/api|engineering|integration|technical|interface|infrastructure|platform/.test(text)) return 'engineering'
  if (/go.to.market|sales|channel|marketing|buyer|positioning|commercial/.test(text)) return 'goToMarket'
  if (/partner|vendor|procurement|ecosystem/.test(text)) return 'partner'
  if (/delivery|client|implementation|managed|support|adoption|workflow/.test(text)) return 'delivery'
  return 'general'
}

function roleLearningTerms(profile) {
  return STAGE3_COMPILED_STRATEGY_LEARNING_SIGNALS.buAdaptationGuidance[profile] || ['operating outcome', 'decision gate', 'execution method', 'dependency input', 'risk mitigation', 'validation evidence']
}

function stage3SourceRefsFrom(handoffBrief, sectionKey = null) {
  const refs = handoffBrief?.evidenceRefs || []
  const matched = sectionKey ? refs.filter(ref => ref.id === sectionKey || ref.pointer?.includes(sectionKey)) : refs
  return (matched.length ? matched : refs.slice(0, 2)).map(ref => ({
    sourceTitle: ref.title || ref.id || 'Stage 2 source',
    sourceType: 'stage2-handoff',
    sourceId: ref.id || ref.pointer || null,
    stage2Link: ref.pointer || (ref.id ? `stage2:${handoffBrief?.businessUnitName || 'unknown'}:${ref.id}` : null),
  }))
}

function allTreeBullets(tree, fieldKey = null) {
  return (tree?.sections || []).flatMap(section =>
    (section.taggedBullets || [])
      .filter(b => !fieldKey || b.fieldKey === fieldKey)
      .map(b => ({ ...b, sectionKey: section.sectionKey, sectionName: section.sectionName })),
  )
}

function pickBulletTexts(tree, fieldKey, re, max = 4) {
  return allTreeBullets(tree, fieldKey).filter(b => !re || re.test(b.text)).map(b => b.text).filter(Boolean).slice(0, max)
}

function genericDecisionPatterns(profile) {
  const terms = roleLearningTerms(profile)
  return [
    { name: `${terms[0] || 'Outcome'} Priority`, re: /outcome|priority|scope|decision|gate|threshold/i, options: ['Proceed with current scope', 'Narrow to strongest evidence path', 'Defer until missing evidence is resolved'] },
    { name: `${terms[1] || 'Execution'} Boundary`, re: /boundary|constraint|scope|capacity|dependency|handoff/i, options: ['Keep boundary narrow', 'Expand after readiness evidence', 'Route reciprocal ownership to coordination'] },
    { name: `${terms[2] || 'Readiness'} Standard`, re: /readiness|validation|evidence|review|pilot|approval/i, options: ['Use observed evidence', 'Require cross-functional review', 'Hold until evidence quality improves'] },
  ]
}

function buildCompiledCriticalDecisions(tree, handoffBrief, profile) {
  const allDecisionText = pickBulletTexts(tree, 'decisionsRequired', null, 40)
  const patterns = profile === 'productArchitecture' ? PM_DECISION_PATTERNS : genericDecisionPatterns(profile)
  return patterns.map(pattern => {
    const hits = allDecisionText.filter(text => pattern.re.test(text))
    const basis = hits[0] || ''
    return {
      decisionName: pattern.name,
      decisionQuestion: basis ? firstSentence(basis, 230) : `What ${pattern.name.toLowerCase()} position should govern execution?`,
      whyItMatters: hits[1] ? firstSentence(hits[1], 220) : 'This decision changes scope, sequencing, dependency readiness, and the evidence required before rollout.',
      decisionOptions: pattern.options,
      decisionEvidenceNeeded: [...hits.slice(0, 2).map(text => firstSentence(text, 180)), 'Observed validation evidence, dependency readiness, and source-traceable rationale.'].filter(Boolean).slice(0, 4),
      decisionTiming: /before|prior|precede|gate|sprint|pilot/i.test(basis) ? firstSentence(basis, 170) : 'Resolve before the dependent execution phase proceeds.',
      sourceRefs: stage3SourceRefsFrom(handoffBrief),
    }
  })
}

const GENERAL_PHASES = [
  { name: 'Operating Outcome Clarification', objective: 'Clarify the BU-specific outcome, decision context, and evidence standard before committing execution capacity.', options: [['Stakeholder workflow review', 'Use when the operating problem or decision moment needs clarification.', 'Connects execution to the work this BU actually performs.', 'Workflow notes and outcome criteria'], ['Current-state evidence review', 'Use when existing artifacts or signals can validate the starting point.', 'Prevents execution from starting on untested assumptions.', 'Evidence inventory and unresolved assumptions'], ['SME review session', 'Use when domain interpretation or operating feasibility matters.', 'Grounds the plan in role-specific judgment.', 'SME findings and decision implications']] },
  { name: 'Execution Path Selection', objective: 'Compare feasible execution paths and decide which path best fits the BU role and constraints.', options: [['Option comparison', 'Use when multiple execution approaches are viable.', 'Makes tradeoffs explicit before downstream work begins.', 'Option matrix and rationale'], ['Capability readiness check', 'Use when execution depends on capacity, tools, or expertise.', 'Links ambition to available operating capacity.', 'Readiness gaps and prerequisites'], ['Dependency input review', 'Use when other units shape the feasible path.', 'Keeps dependencies distinct from risk statements.', 'Required inputs and consequence notes']] },
  { name: 'Readiness & Control Design', objective: 'Define controls, handoffs, and evidence needed before execution moves into a controlled run.', options: [['Readiness gate review', 'Use before work crosses into delivery or external exposure.', 'Confirms critical inputs, constraints, and evidence standards.', 'Gate checklist and open blockers'], ['Control/evidence design', 'Use when auditability, governance, or quality assurance matters.', 'Ensures execution can be validated after the fact.', 'Evidence plan and control notes'], ['Dry run or tabletop review', 'Use when coordination or operating behavior needs rehearsal.', 'Surfaces friction before live execution.', 'Dry-run findings and rework list']] },
  { name: 'Controlled Execution', objective: 'Run the selected approach in a bounded way that produces evidence without overcommitting scale.', options: [['Controlled pilot or operating trial', 'Use when evidence is needed before scale.', 'Tests the approach under bounded conditions.', 'Trial results and observed exceptions'], ['Parallel comparison', 'Use when new and current approaches can be compared.', 'Shows whether execution improves outcomes versus baseline.', 'Before/after or side-by-side comparison'], ['Feedback loop review', 'Use when adoption or operating quality matters.', 'Captures objections and failure signals while changes are still small.', 'Feedback themes and unresolved concerns']] },
  { name: 'Scale / Continue / Rework Decision', objective: 'Decide whether to scale, hold, narrow, defer, or rework based on evidence quality and dependency readiness.', options: [['Evidence-based gate decision', 'Use when leadership or BU operators need a clear next step.', 'Forces the decision to cite evidence and unresolved assumptions.', 'Gate rationale and decision record'], ['Scope adjustment review', 'Use when the approach works but the boundary needs refinement.', 'Turns learning into a better-bounded execution plan.', 'Revised scope and deferred items'], ['Risk burn-down review', 'Use when risks remain material but manageable.', 'Confirms which risks reduced and which require coordination.', 'Risk evidence and mitigation status']] },
]

function buildCompiledExecutionSequence(tree, handoffBrief, profile) {
  const validationEvidence = pickBulletTexts(tree, 'validationSignals', null, 12)
  const sequencingEvidence = pickBulletTexts(tree, 'sequencingAndGates', null, 12)
  const phases = profile === 'productArchitecture' ? STAGE3_COMPILED_STRATEGY_LEARNING_SIGNALS.pmValidationCaseGuidance.phases : GENERAL_PHASES
  return phases.map((phase, idx) => ({
    phaseName: phase.name,
    phaseObjective: phase.objective,
    howOptions: phase.options.map(([optionName, whenToUse, whyItFits, evidenceProduced]) => ({ optionName, whatItDoes: optionName, whenToUse, whyItFitsThePhaseOutcome: whyItFits, evidenceProduced })),
    recommendedHow: phase.options[0][0],
    whyThisFitsThePhase: idx === 0 ? 'The plan should validate workflow value before architecture or rollout commitments harden.' : idx === 1 ? 'Solution alternatives are useful only after the outcome and evidence standard are clear.' : idx === 2 ? 'Readiness work prevents pilot learning from being polluted by unresolved architecture or delivery constraints.' : idx === 3 ? 'A controlled pilot creates observed evidence while limiting risk.' : 'Scale should follow evidence, dependency readiness, and risk burn-down.',
    exitCriteria: phase.exit,
    evidenceExamples: [...validationEvidence.slice(idx, idx + 2), ...sequencingEvidence.slice(idx, idx + 1)].filter(Boolean).slice(0, 4),
    sourceRefs: stage3SourceRefsFrom(handoffBrief),
  }))
}

function buildCompiledDependencies(tree, handoffBrief) {
  return pickBulletTexts(tree, 'dependencies', null, 10).slice(0, 8).map((text, idx) => ({
    dependencyName: firstSentence(text, 80).replace(/\s+must\b.*$/i, '').replace(/\s+is required\b.*$/i, '').trim() || `Dependency ${idx + 1}`,
    dependencyDescription: firstSentence(text, 260),
    whyItMatters: /gate|block|before|prerequisite|required/i.test(text) ? firstSentence(text, 220) : 'This input conditions whether the BU can execute the relevant phase with confidence.',
    requiredInput: firstSentence(text, 210),
    consequenceIfMissing: /before|block|gate|cannot|risk/i.test(text) ? 'Execution proceeds on assumptions or blocks the dependent gate.' : 'The plan loses evidence quality and may require rework.',
    sourceRefs: stage3SourceRefsFrom(handoffBrief),
  }))
}

function genericRiskTemplates(tree, profile) {
  const terms = roleLearningTerms(profile)
  const riskTexts = pickBulletTexts(tree, 'risks', null, 5)
  const fallback = [
    `${terms[0] || 'Operating outcome'} risk`,
    `${terms[1] || 'Decision gate'} risk`,
    `${terms[2] || 'Execution method'} readiness risk`,
  ]
  return (riskTexts.length ? riskTexts : fallback).slice(0, 5).map((text, idx) => ({
    name: inferRiskName(text, idx, profile),
    re: /./,
    description: firstSentence(text || fallback[idx] || 'Execution risk may reduce confidence in the BU plan.'),
    mitigations: ['Define the evidence needed before advancing the next gate', 'Use a bounded execution method before scaling commitment', 'Escalate cross-BU ownership or reciprocal dependency questions to coordination'],
    warnings: ['Required evidence remains assumption-based', 'The BU cannot explain how the risk is reducing', 'Dependencies or constraints change without revisiting the plan'],
    reduced: ['Observed evidence supports the decision path', 'Residual assumptions are documented and bounded', 'Mitigation status is traceable to source or execution evidence'],
  }))
}

function inferRiskName(text, idx, profile) {
  const normalized = normalizeSearchText(text)
  if (/regulatory|compliance|examiner|model risk/.test(normalized)) return 'Regulatory Evidence Risk'
  if (/capacity|bandwidth|resourcing/.test(normalized)) return 'Capacity Constraint Risk'
  if (/dependency|handoff|input/.test(normalized)) return 'Dependency Readiness Risk'
  if (/adoption|client|workflow|delivery/.test(normalized)) return 'Operating Adoption Risk'
  const terms = roleLearningTerms(profile)
  return `${terms[idx % terms.length] || 'Execution'} Risk`
}

function buildCompiledRisks(tree, handoffBrief, profile) {
  const riskTexts = pickBulletTexts(tree, 'risks', null, 40)
  const templates = profile === 'productArchitecture'
    ? STAGE3_COMPILED_STRATEGY_LEARNING_SIGNALS.pmValidationCaseGuidance.risks
    : genericRiskTemplates(tree, profile)
  return templates.map(template => {
    const hits = riskTexts.filter(text => template.re.test(text))
    const useTemplateText = profile !== 'productArchitecture'
    return {
      riskName: template.name,
      riskDescription: useTemplateText ? template.description : hits[0] ? firstSentence(hits[0], 260) : template.description,
      whyItMatters: useTemplateText ? template.description : hits[1] ? firstSentence(hits[1], 220) : template.description,
      mitigationOptions: template.mitigations,
      earlyWarningSignals: template.warnings,
      evidenceThatRiskIsReduced: template.reduced,
      sourceRefs: stage3SourceRefsFrom(handoffBrief),
    }
  })
}

function buildCompiledValidationFramework(tree, handoffBrief, profile) {
  const validationTexts = pickBulletTexts(tree, 'validationSignals', null, 16)
  const terms = roleLearningTerms(profile)
  const questions = profile === 'productArchitecture'
    ? ['Does the output improve a real BSA/AML or product workflow decision?', 'Is the architecture and data coverage valid enough to support the promised product boundary?', 'Is the pilot standard strong enough to justify rollout or scale?', 'Are regulatory and explainability assumptions traceable enough to proceed?']
    : [`Does this BU execution path improve the ${terms[0] || 'operating outcome'} it is responsible for?`, `Are the ${terms[1] || 'decision'} and dependency inputs complete enough to proceed?`, `Is the evidence strong enough to advance the next BU-specific gate?`]
  const evidenceExamples = profile === 'productArchitecture'
    ? STAGE3_COMPILED_STRATEGY_LEARNING_SIGNALS.pmValidationCaseGuidance.evidenceExamples
    : ['observed workflow notes', 'readiness review notes', 'before/after operating comparison', 'stakeholder feedback summary', 'decision record', 'unresolved concerns log']
  const veracityChecks = profile === 'productArchitecture'
    ? STAGE3_COMPILED_STRATEGY_LEARNING_SIGNALS.pmValidationCaseGuidance.veracityChecks
    : ['evidence is observed or source-traceable, not only asserted', 'contradictory feedback is documented', 'assumptions are tagged unresolved', 'decision rationale is traceable', 'evidence shows operating impact, not only preference']
  return questions.map((question, idx) => ({
    validationQuestion: question,
    completionCriteria: [validationTexts[idx] ? firstSentence(validationTexts[idx], 210) : 'The target user can use the output in a realistic workflow without extra translation.', 'The evidence supports a real workflow decision or reduces observable friction.', 'Contradictory feedback and unresolved assumptions are documented.'],
    howToDetermineCompletion: ['Observe mock, prototype, or pilot use in a realistic workflow.', 'Compare expected use against actual user interpretation.', 'Document hesitation, rejection, reinterpretation, and decision changes.', 'Confirm whether effort, confidence, or workflow quality improves.'],
    evidenceExamples,
    veracityChecks,
    failureOrReworkTriggers: ['Users cannot interpret the output without analyst translation.', 'The output does not change a decision, reduce effort, or improve confidence.', 'Evidence conflicts are unresolved before the gate.'],
    sourceRefs: stage3SourceRefsFrom(handoffBrief),
  }))
}

function maxIso(values) {
  const times = (values || []).map(value => Date.parse(value)).filter(Number.isFinite)
  if (!times.length) return null
  return new Date(Math.max(...times)).toISOString()
}

function minIso(values) {
  const times = (values || []).map(value => Date.parse(value)).filter(Number.isFinite)
  if (!times.length) return null
  return new Date(Math.min(...times)).toISOString()
}

function sourceRefCountFrom(handoffBrief) {
  return Math.max(
    handoffBrief?.evidenceRefs?.length || 0,
    handoffBrief?.sourceStage2SectionIds?.length || 0,
  )
}

function buildCoverageDataSources(handoffBrief, handoffItems, tree, compiledPlan) {
  return {
    stage2HandoffItems: Array.isArray(handoffItems) ? handoffItems.length : 0,
    sourceRefs: sourceRefCountFrom(handoffBrief),
    compiledStrategyText: compiledText(compiledPlan).length,
    spineText: tree?.spine?.length || 0,
    atomizedText: allTreeBullets(tree).length,
  }
}

function draftIdentityFor(draft, legacyPlan, resolved, handoffBrief) {
  if (draft?.draftVersionId) return draft.draftVersionId
  if (draft?.id) return draft.id
  if (draft?.storageKey) return draft.storageKey
  const basis = [
    draft?.version || 'legacy',
    draft?.sourceBasisRevisionId || draft?.provenance?.stage1Id,
    draft?.sourceStage2RevisionId || draft?.provenance?.stage2Id,
    draft?.buName || draft?.businessUnitName || legacyPlan?.buName || handoffBrief?.businessUnitName,
    draft?.persistedAt || legacyPlan?.generatedAt || resolved?.source,
  ].filter(Boolean).join(':')
  return basis ? stage3TraceHash(basis) : 'unknown'
}

function describeCompiledStrategySource({ draft, legacyPlan, resolved, compiledError = false }) {
  if (compiledError) return 'atomized fallback'
  const atoms = resolved?.atoms || []
  const importedCapture = draft?.source === 'browser_dom_visible_stage3_capture'
    || atoms.some(atom => atom?.metadata?.captureSource === 'browser_dom_visible_stage3_capture')
  if (importedCapture) return 'imported runtime capture'
  if (resolved?.source === 'migrated legacy Stage 3 revision') return 'stale prior draft'
  if (draft?.lifecycle?.acceptedAt || draft?.acceptedAt || draft?.accepted || draft?.lifecycle?.status === LIFECYCLE_STATES.ACCEPTED) return 'accepted draft'
  if (draft?.plan || draft?.executionAtoms?.length) return 'current generated-but-unaccepted draft'
  if (legacyPlan) return 'stale prior draft'
  return 'atomized fallback'
}

function buildCompiledStrategyProvenance({ draft, legacyPlan, handoffBrief, handoffItems, tree, resolved, generationState, compiledPlan = null, compiledAt, coverageAuditAt = null, qualityAuditAt = null, compiledError = false }) {
  const atoms = resolved?.atoms || []
  const sourceType = describeCompiledStrategySource({ draft, legacyPlan, resolved, compiledError })
  const dataSourcesUsed = buildCoverageDataSources(handoffBrief, handoffItems, tree, compiledError ? null : compiledPlan)
  const atomCountUsedByCompiler = renderingEligibleAtoms(atoms).length
  const generatedAt = draft?.generatedAt || legacyPlan?.generatedAt || null
  const generationStartedAt = draft?.generationStartedAt || draft?.progress?.startedAt || minIso(atoms.map(atom => atom?.startedAt)) || generatedAt
  const generationCompletedAt = draft?.generationCompletedAt || draft?.progress?.completedAt || maxIso(atoms.map(atom => atom?.completedAt)) || draft?.updatedAt || null
  const acceptedAt = draft?.acceptedAt || draft?.lifecycle?.acceptedAt || legacyPlan?.acceptedAt || null
  const diagnostics = generationState?.diagnostics || draft?.diagnostics || null
  const skippedThisRun = diagnostics?.atomsSkippedAlreadyValid || 0
  const requestedThisRun = diagnostics?.atomCountRequested || 0
  const totalValidPersisted = diagnostics?.atomsGenerated ?? atomCountUsedByCompiler
  const generatedThisRun = Math.max(0, totalValidPersisted - skippedThisRun)
  const failedThisRun = diagnostics?.atomsFailed || 0
  const acceptanceNote = sourceType === 'current generated-but-unaccepted draft'
    ? 'Regenerate updates the visible compiled strategy after the generated draft is persisted. Accepting is not required for compiled visibility, but this draft is still unaccepted.'
    : sourceType === 'accepted draft'
      ? 'The visible compiled strategy is based on the current accepted draft.'
      : sourceType === 'stale prior draft'
        ? 'No current accepted generated draft is being used here; the visible compiled strategy is based on a stale prior draft.'
        : sourceType === 'imported runtime capture'
          ? 'The visible compiled strategy is based on an imported runtime capture, not a fresh regeneration.'
          : 'The compiled strategy is unavailable; Atomized Detail is the active fallback.'
  return {
    visibleCompiledSource: sourceType,
    draftVersionId: draftIdentityFor(draft, legacyPlan, resolved, handoffBrief),
    draftVersion: draft?.version || 'legacy',
    generatedAt,
    generationStartedAt,
    generationCompletedAt,
    acceptedAt,
    compiledAt,
    coverageAuditAt,
    qualityAuditAt,
    basisHash: draft?.basisHash || null,
    handoffBasisHash: draft?.handoffBasisHash || stage3TraceHash({ handoffBrief, handoffItems }),
    atomCountUsedByCompiler,
    handoffItemCountUsedByCompiler: Array.isArray(handoffItems) ? handoffItems.length : 0,
    totalAtomsCurrentlyPersisted: atoms.length,
    totalValidAtomsCurrentlyPersisted: atomCountUsedByCompiler,
    compilerAtomSource: resolved?.source || 'unknown',
    lifecycleStatus: draft?.lifecycle?.status || draft?.status || legacyPlan?.status || 'unknown',
    generationCounters: {
      atomsRequestedThisRun: diagnostics?.atomsRequestedThisRun ?? requestedThisRun,
      atomsGeneratedThisRun: generatedThisRun,
      atomsSkippedThisRun: skippedThisRun,
      atomsFailedThisRun: failedThisRun,
      totalAtomsCurrentlyPersisted: atoms.length,
      totalAtomsUsedByCompiledStrategy: atomCountUsedByCompiler,
    },
    dataSourcesUsed,
    acceptanceNote,
    atomSetCurrency: draft?.atomSetCurrency || draft?.stalenessPlan?.atomSetCurrency || null,
    stalenessPlan: draft?.stalenessPlan || generationState?.stalenessPlan || null,
  }
}

function buildHandoffCoverageAudit(handoffBrief, handoffItems, tree, compiledPlan, provenance = null) {
  const sourceItems = [
    ...(handoffItems || []).map((item, idx) => ({ id: item?.key || `handoff-${idx}`, title: item?.label || item?.name || item?.key || `Handoff item ${idx + 1}`, text: compiledText(item?.parsedValue || item?.childAtoms || item?.text || item?.label) })),
    ...(tree?.sections || []).map(section => ({ id: section.sectionKey, title: section.sectionName, text: section.taggedBullets?.map(b => b.text).join(' ') || '' })),
  ]
  const audit = {
    usedInCompiledStrategy: [],
    compressedIntoSpine: [],
    representedAsDependency: [],
    representedAsRisk: [],
    representedAsValidation: [],
    deferredToCoordination: [],
    deferredToStage4: [],
    sourceOnlyEvidence: [],
    notUsed: [],
    unclassified: [],
    possibleLosses: [],
    warnings: [],
    coverageAuditAt: provenance?.coverageAuditAt || new Date().toISOString(),
    dataSourcesUsed: provenance?.dataSourcesUsed || buildCoverageDataSources(handoffBrief, handoffItems, tree, compiledPlan),
  }
  if (!sourceItems.length) {
    audit.warnings.push('No Stage 2 handoff items were available for coverage classification; compiled strategy was derived from current Stage 3 atoms only.')
    return audit
  }
  const compiledBlob = normalizeSearchText(compiledPlan)
  sourceItems.forEach(item => {
    const text = normalizeSearchText([item.title, item.text])
    const safeTokens = normalizeTokenArray(semanticFingerprint(text))
    const direct = safeTokens.some(token => compiledBlob.includes(token))
    let category = direct ? 'usedInCompiledStrategy' : 'unclassified'
    if ((tree?.spine || []).some(sp => sp.contributingSecKeys?.includes(item.id) || sp.re.test?.(text))) category = 'compressedIntoSpine'
    if (direct && /depend|input|api|engineering|delivery|compliance|finance|partner|vendor/i.test(text)) category = 'representedAsDependency'
    if (direct && /risk|lock|scope|regulatory|under.?investment|false validation|explainability/i.test(text)) category = 'representedAsRisk'
    if (direct && /valid|evidence|pilot|signal|completion|threshold|workflow/i.test(text)) category = 'representedAsValidation'
    if (!direct && /executive|cross-bu|cross functional|coordination|owner|raci|reciprocal|authority/i.test(text)) category = 'deferredToCoordination'
    if (!direct && /requirement|acceptance criteria|non-functional|implementation|rollout plan|stage 4|runbook|governance artifact/i.test(text)) category = 'deferredToStage4'
    if (!direct && /source|evidence|reference|artifact|records?|notes?|documentation/i.test(text)) category = 'sourceOnlyEvidence'
    if (category === 'unclassified') category = 'notUsed'
    const record = { sourceItemTitle: item.title, summary: firstSentence(item.text || item.title, 190), sourceRefs: stage3SourceRefsFrom(handoffBrief, item.id) }
    audit[category].push(record)
    if (category === 'notUsed' && /decision|risk|dependency|validation|gate|scope|architecture|regulatory|pilot|client|evidence|api|engineering|delivery/i.test(text)) {
      audit.possibleLosses.push({ ...record, whyItMayMatter: 'This handoff item appears important but was not clearly represented in the compiled strategy, spine, dependencies, risks, validation, coordination deferral, Stage 4 deferral, or source-only evidence.', recommendedAction: /depend|api|engineering|delivery|input/i.test(text) ? 'convert to dependency' : /risk|regulatory|scope|lock/i.test(text) ? 'convert to risk' : /valid|evidence|pilot|gate/i.test(text) ? 'convert to validation criterion' : 'add to compiled strategy' })
    }
  })
  return audit
}

function asCompiledArray(value) {
  return Array.isArray(value) ? value : []
}

function auditPass(rule, details = {}) {
  return { ruleId: rule.id, label: rule.label, status: 'pass', details }
}

function auditFail(rule, message, details = {}) {
  return { ruleId: rule.id, label: rule.label, status: 'fail', message, details }
}

function repeatedCompiledTextItems(compiledPlan) {
  const grouped = [
    ['criticalDecisions', asCompiledArray(compiledPlan?.criticalDecisions).map(d => [d.decisionName, d.decisionQuestion, d.whyItMatters].join(' '))],
    ['executionSequence', asCompiledArray(compiledPlan?.executionSequence).flatMap(p => [p.phaseObjective, p.whyThisFitsThePhase, ...asCompiledArray(p.exitCriteria), ...asCompiledArray(p.evidenceExamples)])],
    ['dependencies', asCompiledArray(compiledPlan?.dependencies).map(d => [d.dependencyDescription, d.whyItMatters, d.requiredInput, d.consequenceIfMissing].join(' '))],
    ['risksAndMitigations', asCompiledArray(compiledPlan?.risksAndMitigations).map(r => [r.riskDescription, r.whyItMatters].join(' '))],
    ['validationFramework', asCompiledArray(compiledPlan?.validationFramework).flatMap(v => [v.validationQuestion, ...asCompiledArray(v.completionCriteria), ...asCompiledArray(v.failureOrReworkTriggers)])],
  ]
  const items = grouped.flatMap(([section, values]) =>
    values.map(value => ({ section, text: normalizeSearchText(value), fp: semanticFingerprint(value) })).filter(item => item.text.length > 50),
  )
  const repeats = []
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (items[i].section === items[j].section) continue
      if (jaccardSim(items[i].fp, items[j].fp) >= 0.78) {
        repeats.push({ firstSection: items[i].section, secondSection: items[j].section, text: items[i].text })
      }
    }
  }
  return repeats.slice(0, 6)
}

function buildStage3CompiledStrategyQualityAudit(compiledPlan, handoffCoverageAudit, rules = STAGE3_COMPILED_STRATEGY_LEARNING_SIGNALS.qualityChecks) {
  const results = []
  const ruleById = Object.fromEntries(rules.map(rule => [rule.id, rule]))

  const requiredTopLevel = ['strategicObjective', 'criticalDecisions', 'executionSequence', 'dependencies', 'risksAndMitigations', 'validationFramework']
  const missingTopLevel = requiredTopLevel.filter(key => !compiledPlan?.[key] || (Array.isArray(compiledPlan[key]) && !compiledPlan[key].length))
  results.push(missingTopLevel.length
    ? auditFail(ruleById.accepted_structure, 'Compiled strategy is missing one or more accepted structure sections.', { missing: missingTopLevel })
    : auditPass(ruleById.accepted_structure))

  const weakDecisions = asCompiledArray(compiledPlan?.criticalDecisions).filter(decision =>
    !decision?.whyItMatters || !asCompiledArray(decision?.decisionEvidenceNeeded).length,
  )
  results.push(weakDecisions.length
    ? auditFail(ruleById.decision_depth, 'Some critical decisions are missing why-it-matters or evidence-needed detail.', { decisions: weakDecisions.map(d => d.decisionName) })
    : auditPass(ruleById.decision_depth, { decisionsChecked: asCompiledArray(compiledPlan?.criticalDecisions).length }))

  const phases = asCompiledArray(compiledPlan?.executionSequence)
  const weakHowPhases = phases.filter(phase => asCompiledArray(phase.howOptions).length < (ruleById.phase_how_options.minHowOptionsPerPhase || 3))
  results.push(weakHowPhases.length
    ? auditFail(ruleById.phase_how_options, 'One or more phases are missing enough practical how options.', { phases: weakHowPhases.map(p => p.phaseName) })
    : auditPass(ruleById.phase_how_options, { phasesChecked: phases.length }))

  const weakExecutionMethods = phases.flatMap(phase =>
    asCompiledArray(phase.howOptions)
      .filter(option => !option?.whyItFitsThePhaseOutcome || !option?.evidenceProduced)
      .map(option => `${phase.phaseName}: ${option.optionName || option.whatItDoes || 'option'}`),
  )
  results.push(weakExecutionMethods.length
    ? auditFail(ruleById.execution_method_fit, 'Some execution methods are missing why-it-fits or evidence-produced detail.', { options: weakExecutionMethods.slice(0, 8) })
    : auditPass(ruleById.execution_method_fit, { optionsChecked: phases.reduce((sum, phase) => sum + asCompiledArray(phase.howOptions).length, 0) }))

  const risks = asCompiledArray(compiledPlan?.risksAndMitigations)
  const weakRisks = risks.filter(risk => (ruleById.risk_mitigation_depth.requiredFields || []).some(field => !asCompiledArray(risk?.[field]).length))
  results.push(weakRisks.length
    ? auditFail(ruleById.risk_mitigation_depth, 'Some risks are missing mitigation depth.', { risks: weakRisks.map(r => r.riskName) })
    : auditPass(ruleById.risk_mitigation_depth, { risksChecked: risks.length }))

  const validation = asCompiledArray(compiledPlan?.validationFramework)
  const weakValidation = validation.filter(item => (ruleById.validation_depth.requiredFields || []).some(field => !asCompiledArray(item?.[field]).length))
  results.push(weakValidation.length
    ? auditFail(ruleById.validation_depth, 'Some validation items are missing criteria, evidence, veracity, or rework triggers.', { questions: weakValidation.map(v => v.validationQuestion) })
    : auditPass(ruleById.validation_depth, { validationItemsChecked: validation.length }))

  const dependencyBleed = asCompiledArray(compiledPlan?.dependencies).filter(dep => /mitigation|early warning|veracity|completion criteria|failure trigger|risk is reduced/i.test(compiledText(dep)))
  results.push(dependencyBleed.length
    ? auditFail(ruleById.dependency_distinction, 'Some dependencies appear to contain risk or validation language.', { dependencies: dependencyBleed.map(d => d.dependencyName) })
    : auditPass(ruleById.dependency_distinction, { dependenciesChecked: asCompiledArray(compiledPlan?.dependencies).length }))

  const forcedRiskOwnership = risks.filter(risk => /\b(owner|owns|ownership|accountable|responsible|raci)\b/i.test(compiledText(risk)))
  results.push(forcedRiskOwnership.length
    ? auditFail(ruleById.no_forced_risk_ownership, 'Some risk sections appear to force ownership inside the BU risk model.', { risks: forcedRiskOwnership.map(r => r.riskName) })
    : auditPass(ruleById.no_forced_risk_ownership, { risksChecked: risks.length }))

  results.push(handoffCoverageAudit
    ? auditPass(ruleById.auditable_compression, { possibleLosses: handoffCoverageAudit.possibleLosses?.length || 0 })
    : auditFail(ruleById.auditable_compression, 'No handoff coverage audit was derived.'))

  const classifiedCount = [
    'usedInCompiledStrategy',
    'compressedIntoSpine',
    'representedAsDependency',
    'representedAsRisk',
    'representedAsValidation',
    'deferredToCoordination',
    'deferredToStage4',
    'sourceOnlyEvidence',
    'notUsed',
    'possibleLosses',
  ].reduce((sum, key) => sum + (handoffCoverageAudit?.[key]?.length || 0), 0)
  results.push(classifiedCount > 0 || handoffCoverageAudit?.warnings?.length
    ? auditPass(ruleById.handoff_classification, { classifiedCount, warnings: handoffCoverageAudit?.warnings?.length || 0 })
    : auditFail(ruleById.handoff_classification, 'No handoff content was classified.'))

  const truncated = /\.\.\.|…/.test(compiledText(compiledPlan))
  results.push(truncated
    ? auditFail(ruleById.no_truncated_strategy_text, 'Compiled strategy text contains truncation markers.')
    : auditPass(ruleById.no_truncated_strategy_text))

  const repeats = repeatedCompiledTextItems(compiledPlan)
  results.push(repeats.length
    ? auditFail(ruleById.reduce_repetition, 'Repeated content appears across compiled strategy sections.', { repeats })
    : auditPass(ruleById.reduce_repetition))

  return {
    rules,
    results,
    violations: results.filter(result => result.status === 'fail'),
    passedCount: results.filter(result => result.status === 'pass').length,
    failedCount: results.filter(result => result.status === 'fail').length,
  }
}

function compileBUExecutionPlan({ draft, legacyPlan, handoffBrief, handoffItems, tree, resolved, generationState }) {
  const compiledAt = new Date().toISOString()
  const coverageAuditAt = new Date().toISOString()
  const qualityAuditAt = new Date().toISOString()
  const sourceRefs = stage3SourceRefsFrom(handoffBrief)
  const buProfile = inferCompiledBUProfile({ draft, legacyPlan, handoffBrief, tree })
  const compiled = {
    strategicObjective: {
      summary: firstSentence(legacyPlan?.mission || handoffBrief?.planningPurpose || draft?.plan?.mission || 'Define a focused execution basis for this business unit.'),
      outcomeFocus: firstSentence(legacyPlan?.strategicRole || handoffBrief?.decisionBasisSummary || 'Convert Stage 2 handoff context into decisions, sequencing, dependencies, risk mitigation, and validation evidence.'),
      nonGoalsOrBoundaries: [...(handoffBrief?.executionConstraints || []), ...(legacyPlan?.constraints || [])].map(text => firstSentence(text, 180)).filter(Boolean).slice(0, 4),
      sourceRefs,
    },
    criticalDecisions: buildCompiledCriticalDecisions(tree, handoffBrief, buProfile),
    executionSequence: buildCompiledExecutionSequence(tree, handoffBrief, buProfile),
    dependencies: buildCompiledDependencies(tree, handoffBrief),
    risksAndMitigations: buildCompiledRisks(tree, handoffBrief, buProfile),
    validationFramework: buildCompiledValidationFramework(tree, handoffBrief, buProfile),
    sourceTraceability: sourceRefs,
    learningSignalBasis: {
      profile: buProfile,
      productIntent: STAGE3_COMPILED_STRATEGY_LEARNING_SIGNALS.productIntent,
      acceptedStructure: STAGE3_COMPILED_STRATEGY_LEARNING_SIGNALS.acceptedStructure,
      appliedLearningSignals: STAGE3_COMPILED_STRATEGY_LEARNING_SIGNALS.generalLearningSignals,
      prohibitedPatterns: STAGE3_COMPILED_STRATEGY_LEARNING_SIGNALS.prohibitedPatterns,
      adaptationGuidance: roleLearningTerms(buProfile),
    },
  }
  const provenance = buildCompiledStrategyProvenance({
    draft,
    legacyPlan,
    handoffBrief,
    handoffItems,
    tree,
    resolved,
    generationState,
    compiledPlan: compiled,
    compiledAt,
    coverageAuditAt,
    qualityAuditAt,
  })
  const handoffCoverageAudit = buildHandoffCoverageAudit(handoffBrief, handoffItems, tree, compiled, provenance)
  const stage3CompiledStrategyQualityAudit = {
    ...buildStage3CompiledStrategyQualityAudit(compiled, handoffCoverageAudit),
    qualityAuditAt,
    basisSource: provenance.visibleCompiledSource,
    isCurrentDraftBasis: ['accepted draft', 'current generated-but-unaccepted draft'].includes(provenance.visibleCompiledSource),
  }
  return {
    compiledBUExecutionPlan: compiled,
    handoffCoverageAudit,
    stage3CompiledStrategyQualityAudit,
    provenance: {
      ...provenance,
      coverageAuditAt: handoffCoverageAudit.coverageAuditAt,
      qualityAuditAt,
    },
  }
}

function StrategySection({ title, children, accent = '#00e5b4' }) {
  return (
    <div style={{ border: `1px solid ${accent}33`, borderRadius: 5, overflow: 'hidden', background: 'var(--surface)' }}>
      <div style={{ padding: '7px 10px', background: `${accent}0d`, borderBottom: `1px solid ${accent}22`, fontSize: 10, fontWeight: 700, color: accent }}>{title}</div>
      <div style={{ padding: '9px 11px', display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
    </div>
  )
}

function TinyList({ items, dot = '#00e5b4' }) {
  const clean = listFromValue(items).filter(Boolean)
  if (!clean.length) return null
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{clean.map((item, idx) => <div key={idx} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}><span style={{ flexShrink: 0, width: 4, height: 4, borderRadius: '50%', background: dot, marginTop: 6 }} /><div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted2)', lineHeight: 1.55 }}>{item}</div></div>)}</div>
}

function LabeledText({ label, value }) {
  if (!value && !(Array.isArray(value) && value.length)) return null
  return <div><div style={{ fontSize: 7, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>{label}</div>{Array.isArray(value) ? <TinyList items={value} /> : <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted2)', lineHeight: 1.6 }}>{value}</div>}</div>
}

function formatPlanTimestamp(value) {
  if (!value) return 'not available'
  return String(value)
}

function CompiledStrategyProvenancePanel({ provenance }) {
  if (!provenance) return null
  const sourceColor = provenance.visibleCompiledSource === 'accepted draft'
    ? '#00e5b4'
    : provenance.visibleCompiledSource === 'current generated-but-unaccepted draft'
      ? '#fb923c'
      : provenance.visibleCompiledSource === 'atomized fallback'
        ? '#f87171'
        : '#3b82f6'
  const rows = [
    ['draft ID / version', `${provenance.draftVersionId || 'unknown'} / ${provenance.draftVersion || 'unknown'}`],
    ['generationStartedAt', formatPlanTimestamp(provenance.generationStartedAt)],
    ['generationCompletedAt', formatPlanTimestamp(provenance.generationCompletedAt)],
    ['generatedAt', formatPlanTimestamp(provenance.generatedAt)],
    ['compiledAt', formatPlanTimestamp(provenance.compiledAt)],
    ['acceptedAt', formatPlanTimestamp(provenance.acceptedAt)],
    ['coverageAuditAt', formatPlanTimestamp(provenance.coverageAuditAt)],
    ['qualityAuditAt', formatPlanTimestamp(provenance.qualityAuditAt)],
    ['handoffBasisHash', provenance.handoffBasisHash || provenance.basisHash || 'not available'],
    ['compiler atom source', provenance.compilerAtomSource || 'unknown'],
    ['atom set currency', provenance.atomSetCurrency || 'unknown'],
    ['atom count used by compiler', provenance.atomCountUsedByCompiler ?? 0],
    ['handoff item count used by compiler', provenance.handoffItemCountUsedByCompiler ?? 0],
  ]
  const counters = provenance.generationCounters || {}
  return (
    <div style={{ border: '1px solid rgba(0,229,180,.28)', borderRadius: 5, padding: '9px 10px', background: 'rgba(0,229,180,.04)' }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 7 }}>
        <Badge color={sourceColor} small>{provenance.visibleCompiledSource || 'unknown source'}</Badge>
        <Badge color="#3b82f6" small>{counters.atomsRequestedThisRun ?? 0} requested this run</Badge>
        <Badge color="#00e5b4" small>{counters.atomsGeneratedThisRun ?? 0} generated this run</Badge>
        <Badge color="var(--muted)" small>{counters.atomsSkippedThisRun ?? 0} skipped this run</Badge>
        <Badge color={counters.atomsFailedThisRun ? '#f87171' : 'var(--muted)'} small>{counters.atomsFailedThisRun ?? 0} failed this run</Badge>
        <Badge color="#fb923c" small>{counters.totalAtomsCurrentlyPersisted ?? 0} total persisted</Badge>
        <Badge color="#a3e635" small>{counters.totalAtomsUsedByCompiledStrategy ?? 0} used by compiler</Badge>
      </div>
      <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted2)', lineHeight: 1.5, marginBottom: 7 }}>
        {provenance.acceptanceNote}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 5 }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '5px 6px', background: 'var(--surface)' }}>
            <div style={{ fontSize: 7, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2 }}>{label}</div>
            <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted2)', lineHeight: 1.35, wordBreak: 'break-word' }}>{String(value)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function HandoffCoverageAuditView({ audit }) {
  const [open, setOpen] = useState(false)
  if (!audit) return null
  const counts = [['used in compiled strategy', audit.usedInCompiledStrategy.length], ['compressed into spine', audit.compressedIntoSpine.length], ['represented as dependencies', audit.representedAsDependency.length], ['represented as risks', audit.representedAsRisk.length], ['represented as validation', audit.representedAsValidation.length], ['deferred to coordination', audit.deferredToCoordination.length], ['deferred to Stage 4', audit.deferredToStage4.length], ['source-only', audit.sourceOnlyEvidence.length], ['unclassified', audit.unclassified?.length || 0], ['possible losses', audit.possibleLosses.length]]
  return (
    <div style={{ border: '1px solid rgba(251,146,60,.35)', borderRadius: 5, overflow: 'hidden' }}>
      <div onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '8px 10px', background: 'rgba(251,146,60,.06)' }}>
        <div style={{ flex: 1 }}><div style={{ fontSize: 10, fontWeight: 700, color: '#fb923c' }}>Handoff Coverage</div><div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>{audit.possibleLosses.length} possible loss{audit.possibleLosses.length === 1 ? '' : 'es'} flagged</div></div>
        <span style={{ fontSize: 7, color: 'var(--muted)' }}>{open ? 'hide' : 'show'}</span>
      </div>
      {open && <div style={{ padding: '9px 10px', background: 'var(--surface)', display: 'flex', flexDirection: 'column', gap: 9 }}>
        {audit.warnings?.length > 0 && <TinyList items={audit.warnings} dot="#fb923c" />}
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>{counts.map(([label, count]) => <Badge key={label} color={label === 'possible losses' && count ? '#f87171' : '#fb923c'} small>{count} {label}</Badge>)}</div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '7px 8px', background: 'var(--s2)' }}>
          <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 5 }}>Coverage Audit Data Sources</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            <Badge color="#fb923c" small>{audit.dataSourcesUsed?.stage2HandoffItems ?? 0} Stage 2 handoff items</Badge>
            <Badge color="#fb923c" small>{audit.dataSourcesUsed?.sourceRefs ?? 0} source refs</Badge>
            <Badge color="#fb923c" small>{audit.dataSourcesUsed?.compiledStrategyText ?? 0} compiled text chars</Badge>
            <Badge color="#fb923c" small>{audit.dataSourcesUsed?.spineText ?? 0} spine items</Badge>
            <Badge color="#fb923c" small>{audit.dataSourcesUsed?.atomizedText ?? 0} atomized bullets</Badge>
          </div>
          <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', marginTop: 5 }}>
            coverageAuditAt {audit.coverageAuditAt || 'not available'}
          </div>
        </div>
        {audit.possibleLosses.length > 0 && <div><div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#f87171', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 5 }}>Possible Losses</div>{audit.possibleLosses.map((loss, idx) => <div key={idx} style={{ border: '1px solid rgba(248,113,113,.28)', borderRadius: 4, padding: '7px 8px', marginBottom: 6, background: 'rgba(248,113,113,.05)' }}><div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text)', marginBottom: 3 }}>{loss.sourceItemTitle}</div><LabeledText label="summary" value={loss.summary} /><LabeledText label="why it may matter" value={loss.whyItMayMatter} /><LabeledText label="recommended action" value={loss.recommendedAction} /></div>)}</div>}
      </div>}
    </div>
  )
}

function Stage3CompiledQualityAuditView({ audit }) {
  const [open, setOpen] = useState(false)
  if (!audit) return null
  return (
    <div style={{ border: '1px solid rgba(59,130,246,.32)', borderRadius: 5, overflow: 'hidden' }}>
      <div onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '8px 10px', background: 'rgba(59,130,246,.06)' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#3b82f6' }}>Compiled Strategy Quality Audit</div>
          {audit.isCurrentDraftBasis ? (
            <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
              {audit.failedCount} violation{audit.failedCount === 1 ? '' : 's'} - {audit.passedCount} rule{audit.passedCount === 1 ? '' : 's'} passed
            </div>
          ) : (
            <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#fb923c' }}>
              Quality claims withheld because this is not based on a current accepted or generated draft.
            </div>
          )}
          <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', marginTop: 2 }}>
            basis {audit.basisSource || 'unknown'} - qualityAuditAt {audit.qualityAuditAt || 'not available'}
          </div>
        </div>
        <span style={{ fontSize: 7, color: 'var(--muted)' }}>{open ? 'hide' : 'show'}</span>
      </div>
      {open && (
        <div style={{ padding: '9px 10px', background: 'var(--surface)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!audit.isCurrentDraftBasis && (
            <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#fb923c', lineHeight: 1.5 }}>
              The rules were not presented as strategy-quality claims because the compiled view basis is {audit.basisSource || 'unknown'}.
            </div>
          )}
          {audit.isCurrentDraftBasis && audit.violations?.length > 0 && (
            <div>
              <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#f87171', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 5 }}>Violations</div>
              {audit.violations.map(result => (
                <div key={result.ruleId} style={{ border: '1px solid rgba(248,113,113,.28)', borderRadius: 4, padding: '7px 8px', marginBottom: 6, background: 'rgba(248,113,113,.05)' }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text)', marginBottom: 3 }}>{result.label}</div>
                  <LabeledText label="finding" value={result.message} />
                  {result.details && Object.keys(result.details).length > 0 && (
                    <LabeledText label="details" value={compiledText(result.details)} />
                  )}
                </div>
              ))}
            </div>
          )}
          {audit.isCurrentDraftBasis && <div>
            <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 5 }}>Rules</div>
            {audit.results.map(result => (
              <div key={result.ruleId} style={{ display: 'flex', gap: 7, alignItems: 'flex-start', marginBottom: 5 }}>
                <Badge color={result.status === 'pass' ? '#00e5b4' : '#f87171'} small>{result.status}</Badge>
                <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted2)', lineHeight: 1.5 }}>{result.label}</div>
              </div>
            ))}
          </div>}
        </div>
      )}
    </div>
  )
}

function CompiledStrategyView({ compiled, audit, qualityAudit, provenance }) {
  if (!compiled) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <CompiledStrategyProvenancePanel provenance={provenance} />
      <StrategySection title="Strategic Objective"><LabeledText label="summary" value={compiled.strategicObjective.summary} /><LabeledText label="outcome focus" value={compiled.strategicObjective.outcomeFocus} /><LabeledText label="non-goals / boundaries" value={compiled.strategicObjective.nonGoalsOrBoundaries} /></StrategySection>
      <StrategySection title="Critical Decisions" accent="#3b82f6">{compiled.criticalDecisions.map((decision, idx) => <div key={idx} style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '8px 9px', background: 'var(--s2)' }}><div style={{ fontSize: 10, fontWeight: 700, color: '#3b82f6', marginBottom: 6 }}>{decision.decisionName}</div><LabeledText label="question" value={decision.decisionQuestion} /><LabeledText label="why it matters" value={decision.whyItMatters} /><LabeledText label="options" value={decision.decisionOptions} /><LabeledText label="evidence needed" value={decision.decisionEvidenceNeeded} /><LabeledText label="timing" value={decision.decisionTiming} /></div>)}</StrategySection>
      <StrategySection title="Execution Sequence">{compiled.executionSequence.map((phase, idx) => <div key={idx} style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '8px 9px', background: 'var(--s2)' }}><div style={{ fontSize: 10, fontWeight: 700, color: '#00e5b4', marginBottom: 5 }}>{phase.phaseName}</div><LabeledText label="phase objective" value={phase.phaseObjective} /><LabeledText label="recommended how" value={phase.recommendedHow} /><LabeledText label="why this fits the phase" value={phase.whyThisFitsThePhase} /><LabeledText label="exit criteria" value={phase.exitCriteria} /><div style={{ marginTop: 6 }}><div style={{ fontSize: 7, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 4 }}>how options</div>{phase.howOptions.map((opt, oi) => <div key={oi} style={{ marginBottom: 6, paddingLeft: 7, borderLeft: '2px solid rgba(0,229,180,.35)' }}><div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>{opt.optionName}</div><LabeledText label="when to use" value={opt.whenToUse} /><LabeledText label="why it fits" value={opt.whyItFitsThePhaseOutcome} /><LabeledText label="evidence produced" value={opt.evidenceProduced} /></div>)}</div></div>)}</StrategySection>
      <StrategySection title="Dependencies" accent="#fb923c">{compiled.dependencies.map((dep, idx) => <div key={idx} style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '8px 9px', background: 'var(--s2)' }}><div style={{ fontSize: 9, fontWeight: 700, color: '#fb923c', marginBottom: 5 }}>{dep.dependencyName}</div><LabeledText label="description" value={dep.dependencyDescription} /><LabeledText label="required input" value={dep.requiredInput} /><LabeledText label="consequence if missing" value={dep.consequenceIfMissing} /></div>)}</StrategySection>
      <StrategySection title="Risk & Mitigation" accent="#f87171">{compiled.risksAndMitigations.map((risk, idx) => <div key={idx} style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '8px 9px', background: 'var(--s2)' }}><div style={{ fontSize: 9, fontWeight: 700, color: '#f87171', marginBottom: 5 }}>{risk.riskName}</div><LabeledText label="description" value={risk.riskDescription} /><LabeledText label="mitigation options" value={risk.mitigationOptions} /><LabeledText label="early warning signals" value={risk.earlyWarningSignals} /><LabeledText label="evidence risk is reduced" value={risk.evidenceThatRiskIsReduced} /></div>)}</StrategySection>
      <StrategySection title="Validation Framework" accent="#a3e635">{compiled.validationFramework.map((item, idx) => <div key={idx} style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '8px 9px', background: 'var(--s2)' }}><div style={{ fontSize: 9, fontWeight: 700, color: '#a3e635', marginBottom: 5 }}>{item.validationQuestion}</div><LabeledText label="completion criteria" value={item.completionCriteria} /><LabeledText label="how to determine completion" value={item.howToDetermineCompletion} /><LabeledText label="evidence examples" value={item.evidenceExamples} /><LabeledText label="veracity checks" value={item.veracityChecks} /><LabeledText label="failure / rework triggers" value={item.failureOrReworkTriggers} /></div>)}</StrategySection>
      <HandoffCoverageAuditView audit={audit} />
      <Stage3CompiledQualityAuditView audit={qualityAudit} />
    </div>
  )
}

function Stage3BUPlanTree({ draft, legacyPlan, handoffBrief, handoffItems = [], unitName, onStage2Action, showHandoffBrief = true, generationState = null }) {
  const [viewMode,       setViewMode]       = useState('compiled')
  const [briefOpen,      setBriefOpen]      = useState(true)
  const [spineOpen,      setSpineOpen]      = useState(true)
  const [execOpen,       setExecOpen]       = useState(true)
  const [execFields,     setExecFields]     = useState({ executionStrategy: true })
  // Per-spine-item open state (collapsed by default — header is readable, detail is on demand)
  const [openSpineItems, setOpenSpineItems] = useState({})
  // Per-spine-item raw-instances expansion
  const [openSpineRaw,   setOpenSpineRaw]   = useState({})

  const resolvedExecutionDraft = React.useMemo(() => resolveExecutionDraftSource(draft, legacyPlan), [draft, legacyPlan])

  const tree = React.useMemo(() => {
    if (!resolvedExecutionDraft.atoms?.length) return null
    return buildPlanTree(resolvedExecutionDraft.atoms)
  }, [resolvedExecutionDraft])

  const fallbackProvenance = React.useMemo(() => {
    return buildCompiledStrategyProvenance({
      draft,
      legacyPlan,
      handoffBrief,
      handoffItems,
      tree,
      resolved: resolvedExecutionDraft,
      generationState,
      compiledAt: null,
      compiledError: true,
    })
  }, [draft, legacyPlan, handoffBrief, handoffItems, tree, resolvedExecutionDraft, generationState])

  const compiledStrategy = React.useMemo(() => {
    if (!tree) return null
    try {
      return compileBUExecutionPlan({ draft, legacyPlan, handoffBrief, handoffItems, tree, resolved: resolvedExecutionDraft, generationState })
    } catch (error) {
      console.warn('Stage 3 compiled strategy derivation failed', {
        message: error?.message || String(error),
        buName: legacyPlan?.buName || draft?.plan?.buName || handoffBrief?.businessUnitName || unitName || 'unknown',
        compilerFunction: 'compileBUExecutionPlan',
      })
      return { error: error?.message || 'Compiled strategy derivation failed.', provenance: fallbackProvenance }
    }
  }, [draft, legacyPlan, handoffBrief, handoffItems, tree, resolvedExecutionDraft, generationState, fallbackProvenance])

  if (!tree || !tree.sections.length) {
    return (
      <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', fontStyle: 'italic', marginTop: 10, marginBottom: 12 }}>
        No execution plan draft — generate or import a plan to see the hierarchy.
      </div>
    )
  }

  const { spine, sections, executionPlan } = tree
  const scoreColor = s => s === 'high' ? '#00e5b4' : s === 'medium' ? '#fb923c' : '#f87171'

  // ── Shared panel header style helper ────────────────────────────────────────
  function PanelHeader({ label, sub, open, onToggle, accent = 'var(--muted2)', defaultBg = 'var(--s2)' }) {
    return (
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
          padding: '8px 11px', background: defaultBg,
          borderBottom: open ? '1px solid var(--border)' : 'none',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: accent }}>{label}</div>
          {sub && <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', marginTop: 1 }}>{sub}</div>}
        </div>
        <span style={{ fontSize: 8, color: 'var(--muted)', flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </div>
    )
  }

  // ── Bullet renderer ─────────────────────────────────────────────────────────
  function BulletItem({ text, dot = 'var(--muted)' }) {
    return (
      <div style={{ display: 'flex', gap: 7, marginBottom: 7, alignItems: 'flex-start' }}>
        <span style={{ flexShrink: 0, width: 5, height: 5, borderRadius: '50%', background: dot, marginTop: 5 }} />
        <div style={{ fontSize: 9, color: 'var(--muted2)', lineHeight: 1.65, fontFamily: 'var(--fm)', whiteSpace: 'normal', wordBreak: 'break-word' }}>{text}</div>
      </div>
    )
  }

  // ── Source refs — keyed by section ID for per-spine-item lookup ────────────
  const evidenceRefs   = handoffBrief?.evidenceRefs          || []
  const sourceIds      = handoffBrief?.sourceStage2SectionIds || []
  const keyImplications = handoffBrief?.keyImplications       || []
  // Build a fast lookup: sectionKey → evidenceRef
  const refBySectionKey = Object.fromEntries(evidenceRefs.map(r => [r.id, r]))

  return (
    <div style={{ marginTop: 12, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {['compiled', 'atomized'].map(mode => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            style={{
              fontSize: 8,
              fontFamily: 'var(--fm)',
              fontWeight: 700,
              padding: '4px 9px',
              borderRadius: 4,
              cursor: 'pointer',
              background: viewMode === mode ? 'rgba(0,229,180,.12)' : 'var(--s2)',
              border: `1px solid ${viewMode === mode ? 'rgba(0,229,180,.45)' : 'var(--border)'}`,
              color: viewMode === mode ? '#00e5b4' : 'var(--muted)',
            }}
          >
            {mode === 'compiled' ? 'Compiled Strategy View' : 'Current Atomized View'}
          </button>
        ))}
      </div>

      {compiledStrategy?.error && (
        <div style={{
          fontSize: 9,
          fontFamily: 'var(--fm)',
          color: '#fb923c',
          lineHeight: 1.55,
          padding: '8px 10px',
          background: 'rgba(251,146,60,.07)',
          border: '1px solid rgba(251,146,60,.25)',
          borderRadius: 5,
        }}>
          Compiled strategy could not be derived from the current handoff shape. Showing the current atomized detail view instead. {compiledStrategy.error}
          {compiledStrategy.provenance?.acceptanceNote && (
            <div style={{ marginTop: 5 }}>
              {compiledStrategy.provenance.acceptanceNote}
            </div>
          )}
        </div>
      )}

      {viewMode === 'compiled' && !compiledStrategy?.error ? (
        <CompiledStrategyView
          compiled={compiledStrategy?.compiledBUExecutionPlan}
          audit={compiledStrategy?.handoffCoverageAudit}
          qualityAudit={compiledStrategy?.stage3CompiledStrategyQualityAudit}
          provenance={compiledStrategy?.provenance}
        />
      ) : (
        <>

      {/* ══ 1. HANDOFF BRIEF — omitted when already shown by Stage3HandoffBriefCard above ══ */}
      {showHandoffBrief && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 5, overflow: 'hidden' }}>
          <PanelHeader
            label="Handoff Brief"
            sub="Why this BU exists in Stage 3 and what Stage 2 handed into it"
            open={briefOpen}
            onToggle={() => setBriefOpen(o => !o)}
          />
          {briefOpen && (
            <div style={{ padding: '10px 12px', background: 'var(--surface)', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {handoffBrief?.planningPurpose && (
                <div>
                  <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>Planning Purpose</div>
                  <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted2)', lineHeight: 1.6 }}>{handoffBrief.planningPurpose}</div>
                </div>
              )}
              {handoffBrief?.decisionBasisSummary && (
                <div>
                  <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>Decision Basis</div>
                  <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted2)', lineHeight: 1.6 }}>{handoffBrief.decisionBasisSummary}</div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ══ 1b. MISSION + STRATEGIC ROLE — always shown (BU-level context) ══════ */}
      {(legacyPlan?.mission || legacyPlan?.strategicRole) && (
        <div style={{ border: '1px solid rgba(59,130,246,.2)', borderRadius: 5, overflow: 'hidden' }}>
          <div style={{ padding: '10px 12px', background: 'rgba(59,130,246,.04)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {legacyPlan.mission && (
              <div>
                <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#3b82f6', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 4 }}>Mission</div>
                <div style={{ fontSize: 10, color: 'var(--text)', lineHeight: 1.7, fontStyle: 'italic' }}>{legacyPlan.mission}</div>
              </div>
            )}
            {legacyPlan.strategicRole && (
              <div>
                <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#3b82f6', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 4 }}>Strategic Role</div>
                <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted2)', lineHeight: 1.7 }}>{legacyPlan.strategicRole}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══ 2. SHARED PLAN SPINE — constraint + rationale + provenance ════════════
             Supporting Analysis and Source References are embedded per spine item.
             The Execution Plan panel (below) holds derived outcomes and actions.     */}
      {spine.length > 0 && (
        <div style={{ border: '1px solid rgba(59,130,246,.3)', borderRadius: 5, overflow: 'hidden' }}>
          <PanelHeader
            label="Shared Plan Spine"
            sub={`${spine.length} cross-cutting constraints — with contributing sections, unique rationale, and source provenance`}
            open={spineOpen}
            onToggle={() => setSpineOpen(o => !o)}
            accent="#3b82f6"
            defaultBg="rgba(59,130,246,.06)"
          />
          {spineOpen && (
            <div style={{ padding: '8px 10px', background: 'var(--surface)', display: 'flex', flexDirection: 'column', gap: 5 }}>
              {spine.map(t => {
                const itemOpen     = !!openSpineItems[t.key]
                const rawOpen      = !!openSpineRaw[t.key]
                const contribSecs  = sections.filter(s => t.contributingSecKeys.includes(s.sectionKey))
                // Source refs for sections that contribute to this spine item
                const themeRefs    = contribSecs
                  .map(s => refBySectionKey[s.sectionKey])
                  .filter(Boolean)
                // Deduplicate by ref.id (a section only contributes one source ref)
                const seenRefIds   = new Set()
                const uniqueRefs   = themeRefs.filter(r => seenRefIds.has(r.id) ? false : seenRefIds.add(r.id))

                return (
                  <div key={t.key} style={{ border: '1px solid rgba(59,130,246,.18)', borderRadius: 4, overflow: 'hidden' }}>

                    {/* Spine item header — always visible */}
                    <div
                      onClick={() => setOpenSpineItems(p => ({ ...p, [t.key]: !p[t.key] }))}
                      style={{
                        display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer',
                        padding: '7px 10px',
                        background: itemOpen ? 'rgba(59,130,246,.07)' : 'var(--s2)',
                        borderBottom: itemOpen ? '1px solid rgba(59,130,246,.18)' : 'none',
                      }}
                    >
                      <Badge color="#3b82f6" small style={{ flexShrink: 0, marginTop: 2 }}>
                        {t.sectionCount}/{sections.length}
                      </Badge>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 9, fontWeight: 700, color: '#3b82f6', marginBottom: 4, lineHeight: 1.3 }}>
                          {t.label}
                        </div>
                        {t.representative && (
                          <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {t.representative}
                          </div>
                        )}
                      </div>
                      <span style={{ fontSize: 7, color: 'var(--muted)', flexShrink: 0, marginTop: 3 }}>
                        {itemOpen ? '▲' : '▼'}
                      </span>
                    </div>

                    {/* Spine item body — rationale + contributing sections + provenance */}
                    {itemOpen && (() => {
                      // Why It Matters: unique bullets that explain impact, risk, or sequencing.
                      // Prioritise risks → sequencingAndGates → executionStrategy, 1 bullet per section max.
                      const RATIONALE_FIELDS = ['risks', 'sequencingAndGates', 'executionStrategy']
                      const rationaleItems = contribSecs.flatMap(sec => {
                        for (const fk of RATIONALE_FIELDS) {
                          const hit = sec.taggedBullets.find(b => b.isUnique && b.fieldKey === fk)
                          if (hit) return [hit]
                        }
                        const fallback = sec.taggedBullets.find(b => b.isUnique)
                        return fallback ? [fallback] : []
                      }).slice(0, 4)
                      return (
                      <div style={{ padding: '10px 12px', background: 'var(--surface)', display: 'flex', flexDirection: 'column', gap: 10 }}>

                        {/* Why It Matters — visible rationale from unique section contributions */}
                        {rationaleItems.length > 0 && (
                          <div>
                            <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 5 }}>
                              Why It Matters
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                              {rationaleItems.map((b, ri) => (
                                <div key={ri} style={{ display: 'flex', gap: 7, alignItems: 'flex-start' }}>
                                  <span style={{ flexShrink: 0, width: 4, height: 4, borderRadius: '50%', background: '#3b82f6', marginTop: 6 }} />
                                  <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted2)', lineHeight: 1.65, whiteSpace: 'normal' }}>
                                    {b.text}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Contributing Areas — semantic label + one-line role description */}
                        {/* The one-liner comes from a field NOT already in Why It Matters (no duplication) */}
                        {contribSecs.length > 0 && (
                          <div>
                            <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
                              Contributing Areas
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                              {contribSecs.map(sec => {
                                // Pick a one-liner from a field NOT in RATIONALE_FIELDS (avoid duplicating Why It Matters)
                                const NON_RATIONALE = ['decisionsRequired', 'dependencies', 'validationSignals', 'sequencingAndGates', 'executionStrategy', 'risks']
                                let oneLiner = null
                                for (const fk of ['decisionsRequired', 'validationSignals', 'dependencies']) {
                                  const hit = sec.taggedBullets.find(b => b.isUnique && b.fieldKey === fk)
                                  if (hit) { oneLiner = hit.text; break }
                                }
                                if (!oneLiner) {
                                  const any = sec.taggedBullets.find(b => b.isUnique)
                                  oneLiner = any?.text ?? null
                                }
                                return (
                                  <div key={sec.sectionKey} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                      <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text)' }}>
                                        {sec.semanticLabel}
                                      </span>
                                      {oneLiner && (
                                        <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', marginLeft: 6, lineHeight: 1.5, whiteSpace: 'normal', wordBreak: 'break-word' }}>
                                          — {oneLiner}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )}

                        {/* Source artifacts */}
                        {uniqueRefs.length > 0 && (
                          <div>
                            <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 5 }}>
                              Source artifacts
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              {uniqueRefs.map(ref => {
                                const refIdxInSource = sourceIds.indexOf(ref.id)
                                const summary = keyImplications[refIdxInSource] || handoffBrief?.planningPurpose || ''
                                const title   = ref.title && ref.title !== ref.id ? ref.title : `Stage 2 item ${ref.id}`
                                return (
                                  <div key={ref.id} style={{
                                    display: 'flex', alignItems: 'flex-start', gap: 8,
                                    padding: '5px 8px', background: 'var(--s2)',
                                    border: '1px solid var(--border)', borderRadius: 4,
                                  }}>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                      <div style={{ fontSize: 8, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>
                                        {title}
                                      </div>
                                      {summary && (
                                        <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.5, whiteSpace: 'normal' }}>
                                          {summary}
                                        </div>
                                      )}
                                    </div>
                                    {onStage2Action && (
                                      <button
                                        onClick={() => onStage2Action(unitName || legacyPlan?.buName, ref.id, 'review')}
                                        style={{
                                          flexShrink: 0, fontSize: 8, fontFamily: 'var(--fm)',
                                          padding: '3px 8px', borderRadius: 3, cursor: 'pointer',
                                          background: 'transparent', border: '1px solid var(--border)',
                                          color: 'var(--muted)',
                                        }}
                                      >
                                        Open in Stage 2
                                      </button>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )}

                        {/* Raw supporting detail — spine instances + unique contributions per section */}
                        <div>
                          <div
                            onClick={() => setOpenSpineRaw(p => ({ ...p, [t.key]: !p[t.key] }))}
                            style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}
                          >
                            <span style={{ opacity: .65 }}>{rawOpen ? '▲' : '▼'}</span>
                            Raw supporting detail — {t.sectionCount} contributing section{t.sectionCount !== 1 ? 's' : ''}
                          </div>
                          {rawOpen && (
                            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {contribSecs.map(sec => {
                                const themeBullets = sec.taggedBullets.filter(
                                  b => b.isSpine && b.spineThemes.some(st => st.key === t.key)
                                )
                                const secUniqueBullets = sec.taggedBullets.filter(b => b.isUnique)
                                if (!themeBullets.length && !secUniqueBullets.length) return null
                                return (
                                  <div key={sec.sectionKey} style={{ marginBottom: 6 }}>
                                    <div style={{ fontSize: 7, fontFamily: 'var(--fm)', color: 'var(--muted)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                                      {sec.semanticLabel || sec.mandate}
                                    </div>
                                    {themeBullets.map((b, bi) => (
                                      <div key={`s:${bi}`} style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'flex-start' }}>
                                        <span style={{ flexShrink: 0, width: 4, height: 4, borderRadius: '50%', background: '#3b82f6', marginTop: 5 }} />
                                        <div style={{ fontSize: 8, color: 'var(--muted)', lineHeight: 1.6, fontFamily: 'var(--fm)', whiteSpace: 'normal' }}>{b.text}</div>
                                      </div>
                                    ))}
                                    {secUniqueBullets.map((b, bi) => (
                                      <div key={`u:${bi}`} style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'flex-start' }}>
                                        <span style={{ flexShrink: 0, width: 4, height: 4, borderRadius: '50%', background: '#00e5b4', marginTop: 5 }} />
                                        <div style={{ fontSize: 8, color: 'var(--muted2)', lineHeight: 1.6, fontFamily: 'var(--fm)', whiteSpace: 'normal' }}>{b.text}</div>
                                      </div>
                                    ))}
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                      )
                    })()}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ══ 3. EXECUTION PLAN — dimension-first ════════════════════════════════ */}
      <div style={{ border: '1px solid rgba(0,229,180,.3)', borderRadius: 5, overflow: 'hidden' }}>
        <PanelHeader
          label="Execution Plan"
          sub="Aggregated across all sections — each dimension appears once"
          open={execOpen}
          onToggle={() => setExecOpen(o => !o)}
          accent="#00e5b4"
          defaultBg="rgba(0,229,180,.05)"
        />
        {execOpen && (
          <div style={{ padding: '8px 10px', background: 'var(--surface)', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {EXEC_PLAN_FIELDS.map(fk => {
              const contributions = executionPlan[fk] || []
              const totalBullets  = contributions.reduce((s, c) => s + c.bullets.length, 0)
              if (!totalBullets) return null
              const isOpen = !!execFields[fk]
              const label  = STAGE3_FIELD_ATOM_LABELS[fk] || fk

              return (
                <div key={fk} style={{ border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                  {/* Dimension header */}
                  <div
                    onClick={() => setExecFields(p => ({ ...p, [fk]: !p[fk] }))}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                      padding: '6px 9px', background: isOpen ? 'rgba(0,229,180,.05)' : 'var(--s2)',
                      borderBottom: isOpen ? '1px solid var(--border)' : 'none',
                    }}
                  >
                    <span style={{ fontSize: 9, fontWeight: 700, color: '#00e5b4', flex: 1 }}>{label}</span>
                    <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
                      {totalBullets} items · {contributions.length} section{contributions.length !== 1 ? 's' : ''}
                    </span>
                    <span style={{ fontSize: 7, color: 'var(--muted)', marginLeft: 4 }}>{isOpen ? '▲' : '▼'}</span>
                  </div>

                  {/* Contributions grouped by section — each bullet on its own line */}
                  {isOpen && (
                    <div style={{ padding: '8px 10px 4px', background: 'var(--surface)' }}>
                      {contributions.map((contrib, ci) => (
                        <div key={contrib.sectionKey} style={{ marginBottom: ci < contributions.length - 1 ? 12 : 4 }}>
                          <div style={{
                            fontSize: 8, fontFamily: 'var(--fm)', fontWeight: 700, color: '#00e5b4',
                            marginBottom: 5, paddingLeft: 6,
                            borderLeft: '2px solid rgba(0,229,180,.5)',
                          }}>
                            {contrib.semanticLabel || contrib.mandate}
                          </div>
                          {contrib.bullets.map((text, bi) => (
                            <BulletItem key={bi} text={text} dot="#00e5b4" />
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Supporting Analysis and Source References are now embedded inside each
          Shared Plan Spine item above (constraint + rationale + provenance).
          The Execution Plan below contains derived outcomes and actions.      */}
        </>
      )}
    </div>
  )
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

function PlanCard({ plan, index, onRefineUnit, apiMode, globalBusy, draft = null, handoffBrief = null, onStage2Action = null }) {
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
          {/* Mission, Strategic Role, Execution Plan — all shown in expanded BU readiness row above */}

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
  const [legacyStage3DraftPlans, setLegacyStage3DraftPlans] = useState({})
  const [buPlanGeneration, setBuPlanGeneration] = useState({})
  const [stage12DraftOptIns, setStage12DraftOptIns] = useState({})
  const [coordinationDraft, setCoordinationDraft] = useState(null)
  // IDB readiness: true once storageReady() resolves; gates per-BU generation
  const [idbReady, setIdbReady] = useState(false)
  const [coordinationGen, setCoordinationGen] = useState({ running: false, error: null })
  const [captureImportStatus, setCaptureImportStatus] = useState(null)
  const captureImportRef = useRef(null)

  // ── Derived state ───────────────────────────────────────────────────────────
  const activeRev      = stage3Revisions.find(r => r.id === stage3ActiveId) ?? null
  const savedExecutionPlans = activeRev?.contentSnapshot?.executionPlans || []
  const savedSummaryNote    = activeRev?.contentSnapshot?.summaryNote    || ''
  const savedCoordinationLayer = activeRev?.contentSnapshot?.coordinationLayer || null
  const persistedExecutionPlans = Object.values(stage3DraftPlans)
    .filter(d => [LIFECYCLE_STATES.DRAFT_GENERATED, LIFECYCLE_STATES.PARTIAL_DRAFT, LIFECYCLE_STATES.ACCEPTED].includes(d?.lifecycle?.status))
    .map(d => d?.plan)
    .filter(Boolean)
  const recoveredLegacyExecutionPlans = Object.values(legacyStage3DraftPlans)
    .map(d => d?.plan)
    .filter(Boolean)
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
      setLegacyStage3DraftPlans({})
      setCoordinationDraft(null)
      return
    }
    let cancelled = false
    storageReady().then(() => {
      if (cancelled) return
      const hydrated = {}
      for (const bu of stage2BUs) {
        const key = stage3BuPlanDraftKey(effectiveWorkspaceId, stage1ActiveId, stage2ActiveId, bu.name)
        const draft = readJsonStorage(key)
        if (draft?.version === STAGE3_DRAFT_PLAN_VERSION && draft?.plan?.buName) {
          hydrated[bu.name] = draft
        } else {
          const legacyDraft = findLegacyStage3DraftForBU(bu.name, key)
          if (legacyDraft) hydrated[bu.name] = legacyDraft
        }
      }
      if (!cancelled) setStage3DraftPlans(hydrated)
      const recovered = {}
      for (const draft of findAllLegacyStage3Drafts()) {
        const name = draft?.businessUnitName || draft?.plan?.buName
        if (name && !hydrated[name]) recovered[name] = draft
      }
      if (!cancelled) setLegacyStage3DraftPlans(recovered)
      const coordination = readJsonStorage(stage3CoordinationDraftKey(effectiveWorkspaceId, stage1ActiveId, stage2ActiveId))
      if (!cancelled) setCoordinationDraft(coordination?.version === 1 ? coordination : null)
    }).catch(e => {
      if (!cancelled) console.error('[Stage3] hydration failed', e)
    })
    return () => { cancelled = true }
  }, [effectiveWorkspaceId, stage1ActiveId, stage2ActiveId, activeStage2Rev?.id])

  // Resolve idbReady once the IDB cache initialises
  useEffect(() => {
    let active = true
    storageReady()
      .then(() => { if (active) setIdbReady(true) })
      .catch(() => { if (active) setIdbReady(false) })
    return () => { active = false }
  }, [])

  function handleCaptureImport(file, unit) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const captureJson = JSON.parse(e.target.result)
        if (captureJson.buName !== unit.name) {
          setCaptureImportStatus({ error: `Capture buName "${captureJson.buName}" does not match "${unit.name}"` })
          return
        }
        const draft = buildCapturedStage3Draft(captureJson, unit.name)
        // Write to IDB (+ LS pointer). Run writes in parallel then update React state.
        const runtimeKey = stage3BuPlanDraftKey(effectiveWorkspaceId, stage1ActiveId, stage2ActiveId, unit.name)
        Promise.all([
          runtimeKey ? writeArtifact(runtimeKey, draft) : Promise.resolve(true),
          writeArtifact(CAPTURE_FALLBACK_KEY, draft),
        ]).then(([rOk, fbOk]) => {
          if (rOk || fbOk) setStage3DraftPlans(prev => ({ ...prev, [unit.name]: draft }))
        }).catch(() => {})
        // Optimistic UI update so the user sees the import immediately
        setStage3DraftPlans(prev => ({ ...prev, [unit.name]: draft }))
        setCaptureImportStatus({
          ok: true,
          runtimeKey: runtimeKey || '(IDs not available)',
          fallbackKey: CAPTURE_FALLBACK_KEY,
          sections: draft.plan.executionSections.length,
          atoms: draft.executionAtoms.length,
        })
      } catch (err) {
        setCaptureImportStatus({ error: `Parse failed: ${err.message}` })
      }
    }
    reader.readAsText(file)
  }

  function handleStage2HandoffAction(buName, itemKey, action) {
    writeJsonStorageSync('bsp_v1_stage2_handoff_focus', {
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
    setGenError('Stage 3 all-BU generation is not yet enabled. Use the per-BU Generate buttons in the readiness panel below.')
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
  async function persistBuPlanDraft(unit, plan, readiness, source, executionAtoms = [], lifecycle = {}, diagnostics = null, progress = null, atomPlan = null) {
    const now = new Date().toISOString()
    const atomSummary = summarizeAtoms(executionAtoms)
    const derivedStatus = lifecycle.status || deriveLifecycleState({ atoms: executionAtoms })
    const validAtomCount = renderingEligibleAtoms(executionAtoms).length
    const generationStartedAt = progress?.startedAt || minIso(executionAtoms.map(atom => atom?.startedAt)) || now
    const generationCompletedAt = derivedStatus === LIFECYCLE_STATES.GENERATING
      ? null
      : (progress?.completedAt || maxIso(executionAtoms.map(atom => atom?.completedAt)) || now)
    const handoffBasisHash = stage3TraceHash({
      handoffBrief: readiness?.planningContext?.handoffBrief || readiness?.handoffBrief || null,
      structureItems: readiness?.structureItems || [],
      itemStates: readiness?.itemStates || [],
    })
    const draftVersionId = `${STAGE3_DRAFT_PLAN_VERSION}:${storageSafeName(unit.name)}:${handoffBasisHash}:${stage3TraceHash(now)}`
    const draft = {
      version: STAGE3_DRAFT_PLAN_VERSION,
      draftVersionId,
      workspaceId: effectiveWorkspaceId,
      activePlanId: effectiveWorkspaceId,
      buName: unit.name,
      businessUnitName: unit.name,
      sourceBasisRevisionId: stage1ActiveId,
      sourceStage2RevisionId: stage2ActiveId,
      plan,
      executionAtoms,
      atomSummary,
      failures: executionAtoms
        .filter(a => STAGE3_FAILED_ATOM_STATUSES.has(a?.status))
        .map(a => ({
          atomId: a.id,
          elementName: a.elementName,
          childKey: a.childKey,
          reason: a.parserError || 'unknown',
          stopReason: a.metadata?.stopReason || null,
          failureLabel: a.metadata?.failureLabel || null,
          usage: a.metadata?.usage || null,
          rawExcerpt: typeof a.rawResponseText === 'string' ? a.rawResponseText.slice(0, 200) : null,
        })),
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
      lifecycle: {
        status: derivedStatus,
        acceptedAt: lifecycle.acceptedAt || null,
        failureReason: lifecycle.failureReason || null,
      },
      status: derivedStatus,
      accepted: false,
      source,
      provenance: { generatedBy: 'stage3-bu-plan-lifecycle', stage1Id: stage1ActiveId, stage2Id: stage2ActiveId },
      tokenUsage: diagnostics ? { inputTokens: diagnostics.inputTokens || 0, outputTokens: diagnostics.outputTokens || 0 } : null,
      diagnostics,
      progress: progress ? { ...progress, lifecycleState: progress.lifecycleState === 'generating' ? 'interrupted' : progress.lifecycleState } : null,
      generationStartedAt,
      generationCompletedAt,
      handoffBasisHash,
      atomCountUsedByCompiler: validAtomCount,
      stage3BasisVersion: STAGE3_BASIS_VERSION,
      learningSignalsVersion: STAGE3_LEARNING_SIGNALS_VERSION,
      learningBasisHash: atomPlan?.learningBasisHash || stage3TraceHash(STAGE3_COMPILED_STRATEGY_LEARNING_SIGNALS),
      generationRunId: atomPlan?.generationRunId || progress?.generationRunId || null,
      regenerationMode: atomPlan?.stalenessPlan?.regenerationMode || null,
      stalenessPlan: atomPlan?.stalenessPlan || null,
      handoffItemBasis: atomPlan?.handoffBasis?.itemBasis || null,
      atomSetCurrency: atomPlan?.stalenessPlan?.atomSetCurrency || null,
      generatedAt: executionAtoms.find(a => a.completedAt)?.completedAt || now,
      persistedAt: now,
      updatedAt: now,
      lastSavedAt: now,
    }
    const key = stage3BuPlanDraftKey(effectiveWorkspaceId, stage1ActiveId, stage2ActiveId, unit.name)
    const writeOk = await writeArtifact(key, draft)
    logExecutiveBoundary(unit, 'H. persistedStage3State', { key, writeOk, status: derivedStatus, atomSummary })
    if (writeOk) {
      setStage3DraftPlans(prev => ({ ...prev, [unit.name]: draft }))
    }
    return { ok: writeOk, key, draft }
  }

  async function handleGenerateBUPlan(unit, readiness) {
    if (!activeStage1Rev || !activeStage2Rev) return { error: 'No active upstream revisions.' }
    const blockReason = getPerBuGenerationBlock(unit, readiness, idbReady, buPlanGeneration[unit.name])
    if (blockReason) return { error: `Generation blocked: ${blockReason}` }
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
    setBuPlanGeneration(prev => ({ ...prev, [unit.name]: { running: true, error: null } }))
    setGenError(null)

    try {
      const priorDraft = stage3DraftPlans[unit.name] || null
      if (readiness.acceptOnly) {
        if (priorDraft?.lifecycle?.status !== LIFECYCLE_STATES.DRAFT_GENERATED || !priorDraft?.plan) {
          throw new Error(`No validated ${unit.name} draft is ready to accept.`)
        }
        await persistBuPlanDraft(
          unit,
          priorDraft.plan,
          readiness,
          priorDraft.source || 'ai',
          priorDraft.executionAtoms || [],
          { status: LIFECYCLE_STATES.ACCEPTED, acceptedAt: new Date().toISOString() },
          priorDraft.diagnostics || null,
        )
        setBuPlanGeneration(prev => ({
          ...prev,
          [unit.name]: { running: false, error: null, lifecycleState: LIFECYCLE_STATES.ACCEPTED, diagnostics: priorDraft.diagnostics || null },
        }))
        return { error: null }
      }

      const mode = readiness.completion === 'full'
        ? 'full'
        : readiness.completion === 'none'
          ? 'stage1_2_only'
          : 'limited'
      if (mode === 'stage1_2_only') {
        throw new Error('Product Management needs a compact Stage 2 handoff before Stage 3 generation. Stage 1/2-only fallback output is disabled.')
      }
      const regenerationMode = readiness.regenerationMode || STAGE3_REGENERATION_MODES.SMART
      const generationRunId = `stage3-run:${storageSafeName(unit.name)}:${stage3TraceHash(new Date().toISOString())}`
      let atomPlan = buildExecutionAtomPlanForBU(unit, readiness, priorDraft, mode, regenerationMode, generationRunId)
      let atoms = atomPlan.atoms
      if (!atoms.length) {
        throw new Error('No validated Stage 2 handoff atoms are available for Product Management.')
      }
      if (regenerationMode === STAGE3_REGENERATION_MODES.RECOMPILE_ONLY) {
        const eligibleAtoms = renderingEligibleAtoms(atoms)
        const plan = eligibleAtoms.length ? assembleAtomizedBUPlan(unit, readiness, atoms, mode) : priorDraft?.plan || null
        const diagnostics = buildGenerationDiagnostics({
          buName: unit.name,
          requestedAtoms: [],
          runnableAtoms: [],
          completedAtoms: eligibleAtoms,
          retryMode: 'recompile only',
          model: AI_MODEL_LABEL,
        })
        const progress = buildStage3Progress({
          unit,
          mode: 'recompile only',
          atoms,
          lifecycleState: 'recompiled',
          skippedCount: atoms.length,
        })
        const skipAtomPlan = {
          ...atomPlan,
          stalenessPlan: { ...atomPlan.stalenessPlan, atomSetCurrency: 'current' },
        }
        const { ok: persistOk } = await persistBuPlanDraft(unit, plan, readiness, priorDraft?.source || 'ai', atoms, { status: priorDraft?.lifecycle?.status || LIFECYCLE_STATES.DRAFT_GENERATED }, diagnostics, progress, skipAtomPlan)
        setBuPlanGeneration(prev => ({
          ...prev,
          [unit.name]: {
            running: false,
            error: persistOk ? null : 'Recompile-only draft was not persisted.',
            lifecycleState: persistOk ? (priorDraft?.lifecycle?.status || LIFECYCLE_STATES.DRAFT_GENERATED) : LIFECYCLE_STATES.GENERATION_FAILED,
            diagnostics,
            progress,
            atomSummary: summarizeAtoms(atoms),
            stalenessPlan: skipAtomPlan.stalenessPlan,
          },
        }))
        return { error: persistOk ? null : 'Recompile-only draft was not persisted.' }
      }

      const runnableAtoms = atoms.filter(atom => STAGE3_RETRYABLE_ATOM_STATUSES.has(atom?.status))
      if (!runnableAtoms.length) {
        const eligibleAtoms = renderingEligibleAtoms(atoms)
        const plan = eligibleAtoms.length ? assembleAtomizedBUPlan(unit, readiness, atoms, mode) : priorDraft?.plan || null
        const diagnostics = buildGenerationDiagnostics({
          buName: unit.name,
          requestedAtoms: atoms,
          runnableAtoms,
          completedAtoms: eligibleAtoms,
          retryMode: 'smart - no stale atoms',
          model: AI_MODEL_LABEL,
        })
        const progress = buildStage3Progress({
          unit,
          mode: 'smart - no stale atoms',
          atoms,
          lifecycleState: 'skipped',
          skippedCount: atoms.length,
        })
        const { ok: persistOk } = await persistBuPlanDraft(unit, plan, readiness, priorDraft?.source || 'ai', atoms, { status: priorDraft?.lifecycle?.status || LIFECYCLE_STATES.DRAFT_GENERATED }, diagnostics, progress, atomPlan)
        setBuPlanGeneration(prev => ({
          ...prev,
          [unit.name]: {
            running: false,
            error: persistOk ? null : 'Smart regeneration skipped all atoms, but provenance was not persisted.',
            lifecycleState: persistOk ? (priorDraft?.lifecycle?.status || LIFECYCLE_STATES.DRAFT_GENERATED) : LIFECYCLE_STATES.GENERATION_FAILED,
            diagnostics,
            progress,
            atomSummary: summarizeAtoms(atoms),
            stalenessPlan: atomPlan.stalenessPlan,
          },
        }))
        return { error: persistOk ? null : 'Smart regeneration skipped all atoms, but provenance was not persisted.' }
      }

      if (priorDraft?.plan || priorDraft?.executionAtoms?.length) {
        const backupKey = stage3BuPlanBackupKey(effectiveWorkspaceId, stage1ActiveId, stage2ActiveId, unit.name, new Date().toISOString())
        const backupOk = await writeArtifact(backupKey, {
          version: 1,
          backupType: 'stage3_bu_plan_prior_to_regeneration',
          businessUnitName: unit.name,
          sourceKey: stage3BuPlanDraftKey(effectiveWorkspaceId, stage1ActiveId, stage2ActiveId, unit.name),
          createdAt: new Date().toISOString(),
          reason: `Preserve prior BU draft before Stage 3 ${regenerationMode} regeneration.`,
          regenerationMode,
          generationRunId,
          stalenessPlan: atomPlan.stalenessPlan,
          draft: priorDraft,
        })
        if (!backupOk) {
          throw new Error(`Could not preserve prior ${unit.name} draft before regeneration. Regeneration stopped to avoid content loss.`)
        }
      }
      logExecutiveBoundary(unit, 'C2. executionAtoms', atoms)

      if (!hasApiKey()) {
        throw new Error(`Anthropic API key is required for Stage 3 generation. Add VITE_ANTHROPIC_API_KEY to your environment.`)
      }

      const retryMode = atoms.some(atom => STAGE3_FAILED_ATOM_STATUSES.has(atom.status))
        ? 'retry failed only'
        : runnableAtoms.length < atoms.length
          ? `smart stale only`
          : regenerationMode === STAGE3_REGENERATION_MODES.FORCE ? 'force full' : 'full'
      const startingDiagnostics = buildGenerationDiagnostics({
        buName: unit.name,
        requestedAtoms: atoms,
        runnableAtoms,
        retryMode,
        model: AI_MODEL_LABEL,
      })
      setBuPlanGeneration(prev => ({
        ...prev,
        [unit.name]: {
          running: true,
          error: null,
          lifecycleState: LIFECYCLE_STATES.GENERATING,
          diagnostics: startingDiagnostics,
          progress: buildStage3Progress({
            unit,
            mode: startingDiagnostics.retryMode,
            atoms,
            currentAtom: runnableAtoms[0] || atoms[0],
            lifecycleState: runnableAtoms.length ? 'queued' : 'skipped',
            skippedCount: startingDiagnostics.atomsSkippedAlreadyValid,
            latestUsage: null,
          }),
          atomSummary: summarizeAtoms(atoms),
          stalenessPlan: atomPlan.stalenessPlan,
        },
      }))

      const lifecycleResult = await runGenerationLifecycle({
        buName: unit.name,
        atoms,
        delayMs: STAGE3_QUEUE_DELAY_MS,
        retryFailedOnly: true,
        model: AI_MODEL_LABEL,
        retryMode,
        onUpdate: async ({ lifecycleState, atomLifecycleState, currentAtom, atoms: allAtoms, diagnostics }) => {
          const eligibleAtoms = renderingEligibleAtoms(allAtoms)
          const plan = eligibleAtoms.length ? assembleAtomizedBUPlan(unit, readiness, allAtoms, mode) : null
          const progress = buildStage3Progress({
            unit,
            mode: diagnostics?.retryMode || 'partial',
            atoms: allAtoms,
            currentAtom,
            lifecycleState: atomLifecycleState || lifecycleState,
            skippedCount: diagnostics?.atomsSkippedAlreadyValid || 0,
            latestFailureReason: currentAtom?.parserError || null,
            latestUsage: diagnostics?.latestUsage || null,
          })
          const { ok: midWriteOk } = await persistBuPlanDraft(unit, plan, readiness, 'ai', allAtoms, { status: lifecycleState }, diagnostics, progress, atomPlan)
          setBuPlanGeneration(prev => ({
            ...prev,
            [unit.name]: {
              running: true,
              error: null,
              persistError: midWriteOk ? null : 'Generated content was not persisted. Do not refresh.',
              lifecycleState,
              diagnostics,
              progress,
              atomSummary: summarizeAtoms(allAtoms),
              stalenessPlan: atomPlan.stalenessPlan,
            },
          }))
        },
        worker: async (atom) => {
          console.log(`[Stage3 API] BU field atom start: ${unit.name} / ${atom.elementName} / ${atom.childKey}`)
          const { messages } = buildStage3FieldAtomMessages(
            s1Snap,
            enrichedUnit,
            atom.metadata?.handoffItem || { key: atom.childKey, label: atom.elementName },
            atom.metadata?.fieldKey || atom.childKey,
            mode,
            otherNames,
          )
          logExecutiveBoundary(unit, `D. stage3PromptPayload / ${atom.childKey}`, messages)
          const promptBytes = estimateMessageBytes(messages)
          const response = await callAI(messages, { temperature: 0.3, maxTokens: 650 })
          logExecutiveBoundary(unit, `E. rawModelResponse / ${atom.childKey}`, response.result || response.error)
          if (response.error) {
            const message = isRateLimitedAIResponse(response)
              ? `Rate limited while generating ${unit.name} / ${atom.elementName}. Retry this atom after cooldown.`
              : response.error
            throw { message, rawResponseText: response.result || null, status: response.status, rateLimited: response.rateLimited, usage: response.usage || null, stopReason: response.stopReason || null, model: response.model || null }
          }
          if (response.stopReason === 'max_tokens') {
            throw {
              message: 'Model output exceeded max_tokens before returning valid JSON.',
              rawResponseText: response.result || null,
              failureLabel: 'max_tokens',
              stopReason: response.stopReason,
              usage: response.usage || null,
              model: response.model || null,
            }
          }
          setBuPlanGeneration(prev => ({
            ...prev,
            [unit.name]: {
              ...(prev[unit.name] || {}),
              running: true,
              lifecycleState: LIFECYCLE_STATES.GENERATING,
              progress: buildStage3Progress({
                unit,
                mode: retryMode,
                atoms,
                currentAtom: atom,
                lifecycleState: 'validating',
                skippedCount: startingDiagnostics.atomsSkippedAlreadyValid,
                latestUsage: response.usage
                  ? {
                      atomId: atom.id,
                      input_tokens: response.usage.input_tokens || 0,
                      output_tokens: response.usage.output_tokens || 0,
                      stop_reason: response.stopReason || null,
                      model: response.model || AI_MODEL_LABEL,
                      timestamp: new Date().toISOString(),
                    }
                  : null,
              }),
            },
          }))
          const fieldKey = atom.metadata?.fieldKey || atom.childKey
          const parsed = parseStage3FieldAtomResponse(response.result, fieldKey)
          logExecutiveBoundary(unit, `F. parsedStage3Result / ${atom.childKey}`, parsed)
          if (parsed.error) {
            throw {
              message: parsed.error || 'Execution field atom parse failed.',
              rawResponseText: response.result || null,
              failureLabel: 'validation_failed',
              usage: response.usage || null,
              stopReason: response.stopReason || null,
              model: response.model || null,
            }
          }
          return {
            rawResponseText: response.result,
            parsedValue: parsed.value,
            promptBytes,
            outputBytes: estimateTextBytes(response.result || ''),
            usage: response.usage || null,
            stopReason: response.stopReason || null,
            model: response.model || null,
          }
        },
      })

      const updatedAtoms = lifecycleResult.atoms
      const eligibleFinal = renderingEligibleAtoms(updatedAtoms)
      const hasFinalFailures = updatedAtoms.some(a => STAGE3_FAILED_ATOM_STATUSES.has(a?.status))
      // Assemble partial plan from any successful atoms — never null just because some atoms failed
      const finalPlan = eligibleFinal.length
        ? assembleAtomizedBUPlan(unit, readiness, updatedAtoms, mode)
        : null
      const finalLifecycleState = eligibleFinal.length && hasFinalFailures
        ? LIFECYCLE_STATES.PARTIAL_DRAFT
        : lifecycleResult.lifecycleState
      const finalProgress = buildStage3Progress({
        unit,
        mode: lifecycleResult.diagnostics?.retryMode || 'partial',
        atoms: updatedAtoms,
        lifecycleState: finalLifecycleState === LIFECYCLE_STATES.GENERATION_FAILED ? 'failed'
          : finalLifecycleState === LIFECYCLE_STATES.PARTIAL_DRAFT ? 'partial' : 'persisted',
        skippedCount: lifecycleResult.diagnostics?.atomsSkippedAlreadyValid || 0,
        latestFailureReason: hasFinalFailures ? `${updatedAtoms.filter(a => STAGE3_FAILED_ATOM_STATUSES.has(a?.status)).length} atom(s) failed. Retry to complete.` : null,
        latestUsage: lifecycleResult.diagnostics?.latestUsage || null,
      })
      // Persist BEFORE updating React state — if write fails, block safe render
      const finalAtomPlan = {
        ...atomPlan,
        stalenessPlan: {
          ...atomPlan.stalenessPlan,
          atomSetCurrency: hasFinalFailures ? 'stale' : 'current',
        },
      }
      const { ok: persistOk } = await persistBuPlanDraft(unit, finalPlan, readiness, 'ai', updatedAtoms, { status: finalLifecycleState }, lifecycleResult.diagnostics, finalProgress, finalAtomPlan)
      const persistError = !persistOk ? 'Generated content was not persisted. Do not refresh.' : null
      setBuPlanGeneration(prev => ({
        ...prev,
        [unit.name]: {
          running: false,
          error: hasFinalFailures
            ? `${updatedAtoms.filter(a => STAGE3_FAILED_ATOM_STATUSES.has(a?.status)).length} atom(s) failed. Retry to complete missing sections.`
            : null,
          persistError,
          lifecycleState: persistOk ? finalLifecycleState : LIFECYCLE_STATES.GENERATION_FAILED,
          diagnostics: lifecycleResult.diagnostics,
          progress: finalProgress,
          atomSummary: lifecycleResult.atomSummary,
          stalenessPlan: finalAtomPlan.stalenessPlan,
        },
      }))
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
      await writeArtifact(stage3CoordinationDraftKey(effectiveWorkspaceId, stage1ActiveId, stage2ActiveId), draft)
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

  // Refine by buName — used by Stage3ReadinessPanels refine panel in the readiness row
  const handleRefineUnitByName = useCallback(async (buName, prompt, impact, scope) => {
    const idx = executionPlans.findIndex(p => p.buName === buName)
    if (idx < 0) return { error: `No active plan found for ${buName}.` }
    return handleUnitRegenerate(idx, prompt, impact || '', scope || 'auto')
  }, [executionPlans, handleUnitRegenerate])

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
        <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
          D · BU Readiness &amp; Generation
        </div>
        <Stage3ReadinessPanels
          rows={readinessRows}
          planDrafts={stage3DraftPlans}
          legacyExecutionPlans={executionPlans}
          planGeneration={buPlanGeneration}
          draftOptIns={stage12DraftOptIns}
          onOptIntoStage12Draft={buName => setStage12DraftOptIns(prev => ({ ...prev, [buName]: true }))}
          onGenerateBUPlan={handleGenerateBUPlan}
          onStage2Action={handleStage2HandoffAction}
          onRefineUnit={handleRefineUnitByName}
          apiMode={apiMode}
          disabled={!activeStage1Rev || !activeStage2Rev || isGenerating}
          generationEnabled
          captureImportRef={captureImportRef}
          captureImportStatus={captureImportStatus}
          onCaptureImport={handleCaptureImport}
          idbReady={idbReady}
        />
        <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
          C · Cross-BU Coordination
        </div>
        <CoordinationReadinessPanel
          readiness={coordinationReadiness}
          coordinationDraft={coordinationDraft}
          isGenerating={coordinationGen.running}
          error={coordinationGen.error}
          onGenerate={handleGenerateCoordination}
        />
        {(!activeStage1Rev || !activeStage2Rev) && (
          <div style={{
            fontSize: 10, color: '#f87171', marginBottom: 12, padding: '8px 14px',
            background: 'rgba(248,113,113,.06)', border: '1px solid rgba(248,113,113,.25)',
            borderRadius: 5, fontFamily: 'var(--fm)',
          }}>
            {!activeStage1Rev ? 'No active Stage 1 revision.' : 'No active Stage 2 revision.'} Go back and complete it first.
          </div>
        )}
        <GenerationProgress generation={generation} onRetry={handleRetryGeneration} />
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
      </div>

      {/* ── D. BU Readiness & Generation ──────────────────────────────────── */}
      <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
        D · BU Readiness &amp; Generation
      </div>
      <Stage3ReadinessPanels
        rows={readinessRows}
        planDrafts={stage3DraftPlans}
        legacyExecutionPlans={executionPlans}
        planGeneration={buPlanGeneration}
        draftOptIns={stage12DraftOptIns}
        onOptIntoStage12Draft={buName => setStage12DraftOptIns(prev => ({ ...prev, [buName]: true }))}
        onGenerateBUPlan={handleGenerateBUPlan}
        onStage2Action={handleStage2HandoffAction}
        apiMode={apiMode}
        disabled={!activeStage1Rev || !activeStage2Rev || isGenerating}
        generationEnabled
        captureImportRef={captureImportRef}
        captureImportStatus={captureImportStatus}
        onCaptureImport={handleCaptureImport}
      />

      {/* ── C. Cross-BU Coordination ──────────────────────────────────────── */}
      <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
        C · Cross-BU Coordination
      </div>
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
              Regenerate individual BUs from the readiness panel below. All-BU regeneration is not yet enabled.
            </div>
          </div>
          <button
            onClick={() => setGenError('All-BU Stage 3 regeneration is not yet enabled. Use the per-BU Generate buttons in the readiness panel below.')}
            disabled
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

      {/* ── Live generation progress ─────────────────────────────────────── */}
      <GenerationProgress generation={generation} onRetry={handleRetryGeneration} />
      {/* BU execution plans are inside the D · BU Readiness expanded rows above — not duplicated here */}

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
