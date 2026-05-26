// Word-level diff utility using Longest Common Subsequence (LCS).
// Returns an array of ops: { type: 'keep'|'add'|'remove', text: string }
// Safe token guard: truncates both inputs to MAX_TOKENS words before diffing.

const MAX_TOKENS = 400

function tokenize(text) {
  // Split on whitespace, preserving tokens (words, punctuation runs, newlines)
  return (text || '').split(/(\s+)/).filter(t => t.length > 0)
}

/**
 * LCS-based word diff.
 * @param {string} textA  — "before" text
 * @param {string} textB  — "after" text
 * @returns {{ type: 'keep'|'add'|'remove', text: string }[]}
 */
export function diffWords(textA, textB) {
  let wordsA = tokenize(textA)
  let wordsB = tokenize(textB)

  // Guard: truncate to MAX_TOKENS each before running LCS
  if (wordsA.length > MAX_TOKENS) wordsA = wordsA.slice(0, MAX_TOKENS)
  if (wordsB.length > MAX_TOKENS) wordsB = wordsB.slice(0, MAX_TOKENS)

  const m = wordsA.length
  const n = wordsB.length

  // Build LCS table (m+1) × (n+1)
  // Use flat Uint16Array for memory efficiency
  const table = new Uint16Array((m + 1) * (n + 1))
  const row = n + 1

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (wordsA[i] === wordsB[j]) {
        table[i * row + j] = 1 + table[(i + 1) * row + (j + 1)]
      } else {
        const down  = table[(i + 1) * row + j]
        const right = table[i * row + (j + 1)]
        table[i * row + j] = down > right ? down : right
      }
    }
  }

  // Trace back to build ops
  const ops = []
  let i = 0, j = 0
  while (i < m || j < n) {
    if (i < m && j < n && wordsA[i] === wordsB[j]) {
      ops.push({ type: 'keep', text: wordsA[i] })
      i++; j++
    } else if (j < n && (i >= m || table[i * row + j] <= table[i * row + (j + 1)])) {
      ops.push({ type: 'add', text: wordsB[j] })
      j++
    } else {
      ops.push({ type: 'remove', text: wordsA[i] })
      i++
    }
  }

  return ops
}

/**
 * Summarises a diff ops array.
 * @param {{ type: string }[]} ops
 * @returns {{ added: number, removed: number, kept: number, hasChanges: boolean }}
 */
export function diffSummary(ops) {
  let added = 0, removed = 0, kept = 0
  for (const op of ops) {
    if (op.type === 'add')    added++
    else if (op.type === 'remove') removed++
    else kept++
  }
  return { added, removed, kept, hasChanges: added > 0 || removed > 0 }
}
