import { describe, expect, it } from 'vitest'
import {
  STAGE4_READINESS_TARGETS,
  artifactMappingAnchorId,
  buildArtifactReadinessDeepLinkTarget,
} from './stage4ReadinessNavigation'

describe('stage4 readiness navigation', () => {
  it('builds a mapping deep-link target from a blocked missing-mapping row', () => {
    const row = {
      buId: 'engineering-api-infrastructure',
      buName: 'Engineering & API Infrastructure',
      artifactId: 'pdlc_epic_outline',
      artifactTitle: 'PDLC Epic Outline',
      readinessStatus: 'blocked_missing_mapping',
      sourcePanelId: 'executionSequence',
      sourcePanelLabel: 'Execution Sequence',
      remediationTarget: 'Execution Sequence -> find PDLC Epic Outline row -> select how options',
    }

    const { target, missing } = buildArtifactReadinessDeepLinkTarget(row)

    expect(missing).toEqual([])
    expect(target).toMatchObject({
      buId: 'engineering-api-infrastructure',
      buName: 'Engineering & API Infrastructure',
      panelId: 'executionSequence',
      sourcePanelId: 'executionSequence',
      artifactId: 'pdlc_epic_outline',
      anchorId: artifactMappingAnchorId('pdlc_epic_outline'),
      reason: 'blocked_missing_mapping',
    })
  })

  it('reports missing navigation identifiers instead of silently failing', () => {
    const { target, missing } = buildArtifactReadinessDeepLinkTarget({
      buName: 'Engineering & API Infrastructure',
      readinessStatus: 'blocked_missing_mapping',
    })

    expect(target).toBeNull()
    expect(missing).toContain('artifactId')
  })

  it('builds review-target links to BU summary, mapping, and quality audit', () => {
    const row = {
      buName: 'Engineering & API Infrastructure',
      artifactId: 'pdlc_epic_outline',
      readinessStatus: 'review_recommended',
    }

    expect(buildArtifactReadinessDeepLinkTarget(row, STAGE4_READINESS_TARGETS.BU_SUMMARY).target.panelId)
      .toBe('buSummary')
    expect(buildArtifactReadinessDeepLinkTarget(row, STAGE4_READINESS_TARGETS.EXECUTION_MAPPING).target)
      .toMatchObject({ panelId: 'executionSequence', artifactId: 'pdlc_epic_outline' })
    expect(buildArtifactReadinessDeepLinkTarget(row, STAGE4_READINESS_TARGETS.QUALITY_AUDIT).target.panelId)
      .toBe('compiledStrategyQualityAudit')
  })
})
