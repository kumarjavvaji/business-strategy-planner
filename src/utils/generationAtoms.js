export const ATOM_STATUSES = {
  NOT_STARTED: 'not_started',
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETE: 'complete',
  FAILED: 'failed',
  PARTIAL: 'partial',
  STALE: 'stale',
}

export function createGenerationAtom({
  id,
  stage,
  phase,
  parentId = null,
  businessUnitName = null,
  elementName = null,
  childKey = null,
  status = ATOM_STATUSES.NOT_STARTED,
  rawResponseText = null,
  parsedValue = null,
  parserError = null,
  attemptCount = 0,
  startedAt = null,
  completedAt = null,
  metadata = {},
} = {}) {
  return {
    id,
    stage,
    phase,
    parentId,
    businessUnitName,
    elementName,
    childKey,
    status,
    rawResponseText,
    parsedValue,
    parserError,
    attemptCount,
    startedAt,
    completedAt,
    metadata,
  }
}

export function markAtomPending(atom) {
  return {
    ...createGenerationAtom(atom),
    status: ATOM_STATUSES.PENDING,
    parserError: null,
  }
}

export function markAtomRunning(atom) {
  return {
    ...createGenerationAtom(atom),
    status: ATOM_STATUSES.RUNNING,
    parserError: null,
    attemptCount: (atom?.attemptCount || 0) + 1,
    startedAt: new Date().toISOString(),
    completedAt: null,
  }
}

export function markAtomComplete(atom, { rawResponseText = atom?.rawResponseText, parsedValue = atom?.parsedValue } = {}) {
  return {
    ...createGenerationAtom(atom),
    status: ATOM_STATUSES.COMPLETE,
    rawResponseText,
    parsedValue,
    parserError: null,
    completedAt: new Date().toISOString(),
  }
}

export function markAtomFailed(atom, {
  rawResponseText = atom?.rawResponseText,
  parserError = 'Generation failed.',
  status = ATOM_STATUSES.FAILED,
  metadata = {},
} = {}) {
  return {
    ...createGenerationAtom(atom),
    status,
    rawResponseText,
    parserError,
    completedAt: new Date().toISOString(),
    metadata: { ...(atom?.metadata || {}), ...metadata },
  }
}

export function markAtomStale(atom, metadata = {}) {
  return {
    ...createGenerationAtom(atom),
    status: ATOM_STATUSES.STALE,
    metadata: { ...(atom?.metadata || {}), ...metadata },
  }
}

export function shouldRetryAtom(atom) {
  return !atom || [
    ATOM_STATUSES.NOT_STARTED,
    ATOM_STATUSES.PENDING,
    ATOM_STATUSES.FAILED,
    ATOM_STATUSES.STALE,
  ].includes(atom.status)
}

export function summarizeAtoms(atoms = []) {
  const summary = {
    total: atoms.length,
    complete: 0,
    failed: 0,
    partial: 0,
    stale: 0,
    running: 0,
    pending: 0,
    not_started: 0,
  }
  for (const atom of atoms) {
    const status = atom?.status || ATOM_STATUSES.NOT_STARTED
    summary[status] = (summary[status] || 0) + 1
  }
  summary.done = summary.complete + summary.failed + summary.partial
  summary.hasFailures = summary.failed > 0
  summary.hasStale = summary.stale > 0
  summary.allComplete = summary.total > 0 && summary.complete === summary.total
  return summary
}
