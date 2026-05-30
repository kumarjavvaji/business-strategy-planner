import { ATOM_STATUSES, summarizeAtoms } from './generationAtoms'
import { runGenerationQueue } from './generationQueue'

export const LIFECYCLE_STATES = {
  NOT_STARTED: 'not_started',
  INPUT_READY: 'input_ready',
  GENERATING: 'generating',
  GENERATION_FAILED: 'generation_failed',
  PARTIAL_DRAFT: 'partial_draft',
  DRAFT_GENERATED: 'draft_generated',
  ACCEPTED: 'accepted',
  STALE: 'stale',
}

export function estimateMessageBytes(messages = []) {
  try {
    return new Blob([JSON.stringify(messages || [])]).size
  } catch {
    return JSON.stringify(messages || []).length
  }
}

export function estimateTextBytes(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || '')
  try {
    return new Blob([text]).size
  } catch {
    return text.length
  }
}

export function atomIsValidDraft(atom) {
  return atom?.status === ATOM_STATUSES.COMPLETE && !!atom.parsedValue && !atom.parserError
}

export function atomNeedsGeneration(atom) {
  return !atom || [
    ATOM_STATUSES.NOT_STARTED,
    ATOM_STATUSES.PENDING,
    ATOM_STATUSES.FAILED,
    ATOM_STATUSES.API_RATE_LIMITED,
    ATOM_STATUSES.RETRY_PENDING,
    ATOM_STATUSES.STALE,
  ].includes(atom.status)
}

export function deriveLifecycleState({ atoms = [], accepted = false, stale = false, running = false } = {}) {
  if (stale) return LIFECYCLE_STATES.STALE
  if (running) return LIFECYCLE_STATES.GENERATING
  if (!atoms.length) return LIFECYCLE_STATES.NOT_STARTED
  if (accepted && atoms.every(atomIsValidDraft)) return LIFECYCLE_STATES.ACCEPTED
  if (atoms.every(atomIsValidDraft)) return LIFECYCLE_STATES.DRAFT_GENERATED
  const hasFailures = atoms.some(atom => atom?.status === ATOM_STATUSES.FAILED || atom?.status === ATOM_STATUSES.API_RATE_LIMITED)
  const hasSuccess = atoms.some(atomIsValidDraft)
  if (hasFailures && hasSuccess) return LIFECYCLE_STATES.PARTIAL_DRAFT
  if (hasFailures) return LIFECYCLE_STATES.GENERATION_FAILED
  return LIFECYCLE_STATES.INPUT_READY
}

export function renderingEligibleAtoms(atoms = []) {
  return atoms.filter(atomIsValidDraft)
}

export function buildGenerationDiagnostics({
  buName,
  requestedAtoms = [],
  runnableAtoms = [],
  completedAtoms = [],
  failedAtoms = [],
  promptBytes = 0,
  outputBytes = 0,
  inputTokens = 0,
  outputTokens = 0,
  latestUsage = null,
  retryMode = 'full',
  model = null,
} = {}) {
  return {
    buName,
    atomCountRequested: requestedAtoms.length,
    atomsRequestedThisRun: runnableAtoms.length,
    totalAtomsEvaluated: requestedAtoms.length,
    atomsSkippedAlreadyValid: requestedAtoms.length - runnableAtoms.length,
    atomsGenerated: completedAtoms.length,
    atomsFailed: failedAtoms.length,
    approximatePromptBytes: promptBytes,
    approximateOutputBytes: outputBytes,
    inputTokens,
    outputTokens,
    latestUsage,
    retryMode,
    timestamp: new Date().toISOString(),
    model,
  }
}

function usageTotalsFromAtoms(atoms = []) {
  return atoms.reduce((acc, atom) => {
    const usage = atom?.metadata?.usage
    if (usage) {
      acc.inputTokens += Number(usage.input_tokens || 0)
      acc.outputTokens += Number(usage.output_tokens || 0)
      acc.latestUsage = {
        atomId: atom.id,
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        stop_reason: atom?.metadata?.stopReason || null,
        model: atom?.metadata?.model || null,
        timestamp: atom?.completedAt || new Date().toISOString(),
      }
    }
    return acc
  }, { inputTokens: 0, outputTokens: 0, latestUsage: null })
}

export async function runGenerationLifecycle({
  buName,
  atoms,
  worker,
  onUpdate,
  retryFailedOnly = true,
  delayMs = 0,
  retry = null,
  model = null,
  retryMode: requestedRetryMode = null,
}) {
  const requestedAtoms = atoms || []
  const runnableAtoms = requestedAtoms.filter(atomNeedsGeneration)
  const retryMode = requestedRetryMode || (runnableAtoms.length < requestedAtoms.length ? 'partial' : 'full')
  let promptBytes = 0
  let outputBytes = 0
  let inputTokens = 0
  let outputTokens = 0
  let latestUsage = null

  onUpdate?.({
    lifecycleState: LIFECYCLE_STATES.GENERATING,
    atoms: requestedAtoms,
    diagnostics: buildGenerationDiagnostics({
      buName,
      requestedAtoms,
      runnableAtoms,
      retryMode,
      model,
    }),
  })

  const updatedAtoms = await runGenerationQueue({
    atoms: requestedAtoms,
    concurrency: 1,
    delayMs,
    retryFailedOnly,
    retry,
    worker: async (atom) => {
      const result = await worker(atom)
      promptBytes += result?.promptBytes || 0
      outputBytes += result?.outputBytes || estimateTextBytes(result?.rawResponseText || '')
      if (result?.usage) {
        inputTokens += Number(result.usage.input_tokens || 0)
        outputTokens += Number(result.usage.output_tokens || 0)
        latestUsage = {
          atomId: atom.id,
          input_tokens: result.usage.input_tokens || 0,
          output_tokens: result.usage.output_tokens || 0,
          stop_reason: result.stopReason || null,
          model: result.model || model,
          timestamp: new Date().toISOString(),
        }
      }
      return result
    },
    onAtomUpdate: (currentAtom, allAtoms) => {
      const completedAtoms = allAtoms.filter(atomIsValidDraft)
      const failedAtoms = allAtoms.filter(atom => atom?.status === ATOM_STATUSES.FAILED || atom?.status === ATOM_STATUSES.API_RATE_LIMITED)
      const usageTotals = usageTotalsFromAtoms(allAtoms)
      const atomState = currentAtom?.status === ATOM_STATUSES.RUNNING
        ? 'generating'
        : atomIsValidDraft(currentAtom)
          ? 'persisted'
          : failedAtoms.some(atom => atom.id === currentAtom?.id)
            ? 'failed'
            : 'queued'
      onUpdate?.({
        lifecycleState: LIFECYCLE_STATES.GENERATING,
        atomLifecycleState: atomState,
        currentAtom,
        atoms: allAtoms,
        diagnostics: buildGenerationDiagnostics({
          buName,
          requestedAtoms,
          runnableAtoms,
          completedAtoms,
          failedAtoms,
          promptBytes,
          outputBytes,
          inputTokens: Math.max(inputTokens, usageTotals.inputTokens),
          outputTokens: Math.max(outputTokens, usageTotals.outputTokens),
          latestUsage: usageTotals.latestUsage || latestUsage,
          retryMode,
          model,
        }),
      })
    },
  })

  const completedAtoms = updatedAtoms.filter(atomIsValidDraft)
  const failedAtoms = updatedAtoms.filter(atom => atom?.status === ATOM_STATUSES.FAILED || atom?.status === ATOM_STATUSES.API_RATE_LIMITED)
  const usageTotals = usageTotalsFromAtoms(updatedAtoms)
  const lifecycleState = deriveLifecycleState({ atoms: updatedAtoms })
  const diagnostics = buildGenerationDiagnostics({
    buName,
    requestedAtoms,
    runnableAtoms,
    completedAtoms,
    failedAtoms,
    promptBytes,
    outputBytes,
    inputTokens: Math.max(inputTokens, usageTotals.inputTokens),
    outputTokens: Math.max(outputTokens, usageTotals.outputTokens),
    latestUsage: usageTotals.latestUsage || latestUsage,
    retryMode,
    model,
  })

  return {
    atoms: updatedAtoms,
    atomSummary: summarizeAtoms(updatedAtoms),
    lifecycleState,
    diagnostics,
  }
}
