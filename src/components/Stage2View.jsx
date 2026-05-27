// Stage 2 — Business Unit Mapping
// Generates an inferred BU structure from the active Stage 1 revision.
// Supports: AI generation (VITE_ANTHROPIC_API_KEY) + mock mode (no key required).
//
// Refinement architecture:
//   Unit-level  — localised panel inside each BU card; regenerates one unit via AI,
//                 merges back into full snapshot, saves a new Stage 2 revision.
//   Stage-level — bottom-of-stage RefinementPanel for cross-functional / org-wide
//                 correction notes; creates full revision snapshots (manual, no AI).
//
// Revision history remains strictly stage-level — no nested unit histories.

import React, { useState, useCallback, useEffect, useRef } from 'react'
import { hasApiKey, callAI, getApiMode, AI_MODEL_LABEL } from '../api/aiClient'
import {
  buildStage2Messages,
  parseStage2Response,
  generateMockStage2,
  buildStage2UnitRefinementMessages,
  parseStage2UnitResponse,
  buildStage2StageRefinementMessages,
  orderBusinessUnits,
} from '../utils/stage2Prompts'
import { buildStage2RevisionRecord, stage2SnapshotToText } from '../utils/stageSnapshots'
import {
  buildHandoffStructureMessages, parseHandoffStructureResponse,
  parseHandoffItemResponse,
  buildHandoffChildAtomMessages, parseHandoffChildAtomResponse,
  buildHandoffItemRefinementMessages,
  buildHandoffChildAtomRefinementMessages,
  buildSmeLensMessages, parseSmeLensResponse,
  buildSmeLensRefinementMessages,
  CHILD_ATOM_KEYS,
} from '../utils/handoffPrompts'
import RevisionHistory    from './RevisionHistory'
import RevisionDiffViewer from './RevisionDiffViewer'
import RefinementPanel    from './RefinementPanel'
import LearningSignals    from './LearningSignals'
import { deriveLearningSignals, buildLearningSignalMessages, parseLearningSignalResponse, normalizeLearningSignals } from '../utils/learningSignals'

// ── Involvement level styles ──────────────────────────────────────────────────
const LEVEL_COLORS = {
  primary:    { color: '#3b82f6', label: 'Primary driver'  },
  supporting: { color: '#fb923c', label: 'Supporting'       },
  informed:   { color: 'rgba(255,255,255,.38)', label: 'Informed' },
}
function levelStyle(lvl) {
  return LEVEL_COLORS[lvl] || LEVEL_COLORS.supporting
}

// ── Small shared primitives ───────────────────────────────────────────────────

function Badge({ children, color }) {
  const c = color || 'rgba(255,255,255,.38)'
  return (
    <span style={{
      fontSize: 8, fontFamily: 'var(--fm)', padding: '2px 7px', borderRadius: 3,
      color: c, background: `${c}18`, border: `1px solid ${c}30`,
      display: 'inline-block', lineHeight: 1.6,
    }}>
      {children}
    </span>
  )
}

function SubList({ label, items, borderColor }) {
  if (!items?.length) return null
  const bc = borderColor || 'var(--border2)'
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5 }}>
        {label}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {items.map((item, i) => (
          <div key={i} style={{
            fontSize: 10, color: 'var(--muted2)', lineHeight: 1.65,
            paddingLeft: 10, borderLeft: `2px solid ${bc}`,
          }}>
            {item}
          </div>
        ))}
      </div>
    </div>
  )
}

const ITEM_STATE_DEFAULT = {
  status: 'not_started', rawResponse: null, parsedValue: null, parserError: null,
  isDecomposed: false, assembledFromChildren: false, childAtoms: null,
  missingChildren: [], failedChildren: [], isStale: false,
}

// Display label for a handoff structure item (string legacy or new object format)
function getThemeLabel(theme) {
  return typeof theme === 'string' ? theme : theme?.label || theme?.key || '(unnamed)'
}

// Formatted string for passing a structure item into prompt context
function getThemeContext(theme) {
  if (typeof theme === 'string') return theme
  const parts = [theme.label]
  if (theme.purpose)        parts.push(`Purpose: ${theme.purpose}`)
  if (theme.SMEReviewFocus) parts.push(`SME Review Focus: ${theme.SMEReviewFocus}`)
  return parts.filter(Boolean).join('\n')
}

// Derive a camelCase key from a structure item
function getThemeKey(theme) {
  if (typeof theme === 'object' && theme?.key) return theme.key
  return getThemeLabel(theme)
    .toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
    .split(/\s+/).map((w, i) => i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)).join('')
}
const CHILD_ATOM_STATE_DEFAULT = { status: 'not_started', rawResponse: null, parsedValue: null, parserError: null }
const SME_LENS_STATE_DEFAULT   = { status: 'not_started', rawResponse: null, parsedValue: null, parserError: null }

function Stage3HandoffShell({ bu, otherBuNames, activeStage1Rev, apiMode, workspaceId }) {
  const [open,              setOpen]              = useState(false)
  const [isGenerating,      setIsGenerating]      = useState(false)
  const [structureRaw,      setStructureRaw]      = useState(null)
  const [parsed,            setParsed]            = useState(null)   // { domainOfWork, handoffStructure }
  const [genError,          setGenError]          = useState(null)
  const [itemStates,        setItemStates]        = useState({})     // { [index]: ITEM_STATE_DEFAULT }
  const [smeLensState,      setSmeLensState]      = useState(SME_LENS_STATE_DEFAULT)
  const [structureIsStale,  setStructureIsStale]  = useState(false)  // true after SME lens changes
  const [buHandoff,         setBuHandoff]         = useState(null)   // assembled BU-level handoff
  // transient UI state — not persisted
  const [itemOpen,          setItemOpen]          = useState({})     // { [i]: bool }
  const [smeLensRefineUi,   setSmeLensRefineUi]   = useState({ open: false, prompt: '', busy: false, error: null })
  const [itemRefineUi,      setItemRefineUi]      = useState({})
  const [childRefineUi,     setChildRefineUi]     = useState({})
  const [decompositionOpen, setDecompositionOpen] = useState({})

  // ── Draft persistence ───────────────────────────────────────────────────────
  const hasHydrated = useRef(false)
  const storageKey  = workspaceId ? `bsp_v1_handoff_${workspaceId}_${bu.name}` : null

  // Hydrate once on mount
  useEffect(() => {
    if (!storageKey) { hasHydrated.current = true; return }
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) {
        const { parsed: p, itemStates: is, smeLensState: sls, structureIsStale: sis, buHandoff: bh } = JSON.parse(raw)
        if (p)   setParsed(p)
        if (is)  setItemStates(is)
        if (sls) setSmeLensState(sls)
        if (sis) setStructureIsStale(sis)
        if (bh)  setBuHandoff(bh)
      }
    } catch { /* ignore corrupt data */ }
    hasHydrated.current = true
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist whenever persisted state changes (skip initial empty save)
  useEffect(() => {
    if (!hasHydrated.current || !storageKey) return
    try {
      localStorage.setItem(storageKey, JSON.stringify({ parsed, itemStates, smeLensState, structureIsStale, buHandoff }))
    } catch { /* quota errors are non-fatal */ }
  }, [parsed, itemStates, smeLensState, structureIsStale, buHandoff, storageKey])

  // ── Structure generation ────────────────────────────────────────────────────

  const hasSmeLens    = !!smeLensState.parsedValue
  const canGenStructure = apiMode === 'ai' && !!activeStage1Rev && !isGenerating && hasSmeLens

  async function handleGenerateHandoffStructure() {
    if (!canGenStructure) return
    setIsGenerating(true)
    setGenError(null)
    setStructureRaw(null)

    const { messages } = buildHandoffStructureMessages(
      activeStage1Rev.contentSnapshot, bu, smeLensState.parsedValue, otherBuNames,
    )
    const { result, error } = await callAI(messages, { temperature: 0.3, maxTokens: 2000 })

    if (error) {
      setGenError(error)
      setIsGenerating(false)
      return
    }

    setStructureRaw(result)
    const p = parseHandoffStructureResponse(result)

    if (p.error) {
      setGenError(p.error)
      setIsGenerating(false)
      return
    }

    setParsed({ domainOfWork: p.domainOfWork, handoffStructure: p.handoffStructure })
    setItemStates({})
    setStructureIsStale(false)
    setIsGenerating(false)
  }

  // ── SME lens generation ─────────────────────────────────────────────────────

  async function handleGenerateSmeLens() {
    if (!activeStage1Rev || smeLensState.status === 'generating') return
    setSmeLensState({ status: 'generating', rawResponse: null, parsedValue: null, parserError: null })

    const completedThemes = parsed?.handoffStructure?.filter((_, idx) => {
      const s = itemStates[idx]?.status
      return s === 'complete' || s === 'partial'
    }) || []

    const { messages } = buildSmeLensMessages(
      activeStage1Rev.contentSnapshot,
      bu,
      parsed?.domainOfWork || null,
      parsed?.handoffStructure || null,
      completedThemes,
      otherBuNames,
    )
    const { result, error } = await callAI(messages, { temperature: 0.3, maxTokens: 800 })

    if (error) {
      setSmeLensState(prev => ({ ...prev, status: 'failed', rawResponse: result ?? null, parserError: error }))
      return
    }

    const p = parseSmeLensResponse(result)
    if (p.error) {
      setSmeLensState(prev => ({ ...prev, status: 'failed', rawResponse: result, parserError: p.error }))
      return
    }

    setSmeLensState({ status: 'complete', rawResponse: result, parsedValue: p.parsedValue, parserError: null })
    // Mark existing structure/items stale when SME lens changes
    if (parsed?.handoffStructure) {
      setStructureIsStale(true)
      setItemStates(prev => {
        const updated = { ...prev }
        Object.keys(updated).forEach(idx => {
          const s = updated[idx]?.status
          if (s === 'complete' || s === 'partial') {
            updated[idx] = { ...updated[idx], isStale: true }
          }
        })
        return updated
      })
    }
  }

  async function handleRefineSmeLens() {
    if (!smeLensState.parsedValue || !activeStage1Rev) return
    const prompt = smeLensRefineUi.prompt?.trim()
    if (!prompt) return

    setSmeLensRefineUi(p => ({ ...p, busy: true, error: null }))

    const { messages } = buildSmeLensRefinementMessages(
      activeStage1Rev.contentSnapshot,
      bu,
      parsed?.domainOfWork || null,
      parsed?.handoffStructure || null,
      smeLensState.parsedValue,
      prompt,
      otherBuNames,
    )
    const { result, error } = await callAI(messages, { temperature: 0.3, maxTokens: 800 })

    if (error) {
      setSmeLensRefineUi(p => ({ ...p, busy: false, error }))
      return
    }

    const p = parseSmeLensResponse(result)
    if (p.error) {
      setSmeLensRefineUi(prev => ({ ...prev, busy: false, error: p.error }))
      return
    }

    setSmeLensState(prev => ({ ...prev, rawResponse: result, parsedValue: p.parsedValue, parserError: null }))
    setSmeLensRefineUi({ open: false, prompt: '', busy: false, error: null })
    if (parsed?.handoffStructure) {
      setStructureIsStale(true)
      setItemStates(prev => {
        const updated = { ...prev }
        Object.keys(updated).forEach(idx => {
          const s = updated[idx]?.status
          if (s === 'complete' || s === 'partial') {
            updated[idx] = { ...updated[idx], isStale: true }
          }
        })
        return updated
      })
    }
  }

  // ── Per-item generation ─────────────────────────────────────────────────────

  function patchItem(i, patch) {
    setItemStates(prev => ({
      ...prev,
      [i]: { ...ITEM_STATE_DEFAULT, ...(prev[i] || {}), ...patch },
    }))
  }

  async function handleGenerateItem(i, theme) {
    if (!activeStage1Rev || !parsed) return

    const structureItemContext = getThemeContext(theme)
    const themeKey = getThemeKey(theme)

    // Open item to show progress; reset state
    setItemOpen(prev => ({ ...prev, [i]: true }))
    patchItem(i, {
      status: 'generating',
      isDecomposed: true,
      assembledFromChildren: false,
      parsedValue: null,
      parserError: null,
      rawResponse: null,
      isStale: false,
      childAtoms: Object.fromEntries(CHILD_ATOM_KEYS.map(k => [k, { ...CHILD_ATOM_STATE_DEFAULT }])),
      missingChildren: [],
      failedChildren: [],
    })

    // Track each child result locally so assembly doesn't read stale React state
    const localResults = {}

    async function runOne(childKey) {
      patchChildAtom(i, childKey, { status: 'generating', parserError: null, rawResponse: null })

      const { messages } = buildHandoffChildAtomMessages(
        activeStage1Rev.contentSnapshot,
        bu,
        parsed.domainOfWork,
        smeLensState.parsedValue || null,
        structureItemContext,
        childKey,
        otherBuNames,
      )
      const { result, error } = await callAI(messages, { temperature: 0.3, maxTokens: 800 })

      if (error) {
        patchChildAtom(i, childKey, { status: 'failed', parserError: error, rawResponse: result ?? null })
        localResults[childKey] = { status: 'failed' }
        return
      }

      const p = parseHandoffChildAtomResponse(result, childKey)
      if (p.error) {
        patchChildAtom(i, childKey, { status: 'failed', rawResponse: result, parserError: p.error })
        localResults[childKey] = { status: 'failed' }
        return
      }

      patchChildAtom(i, childKey, { status: 'complete', rawResponse: result, parsedValue: p.value, parserError: null })
      localResults[childKey] = { status: 'complete', parsedValue: p.value }
    }

    // Bounded concurrency — process CHILD_ATOM_KEYS in pairs
    const CONCURRENCY = 2
    for (let j = 0; j < CHILD_ATOM_KEYS.length; j += CONCURRENCY) {
      await Promise.all(CHILD_ATOM_KEYS.slice(j, j + CONCURRENCY).map(runOne))
    }

    // Assemble from local results (avoids reading stale React state)
    const assembledValue = {}
    const missingChildren = []
    const failedChildren  = []

    CHILD_ATOM_KEYS.forEach(key => {
      const r = localResults[key]
      if (r?.status === 'complete' && r.parsedValue !== null) {
        assembledValue[key] = r.parsedValue
      } else if (r?.status === 'failed') {
        failedChildren.push(key)
      } else {
        missingChildren.push(key)
      }
    })

    if (!Object.keys(assembledValue).length) {
      patchItem(i, { status: 'failed', parserError: 'All child atoms failed to generate.' })
      return
    }

    const isPartial = missingChildren.length > 0 || failedChildren.length > 0

    if (!isPartial) {
      setDecompositionOpen(prev => ({ ...prev, [i]: false }))
      setItemOpen(prev => ({ ...prev, [i]: false }))  // collapse on full success
    }

    patchItem(i, {
      status: isPartial ? 'partial' : 'complete',
      assembledFromChildren: true,
      isStale: false,
      parsedValue: { key: themeKey, value: assembledValue },
      missingChildren,
      failedChildren,
    })
  }

  // ── Child atom helpers ──────────────────────────────────────────────────────

  function patchChildAtom(i, childKey, patch) {
    setItemStates(prev => {
      const item = { ...ITEM_STATE_DEFAULT, ...(prev[i] || {}) }
      return {
        ...prev,
        [i]: {
          ...item,
          childAtoms: {
            ...(item.childAtoms || {}),
            [childKey]: {
              ...CHILD_ATOM_STATE_DEFAULT,
              ...(item.childAtoms?.[childKey] || {}),
              ...patch,
            },
          },
        },
      }
    })
  }

  async function handleGenerateChildAtom(i, structureItem, childKey) {
    if (!activeStage1Rev || !parsed) return
    patchChildAtom(i, childKey, { status: 'generating', parserError: null, rawResponse: null })

    const { messages } = buildHandoffChildAtomMessages(
      activeStage1Rev.contentSnapshot,
      bu,
      parsed.domainOfWork,
      smeLensState.parsedValue || null,
      structureItem,
      childKey,
      otherBuNames,
    )
    const { result, error } = await callAI(messages, { temperature: 0.3, maxTokens: 800 })

    if (error) {
      patchChildAtom(i, childKey, { status: 'failed', parserError: error, rawResponse: result ?? null })
      return
    }

    const p = parseHandoffChildAtomResponse(result, childKey)
    if (p.error) {
      patchChildAtom(i, childKey, { status: 'failed', rawResponse: result, parserError: p.error })
      return
    }

    patchChildAtom(i, childKey, { status: 'complete', rawResponse: result, parsedValue: p.value, parserError: null })
  }

  function handleAssembleItem(i, theme) {
    const iState = itemStates[i]
    if (!iState?.childAtoms) return

    const assembledValue = {}
    const missingChildren = []
    const failedChildren  = []

    CHILD_ATOM_KEYS.forEach(key => {
      const cs = iState.childAtoms[key]
      if (cs?.status === 'complete' && cs.parsedValue !== null) {
        assembledValue[key] = cs.parsedValue
      } else if (cs?.status === 'failed') {
        failedChildren.push(key)
      } else {
        missingChildren.push(key)
      }
    })

    if (!Object.keys(assembledValue).length) return

    const isPartial = missingChildren.length > 0 || failedChildren.length > 0

    const existingKey = iState.parsedValue?.key
    const derivedKey = existingKey || getThemeKey(theme)

    patchItem(i, {
      status: isPartial ? 'partial' : 'complete',
      assembledFromChildren: true,
      parsedValue: { key: derivedKey, value: assembledValue },
      missingChildren,
      failedChildren,
    })
    // Auto-collapse decomposition on full assembly
    if (!isPartial) {
      setDecompositionOpen(prev => ({ ...prev, [i]: false }))
    }
  }

  function handleAssembleBuHandoff() {
    if (!parsed?.handoffStructure) return
    const items = parsed.handoffStructure.map((theme, i) => {
      const iState = itemStates[i]
      return {
        key: getThemeKey(theme),
        label: getThemeLabel(theme),
        status: iState?.status || 'not_started',
        value: iState?.parsedValue?.value || null,
      }
    })
    const completedItems = items.filter(it => it.value !== null)
    if (!completedItems.length) return
    setBuHandoff({
      assembledAt: new Date().toISOString(),
      domainOfWork: parsed.domainOfWork,
      smeLens: smeLensState.parsedValue || null,
      items,
      completedCount: completedItems.length,
      totalCount: items.length,
    })
  }

  // ── Refine item helpers ─────────────────────────────────────────────────────

  function patchItemRefineUi(i, patch) {
    setItemRefineUi(prev => ({
      ...prev,
      [i]: { open: false, prompt: '', busy: false, error: null, ...(prev[i] || {}), ...patch },
    }))
  }

  function patchChildRefineUi(key, patch) {
    setChildRefineUi(prev => ({
      ...prev,
      [key]: { open: false, prompt: '', busy: false, error: null, ...(prev[key] || {}), ...patch },
    }))
  }

  async function handleRefineItem(i, structureItem) {
    const iState = itemStates[i]
    if (!iState?.parsedValue || !activeStage1Rev || !parsed) return
    const ui = itemRefineUi[i] || {}
    const prompt = ui.prompt?.trim()
    if (!prompt) return

    patchItemRefineUi(i, { busy: true, error: null })

    const { messages } = buildHandoffItemRefinementMessages(
      activeStage1Rev.contentSnapshot,
      bu,
      parsed.domainOfWork,
      smeLensState.parsedValue || null,
      structureItem,
      iState.parsedValue.value,
      prompt,
      otherBuNames,
    )
    const { result, error } = await callAI(messages, { temperature: 0.3, maxTokens: 1500 })

    if (error) {
      patchItemRefineUi(i, { busy: false, error })
      return
    }

    const p = parseHandoffItemResponse(result)
    if (p.error) {
      patchItemRefineUi(i, { busy: false, error: p.error })
      return
    }

    patchItem(i, { rawResponse: result, parsedValue: { key: p.key, value: p.value }, parserError: null })
    patchItemRefineUi(i, { busy: false, error: null, open: false, prompt: '' })
  }

  async function handleRefineChildAtom(i, structureItem, childKey) {
    const iState = itemStates[i]
    const cs = iState?.childAtoms?.[childKey]
    if (!cs?.parsedValue || !activeStage1Rev || !parsed) return
    const uiKey = `${i}/${childKey}`
    const ui = childRefineUi[uiKey] || {}
    const prompt = ui.prompt?.trim()
    if (!prompt) return

    patchChildRefineUi(uiKey, { busy: true, error: null })

    const { messages } = buildHandoffChildAtomRefinementMessages(
      activeStage1Rev.contentSnapshot,
      bu,
      parsed.domainOfWork,
      smeLensState.parsedValue || null,
      structureItem,
      childKey,
      cs.parsedValue,
      prompt,
      otherBuNames,
    )
    const { result, error } = await callAI(messages, { temperature: 0.3, maxTokens: 800 })

    if (error) {
      patchChildRefineUi(uiKey, { busy: false, error })
      return
    }

    const p = parseHandoffChildAtomResponse(result, childKey)
    if (p.error) {
      patchChildRefineUi(uiKey, { busy: false, error: p.error })
      return
    }

    patchChildAtom(i, childKey, { rawResponse: result, parsedValue: p.value, parserError: null })
    patchChildRefineUi(uiKey, { busy: false, error: null, open: false, prompt: '' })
  }

  // ── Derived status label ────────────────────────────────────────────────────

  const itemCount = parsed?.handoffStructure?.length ?? 0
  const doneCount = Object.values(itemStates).filter(s => s?.status === 'complete' || s?.status === 'partial').length

  function handoffStatusLabel() {
    if (!parsed) return 'Not started'
    if (itemCount === 0 || doneCount === 0) return 'Structure ready'
    if (doneCount === itemCount) return 'All items complete'
    return `${doneCount} / ${itemCount} items complete`
  }

  // ── Shared styles ───────────────────────────────────────────────────────────

  const disabledButtonStyle = {
    fontSize: 8, fontFamily: 'var(--fm)', fontWeight: 600,
    padding: '4px 8px', borderRadius: 4, cursor: 'not-allowed',
    background: 'var(--surface)', border: '1px solid var(--border)',
    color: 'var(--muted)', opacity: 0.58,
  }

  const Field = ({ label, value }) => (
    <div style={{
      padding: '7px 9px', border: '1px solid var(--border)',
      borderRadius: 4, background: 'rgba(255,255,255,.015)',
    }}>
      <div style={{
        fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)',
        textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 3,
      }}>
        {label}
      </div>
      <div style={{ fontSize: 10, color: value ? 'var(--text)' : 'var(--muted2)', fontFamily: 'var(--fm)', lineHeight: 1.55 }}>
        {value || 'Not generated yet'}
      </div>
    </div>
  )

  // ── Item value renderer (string | array | object) ───────────────────────────

  function renderItemValue(value, depth = 0) {
    if (typeof value === 'string') {
      return (
        <div style={{ fontSize: 10, color: 'var(--muted2)', fontFamily: 'var(--fm)', lineHeight: 1.6, marginTop: 4 }}>
          {value}
        </div>
      )
    }
    if (Array.isArray(value)) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
          {value.map((v, idx) => (
            <div key={idx} style={{ fontSize: 10, color: 'var(--muted2)', fontFamily: 'var(--fm)', lineHeight: 1.55 }}>
              · {typeof v === 'string' ? v : JSON.stringify(v)}
            </div>
          ))}
        </div>
      )
    }
    if (value && typeof value === 'object' && depth < 2) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 4 }}>
          {Object.entries(value).map(([k, v]) => (
            <div key={k}>
              <div style={{
                fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)',
                textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 1,
              }}>
                {k}
              </div>
              {renderItemValue(v, depth + 1)}
            </div>
          ))}
        </div>
      )
    }
    return null
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 10, fontSize: 9, fontFamily: 'var(--fm)', fontWeight: 600,
          padding: '6px 9px', borderRadius: 5, cursor: 'pointer',
          background: open ? 'rgba(59,130,246,.08)' : 'var(--s2)',
          border: `1px solid ${open ? 'rgba(59,130,246,.28)' : 'var(--border)'}`,
          color: open ? 'var(--accent)' : 'var(--muted)',
        }}
      >
        <span>Stage 3 Planning Handoff</span>
        <span style={{ fontSize: 8, color: 'var(--muted)' }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{
          marginTop: 8, padding: '10px 11px',
          background: 'rgba(59,130,246,.035)', border: '1px solid rgba(59,130,246,.14)', borderRadius: 6,
        }}>

          {/* ── Top metadata row ─────────────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 9 }}>
            <Field label="domainOfWork" value={parsed?.domainOfWork} />

            {/* SME lens field with inline refine */}
            <div style={{
              padding: '7px 9px', border: `1px solid ${smeLensState.status === 'failed' ? 'rgba(248,113,113,.35)' : 'var(--border)'}`,
              borderRadius: 4, background: 'rgba(255,255,255,.015)',
            }}>
              <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 3 }}>
                SMEReviewLens
              </div>

              {smeLensState.status === 'complete' && (
                <div style={{ fontSize: 10, color: 'var(--text)', fontFamily: 'var(--fm)', lineHeight: 1.55 }}>
                  {smeLensState.parsedValue}
                </div>
              )}
              {smeLensState.status === 'generating' && (
                <div style={{ fontSize: 10, color: 'var(--muted2)', fontFamily: 'var(--fm)' }}>Generating…</div>
              )}
              {smeLensState.status === 'failed' && (
                <div>
                  <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: '#f87171', lineHeight: 1.4, display: 'flex', gap: 4 }}>
                    <span style={{ flexShrink: 0 }}>⚠</span>
                    <span>{smeLensState.parserError}</span>
                  </div>
                  {smeLensState.rawResponse && (
                    <pre style={{
                      fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted2)',
                      background: 'var(--s2)', borderRadius: 3, padding: '4px 6px',
                      overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      maxHeight: 80, overflowY: 'auto', margin: '3px 0 0',
                    }}>
                      {smeLensState.rawResponse}
                    </pre>
                  )}
                </div>
              )}
              {smeLensState.status === 'not_started' && (
                <div style={{ fontSize: 10, color: 'var(--muted2)', fontFamily: 'var(--fm)' }}>Not generated yet</div>
              )}

              {/* Inline refine for SME lens */}
              {smeLensState.status === 'complete' && apiMode === 'ai' && (
                <div style={{ marginTop: 6 }}>
                  <button
                    onClick={() => setSmeLensRefineUi(p => ({ ...p, open: !p.open }))}
                    disabled={smeLensRefineUi.busy}
                    style={{
                      fontSize: 7, fontFamily: 'var(--fm)', fontWeight: 600,
                      padding: '1px 6px', borderRadius: 3,
                      cursor: smeLensRefineUi.busy ? 'not-allowed' : 'pointer',
                      background: smeLensRefineUi.open ? 'rgba(59,130,246,.1)' : 'transparent',
                      border: `1px solid ${smeLensRefineUi.open ? 'rgba(59,130,246,.3)' : 'var(--border)'}`,
                      color: smeLensRefineUi.open ? 'var(--accent)' : 'var(--muted)',
                      opacity: smeLensRefineUi.busy ? 0.5 : 1,
                    }}
                  >
                    ↻ Refine {smeLensRefineUi.open ? '▲' : '▼'}
                  </button>
                  {smeLensRefineUi.open && (
                    <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <textarea
                        value={smeLensRefineUi.prompt}
                        onChange={e => setSmeLensRefineUi(p => ({ ...p, prompt: e.target.value }))}
                        rows={2}
                        disabled={smeLensRefineUi.busy}
                        placeholder="Refinement instruction…"
                        style={{
                          width: '100%', boxSizing: 'border-box',
                          fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--text)',
                          background: 'var(--surface)', border: '1px solid var(--border)',
                          borderRadius: 3, padding: '4px 6px', resize: 'vertical', outline: 'none',
                          lineHeight: 1.5, opacity: smeLensRefineUi.busy ? 0.5 : 1,
                        }}
                      />
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <button
                          onClick={handleRefineSmeLens}
                          disabled={smeLensRefineUi.busy || !smeLensRefineUi.prompt.trim()}
                          style={{
                            fontSize: 7, fontFamily: 'var(--fm)', fontWeight: 600,
                            padding: '2px 7px', borderRadius: 3,
                            cursor: (smeLensRefineUi.busy || !smeLensRefineUi.prompt.trim()) ? 'not-allowed' : 'pointer',
                            background: 'rgba(59,130,246,.12)',
                            border: '1px solid rgba(59,130,246,.3)',
                            color: 'var(--accent)',
                            opacity: (smeLensRefineUi.busy || !smeLensRefineUi.prompt.trim()) ? 0.5 : 1,
                          }}
                        >
                          {smeLensRefineUi.busy ? 'Refining…' : 'Apply'}
                        </button>
                        {smeLensRefineUi.error && (
                          <span style={{ fontSize: 7, fontFamily: 'var(--fm)', color: '#f87171', lineHeight: 1.4 }}>
                            ⚠ {smeLensRefineUi.error}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── Stale structure warning ──────────────────────────── */}
          {structureIsStale && parsed?.handoffStructure && (
            <div style={{
              marginBottom: 8, padding: '6px 9px', borderRadius: 4,
              background: 'rgba(251,146,60,.07)', border: '1px solid rgba(251,146,60,.3)',
              fontSize: 9, fontFamily: 'var(--fm)', color: '#fb923c', lineHeight: 1.5,
              display: 'flex', gap: 6, alignItems: 'flex-start',
            }}>
              <span style={{ flexShrink: 0 }}>⚠</span>
              <span>SME lens changed — regenerate the handoff structure to align with the updated lens.</span>
            </div>
          )}

          {/* ── handoffStructure + per-item generation ───────────── */}
          <div style={{
            padding: '7px 9px', border: '1px solid var(--border)',
            borderRadius: 4, background: 'rgba(255,255,255,.015)', marginBottom: 8,
          }}>
            <div style={{
              fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)',
              textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6,
            }}>
              handoffStructure &amp; items
            </div>

            {parsed?.handoffStructure ? (() => {
              const canGenItemBase = apiMode === 'ai' && !!activeStage1Rev && !!parsed.domainOfWork && !isGenerating
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {parsed.handoffStructure.map((theme, i) => {
                    const iState = itemStates[i] || ITEM_STATE_DEFAULT
                    const isGenItem = iState.status === 'generating'
                    const canGenItem = canGenItemBase && !isGenItem

                    const assembled = iState.assembledFromChildren &&
                      (iState.status === 'complete' || iState.status === 'partial')
                    const isPartial = iState.status === 'partial'

                    const borderColor =
                      assembled && isPartial         ? 'rgba(251,146,60,.45)'  :
                      assembled                      ? 'rgba(139,92,246,.45)'  :
                      iState.status === 'complete'   ? 'rgba(0,229,180,.45)'   :
                      iState.status === 'failed'     ? 'rgba(248,113,113,.45)' :
                      isGenItem                      ? 'rgba(59,130,246,.55)'  :
                                                       'rgba(59,130,246,.22)'

                    const btnBg =
                      iState.status === 'failed'   ? 'rgba(248,113,113,.1)'  :
                      assembled && isPartial       ? 'rgba(251,146,60,.1)'   :
                      assembled                    ? 'rgba(139,92,246,.1)'   :
                      iState.status === 'complete' ? 'rgba(0,229,180,.08)'   :
                      canGenItem                   ? 'rgba(59,130,246,.1)'   : 'var(--surface)'

                    const btnBorder =
                      iState.status === 'failed'   ? 'rgba(248,113,113,.35)' :
                      assembled && isPartial       ? 'rgba(251,146,60,.35)'  :
                      assembled                    ? 'rgba(139,92,246,.3)'   :
                      iState.status === 'complete' ? 'rgba(0,229,180,.3)'    :
                      canGenItem                   ? 'rgba(59,130,246,.3)'   : 'var(--border)'

                    const btnColor =
                      iState.status === 'failed'   ? '#f87171'        :
                      assembled && isPartial       ? '#fb923c'        :
                      assembled                    ? '#a78bfa'        :
                      iState.status === 'complete' ? '#00e5b4'        :
                      canGenItem                   ? 'var(--accent)'  : 'var(--muted)'

                    const genDoneCount = isGenItem && iState.childAtoms
                      ? Object.values(iState.childAtoms).filter(cs => cs?.status === 'complete' || cs?.status === 'failed').length
                      : null

                    const btnLabel =
                      isGenItem                                        ? `Generating… ${genDoneCount !== null ? `(${genDoneCount}/${CHILD_ATOM_KEYS.length})` : ''}`.trim() :
                      iState.status === 'complete' || isPartial       ? '↻ Regenerate item' :
                      iState.status === 'failed'                       ? 'Retry item'        :
                                                                         'Generate item'

                    const canAssemble = !!(iState.childAtoms &&
                      Object.values(iState.childAtoms).some(cs => cs?.status === 'complete'))

                    const isItemOpen = isGenItem || iState.status === 'failed' || !!itemOpen[i]

                    return (
                      <div key={i} style={{ paddingLeft: 8, borderLeft: `2px solid ${borderColor}` }}>
                        {/* Theme row */}
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                          <div style={{ flex: 1, fontSize: 10, color: 'var(--muted2)', fontFamily: 'var(--fm)', lineHeight: 1.55 }}>
                            {getThemeLabel(theme)}
                            {iState.isStale && (
                              <span style={{ marginLeft: 5, fontSize: 7, fontFamily: 'var(--fm)', color: '#fb923c', opacity: .85, fontWeight: 600 }}>
                                STALE
                              </span>
                            )}
                            {assembled && isPartial && !iState.isStale && (
                              <span style={{ marginLeft: 5, fontSize: 8, fontFamily: 'var(--fm)', color: '#fb923c', opacity: .85 }}>
                                partial
                              </span>
                            )}
                            {assembled && !isPartial && !iState.isStale && (
                              <span style={{ marginLeft: 5, fontSize: 8, fontFamily: 'var(--fm)', color: '#a78bfa', opacity: .8 }}>
                                assembled
                              </span>
                            )}
                          </div>
                          {(iState.status === 'complete' || iState.status === 'partial') && (
                            <button
                              onClick={() => setItemOpen(prev => ({ ...prev, [i]: !prev[i] }))}
                              style={{
                                flexShrink: 0, fontSize: 8, fontFamily: 'var(--fm)',
                                padding: '1px 5px', borderRadius: 3, cursor: 'pointer',
                                background: 'transparent', border: '1px solid var(--border)',
                                color: 'var(--muted)',
                              }}
                            >
                              {isItemOpen ? '▲' : '▼'}
                            </button>
                          )}
                          <button
                            onClick={() => handleGenerateItem(i, theme)}
                            disabled={!canGenItem}
                            style={{
                              flexShrink: 0, fontSize: 8, fontFamily: 'var(--fm)', fontWeight: 600,
                              padding: '2px 7px', borderRadius: 3,
                              cursor: canGenItem ? 'pointer' : 'not-allowed',
                              background: btnBg, border: `1px solid ${btnBorder}`, color: btnColor,
                              opacity: !canGenItem && !isGenItem ? 0.5 : 1,
                            }}
                          >
                            {btnLabel}
                          </button>
                        </div>

                        {/* Generated value — direct or assembled (complete/partial) */}
                        {isItemOpen && (iState.status === 'complete' || iState.status === 'partial') && iState.parsedValue && (
                          <div style={{ paddingLeft: 4 }}>
                            {isPartial && (
                              <div style={{ marginBottom: 5 }}>
                                <div style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#fb923c', lineHeight: 1.55 }}>
                                  ⚠ Partial assembly
                                  {iState.missingChildren?.length > 0 && (
                                    <span> · not generated: {iState.missingChildren.join(', ')}</span>
                                  )}
                                  {iState.failedChildren?.length > 0 && (
                                    <span> · failed: {iState.failedChildren.join(', ')}</span>
                                  )}
                                </div>
                              </div>
                            )}
                            {renderItemValue(iState.parsedValue.value)}

                            {/* UX Fix B — Refine handoff item */}
                            {apiMode === 'ai' && (() => {
                              const rui = itemRefineUi[i] || {}
                              return (
                                <div style={{ marginTop: 6 }}>
                                  <button
                                    onClick={() => patchItemRefineUi(i, { open: !rui.open })}
                                    disabled={rui.busy}
                                    style={{
                                      fontSize: 8, fontFamily: 'var(--fm)', fontWeight: 600,
                                      padding: '2px 7px', borderRadius: 3,
                                      cursor: rui.busy ? 'not-allowed' : 'pointer',
                                      background: rui.open ? 'rgba(59,130,246,.1)' : 'transparent',
                                      border: `1px solid ${rui.open ? 'rgba(59,130,246,.3)' : 'var(--border)'}`,
                                      color: rui.open ? 'var(--accent)' : 'var(--muted)',
                                      opacity: rui.busy ? 0.5 : 1,
                                    }}
                                  >
                                    ↻ Refine item {rui.open ? '▲' : '▼'}
                                  </button>
                                  {rui.open && (
                                    <div style={{ marginTop: 5, display: 'flex', flexDirection: 'column', gap: 4 }}>
                                      <textarea
                                        value={rui.prompt || ''}
                                        onChange={e => patchItemRefineUi(i, { prompt: e.target.value })}
                                        rows={2}
                                        disabled={rui.busy}
                                        placeholder="Refinement instruction…"
                                        style={{
                                          width: '100%', boxSizing: 'border-box',
                                          fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--text)',
                                          background: 'var(--surface)', border: '1px solid var(--border)',
                                          borderRadius: 3, padding: '5px 7px', resize: 'vertical', outline: 'none',
                                          lineHeight: 1.5, opacity: rui.busy ? 0.5 : 1,
                                        }}
                                      />
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <button
                                          onClick={() => handleRefineItem(i, theme)}
                                          disabled={rui.busy || !(rui.prompt?.trim())}
                                          style={{
                                            fontSize: 8, fontFamily: 'var(--fm)', fontWeight: 600,
                                            padding: '2px 8px', borderRadius: 3,
                                            cursor: (rui.busy || !(rui.prompt?.trim())) ? 'not-allowed' : 'pointer',
                                            background: 'rgba(59,130,246,.12)',
                                            border: '1px solid rgba(59,130,246,.3)',
                                            color: 'var(--accent)',
                                            opacity: (rui.busy || !(rui.prompt?.trim())) ? 0.5 : 1,
                                          }}
                                        >
                                          {rui.busy ? 'Refining…' : 'Apply refinement'}
                                        </button>
                                        {rui.error && (
                                          <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#f87171', lineHeight: 1.4 }}>
                                            ⚠ {rui.error}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )
                            })()}
                          </div>
                        )}

                        {/* Per-item error + raw + decompose trigger */}
                        {isItemOpen && iState.status === 'failed' && (
                          <div style={{ marginTop: 4 }}>
                            <div style={{
                              display: 'flex', gap: 4, fontSize: 9, fontFamily: 'var(--fm)',
                              color: '#f87171', lineHeight: 1.5,
                            }}>
                              <span style={{ flexShrink: 0 }}>⚠</span>
                              <span>{iState.parserError}</span>
                            </div>
                            {iState.rawResponse && (
                              <pre style={{
                                fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted2)',
                                background: 'var(--s2)', borderRadius: 4, padding: '6px 8px',
                                overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                                maxHeight: 120, overflowY: 'auto', margin: '4px 0 0',
                              }}>
                                {iState.rawResponse}
                              </pre>
                            )}
                          </div>
                        )}

                        {/* UX Fix C — toggle for decomposition after full assembly */}
                        {isItemOpen && assembled && !isPartial && iState.isDecomposed && (
                          <button
                            onClick={() => setDecompositionOpen(prev => ({ ...prev, [i]: !prev[i] }))}
                            style={{
                              marginTop: 5, fontSize: 8, fontFamily: 'var(--fm)', fontWeight: 600,
                              padding: '2px 7px', borderRadius: 3, cursor: 'pointer',
                              background: 'transparent',
                              border: '1px solid var(--border)',
                              color: 'var(--muted)',
                            }}
                          >
                            {decompositionOpen[i] ? '▲ Hide generation details' : '▼ Show generation details'}
                          </button>
                        )}

                        {/* Child atoms — shown if isDecomposed AND (partial/not-assembled OR toggle open) */}
                        {isItemOpen && iState.isDecomposed && iState.childAtoms && (assembled && !isPartial ? decompositionOpen[i] : true) && (
                          <div style={{
                            marginTop: 7, padding: '8px 9px',
                            background: 'rgba(139,92,246,.04)',
                            border: '1px solid rgba(139,92,246,.18)',
                            borderRadius: 5,
                          }}>
                            <div style={{
                              fontSize: 8, fontFamily: 'var(--fm)', color: 'rgba(167,139,250,.8)',
                              textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 7,
                            }}>
                              Generation details
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {CHILD_ATOM_KEYS.map(childKey => {
                                const cs = iState.childAtoms[childKey] || CHILD_ATOM_STATE_DEFAULT
                                const isGenChild = cs.status === 'generating'
                                const canGenChild = canGenItemBase && !isGenItem && !isGenChild

                                const childBtnLabel =
                                  isGenChild               ? 'Generating…' :
                                  cs.status === 'complete' ? '↻'           :
                                  cs.status === 'failed'   ? 'Retry'       :
                                                             'Generate'

                                const childBtnColor =
                                  cs.status === 'failed'   ? '#f87171'           :
                                  cs.status === 'complete' ? '#00e5b4'           :
                                  canGenChild              ? '#a78bfa'           : 'var(--muted)'

                                const childBtnBorder =
                                  cs.status === 'failed'   ? 'rgba(248,113,113,.35)' :
                                  cs.status === 'complete' ? 'rgba(0,229,180,.3)'    :
                                  canGenChild              ? 'rgba(139,92,246,.35)'  : 'var(--border)'

                                const cuiKey = `${i}/${childKey}`
                                const crui = childRefineUi[cuiKey] || {}

                                return (
                                  <div key={childKey}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                      <div style={{
                                        flex: 1, fontSize: 9, fontFamily: 'var(--fm)',
                                        color: cs.status === 'complete' ? 'var(--text)' : 'var(--muted)',
                                        lineHeight: 1.4,
                                      }}>
                                        {childKey}
                                      </div>
                                      <button
                                        onClick={() => handleGenerateChildAtom(i, theme, childKey)}
                                        disabled={!canGenChild}
                                        style={{
                                          flexShrink: 0, fontSize: 8, fontFamily: 'var(--fm)', fontWeight: 600,
                                          padding: '2px 6px', borderRadius: 3,
                                          cursor: canGenChild ? 'pointer' : 'not-allowed',
                                          background: cs.status === 'failed'   ? 'rgba(248,113,113,.08)' :
                                                      cs.status === 'complete' ? 'rgba(0,229,180,.06)'   :
                                                      canGenChild              ? 'rgba(139,92,246,.1)'   : 'var(--surface)',
                                          border: `1px solid ${childBtnBorder}`,
                                          color: childBtnColor,
                                          opacity: !canGenChild && !isGenChild ? 0.5 : 1,
                                        }}
                                      >
                                        {childBtnLabel}
                                      </button>
                                    </div>

                                    {cs.status === 'complete' && cs.parsedValue !== null && (
                                      <div style={{ paddingLeft: 10, marginTop: 2 }}>
                                        {renderItemValue(cs.parsedValue)}

                                        {/* UX Fix A — Refine child atom */}
                                        {apiMode === 'ai' && (
                                          <div style={{ marginTop: 4 }}>
                                            <button
                                              onClick={() => patchChildRefineUi(cuiKey, { open: !crui.open })}
                                              disabled={crui.busy}
                                              style={{
                                                fontSize: 7, fontFamily: 'var(--fm)', fontWeight: 600,
                                                padding: '1px 6px', borderRadius: 3,
                                                cursor: crui.busy ? 'not-allowed' : 'pointer',
                                                background: crui.open ? 'rgba(0,229,180,.07)' : 'transparent',
                                                border: `1px solid ${crui.open ? 'rgba(0,229,180,.25)' : 'var(--border)'}`,
                                                color: crui.open ? '#00e5b4' : 'var(--muted)',
                                                opacity: crui.busy ? 0.5 : 1,
                                              }}
                                            >
                                              ↻ Refine {crui.open ? '▲' : '▼'}
                                            </button>
                                            {crui.open && (
                                              <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
                                                <textarea
                                                  value={crui.prompt || ''}
                                                  onChange={e => patchChildRefineUi(cuiKey, { prompt: e.target.value })}
                                                  rows={2}
                                                  disabled={crui.busy}
                                                  placeholder="Refinement instruction…"
                                                  style={{
                                                    width: '100%', boxSizing: 'border-box',
                                                    fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--text)',
                                                    background: 'var(--surface)', border: '1px solid var(--border)',
                                                    borderRadius: 3, padding: '4px 6px', resize: 'vertical', outline: 'none',
                                                    lineHeight: 1.5, opacity: crui.busy ? 0.5 : 1,
                                                  }}
                                                />
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                                  <button
                                                    onClick={() => handleRefineChildAtom(i, theme, childKey)}
                                                    disabled={crui.busy || !(crui.prompt?.trim())}
                                                    style={{
                                                      fontSize: 7, fontFamily: 'var(--fm)', fontWeight: 600,
                                                      padding: '2px 7px', borderRadius: 3,
                                                      cursor: (crui.busy || !(crui.prompt?.trim())) ? 'not-allowed' : 'pointer',
                                                      background: 'rgba(0,229,180,.08)',
                                                      border: '1px solid rgba(0,229,180,.25)',
                                                      color: '#00e5b4',
                                                      opacity: (crui.busy || !(crui.prompt?.trim())) ? 0.5 : 1,
                                                    }}
                                                  >
                                                    {crui.busy ? 'Refining…' : 'Apply'}
                                                  </button>
                                                  {crui.error && (
                                                    <span style={{ fontSize: 7, fontFamily: 'var(--fm)', color: '#f87171', lineHeight: 1.4 }}>
                                                      ⚠ {crui.error}
                                                    </span>
                                                  )}
                                                </div>
                                              </div>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    )}

                                    {cs.status === 'failed' && (
                                      <div style={{ marginTop: 3, paddingLeft: 10 }}>
                                        <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: '#f87171', lineHeight: 1.4 }}>
                                          ⚠ {cs.parserError}
                                        </div>
                                        {cs.rawResponse && (
                                          <pre style={{
                                            fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted2)',
                                            background: 'var(--s2)', borderRadius: 3, padding: '4px 6px',
                                            overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                                            maxHeight: 80, overflowY: 'auto', margin: '3px 0 0',
                                          }}>
                                            {cs.rawResponse}
                                          </pre>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                )
                              })}
                            </div>

                            {canAssemble && (
                              <button
                                onClick={() => handleAssembleItem(i, theme)}
                                style={{
                                  marginTop: 9, fontSize: 8, fontFamily: 'var(--fm)', fontWeight: 600,
                                  padding: '4px 9px', borderRadius: 4, cursor: 'pointer',
                                  background: 'rgba(139,92,246,.14)',
                                  border: '1px solid rgba(139,92,246,.35)',
                                  color: '#a78bfa',
                                }}
                              >
                                Assemble item from child atoms
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })() : (
              <div style={{ fontSize: 10, color: 'var(--muted2)', fontFamily: 'var(--fm)', lineHeight: 1.55 }}>
                Generate handoff structure first.
              </div>
            )}
          </div>

          {/* ── handoffStatus ────────────────────────────────────── */}
          <div style={{ marginBottom: 9 }}>
            <Field label="handoffStatus" value={handoffStatusLabel()} />
          </div>

          {/* ── Structure-level error ────────────────────────────── */}
          {genError && (
            <div style={{
              marginBottom: 8, fontSize: 9, fontFamily: 'var(--fm)',
              color: '#f87171', lineHeight: 1.6, padding: '6px 9px', borderRadius: 4,
              background: 'rgba(248,113,113,.07)', border: '1px solid rgba(248,113,113,.25)',
            }}>
              <div style={{ display: 'flex', gap: 5, marginBottom: structureRaw ? 5 : 0 }}>
                <span style={{ flexShrink: 0 }}>⚠</span>
                <span>{genError}</span>
              </div>
              {structureRaw && (
                <pre style={{
                  fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted2)',
                  background: 'var(--s2)', borderRadius: 4, padding: '8px 10px',
                  overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  maxHeight: 160, overflowY: 'auto', margin: 0,
                }}>
                  {structureRaw}
                </pre>
              )}
            </div>
          )}

          {/* ── Action buttons — SME lens → structure → assemble ─── */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {/* 1. Generate SME lens */}
            {(() => {
              const isGenLens = smeLensState.status === 'generating'
              const canGenLens = apiMode === 'ai' && !!activeStage1Rev && !isGenLens
              const lensLabel =
                isGenLens                            ? 'Generating…'           :
                smeLensState.status === 'complete'   ? '↻ Regenerate SME lens' :
                smeLensState.status === 'failed'     ? 'Retry SME lens'        :
                                                       'Generate SME lens'
              return (
                <button
                  onClick={handleGenerateSmeLens}
                  disabled={!canGenLens}
                  style={{
                    fontSize: 8, fontFamily: 'var(--fm)', fontWeight: 600,
                    padding: '4px 8px', borderRadius: 4,
                    cursor: canGenLens ? 'pointer' : 'not-allowed',
                    background: smeLensState.status === 'failed'   ? 'rgba(248,113,113,.1)' :
                                smeLensState.status === 'complete' ? 'rgba(0,229,180,.08)'  :
                                canGenLens                         ? 'rgba(59,130,246,.12)' : 'var(--surface)',
                    border: `1px solid ${
                      smeLensState.status === 'failed'   ? 'rgba(248,113,113,.35)' :
                      smeLensState.status === 'complete' ? 'rgba(0,229,180,.3)'    :
                      canGenLens                         ? 'rgba(59,130,246,.35)'  : 'var(--border)'
                    }`,
                    color: smeLensState.status === 'failed'   ? '#f87171'       :
                           smeLensState.status === 'complete' ? '#00e5b4'       :
                           canGenLens                         ? 'var(--accent)' : 'var(--muted)',
                    opacity: canGenLens ? 1 : 0.58,
                  }}
                >
                  {lensLabel}
                </button>
              )
            })()}

            {/* 2. Generate handoff structure (requires SME lens) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <button
                onClick={handleGenerateHandoffStructure}
                disabled={!canGenStructure}
                style={{
                  fontSize: 8, fontFamily: 'var(--fm)', fontWeight: 600,
                  padding: '4px 8px', borderRadius: 4,
                  cursor: canGenStructure ? 'pointer' : 'not-allowed',
                  background: canGenStructure ? 'rgba(59,130,246,.12)' : 'var(--surface)',
                  border: `1px solid ${canGenStructure ? 'rgba(59,130,246,.35)' : 'var(--border)'}`,
                  color: canGenStructure ? 'var(--accent)' : 'var(--muted)',
                  opacity: canGenStructure ? 1 : 0.58,
                }}
              >
                {isGenerating ? 'Generating…' : parsed ? '↻ Regenerate handoff structure' : 'Generate handoff structure'}
              </button>
              {!hasSmeLens && apiMode === 'ai' && (
                <div style={{ fontSize: 7, fontFamily: 'var(--fm)', color: 'var(--muted)', paddingLeft: 1 }}>
                  Generate SME lens first
                </div>
              )}
            </div>

            {/* 3. Assemble BU handoff */}
            {(() => {
              const canAssembleBu = !!parsed?.handoffStructure && doneCount > 0
              return (
                <button
                  onClick={handleAssembleBuHandoff}
                  disabled={!canAssembleBu}
                  style={{
                    fontSize: 8, fontFamily: 'var(--fm)', fontWeight: 600,
                    padding: '4px 8px', borderRadius: 4,
                    cursor: canAssembleBu ? 'pointer' : 'not-allowed',
                    background: buHandoff     ? 'rgba(0,229,180,.08)'  :
                                canAssembleBu ? 'rgba(139,92,246,.12)' : 'var(--surface)',
                    border: `1px solid ${
                      buHandoff     ? 'rgba(0,229,180,.3)'    :
                      canAssembleBu ? 'rgba(139,92,246,.35)'  : 'var(--border)'
                    }`,
                    color: buHandoff     ? '#00e5b4'  :
                           canAssembleBu ? '#a78bfa'  : 'var(--muted)',
                    opacity: canAssembleBu ? 1 : 0.58,
                  }}
                >
                  {buHandoff ? '↻ Re-assemble BU handoff' : 'Assemble BU handoff'}
                </button>
              )
            })()}
          </div>

          {/* ── Assembled BU handoff summary ─────────────────────── */}
          {buHandoff && (
            <div style={{
              marginTop: 9, padding: '8px 10px', borderRadius: 5,
              background: 'rgba(0,229,180,.04)', border: '1px solid rgba(0,229,180,.2)',
            }}>
              <div style={{
                fontSize: 8, fontFamily: 'var(--fm)', color: '#00e5b4',
                textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6,
              }}>
                BU Handoff — {buHandoff.completedCount}/{buHandoff.totalCount} items assembled
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {buHandoff.items.map(item => (
                  <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{
                      fontSize: 7, fontFamily: 'var(--fm)', fontWeight: 600,
                      color: item.value ? '#00e5b4' : 'var(--muted)',
                    }}>
                      {item.value ? '✓' : '○'}
                    </span>
                    <span style={{ fontSize: 9, fontFamily: 'var(--fm)', color: item.value ? 'var(--text)' : 'var(--muted2)', lineHeight: 1.4 }}>
                      {item.label}
                    </span>
                    {item.status === 'partial' && (
                      <span style={{ fontSize: 7, fontFamily: 'var(--fm)', color: '#fb923c' }}>partial</span>
                    )}
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 5, fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', opacity: .7 }}>
                Assembled {new Date(buHandoff.assembledAt).toLocaleString()}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

async function collectStage2LearningSignals(context, useAI) {
  const heuristic = deriveLearningSignals({ stage: 'Stage 2', ...context })
  if (!useAI) return heuristic
  const { messages } = buildLearningSignalMessages({ stage: 'Stage 2', ...context })
  const { result } = await callAI(messages, { temperature: 0.2, maxTokens: 900, timeoutMs: 15000 })
  return normalizeLearningSignals([...heuristic, ...parseLearningSignalResponse(result, 'Stage 2')], 'Stage 2')
}

// ── Refinement scope options (shared Stage 2 + Stage 3) ──────────────────────

export const REFINEMENT_SCOPES = [
  { value: 'auto',      label: 'auto-detect'       },
  { value: 'wording',   label: 'wording only'       },
  { value: 'ownership', label: 'ownership / emphasis' },
  { value: 'cross-fn',  label: 'cross-functional'   },
  { value: 'execution', label: 'execution plan'     },
  { value: 'kpi',       label: 'KPIs / metrics'     },
]

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

// ── Business unit card ────────────────────────────────────────────────────────
// onRefineUnit: async (prompt: string, impact: string, scope: string) => { error: string|null }
// apiMode:      'ai' | 'mock'
// globalBusy:   true while a parent-level generation is running

function BUCard({ bu, index, onRefineUnit, apiMode, globalBusy, activeStage1Rev, otherBuNames, workspaceId }) {
  const [open,          setOpen]          = useState(true)
  const [refineOpen,    setRefineOpen]    = useState(false)
  const [refinePrompt,  setRefinePrompt]  = useState('')
  const [refineImpact,  setRefineImpact]  = useState('')
  const [refineScope,   setRefineScope]   = useState('auto')
  const [isRefining,    setIsRefining]    = useState(false)
  const [refineError,   setRefineError]   = useState(null)
  const [refineDone,    setRefineDone]    = useState(false)

  const ls = levelStyle(bu.involvementLevel)

  const canRefine  = apiMode === 'ai' && refinePrompt.trim().length > 0 && !isRefining && !globalBusy
  const aiDisabled = apiMode !== 'ai'

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
          background: open ? 'transparent' : 'rgba(255,255,255,.01)',
        }}
      >
        <span style={{
          flexShrink: 0,
          width: 22, height: 22, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 9, fontFamily: 'var(--fm)', fontWeight: 700,
          background: `${ls.color}18`, border: `1px solid ${ls.color}30`,
          color: ls.color,
        }}>
          {index + 1}
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, flex: 1, color: 'var(--text)' }}>
          {bu.name}
        </span>
        {refineDone && (
          <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: '#00e5b4', flexShrink: 0 }}>
            ✓ Updated
          </span>
        )}
        <Badge color={ls.color}>{bu.involvementLevel}</Badge>
        {bu.strategicInvolvement && (
          <span style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {bu.strategicInvolvement}
          </span>
        )}
        <span style={{ fontSize: 9, color: 'var(--muted)', flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </div>

      {/* Card body */}
      {open && (
        <div style={{ padding: '13px 14px' }}>
          {bu.purpose && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 3 }}>
                Purpose
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted2)', lineHeight: 1.7 }}>{bu.purpose}</div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
            <SubList label="Key Responsibilities" items={bu.keyResponsibilities} borderColor="rgba(59,130,246,.4)"  />
            <SubList label="Dependencies"         items={bu.dependencies}        borderColor="rgba(139,92,246,.4)"  />
            <SubList label="Risks & Unknowns"     items={bu.risksAndUnknowns}    borderColor="rgba(248,113,113,.45)" />
            <SubList label="Key Success Metrics"  items={bu.keySuccessMetrics}   borderColor="rgba(0,229,180,.4)"   />
          </div>

          <Stage3HandoffShell bu={bu} otherBuNames={otherBuNames} activeStage1Rev={activeStage1Rev} apiMode={apiMode} workspaceId={workspaceId} />

          {/* ── Unit-level refinement panel ───────────────────────────────── */}
          <div style={{
            marginTop: 10,
            borderTop: '1px solid var(--border)',
            paddingTop: 10,
          }}>
            {/* Toggle row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
                ↻ Refine this unit {refineOpen ? '▲' : '▼'}
              </button>
              {aiDisabled && (
                <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
                  Requires API key
                </span>
              )}
            </div>

            {/* Refinement fields */}
            {refineOpen && (
              <div style={{
                marginTop: 10,
                background: 'var(--s2)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '12px 12px 10px',
              }}>
                {/* Refinement prompt */}
                <div style={{ marginBottom: 10 }}>
                  <div style={{
                    fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)',
                    textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4,
                  }}>
                    Refinement instruction <span style={{ color: '#f87171' }}>*</span>
                  </div>
                  <textarea
                    value={refinePrompt}
                    onChange={e => setRefinePrompt(e.target.value)}
                    rows={3}
                    disabled={aiDisabled || isRefining}
                    placeholder={`e.g. ${bu.name} is the primary client-facing channel — they introduce the offering to clients, need enablement and consistent messaging, and own the field feedback loop.`}
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

                {/* Refinement scope */}
                <ScopeSelector
                  value={refineScope}
                  onChange={setRefineScope}
                  disabled={aiDisabled || isRefining}
                />

                {/* Impact summary */}
                <div style={{ marginBottom: 10 }}>
                  <div style={{
                    fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)',
                    textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4,
                  }}>
                    Impact summary <span style={{ opacity: .5 }}>(optional)</span>
                  </div>
                  <textarea
                    value={refineImpact}
                    onChange={e => setRefineImpact(e.target.value)}
                    rows={2}
                    disabled={aiDisabled || isRefining}
                    placeholder="e.g. Elevates compliance to primary — now blocks pilot launch without sign-off."
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

                {/* Actions row */}
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
                    {isRefining ? 'Regenerating…' : 'Regenerate this unit'}
                  </button>
                  {!canRefine && !isRefining && !aiDisabled && (
                    <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
                      Enter an instruction to regenerate.
                    </span>
                  )}
                  {isRefining && (
                    <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
                      Regenerating "{bu.name}" — preserving all other units…
                    </span>
                  )}
                </div>

                {/* Inline error */}
                {refineError && (
                  <div style={{
                    marginTop: 8, fontSize: 9, fontFamily: 'var(--fm)',
                    color: '#f87171', lineHeight: 1.6,
                    padding: '6px 9px', borderRadius: 4,
                    background: 'rgba(248,113,113,.07)',
                    border: '1px solid rgba(248,113,113,.25)',
                    display: 'flex', gap: 5,
                  }}>
                    <span style={{ flexShrink: 0 }}>⚠</span>
                    <span>{refineError}</span>
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

// ── Main Stage 2 view ─────────────────────────────────────────────────────────

export default function Stage2View({
  workspace,
  stage1Revisions,
  stage1ActiveId,
  stage2Revisions,
  stage2ActiveId,
  onSaveRevision,           // (revisionRecord) => void   — receives pre-built record
  onNavigateToStage3,
  onRegenerateAndGoToStage3,// () => void — navigate + trigger Stage 3 regeneration
  stage3IsStale,            // boolean — Stage 3 stale relative to current Stage 2
  stage3HasRevisions,       // boolean — Stage 3 has at least one revision
  shouldAutoGenerate,       // boolean — set by Stage 1 "Regenerate & View Stage 2" CTA
  onAutoGenerateComplete,   // () => void — clears the flag after we consume it
}) {
  const [isGenerating,   setIsGenerating]   = useState(false)
  const [genError,       setGenError]       = useState(null)
  const [rawResponse,    setRawResponse]    = useState(null)  // shown on parse fail
  const [showRaw,        setShowRaw]        = useState(false)
  const [compareRevId,   setCompareRevId]   = useState(null)
  const [isStageRefining,setIsStageRefining]= useState(false)

  // ── Derived state ───────────────────────────────────────────────────────────
  const activeRev     = stage2Revisions.find(r => r.id === stage2ActiveId) ?? null
  const businessUnits = orderBusinessUnits(activeRev?.contentSnapshot?.businessUnits || [])
  const summaryNote   = activeRev?.contentSnapshot?.summaryNote   || ''

  // Staleness: latest Stage 2 rev was generated from a different Stage 1 rev
  const latestStage2  = [...stage2Revisions].sort((a, b) => b.revisionNumber - a.revisionNumber)[0]
  const isStale       = !!(latestStage2 && latestStage2.sourceBasisRevisionId !== stage1ActiveId)

  // Active Stage 1 revision object (for snapshot access)
  const activeStage1Rev = stage1Revisions.find(r => r.id === stage1ActiveId) ?? null

  // Compare revision objects for diff viewer
  const compareRevision = compareRevId ? stage2Revisions.find(r => r.id === compareRevId) ?? null : null
  const apiMode = getApiMode()   // 'ai' | 'mock'

  // ── Auto-generate when triggered from Stage 1 "Regenerate & View" CTA ───────
  // Guards against React StrictMode's double-invocation of effects in development:
  // the ref is set on first consumption and only resets when the flag clears,
  // preventing two concurrent handleGenerate() calls (which would produce two
  // revisions with the same revisionNumber).
  const autoGenConsumedRef = useRef(false)

  useEffect(() => {
    // Flag cleared — reset the guard so the next trigger works
    if (!shouldAutoGenerate) {
      autoGenConsumedRef.current = false
      return
    }
    // Already consumed this trigger (or no Stage 1 revision available)
    if (!activeStage1Rev || autoGenConsumedRef.current) return

    autoGenConsumedRef.current = true   // mark consumed before async work
    onAutoGenerateComplete?.()          // clear the prop flag
    handleGenerate()
    // handleGenerate is a stable useCallback; eslint would warn about missing dep
    // but including it would cause infinite loops — intentional omission.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldAutoGenerate])

  // ── Full Stage 2 generation ─────────────────────────────────────────────────
  const handleGenerate = useCallback(async () => {
    if (!activeStage1Rev) return
    setIsGenerating(true)
    setGenError(null)
    setRawResponse(null)
    setShowRaw(false)

    console.log('[Stage2] hasApiKey:', hasApiKey(), '| path:', hasApiKey() ? 'AI' : 'mock')
    console.log('[Stage2] VITE_ANTHROPIC_API_KEY present:', !!(import.meta.env.VITE_ANTHROPIC_API_KEY))

    const snapshot = activeStage1Rev.contentSnapshot
    let buList, note, source

    if (hasApiKey()) {
      const { messages } = buildStage2Messages(snapshot)
      const { result, error } = await callAI(messages, { temperature: 0.3, maxTokens: 6000 })

      if (error) {
        setGenError(error)
        setIsGenerating(false)
        return
      }

      const parsed = parseStage2Response(result)
      setRawResponse(result)

      if (parsed.error || !parsed.businessUnits) {
        setGenError(parsed.error || 'Response parse failed.')
        setIsGenerating(false)
        return
      }

      buList = parsed.businessUnits
      note   = parsed.summaryNote
      source = 'ai'

    } else {
      const mock = generateMockStage2(snapshot)
      buList = mock.businessUnits
      note   = mock.summaryNote
      source = 'mock'
    }

    const learningSignals = await collectStage2LearningSignals({
      source,
      prompt: '',
      impactSummary: `Generated from Stage 1 revision v${activeStage1Rev.revisionNumber}.`,
      refinementType: null,
      beforeAfterSummary: 'Stage 2 organizational capability map generated from the active Stage 1 strategy basis.',
      stalenessEvents: stage3HasRevisions ? ['Stage 3'] : [],
    }, source === 'ai')
    const nextNum = stage2Revisions.length + 1
    const record  = buildStage2RevisionRecord({
      businessUnits:        buList,
      summaryNote:          note,
      revisionNumber:       nextNum,
      sourceBasisRevisionId: stage1ActiveId,
      source,
      prompt:        '',
      impactSummary: `Generated from Stage 1 revision v${activeStage1Rev.revisionNumber} via ${source === 'ai' ? AI_MODEL_LABEL : 'mock generator'}.`,
      learningSignals,
      // refinementType and affectedUnit intentionally omitted (null) for full regeneration
    })

    onSaveRevision(record)
    setIsGenerating(false)
  }, [activeStage1Rev, stage1ActiveId, stage2Revisions.length, onSaveRevision])

  // ── Unit-level AI regeneration ──────────────────────────────────────────────
  // Returns { error: string|null } — does NOT set global isGenerating.
  // Loading state is owned by the BUCard that triggered the call.
  const handleUnitRegenerate = useCallback(async (buIndex, refinementPrompt, impactSummary, refinementScope) => {
    if (!activeStage1Rev)  return { error: 'No active Stage 1 revision.' }
    if (!hasApiKey())      return { error: 'API key required for unit regeneration.' }
    if (!activeRev)        return { error: 'No active Stage 2 revision to update.' }

    const snapshot = activeStage1Rev.contentSnapshot
    const { messages } = buildStage2UnitRefinementMessages(
      snapshot, businessUnits, buIndex, refinementPrompt, refinementScope,
    )

    const { result, error } = await callAI(messages, { temperature: 0.3, maxTokens: 2000 })
    if (error) return { error }

    const parsed = parseStage2UnitResponse(result)
    if (parsed.error || !parsed.unit) return { error: parsed.error || 'Response parse failed.' }

    const updatedBUs = businessUnits.map((bu, i) => (i === buIndex ? parsed.unit : bu))
    const unitName   = businessUnits[buIndex]?.name || `Unit ${buIndex + 1}`
    const learningSignals = await collectStage2LearningSignals({
      source: 'ai',
      prompt: refinementPrompt,
      impactSummary: impactSummary || `Regenerated "${unitName}"`,
      refinementType: 'unit',
      refinementScope,
      affectedUnit: unitName,
      beforeAfterSummary: 'One Stage 2 business unit was regenerated and merged back into the stage-level mapping.',
      stalenessEvents: stage3HasRevisions ? ['Stage 3'] : [],
    }, true)

    const nextNum = stage2Revisions.length + 1
    const record  = buildStage2RevisionRecord({
      businessUnits:         updatedBUs,
      summaryNote,
      revisionNumber:        nextNum,
      sourceBasisRevisionId: activeRev.sourceBasisRevisionId,
      source:                'ai',
      prompt:                refinementPrompt,
      impactSummary:         impactSummary || `Regenerated "${unitName}": ${refinementPrompt.slice(0, 80)}${refinementPrompt.length > 80 ? '…' : ''}`,
      refinementType:        'unit',
      affectedUnit:          unitName,
      refinementScope,
      learningSignals,
    })

    onSaveRevision(record)
    return { error: null }
  }, [activeStage1Rev, activeRev, businessUnits, summaryNote, stage2Revisions.length, onSaveRevision])

  // ── Stage-level correction note ─────────────────────────────────────────────
  // Cross-functional / org-wide corrections: saves a full revision snapshot (manual).
  // Does not regenerate via AI — use "Regenerate with AI" for full AI regeneration.
  async function handleStageRefinement({ prompt, impactSummary }) {
    if (!activeRev) return

    if (hasApiKey()) {
      if (!activeStage1Rev) return { error: 'No active Stage 1 revision.' }
      setIsStageRefining(true)
      setGenError(null)
      setRawResponse(null)
      setShowRaw(false)

      const { messages } = buildStage2StageRefinementMessages(
        activeStage1Rev.contentSnapshot,
        activeRev.contentSnapshot,
        prompt,
        impactSummary,
      )
      const { result, error } = await callAI(messages, { temperature: 0.3, maxTokens: 7000 })

      if (error) {
        setGenError(error)
        setIsStageRefining(false)
        return { error }
      }

      const parsed = parseStage2Response(result)
      setRawResponse(result)

      if (parsed.error || !parsed.businessUnits) {
        const parseError = parsed.error || 'Response parse failed.'
        setGenError(parseError)
        setIsStageRefining(false)
        return { error: parseError }
      }

      const learningSignals = await collectStage2LearningSignals({
        source: 'ai',
        prompt,
        impactSummary: impactSummary || 'Regenerated Stage 2 with AI',
        refinementType: 'stage',
        structuralImpact: parsed.structuralImpact,
        refinementClassification: parsed.refinementClassification,
        beforeAfterSummary: 'Full Stage 2 organizational capability map regenerated after a stage-level refinement.',
        stalenessEvents: stage3HasRevisions ? ['Stage 3'] : [],
      }, true)
      const nextNum = stage2Revisions.length + 1
      const record  = buildStage2RevisionRecord({
        businessUnits:        parsed.businessUnits,
        summaryNote:          parsed.summaryNote,
        revisionNumber:       nextNum,
        sourceBasisRevisionId: stage1ActiveId,
        source:               'ai',
        prompt,
        impactSummary:        impactSummary || `Regenerated Stage 2 with AI: ${prompt.slice(0, 90)}${prompt.length > 90 ? '...' : ''}`,
        refinementType:       'stage',
        affectedUnit:         null,
        structuralImpact:     parsed.structuralImpact,
        refinementClassification: parsed.refinementClassification,
        learningSignals,
      })

      onSaveRevision(record)
      setIsStageRefining(false)
      return { error: null }
    }

    const learningSignals = deriveLearningSignals({
      stage: 'Stage 2',
      source: 'manual',
      prompt,
      impactSummary,
      refinementType: 'stage',
      structuralImpact: 'none',
      stalenessEvents: stage3HasRevisions ? ['Stage 3'] : [],
    })
    const nextNum = stage2Revisions.length + 1
    const record  = buildStage2RevisionRecord({
      businessUnits: activeRev.contentSnapshot.businessUnits,
      summaryNote:   activeRev.contentSnapshot.summaryNote,
      revisionNumber:        nextNum,
      sourceBasisRevisionId: activeRev.sourceBasisRevisionId,
      source:                'manual',
      prompt,
      impactSummary,
      refinementType:        'stage',
      affectedUnit:          null,
      structuralImpact:      'none',
      learningSignals,
    })
    onSaveRevision(record)
    return { error: null }
  }

  // ── Source label for the current revision ───────────────────────────────────
  function sourceLabel(src) {
    if (src === 'ai')     return { text: 'AI-generated',    color: '#3b82f6'  }
    if (src === 'mock')   return { text: 'Mock-generated',  color: '#fb923c'  }
    if (src === 'manual') return { text: 'Manual note',     color: 'rgba(255,255,255,.38)' }
    return { text: src,   color: 'var(--muted)' }
  }

  // ── Empty state ─────────────────────────────────────────────────────────────
  if (stage2Revisions.length === 0) {
    return (
      <div style={{ maxWidth: 840, padding: '0 16px 40px' }}>
        <EmptyState
          apiMode={apiMode}
          isGenerating={isGenerating}
          genError={genError}
          rawResponse={rawResponse}
          showRaw={showRaw}
          onShowRaw={() => setShowRaw(s => !s)}
          onGenerate={handleGenerate}
          activeStage1Rev={activeStage1Rev}
        />
      </div>
    )
  }

  // ── Main view (has revisions) ───────────────────────────────────────────────
  const srcLbl = sourceLabel(activeRev?.source)

  return (
    <div style={{ maxWidth: 840, padding: '0 16px 40px' }}>

      {/* ── Status header ──────────────────────────────────────────────── */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--r)', padding: '14px 16px', marginBottom: 12,
        display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
        Organisational Capability Mapping
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
                from Stage 1 v{stage1Revisions.find(r => r.id === activeRev.sourceBasisRevisionId)?.revisionNumber ?? '?'}
              </span>
            )}
          </div>
          {summaryNote && (
            <div style={{ fontSize: 10, color: 'var(--muted2)', lineHeight: 1.65, marginTop: 8, fontFamily: 'var(--fm)' }}>
              {summaryNote}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <GenerateButton
            apiMode={apiMode}
            isGenerating={isGenerating}
            isRegenerate={true}
            onGenerate={handleGenerate}
            disabled={!activeStage1Rev}
          />
          <ApiModeStatus apiMode={apiMode} />
        </div>
      </div>

      {/* ── Staleness banner ───────────────────────────────────────────── */}
      {isStale && (
        <div style={{
          background: 'rgba(251,146,60,.06)', border: '1px solid rgba(251,146,60,.35)',
          borderRadius: 'var(--r)', padding: '12px 16px', marginBottom: 12,
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 10, fontFamily: 'var(--fm)' }}>⚠</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#fb923c', marginBottom: 2 }}>
              Stage 2 is stale
            </div>
            <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', lineHeight: 1.6 }}>
              The active Stage 1 revision has changed since this Stage 2 was generated.
              Regenerate to re-align, or keep the existing mapping.
            </div>
          </div>
          <button
            onClick={handleGenerate}
            disabled={isGenerating || !activeStage1Rev}
            style={{
              flexShrink: 0,
              fontSize: 9, fontFamily: 'var(--fm)', fontWeight: 600,
              padding: '5px 14px', borderRadius: 5, cursor: 'pointer',
              background: 'rgba(251,146,60,.15)', border: '1px solid rgba(251,146,60,.4)',
              color: '#fb923c',
            }}
          >
            {isGenerating ? 'Generating…' : 'Regenerate Stage 2'}
          </button>
        </div>
      )}

      {/* ── Generation error ───────────────────────────────────────────── */}
      {genError && (
        <div style={{
          fontSize: 10, color: '#f87171', marginBottom: 12, padding: '10px 14px',
          background: 'rgba(248,113,113,.06)', border: '1px solid rgba(248,113,113,.25)',
          borderRadius: 'var(--r)', fontFamily: 'var(--fm)',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <span style={{ flexShrink: 0 }}>⚠</span>
            <span>{genError}</span>
          </div>
          {rawResponse && (
            <div>
              <button
                onClick={() => setShowRaw(s => !s)}
                style={{
                  fontSize: 8, fontFamily: 'var(--fm)', padding: '2px 8px', borderRadius: 3,
                  cursor: 'pointer', background: 'var(--s2)',
                  border: '1px solid var(--border)', color: 'var(--muted)',
                }}
              >
                {showRaw ? 'Hide raw response' : 'Show raw response'}
              </button>
            </div>
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

      {/* ── Business units ─────────────────────────────────────────────── */}
      {businessUnits.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{
            fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            Organisational Capabilities
            <span style={{
              padding: '1px 6px', borderRadius: 3,
              background: 'var(--s2)', border: '1px solid var(--border)',
              fontSize: 8, color: 'var(--muted)',
            }}>
              {businessUnits.length}
            </span>
            {apiMode === 'ai' && (
              <span style={{ fontSize: 8, fontFamily: 'var(--fm)', color: 'var(--muted)', opacity: .65 }}>
                · Each unit has a localised ↻ Refine panel below its content
              </span>
            )}
          </div>
          {businessUnits.map((bu, i) => (
            <BUCard
              key={i}
              bu={bu}
              index={i}
              apiMode={apiMode}
              globalBusy={isGenerating}
              activeStage1Rev={activeStage1Rev}
              otherBuNames={businessUnits.filter((_, j) => j !== i).map(b => b.name)}
              onRefineUnit={(prompt, impact, scope) => handleUnitRegenerate(i, prompt, impact, scope)}
              workspaceId={workspace?.id}
            />
          ))}
        </div>
      )}

      {/* ── Diff viewer ────────────────────────────────────────────────── */}
      <LearningSignals signals={activeRev?.contentSnapshot?.learningSignals || activeRev?.learningSignals} />

      {compareRevision && activeRev && (
        <RevisionDiffViewer
          revA={compareRevision}
          revB={activeRev}
          toText={stage2SnapshotToText}
          onClose={() => setCompareRevId(null)}
        />
      )}

      {/* ── Revision history ───────────────────────────────────────────── */}
      <RevisionHistory
        revisions={stage2Revisions}
        activeRevisionId={stage2ActiveId}
        onCompare={id => setCompareRevId(id)}
        compareRevId={compareRevId}
      />

      {/* ── Stage-level cross-functional refinements ────────────────────── */}
      <RefinementPanel
        onSaveRevision={handleStageRefinement}
        title="Cross-functional Refinements"
        subtitle={
          apiMode === 'ai'
            ? 'Use this section for organisation-wide or structural changes. API mode regenerates the full Stage 2 business-unit mapping, including added, removed, merged, or reassigned units when needed.'
            : 'Use this section to record organisation-wide or cross-department corrections. Add an API key to regenerate the full Stage 2 structure with AI.'
        }
        saveLabel={apiMode === 'ai' ? 'Regenerate Stage 2 with AI' : 'Save manual correction note'}
        promptLabel="Refinement instruction"
        promptPlaceholder={
          'Examples:\n' +
          '· Finance should not participate until pilot validation is complete.\n' +
          '· Add Partnerships as a new business unit.\n' +
          '· Reduce staffing assumptions across all units to reflect the revised budget posture.\n' +
          '· Elevate Legal & Compliance to primary across all units — regulatory risk is now the gating factor.'
        }
        aiNotice={apiMode === 'ai' ? 'AI regeneration enabled' : null}
        isSaving={isStageRefining}
      />

      {/* ── Stage 3 CTA ────────────────────────────────────────────────── */}
      <div style={{
        background: 'var(--surface)',
        border: `1px solid ${stage3IsStale && stage3HasRevisions ? 'rgba(251,146,60,.35)' : 'rgba(59,130,246,.3)'}`,
        borderRadius: 'var(--r)', padding: '16px 18px',
        display: 'flex', alignItems: 'center', gap: 16,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
            {stage3IsStale && stage3HasRevisions
              ? 'Stage 3 is stale — business unit mapping has changed'
              : 'Continue to Stage 3 — Execution Planning'
            }
          </div>
          <div style={{ fontSize: 10, color: 'var(--muted2)', fontFamily: 'var(--fm)', lineHeight: 1.65 }}>
            {stage3IsStale && stage3HasRevisions
              ? 'The active Stage 2 BU mapping has changed since Stage 3 was generated. Regenerate to re-align execution plans, or view the existing Stage 3.'
              : 'Stage 3 will generate execution plans per business unit — including prioritised initiatives, sequencing, dependencies, and constraints.'
            }
          </div>
        </div>
        {stage3IsStale && stage3HasRevisions ? (
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button
              onClick={onNavigateToStage3}
              style={{
                fontSize: 10, fontFamily: 'var(--fm)', fontWeight: 600,
                padding: '7px 16px', borderRadius: 5, cursor: 'pointer',
                background: 'var(--s2)', border: '1px solid var(--border)', color: 'var(--muted2)',
              }}
            >
              View Stage 3
            </button>
            <button
              onClick={onRegenerateAndGoToStage3}
              style={{
                fontSize: 10, fontFamily: 'var(--fm)', fontWeight: 600,
                padding: '7px 16px', borderRadius: 5, cursor: 'pointer',
                background: 'rgba(251,146,60,.15)', border: '1px solid rgba(251,146,60,.4)',
                color: '#fb923c',
              }}
            >
              ↻ Regenerate & View →
            </button>
          </div>
        ) : (
          <button
            onClick={onNavigateToStage3}
            style={{
              flexShrink: 0,
              fontSize: 10, fontFamily: 'var(--fm)', fontWeight: 600,
              padding: '7px 20px', borderRadius: 5, cursor: 'pointer',
              background: 'var(--accent)', border: 'none', color: '#000',
            }}
          >
            Stage 3 →
          </button>
        )}
      </div>

    </div>
  )
}

// ── Empty state component ─────────────────────────────────────────────────────

function EmptyState({
  apiMode, isGenerating, genError, rawResponse, showRaw, onShowRaw,
  onGenerate, activeStage1Rev,
}) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--r)', padding: '40px 32px', textAlign: 'center',
      marginBottom: 12,
    }}>
      <div style={{ fontSize: 24, opacity: .18, marginBottom: 16, lineHeight: 1 }}>⬡</div>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
            Organisational Capability Mapping
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted2)', fontFamily: 'var(--fm)', lineHeight: 1.7, maxWidth: 420, margin: '0 auto 24px' }}>
        {apiMode === 'ai'
          ? 'Generate an AI-inferred organisational capability map from the active Stage 1 strategy basis.'
          : 'Generate a mock organisational capability map from the active Stage 1 strategy basis. Add VITE_ANTHROPIC_API_KEY to .env.local and restart the dev server for AI generation.'}
      </div>

      {!activeStage1Rev && (
        <div style={{
          fontSize: 10, color: '#f87171', marginBottom: 16, padding: '8px 14px',
          background: 'rgba(248,113,113,.06)', border: '1px solid rgba(248,113,113,.25)',
          borderRadius: 5, fontFamily: 'var(--fm)', display: 'inline-block',
        }}>
          No active Stage 1 revision found. Go back to Stage 1 first.
        </div>
      )}

      <GenerateButton
        apiMode={apiMode}
        isGenerating={isGenerating}
        isRegenerate={false}
        onGenerate={onGenerate}
        disabled={!activeStage1Rev}
        large
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
          <div style={{ display: 'flex', gap: 6 }}>
            <span style={{ flexShrink: 0 }}>⚠</span> {genError}
          </div>
          {rawResponse && (
            <button
              onClick={onShowRaw}
              style={{
                fontSize: 8, fontFamily: 'var(--fm)', padding: '2px 8px', borderRadius: 3,
                cursor: 'pointer', background: 'var(--s2)',
                border: '1px solid var(--border)', color: 'var(--muted)', alignSelf: 'flex-start',
              }}
            >
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
  )
}

// ── Generate/Regenerate button ────────────────────────────────────────────────

function GenerateButton({ apiMode, isGenerating, isRegenerate, onGenerate, disabled, large }) {
  let label
  if (isGenerating) {
    label = 'Generating…'
  } else if (apiMode === 'ai') {
    label = isRegenerate ? 'Regenerate with AI' : 'Generate with AI'
  } else {
    label = isRegenerate ? 'Regenerate (mock)' : 'Generate (mock)'
  }

  return (
    <button
      onClick={onGenerate}
      disabled={isGenerating || disabled}
      style={{
        fontSize: large ? 11 : 10,
        fontFamily: 'var(--fm)', fontWeight: 600,
        padding: large ? '9px 24px' : '6px 16px',
        borderRadius: 5, cursor: (isGenerating || disabled) ? 'not-allowed' : 'pointer',
        background: (isGenerating || disabled) ? 'var(--s2)' : 'var(--accent)',
        border: `1px solid ${(isGenerating || disabled) ? 'var(--border)' : 'var(--accent)'}`,
        color: (isGenerating || disabled) ? 'var(--muted)' : '#000',
        opacity: (isGenerating || disabled) ? 0.65 : 1,
        flexShrink: 0,
        transition: 'background .15s, color .15s',
      }}
    >
      {label}
    </button>
  )
}

// ── API mode status line ──────────────────────────────────────────────────────

function ApiModeStatus({ apiMode }) {
  const rawKey  = import.meta.env.VITE_ANTHROPIC_API_KEY
  const keyLen  = rawKey ? rawKey.length : 0
  const keyPreview = rawKey ? `${rawKey.slice(0, 10)}…` : '—'

  if (apiMode === 'ai') {
    return (
      <div style={{
        fontSize: 8, fontFamily: 'var(--fm)', color: '#00e5b4',
        display: 'flex', alignItems: 'center', gap: 4,
      }}>
        <span style={{
          display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
          background: '#00e5b4', flexShrink: 0,
        }} />
        AI enabled · key length: {keyLen}
      </div>
    )
  }
  return (
    <div style={{
      fontSize: 8, fontFamily: 'var(--fm)', color: '#f87171',
      display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{
          display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
          background: '#f87171', flexShrink: 0,
        }} />
        Key not detected — mock mode
      </div>
      <div style={{ color: 'var(--muted)', lineHeight: 1.5 }}>
        raw value: <code style={{ fontSize: 8, background: 'var(--s2)', padding: '0 3px', borderRadius: 2 }}>
          {keyPreview}
        </code>
        {' '}({keyLen} chars)
      </div>
      <div style={{ color: 'var(--muted)', lineHeight: 1.5 }}>
        Add <code style={{ fontSize: 8, background: 'var(--s2)', padding: '0 3px', borderRadius: 2 }}>VITE_ANTHROPIC_API_KEY</code> to .env.local · restart server · hard-refresh browser
      </div>
    </div>
  )
}
