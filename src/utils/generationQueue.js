import {
  ATOM_STATUSES,
  markAtomComplete,
  markAtomFailed,
  markAtomRunning,
  shouldRetryAtom,
} from './generationAtoms'

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function labelGenerationFailure(errorLike) {
  const text = typeof errorLike === 'string'
    ? errorLike
    : errorLike?.message || errorLike?.error || ''
  if (/429|rate.?limit|rate_limit/i.test(text) || errorLike?.status === 429 || errorLike?.rateLimited) {
    return { label: 'rate_limited', message: text || 'Rate limited.' }
  }
  if (/max.?tokens|token limit|stop_reason.?max_tokens/i.test(text) || errorLike?.stopReason === 'max_tokens') {
    return { label: 'max_tokens', message: text || 'Response exceeded token limit.' }
  }
  return { label: 'failed', message: text || 'Generation failed.' }
}

export async function runGenerationQueue({
  atoms,
  worker,
  onAtomUpdate,
  concurrency = 1,
  delayMs = 0,
  retryFailedOnly = false,
  shouldRunAtom = shouldRetryAtom,
}) {
  const runnable = atoms.filter(atom => retryFailedOnly ? shouldRetryAtom(atom) : shouldRunAtom(atom))
  const results = new Map(atoms.map(atom => [atom.id, atom]))
  let cursor = 0

  async function runNext() {
    while (cursor < runnable.length) {
      const atom = runnable[cursor]
      cursor += 1
      const running = markAtomRunning(atom)
      results.set(atom.id, running)
      onAtomUpdate?.(running, Array.from(results.values()))

      try {
        const result = await worker(running)
        const completed = markAtomComplete(running, {
          rawResponseText: result?.rawResponseText,
          parsedValue: result?.parsedValue,
        })
        results.set(atom.id, completed)
        onAtomUpdate?.(completed, Array.from(results.values()))
      } catch (err) {
        const failure = labelGenerationFailure(err)
        const failed = markAtomFailed(running, {
          rawResponseText: err?.rawResponseText || err?.result || null,
          parserError: failure.message,
          status: failure.label === 'rate_limited' ? ATOM_STATUSES.FAILED : ATOM_STATUSES.FAILED,
          metadata: { failureLabel: failure.label },
        })
        results.set(atom.id, failed)
        onAtomUpdate?.(failed, Array.from(results.values()))
      }

      if (delayMs > 0 && cursor < runnable.length) await sleep(delayMs)
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => runNext())
  await Promise.all(workers)
  return Array.from(results.values())
}
