// Stage 3 — prompt builder, mock generator, and response normaliser.
// Translates active Stage 1 strategy + Stage 2 BU mapping into per-BU execution plans.
// Pure functions — no React, no side effects.

import { stageSnapshotToText, stage2SnapshotToText } from './stageSnapshots'

// ── Shared helpers ────────────────────────────────────────────────────────────

const safeStr  = v => (typeof v === 'string' ? v.trim() : String(v ?? ''))
const safeList = v => (Array.isArray(v) ? v.map(safeStr).filter(Boolean) : [])
const LEVELS   = new Set(['low', 'medium', 'high'])
const ATYPES   = new Set(['fact', 'inferred', 'speculative'])

function safeLevel(v) { return LEVELS.has(v) ? v : 'medium' }

function safeAssumptions(v) {
  if (!Array.isArray(v)) return []
  return v
    .map(a => ({
      text: safeStr(a?.text || a?.assumption || a),
      type: ATYPES.has(a?.type) ? a.type : 'inferred',
    }))
    .filter(a => a.text)
}

// ── Schema string (shared between full and unit prompts) ──────────────────────

const BU_PLAN_SCHEMA = `{
  "buName": "string — exact name of the business unit",
  "mission": "string — 1-sentence operator-style mission for this BU in this initiative (no generic language)",
  "strategicObjectives": ["string — 2-3 items"],
  "initiativesMissionCritical": ["string — must happen; blocks all else — 1-3 items"],
  "initiativesOptional": ["string — value-add but not blocking — 1-2 items"],
  "initiativesDeferred": ["string — explicitly push to a later phase with reason — 1-2 items"],
  "initiativesBlocked": ["string — currently blocked: name the blocker — 0-2 items, empty array if none"],
  "sequencingNarrative": "string — what happens in phase 1 vs phase 2 vs phase 3, 2-3 sentences",
  "keyMilestones": ["string — milestone event + rough timing — 2-3 items"],
  "crossFunctionalDependencies": ["string — dependency description + owning unit — 2-3 items"],
  "requiredCapabilities": ["string — capability gap or specific need — 2-3 items"],
  "staffingOwnership": ["string — role/headcount/ownership implication — 2-3 items"],
  "systemsTools": ["string — specific tool, system, or process implication — 1-3 items"],
  "governanceCadence": ["string — governance rhythm or decision checkpoint — 1-2 items"],
  "decisionRights": ["string — who decides what, explicitly — 1-2 items"],
  "risks": ["string — specific risk to this BU in this strategy context, not generic — 2-3 items"],
  "constraints": ["string — hard constraint that bounds what this BU can do — 2-3 items"],
  "unresolvedUnknowns": ["string — genuine gap that has not been answered — 2-3 items"],
  "assumptions": [
    { "text": "string — the assumption", "type": "fact | inferred | speculative" }
  ],
  "leadingIndicators": ["string — early signal to watch before outcomes arrive — 2-3 items"],
  "keySuccessMetrics": ["string — measurable outcome — 2-3 items"],
  "failureSignals": ["string — early warning that the plan is failing — 2-3 items"],
  "readinessAssessment": "string — honest 1-sentence assessment of this BU's readiness to execute",
  "executionRisk": "low | medium | high",
  "dependencyComplexity": "low | medium | high",
  "confidenceLevel": "low | medium | high",
  "organizationalReadiness": "low | medium | high"
}`

// ── Full Stage 3 generation ───────────────────────────────────────────────────

/**
 * Build AI messages for full Stage 3 execution plan generation.
 * @param {object} stage1Snapshot  — contentSnapshot from active Stage 1 revision
 * @param {object} stage2Snapshot  — contentSnapshot from active Stage 2 revision
 * @returns {{ messages: Array<{ role, content }>, systemPrompt: string }}
 */
export function buildStage3Messages(stage1Snapshot, stage2Snapshot) {
  const s1Context = stageSnapshotToText(stage1Snapshot)
  const s2Context = stage2SnapshotToText(stage2Snapshot)
  const buNames   = (stage2Snapshot?.businessUnits || []).map(u => u.name).join(', ')

  const systemPrompt = `You are an execution strategist — not a consultant, not a project manager. Your role is to translate a corporate strategy and business-unit mapping into realistic, constraint-aware execution plans.

EXECUTION REALISM RULES — follow every one:
1. Force prioritisation: use the four initiative categories ruthlessly. Not everything is mission critical. Mark genuinely optional work as optional. Name what is deferred and why. If something is blocked, name the specific blocker.
2. Model constraints explicitly: staffing limits, budget pressure, organisational maturity, leadership attention, dependency bottlenecks. Surface them — do not assume infinite capacity.
3. Expose tradeoffs directly: if an initiative increases risk, say so. If sequencing it first delays other units, say so. If scope reduction is needed, say so.
4. Distinguish assumption types: "fact" = stated in source documents; "inferred" = reasoned from context; "speculative" = you are guessing. Label every assumption honestly.
5. Avoid generic language: no "leverage synergies", no "drive alignment", no "ensure stakeholder buy-in", no "best practices". Use operator language — name the specific thing.
6. Unknowns are first-class: unresolvedUnknowns should list genuine gaps, not be empty. Do not mask uncertainty with authoritative wording.
7. Encourage strategic sacrifice: not every BU gets equal urgency or investment. Some BUs should have thin plans, deferred timelines, and honest low-readiness assessments.
8. Readiness must be honest: if a BU is not ready, say "not ready to execute" and name why.
9. Failure signals matter: failureSignals should be specific early-warning signs, not generic risk re-statements.
10. Sequencing must be concrete: sequencingNarrative should name what gates what.

For EACH business unit, reason through:
- What must happen first and why (missionCritical)?
- What can wait without blocking progress (optional/deferred)?
- What is currently blocked and what specifically unblocks it?
- What would invalidate the entire plan for this BU?
- What are the real staffing and system constraints?
- What governance touchpoints are genuinely required vs. theatre?

Return ONLY a valid JSON object — no markdown, no prose, no code fences. Exact schema:

{
  "executionPlans": [
${BU_PLAN_SCHEMA.split('\n').map(l => '    ' + l).join('\n')}
  ],
  "summaryNote": "string — 2-sentence executive note: overall execution posture, top cross-cutting risk, and the single most important sequencing constraint"
}

Produce one executionPlan object per business unit in the Stage 2 mapping.`

  const userPrompt = `Stage 1 — Strategy Basis:
${s1Context}

Stage 2 — Business Unit Mapping:
${s2Context}

Business units to plan: ${buNames || 'see Stage 2 above'}

Generate the full Stage 3 execution plan. Return only the JSON object.`

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
    systemPrompt,
  }
}

// ── Full response normaliser ──────────────────────────────────────────────────

/**
 * Parse and normalise the raw AI text response into Stage 3 payload.
 * @param {string} rawText
 * @returns {{ executionPlans: object[]|null, summaryNote: string, raw: string, error: string|null }}
 */
export function parseStage3Response(rawText) {
  if (!rawText?.trim()) {
    return { executionPlans: null, summaryNote: '', raw: rawText || '', error: 'Empty response from API.' }
  }

  let jsonStr = rawText.trim()
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) jsonStr = fenceMatch[1].trim()

  const firstBrace = jsonStr.indexOf('{')
  const lastBrace  = jsonStr.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1)
  }

  let parsed
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    return {
      executionPlans: null,
      summaryNote:    '',
      raw:            rawText,
      error:          'Could not parse JSON from response. See raw output below.',
    }
  }

  const plans = parsed?.executionPlans
  if (!Array.isArray(plans) || plans.length === 0) {
    return {
      executionPlans: null,
      summaryNote:    '',
      raw:            rawText,
      error:          'Response did not contain a valid executionPlans array.',
    }
  }

  const normalised = plans.map(p => normalisePlan(p))

  return {
    executionPlans: normalised,
    summaryNote:    safeStr(parsed.summaryNote),
    raw:            rawText,
    error:          null,
  }
}

function normalisePlan(p) {
  return {
    buName:                       safeStr(p.buName)                || 'Unnamed unit',
    mission:                      safeStr(p.mission),
    strategicObjectives:          safeList(p.strategicObjectives),
    initiativesMissionCritical:   safeList(p.initiativesMissionCritical),
    initiativesOptional:          safeList(p.initiativesOptional),
    initiativesDeferred:          safeList(p.initiativesDeferred),
    initiativesBlocked:           safeList(p.initiativesBlocked),
    sequencingNarrative:          safeStr(p.sequencingNarrative),
    keyMilestones:                safeList(p.keyMilestones),
    crossFunctionalDependencies:  safeList(p.crossFunctionalDependencies),
    requiredCapabilities:         safeList(p.requiredCapabilities),
    staffingOwnership:            safeList(p.staffingOwnership),
    systemsTools:                 safeList(p.systemsTools),
    governanceCadence:            safeList(p.governanceCadence),
    decisionRights:               safeList(p.decisionRights),
    risks:                        safeList(p.risks),
    constraints:                  safeList(p.constraints),
    unresolvedUnknowns:           safeList(p.unresolvedUnknowns),
    assumptions:                  safeAssumptions(p.assumptions),
    leadingIndicators:            safeList(p.leadingIndicators),
    keySuccessMetrics:            safeList(p.keySuccessMetrics),
    failureSignals:               safeList(p.failureSignals),
    readinessAssessment:          safeStr(p.readinessAssessment),
    executionRisk:                safeLevel(p.executionRisk),
    dependencyComplexity:         safeLevel(p.dependencyComplexity),
    confidenceLevel:              safeLevel(p.confidenceLevel),
    organizationalReadiness:      safeLevel(p.organizationalReadiness),
  }
}

// ── Unit-level refinement prompt builder ─────────────────────────────────────

/**
 * Build messages for regenerating a single BU execution plan.
 * @param {object}   stage1Snapshot    — contentSnapshot from active Stage 1 revision
 * @param {object}   stage2Snapshot    — contentSnapshot from active Stage 2 revision
 * @param {object[]} allPlans          — full current execution plan array
 * @param {number}   targetIndex       — 0-based index of the plan to regenerate
 * @param {string}   refinementPrompt  — user's refinement instruction
 * @param {string}   [refinementScope] — user-indicated scope hint
 * @returns {{ messages: Array<{ role, content }>, systemPrompt: string }}
 */
export function buildStage3UnitRefinementMessages(
  stage1Snapshot, stage2Snapshot, allPlans, targetIndex, refinementPrompt, refinementScope,
) {
  const s1Context   = stageSnapshotToText(stage1Snapshot)
  const targetPlan  = allPlans[targetIndex]
  const targetBU    = (stage2Snapshot?.businessUnits || []).find(u => u.name === targetPlan?.buName) || {}

  const otherPlansSummary = allPlans
    .filter((_, i) => i !== targetIndex)
    .map(p => `- ${p.buName}: ${p.mission || '—'} [exec risk: ${p.executionRisk}, readiness: ${p.organizationalReadiness}]`)
    .join('\n')

  const scopeHint = (refinementScope && refinementScope !== 'auto')
    ? `\nUser-indicated refinement scope: ${refinementScope} — weight your changes accordingly.`
    : ''

  const systemPrompt = `You are an execution strategist regenerating ONE specific business unit execution plan within an existing Stage 3 execution planning document.

STEP 1 — CLASSIFY THE REFINEMENT
Before making changes, silently classify the user's refinement as one or more of:
  • wording clarification
  • ownership / emphasis change (who leads, who is primary, who is accountable)
  • client-facing role identification (this unit interacts with or introduces the offering to clients)
  • sequencing change (what happens when, what gates what)
  • cross-functional dependency change
  • staffing / capability gap identified
  • KPI / measurement change
  • risk, constraint, or unknown change
  • new initiative or workstream needed
  • blocked initiative needs resolution path

STEP 2 — APPLY THE CLASSIFICATION TO PRODUCE CONCRETE CHANGES

  • wording clarification only → update only the specific text; preserve all other fields verbatim.

  • ownership / emphasis change → MUST update: mission (reframe to reflect new ownership),
    initiativesMissionCritical (add initiatives that own the new responsibility),
    staffingOwnership (name the new owner explicitly), decisionRights (update who decides what),
    governanceCadence (add checkpoints for the new accountability), and
    keySuccessMetrics (add metrics for the ownership outcome).

  • client-facing role identification → MUST update ALL of the following:
      - mission: reframe to include client-facing delivery and adoption explicitly
      - initiativesMissionCritical: add "consultant/field enablement programme", "field messaging
        readiness", and "client adoption support track" as mission-critical initiatives
      - crossFunctionalDependencies: add dependencies on product/marketing for messaging assets,
        training team for readiness programmes, and feedback infrastructure
      - staffingOwnership: add enablement lead, training coordinator, field feedback owner
      - systemsTools: add tools for enablement delivery, training tracking, feedback capture
      - leadingIndicators: add consultant readiness %, training completion rate, field message
        consistency score
      - keySuccessMetrics: add client adoption rate driven through this channel, consultant
        satisfaction with enablement, feedback loop closure rate
      - failureSignals: add signals for insufficient consultant readiness before client launch,
        message inconsistency in client conversations, feedback not captured or acted on
      - unresolvedUnknowns: add unknowns around current enablement maturity, training capacity,
        and feedback infrastructure readiness
      - readinessAssessment: update to reflect enablement readiness as a key gate

  • sequencing change → update sequencingNarrative and keyMilestones; check if anything
    previously deferred should be promoted to mission critical or vice versa.

  • new initiative → add to initiativesMissionCritical or initiativesOptional based on priority;
    update dependencies, staffing, and metrics accordingly.

  • staffing / capability gap → update staffingOwnership and requiredCapabilities;
    add the gap as a constraint or unknown if not yet resolved.

  • KPI change → update leadingIndicators, keySuccessMetrics, failureSignals.

  • risk / constraint / unknown → update risks, constraints, unresolvedUnknowns; check if
    sequencing or initiatives need adjustment as a result.

CRITICAL RULES — FOLLOW WITHOUT EXCEPTION:
1. Treat emphasis, ownership, and client-facing role changes as substantive execution changes.
   Do not treat them as cosmetic. A change in who owns client interaction demands concrete changes
   to missions, initiatives, metrics, staffing, and failure signals.
2. If a refinement identifies that this unit is the primary delivery or adoption channel to clients,
   the plan MUST include explicit workstreams for enablement, field readiness, messaging
   consistency, and feedback loop capture — these are not optional.
3. Do NOT return content that is materially unchanged from the current version unless the
   refinement is purely a wording clarification with zero operational impact.
4. Avoid generic PMO language. Every added item must be concrete and specific to this unit
   and strategy context.
5. Force prioritisation: not everything added should be mission critical. Use the four categories
   correctly.${scopeHint}

Preserve organisational coherence with the other plans. Do not create dependencies or decision
rights that conflict with other units.

Return ONLY a valid JSON object — no markdown, no prose, no code fences:
${BU_PLAN_SCHEMA}`

  const userPrompt = `Stage 1 Strategic Context:
${s1Context}

Stage 2 — Business Unit context:
  Name: ${targetBU.name || targetPlan?.buName}
  Purpose: ${targetBU.purpose || '—'}
  Involvement: ${targetBU.involvementLevel || '—'}
  Key responsibilities: ${(targetBU.keyResponsibilities || []).join('; ') || '—'}
  Dependencies: ${(targetBU.dependencies || []).join('; ') || '—'}
  Risks: ${(targetBU.risksAndUnknowns || []).join('; ') || '—'}

Current Stage 3 plan for "${targetPlan?.buName}":
  Mission: ${targetPlan?.mission || '—'}
  Mission Critical initiatives: ${(targetPlan?.initiativesMissionCritical || []).join('; ') || '—'}
  Execution risk: ${targetPlan?.executionRisk || '—'} · Readiness: ${targetPlan?.organizationalReadiness || '—'}
  Current success metrics: ${(targetPlan?.keySuccessMetrics || []).join('; ') || '—'}
  Current failure signals: ${(targetPlan?.failureSignals || []).join('; ') || '—'}

Other BU plans (for coherence — do not modify):
${otherPlansSummary}

Refinement instruction:
${refinementPrompt}

Apply the refinement classification rules above and return the updated JSON object for "${targetPlan?.buName}". Make concrete changes — this refinement must produce a materially different execution plan.`

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
    systemPrompt,
  }
}

/**
 * Parse a single execution plan from a unit-level regeneration response.
 * @param {string} rawText
 * @returns {{ plan: object|null, error: string|null }}
 */
export function parseStage3UnitResponse(rawText) {
  if (!rawText?.trim()) return { plan: null, error: 'Empty response from API.' }

  let jsonStr = rawText.trim()
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) jsonStr = fenceMatch[1].trim()

  const firstBrace = jsonStr.indexOf('{')
  const lastBrace  = jsonStr.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1)
  }

  let parsed
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    return { plan: null, error: 'Could not parse JSON from unit response.' }
  }

  if (!parsed?.buName && !parsed?.mission) {
    return { plan: null, error: 'Response did not contain a valid execution plan object.' }
  }

  return { plan: normalisePlan(parsed), error: null }
}

// ── Mock generator ────────────────────────────────────────────────────────────

/**
 * Deterministic mock — produces realistic per-BU execution plans from Stage 1 + Stage 2 data.
 * Used when no API key is configured.
 */
export function generateMockStage3(stage1Snapshot, stage2Snapshot) {
  const thesis     = stage1Snapshot?.thesis          || ''
  const opportunity= stage1Snapshot?.opportunity     || ''
  const posture    = stage1Snapshot?.artifactType    || 'selective investment'
  const s1Risks    = stage1Snapshot?.risks           || []
  const s1Unknowns = stage1Snapshot?.unresolvedQuestions || []
  const decisions  = stage1Snapshot?.keyDecisions    || []
  const bUs        = stage2Snapshot?.businessUnits   || []

  const cap = (s, n = 100) => s ? (s.length > n ? s.slice(0, n) + '…' : s) : ''

  function makePlan(bu) {
    const isPrimary    = bu.involvementLevel === 'primary'
    const isInformed   = bu.involvementLevel === 'informed'
    const resps        = bu.keyResponsibilities || []
    const deps         = bu.dependencies        || []
    const risks        = bu.risksAndUnknowns    || []
    const metrics      = bu.keySuccessMetrics   || []
    const name         = bu.name

    // Derive risk scores heuristically
    const execRisk    = risks.length >= 3 ? 'high' : (risks.length >= 2 ? 'medium' : 'low')
    const depComplx   = deps.length  >= 3 ? 'high' : (deps.length  >= 2 ? 'medium' : 'low')
    const confidence  = isPrimary ? 'medium' : (isInformed ? 'high' : 'medium')
    const orgReady    = isPrimary ? 'medium' : 'high'

    const missionCritical = resps.slice(0, 2).map(r => cap(r, 80))
    const optional        = resps.slice(2, 3).map(r => `Optional: ${cap(r, 70)}`)
    const deferred        = isInformed
      ? [`Defer deeper involvement until pilot validation is complete`]
      : [`Defer detailed process documentation to phase two`]
    const blocked         = deps.length > 0
      ? [`Blocked on: ${cap(deps[0], 70)} — unblock by completing upstream milestone`]
      : []

    return {
      buName: name,
      mission: `${isPrimary ? 'Own' : isInformed ? 'Monitor' : 'Support'} the ${cap(bu.strategicInvolvement || bu.purpose, 80)} for this initiative.`,
      strategicObjectives: [
        cap(bu.purpose, 90) || `Deliver ${name} contribution to the strategy`,
        `Establish clear decision rights and handoff protocols with dependent units`,
        isPrimary ? `Lead the evidence generation required for the go/no-go gate` : `Provide structured input to the core execution team`,
      ].filter(Boolean).slice(0, 3),
      initiativesMissionCritical: missionCritical.length > 0
        ? missionCritical
        : [`Execute core ${name} responsibilities per the strategy basis`],
      initiativesOptional: optional.length > 0
        ? optional
        : [`Develop supplementary materials beyond the minimum required`],
      initiativesDeferred: deferred,
      initiativesBlocked: blocked,
      sequencingNarrative: `Phase 1 (weeks 1–6): ${isPrimary ? 'Scope and mobilise the ' + name + ' workstream; establish baseline metrics and identify dependencies.' : 'Define involvement criteria and establish communication cadence with the primary execution units.'} Phase 2 (weeks 7–16): ${isPrimary ? 'Execute the core ' + name + ' deliverables per the validation gate criteria.' : 'Monitor and provide structured input on request; escalate blockers immediately.'} Phase 3 (post-gate): Re-evaluate scope and investment level based on phase-one evidence.`,
      keyMilestones: [
        `Week 2: ${name} workstream kick-off and RACI confirmed`,
        `Week 6: Phase-one deliverables scoped and resourcing confirmed`,
        isPrimary ? `Week 14: Evidence package ready for go/no-go gate` : `Week 12: Input provided for gate review`,
      ],
      crossFunctionalDependencies: deps.slice(0, 3).map(d => cap(d, 90)).filter(Boolean),
      requiredCapabilities: [
        `${name} team requires clear strategic brief and updated context from Stage 1`,
        isPrimary ? `Domain expertise in ${cap(bu.strategicInvolvement || bu.purpose, 60)}` : `Coordination capability with primary units`,
        `Access to shared tools and data required by the initiative`,
      ].slice(0, 3),
      staffingOwnership: [
        `${isPrimary ? 'Dedicated lead required' : 'Part-time involvement acceptable'} for ${name} workstream`,
        `Ownership assigned to ${name} leadership before phase-one kick-off`,
        `Resourcing assumption is ${isInformed ? 'minimal (informed only)' : 'moderate — confirm against budget posture'}`,
      ],
      systemsTools: [
        `Shared project tracking tool required across all executing units`,
        `${name}-specific tooling requirements to be confirmed in phase-one scoping`,
      ],
      governanceCadence: [
        `Weekly ${isPrimary ? 'stand-up' : 'touch-point'} with the core execution team`,
        `Gate review participation at end of phase one`,
      ],
      decisionRights: [
        `${name} lead approves scope changes within their workstream`,
        isPrimary ? `Escalate cross-unit blockers to steering committee within 48h` : `Escalation path: ${name} lead → core execution team lead → steering`,
      ],
      risks: risks.slice(0, 2).map(r => cap(r, 90)).concat(
        [`Mock note: this is a mock-generated plan — use AI generation with an API key for context-specific analysis`]
      ).slice(0, 3),
      constraints: [
        `Investment posture is "${posture}" — phase-two commitment is conditional on phase-one evidence`,
        `${name} bandwidth is shared with existing business operations; no dedicated team assumed`,
        `Timeline is gated by upstream dependencies not yet confirmed`,
      ],
      unresolvedUnknowns: [
        (s1Unknowns[0] ? cap(s1Unknowns[0], 90) : `SME availability and commitment level within ${name} is unconfirmed`),
        `Organisational maturity of ${name} for this type of initiative is not validated`,
        `Exact budget allocation to ${name} has not been scoped against this plan`,
      ].slice(0, 3),
      assumptions: [
        { text: `${name} leadership will prioritise this initiative per the strategy direction`, type: 'inferred' },
        { text: `Current ${name} capabilities are sufficient for phase-one delivery without new hires`, type: 'speculative' },
        { text: cap(decisions[0] || `The investment posture of "${posture}" holds through phase one`, 90), type: 'fact' },
      ],
      leadingIndicators: [
        `${name} workstream kick-off completed by week 2`,
        `Phase-one deliverables scoped and accepted by week 4`,
        metrics[0] ? cap(metrics[0], 80) : `First milestone completed on schedule`,
      ].slice(0, 3),
      keySuccessMetrics: metrics.slice(0, 2).concat([
        `${name} contribution delivered without blocking the go/no-go gate`
      ]).slice(0, 3),
      failureSignals: [
        `${name} workstream misses week-2 kick-off without a documented reason`,
        `Dependencies on ${deps[0] ? cap(deps[0], 50) : 'upstream units'} remain unresolved at week 6`,
        `${name} leadership re-prioritises away from this initiative without escalation`,
      ],
      readinessAssessment: `${name} is ${isPrimary ? 'moderately ready' : 'ready with limited involvement required'} — key unknowns around resourcing and tool access should be resolved in week-one scoping. Note: mock-generated assessment.`,
      executionRisk:           execRisk,
      dependencyComplexity:    depComplx,
      confidenceLevel:         confidence,
      organizationalReadiness: orgReady,
    }
  }

  const executionPlans = bUs.map(bu => makePlan(bu))
  const thesisSnip     = thesis ? ` Thesis: ${cap(thesis, 100)}` : ''
  const oppSnip        = opportunity ? ` Opportunity: ${cap(opportunity, 80)}` : ''

  return {
    executionPlans,
    summaryNote: `Mock-generated Stage 3 execution plans for ${bUs.length} business unit${bUs.length !== 1 ? 's' : ''} under "${posture}" investment posture.${thesisSnip}${oppSnip} Top cross-cutting risk: dependency bottlenecks between primary units before the go/no-go gate. Add VITE_ANTHROPIC_API_KEY to .env.local and restart the dev server for AI-generated plans.`,
  }
}
