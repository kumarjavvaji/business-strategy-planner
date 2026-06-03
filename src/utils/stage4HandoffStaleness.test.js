/**
 * Tests for Stage 4 upstream staleness detection (D5).
 */

import { describe, it, expect } from 'vitest'
import { isHandoffUpstreamStale, buildUpstreamStalenessWarning } from './stage4Handoff'

const BASE_HANDOFF = {
  stage1RevisionId: 's1_v1',
  stage2RevisionId: 's2_v1',
  stage3RevisionId: 's3_v1',
}

describe('isHandoffUpstreamStale — D5', () => {
  it('returns false when all revision IDs match', () => {
    expect(isHandoffUpstreamStale(BASE_HANDOFF, 's1_v1', 's2_v1', 's3_v1')).toBe(false)
  })

  it('returns true when Stage 1 has changed', () => {
    expect(isHandoffUpstreamStale(BASE_HANDOFF, 's1_v2', 's2_v1', 's3_v1')).toBe(true)
  })

  it('returns true when Stage 2 has changed', () => {
    expect(isHandoffUpstreamStale(BASE_HANDOFF, 's1_v1', 's2_v2', 's3_v1')).toBe(true)
  })

  it('returns true when Stage 3 has changed', () => {
    expect(isHandoffUpstreamStale(BASE_HANDOFF, 's1_v1', 's2_v1', 's3_v2')).toBe(true)
  })

  it('returns false for null handoff', () => {
    expect(isHandoffUpstreamStale(null, 's1_v1', 's2_v1', 's3_v1')).toBe(false)
  })

  it('ignores undefined current IDs (partial staleness check)', () => {
    // When only some IDs are checked, only those IDs are compared
    expect(isHandoffUpstreamStale(BASE_HANDOFF, 's1_v2', undefined, undefined)).toBe(true)
    expect(isHandoffUpstreamStale(BASE_HANDOFF, undefined, 's2_v1', undefined)).toBe(false)
  })
})

describe('buildUpstreamStalenessWarning — D5', () => {
  it('returns null when handoff is current', () => {
    expect(buildUpstreamStalenessWarning(BASE_HANDOFF, 's1_v1', 's2_v1', 's3_v1')).toBeNull()
  })

  it('returns a warning message identifying changed stages', () => {
    const warning = buildUpstreamStalenessWarning(BASE_HANDOFF, 's1_v2', 's2_v1', 's3_v1')
    expect(warning).toBeTruthy()
    expect(warning).toContain('Stage 1')
    expect(warning).toContain('earlier upstream basis')
  })

  it('mentions all changed stages when multiple have changed', () => {
    const warning = buildUpstreamStalenessWarning(BASE_HANDOFF, 's1_v2', 's2_v2', 's3_v1')
    expect(warning).toContain('Stage 1')
    expect(warning).toContain('Stage 2')
  })

  it('returns null for null handoff', () => {
    expect(buildUpstreamStalenessWarning(null, 's1_v1', 's2_v1', 's3_v1')).toBeNull()
  })
})
