// Stage 2 — prompt builder, mock generator, and response normaliser.
// Keeps all AI-specific business logic isolated from UI components.
// Pure functions — no React, no side effects.

import { stageSnapshotToText } from './stageSnapshots'

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
    raw:           rawText,
    error:         null,
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
