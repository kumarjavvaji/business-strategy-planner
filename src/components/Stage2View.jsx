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
  buildHandoffItemMessages, parseHandoffItemResponse,
  buildHandoffChildAtomMessages, parseHandoffChildAtomResponse,
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
}
const CHILD_ATOM_STATE_DEFAULT = { status: 'not_started', rawResponse: null, parsedValue: null, parserError: null }

function Stage3HandoffShell({ bu, otherBuNames, activeStage1Rev, apiMode }) {
  const [open,         setOpen]         = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)   // structure-level generation
  const [structureRaw, setStructureRaw] = useState(null)
  const [parsed,       setParsed]       = useState(null)    // { domainOfWork, handoffStructure }
  const [genError,     setGenError]     = useState(null)
  const [itemStates,   setItemStates]   = useState({})      // { [index]: ITEM_STATE_DEFAULT }

  // ── Structure generation ────────────────────────────────────────────────────

  const canGenStructure = apiMode === 'ai' && !!activeStage1Rev && !isGenerating

  async function handleGenerateHandoffStructure() {
    if (!canGenStructure) return
    setIsGenerating(true)
    setGenError(null)
    setStructureRaw(null)

    const { messages } = buildHandoffStructureMessages(
      activeStage1Rev.contentSnapshot, bu, otherBuNames,
    )
    const { result, error } = await callAI(messages, { temperature: 0.3, maxTokens: 1500 })

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
    setItemStates({})   // reset all item state when structure changes
    setIsGenerating(false)
  }

  // ── Per-item generation ─────────────────────────────────────────────────────

  function patchItem(i, patch) {
    setItemStates(prev => ({
      ...prev,
      [i]: { ...ITEM_STATE_DEFAULT, ...(prev[i] || {}), ...patch },
    }))
  }

  async function handleGenerateItem(i, structureItem) {
    if (!activeStage1Rev || !parsed) return
    patchItem(i, { status: 'generating', parserError: null, rawResponse: null })

    const { messages } = buildHandoffItemMessages(
      activeStage1Rev.contentSnapshot,
      bu,
      parsed.domainOfWork,
      parsed.smeLens || null,
      structureItem,
      otherBuNames,
    )
    const { result, error } = await callAI(messages, { temperature: 0.3, maxTokens: 1200 })

    if (error) {
      patchItem(i, { status: 'failed', parserError: error, rawResponse: result ?? null })
      return
    }

    const p = parseHandoffItemResponse(result)
    if (p.error) {
      patchItem(i, { status: 'failed', rawResponse: result, parserError: p.error })
      return
    }

    patchItem(i, { status: 'complete', rawResponse: result, parsedValue: { key: p.key, value: p.value }, parserError: null })
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

  function handleDecomposeItem(i) {
    patchItem(i, {
      isDecomposed: true,
      childAtoms: Object.fromEntries(
        CHILD_ATOM_KEYS.map(k => [k, { ...CHILD_ATOM_STATE_DEFAULT }])
      ),
    })
  }

  async function handleGenerateChildAtom(i, structureItem, childKey) {
    if (!activeStage1Rev || !parsed) return
    patchChildAtom(i, childKey, { status: 'generating', parserError: null, rawResponse: null })

    const { messages } = buildHandoffChildAtomMessages(
      activeStage1Rev.contentSnapshot,
      bu,
      parsed.domainOfWork,
      parsed.smeLens || null,
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
    CHILD_ATOM_KEYS.forEach(key => {
      const cs = iState.childAtoms[key]
      if (cs?.status === 'complete' && cs.parsedValue !== null) {
        assembledValue[key] = cs.parsedValue
      }
    })
    if (!Object.keys(assembledValue).length) return

    const existingKey = iState.parsedValue?.key
    const derivedKey = existingKey || theme
      .toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
      .split(/\s+/)
      .map((w, idx) => idx === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))
      .join('')

    patchItem(i, {
      status: 'complete',
      assembledFromChildren: true,
      parsedValue: { key: derivedKey, value: assembledValue },
    })
  }

  // ── Derived status label ────────────────────────────────────────────────────

  const itemCount = parsed?.handoffStructure?.length ?? 0
  const doneCount = Object.values(itemStates).filter(s => s?.status === 'complete').length

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
            <Field label="SMEReviewLens" />
          </div>

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

                    const assembled = iState.status === 'complete' && iState.assembledFromChildren

                    const borderColor =
                      assembled                       ? 'rgba(139,92,246,.45)'  :
                      iState.status === 'complete'   ? 'rgba(0,229,180,.45)'   :
                      iState.status === 'failed'     ? 'rgba(248,113,113,.45)' :
                      isGenItem                      ? 'rgba(59,130,246,.55)'  :
                                                       'rgba(59,130,246,.22)'

                    const btnBg =
                      iState.status === 'failed'   ? 'rgba(248,113,113,.1)'  :
                      assembled                    ? 'rgba(139,92,246,.1)'   :
                      iState.status === 'complete' ? 'rgba(0,229,180,.08)'   :
                      canGenItem                   ? 'rgba(59,130,246,.1)'   : 'var(--surface)'

                    const btnBorder =
                      iState.status === 'failed'   ? 'rgba(248,113,113,.35)' :
                      assembled                    ? 'rgba(139,92,246,.3)'   :
                      iState.status === 'complete' ? 'rgba(0,229,180,.3)'    :
                      canGenItem                   ? 'rgba(59,130,246,.3)'   : 'var(--border)'

                    const btnColor =
                      iState.status === 'failed'   ? '#f87171'        :
                      assembled                    ? '#a78bfa'        :
                      iState.status === 'complete' ? '#00e5b4'        :
                      canGenItem                   ? 'var(--accent)'  : 'var(--muted)'

                    const btnLabel =
                      isGenItem                    ? 'Generating…'       :
                      iState.status === 'complete' ? '↻ Regenerate item' :
                      iState.status === 'failed'   ? 'Retry item'        :
                                                     'Generate item'

                    const canAssemble = !!(iState.childAtoms &&
                      Object.values(iState.childAtoms).some(cs => cs?.status === 'complete'))

                    return (
                      <div key={i} style={{ paddingLeft: 8, borderLeft: `2px solid ${borderColor}` }}>
                        {/* Theme row */}
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                          <div style={{ flex: 1, fontSize: 10, color: 'var(--muted2)', fontFamily: 'var(--fm)', lineHeight: 1.55 }}>
                            {theme}
                            {assembled && (
                              <span style={{ marginLeft: 5, fontSize: 8, fontFamily: 'var(--fm)', color: '#a78bfa', opacity: .8 }}>
                                assembled
                              </span>
                            )}
                          </div>
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

                        {/* Generated value */}
                        {iState.status === 'complete' && iState.parsedValue && (
                          <div style={{ paddingLeft: 4 }}>
                            {renderItemValue(iState.parsedValue.value)}
                          </div>
                        )}

                        {/* Per-item error + raw + decompose trigger */}
                        {iState.status === 'failed' && (
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
                            {!iState.isDecomposed && (
                              <button
                                onClick={() => handleDecomposeItem(i)}
                                style={{
                                  marginTop: 6, fontSize: 8, fontFamily: 'var(--fm)', fontWeight: 600,
                                  padding: '3px 8px', borderRadius: 3, cursor: 'pointer',
                                  background: 'rgba(139,92,246,.1)', border: '1px solid rgba(139,92,246,.3)',
                                  color: '#a78bfa',
                                }}
                              >
                                Decompose failed item
                              </button>
                            )}
                          </div>
                        )}

                        {/* Child atoms — shown whenever isDecomposed */}
                        {iState.isDecomposed && iState.childAtoms && (
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
                              Fallback decomposition
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

          {/* ── Action buttons ───────────────────────────────────── */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
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
            <button disabled style={disabledButtonStyle}>Generate SME lens</button>
            <button disabled style={disabledButtonStyle}>Assemble BU handoff</button>
          </div>
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

function BUCard({ bu, index, onRefineUnit, apiMode, globalBusy, activeStage1Rev, otherBuNames }) {
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

          <Stage3HandoffShell bu={bu} otherBuNames={otherBuNames} activeStage1Rev={activeStage1Rev} apiMode={apiMode} />

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
