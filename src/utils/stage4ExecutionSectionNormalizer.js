/**
 * Stage 4 execution-section normalizer — group-based algorithm.
 *
 * Two-pass approach:
 *  Pass 1 — Cluster sections by base-framing similarity (first-N-char opening Jaccard).
 *            Sections that share the same overall execution concept form one framing group.
 *  Pass 2 — Within each group keep the strongest representative.
 *            Extract unique deltas from non-representative members and fold them in.
 *            Remove members that add no unique execution value.
 *
 * SEPARATION PRINCIPLE:
 *  shared base framing  → same framing group → one retained representative
 *  unique execution deltas → captured in extractedUniqueDetails (not lost)
 *  different execution concept → separate framing group → own representative retained
 *
 * INVARIANT: accepted Stage 3 source atoms are never deleted or mutated.
 */

// ── Thresholds ────────────────────────────────────────────────────────────────

const OPENING_WINDOW        = 150   // chars of objective text used for framing comparison
const FRAMING_THRESHOLD     = 0.55  // Jaccard on first-150-char opening → same framing group
const MIN_DELTA_WORDS       = 4     // min unique objective words to constitute a significant delta
const HIGH_BODY_DUPLICATE   = 0.90  // full-body Jaccard → definitively the same section

// ── Text helpers ──────────────────────────────────────────────────────────────

function normalizeText(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}

function wordSet(text) {
  const words = new Set()
  normalizeText(text).split(' ').forEach(w => { if (w.length > 3) words.add(w) })
  return words
}

function jaccardSimilarity(textA, textB) {
  const setA = wordSet(textA)
  const setB = wordSet(textB)
  if (!setA.size && !setB.size) return 1.0
  if (!setA.size || !setB.size) return 0.0
  let intersection = 0
  setA.forEach(w => { if (setB.has(w)) intersection++ })
  return intersection / (setA.size + setB.size - intersection)
}

function extendedOpening(text) {
  return normalizeText(String(text || '').slice(0, OPENING_WINDOW))
}

// ── Section content helpers ────────────────────────────────────────────────────

const DETAIL_FIELDS = ['decisionsRequired', 'dependencies', 'risks', 'validationSignals', 'sequencingAndGates']

function sectionBodyText(section) {
  const parts = [
    section.sectionName,
    section.objective,
    ...(section.executionStrategy || []),
    ...(section.decisionsRequired || []),
    ...(section.dependencies || []),
    ...(section.risks || []),
    ...(section.validationSignals || []),
    ...(section.sequencingAndGates || []),
  ]
  return parts.filter(Boolean).join(' ')
}

function sectionStrength(section) {
  return (
    (section.objective?.length || 0) +
    (section.decisionsRequired?.length  || 0) * 20 +
    (section.dependencies?.length       || 0) * 20 +
    (section.risks?.length              || 0) * 20 +
    (section.validationSignals?.length  || 0) * 15 +
    (section.sequencingAndGates?.length || 0) * 15 +
    (section.executionStrategy?.length  || 0) * 5
  )
}

function detectExecutionRoles(section) {
  const roles = []
  if ((section.decisionsRequired  || []).length > 0) roles.push('decision_gate')
  if ((section.dependencies       || []).length > 0) roles.push('dependency')
  if ((section.risks              || []).length > 0) roles.push('risk_control')
  if ((section.validationSignals  || []).length > 0) roles.push('validation_evidence')
  if ((section.sequencingAndGates || []).length > 0) roles.push('sequencing_gate')
  if ((section.executionStrategy  || []).length > 0) roles.push('workstream')
  if (section.objective && section.objective.length > 30) roles.push('milestone')
  return roles
}

// ── Unique-detail helpers ─────────────────────────────────────────────────────

function extractUniqueItems(listA, listB) {
  const normB = new Set((listB || []).map(normalizeText).filter(Boolean))
  return (listA || []).filter(item => {
    const n = normalizeText(item)
    return n.length > 3 && !normB.has(n)
  })
}

function getUniqueDetails(sectionA, sectionB) {
  const result = {}
  for (const field of DETAIL_FIELDS) {
    const unique = extractUniqueItems(sectionA[field], sectionB[field])
    if (unique.length > 0) result[field] = unique
  }
  return result
}

/**
 * Returns words present in memberSection's objective but absent from repSection's
 * objective. These are the unique constraint/outcome words that constitute a delta.
 */
function uniqueObjectiveWords(memberSection, repSection) {
  const repWords = wordSet(repSection.objective || '')
  return [...wordSet(memberSection.objective || '')].filter(w => !repWords.has(w))
}

// ── Merge ─────────────────────────────────────────────────────────────────────

function dedupStringList(existing, additions) {
  const norm = new Set((existing || []).map(normalizeText))
  const result = [...(existing || [])]
  for (const item of (additions || [])) {
    if (!item) continue
    const n = normalizeText(item)
    if (n && !norm.has(n)) { norm.add(n); result.push(item) }
  }
  return result
}

function mergeIntoRetained(retained, duplicate) {
  return {
    ...retained,
    decisionsRequired:  dedupStringList(retained.decisionsRequired,  duplicate.decisionsRequired),
    dependencies:       dedupStringList(retained.dependencies,       duplicate.dependencies),
    risks:              dedupStringList(retained.risks,              duplicate.risks),
    validationSignals:  dedupStringList(retained.validationSignals,  duplicate.validationSignals),
    sequencingAndGates: dedupStringList(retained.sequencingAndGates, duplicate.sequencingAndGates),
    sourceAtomRefs: [...new Set([
      ...(retained.sourceAtomRefs  || []),
      ...(duplicate.sourceAtomRefs || []),
    ])],
    _mergedFrom: [...(retained._mergedFrom || []), duplicate.sectionName].filter(Boolean),
  }
}

function mergeSourceRefs(rep, member) {
  return {
    ...rep,
    sourceAtomRefs: [...new Set([...(rep.sourceAtomRefs || []), ...(member.sourceAtomRefs || [])])],
    _mergedFrom: [...(rep._mergedFrom || []), member.sectionName].filter(Boolean),
  }
}

// ── Pass 1: framing-group clustering ─────────────────────────────────────────

/**
 * Groups sections by opening-phrase/base-framing similarity.
 *
 * Each section is assigned to the first existing group whose representative
 * has an opening Jaccard >= FRAMING_THRESHOLD. If none matches, a new group
 * is created. Within a group the representative is always the member with the
 * highest strength score.
 */
function groupByFraming(sections) {
  const groups = []

  for (const section of sections) {
    const secOpening = extendedOpening(section.objective || section.sectionName)
    let matched = false

    for (const group of groups) {
      const repOpening = extendedOpening(group.representative.objective || group.representative.sectionName)
      if (jaccardSimilarity(secOpening, repOpening) >= FRAMING_THRESHOLD) {
        group.members.push(section)
        if (sectionStrength(section) > sectionStrength(group.representative)) {
          group.representative = section
        }
        matched = true
        break
      }
    }

    if (!matched) {
      groups.push({ representative: section, members: [section] })
    }
  }

  return groups
}

// ── Pass 2: within-group disposition ─────────────────────────────────────────

/**
 * Classifies a non-representative member relative to its group representative.
 * Returns the disposition tag used for diagnostic issueType.
 */
function classifyMember(member, representative) {
  const uniqueWords  = uniqueObjectiveWords(member, representative)
  const listDeltas   = getUniqueDetails(member, representative)
  const hasListDeltas = Object.values(listDeltas).some(v => v.length > 0)
  const bodyJaccard  = jaccardSimilarity(sectionBodyText(member), sectionBodyText(representative))

  if (uniqueWords.length >= MIN_DELTA_WORDS || hasListDeltas) {
    return { tag: 'DELTA', uniqueWords, listDeltas, bodyJaccard }
  }
  if (bodyJaccard >= HIGH_BODY_DUPLICATE) {
    return { tag: 'FULL_DUPLICATE', uniqueWords, listDeltas, bodyJaccard }
  }
  return { tag: 'LOW_DISTINCTNESS_VARIANT', uniqueWords, listDeltas, bodyJaccard }
}

// ── Diagnostic builders ───────────────────────────────────────────────────────

function diagRetainedDistinct(section, groupSize) {
  const reason = groupSize === 1
    ? `Section "${section.sectionName}" has a distinct base framing from all other sections.`
    : `Section "${section.sectionName}" is the strongest representative of its framing group.`
  return {
    issueType:         'retained_distinct_execution_role',
    retainedSectionId: section.sectionName,
    reason,
    remediation:       'Retained as a distinct top-level execution section.',
  }
}

function diagDelta(member, representative, uniqueWords, listDeltas) {
  const parts = []
  if (uniqueWords.length > 0) {
    parts.push(`${uniqueWords.length} unique constraint/outcome words (${uniqueWords.slice(0, 5).join(', ')}${uniqueWords.length > 5 ? '…' : ''})`)
  }
  if (Object.keys(listDeltas).length > 0) {
    parts.push(`unique list-field details in: ${Object.keys(listDeltas).join(', ')}`)
  }
  return {
    issueType:          uniqueWords.length >= MIN_DELTA_WORDS ? 'unique_delta_extracted' : 'same_execution_role',
    retainedSectionId:  representative.sectionName,
    removedSectionIds:  [member.sectionName],
    reason:             `Section "${member.sectionName}" shares the same base framing as "${representative.sectionName}" and adds ${parts.join('; ')}. Unique delta captured in extractedUniqueDetails.`,
    mergedSourceRefs:   member.sourceAtomRefs || [],
    remediation:        'Section removed; unique deltas and source refs preserved in retained representative.',
  }
}

function diagFullDuplicate(member, representative, jaccard) {
  return {
    issueType:         'removed_no_unique_value',
    retainedSectionId: representative.sectionName,
    removedSectionIds: [member.sectionName],
    reason:            `Section "${member.sectionName}" is a near-identical duplicate (${Math.round(jaccard * 100)}% body similarity) of retained section "${representative.sectionName}" with no unique execution content.`,
    mergedSourceRefs:  member.sourceAtomRefs || [],
    remediation:       'Removed near-identical duplicate; source refs preserved in retained section.',
  }
}

function diagLowDistinctness(member, representative) {
  return {
    issueType:         'merged_low_distinctness_variant',
    retainedSectionId: representative.sectionName,
    removedSectionIds: [member.sectionName],
    reason:            `Section "${member.sectionName}" shares the same base framing as "${representative.sectionName}" with only minor wording differences and no unique execution constraints or list-field details.`,
    mergedSourceRefs:  member.sourceAtomRefs || [],
    remediation:       'Removed low-distinctness variant; source refs preserved in retained representative.',
  }
}

// ── Main normalizer ────────────────────────────────────────────────────────────

/**
 * Normalizes execution sections for Stage 4 handoff and artifact generation.
 *
 * @param {Array}  sections - raw mapped execution sections
 * @param {object} context  - optional: { buName, artifactType, sourcePanelRefs }
 * @returns {{
 *   retainedSections:       Array,
 *   removedSections:        Array,
 *   mergedSections:         Array,
 *   extractedUniqueDetails: Array,
 *   diagnostics:            Array,
 *   summary:                string|null,
 *   buName:                 string|null,
 *   inputCount:             number,
 *   retainedCount:          number,
 *   removedCount:           number,
 *   mergedCount:            number,
 * }}
 */
export function normalizeExecutionSectionsForStage4(sections, context = {}) {
  if (!Array.isArray(sections) || sections.length === 0) {
    return {
      retainedSections: [], removedSections: [], mergedSections: [],
      extractedUniqueDetails: [], diagnostics: [],
      summary: null, buName: context.buName || null,
      inputCount: 0, retainedCount: 0, removedCount: 0, mergedCount: 0,
    }
  }

  const buName              = context.buName || null
  const retained            = []
  const removed             = []
  const merged              = []
  const extractedUniqueDetails = []
  const diagnostics         = []

  // Pass 1: cluster sections into framing groups
  const groups = groupByFraming(sections)

  // Pass 2: process each group
  for (const { representative, members } of groups) {
    let rep = representative

    if (members.length === 1) {
      retained.push(rep)
      diagnostics.push(diagRetainedDistinct(rep, 1))
      continue
    }

    // Multi-member group
    for (const member of members) {
      if (member === representative) continue

      const { tag, uniqueWords, listDeltas, bodyJaccard } = classifyMember(member, representative)

      // Always absorb source refs from every group member
      rep = mergeSourceRefs(rep, member)

      if (tag === 'DELTA') {
        // Significant unique content: fold list-field deltas into representative
        // and capture the full delta record for traceability.
        if (Object.values(listDeltas).some(v => v.length > 0)) {
          rep = mergeIntoRetained(rep, member)
        }
        extractedUniqueDetails.push({
          fromSectionId:   member.sectionName,
          toSectionId:     representative.sectionName,
          capturedDetails: {
            ...(uniqueWords.length > 0 ? { uniqueObjectiveWords: uniqueWords, objectiveFragment: member.objective } : {}),
            ...listDeltas,
          },
          captureReason: uniqueWords.length >= MIN_DELTA_WORDS ? 'unique_objective_delta' : 'list_field_deltas',
        })
        diagnostics.push(diagDelta(member, representative, uniqueWords, listDeltas))
      } else if (tag === 'FULL_DUPLICATE') {
        diagnostics.push(diagFullDuplicate(member, representative, bodyJaccard))
      } else {
        diagnostics.push(diagLowDistinctness(member, representative))
      }

      removed.push(member)
      merged.push({ retainedSectionId: representative.sectionName, removedSectionId: member.sectionName })
    }

    retained.push(rep)
    // Add representative diagnostic after processing the whole group
    diagnostics.push(diagRetainedDistinct(rep, members.length))
  }

  // Re-sort retained into original input order for stable downstream consumption
  const originalOrder = new Map(sections.map((s, i) => [s.sectionName, i]))
  retained.sort((a, b) => (originalOrder.get(a.sectionName) ?? 999) - (originalOrder.get(b.sectionName) ?? 999))

  const summary = removed.length > 0
    ? `${sections.length} source section${sections.length === 1 ? '' : 's'} normalized to ${retained.length} execution section${retained.length === 1 ? '' : 's'} (${removed.length} duplicate/low-value section${removed.length === 1 ? '' : 's'} merged)`
    : null

  return {
    retainedSections:       retained,
    removedSections:        removed,
    mergedSections:         merged,
    extractedUniqueDetails,
    diagnostics,
    summary,
    buName,
    inputCount:    sections.length,
    retainedCount: retained.length,
    removedCount:  removed.length,
    mergedCount:   merged.length,
  }
}

/**
 * Convenience: applies normalization and returns only the retained sections.
 * Attach the full normalization result to the handoff entry for diagnostics.
 */
export function getRetainedExecutionSections(sections, context = {}) {
  return normalizeExecutionSectionsForStage4(sections, context).retainedSections
}
