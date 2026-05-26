// Stage 1 — Strategy Basis Review
// Reads from the normalized workspace model. Never accesses the raw package.

import React, { useState } from 'react'

// ── Posture colour map ────────────────────────────────────────────────────────
const POSTURE_COLORS = {
  'double down':          '#00e5b4',
  'selective investment': '#3b82f6',
  'maintain':             '#fb923c',
  'deprioritize':         'rgba(255,255,255,.38)',
  'divest/reallocate':    '#f87171',
}
function postureColor(type) {
  return POSTURE_COLORS[(type || '').toLowerCase()] || '#3b82f6'
}

// ── Small reusable primitives ─────────────────────────────────────────────────

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

function Field({ label, value }) {
  if (!value) return null
  return (
    <div style={{ marginBottom: 11 }}>
      <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted2)', lineHeight: 1.75 }}>{value}</div>
    </div>
  )
}

function ItemList({ items, borderColor }) {
  const bc = borderColor || 'var(--border2)'
  if (!items?.length) {
    return <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--fm)' }}>None recorded.</div>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {items.map((item, i) => (
        <div key={i} style={{
          fontSize: 10, color: 'var(--muted2)', lineHeight: 1.7,
          paddingLeft: 10, borderLeft: `2px solid ${bc}`,
        }}>
          {item}
        </div>
      ))}
    </div>
  )
}

function Section({ title, label, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--r)', marginBottom: 10, overflow: 'hidden',
    }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          padding: '10px 15px', cursor: 'pointer', userSelect: 'none',
          display: 'flex', alignItems: 'center', gap: 8,
          borderBottom: open ? '1px solid var(--border)' : 'none',
        }}
      >
        {label && (
          <span style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--accent)', flexShrink: 0 }}>
            {label}
          </span>
        )}
        <span style={{ fontSize: 11, fontWeight: 600, flex: 1 }}>{title}</span>
        <span style={{ fontSize: 9, color: 'var(--muted)' }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && <div style={{ padding: '13px 15px' }}>{children}</div>}
    </div>
  )
}

// ── Main Stage 1 view ─────────────────────────────────────────────────────────

export default function Stage1View({ workspace }) {
  const { entity, artifact, strategy, evidence, lineage } = workspace
  const data     = artifact?.data    || {}
  const sections = data.sections     || []
  const posColor = postureColor(artifact?.type)
  const confColor = strategy.confidenceLevel === 'High'   ? '#00e5b4'
                  : strategy.confidenceLevel === 'Medium' ? '#fb923c'
                  : strategy.confidenceLevel === 'Low'    ? '#f87171'
                  : 'var(--muted)'

  return (
    <div style={{ maxWidth: 840, padding: '0 16px 40px' }}>

      {/* ── Artifact identity header ─────────────────────────────────────── */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--r)', padding: '16px 18px', marginBottom: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.3, marginBottom: 4 }}>
              {artifact.title || 'Untitled artifact'}
            </div>
            {data.subtitle && (
              <div style={{ fontSize: 10, color: 'var(--muted2)', fontFamily: 'var(--fm)', lineHeight: 1.5 }}>
                {data.subtitle}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 }}>
            {artifact.versionNumber != null && (
              <Badge color="rgba(255,255,255,.3)">v{artifact.versionNumber}</Badge>
            )}
            {artifact.type && <Badge color={posColor}>{artifact.type}</Badge>}
            {entity.company && <Badge color="var(--accent)">{entity.company}</Badge>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {data.personaSummary && (
            <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
              For: {data.personaSummary}
            </div>
          )}
          {strategy.targetCustomer && (
            <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--a3)' }}>
              Target: {strategy.targetCustomer}
            </div>
          )}
          {entity.analysisType && (
            <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)' }}>
              {entity.analysisType}
            </div>
          )}
        </div>
      </div>

      {/* ── Strategy Basis ────────────────────────────────────────────────── */}
      <Section title="Strategy Basis" label="01" defaultOpen={true}>
        <Field label="Strategic Thesis" value={strategy.thesis} />
        <Field label="Business Problem" value={strategy.businessProblem} />
        <Field label="Opportunity" value={strategy.opportunity} />
        <Field label="Recommended Direction" value={strategy.recommendedDirection} />
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 4 }}>
          {strategy.confidenceLevel && (
            <div>
              <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5 }}>
                Confidence
              </div>
              <Badge color={confColor}>{strategy.confidenceLevel}</Badge>
            </div>
          )}
          {strategy.readinessLevel && (
            <div>
              <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5 }}>
                Readiness
              </div>
              <Badge color="var(--a4)">{strategy.readinessLevel}</Badge>
            </div>
          )}
        </div>
      </Section>

      {/* ── Artifact Content (sections) ──────────────────────────────────── */}
      {sections.length > 0 && (
        <Section title="Artifact Content" label="02" defaultOpen={true}>
          {sections.map((sec, i) => (
            <div key={i} style={{ marginBottom: i < sections.length - 1 ? 16 : 0 }}>
              <div style={{
                fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '.07em', color: 'var(--text)',
                marginBottom: 5, paddingBottom: 4,
                borderBottom: '1px solid var(--border)',
              }}>
                {sec.heading}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted2)', lineHeight: 1.8 }}>
                {sec.body}
              </div>
            </div>
          ))}
        </Section>
      )}

      {/* ── Key Decisions ────────────────────────────────────────────────── */}
      {data.keyDecisions?.length > 0 && (
        <Section title="Key Decisions" label="03" defaultOpen={true}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {data.keyDecisions.map((d, i) => (
              <div key={i} style={{ display: 'flex', gap: 9, fontSize: 10, color: 'var(--text)', lineHeight: 1.7 }}>
                <span style={{ color: 'var(--accent)', fontFamily: 'var(--fm)', fontWeight: 700, flexShrink: 0 }}>
                  {i + 1}.
                </span>
                {d}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ── Call to Action ───────────────────────────────────────────────── */}
      {data.callToAction && (
        <Section title="Call to Action" label="04" defaultOpen={true}>
          <div style={{
            fontSize: 11, color: 'var(--text)', lineHeight: 1.75, fontWeight: 500,
            padding: '8px 12px', borderRadius: 5,
            background: 'rgba(59,130,246,.06)', border: '1px solid rgba(59,130,246,.2)',
          }}>
            {data.callToAction}
          </div>
        </Section>
      )}

      {/* ── Validation Checkpoints ───────────────────────────────────────── */}
      {data.validationCheckpoints?.length > 0 && (
        <Section title="Validation Checkpoints" label="05" defaultOpen={true}>
          <ItemList items={data.validationCheckpoints} borderColor="rgba(0,229,180,.4)" />
        </Section>
      )}

      {/* ── Readiness Warnings ──────────────────────────────────────────── */}
      {data.readinessWarnings?.length > 0 && (
        <Section title="Readiness Warnings" label="06" defaultOpen={true}>
          <ItemList items={data.readinessWarnings} borderColor="rgba(248,113,113,.5)" />
        </Section>
      )}

      {/* ── Risk Posture & Risks ─────────────────────────────────────────── */}
      <Section title="Risk Posture & Identified Risks" label="07" defaultOpen={true}>
        <div style={{ marginBottom: evidence.risks.length > 0 ? 12 : 0 }}>
          <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5 }}>
            Investment Posture
          </div>
          {artifact.type
            ? <Badge color={posColor}>{artifact.type}</Badge>
            : <span style={{ fontSize: 10, color: 'var(--muted)' }}>Not specified</span>
          }
        </div>
        {evidence.risks.length > 0 && (
          <>
            <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 7, marginTop: 12 }}>
              Identified Risks
            </div>
            <ItemList items={evidence.risks} borderColor="rgba(248,113,113,.5)" />
          </>
        )}
      </Section>

      {/* ── Key Insights ─────────────────────────────────────────────────── */}
      <Section title="Key Insights" label="08" defaultOpen={false}>
        <ItemList items={evidence.keyInsights} borderColor="rgba(59,130,246,.45)" />
      </Section>

      {/* ── Supporting Claims ────────────────────────────────────────────── */}
      <Section title="Supporting Claims" label="09" defaultOpen={false}>
        <ItemList items={evidence.supportingClaims} borderColor="rgba(99,102,241,.45)" />
      </Section>

      {/* ── Unresolved Questions ─────────────────────────────────────────── */}
      {evidence.unresolvedQuestions.length > 0 && (
        <Section title="Unresolved Questions" label="10" defaultOpen={false}>
          <ItemList items={evidence.unresolvedQuestions} borderColor="rgba(251,146,60,.45)" />
        </Section>
      )}

      {/* ── Upstream Evidence Chain ──────────────────────────────────────── */}
      <Section title="Upstream Evidence Chain" label="11" defaultOpen={false}>
        <Field label="Stage 1 — Initial orientation" value={evidence.stage1Intent} />
        <Field label="Stage 2 — Evidence retrieval" value={evidence.stage2Summary} />
        <Field label="Stage 3 — Strategic synthesis" value={evidence.stage3Synthesis} />
        {evidence.userContextAdditions.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
              User Context Additions (Stage 4)
            </div>
            <ItemList items={evidence.userContextAdditions} borderColor="rgba(139,92,246,.45)" />
          </div>
        )}
      </Section>

      {/* ── Lineage & Traceability ───────────────────────────────────────── */}
      <Section title="Lineage & Traceability" label="12" defaultOpen={false}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 20px', marginBottom: 10 }}>
          <Field label="Source Stage" value={lineage.sourceStage} />
          <Field label="Artifact Version" value={lineage.sourceArtifactVersion} />
          <Field label="User Edited" value={lineage.userEdited ? 'Yes' : 'No'} />
          <Field label="Citations Preserved" value={lineage.citationsPreserved ? 'Yes' : 'No'} />
        </div>
        {lineage.basedOnStages?.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 9, fontFamily: 'var(--fm)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
              Based On
            </div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {lineage.basedOnStages.map(s => <Badge key={s} color="var(--accent)">{s}</Badge>)}
            </div>
          </div>
        )}
        {lineage.notes && <Field label="Notes" value={lineage.notes} />}
      </Section>

    </div>
  )
}
