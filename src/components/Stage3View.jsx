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
  buildStage3Messages,
  parseStage3Response,
  generateMockStage3,
  buildStage3UnitRefinementMessages,
  parseStage3UnitResponse,
} from '../utils/stage3Prompts'
import { buildStage3RevisionRecord, stage3SnapshotToText } from '../utils/stageSnapshots'
import RevisionHistory    from './RevisionHistory'
import RevisionDiffViewer from './RevisionDiffViewer'
import RefinementPanel                    from './RefinementPanel'
import { REFINEMENT_SCOPES }             from './Stage2View'

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

function riskColor(level)      { return RISK_COLORS[level]     || '#fb923c' }
function readyColor(level)     { return READINESS_COLORS[level] || '#fb923c' }

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

          {/* Strategic objectives */}
          {plan.strategicObjectives?.length > 0 && (
            <PlanSection label="Strategic Objectives">
              <BulletList items={plan.strategicObjectives} borderColor="rgba(59,130,246,.4)" />
            </PlanSection>
          )}

          {/* Prioritised initiatives */}
          <PlanSection label="Prioritised Initiatives">
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
  stage1Revisions,
  stage1ActiveId,
  stage2Revisions,
  stage2ActiveId,
  stage3Revisions,
  stage3ActiveId,
  onSaveRevision,         // (revisionRecord) => void
  onNavigateToStage4,
  shouldAutoGenerate,     // boolean — set by Stage 2 "Regenerate & View Stage 3" CTA
  onAutoGenerateComplete, // () => void
}) {
  const [isGenerating, setIsGenerating] = useState(false)
  const [genError,     setGenError]     = useState(null)
  const [rawResponse,  setRawResponse]  = useState(null)
  const [showRaw,      setShowRaw]      = useState(false)
  const [compareRevId, setCompareRevId] = useState(null)

  // ── Derived state ───────────────────────────────────────────────────────────
  const activeRev      = stage3Revisions.find(r => r.id === stage3ActiveId) ?? null
  const executionPlans = activeRev?.contentSnapshot?.executionPlans || []
  const summaryNote    = activeRev?.contentSnapshot?.summaryNote    || ''

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

  // ── Full Stage 3 generation ─────────────────────────────────────────────────
  const handleGenerate = useCallback(async () => {
    if (!activeStage1Rev || !activeStage2Rev) return
    setIsGenerating(true)
    setGenError(null)
    setRawResponse(null)
    setShowRaw(false)

    const s1Snap = activeStage1Rev.contentSnapshot
    const s2Snap = activeStage2Rev.contentSnapshot

    let plans, note, source

    if (hasApiKey()) {
      const { messages } = buildStage3Messages(s1Snap, s2Snap)
      const { result, error } = await callAI(messages, { temperature: 0.3, maxTokens: 10000 })

      if (error) { setGenError(error); setIsGenerating(false); return }

      const parsed = parseStage3Response(result)
      setRawResponse(result)

      if (parsed.error || !parsed.executionPlans) {
        setGenError(parsed.error || 'Response parse failed.')
        setIsGenerating(false)
        return
      }

      plans  = parsed.executionPlans
      note   = parsed.summaryNote
      source = 'ai'

    } else {
      const mock = generateMockStage3(s1Snap, s2Snap)
      plans  = mock.executionPlans
      note   = mock.summaryNote
      source = 'mock'
    }

    const nextNum = stage3Revisions.length + 1
    const record  = buildStage3RevisionRecord({
      executionPlans:        plans,
      summaryNote:           note,
      revisionNumber:        nextNum,
      sourceBasisRevisionId:  stage1ActiveId,
      sourceStage2RevisionId: stage2ActiveId,
      source,
      prompt:        '',
      impactSummary: `Generated from Stage 1 ${revNum(stage1ActiveId, stage1Revisions)} + Stage 2 ${revNum(stage2ActiveId, stage2Revisions)} via ${source === 'ai' ? AI_MODEL_LABEL : 'mock generator'}.`,
      refinementType: null,
      affectedUnit:   null,
    })

    onSaveRevision(record)
    setIsGenerating(false)
  }, [activeStage1Rev, activeStage2Rev, stage1ActiveId, stage2ActiveId, stage1Revisions, stage2Revisions, stage3Revisions.length, onSaveRevision])

  // ── Unit-level refinement ───────────────────────────────────────────────────
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

    const nextNum = stage3Revisions.length + 1
    const record  = buildStage3RevisionRecord({
      executionPlans:         updatedPlans,
      summaryNote,
      revisionNumber:         nextNum,
      sourceBasisRevisionId:  activeRev.sourceBasisRevisionId,
      sourceStage2RevisionId: activeRev.sourceStage2RevisionId,
      source:                 'ai',
      prompt:                 refinementPrompt,
      impactSummary:          impactSummary || `Regenerated "${unitName}": ${refinementPrompt.slice(0, 80)}${refinementPrompt.length > 80 ? '…' : ''}`,
      refinementType:         'unit',
      affectedUnit:           unitName,
      refinementScope,
    })

    onSaveRevision(record)
    return { error: null }
  }, [activeStage1Rev, activeStage2Rev, activeRev, executionPlans, summaryNote, stage3Revisions.length, onSaveRevision])

  // ── Stage-level correction ──────────────────────────────────────────────────
  function handleStageRefinement({ prompt, impactSummary }) {
    if (!activeRev) return
    const nextNum = stage3Revisions.length + 1
    const record  = buildStage3RevisionRecord({
      executionPlans: activeRev.contentSnapshot.executionPlans,
      summaryNote:    activeRev.contentSnapshot.summaryNote,
      revisionNumber:         nextNum,
      sourceBasisRevisionId:  activeRev.sourceBasisRevisionId,
      sourceStage2RevisionId: activeRev.sourceStage2RevisionId,
      source:                 'manual',
      prompt,
      impactSummary,
      refinementType:         'stage',
      affectedUnit:           null,
    })
    onSaveRevision(record)
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
          'Use this section for organisation-wide or cross-BU changes that affect multiple execution plans or the overall execution posture. ' +
          'This saves a correction note as a new revision — use "Regenerate with AI" above to fully re-generate from updated upstream stages.'
        }
        saveLabel="Save refinement note"
        promptLabel="Refinement instruction"
        promptPlaceholder={
          'Examples:\n' +
          '· Reduce all timelines by 3 weeks — leadership compressed the pilot window.\n' +
          '· Remove Finance from the gate review — decision rights have moved to the executive sponsor.\n' +
          '· Add a shared data infrastructure unit as a cross-cutting workstream.\n' +
          '· All BUs should defer phase-two commitments until the phase-one go/no-go review is complete.'
        }
        aiNotice={null}
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
