// Stage 3 — prompt builder, mock generator, and response normaliser.
// Translates active Stage 1 strategy + Stage 2 BU mapping into per-BU execution plans.
// Pure functions — no React, no side effects.

import { stageSnapshotToText, stage2SnapshotToText } from './stageSnapshots'

// ── Shared helpers ────────────────────────────────────────────────────────────

const safeStr  = v => (typeof v === 'string' ? v.trim() : String(v ?? ''))
const safeList = v => (Array.isArray(v) ? v.map(safeStr).filter(Boolean) : [])
const LEVELS   = new Set(['low', 'medium', 'high'])
const ATYPES   = new Set(['fact', 'inferred', 'speculative'])
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

function safeLevel(v) { return LEVELS.has(v) ? v : 'medium' }
function safeStructuralImpact(v) { return STRUCTURAL_IMPACTS.has(v) ? v : 'none' }

const EXECUTION_LENS_NAMES = [
  'compliance/governance',
  'auditability',
  'regulatory validation',
  'platform/architecture',
  'infrastructure scalability',
  'delivery/operations',
  'enablement/training',
  'client advisory',
  'GTM/messaging',
  'marketing/commercialization',
  'finance/commercial gating',
  'vendor coordination',
  'implementation readiness',
  'data governance',
  'operational support',
  'escalation management',
  'organizational change management',
]

function safeAssumptions(v) {
  if (!Array.isArray(v)) return []
  return v
    .map(a => ({
      text: safeStr(a?.text || a?.assumption || a),
      type: ATYPES.has(a?.type) ? a.type : 'inferred',
    }))
    .filter(a => a.text)
}

function safeExecutionLenses(v) {
  if (!Array.isArray(v)) return []
  return v
    .map(lens => {
      if (typeof lens === 'string') {
        return { name: safeStr(lens), focus: '', actions: [], risks: [], validation: [] }
      }
      return {
        name:       safeStr(lens?.name || lens?.lens),
        focus:      safeStr(lens?.focus || lens?.purpose),
        actions:    safeList(lens?.actions || lens?.workstreams),
        risks:      safeList(lens?.risks),
        validation: safeList(lens?.validation || lens?.evidence),
      }
    })
    .filter(lens => lens.name || lens.focus || lens.actions.length || lens.risks.length || lens.validation.length)
}

// ── Schema string (shared between full and unit prompts) ──────────────────────

const BU_PLAN_SCHEMA = `{
  "strategicRole": "string - concise explanation of why this BU matters in the strategy",
  "priorityOutcomes": ["string - universal core, 2-3 outcome statements"],
  "criticalWorkstreams": ["string - universal core, 2-4 concrete workstreams"],
  "executionLenses": [
    {
      "name": "one relevant execution lens",
      "focus": "why this lens matters for this BU",
      "actions": ["string - materially useful actions only"],
      "risks": ["string - lens-specific risk only"],
      "validation": ["string - evidence or validation need only"]
    }
  ],
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

const DOMAIN_ADAPTIVE_STAGE3_RULES = `
STAGE SEMANTICS:
- Stage 2 is organizational capability topology: what capabilities exist, what they own, and how they interact.
- Stage 3 is domain-adaptive operationalization: how operators execute, validate, govern, coordinate, and assess the strategy.
- Do not move Stage 2 mapping work into Stage 3, and do not turn every Stage 3 plan into the same enterprise template.

DOMAIN-ADAPTIVE EXECUTION RULES:
1. Every business unit needs a concise universal execution core: mission, strategicRole, priorityOutcomes, criticalWorkstreams, dependencies, constraints, risks/unknowns, success/failure indicators, and readinessAssessment.
2. Additional detail must adapt to the BU and strategy context. Emphasize only materially useful dimensions based on operational burden, regulatory exposure, technical complexity, client-facing responsibility, GTM dependency, maturity, implementation risk, and uncertainty.
3. Use executionLenses only when relevant. Candidate lenses: ${EXECUTION_LENS_NAMES.join('; ')}.
4. Omit irrelevant sections by returning empty arrays or empty strings. Empty is better than generic filler.
5. Preserve executive readability and SME actionability. Prefer short concrete items over exhaustive consultant-style sections.
6. Compliance units should emphasize auditability, evidence generation, regulatory timing, approvals, and liability exposure.
7. Technology units should emphasize architecture, integration, observability, scalability, and infrastructure dependencies.
8. Delivery/advisory units should emphasize enablement, client trust, field readiness, narrative consistency, escalation routing, and feedback loops.
9. Sales/marketing units should emphasize positioning, adoption, messaging coordination, and commercialization readiness.
10. Finance units should emphasize investment posture, ROI assumptions, commercial gating, and operational leverage.

DOMAIN-CONTEXT SPECIFICITY:
- For each business unit, first infer what domain of work this unit represents, what decisions its SMEs own, what operational realities those SMEs would recognize, which constraints/risks/dependencies/validation needs/success signals are specific to that domain, and what information a real SME would need to trust, correct, and operationalize the plan.
- Generate the execution plan around that domain-specific operating reality.
- If the output could apply to almost any business unit, it is too generic and should be regenerated with stronger domain specificity.
`

function parseJsonObject(rawText, emptyError = 'Empty response from API.') {
  if (!rawText?.trim()) return { parsed: null, error: emptyError }
  let jsonStr = rawText.trim()
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) jsonStr = fenceMatch[1].trim()
  const firstBrace = jsonStr.indexOf('{')
  const lastBrace  = jsonStr.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1)
  }
  try {
    return { parsed: JSON.parse(jsonStr), error: null }
  } catch {
    return { parsed: null, error: 'Could not parse JSON from response. See raw output below.' }
  }
}

function normaliseCoordinationLayer(c) {
  return {
    executionSummary:                 safeStr(c?.executionSummary),
    sequencingOverview:               safeStr(c?.sequencingOverview),
    dependencyCoordinationMap:        safeList(c?.dependencyCoordinationMap),
    governanceModel:                  safeList(c?.governanceModel),
    organizationalBottlenecks:        safeList(c?.organizationalBottlenecks),
    sharedRisks:                      safeList(c?.sharedRisks),
    sharedUnknowns:                   safeList(c?.sharedUnknowns),
    operationalReadinessOverview:     safeStr(c?.operationalReadinessOverview),
    crossFunctionalSuccessMetrics:    safeList(c?.crossFunctionalSuccessMetrics),
    escalationDecisionOwnership:      safeList(c?.escalationDecisionOwnership),
    criticalExecutionPath:            safeList(c?.criticalExecutionPath),
    parallelizableWorkstreams:        safeList(c?.parallelizableWorkstreams),
    confidenceReadinessAssessment:    safeStr(c?.confidenceReadinessAssessment),
  }
}

function stage1Summary(stage1Snapshot) {
  return [
    `Thesis: ${safeStr(stage1Snapshot?.thesis)}`,
    `Business problem: ${safeStr(stage1Snapshot?.businessProblem)}`,
    `Opportunity: ${safeStr(stage1Snapshot?.opportunity)}`,
    `Direction: ${safeStr(stage1Snapshot?.recommendedDirection)}`,
    `Posture: ${safeStr(stage1Snapshot?.artifactType)}`,
    `Target customer: ${safeStr(stage1Snapshot?.targetCustomer)}`,
    `Unknowns: ${(stage1Snapshot?.unresolvedQuestions || []).slice(0, 4).join('; ')}`,
  ].filter(line => !line.endsWith(': ')).join('\n')
}

function businessUnitSummary(unit) {
  const planningContext = unit?.stage3PlanningContext || {}
  const rawLikelySections = Array.isArray(planningContext.likelyExecutionSections)
    ? planningContext.likelyExecutionSections
    : []
  const likelySections = safeList(
    rawLikelySections.map(section => (
      typeof section === 'string'
        ? section
        : [
            section?.name,
            section?.purpose,
            section?.whyThisSectionMatters,
          ].filter(Boolean).join(' - ')
    )),
  )
  const planningLines = planningContext && Object.keys(planningContext).length
    ? `
Stage 3 planning handoff:
Domain of work: ${safeStr(planningContext.domainOfWork)}
SME review lens: ${typeof planningContext.SMEReviewLens === 'string' ? safeStr(planningContext.SMEReviewLens) : safeStr(planningContext.SMEReviewLens?.summary || planningContext.SMEReviewLens?.reviewerProfile)}
Likely execution sections: ${likelySections.join('; ')}
Critical dependencies to explore: ${safeList(planningContext.criticalDependenciesToExplore).join('; ')}
Risk themes to explore: ${safeList(planningContext.riskThemesToExplore).join('; ')}
Constraints to carry forward: ${safeList(planningContext.constraintsToCarryForward).join('; ')}
Unresolved Stage 3 questions: ${safeList(planningContext.unresolvedQuestionsForStage3).join('; ')}
Validation needs: ${safeList(planningContext.validationNeedsForStage3).join('; ')}
Stage 4 implications: ${safeList(planningContext.stage4DeliveryImplications).join('; ')}
Prior refinements to preserve: ${safeList(planningContext.priorRefinementsToPreserve).join('; ')}`
    : ''
  return `Name: ${unit?.name || unit?.buName || 'Unnamed unit'}
Purpose: ${unit?.purpose || ''}
Strategic involvement: ${unit?.strategicInvolvement || ''}
Involvement level: ${unit?.involvementLevel || ''}
Responsibilities: ${(unit?.keyResponsibilities || []).join('; ')}
Dependencies: ${(unit?.dependencies || []).join('; ')}
Risks/unknowns: ${(unit?.risksAndUnknowns || []).join('; ')}
Success metrics: ${(unit?.keySuccessMetrics || []).join('; ')}${planningLines}`
}

export function buildStage3CoordinationMessages(stage1Snapshot, stage2Snapshot, refinement = {}) {
  const s1Context = stage1Summary(stage1Snapshot)
  const s2Context = stage2SnapshotToText(stage2Snapshot)
  const refinementBlock = refinement?.prompt
    ? `\nStage-level refinement: ${refinement.prompt}\nImpact summary: ${refinement.impactSummary || 'none'}\nCurrent Stage 3 summary: ${refinement.currentSummary || 'none'}`
    : ''

  const systemPrompt = `You are generating the Stage 3 cross-functional coordination layer before any individual business-unit plans are generated.

Stage 3 is domain-adaptive operationalization. Produce the operating spine that the BU plans must align to, not the BU plans themselves.

${DOMAIN_ADAPTIVE_STAGE3_RULES}

If a stage-level refinement implies add/remove/merge/split/reassignment of execution units, return executionUnits in the order they should be generated. Otherwise mirror the Stage 2 business-unit list.

Return ONLY JSON:
{
  "coordinationLayer": {
    "executionSummary": "string",
    "sequencingOverview": "string",
    "dependencyCoordinationMap": ["string"],
    "governanceModel": ["string"],
    "organizationalBottlenecks": ["string"],
    "sharedRisks": ["string"],
    "sharedUnknowns": ["string"],
    "operationalReadinessOverview": "string",
    "crossFunctionalSuccessMetrics": ["string"],
    "escalationDecisionOwnership": ["string"],
    "criticalExecutionPath": ["string"],
    "parallelizableWorkstreams": ["string"],
    "confidenceReadinessAssessment": "string"
  },
  "executionUnits": [
    {
      "name": "string",
      "sourceStage2Name": "string or empty",
      "purpose": "string",
      "strategicInvolvement": "string",
      "involvementLevel": "primary | supporting | informed",
      "keyResponsibilities": ["string"],
      "dependencies": ["string"],
      "risksAndUnknowns": ["string"],
      "keySuccessMetrics": ["string"]
    }
  ],
  "summaryNote": "2-sentence executive execution posture note",
  "refinementClassification": "string if refinement was provided",
  "structuralImpact": "none | unit_added | unit_removed | unit_merged | ownership_changed | dependencies_changed"
}`

  const userPrompt = `Stage 1 summary:
${s1Context}

Stage 2 business-unit mapping:
${s2Context}
${refinementBlock}

Generate the coordination layer and ordered execution units.`

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    systemPrompt,
  }
}

export function parseStage3CoordinationResponse(rawText, fallbackUnits = []) {
  const { parsed, error } = parseJsonObject(rawText)
  if (error) return { coordinationLayer: null, executionUnits: null, summaryNote: '', raw: rawText || '', error }
  if (!parsed?.coordinationLayer) {
    return { coordinationLayer: null, executionUnits: null, summaryNote: '', raw: rawText || '', error: 'Response did not contain a coordinationLayer object.' }
  }
  const units = Array.isArray(parsed.executionUnits) && parsed.executionUnits.length
    ? parsed.executionUnits
    : fallbackUnits
  return {
    coordinationLayer: normaliseCoordinationLayer(parsed.coordinationLayer),
    executionUnits: units.map(u => ({
      name:                 safeStr(u.name || u.sourceStage2Name) || 'Unnamed unit',
      sourceStage2Name:     safeStr(u.sourceStage2Name || u.name),
      purpose:              safeStr(u.purpose),
      strategicInvolvement: safeStr(u.strategicInvolvement),
      involvementLevel:     ['primary', 'supporting', 'informed'].includes(u.involvementLevel) ? u.involvementLevel : 'supporting',
      keyResponsibilities:  safeList(u.keyResponsibilities),
      dependencies:         safeList(u.dependencies),
      risksAndUnknowns:     safeList(u.risksAndUnknowns),
      keySuccessMetrics:    safeList(u.keySuccessMetrics),
    })),
    summaryNote: safeStr(parsed.summaryNote),
    refinementClassification: safeStr(parsed.refinementClassification),
    structuralImpact: safeStructuralImpact(parsed.structuralImpact),
    raw: rawText,
    error: null,
  }
}

export function buildStage3BusinessUnitMessages(stage1Snapshot, stage2Snapshot, unit, refinement = {}) {
  const otherUnitNames = (stage2Snapshot?.businessUnits || [])
    .filter(u => u.name !== (unit?.name || unit?.sourceStage2Name))
    .map(u => u.name)
    .join(', ')
  const refinementBlock = refinement?.prompt
    ? `\nRelevant refinement: ${refinement.prompt}\nImpact summary: ${refinement.impactSummary || 'none'}`
    : ''

  const systemPrompt = `You are generating ONE complete Stage 3 business-unit execution plan. Do not generate any other units.

${DOMAIN_ADAPTIVE_STAGE3_RULES}

Every BU needs a concise universal execution core: mission, strategic role, priority outcomes, critical workstreams, dependencies, constraints, risks/unknowns, success/failure indicators, and readiness/confidence assessment.

Omit irrelevant sections by returning empty arrays or empty strings. Preserve domain-context specificity: a competent SME in this unit should recognize the operating reality and be able to validate, correct, and act on the plan.

Return ONLY JSON:
${BU_PLAN_SCHEMA}`

  const userPrompt = `Stage 1 summary:
${stage1Summary(stage1Snapshot)}

Business unit to generate:
${businessUnitSummary(unit)}

Other business unit names (for dependency awareness only):
${otherUnitNames || 'none'}
${refinementBlock}

Generate one domain-specific execution plan for "${unit?.name || unit?.sourceStage2Name}".`

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    systemPrompt,
  }
}

// ── Hierarchical BU generation ────────────────────────────────────────────────
// Per-BU: structure call → section calls → client-side assembly
// Sections map 1:1 to normalisePlan fields — no AI needed for assembly.

export const SECTION_KEYS = ['workstreams', 'dependencies', 'operations', 'risk', 'measurement', 'lenses']

export const SECTION_LABELS = {
  workstreams:  'Prioritized Initiatives & Sequencing',
  dependencies: 'Cross-functional Dependencies & Capabilities',
  operations:   'Staffing, Governance & Operations',
  risk:         'Risks, Constraints & Unknowns',
  measurement:  'Measurement & Readiness',
  lenses:       'Domain Execution Lenses',
}

const SECTION_SCHEMAS = {
  workstreams: `{
  "initiativesMissionCritical": ["string — must happen; blocks all else — 2-4 items"],
  "initiativesOptional": ["string — value-add, not blocking — 1-2 items"],
  "initiativesDeferred": ["string — explicitly deferred with reason — 1-2 items"],
  "initiativesBlocked": ["string — blocked: name the blocker — 0-2 items, empty array if none"],
  "sequencingNarrative": "string — what gates what across phases, 2-3 sentences",
  "keyMilestones": ["string — milestone + rough timing — 2-3 items"]
}`,
  dependencies: `{
  "crossFunctionalDependencies": ["string — dependency + owning BU — 2-3 items"],
  "requiredCapabilities": ["string — capability gap or specific need — 2-3 items"]
}`,
  operations: `{
  "staffingOwnership": ["string — role/headcount/ownership — 2-3 items"],
  "systemsTools": ["string — specific tool, system, or process — 1-3 items"],
  "governanceCadence": ["string — governance rhythm or checkpoint — 1-2 items"],
  "decisionRights": ["string — who decides what, explicitly — 1-2 items"]
}`,
  risk: `{
  "risks": ["string — specific risk in this BU's execution context — 2-3 items"],
  "constraints": ["string — hard constraint bounding this BU — 2-3 items"],
  "unresolvedUnknowns": ["string — genuine gap not yet answered — 2-3 items"],
  "assumptions": [{ "text": "string", "type": "fact | inferred | speculative" }]
}`,
  measurement: `{
  "leadingIndicators": ["string — early signal before outcomes arrive — 2-3 items"],
  "keySuccessMetrics": ["string — measurable outcome — 2-3 items"],
  "failureSignals": ["string — early warning the plan is failing — 2-3 items"],
  "readinessAssessment": "string — honest 1-sentence readiness assessment"
}`,
  lenses: `{
  "executionLenses": [
    {
      "name": "one relevant execution lens",
      "focus": "why this lens matters for this BU",
      "actions": ["string — materially useful action only"],
      "risks": ["string — lens-specific risk only"],
      "validation": ["string — evidence or validation need only"]
    }
  ]
}`,
}

export function buildBUStructureMessages(stage1Snapshot, s2Unit, otherUnitNames, refinement = {}) {
  const refinementBlock = refinement?.prompt
    ? `\nPrior refinement affecting this BU: ${refinement.prompt}\nImpact: ${refinement.impactSummary || 'none'}`
    : ''

  const systemPrompt = `You are determining the execution structure for ONE business unit in Stage 3 of a strategy operationalization.

Stage 3 is domain-adaptive operationalization: how operators execute, validate, govern, coordinate, and assess the strategy.

Your task:
1. Infer what domain of work this unit represents.
2. Infer what operational realities its SMEs would recognize.
3. Determine which execution section groups are needed. Choose from:
   - workstreams — always include
   - dependencies — always include
   - operations — include unless this BU is purely "informed" (no delivery ownership)
   - risk — always include
   - measurement — always include
   - lenses — include ONLY if this domain has clear relevant execution lenses (compliance/regulatory, platform/architecture, delivery/operations, GTM/messaging, finance/commercial)
4. Provide the universal core execution fields.

${DOMAIN_ADAPTIVE_STAGE3_RULES}

Return ONLY JSON:
{
  "buName": "string — exact name of the business unit",
  "domain": "string — inferred domain of work (e.g. 'model risk governance', 'GTM and commercial launch')",
  "smeLens": "string — what a domain SME cares about most for this initiative",
  "mission": "string — 1-sentence operator-style mission (no generic language)",
  "strategicRole": "string — why this BU matters in this strategy",
  "priorityOutcomes": ["string — 2-3 concrete outcome statements"],
  "criticalWorkstreams": ["string — 2-4 high-level workstreams (brief; detail generated in sections)"],
  "executionRisk": "low | medium | high",
  "dependencyComplexity": "low | medium | high",
  "confidenceLevel": "low | medium | high",
  "organizationalReadiness": "low | medium | high",
  "sections": ["workstreams", "dependencies", "risk", "measurement"]
}`

  const userPrompt = `Stage 1 summary:
${stage1Summary(stage1Snapshot)}

Business unit to structure:
${businessUnitSummary(s2Unit)}

Other unit names (for dependency awareness): ${otherUnitNames || 'none'}
${refinementBlock}

Determine the execution structure for "${s2Unit?.name || s2Unit?.buName}".`

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
    systemPrompt,
  }
}

export function parseBUStructureResponse(rawText) {
  const { parsed, error } = parseJsonObject(rawText)
  if (error) return { structure: null, error }
  if (!parsed?.buName) return { structure: null, error: 'BU structure response missing buName.' }

  // Always include workstreams/risk/measurement; validate others against known keys
  const validKeys = new Set(SECTION_KEYS)
  const rawSections = Array.isArray(parsed.sections) ? parsed.sections : []
  const sections = [...new Set([
    'workstreams', 'risk', 'measurement',
    ...rawSections.filter(s => validKeys.has(s)),
  ])]

  return {
    structure: {
      buName:                  safeStr(parsed.buName),
      domain:                  safeStr(parsed.domain),
      smeLens:                 safeStr(parsed.smeLens),
      mission:                 safeStr(parsed.mission),
      strategicRole:           safeStr(parsed.strategicRole),
      priorityOutcomes:        safeList(parsed.priorityOutcomes),
      criticalWorkstreams:     safeList(parsed.criticalWorkstreams),
      executionRisk:           safeLevel(parsed.executionRisk),
      dependencyComplexity:    safeLevel(parsed.dependencyComplexity),
      confidenceLevel:         safeLevel(parsed.confidenceLevel),
      organizationalReadiness: safeLevel(parsed.organizationalReadiness),
      sections,
    },
    error: null,
  }
}

export function buildBUSectionMessages(stage1Snapshot, s2Unit, structure, sectionKey, otherUnitNames, refinement = {}) {
  const label  = SECTION_LABELS[sectionKey] || sectionKey
  const schema = SECTION_SCHEMAS[sectionKey] || '{}'
  const refinementBlock = refinement?.prompt
    ? `\nPrior refinement affecting this BU: ${refinement.prompt}\nImpact: ${refinement.impactSummary || 'none'}`
    : ''

  const systemPrompt = `You are generating the "${label}" section of a Stage 3 business-unit execution plan.

Domain: ${structure.domain || 'business execution'}
SME lens: ${structure.smeLens || 'operational execution'}

Stage 3 is domain-adaptive operationalization. This section must reflect the specific operational realities of this BU and domain — not generic PMO content. If the output could apply to almost any BU, it is too generic.

Preserve prior refinements that materially affect this section. Do not trade strategic depth for brevity.

Return ONLY JSON matching this exact schema:
${schema}`

  const userPrompt = `Stage 1 summary:
${stage1Summary(stage1Snapshot)}

Business unit:
${businessUnitSummary(s2Unit)}

BU execution core (already determined):
  Mission: ${structure.mission}
  Strategic role: ${structure.strategicRole}
  Priority outcomes: ${(structure.priorityOutcomes || []).join('; ')}
  Critical workstreams: ${(structure.criticalWorkstreams || []).join('; ')}
  Execution risk: ${structure.executionRisk} · Readiness: ${structure.organizationalReadiness}

Other unit names: ${otherUnitNames || 'none'}
${refinementBlock}

Generate the "${label}" section for "${s2Unit?.name || s2Unit?.buName}".`

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
    systemPrompt,
  }
}

export function parseBUSectionResponse(sectionKey, rawText) {
  const { parsed, error } = parseJsonObject(rawText)
  if (error) return { section: null, error }
  if (!parsed) return { section: null, error: 'Empty section response.' }
  switch (sectionKey) {
    case 'workstreams': return { section: {
      initiativesMissionCritical: safeList(parsed.initiativesMissionCritical),
      initiativesOptional:        safeList(parsed.initiativesOptional),
      initiativesDeferred:        safeList(parsed.initiativesDeferred),
      initiativesBlocked:         safeList(parsed.initiativesBlocked),
      sequencingNarrative:        safeStr(parsed.sequencingNarrative),
      keyMilestones:              safeList(parsed.keyMilestones),
    }, error: null }
    case 'dependencies': return { section: {
      crossFunctionalDependencies: safeList(parsed.crossFunctionalDependencies),
      requiredCapabilities:        safeList(parsed.requiredCapabilities),
    }, error: null }
    case 'operations': return { section: {
      staffingOwnership: safeList(parsed.staffingOwnership),
      systemsTools:      safeList(parsed.systemsTools),
      governanceCadence: safeList(parsed.governanceCadence),
      decisionRights:    safeList(parsed.decisionRights),
    }, error: null }
    case 'risk': return { section: {
      risks:              safeList(parsed.risks),
      constraints:        safeList(parsed.constraints),
      unresolvedUnknowns: safeList(parsed.unresolvedUnknowns),
      assumptions:        safeAssumptions(parsed.assumptions),
    }, error: null }
    case 'measurement': return { section: {
      leadingIndicators:   safeList(parsed.leadingIndicators),
      keySuccessMetrics:   safeList(parsed.keySuccessMetrics),
      failureSignals:      safeList(parsed.failureSignals),
      readinessAssessment: safeStr(parsed.readinessAssessment),
    }, error: null }
    case 'lenses': return { section: {
      executionLenses: safeExecutionLenses(parsed.executionLenses),
    }, error: null }
    default: return { section: parsed, error: null }
  }
}

// Client-side assembly — no AI call needed.
// Maps structure core + completed section outputs into one normalisePlan-compatible object.
export function assembleBUPlan(structure, sections) {
  const ws  = sections.workstreams  || {}
  const dep = sections.dependencies || {}
  const ops = sections.operations   || {}
  const rsk = sections.risk         || {}
  const msr = sections.measurement  || {}
  const lns = sections.lenses       || {}
  return normalisePlan({
    buName:                      structure.buName,
    mission:                     structure.mission,
    strategicRole:               structure.strategicRole,
    priorityOutcomes:            structure.priorityOutcomes            || [],
    criticalWorkstreams:         structure.criticalWorkstreams         || [],
    executionRisk:               structure.executionRisk,
    dependencyComplexity:        structure.dependencyComplexity,
    confidenceLevel:             structure.confidenceLevel,
    organizationalReadiness:     structure.organizationalReadiness,
    initiativesMissionCritical:  ws.initiativesMissionCritical        || [],
    initiativesOptional:         ws.initiativesOptional               || [],
    initiativesDeferred:         ws.initiativesDeferred               || [],
    initiativesBlocked:          ws.initiativesBlocked                || [],
    sequencingNarrative:         ws.sequencingNarrative               || '',
    keyMilestones:               ws.keyMilestones                     || [],
    crossFunctionalDependencies: dep.crossFunctionalDependencies       || [],
    requiredCapabilities:        dep.requiredCapabilities              || [],
    staffingOwnership:           ops.staffingOwnership                 || [],
    systemsTools:                ops.systemsTools                      || [],
    governanceCadence:           ops.governanceCadence                 || [],
    decisionRights:              ops.decisionRights                    || [],
    risks:                       rsk.risks                             || [],
    constraints:                 rsk.constraints                       || [],
    unresolvedUnknowns:          rsk.unresolvedUnknowns                || [],
    assumptions:                 rsk.assumptions                       || [],
    leadingIndicators:           msr.leadingIndicators                 || [],
    keySuccessMetrics:           msr.keySuccessMetrics                 || [],
    failureSignals:              msr.failureSignals                    || [],
    readinessAssessment:         msr.readinessAssessment               || '',
    executionLenses:             lns.executionLenses                   || [],
  })
}

// ── Coordination synthesis (BU-first: runs after all BU plans complete) ───────

function buildCoordinationEvidencePacket(plan, idx) {
  const mc   = (plan.initiativesMissionCritical || []).slice(0, 2).join('; ')
  const deps = (plan.crossFunctionalDependencies || []).slice(0, 3).join('; ')
  const out  = (plan.criticalWorkstreams || []).slice(0, 2).join('; ')
  const cons = (plan.constraints || []).slice(0, 2).join('; ')
  const risk = (plan.risks || []).slice(0, 2).join('; ')
  const unk  = (plan.unresolvedUnknowns || []).slice(0, 2).join('; ')
  const gov  = (plan.governanceCadence || []).slice(0, 1).join('; ')
  const dec  = (plan.decisionRights || []).slice(0, 1).join('; ')
  const s4   = (plan.failureSignals || []).slice(0, 1).join('; ')
  return `${idx + 1}. ${plan.buName} [exec_risk=${plan.executionRisk} readiness=${plan.organizationalReadiness}]
   Mission: ${(plan.mission || '').slice(0, 120)}
   Priority outcomes: ${(plan.priorityOutcomes || []).slice(0, 2).join('; ')}
   Mission-critical initiatives: ${mc}
   Outputs provided: ${out}
   Dependencies on other BUs: ${deps}
   Constraints: ${cons}
   Risks: ${risk}
   Unknowns: ${unk}
   Governance: ${gov}
   Key decisions needing coordination: ${dec}
   Failure early-warning: ${s4}`
}

export function buildStage3CoordinationSynthesisMessages(stage1Snapshot, completedPlans, refinement = {}) {
  const s1Context   = stage1Summary(stage1Snapshot)
  const buSummaries = completedPlans
    .map((plan, i) => buildCoordinationEvidencePacket(plan, i))
    .join('\n\n')
  const refinementBlock = refinement?.prompt
    ? `\nRefinement context: ${refinement.prompt}\nImpact: ${refinement.impactSummary || 'none'}`
    : ''

  const systemPrompt = `You are synthesizing a cross-functional coordination layer from completed per-BU execution plans.

Do NOT generate BU execution plans. Synthesize only cross-BU coordination.

Return ONLY JSON:
{
  "coordinationLayer": {
    "executionSummary": "string — 2-sentence overall execution posture",
    "sequencingOverview": "string — which BUs must sequence before others and why",
    "dependencyCoordinationMap": ["string — specific cross-BU dependency with owning BU"],
    "governanceModel": ["string — governance checkpoint or decision authority"],
    "organizationalBottlenecks": ["string — specific bottleneck with owning BU"],
    "sharedRisks": ["string — risk shared across 2+ BUs"],
    "sharedUnknowns": ["string — unresolved question blocking multiple BUs"],
    "operationalReadinessOverview": "string — honest cross-BU readiness assessment",
    "crossFunctionalSuccessMetrics": ["string — metric requiring multiple BUs"],
    "escalationDecisionOwnership": ["string — who escalates what, explicitly"],
    "criticalExecutionPath": ["string — ordered steps on the critical path"],
    "parallelizableWorkstreams": ["string — BU workstreams that can run concurrently"],
    "confidenceReadinessAssessment": "string — overall confidence and readiness assessment"
  },
  "summaryNote": "string — 2-sentence executive execution posture note"
}`

  const userPrompt = `Stage 1 summary:
${s1Context}

Completed BU execution plan summaries (${completedPlans.length} units):
${buSummaries}
${refinementBlock}

Synthesize the cross-functional coordination layer. Do not repeat or generate BU plans.`

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
    systemPrompt,
  }
}

export function parseStage3CoordinationSynthesisResponse(rawText) {
  const { parsed, error } = parseJsonObject(rawText)
  if (error) return { coordinationLayer: null, summaryNote: '', error }
  if (!parsed?.coordinationLayer) {
    return {
      coordinationLayer: null,
      summaryNote: '',
      error: 'Response did not contain a coordinationLayer object.',
    }
  }
  return {
    coordinationLayer: normaliseCoordinationLayer(parsed.coordinationLayer),
    summaryNote:       safeStr(parsed.summaryNote),
    error:             null,
  }
}

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

${DOMAIN_ADAPTIVE_STAGE3_RULES}

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
    refinementClassification: safeStr(parsed.refinementClassification),
    structuralImpact: safeStructuralImpact(parsed.structuralImpact),
    raw:            rawText,
    error:          null,
  }
}

function normalisePlan(p) {
  const priorityOutcomes = safeList(p.priorityOutcomes || p.strategicObjectives)
  const criticalWorkstreams = safeList(p.criticalWorkstreams || p.initiativesMissionCritical)
  const legacyObjectives = safeList(p.strategicObjectives)
  const legacyCritical = safeList(p.initiativesMissionCritical)
  return {
    buName:                       safeStr(p.buName)                || 'Unnamed unit',
    mission:                      safeStr(p.mission),
    strategicRole:                safeStr(p.strategicRole || p.strategicInvolvement),
    priorityOutcomes,
    criticalWorkstreams,
    executionLenses:              safeExecutionLenses(p.executionLenses),
    strategicObjectives:          legacyObjectives.length ? legacyObjectives : priorityOutcomes,
    initiativesMissionCritical:   legacyCritical.length ? legacyCritical : criticalWorkstreams,
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

// Full-stage refinement prompt builder. This can restructure the execution-plan
// package by adding/removing/merging/splitting plans when the operating model
// implied by Stage 2 plus the user refinement requires it.
export function buildStage3StageRefinementMessages(
  stage1Snapshot, stage2Snapshot, currentStage3Snapshot, refinementPrompt, impactSummary,
) {
  const s1Context = stageSnapshotToText(stage1Snapshot)
  const s2Context = stage2SnapshotToText(stage2Snapshot)
  const s3Payload = JSON.stringify(currentStage3Snapshot || {}, null, 2)

  const systemPrompt = `You are an execution strategist regenerating the FULL Stage 3 execution-plan package from the upstream stages, an existing Stage 3 revision, and a user refinement.

Classify the refinement as exactly one primary class from this list:
${STAGE_REFINEMENT_CLASSES.map(c => `- ${c}`).join('\n')}

Then update the full Stage 3 JSON. The refinement may be structural. You may add, remove, merge, split, rename, reorder, or reassign execution plans if that is the coherent answer.

Structural rules:
- If a major client-facing role or capability is not clearly owned, either add a new execution plan/capability or explicitly assign it to an existing plan.
- If the refinement says frontline consultants, advisors, field operators, implementation consultants, or similar roles are the primary client-facing operators, evaluate whether there should be an execution plan for "Consulting & Advisory Services", "Client Advisory", "Field Consulting", or "Advisory Delivery".
- If you do not create a new consulting/advisory plan for such a refinement, assign the role explicitly to an existing plan and make that ownership visible in mission, mission-critical initiatives, staffingOwnership, dependencies, systemsTools, leadingIndicators, keySuccessMetrics, failureSignals, and readinessAssessment.
- Treat ownership, primary-client-channel, dependency, KPI, risk, and strategic emphasis changes as content changes, not notes.
- Preserve one coherent execution package; update dependencies and sequencing after any structural change.

${DOMAIN_ADAPTIVE_STAGE3_RULES}

Return ONLY a valid JSON object with this exact schema:
{
  "refinementClassification": "one class from the allowed list",
  "structuralImpact": "none | unit_added | unit_removed | unit_merged | ownership_changed | dependencies_changed",
  "executionPlans": [
    ${BU_PLAN_SCHEMA}
  ],
  "summaryNote": "string"
}

Normally produce one executionPlan per Stage 2 business unit. If the refinement requires an additional cross-cutting capability plan, include it and explain why in summaryNote.`

  const userPrompt = `Stage 1 Strategy Basis:
${s1Context}

Stage 2 Business Unit Mapping:
${s2Context}

Current Stage 3 JSON:
${s3Payload}

Refinement instruction:
${refinementPrompt}

Optional impact summary:
${impactSummary || 'none provided'}

Regenerate the full Stage 3 execution-plan package and return only JSON.`

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
    systemPrompt,
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

${DOMAIN_ADAPTIVE_STAGE3_RULES}

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

  function inferMockLenses(bu) {
    const text = [
      bu.name,
      bu.purpose,
      bu.strategicInvolvement,
      ...(bu.keyResponsibilities || []),
      ...(bu.dependencies || []),
      ...(bu.risksAndUnknowns || []),
    ].join(' ').toLowerCase()
    const lenses = []
    const add = (name, focus, actions, risks = [], validation = []) => {
      lenses.push({ name, focus, actions, risks, validation })
    }

    if (/compliance|regulat|risk|legal|audit|governance/.test(text)) {
      add('compliance/governance', 'Control evidence and approval timing determine whether execution can proceed.', ['Define evidence requirements for the first gate', 'Confirm approval workflow and accountable approver'], ['Regulatory interpretation changes after work has started'], ['Evidence package accepted by the accountable control owner'])
    }
    if (/tech|platform|data|system|infrastructure|architecture|security|integration|engineering/.test(text)) {
      add('platform/architecture', 'Technical dependencies shape feasibility, observability, and scale readiness.', ['Map required integrations and data flows', 'Identify observability and support requirements before launch'], ['Integration scope is larger than the planning assumption'], ['Architecture review confirms no launch-blocking dependency'])
    }
    if (/delivery|operations|service|advisory|consult|client|field|implementation|enablement/.test(text)) {
      add('delivery/operations', 'Field execution and client trust depend on readiness, escalation routes, and feedback loops.', ['Prepare field readiness materials', 'Define escalation routing and feedback capture process'], ['Client-facing teams receive inconsistent guidance'], ['Readiness checks show operators can explain and execute the offer'])
    }
    if (/sales|channel|gtm|market|commercial|revenue|customer acquisition/.test(text)) {
      add('GTM/messaging', 'Commercial uptake depends on positioning clarity and timing with delivery readiness.', ['Align launch messaging with product and delivery constraints', 'Define adoption signals for early GTM review'], ['Sales motion promises capabilities before delivery readiness'], ['Messaging review confirms consistent buyer narrative'])
    }
    if (/finance|pricing|budget|roi|investment|commercial/.test(text)) {
      add('finance/commercial gating', 'Investment posture and ROI assumptions determine how far execution should scale.', ['Set spend thresholds for phase advancement', 'Validate unit economics before expansion'], ['Costs scale before demand or validation evidence is strong enough'], ['Gate review confirms ROI assumptions remain credible'])
    }

    return lenses.slice(0, 3)
  }

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

    const priorityOutcomes = [
      cap(bu.purpose, 90) || `Deliver ${name} contribution to the strategy`,
      isPrimary ? `Produce the evidence needed for the next executive gate` : `Provide timely input without slowing the primary workstreams`,
      deps.length ? `Resolve critical handoffs with dependent units` : `Keep execution scope narrow enough for reliable review`,
    ].filter(Boolean).slice(0, 3)
    const criticalWorkstreams = missionCritical.length > 0
      ? missionCritical
      : [`Execute core ${name} responsibilities per the strategy basis`]

    return {
      buName: name,
      mission: `${isPrimary ? 'Own' : isInformed ? 'Monitor' : 'Support'} the ${cap(bu.strategicInvolvement || bu.purpose, 80)} for this initiative.`,
      strategicRole: `${name} turns the Stage 2 capability map into ${isPrimary ? 'primary execution ownership' : isInformed ? 'review and signal monitoring' : 'supporting execution capacity'} for this strategy.`,
      priorityOutcomes,
      criticalWorkstreams,
      executionLenses: inferMockLenses(bu),
      strategicObjectives: priorityOutcomes,
      initiativesMissionCritical: criticalWorkstreams,
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
  const coordinationLayer = {
    executionSummary: `Mock coordination layer for ${bUs.length} execution unit${bUs.length !== 1 ? 's' : ''} under "${posture}" posture.`,
    sequencingOverview: 'Phase one resolves governance, dependency, and validation readiness before phase-two scaling decisions.',
    dependencyCoordinationMap: bUs.slice(0, 4).map(bu => `${bu.name}: coordinate dependencies through the shared gate review`),
    governanceModel: ['Executive gate owns phase advancement', 'Each BU lead owns its workstream scope and escalation path'],
    organizationalBottlenecks: ['Dependency bottlenecks between primary units before the go/no-go gate'],
    sharedRisks: s1Risks.slice(0, 3).map(r => cap(r, 90)),
    sharedUnknowns: s1Unknowns.slice(0, 3).map(u => cap(u, 90)),
    operationalReadinessOverview: 'Mock readiness is moderate until BU leads confirm resourcing, validation evidence, and dependency owners.',
    crossFunctionalSuccessMetrics: ['No primary workstream blocks the gate review', 'Evidence package ready before phase-two commitment'],
    escalationDecisionOwnership: ['BU leads escalate blockers to executive sponsor within 48 hours', 'Executive sponsor resolves cross-unit tradeoffs'],
    criticalExecutionPath: ['Confirm governance and validation criteria', 'Resolve primary dependencies', 'Complete evidence package for gate review'],
    parallelizableWorkstreams: bUs.slice(0, 4).map(bu => `${bu.name} phase-one scoping`),
    confidenceReadinessAssessment: 'Medium confidence; mock generation should be replaced by AI generation for domain-specific validation.',
  }

  return {
    executionPlans,
    coordinationLayer,
    summaryNote: `Mock-generated Stage 3 execution plans for ${bUs.length} business unit${bUs.length !== 1 ? 's' : ''} under "${posture}" investment posture.${thesisSnip}${oppSnip} Top cross-cutting risk: dependency bottlenecks between primary units before the go/no-go gate. Add VITE_ANTHROPIC_API_KEY to .env.local and restart the dev server for AI-generated plans.`,
  }
}
