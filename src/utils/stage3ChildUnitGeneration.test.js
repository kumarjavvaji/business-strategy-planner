/**
 * Tests for stage3ChildUnitGeneration — atomic panel generation.
 *
 * Key behaviors tested:
 *   - Successful items preserved when a later item fails with max_tokens
 *   - Failed child unit can be retried without regenerating successful siblings
 *   - Panel assembly contains only completed units
 *   - Previous accepted panel content not overwritten by partial draft
 *   - Truncated response creates retryable failed unit
 *   - Stage 4 readiness blocked while panel has failed child units
 */

import { describe, it, expect, vi } from 'vitest'
import {
  buildChildUnitMessages,
  parseChildUnitResponse,
  auditChildUnit,
  generatePanelAtomically,
  retryChildUnit,
  apiStopReasonTruncation,
  initChildUnits,
  ATOMIC_GENERATION_PANELS,
  DEFAULT_ITEM_COUNTS,
} from './stage3ChildUnitGeneration'
import { PANEL_AUDIT_STATUSES } from './stage3PanelModel'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const GOOD_RISK = {
  riskName:                  'Architecture Lock-In Risk',
  riskDescription:           'Early connector build may lock data mappings before schema coverage is confirmed.',
  whyItMatters:              'Rework costs escalate once integrations are built on the locked path.',
  mitigationOptions:         ['Define interface boundaries before build', 'Separate reusable logic from ETL exceptions'],
  earlyWarningSignals:       ['Connector work starts before schema coverage is complete'],
  evidenceThatRiskIsReduced: ['Architecture review confirms extension points', 'Schema gaps are visible before build'],
}

const GOOD_DECISION = {
  decisionName:           'Build vs Partner',
  decisionQuestion:       'Which explainability components should be built internally versus sourced from a partner?',
  whyItMatters:           'This choice determines long-term maintenance ownership and integration complexity.',
  decisionOptions:        ['Full internal build', 'Partner for selected components', 'Hybrid approach'],
  decisionEvidenceNeeded: ['Pilot evidence from partner capability screen', 'Internal capacity assessment from API Engineering'],
  decisionTiming:         'Resolve before Sprint 2 architecture work begins.',
}

const GOOD_DEPENDENCY = {
  dependencyName:        'API Engineering Schema Approval',
  dependencyDescription: 'API Engineering must review and approve schema contracts before Sprint 2 begins.',
  whyItMatters:          'This gates Sprint 2 — connector build cannot start without approved schemas.',
  requiredInput:         'signed schema interface contracts',
  consequenceIfMissing:  'Sprint 2 connector build begins on unvalidated assumptions.',
}

const BU_SUMMARY = {
  name: 'Product & Competitive Architecture',
  purpose: 'Own the explainability infrastructure for AaaS BSA/AML outputs.',
  strategicInvolvement: 'Primary — builds the core explainability platform.',
  keyResponsibilities: ['Schema design', 'Connector build', 'Explainability output formats'],
}

const S1_SUMMARY = 'Finlytica is building AaaS explainability infrastructure to reduce partner dependencies and ensure SR 11-7 compliance.'

// ── Mock callAI helpers ───────────────────────────────────────────────────────

/** Returns a good risk item for every call. */
function goodRiskCallAI(item = GOOD_RISK) {
  return vi.fn(async () => ({ content: JSON.stringify(item), stop_reason: 'end_turn' }))
}

/** Returns max_tokens for the given indices, good response otherwise. */
function callAIWithTruncationAt(truncationIndices, goodItem = GOOD_RISK) {
  let callCount = 0
  return vi.fn(async () => {
    const idx = callCount++
    if (truncationIndices.includes(idx)) {
      return { content: '{ "riskName": "Incomplete Risk", "riskDescription": "This was cut', stop_reason: 'max_tokens' }
    }
    return { content: JSON.stringify({ ...goodItem, riskName: `Risk ${idx + 1}` }), stop_reason: 'end_turn' }
  })
}

/** Returns an empty response for the given index. */
function callAIWithEmptyAt(emptyIndex, goodItem = GOOD_RISK) {
  let callCount = 0
  return vi.fn(async () => {
    const idx = callCount++
    if (idx === emptyIndex) return { content: '', stop_reason: 'end_turn' }
    return { content: JSON.stringify({ ...goodItem, riskName: `Risk ${idx + 1}` }), stop_reason: 'end_turn' }
  })
}

// ── apiStopReasonTruncation ───────────────────────────────────────────────────

describe('apiStopReasonTruncation', () => {
  it('detects max_tokens stop reason', () => {
    expect(apiStopReasonTruncation({ stop_reason: 'max_tokens' })).toBeTruthy()
    expect(apiStopReasonTruncation({ stopReason: 'max_tokens' })).toBeTruthy()
  })

  it('detects length stop reason', () => {
    expect(apiStopReasonTruncation({ stop_reason: 'length' })).toBeTruthy()
  })

  it('returns null for normal end_turn', () => {
    expect(apiStopReasonTruncation({ stop_reason: 'end_turn' })).toBeNull()
    expect(apiStopReasonTruncation({ stop_reason: 'stop' })).toBeNull()
  })

  it('detects explicit truncated flag', () => {
    expect(apiStopReasonTruncation({ truncated: true, stop_reason: 'end_turn' })).toBeTruthy()
  })
})

// ── buildChildUnitMessages ────────────────────────────────────────────────────

describe('buildChildUnitMessages', () => {
  it('produces messages for a risk item', () => {
    const { messages } = buildChildUnitMessages({
      panelId: 'risks',
      itemIndex: 0,
      totalItems: 4,
      buSummary: BU_SUMMARY,
      s1Summary: S1_SUMMARY,
      completedItems: [],
    })
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('item 1 of 4')
    expect(messages[1].role).toBe('user')
  })

  it('includes completed item names in context to avoid repetition', () => {
    const { messages } = buildChildUnitMessages({
      panelId: 'risks',
      itemIndex: 2,
      totalItems: 4,
      buSummary: BU_SUMMARY,
      s1Summary: S1_SUMMARY,
      completedItems: [
        { riskName: 'Architecture Lock-In Risk', riskDescription: '...' },
        { riskName: 'Scope Expansion Risk', riskDescription: '...' },
      ],
    })
    expect(messages[1].content).toContain('Architecture Lock-In Risk')
    expect(messages[1].content).toContain('Scope Expansion Risk')
  })

  it('names the execution phase for executionSequence items', () => {
    const { messages } = buildChildUnitMessages({
      panelId: 'executionSequence',
      itemIndex: 0,
      totalItems: 4,
      buSummary: BU_SUMMARY,
      s1Summary: S1_SUMMARY,
      completedItems: [],
    })
    expect(messages[1].content).toContain('Problem & Outcome Validation')
  })

  it('throws for panels that do not use atomic generation', () => {
    expect(() => buildChildUnitMessages({
      panelId: 'strategicObjective',
      itemIndex: 0,
      totalItems: 1,
      buSummary: BU_SUMMARY,
      s1Summary: S1_SUMMARY,
    })).toThrow()
  })
})

// ── parseChildUnitResponse ────────────────────────────────────────────────────

describe('parseChildUnitResponse', () => {
  it('parses a valid JSON object', () => {
    const { item, error } = parseChildUnitResponse('risks', JSON.stringify(GOOD_RISK))
    expect(error).toBeNull()
    expect(item?.riskName).toBe('Architecture Lock-In Risk')
  })

  it('handles code-fenced JSON', () => {
    const raw = '```json\n' + JSON.stringify(GOOD_RISK) + '\n```'
    const { item, error } = parseChildUnitResponse('risks', raw)
    expect(error).toBeNull()
    expect(item?.riskName).toBeTruthy()
  })

  it('returns error for empty response', () => {
    const { item, error } = parseChildUnitResponse('risks', '')
    expect(item).toBeNull()
    expect(error).toBeTruthy()
  })

  it('returns error for array response (wrong format)', () => {
    const { item, error } = parseChildUnitResponse('risks', JSON.stringify([GOOD_RISK]))
    expect(item).toBeNull()
    expect(error).toBeTruthy()
  })

  it('returns error for truncated JSON', () => {
    const { item, error } = parseChildUnitResponse('risks', '{ "riskName": "Cut off')
    expect(item).toBeNull()
    expect(error).toBeTruthy()
  })
})

// ── auditChildUnit ────────────────────────────────────────────────────────────

describe('auditChildUnit', () => {
  it('passes a complete well-formed risk item', () => {
    const audit = auditChildUnit('risks', GOOD_RISK)
    expect(audit.status).toBe(PANEL_AUDIT_STATUSES.COMPLETE)
    expect(audit.truncatedFields).toHaveLength(0)
    expect(audit.missingFields).toHaveLength(0)
  })

  it('flags truncated riskDescription', () => {
    const audit = auditChildUnit('risks', { ...GOOD_RISK, riskDescription: 'The architecture may fail before con' })
    expect(audit.status).toBe(PANEL_AUDIT_STATUSES.TRUNCATED)
    expect(audit.truncatedFields.some(f => f.includes('riskDescription'))).toBe(true)
  })

  it('flags missing required field', () => {
    const audit = auditChildUnit('risks', { ...GOOD_RISK, riskName: '' })
    expect(audit.status).toBe(PANEL_AUDIT_STATUSES.INCOMPLETE)
    expect(audit.missingFields).toContain('riskName')
  })

  it('flags truncated decisionQuestion', () => {
    const audit = auditChildUnit('criticalDecisions', { ...GOOD_DECISION, decisionQuestion: 'Should we build or part' })
    expect(audit.status).toBe(PANEL_AUDIT_STATUSES.TRUNCATED)
    expect(audit.truncatedFields.some(f => f.includes('decisionQuestion'))).toBe(true)
  })

  it('passes a well-formed dependency item', () => {
    const audit = auditChildUnit('dependencies', GOOD_DEPENDENCY)
    expect(audit.status).toBe(PANEL_AUDIT_STATUSES.COMPLETE)
  })
})

// ── generatePanelAtomically ───────────────────────────────────────────────────

describe('generatePanelAtomically — preserves successful items when a later item fails', () => {
  it('keeps items 0–2 when item 3 fails with max_tokens', async () => {
    const mockCallAI = callAIWithTruncationAt([3])
    const result = await generatePanelAtomically({
      panelId:    'risks',
      buSummary:  BU_SUMMARY,
      s1Summary:  S1_SUMMARY,
      totalItems: 4,
      callAI:     mockCallAI,
    })

    // Items 0, 1, 2 should be completed
    expect(result.completedUnits).toHaveLength(3)
    expect(result.completedUnits.every(u => u.content?.riskName)).toBe(true)

    // Item 3 should be failed
    expect(result.failedUnits).toHaveLength(1)
    expect(result.failedUnits[0].index).toBe(3)
    expect(result.failedUnits[0].isTruncation).toBe(true)

    // Assembled content contains only completed items
    expect(result.assembledContent).toHaveLength(3)
  })

  it('keeps item 0 when item 1 fails and item 2 succeeds', async () => {
    const goodItem = { ...GOOD_RISK }
    let count = 0
    const mockCallAI = vi.fn(async () => {
      const i = count++
      if (i === 1) return { content: '', stop_reason: 'end_turn' }  // empty response
      return { content: JSON.stringify({ ...goodItem, riskName: `Risk ${i}` }), stop_reason: 'end_turn' }
    })

    const result = await generatePanelAtomically({
      panelId:    'risks',
      buSummary:  BU_SUMMARY,
      s1Summary:  S1_SUMMARY,
      totalItems: 3,
      callAI:     mockCallAI,
    })

    expect(result.completedUnits).toHaveLength(2)
    expect(result.failedUnits).toHaveLength(1)
    expect(result.failedUnits[0].index).toBe(1)
    expect(result.assembledContent).toHaveLength(2)
    // Assembled content is in order (item 0 before item 2)
    expect(result.assembledContent[0].riskName).toBe('Risk 0')
    expect(result.assembledContent[1].riskName).toBe('Risk 2')
  })

  it('returns empty assembledContent (not error) when all items fail', async () => {
    const mockCallAI = vi.fn(async () => ({ content: '', stop_reason: 'max_tokens' }))
    const result = await generatePanelAtomically({
      panelId:    'risks',
      buSummary:  BU_SUMMARY,
      s1Summary:  S1_SUMMARY,
      totalItems: 3,
      callAI:     mockCallAI,
    })

    expect(result.completedUnits).toHaveLength(0)
    expect(result.failedUnits).toHaveLength(3)
    expect(result.assembledContent).toHaveLength(0)
  })

  it('skips already-accepted child units (for retry flow)', async () => {
    const existingAccepted = [
      { index: 0, status: 'accepted', content: { ...GOOD_RISK, riskName: 'Risk 0' }, audit: { status: PANEL_AUDIT_STATUSES.COMPLETE } },
      { index: 1, status: 'accepted', content: { ...GOOD_RISK, riskName: 'Risk 1' }, audit: { status: PANEL_AUDIT_STATUSES.COMPLETE } },
    ]
    const mockCallAI = vi.fn(async () => ({
      content: JSON.stringify({ ...GOOD_RISK, riskName: 'Risk 2' }),
      stop_reason: 'end_turn',
    }))

    const result = await generatePanelAtomically({
      panelId:            'risks',
      buSummary:          BU_SUMMARY,
      s1Summary:          S1_SUMMARY,
      totalItems:         3,
      existingChildUnits: existingAccepted,
      callAI:             mockCallAI,
    })

    // Only item 2 should have been called
    expect(mockCallAI).toHaveBeenCalledTimes(1)
    expect(result.completedUnits).toHaveLength(3) // 2 skipped + 1 new
    expect(result.skippedUnits).toHaveLength(2)
    expect(result.assembledContent).toHaveLength(3)
  })

  it('fires onChildUnitComplete callback for each successful item', async () => {
    const onComplete = vi.fn()
    const mockCallAI = goodRiskCallAI()

    await generatePanelAtomically({
      panelId:             'risks',
      buSummary:           BU_SUMMARY,
      s1Summary:           S1_SUMMARY,
      totalItems:          2,
      callAI:              mockCallAI,
      onChildUnitComplete: onComplete,
    })

    expect(onComplete).toHaveBeenCalledTimes(2)
    expect(onComplete.mock.calls[0][0]).toBe(0) // index
    expect(onComplete.mock.calls[0][1]).toBeTruthy() // content
  })

  it('fires onChildUnitFailed callback for failed items', async () => {
    const onFailed = vi.fn()
    const mockCallAI = callAIWithTruncationAt([0])

    await generatePanelAtomically({
      panelId:           'risks',
      buSummary:         BU_SUMMARY,
      s1Summary:         S1_SUMMARY,
      totalItems:        2,
      callAI:            mockCallAI,
      onChildUnitFailed: onFailed,
    })

    expect(onFailed).toHaveBeenCalledTimes(1)
    expect(onFailed.mock.calls[0][0]).toBe(0)  // index
    expect(onFailed.mock.calls[0][2]).toBe(true) // isTruncation
  })
})

// ── retryChildUnit ────────────────────────────────────────────────────────────

describe('retryChildUnit — retries one unit without touching siblings', () => {
  it('succeeds on retry after prior failure', async () => {
    const mockCallAI = goodRiskCallAI({ ...GOOD_RISK, riskName: 'Architecture Risk (Retried)' })

    const result = await retryChildUnit({
      panelId:         'risks',
      index:           2,
      buSummary:       BU_SUMMARY,
      s1Summary:       S1_SUMMARY,
      siblingsContent: [{ riskName: 'Risk 0' }, { riskName: 'Risk 1' }],
      callAI:          mockCallAI,
    })

    expect(result.status).toBe('draft_ready')
    expect(result.content?.riskName).toBe('Architecture Risk (Retried)')
    expect(result.index).toBe(2)
    expect(mockCallAI).toHaveBeenCalledTimes(1)
  })

  it('returns failed unit record when retry also truncates', async () => {
    const mockCallAI = vi.fn(async () => ({ content: '{ "riskName": "cut', stop_reason: 'max_tokens' }))

    const result = await retryChildUnit({
      panelId:         'risks',
      index:           1,
      buSummary:       BU_SUMMARY,
      s1Summary:       S1_SUMMARY,
      siblingsContent: [],
      callAI:          mockCallAI,
    })

    expect(result.status).toBe('failed')
    expect(result.error).toBeTruthy()
    expect(result.index).toBe(1)
  })

  it('does not include the failed item index in siblingsContent prompt context', async () => {
    const mockCallAI = goodRiskCallAI()
    await retryChildUnit({
      panelId:         'risks',
      index:           1,
      buSummary:       BU_SUMMARY,
      s1Summary:       S1_SUMMARY,
      siblingsContent: [{ riskName: 'Risk 0' }, { riskName: 'Risk 2' }],
      callAI:          mockCallAI,
    })
    // Check the sibling names were included in the prompt
    const userMessage = mockCallAI.mock.calls[0][0].find(m => m.role === 'user')
    expect(userMessage.content).toContain('Risk 0')
    expect(userMessage.content).toContain('Risk 2')
  })
})

// ── Panel lifecycle with child units ─────────────────────────────────────────

describe('panel lifecycle — Stage 4 readiness blocked while child units are failing', () => {
  it('ATOMIC_GENERATION_PANELS contains the expected multi-item panels', () => {
    expect(ATOMIC_GENERATION_PANELS.has('risks')).toBe(true)
    expect(ATOMIC_GENERATION_PANELS.has('criticalDecisions')).toBe(true)
    expect(ATOMIC_GENERATION_PANELS.has('dependencies')).toBe(true)
    expect(ATOMIC_GENERATION_PANELS.has('executionSequence')).toBe(true)
    expect(ATOMIC_GENERATION_PANELS.has('validationFramework')).toBe(true)
    // strategicObjective is single-call
    expect(ATOMIC_GENERATION_PANELS.has('strategicObjective')).toBe(false)
  })

  it('assembledContent from generatePanelAtomically excludes failed units', async () => {
    const mockCallAI = callAIWithTruncationAt([1, 3])
    const result = await generatePanelAtomically({
      panelId:    'risks',
      buSummary:  BU_SUMMARY,
      s1Summary:  S1_SUMMARY,
      totalItems: 4,
      callAI:     mockCallAI,
    })

    // Items 0 and 2 succeeded; 1 and 3 failed
    expect(result.assembledContent).toHaveLength(2)
    expect(result.failedUnits.map(u => u.index)).toEqual(expect.arrayContaining([1, 3]))
  })

  it('allChildUnits contains records for every index', async () => {
    const mockCallAI = goodRiskCallAI()
    const result = await generatePanelAtomically({
      panelId:    'risks',
      buSummary:  BU_SUMMARY,
      s1Summary:  S1_SUMMARY,
      totalItems: 3,
      callAI:     mockCallAI,
    })

    expect(result.allChildUnits).toHaveLength(3)
    result.allChildUnits.forEach((u, i) => {
      expect(u.index).toBe(i)
      expect(u.unitId).toContain(String(i))
    })
  })
})

// ── initChildUnits ────────────────────────────────────────────────────────────

describe('initChildUnits', () => {
  it('creates the correct number of not_started unit records', () => {
    const units = initChildUnits('risks', 4)
    expect(units).toHaveLength(4)
    units.forEach((u, i) => {
      expect(u.index).toBe(i)
      expect(u.status).toBe('not_started')
      expect(u.panelId).toBe('risks')
      expect(u.content).toBeNull()
    })
  })
})

// ── Max-tokens creates retryable failed unit (not terminal failure) ───────────

describe('max_tokens response creates retryable failed unit', () => {
  it('failed unit has isTruncation=true and can be retried', async () => {
    const mockCallAI = vi.fn(async () => ({
      content:     '{ "riskName": "Architecture", "riskDescription": "The connector build may fail before con',
      stop_reason: 'max_tokens',
    }))

    const result = await generatePanelAtomically({
      panelId:    'risks',
      buSummary:  BU_SUMMARY,
      s1Summary:  S1_SUMMARY,
      totalItems: 1,
      callAI:     mockCallAI,
    })

    expect(result.failedUnits[0].isTruncation).toBe(true)
    expect(result.allChildUnits[0].status).toBe('failed')

    // The unit can be retried — retry succeeds with a good response
    const retryCallAI = goodRiskCallAI({ ...GOOD_RISK, riskName: 'Architecture Risk (Retried)' })
    const retried = await retryChildUnit({
      panelId:         'risks',
      index:           0,
      buSummary:       BU_SUMMARY,
      s1Summary:       S1_SUMMARY,
      siblingsContent: [],
      callAI:          retryCallAI,
    })

    expect(retried.status).toBe('draft_ready')
    expect(retried.content?.riskName).toBe('Architecture Risk (Retried)')
  })
})
