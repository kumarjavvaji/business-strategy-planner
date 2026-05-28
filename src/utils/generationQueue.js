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
  const status = errorLike?.status || errorLike?.response?.status
  const rateLimited = errorLike?.rateLimited || errorLike?.failureLabel === 'rate_limited'
  if (/429|rate.?limit|rate_limit/i.test(text) || status === 429 || rateLimited) {
    return { label: 'rate_limited', message: text || 'Rate limited.' }
  }
  if (/max.?tokens|token limit|stop_reason.?max_tokens/i.test(text) || errorLike?.stopReason === 'max_tokens') {
    return { label: 'max_tokens', message: text || 'Response exceeded token limit.' }
  }
  return { label: errorLike?.failureLabel || 'failed', message: text || 'Generation failed.' }
}

export async function runGenerationQueue({
  atoms,
  worker,
  onAtomUpdate,
  concurrency = 1,
  delayMs = 0,
  retryFailedOnly = false,
  shouldRunAtom = shouldRetryAtom,
  retry = null,
}) {
  const runnable = atoms.filter(atom => retryFailedOnly ? shouldRetryAtom(atom) : shouldRunAtom(atom))
  const results = new Map(atoms.map(atom => [atom.id, atom]))
  let cursor = 0
  const maxAttempts = Math.max(1, retry?.maxAttempts || 1)
  const baseDelayMs = Math.max(0, retry?.baseDelayMs || 0)
  const maxDelayMs = Math.max(baseDelayMs, retry?.maxDelayMs || baseDelayMs)
  const retryOn = retry?.retryOn || ((failure) => failure.label === 'rate_limited')
  const delayForAttempt = (attemptIndex) => {
    if (!baseDelayMs) return 0
    return Math.min(maxDelayMs, baseDelayMs * Math.pow(2, Math.max(0, attemptIndex - 1)))
  }

  async function runNext() {
    while (cursor < runnable.length) {
      const atom = runnable[cursor]
      cursor += 1
      let running = markAtomRunning(atom)
      results.set(atom.id, running)
      onAtomUpdate?.(running, Array.from(results.values()))

      try {
        let result = null
        for (let attemptIndex = 1; attemptIndex <= maxAttempts; attemptIndex += 1) {
          try {
            result = await worker(running)
            break
          } catch (err) {
            const failure = labelGenerationFailure(err)
            const shouldRetry = attemptIndex < maxAttempts && retryOn(failure, err, running)
            if (!shouldRetry) {
              throw {
                ...err,
                message: failure.message,
                failureLabel: failure.label,
                rawResponseText: err?.rawResponseText || err?.result || null,
                status: err?.status,
                rateLimited: err?.rateLimited,
              }
            }

            const waitMs = delayForAttempt(attemptIndex)
            const retryPending = markAtomFailed(running, {
              rawResponseText: err?.rawResponseText || err?.result || null,
              parserError: `${failure.message} Retrying in ${Math.round(waitMs / 1000)}s.`,
              status: ATOM_STATUSES.RETRY_PENDING,
              metadata: {
                failureLabel: failure.label,
                retryAttempt: attemptIndex,
                nextRetryAt: waitMs ? new Date(Date.now() + waitMs).toISOString() : null,
              },
            })
            results.set(atom.id, retryPending)
            onAtomUpdate?.(retryPending, Array.from(results.values()))
            if (waitMs > 0) await sleep(waitMs)
            running = markAtomRunning(retryPending)
            results.set(atom.id, running)
            onAtomUpdate?.(running, Array.from(results.values()))
          }
        }
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
          status: failure.label === 'rate_limited' ? ATOM_STATUSES.API_RATE_LIMITED : ATOM_STATUSES.FAILED,
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
