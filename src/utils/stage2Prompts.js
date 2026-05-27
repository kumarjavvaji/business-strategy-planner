// Stage 2 — prompt builder, mock generator, and response normaliser.
// Keeps all AI-specific business logic isolated from UI components.
// Pure functions — no React, no side effects.

import { stageSnapshotToText } from './stageSnapshots'

const STAGE_REFINEMENT_CLASSES = [
  'wording clarification',
  'existing unit responsibility change',
  'cross-functional dependency change',
  'strategic emphasis change',
  'KPI/measurement change',
  'risk/unknown change',
  'new business unit/capability needed',
  'remove business unit',
  'merge/split business units',
]

const STRUCTURAL_IMPACTS = new Set([
  'none',
  'unit_added',
  'unit_removed',
  'unit_merged',
  'ownership_changed',
  'dependencies_changed',
])

function safeStructuralImpact(value) {
  return STRUCTURAL_IMPACTS.has(value) ? value : 'none'
}

// ── AI prompt builder ─────────────────────────────────────────────────────────

/**
 * Build OpenAI messages for Stage 2 business-unit mapping.
 * @param {object} stage1Snapshot  — contentSnapshot from active Stage 1 revision
 * @returns {{ messages: Array<{ role, content }>, systemPrompt: string }}
 */
export function buildStage2Messages(stage1Snapshot) {
  const context = stageSnapshotToText(stage1Snapshot)

  const systemPrompt = `You are a strategic business analyst specialising in mapping corporate strategy to organisational execution.

Your task: Given a Stage 1 Strategy Basis document, infer the business unit structure and organisational involvement required to execute that strategy.

Draw on:
- The explicit strategic context, thesis, opportunity, and key decisions provided
- Comparable operating models for companies of this type and scale in this industry
- Standard business function coverage matched to the identified business model
- The specific execution needs implied by the investment posture and risks

Return ONLY a valid JSON object — no markdown, no prose, no code fences. Exact schema:

{
  "businessUnits": [
    {
      "name": "string — business unit or function name",
      "purpose": "string — this unit's reason for existing in this specific strategic context",
      "strategicInvolvement": "string — how this unit is involved, e.g. 'Primary driver', 'Supporting capability', 'Accountable for governance', 'Informed only'",
      "involvementLevel": "primary | supporting | informed",
      "keyResponsibilities": ["string", "..."],
      "dependencies": ["string — other units, systems, or external parties this unit depends on", "..."],
      "risksAndUnknowns": ["string", "..."],
      "keySuccessMetrics": ["string", "..."]
    }
  ],
  "summaryNote": "string — 1–2 sentence executive note on the organisational model implied by this strategy"
}

Rules:
- Include 5–8 business units
- Cover all functions genuinely implicated by the strategy; omit those with no real involvement
- Order by strategic centrality — most critical first
- Be specific to this company, strategy, and context — do not produce generic lists
- keyResponsibilities, dependencies, risksAndUnknowns, keySuccessMetrics: 2–5 items each`

  const userPrompt = `Stage 1 Strategy Basis document:

${context}

Map the organisational involvement. Return only the JSON object.`

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
    systemPrompt,
  }
}

// ── Response normaliser ───────────────────────────────────────────────────────

/**
 * Parse and normalise the raw AI text response into a Stage 2 payload.
 * @param {string} rawText
 * @returns {{ businessUnits: object[]|null, summaryNote: string, raw: string, error: string|null }}
 */
export function parseStage2Response(rawText) {
  if (!rawText?.trim()) {
    return { businessUnits: null, summaryNote: '', raw: rawText || '', error: 'Empty response from API.' }
  }

  // Strip markdown code fences if present
  let jsonStr = rawText.trim()
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) jsonStr = fenceMatch[1].trim()

  // Strip leading/trailing non-JSON characters (model sometimes adds prose)
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
      businessUnits: null,
      summaryNote:   '',
      raw:           rawText,
      error:         'Could not parse JSON from response. See raw output below.',
    }
  }

  const units = parsed?.businessUnits
  if (!Array.isArray(units) || units.length === 0) {
    return {
      businessUnits: null,
      summaryNote:   '',
      raw:           rawText,
      error:         'Response did not contain a valid businessUnits array.',
    }
  }

  const safeStr  = v => (typeof v === 'string' ? v.trim() : String(v ?? ''))
  const safeList = v => (Array.isArray(v) ? v.map(safeStr).filter(Boolean) : [])
  const LEVELS   = new Set(['primary', 'supporting', 'informed'])

  const normalised = units.map(u => ({
    name:                 safeStr(u.name)                || 'Unnamed unit',
    purpose:              safeStr(u.purpose),
    strategicInvolvement: safeStr(u.strategicInvolvement),
    involvementLevel:     LEVELS.has(u.involvementLevel) ? u.involvementLevel : 'supporting',
    keyResponsibilities:  safeList(u.keyResponsibilities),
    dependencies:         safeList(u.dependencies),
    risksAndUnknowns:     safeList(u.risksAndUnknowns),
    keySuccessMetrics:    safeList(u.keySuccessMetrics),
  }))

  return {
    businessUnits: normalised,
    summaryNote:   safeStr(parsed.summaryNote),
    refinementClassification: safeStr(parsed.refinementClassification),
    structuralImpact: safeStructuralImpact(parsed.structuralImpact),
    raw:           rawText,
    error:         null,
  }
}

// Full-stage refinement prompt builder. Unlike unit refinement, this may add,
// remove, merge, split, or reassign business units when the instruction implies
// a structural operating-model change.
export function buildStage2StageRefinementMessages(stage1Snapshot, currentStage2Snapshot, refinementPrompt, impactSummary) {
  const s1Context = stageSnapshotToText(stage1Snapshot)
  const s2Payload = JSON.stringify(currentStage2Snapshot || {}, null, 2)

  const systemPrompt = `You are a strategic business analyst regenerating the FULL Stage 2 business-unit mapping from an existing Stage 2 revision plus a user refinement.

Classify the refinement as exactly one primary class from this list:
${STAGE_REFINEMENT_CLASSES.map(c => `- ${c}`).join('\n')}

Then update the full Stage 2 JSON. The refinement may be structural. You may add, remove, merge, split, rename, reorder, or reassign business units if that is the coherent answer.

Structural rules:
- If a major client-facing role or capability is not clearly owned, either add a new unit/capability or explicitly assign it to an existing unit.
- If the refinement says frontline consultants, advisors, field operators, implementation consultants, or similar roles are the primary client-facing operators, evaluate whether to create a unit such as "Consulting & Advisory Services", "Client Advisory", "Field Consulting", or "Advisory Delivery".
- If you do not create a new consulting/advisory unit for such a refinement, assign the role explicitly to an existing unit and make that ownership visible in purpose, strategicInvolvement, responsibilities, dependencies, risks, and metrics.
- Treat ownership, primary-client-channel, dependency, KPI, risk, and strategic emphasis changes as content changes, not notes.
- Preserve coherent cross-functional dependencies after adding, removing, merging, or splitting units.

Return ONLY a valid JSON object with this exact schema:
{
  "refinementClassification": "one class from the allowed list",
  "structuralImpact": "none | unit_added | unit_removed | unit_merged | ownership_changed | dependencies_changed",
  "businessUnits": [
    {
      "name": "string",
      "purpose": "string",
      "strategicInvolvement": "string",
      "involvementLevel": "primary | supporting | informed",
      "keyResponsibilities": ["string"],
      "dependencies": ["string"],
      "risksAndUnknowns": ["string"],
      "keySuccessMetrics": ["string"]
    }
  ],
  "summaryNote": "string"
}

Use 5-9 units unless the refinement clearly requires fewer or more. Order by strategic centrality.`

  const userPrompt = `Stage 1 Strategy Basis:
${s1Context}

Current Stage 2 JSON:
${s2Payload}

Refinement instruction:
${refinementPrompt}

Optional impact summary:
${impactSummary || 'none provided'}

Regenerate the full Stage 2 business-unit mapping and return only JSON.`

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
    systemPrompt,
  }
}

// ── Unit-level refinement prompt builder ──────────────────────────────────────

/**
 * Build messages for regenerating a single business unit while preserving the rest.
 * @param {object}   stage1Snapshot    — contentSnapshot from active Stage 1 revision
 * @param {object[]} allBusinessUnits  — full current BU array (all units)
 * @param {number}   targetIndex       — 0-based index of the unit to regenerate
 * @param {string}   refinementPrompt  — the user's refinement instruction
 * @param {string}   [refinementScope] — user-indicated scope hint ('auto'|'wording'|'ownership'|'cross-fn'|'execution'|'kpi')
 * @returns {{ messages: Array<{ role, content }>, systemPrompt: string }}
 */
export function buildStage2UnitRefinementMessages(stage1Snapshot, allBusinessUnits, targetIndex, refinementPrompt, refinementScope) {
  const context    = stageSnapshotToText(stage1Snapshot)
  const targetUnit = allBusinessUnits[targetIndex]

  const otherUnitsSummary = allBusinessUnits
    .filter((_, i) => i !== targetIndex)
    .map(u => `- ${u.name} (${u.involvementLevel}): ${u.purpose || '—'}`)
    .join('\n')

  const scopeHint = (refinementScope && refinementScope !== 'auto')
    ? `\nUser-indicated refinement scope: ${refinementScope} — weight your changes accordingly.`
    : ''

  const systemPrompt = `You are a strategic business analyst regenerating ONE specific business unit inside an existing Stage 2 business unit mapping.

STEP 1 — CLASSIFY THE REFINEMENT
Before making changes, silently classify the user's refinement as one or more of:
  • wording clarification
  • ownership / emphasis change (who leads, who is primary, strategic centrality)
  • client-facing role identification (this unit interacts with or introduces the offering to clients)
  • cross-functional dependency change (changes who depends on whom)
  • KPI / measurement change
  • risk or unknown change
  • new capability or responsibility added
  • involvement level change (primary → supporting, or vice versa)

STEP 2 — APPLY THE CLASSIFICATION TO PRODUCE CONCRETE CHANGES
Apply the classification to determine which fields to update:

  • wording clarification only → update only the specific text; preserve all other fields verbatim.

  • ownership / emphasis change → MUST update: involvementLevel (elevate or reduce as implied),
    strategicInvolvement (rewrite to reflect new emphasis), purpose (update to match new role),
    keyResponsibilities (add or reorder to reflect the ownership shift).
    Also update dependencies and keySuccessMetrics where they are affected.

  • client-facing role identification → MUST update ALL of the following:
      - involvementLevel: elevate to 'primary' if the unit is the primary delivery/adoption channel
      - purpose: rewrite to include the client-facing delivery role explicitly
      - strategicInvolvement: describe the client-facing nature clearly
      - keyResponsibilities: add responsibilities for client communication, enabling adoption,
        delivering consistent messaging, and capturing client feedback
      - dependencies: add dependencies on enabling units (training, product, marketing) that
        must provide this unit with tools, messaging, and readiness support
      - risksAndUnknowns: add risks such as inconsistent messaging, insufficient readiness,
        feedback loop gaps, and adoption stall
      - keySuccessMetrics: add metrics for adoption rate, client satisfaction, readiness scores,
        and feedback loop completeness

  • cross-functional dependency change → update dependencies; note implications for responsibilities.

  • KPI change → update keySuccessMetrics; verify responsibilities are aligned.

  • risk change → update risksAndUnknowns; check if responsibilities or dependencies need adjustment.

CRITICAL RULES — FOLLOW WITHOUT EXCEPTION:
1. Treat emphasis and ownership changes as meaningful strategic changes even if the business unit
   list remains the same. A change in who is primary, who leads client interaction, or who owns
   adoption is a substantive strategic change — not cosmetic.
2. If a refinement identifies a primary client-facing role, update responsibilities, dependencies,
   risks, unknowns, and success metrics accordingly — do not leave them unchanged.
3. Do NOT return content that is materially unchanged from the current version unless the
   refinement is purely a wording clarification with zero operational impact.
   If you must leave content unchanged, you MUST explain why in the impactSummary (not in this JSON).
4. If a unit communicates the offering to clients, introduces the capability to clients, owns field
   feedback, or is the primary adoption channel, it must be treated as a client-facing delivery unit
   and its responsibilities, dependencies, and metrics must reflect that role explicitly.
5. Be specific — do not add generic placeholders. Every added item must be concrete.${scopeHint}

Preserve organisational coherence with the other units listed. Do not alter responsibilities or
dependencies that belong to other units.

Return ONLY a valid JSON object — no markdown, no prose, no code fences:

{
  "name": "string",
  "purpose": "string",
  "strategicInvolvement": "string",
  "involvementLevel": "primary | supporting | informed",
  "keyResponsibilities": ["string", "..."],
  "dependencies": ["string", "..."],
  "risksAndUnknowns": ["string", "..."],
  "keySuccessMetrics": ["string", "..."]
}

Rules: 2–5 items per list. Be specific to this company, strategy, and unit.`

  const userPrompt = `Stage 1 Strategic Context:
${context}

Other business units in this mapping (for coherence — do not modify):
${otherUnitsSummary}

Business unit to regenerate:
  Name: ${targetUnit.name}
  Current purpose: ${targetUnit.purpose || '—'}
  Current involvement: ${targetUnit.involvementLevel}
  Current strategic role: ${targetUnit.strategicInvolvement || '—'}
  Current responsibilities: ${(targetUnit.keyResponsibilities || []).join('; ') || '—'}
  Current dependencies: ${(targetUnit.dependencies || []).join('; ') || '—'}
  Current risks: ${(targetUnit.risksAndUnknowns || []).join('; ') || '—'}
  Current metrics: ${(targetUnit.keySuccessMetrics || []).join('; ') || '—'}

Refinement instruction:
${refinementPrompt}

Apply the refinement classification rules above and return the updated JSON object for "${targetUnit.name}". Make concrete changes — this refinement must produce a materially different result.`

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
    systemPrompt,
  }
}

/**
 * Parse a single business unit from a unit-level regeneration response.
 * @param {string} rawText
 * @returns {{ unit: object|null, error: string|null }}
 */
export function parseStage2UnitResponse(rawText) {
  if (!rawText?.trim()) {
    return { unit: null, error: 'Empty response from API.' }
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
    return { unit: null, error: 'Could not parse JSON from unit response.' }
  }

  if (!parsed?.name) {
    return { unit: null, error: 'Response did not contain a valid business unit object.' }
  }

  const safeStr  = v => (typeof v === 'string' ? v.trim() : String(v ?? ''))
  const safeList = v => (Array.isArray(v) ? v.map(safeStr).filter(Boolean) : [])
  const LEVELS   = new Set(['primary', 'supporting', 'informed'])

  return {
    unit: {
      name:                 safeStr(parsed.name)                || 'Unnamed unit',
      purpose:              safeStr(parsed.purpose),
      strategicInvolvement: safeStr(parsed.strategicInvolvement),
      involvementLevel:     LEVELS.has(parsed.involvementLevel) ? parsed.involvementLevel : 'supporting',
      keyResponsibilities:  safeList(parsed.keyResponsibilities),
      dependencies:         safeList(parsed.dependencies),
      risksAndUnknowns:     safeList(parsed.risksAndUnknowns),
      keySuccessMetrics:    safeList(parsed.keySuccessMetrics),
    },
    error: null,
  }
}

// ── Mock generator ────────────────────────────────────────────────────────────

/**
 * Deterministic mock — produces plausible BUs from Stage 1 snapshot data.
 * Used when no API key is configured.
 * @param {object} stage1Snapshot
 * @returns {{ businessUnits: object[], summaryNote: string }}
 */
export function generateMockStage2(stage1Snapshot) {
  const title          = stage1Snapshot.artifactTitle   || 'the strategy'
  const thesis         = stage1Snapshot.thesis          || ''
  const opportunity    = stage1Snapshot.opportunity     || ''
  const posture        = stage1Snapshot.artifactType    || 'selective investment'
  const targetCustomer = stage1Snapshot.targetCustomer  || 'target customers'
  const decisions      = stage1Snapshot.keyDecisions    || []
  const risks          = stage1Snapshot.risks           || []

  const cap  = s => s ? s.slice(0, 110) + (s.length > 110 ? '…' : '') : ''
  const dec  = i => decisions[i] ? `Execute on key decision: ${cap(decisions[i])}` : null
  const risk = i => risks[i]     ? cap(risks[i]) : null

  function compact(...items) { return items.filter(Boolean) }

  const businessUnits = [
    {
      name: 'Product & Engineering',
      purpose: `Build and own the core capability described by this strategy: ${cap(opportunity) || title}.`,
      strategicInvolvement: 'Primary driver — owns the capability build, quality validation, and iteration cycle',
      involvementLevel: 'primary',
      keyResponsibilities: compact(
        'Define and scope the phase-one technical approach aligned to the investment posture',
        'Deliver the core capability per the artifact roadmap and staged gates',
        'Instrument output quality metrics for the validation checkpoint',
        dec(0),
        'Manage phase-one to phase-two transition based on evidence',
      ),
      dependencies: [
        'Data & Analytics — structured data access and schema requirements',
        'Legal & Compliance — risk sign-off before client exposure',
        'Customer Success — pilot client access and structured feedback loops',
      ],
      risksAndUnknowns: compact(
        risk(0) || 'Internal capability inventory may reveal prior work that changes scope',
        'Timeline asymmetry vs. faster-iterating competitors is the primary execution risk',
        'Fine-tuning or advanced infrastructure cost is uncertain until phase-one evidence gathered',
      ),
      keySuccessMetrics: [
        'Phase-one delivery within timeline and approved budget',
        'Output quality meets validation gate criteria at the defined checkpoint',
        'No compliance blockers at client pilot launch',
      ],
    },
    {
      name: 'Data & Analytics',
      purpose: 'Provide data infrastructure, quality assurance, and structured datasets required for capability development and strategic evidence generation.',
      strategicInvolvement: 'Supporting capability — critical data layer for development and validation evidence',
      involvementLevel: 'supporting',
      keyResponsibilities: [
        'Audit existing internal tooling, data practices, and capability baseline',
        'Prepare and maintain structured datasets for capability development',
        'Document data lineage to meet applicable governance standards',
        'Support evidence collection for strategic validation gates',
      ],
      dependencies: [
        'Product & Engineering — to define data schema and access requirements',
        'Legal & Compliance — for data handling and client data governance',
        'Customer Success — for client data access coordination',
      ],
      risksAndUnknowns: compact(
        'Existing data quality and availability for development is unverified',
        'Client data consent for use in capability development is unconfirmed',
        risk(1) || 'Volume of usable structured data is unknown until audit',
      ),
      keySuccessMetrics: [
        'Internal tooling and capability audit complete within four weeks',
        'Data lineage documentation in place before client pilot',
        'Dataset available if phase-two is approved at the validation gate',
      ],
    },
    {
      name: 'Sales & Business Development',
      purpose: `Generate the market evidence required to validate the strategic thesis and position the capability to ${targetCustomer} before competitive alternatives close.`,
      strategicInvolvement: 'Primary driver — owns substitution evidence, buyer intelligence, and pilot client access',
      involvementLevel: 'primary',
      keyResponsibilities: compact(
        `Validate substitution risk with ${targetCustomer} through a structured interview or survey programme`,
        'Audit recent sales conversations for competitive signal frequency and framing',
        'Equip sales team with differentiation positioning for the strategic capability',
        'Feed market evidence into the product steering and validation gate process',
        dec(1),
      ),
      dependencies: [
        'Marketing — positioning materials and competitive intelligence',
        'Customer Success — warm client introductions for research access',
        'Product & Engineering — demo capability during commercial conversations',
      ],
      risksAndUnknowns: [
        `${targetCustomer} may not yet perceive the substitution risk as urgent — education required`,
        'Sales conversation audit may not have captured LLM topics systematically',
      ],
      keySuccessMetrics: [
        'Substitution research programme completed with structured findings documented',
        'Sales conversation audit delivered with competitive signal frequency data',
        'At least one pilot client committed before phase-one sprint scoping',
      ],
    },
    {
      name: 'Customer Success',
      purpose: 'Manage pilot client relationships, surface retention signals, and deliver structured feedback that validates strategic output quality versus alternatives.',
      strategicInvolvement: 'Supporting capability — owns the client evidence loop and retention signal tracking',
      involvementLevel: 'supporting',
      keyResponsibilities: [
        'Identify and secure pilot client cohort for phase-one validation',
        'Collect structured feedback on output quality relative to current alternatives',
        'Track leading retention and renewal drivers in client conversations',
        'Escalate substitution signals from client conversations to Sales and Product',
      ],
      dependencies: [
        'Sales — for client selection and commercial relationship ownership',
        'Product & Engineering — for pilot access and technical support',
      ],
      risksAndUnknowns: [
        'Leading retention drivers are not yet confirmed from primary client research',
        'Pilot clients may be reluctant to share candid substitution intent',
      ],
      keySuccessMetrics: [
        'Pilot cohort assembled and committed within four weeks',
        'Structured feedback collected from all pilot clients at defined checkpoint',
        'Retention signal data feeding into the go/no-go gate review',
      ],
    },
    {
      name: 'Legal & Compliance',
      purpose: 'Govern the regulatory and liability dimensions of the strategy, ensuring output meets applicable standards before client exposure and preserving the regulatory moat thesis.',
      strategicInvolvement: 'Accountable for governance — enables or blocks client deployment and the moat claim',
      involvementLevel: 'primary',
      keyResponsibilities: [
        'Define and document compliance requirements for the strategic capability',
        'Review and sign off on output approach before client pilot launch',
        'Govern data handling for any client data used in development',
        'Monitor the regulatory landscape for changes affecting the strategy',
      ],
      dependencies: [
        'Product & Engineering — for model risk documentation and compliance artefacts',
        'Data & Analytics — for data handling and de-identification governance',
      ],
      risksAndUnknowns: compact(
        'Compliance interpretation errors carry reputational and liability exposure beyond analytics product risk',
        risk(2) || 'Applicable regulatory standards for this capability type are not yet formally scoped',
      ),
      keySuccessMetrics: [
        'Compliance framework documented and approved before client pilot',
        'No regulatory blockers identified at pilot launch',
      ],
    },
    {
      name: 'Marketing',
      purpose: `Build positioning and messaging for the strategic capability targeting ${targetCustomer}, and monitor competitive alternatives to maintain differentiation timing.`,
      strategicInvolvement: 'Supporting capability — owns external positioning and competitive intelligence',
      involvementLevel: 'supporting',
      keyResponsibilities: [
        `Develop ${targetCustomer}-facing messaging for the strategic capability`,
        'Create differentiation materials distinguishing from general-purpose alternatives',
        'Monitor competitor announcements and capability releases on a regular cadence',
        'Support Sales with materials for pilot outreach and commercial conversations',
      ],
      dependencies: [
        'Sales — for market feedback and messaging validation',
        'Product & Engineering — for capability truth points and demo access',
      ],
      risksAndUnknowns: [
        'Competitor marketing may outpace internal positioning timeline',
        'Buyer education requirements may require more content investment than planned',
      ],
      keySuccessMetrics: [
        'Differentiation brief available before pilot outreach begins',
        'Competitive monitoring cadence established and maintained',
      ],
    },
    {
      name: 'Finance & Operations',
      purpose: `Govern the staged investment budget aligned to the "${posture}" posture, define financial criteria for go/no-go gates, and report progress to leadership.`,
      strategicInvolvement: 'Informed — holds the financial gate and executive reporting accountability',
      involvementLevel: 'informed',
      keyResponsibilities: compact(
        'Set and track phase-one investment budget within the approved posture',
        'Define financial criteria for the staged validation gate before phase-two commitment',
        'Model unit economics impact of the strategic initiative on the broader business',
        'Board-level reporting on investment progress against evidence milestones',
        dec(2),
      ),
      dependencies: [
        'Product & Engineering — for cost estimates and milestone tracking',
        'Sales — for revenue signal from pilot client cohort',
      ],
      risksAndUnknowns: [
        'Full investment cost for phase-two is uncertain until phase-one evidence is gathered',
        'Over-investment before validation evidence is the primary financial failure mode to manage',
      ],
      keySuccessMetrics: [
        'Phase-one spend within approved budget at the validation checkpoint',
        'Go/no-go financial criteria defined and board-approved before the checkpoint date',
      ],
    },
  ]

  const thesisSnip = thesis ? ` Strategic thesis: ${cap(thesis)}` : ''
  return {
    businessUnits,
    summaryNote: `Inferred from "${title}" (${posture}).${thesisSnip} The operating model implies cross-functional execution led by Product & Engineering and Sales, governed by Legal & Compliance on the regulatory dimension. Finance holds the go/no-go gate at each staged checkpoint. Note: this is a mock-generated structure based on Stage 1 context — use AI generation with a configured API key for a context-specific analysis.`,
  }
}
