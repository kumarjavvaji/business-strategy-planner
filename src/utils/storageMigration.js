/**
 * Storage migration utilities: inventory, reporting, and diagnostic helpers.
 * All read-only unless explicitly marked as mutating.
 *
 * Use in the browser console:
 *   import('/src/utils/storageMigration.js').then(m => m.reportStorage().then(console.log))
 */

import { storageReady, routeKey, isIdbPointer, getStorageDiagnostics } from './storageRouter'
import { idbReadAllStores } from './idbStorage'

// ── Storage inventory ──────────────────────────────────────────────────────────

/**
 * Full inventory of both localStorage and IndexedDB.
 * Non-destructive reads only.
 */
export async function inventoryStorage() {
  await storageReady()

  // ── localStorage scan ──────────────────────────────────────────────────────
  const lsEntries = []
  try {
    if (typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (!key) continue
        const raw = localStorage.getItem(key) || ''
        const bytes = (key.length + raw.length) * 2  // UTF-16 estimate

        let parsed = null
        let parseOk = false
        try { parsed = JSON.parse(raw); parseOk = true } catch { /* unparseable */ }

        const pointer = parseOk && isIdbPointer(parsed)
        const route   = routeKey(key)

        lsEntries.push({
          key,
          bytes,
          type:      pointer ? 'pointer' : parseOk ? 'value' : 'unparseable',
          idbStore:  pointer ? parsed.store : route ? route.store : null,
          isBspKey:  key.startsWith('bsp_'),
          routed:    !!route,
          dualWrite: route?.dualWrite ?? null,
        })
      }
    }
  } catch (e) {
    console.warn('[storageMigration] LS scan failed', e)
  }

  // ── IndexedDB scan ─────────────────────────────────────────────────────────
  let idbEntries = {}
  try {
    const raw = await idbReadAllStores()
    for (const [store, records] of Object.entries(raw)) {
      idbEntries[store] = records.map(r => ({
        key:   r.key,
        bytes: JSON.stringify(r.value).length * 2,
      }))
    }
  } catch (e) {
    console.warn('[storageMigration] IDB scan failed', e)
  }

  // ── Summaries ──────────────────────────────────────────────────────────────
  const lsTotalBytes   = lsEntries.reduce((s, e) => s + e.bytes, 0)
  const bspEntries     = lsEntries.filter(e => e.isBspKey)
  const pointerEntries = bspEntries.filter(e => e.type === 'pointer')
  const valueEntries   = bspEntries.filter(e => e.type === 'value' && e.routed)
  const lsOnlyEntries  = bspEntries.filter(e => e.type === 'value' && !e.routed)
  // Orphans: bsp_ keys that aren't in any known routing table and aren't the index
  const orphanEntries  = lsEntries.filter(e =>
    e.isBspKey &&
    !e.routed &&
    e.key !== 'bsp_plan_index_v1' &&
    !e.key.startsWith('bsp_v1_stage2_handoff_focus') // deliberate LS-only key
  )

  const idbTotalBytes = Object.values(idbEntries)
    .flat()
    .reduce((s, e) => s + e.bytes, 0)

  return {
    summary: {
      lsTotalBytes,
      lsEstimatedQuotaPct: Math.round(lsTotalBytes / (5 * 1024 * 1024) * 100),
      idbTotalBytes,
      lsTotalKeys:      lsEntries.length,
      bspKeys:          bspEntries.length,
      pointerKeys:      pointerEntries.length,
      migratedValueKeys: valueEntries.length,
      lsOnlyBspKeys:    lsOnlyEntries.length,
      orphanKeys:       orphanEntries.length,
    },
    localStorage: {
      all:       lsEntries,
      bsp:       bspEntries,
      pointers:  pointerEntries,
      values:    valueEntries,
      lsOnly:    lsOnlyEntries,
      orphans:   orphanEntries,
    },
    indexedDB: idbEntries,
  }
}

// ── Human-readable report ──────────────────────────────────────────────────────

/**
 * Returns a formatted text report. Safe to call from the browser console.
 */
export async function reportStorage() {
  const inv = await inventoryStorage()
  const s   = inv.summary
  const idb = inv.indexedDB

  const lines = [
    '=== BSP Storage Report ===',
    '',
    `localStorage`,
    `  total:    ${inv.localStorage.all.length} keys, ~${kb(s.lsTotalBytes)} (~${s.lsEstimatedQuotaPct}% of 5 MB quota)`,
    `  bsp_ keys: ${s.bspKeys}`,
    `    pointers (IDB-primary): ${s.pointerKeys}`,
    `    values still in LS:     ${s.migratedValueKeys}`,
    `    LS-only (expected):     ${s.lsOnlyBspKeys}`,
    `    orphan (unknown):       ${s.orphanKeys}`,
  ]

  if (inv.localStorage.orphans.length) {
    lines.push('  Orphan keys:')
    for (const e of inv.localStorage.orphans) {
      lines.push(`    ${e.key}  (~${kb(e.bytes)})`)
    }
  }

  lines.push('')
  lines.push(`IndexedDB  (~${kb(s.idbTotalBytes)} total)`)
  for (const [store, records] of Object.entries(idb)) {
    if (!records.length) {
      lines.push(`  ${store}: 0 records`)
    } else {
      const storeBytes = records.reduce((t, r) => t + r.bytes, 0)
      lines.push(`  ${store}: ${records.length} records (~${kb(storeBytes)})`)
      for (const r of records) {
        lines.push(`    ${r.key}  (~${kb(r.bytes)})`)
      }
    }
  }

  lines.push('')
  lines.push(`Cache: ${getStorageDiagnostics().idbCacheSize} items loaded`)

  return lines.join('\n')
}

function kb(bytes) {
  if (bytes < 1024) return `${bytes} B`
  return `${Math.round(bytes / 1024)} KB`
}

// ── Exports for console debugging ─────────────────────────────────────────────
export { getStorageDiagnostics }
