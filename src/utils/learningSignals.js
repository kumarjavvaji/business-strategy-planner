const CATEGORIES = new Set([
  'Refinement patterns',
  'Stage-boundary lessons',
  'Assumption shifts',
  'SME validation needs',
  'Downstream implications',
  'Evidence gaps',
  'Failure modes',
])

const GENERIC_PATTERNS = [
  /^compliance is important/i,
  /^marketing needs messaging/i,
  /^sales needs/i,
  /^technology needs/i,
  /^the strategy/i,
  /^business units? should/i,
]

const clean = v => (typeof v === 'string' ? v.trim() : String(v ?? '').trim())

function category(value, fallback = 'Refinement patterns') {
  const c = clean(value)
  return CATEGORIES.has(c) ? c : fallback
}

function signal(stage, categoryName, text, source = 'heuristic') {
  const t = clean(text)
  if (!t || t.length < 45) return null
  if (GENERIC_PATTERNS.some(pattern => pattern.test(t))) return null
  return { stage, category: category(categoryName), text: t, source }
}

export function normalizeLearningSignals(signals, stage = '') {
  const seen = new Set()
  return (Array.isArray(signals) ? signals : [])
    .map(s => signal(clean(s?.stage) || stage, s?.category, s?.text || s, s?.source || 'heuristic'))
    .filter(Boolean)
    .filter(s => {
      const key = `${s.stage}|${s.category}|${s.text.toLowerCase()}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 8)
}

export function deriveLearningSignals({
  stage,
  source,
  prompt,
  impactSummary,
  refinementType,
  refinementScope,
  structuralImpact,
  refinementClassification,
  affectedUnit,
  stalenessEvents,
}) {
  const signals = []
  const p = clean(prompt)
  const impact = clean(impactSummary)
  const lower = `${p} ${impact} ${clean(refinementClassification)}`.toLowerCase()

  if (structuralImpact && structuralImpact !== 'none') {
    signals.push(signal(
      stage,
      'Stage-boundary lessons',
      `Structural ${stage} refinement was classified as "${structuralImpact}"; downstream stages should treat inherited ownership, dependency, and execution assumptions as stale until regenerated.`,
    ))
  }

  if (refinementType === 'unit' && affectedUnit) {
    signals.push(signal(
      stage,
      'Refinement patterns',
      `Localized refinement on "${affectedUnit}" indicates that future generation should preserve full-stage coherence while allowing targeted SME corrections to reshape the affected operating assumptions.`,
    ))
  }

  if (refinementScope && refinementScope !== 'auto') {
    signals.push(signal(
      stage,
      'Refinement patterns',
      `User-selected refinement scope "${refinementScope}" suggests this stage benefits from explicit scope hints before regenerating content, especially when wording and operating-model changes look superficially similar.`,
    ))
  }

  if (/unknown|uncertain|gap|missing|not clear|unclear|validate|validation|evidence/.test(lower)) {
    signals.push(signal(
      stage,
      'Evidence gaps',
      `Refinement language surfaced evidence or validation gaps; future stage prompts should preserve the unresolved question rather than convert it into confident strategy content.`,
    ))
  }

  if (/stage 2|stage 3|stage 4|downstream|stale|regenerate|sequenc|execution|capability topology|mapping/.test(lower)) {
    signals.push(signal(
      stage,
      'Stage-boundary lessons',
      `Revision metadata references cross-stage interpretation; future generation should check whether the change belongs in capability topology, execution operationalization, or downstream product-delivery translation before rewriting content.`,
    ))
  }

  if (/sme|operator|consultant|advisor|frontline|field|client-facing|implementation/.test(lower)) {
    signals.push(signal(
      stage,
      'SME validation needs',
      `Refinement pressure involved operator or SME ownership; future prompts should test whether the people doing the work have enough explicit ownership, readiness, escalation, and feedback-loop detail to validate the plan.`,
    ))
  }

  if (Array.isArray(stalenessEvents) && stalenessEvents.length) {
    signals.push(signal(
      stage,
      'Downstream implications',
      `Staleness was triggered by ${stalenessEvents.join(' and ')}; future revisions should capture which downstream assumptions changed instead of treating regeneration as a cosmetic refresh.`,
    ))
  }

  if (source === 'manual' && p) {
    signals.push(signal(
      stage,
      'Refinement patterns',
      `Manual correction notes are being used to preserve learning context when API regeneration is unavailable; future AI passes should inspect these notes for assumption shifts before replacing stage content.`,
    ))
  }

  return normalizeLearningSignals(signals, stage)
}

export function buildLearningSignalMessages(context) {
  const stage = clean(context?.stage)
  const systemPrompt = `You extract meta-learning signals for a staged business-strategy planning tool.

Learning signals are not facts about the strategy. They are reusable observations about the strategy-formation process: refinement patterns, prompt weaknesses, stage-boundary issues, assumption shifts, staleness triggers, evidence gaps, SME validation needs, decision-quality improvements, and failure modes.

Reject content that merely summarizes the strategy, repeats business-unit content, or says generic things like "Compliance is important".

Return ONLY JSON:
{
  "learningSignals": [
    { "category": "Refinement patterns | Stage-boundary lessons | Assumption shifts | SME validation needs | Downstream implications | Evidence gaps | Failure modes", "text": "specific reusable meta-observation" }
  ]
}

Return at most 4 signals. Empty array is acceptable.`

  const userPrompt = `Stage: ${stage}
Source: ${clean(context?.source)}
Refinement type: ${clean(context?.refinementType) || 'none'}
Refinement scope: ${clean(context?.refinementScope) || 'none'}
Structural impact: ${clean(context?.structuralImpact) || 'none'}
Refinement classification: ${clean(context?.refinementClassification) || 'none'}
Prompt: ${clean(context?.prompt) || 'none'}
Impact summary: ${clean(context?.impactSummary) || 'none'}
Before/after summary: ${clean(context?.beforeAfterSummary) || 'not provided'}
Staleness events: ${(context?.stalenessEvents || []).join(', ') || 'none'}

Extract compact meta-learning signals only.`

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    systemPrompt,
  }
}

export function parseLearningSignalResponse(rawText, stage) {
  if (!rawText?.trim()) return []
  let jsonStr = rawText.trim()
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) jsonStr = fenceMatch[1].trim()
  const firstBrace = jsonStr.indexOf('{')
  const lastBrace = jsonStr.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1)
  }
  try {
    return normalizeLearningSignals(JSON.parse(jsonStr)?.learningSignals || [], stage)
  } catch {
    return []
  }
}
